"""debit-notices: announced direct debits (incasso's) from the bank's e-mail notices.

The bank sends an e-mail for every announced incasso (one-off, first/next/last of a series) to the
outlook.com mailbox. This service reads that mailbox through Microsoft Graph, read-only
(delegated Mail.Read), and every POLL_MINUTES:
  * asks Graph only for mails of the last LOOKBACK_DAYS from SENDER_ADDRESSES (filtered on
    Microsoft's side: no other mail is listed or read)
  * keeps those whose subject contains one of SUBJECT_KEYWORDS or whose body contains one of
    BODY_MARKERS (all settings come from the playbook)
  * accepts a mail only if outlook.com's own Authentication-Results says dmarc=pass for the
    From domain (a spoofed "bank" mail is skipped and logged)
  * parses creditor, amount, collection date and incasso type from it
  * publishes retained MQTT (JSON lists): MQTT_PREFIX/announced = upcoming debits of every kind
    (one-off, first, recurring, last), MQTT_PREFIX/failed = failed debits of the last 7 days,
    MQTT_PREFIX/status = ok | login_required | error. Alerts, if wanted, are openHAB's job.
Stored (data/state.json, 0600): per notice only the parsed creditor, amount, debit date, kind,
status, creditor id and received time, plus the ids of mails already looked at; both are dropped
KEEP_DAYS after the mail was received. No mail text is stored. `python /app/main.py inspect`
prints the recent notice mails with long numbers masked to stdout, to check a new mail layout.

Sign-in (once, and again if Microsoft revokes the token):
    docker exec -it debit-notices python /app/main.py login
It prints a code to enter at microsoft.com/link. The refresh token is kept in /data/token.json
(0600, container user) and is never logged. `python /app/main.py check` runs one cycle.
"""

import json
import logging
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import paho.mqtt.client as mqtt

TZ = ZoneInfo("Europe/Amsterdam")
AUTHORITY = "https://login.microsoftonline.com/consumers/oauth2/v2.0"
GRAPH = "https://graph.microsoft.com/v1.0"
SCOPE = "offline_access https://graph.microsoft.com/Mail.Read"

CLIENT_ID = os.environ.get("MS_CLIENT_ID", "").strip()
DATA = Path(os.environ.get("DATA_DIR", "/data"))
TOKEN_FILE = DATA / "token.json"
STATE_FILE = DATA / "state.json"


def env_list(name: str) -> list[str]:
    return [v.strip() for v in os.environ.get(name, "").split(",") if v.strip()]


SENDER_ADDRESSES = [a.lower() for a in env_list("SENDER_ADDRESSES")]
SUBJECT_KEYWORDS = [k.lower() for k in env_list("SUBJECT_KEYWORDS")]
BODY_MARKERS = env_list("BODY_MARKERS")
POLL_MINUTES = float(os.environ.get("POLL_MINUTES", "15"))
LOOKBACK_DAYS = int(os.environ.get("LOOKBACK_DAYS", "14"))
KEEP_DAYS = int(os.environ.get("KEEP_DAYS", "60"))
MQTT_HOST = os.environ.get("MQTT_HOST", "")
MQTT_PORT = int(os.environ.get("MQTT_PORT", "1883"))
MQTT_PREFIX = os.environ.get("MQTT_TOPIC_PREFIX", "debits")

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("debit-notices")


class NeedLogin(Exception):
    pass


# ---------------------------------------------------------------- files

def load_json(path: Path, default):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return default


