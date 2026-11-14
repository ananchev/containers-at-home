"""energy-tariff: electricity price and whole-house hourly consumption from Greenchoice.

Every INTERVAL_HOURS:
  * the all-in single-rate price in effect today  -> MQTT (retained) + InfluxDB
  * hourly house consumption (kWh, EUR) of the last HOUSE_DAYS days -> InfluxDB
    (the supplier publishes 1-2 days late; re-writing a day is idempotent)
  * the supplier's periodic meter readings (kWh register values) of this and earlier years
    -> InfluxDB; for connections without remote smart-meter reading these are the only
    house data (roughly quarterly)
Once, if BACKFILL_FROM is set and the supplier has hourly data at all: the hourly house
consumption from that date on.
If the price could not be refreshed for STALE_HOURS, a Telegram alert is sent (max 1/day).

Design and data layout: ansible/notes/energy-monitoring.md. Secrets are read from
SECRETS_FILE and are never logged.
"""

import asyncio
import base64
import json
import logging
import os
import time
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

import aiohttp
import paho.mqtt.client as mqtt

from greenchoice_auth import Auth, LoginError

TZ = ZoneInfo("Europe/Amsterdam")  # the supplier's calendar days
BASE_URL = "https://mijn.greenchoice.nl"

INFLUX_URL = os.environ.get("INFLUX_URL", "http://influxdb:8086")
INFLUX_DB = os.environ.get("INFLUX_DB", "openhab")
MQTT_HOST = os.environ["MQTT_HOST"]
MQTT_PORT = int(os.environ.get("MQTT_PORT", "1883"))
MQTT_PREFIX = os.environ.get("MQTT_TOPIC_PREFIX", "energy/tariff")
INTERVAL_HOURS = float(os.environ.get("INTERVAL_HOURS", "6"))
HOUSE_DAYS = int(os.environ.get("HOUSE_DAYS", "3"))
BACKFILL_FROM = os.environ.get("BACKFILL_FROM", "").strip()
STALE_HOURS = float(os.environ.get("STALE_HOURS", "48"))
STATE_FILE = os.environ.get("STATE_FILE", "/data/state.json")
SECRETS_FILE = os.environ.get("SECRETS_FILE", "/run/secrets/energy-tariff.json")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("energy-tariff")
# aiohttp/bs4 debug output could include request details; keep them quiet
logging.getLogger("aiohttp").setLevel(logging.WARNING)
logging.getLogger("greenchoice_auth").setLevel(logging.WARNING)


def load_secrets() -> dict:
    with open(SECRETS_FILE, encoding="utf-8") as f:
        secrets = json.load(f)
    missing = [k for k in ("greenchoice_username", "greenchoice_password",
                           "influx_username", "influx_password") if not secrets.get(k)]
    if missing:
        raise SystemExit(f"secrets file is missing keys: {', '.join(missing)}")
    return secrets


def load_state() -> dict:
    try:
        with open(STATE_FILE, encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def save_state(state: dict) -> None:
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=2)
    os.replace(tmp, STATE_FILE)