def write_private(path: Path, text: str) -> None:
    """Atomic write, mode 0600."""
    tmp = path.with_name(path.name + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(text)
    os.replace(tmp, path)


def save_state(state: dict) -> None:
    write_private(STATE_FILE, json.dumps(state, indent=1, ensure_ascii=False))


# ---------------------------------------------------------------- http

def http(method: str, url: str, form: dict | None = None, headers: dict | None = None):
    """(status, parsed JSON or raw bytes). Never logs request bodies (tokens)."""
    body = urllib.parse.urlencode(form).encode() if form is not None else None
    req = urllib.request.Request(url, data=body, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            status, raw, ctype = r.status, r.read(), r.headers.get("Content-Type", "")
    except urllib.error.HTTPError as e:
        status, raw, ctype = e.code, e.read(), e.headers.get("Content-Type", "")
    if "json" in ctype:
        try:
            return status, json.loads(raw)
        except ValueError:
            return status, {}
    return status, raw


# ---------------------------------------------------------------- auth

def save_token(tok: dict, old_refresh: str | None = None) -> None:
    write_private(TOKEN_FILE, json.dumps({
        "access_token": tok["access_token"],
        "expires_at": time.time() + int(tok.get("expires_in", 3600)),
        # Microsoft rotates refresh tokens; keep the old one if none came back
        "refresh_token": tok.get("refresh_token") or old_refresh,
    }))


def login() -> None:
    if not CLIENT_ID:
        sys.exit("MS_CLIENT_ID is not set")
    st, dc = http("POST", f"{AUTHORITY}/devicecode", {"client_id": CLIENT_ID, "scope": SCOPE})
    if st != 200:
        sys.exit(f"device code request failed: {dc.get('error')}: {str(dc.get('error_description', ''))[:300]}")
    print(dc["message"], flush=True)
    deadline, interval = time.time() + int(dc["expires_in"]), int(dc.get("interval", 5))
    while time.time() < deadline:
        time.sleep(interval)
        st, tok = http("POST", f"{AUTHORITY}/token", {
            "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
            "client_id": CLIENT_ID, "device_code": dc["device_code"]})
        if st == 200:
            save_token(tok)
            print("Signed in. The service uses the token from its next cycle.", flush=True)
            return
        err = tok.get("error") if isinstance(tok, dict) else None
        if err == "authorization_pending":
            continue
        if err == "slow_down":
            interval += 5
            continue
        sys.exit(f"sign-in failed: {err}")
    sys.exit("the code expired; run login again")


def access_token() -> str:
    tok = load_json(TOKEN_FILE, {})
    if not tok.get("refresh_token"):
        raise NeedLogin("no token yet")
    if tok.get("access_token") and tok.get("expires_at", 0) > time.time() + 120:
        return tok["access_token"]
    st, new = http("POST", f"{AUTHORITY}/token", {
        "grant_type": "refresh_token", "client_id": CLIENT_ID,
        "refresh_token": tok["refresh_token"], "scope": SCOPE})
    if st != 200:
        err = new.get("error") if isinstance(new, dict) else None
        if err in ("invalid_grant", "interaction_required", "unauthorized_client"):
            raise NeedLogin(err)
        raise RuntimeError(f"token refresh failed: HTTP {st} {err}")
    save_token(new, tok["refresh_token"])
    return new["access_token"]


def graph(token: str, url: str) -> dict:
    if not url.startswith("http"):
        url = GRAPH + url
    st, data = http("GET", url, headers={
        "Authorization": f"Bearer {token}",
        "Prefer": 'outlook.body-content-type="text"'})
    if st != 200:
        err = data.get("error", {}).get("code") if isinstance(data, dict) else None
        raise RuntimeError(f"Graph HTTP {st} {err}")
    return data


# ---------------------------------------------------------------- mail checks

def from_domain(msg: dict) -> str:
    addr = ((msg.get("from") or {}).get("emailAddress") or {}).get("address", "")
    return addr.rsplit("@", 1)[-1].lower()


def sender_ok(msg: dict) -> bool:
    return ((msg.get("from") or {}).get("emailAddress") or {}).get("address", "").lower() in SENDER_ADDRESSES


def dmarc_ok(headers: list[dict], domain: str) -> bool:
    """outlook.com puts its own Authentication-Results on top; only that one is trusted."""
    first = next((h["value"] for h in headers if h.get("name", "").lower() == "authentication-results"), "")
    m = re.search(r"dmarc=(\w+)[^;]*?header\.from=([\w.-]+)", first, re.I)
    return bool(m) and m.group(1).lower() == "pass" and m.group(2).lower() == domain


# ---------------------------------------------------------------- parsing

PARSER = 4  # bump when parsing changes: the lookback window is re-read

# only what the outputs need: no description (invoice/customer numbers, address), no mandate id
FIELDS = {"Bedrag": "amount", "Naar naam": "creditor", "Gepland op datum": "date", "Incassant ID": "creditor_id"}


def is_incasso(subject: str, body: str) -> bool:
    return any(k in subject.lower() for k in SUBJECT_KEYWORDS) or any(m in body for m in BODY_MARKERS)


def parse_notice(subject: str, body: str) -> dict:
    """The bank's "Details van de incasso" block: one "Label: value" per line."""
    n = {v: None for v in FIELDS.values()}
    for line in body.splitlines():
        label, sep, value = line.partition(":")
        key = FIELDS.get(label.strip())
        if sep and key and n[key] is None:
            n[key] = value.strip()
    if n["amount"]:
        m = re.search(r"-?[\d.]+,\d{2}", n["amount"])
        n["amount"] = float(m.group(0).replace(".", "").replace(",", ".")) if m else None
    if n["date"]:
        m = re.search(r"(\d{1,2})-(\d{1,2})-(\d{4})", n["date"])
        n["date"] = date(int(m.group(3)), int(m.group(2)), int(m.group(1))).isoformat() if m else None
    text = (subject + " " + body).lower()
    n["status"] = "failed" if "niet gelukt" in text else "announced"
    kinds = {"eenmalig": "one-off", "eerste": "first", "laatste": "last"}
    n["kind"] = next((v for k, v in kinds.items() if k in subject.lower()), "recurring")
    return n


# ---------------------------------------------------------------- outputs

def mqtt_publish_retained(messages: dict[str, str]) -> None:
    if not MQTT_HOST:
        return
    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="debit-notices")
    client.connect(MQTT_HOST, MQTT_PORT, keepalive=30)
    client.loop_start()
    for topic, payload in messages.items():
        client.publish(topic, payload, qos=1, retain=True).wait_for_publish(timeout=10)
    client.loop_stop()
    client.disconnect()


def describe(n: dict) -> str:
    amount = f"€{n['amount']:.2f}".replace(".", ",") if n.get("amount") is not None else "amount ?"
    day = date.fromisoformat(n["date"]).strftime("%a %-d %b") if n.get("date") else "?"
    return f"{n.get('creditor') or '?'} {amount}, debit date {day}"


# ---------------------------------------------------------------- cycle

def list_url() -> str:
    """Mails of the last LOOKBACK_DAYS from SENDER_ADDRESSES only (filtered by Graph)."""
    since = (datetime.now(timezone.utc) - timedelta(days=LOOKBACK_DAYS)).strftime("%Y-%m-%dT%H:%M:%SZ")
    return "/me/messages?" + urllib.parse.urlencode({
        "$filter": f"receivedDateTime ge {since} and ("
                   + " or ".join(f"from/emailAddress/address eq '{a}'" for a in SENDER_ADDRESSES) + ")",
        "$select": "id,from,receivedDateTime",
        "$top": "100"}, quote_via=urllib.parse.quote)


def full_mail(token: str, msg_id: str) -> dict:
    return graph(token, f"/me/messages/{urllib.parse.quote(msg_id)}"
                        "?$select=subject,from,receivedDateTime,internetMessageHeaders,body")


def inspect() -> None:
    """Print recent notice mails to stdout (nothing is written), long digit runs masked."""
    token, url = access_token(), list_url()
    while url:
        page = graph(token, url)
        for msg in page.get("value", []):
            full = full_mail(token, msg["id"])
            subject, body = full.get("subject") or "", (full.get("body") or {}).get("content") or ""
            if not is_incasso(subject, body):
                continue
            ok = dmarc_ok(full.get("internetMessageHeaders") or [], from_domain(msg))
            print(f"=== {msg['receivedDateTime']} dmarc={'pass' if ok else 'FAIL'} | {subject}")
            for line in body.splitlines():
                if ":" in line and len(line) < 200:
                    print("   ", re.sub(r"\d{5,}", lambda m: "#" * len(m.group(0)), line.strip()))
            print("    parsed:", parse_notice(subject, body))
        url = page.get("@odata.nextLink")


def cycle() -> None:
    # always from disk: a manual `check` run may have written it since the last cycle
    state = load_json(STATE_FILE, {})
    if state.get("parser") != PARSER:
        state.update(parser=PARSER, seen={}, notices={})
    token, url = access_token(), list_url()
    notices, seen = state.setdefault("notices", {}), state.setdefault("seen", {})
    new = []
    while url:
        page = graph(token, url)
        for msg in page.get("value", []):
            domain = from_domain(msg)
            if msg["id"] in seen or not sender_ok(msg):  # re-check what the server filtered
                continue
            full = full_mail(token, msg["id"])
            seen[msg["id"]] = msg["receivedDateTime"]
            if not dmarc_ok(full.get("internetMessageHeaders") or [], domain):
                log.warning("skipped a mail from %s that did not pass DMARC (received %s)", domain, msg["receivedDateTime"])
                continue
            subject, body = full.get("subject") or "", (full.get("body") or {}).get("content") or ""
            if not is_incasso(subject, body):
                continue
            n = parse_notice(subject, body) | {"received": msg["receivedDateTime"]}
            notices[msg["id"]] = n
            new.append(n)
        url = page.get("@odata.nextLink")

    # retention: ids and notices go KEEP_DAYS after the mail was received
    cutoff = (datetime.now(timezone.utc) - timedelta(days=KEEP_DAYS)).strftime("%Y-%m-%dT%H:%M:%SZ")
    for key in [k for k, v in seen.items() if v < cutoff]:
        seen.pop(key)
        notices.pop(key, None)
    save_state(state)

    today = datetime.now(TZ).date().isoformat()
    week_ago = (datetime.now(TZ).date() - timedelta(days=7)).isoformat()
    fields = ("date", "creditor", "amount", "kind", "creditor_id")
    announced = sorted((n for n in notices.values() if n["status"] == "announced" and (n.get("date") or "") >= today),
                      key=lambda n: n["date"])
    failed = sorted((n for n in notices.values() if n["status"] == "failed" and (n.get("date") or "") >= week_ago),
                    key=lambda n: n["date"])
    mqtt_publish_retained({
        f"{MQTT_PREFIX}/announced": json.dumps([{k: n.get(k) for k in fields} for n in announced], ensure_ascii=False),
        f"{MQTT_PREFIX}/failed": json.dumps([{k: n.get(k) for k in fields} for n in failed], ensure_ascii=False),
        f"{MQTT_PREFIX}/updated": datetime.now(TZ).isoformat(timespec="seconds"),
        f"{MQTT_PREFIX}/status": "ok",
    })
    for n in new:
        log.info("%s notice: %s", n["status"], describe(n))


def publish_status(status: str) -> None:
    try:
        mqtt_publish_retained({f"{MQTT_PREFIX}/status": status})
    except Exception as e:
        log.error("MQTT publish failed: %s", type(e).__name__)


def main() -> None:
    if len(sys.argv) > 1 and sys.argv[1] == "login":
        login()
        return
    if not (CLIENT_ID and SENDER_ADDRESSES and (SUBJECT_KEYWORDS or BODY_MARKERS)):
        sys.exit("MS_CLIENT_ID, SENDER_ADDRESSES and SUBJECT_KEYWORDS/BODY_MARKERS must be set")
    if len(sys.argv) > 1 and sys.argv[1] == "inspect":
        inspect()
        return
    once = len(sys.argv) > 1 and sys.argv[1] == "check"
    log.info("starting: every %s min, senders %s, lookback %d days", POLL_MINUTES, ",".join(SENDER_ADDRESSES), LOOKBACK_DAYS)
    while True:
        try:
            cycle()
        except NeedLogin as e:
            log.error("Microsoft sign-in needed (%s): docker exec -it debit-notices python /app/main.py login", e)
            publish_status("login_required")
        except Exception as e:  # keep running; the next cycle retries
            log.error("cycle failed: %s: %s", type(e).__name__, str(e)[:300])
            publish_status("error")
        if once:
            return
        time.sleep(POLL_MINUTES * 60)


if __name__ == "__main__":
    main()