class Portal:
    """Thin client for the three customer-portal endpoints this app needs."""

    def __init__(self, auth: Auth):
        self.auth = auth
        self.customer = None
        self.agreement = None

    async def get(self, path: str):
        for attempt in (1, 2):
            async with self.auth.session.get(
                BASE_URL + path, timeout=aiohttp.ClientTimeout(total=30)
            ) as resp:
                if resp.status in (401, 403) or self.auth.is_session_expired(resp):
                    if attempt == 1:
                        await self.auth.refresh_session()
                        continue
                if resp.status == 404:
                    return None
                resp.raise_for_status()
                return await resp.json()
        return None

    async def ensure_agreement(self) -> None:
        if self.customer and self.agreement:
            return
        account = await self.get("/api/v2/account") or {}
        prefs = account.get("preferences") or {}
        if not (prefs.get("customerNumber") and prefs.get("agreementId")):
            # no preferred agreement: take the first active address, like the portal does
            for customer in account.get("customers", []):
                for address in customer.get("addresses", []):
                    if address.get("agreementId") and address.get("energySupplyStatus") != "Past":
                        prefs = {"customerNumber": address.get("customerNumber") or customer.get("customerNumber"),
                                 "agreementId": address["agreementId"]}
                        break
                if prefs.get("agreementId"):
                    break
        if not (prefs.get("customerNumber") and prefs.get("agreementId")):
            raise RuntimeError("the account has no agreement to read")
        self.customer, self.agreement = prefs["customerNumber"], prefs["agreementId"]

    def _agreement_path(self) -> str:
        return f"/api/v3/customers/{self.customer}/agreements/{self.agreement}"

    async def single_rate(self, day: date) -> float | None:
        """All-in (supply + energy tax + VAT) single-rate electricity price for `day`."""
        data = await self.get(
            f"{self._agreement_path()}/rate-details?Start={day.isoformat()}&End={(day + timedelta(days=1)).isoformat()}"
        )
        if not data:
            log.warning("no rate details for %s", day)
            return None
        rates = data.get("electricityRates") or {}
        standard = rates.get("standardVariableRates") or {}
        single = (standard.get("deliverySingle") or {}).get("allInRateIncludingVat")
        if single is None:
            log.warning("no single-rate price in the rate details (time-of-use: %s); contract changed?",
                        bool(rates.get("timeOfUseVariableRates")))
            return None
        return float(single)

    async def meter_readings(self, year: int) -> list[tuple[int, float, float]]:
        """[(epoch_s, normal kWh, off-peak kWh)]: the register values the supplier has for `year`."""
        data = await self.get(f"/api/v2/customers/{self.customer}/agreements/{self.agreement}/meter-readings/{year}/")
        rows = []
        for month in (data or {}).get("months", []):
            for r in month.get("readings", []):
                normal, off_peak = r.get("normalConsumption"), r.get("offPeakConsumption")
                if normal is None and off_peak is None:
                    continue
                ts = int(datetime.fromisoformat(r["readingDate"]).replace(tzinfo=TZ).timestamp())
                rows.append((ts, float(normal or 0), float(off_peak or 0)))
        return rows

    async def house_hours(self, day: date) -> list[tuple[int, float, float | None, float | None]]:
        """[(epoch_s, kWh, consumption EUR, total EUR incl. fixed costs)] for each hour of `day`."""
        data = await self.get(
            f"{self._agreement_path()}/consumptions?interval=Hour&start={day.isoformat()}&end={(day + timedelta(days=1)).isoformat()}"
        )
        rows = []
        for period in (data or {}).get("periods", []):
            product = next((p for p in period.get("products", []) if p.get("type") == "Electricity"), None)
            totals = (product or {}).get("totals") or {}
            kwh = totals.get("consumptionQuantity")
            if kwh is None:
                continue
            ts = int(datetime.fromisoformat(period["consumedOn"]).timestamp())
            rows.append((ts, float(kwh), totals.get("consumptionCost"), totals.get("totalCost")))
        return rows


async def influx_write(http: aiohttp.ClientSession, secrets: dict, lines: list[str]) -> None:
    if not lines:
        return
    token = base64.b64encode(f"{secrets['influx_username']}:{secrets['influx_password']}".encode()).decode()
    async with http.post(f"{INFLUX_URL}/write", params={"db": INFLUX_DB, "precision": "s"},
                         data="\n".join(lines).encode(), headers={"Authorization": f"Basic {token}"},
                         timeout=aiohttp.ClientTimeout(total=30)) as resp:
        if resp.status != 204:
            raise RuntimeError(f"InfluxDB write failed: HTTP {resp.status}")


def mqtt_publish_retained(messages: dict[str, str]) -> None:
    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="energy-tariff")
    client.connect(MQTT_HOST, MQTT_PORT, keepalive=30)
    client.loop_start()
    try:
        for topic, payload in messages.items():
            client.publish(topic, payload, qos=1, retain=True).wait_for_publish(timeout=10)
    finally:
        client.loop_stop()
        client.disconnect()


async def telegram(http: aiohttp.ClientSession, secrets: dict, text: str) -> None:
    token, chat = secrets.get("telegram_token"), secrets.get("telegram_chat_id")
    if not (token and chat):
        log.warning("Telegram not configured, alert not sent: %s", text)
        return
    try:
        async with http.post(f"https://api.telegram.org/bot{token}/sendMessage",
                             json={"chat_id": chat, "text": text},
                             timeout=aiohttp.ClientTimeout(total=20)) as resp:
            if resp.status != 200:
                log.warning("Telegram alert failed: HTTP %s", resp.status)
    except aiohttp.ClientError as e:  # the URL contains the token: never log the exception text
        log.warning("Telegram alert failed: %s", type(e).__name__)


def house_lines(rows) -> list[str]:
    lines = []
    for ts, kwh, cost, total in rows:
        fields = [f"kwh={kwh}"]
        if cost is not None:
            fields.append(f"cost_eur={float(cost)}")
        if total is not None:
            fields.append(f"total_cost_eur={float(total)}")
        lines.append(f"house_energy,source=greenchoice {','.join(fields)} {ts}")
    return lines


async def cycle(secrets: dict, state: dict, http: aiohttp.ClientSession) -> None:
    async with Auth(BASE_URL, secrets["greenchoice_username"], secrets["greenchoice_password"]) as auth:
        portal = Portal(auth)
        await portal.ensure_agreement()
        today = datetime.now(TZ).date()

        price = await portal.single_rate(today)
        if price is not None:
            now = datetime.now(TZ)
            mqtt_publish_retained({
                f"{MQTT_PREFIX}/electricity": f"{price:.5f}",
                f"{MQTT_PREFIX}/updated": now.isoformat(timespec="seconds"),
            })
            await influx_write(http, secrets, [f"energy_tariff_eur_kwh,source=greenchoice value={price} {int(now.timestamp())}"])
            if price != state.get("last_price"):
                log.info("price for %s: %.5f EUR/kWh (was %s)", today, price, state.get("last_price"))
            state.update(last_price=price, last_price_ok=time.time())
            save_state(state)

        rows = []
        for back in range(1, HOUSE_DAYS + 1):
            rows += await portal.house_hours(today - timedelta(days=back))
        await influx_write(http, secrets, house_lines(rows))
        if rows:
            log.info("house consumption: %d hourly values written for the last %d days", len(rows), HOUSE_DAYS)
        elif not state.get("no_hourly_logged"):
            log.warning("the supplier has no hourly data for this connection (smart meter not read remotely?); "
                        "only the periodic meter readings are stored")
            state["no_hourly_logged"] = True
            save_state(state)

        first_year = date.fromisoformat(BACKFILL_FROM).year if BACKFILL_FROM else today.year - 1
        readings = []
        for year in range(first_year, today.year + 1):
            readings += await portal.meter_readings(year)
        await influx_write(http, secrets, [
            f"house_meter_kwh,source=greenchoice normal={n},off_peak={o},total={n + o} {ts}" for ts, n, o in readings])
        if len(readings) != state.get("readings_count"):
            log.info("meter readings: %d stored, latest %s", len(readings),
                     datetime.fromtimestamp(max(r[0] for r in readings), TZ).date() if readings else "-")
            state["readings_count"] = len(readings)
            save_state(state)

        # the hourly history only exists if recent days have hourly data
        if rows and BACKFILL_FROM and state.get("backfill_done") != BACKFILL_FROM:
            state.pop("no_hourly_logged", None)
            await backfill(portal, secrets, state, http, today)


async def backfill(portal: Portal, secrets: dict, state: dict, http: aiohttp.ClientSession, today: date) -> None:
    """One-time import of the house history; resumable (progress kept in the state file)."""
    day = date.fromisoformat(state.get("backfill_next") or BACKFILL_FROM)
    if state.get("backfill_from") != BACKFILL_FROM:
        day = date.fromisoformat(BACKFILL_FROM)
        state["backfill_from"] = BACKFILL_FROM
    log.info("backfill of house consumption from %s", day)
    written = 0
    while day < today - timedelta(days=HOUSE_DAYS):
        rows = await portal.house_hours(day)
        await influx_write(http, secrets, house_lines(rows))
        written += len(rows)
        day += timedelta(days=1)
        state["backfill_next"] = day.isoformat()
        if day.day == 1:
            save_state(state)
            log.info("backfill at %s (%d hourly values so far)", day, written)
        await asyncio.sleep(1)  # be gentle with the portal
    state["backfill_done"] = BACKFILL_FROM
    save_state(state)
    log.info("backfill done: %d hourly values", written)


async def main() -> None:
    secrets = load_secrets()
    state = load_state()
    log.info("starting: every %sh, house %d days, backfill from %s", INTERVAL_HOURS, HOUSE_DAYS, BACKFILL_FROM or "-")
    async with aiohttp.ClientSession() as http:
        while True:
            try:
                await cycle(secrets, state, http)
            except LoginError:
                log.error("Greenchoice login failed (credentials, or the portal login changed)")
            except Exception as e:  # keep running; the next cycle retries
                log.error("cycle failed: %s: %s", type(e).__name__, str(e)[:300])

            age_h = (time.time() - state.get("last_price_ok", 0)) / 3600
            if age_h > STALE_HOURS and time.time() - state.get("last_alert", 0) > 24 * 3600:
                await telegram(http, secrets, f"energy-tariff: the electricity price has not been refreshed for "
                                              f"{age_h:.0f} h; openHAB keeps using the last price. Check `docker logs energy-tariff`.")
                state["last_alert"] = time.time()
                save_state(state)
            await asyncio.sleep(INTERVAL_HOURS * 3600)


if __name__ == "__main__":
    asyncio.run(main())
