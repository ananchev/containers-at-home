#!/usr/bin/env python3
"""Estimate the oven's share of meter 3 (group 3: oven + kitchen outlets + master bedroom & bath).

One-off analysis, read-only: it reads history through openHAB's REST persistence API
(no InfluxDB credentials needed) and writes nothing back. See ../README.md, "Meters and circuits".

Modes
  minute     exact-ish, for data since 2026-11-14 (counter on every 0.01 kWh + 1-min power).
             Classifies each burst of load above the bedroom baseline:
               oven        thermostat cycling (>=3 blocks of 2-8 min) or a >=4 min block 16-22 h
               dishwasher  long single blocks (>=8 min) outside 16-22 h (Eco50 runs at night)
               short       1-2 min blocks (kettle, microwave)
  hourly     guesstimate for the old app's hourly history (line3Total, 2023-12 .. 2024-12):
             per hour, excess = kWh - baseline (low quantile of the surrounding days);
             excess in 16-22 h counts as oven, 22-07 h as dishwasher, the rest as other.
  calibrate  runs both on the recent data and compares, to tune the hourly model.

Usage
  oven_estimate.py minute    [--from 2026-11-14T14:00] [--to now] [--csv out.csv]
  oven_estimate.py hourly    [--from 2023-12-11] [--to 2024-12-08] [--csv out.csv]
  oven_estimate.py calibrate [--from 2026-11-14T14:00]
"""
import argparse, bisect, csv, datetime as dt, json, statistics, sys, urllib.request

OH = "http://192.168.2.11:1234"
ON_W = 1000            # W above baseline = a heating element is on
SESSION_GAP = 12       # min between blocks of one session
OVEN_HOURS = range(16, 23)
NIGHT_HOURS = set(range(22, 24)) | set(range(0, 7))


def fetch(item, start, end):
    url = (f"{OH}/rest/persistence/items/{item}?serviceId=influxdb"
           f"&starttime={start:%Y-%m-%dT%H:%M:%S.000Z}&endtime={end:%Y-%m-%dT%H:%M:%S.000Z}")
    with urllib.request.urlopen(url, timeout=120) as r:
        data = json.load(r).get("data", [])
    return [(x["time"] / 1000, float(x["state"])) for x in data]


def utc(s):
    if s == "now":
        return dt.datetime.now(dt.timezone.utc)
    t = dt.datetime.fromisoformat(s)
    return (t if t.tzinfo else t.astimezone()).astimezone(dt.timezone.utc)


def local(ts):
    return dt.datetime.fromtimestamp(ts)


# ---------------------------------------------------------------- minute mode
def per_minute_energy(counter):
    """Wh per whole minute, linearly interpolated from the kWh counter (monotonic part only)."""
    t0, t1 = int(counter[0][0] // 60 * 60), int(counter[-1][0] // 60 * 60)
    ts = [t for t, _ in counter]
    def at(t):
        i = bisect.bisect_left(ts, t)
        if i <= 0: return counter[0][1]
        if i >= len(ts): return counter[-1][1]
        (a, va), (b, vb) = counter[i - 1], counter[i]
        return va + (vb - va) * (t - a) / (b - a) if b > a else vb
    mins = list(range(t0, t1, 60))
    return mins, [max(0.0, (at(m + 60) - at(m)) * 1000) for m in mins]


def classify_minutes(start, end):
    counter = fetch("EnergyMeter3_Total", start, end)
    power = dict((int(t // 60 * 60), p) for t, p in fetch("EnergyMeter3_Power", start, end))
    mins, wh = per_minute_energy(counter)
    # minute power: the sampled power when available (sharper edges), counter-derived otherwise
    w = [power.get(m, e * 60) for m, e in zip(mins, wh)]
    base, quiet = [], []
    for i, p in enumerate(w):
        quiet = [v for v in w[max(0, i - 60):i + 1] if v < 1000]
        base.append(statistics.median(quiet) if quiet else 250)
    on = [p - b > ON_W for p, b in zip(w, base)]
    blocks, cur = [], None
    for i, o in enumerate(on):
        if o: cur = cur or [i, i]; cur[1] = i
        elif cur: blocks.append(cur); cur = None
    if cur: blocks.append(cur)
    sessions = []
    for b in blocks:
        if sessions and b[0] - sessions[-1][-1][1] <= SESSION_GAP: sessions[-1].append(b)
        else: sessions.append([b])
    out = []
    for s in sessions:
        lens = [b[1] - b[0] + 1 for b in s]
        i0, i1 = s[0][0], s[-1][1]
        hour = local(mins[i0]).hour
        cycling = sum(2 <= l <= 8 for l in lens) >= 3
        if cycling or (max(lens) >= 4 and hour in OVEN_HOURS): kind = "oven"
        elif max(lens) >= 8: kind = "dishwasher"
        elif max(lens) <= 2: kind = "short"
        else: kind = "other"
        # energy above baseline over the whole session span (incl. the off-phases of cycling),
        # taken from the counter so nothing between samples is missed
        kwh = sum(max(0.0, wh[i] - base[i] / 60) for i in range(i0, i1 + 1)) / 1000
        out.append(dict(start=local(mins[i0]), end=local(mins[i1] + 60), kind=kind, blocks=len(s),
                        lens=lens, peak_w=max(w[i0:i1 + 1]), kwh=round(kwh, 3)))
    total = (counter[-1][1] - counter[0][1])
    return out, total, mins, wh, base


def mode_minute(a):
    sess, total, *_ = classify_minutes(utc(a.frm or "2026-11-14T14:00"), utc(a.to))
    by = {}
    for s in sess:
        print(f"{s['start']:%m-%d %H:%M} -> {s['end']:%H:%M}  {s['kind']:<10} blocks={s['blocks']:2d} "
              f"peak={s['peak_w']:5.0f} W  {s['kwh']:.2f} kWh  lens={s['lens']}")
        by[s["kind"]] = by.get(s["kind"], 0) + s["kwh"]
    print(f"\nmeter 3 total {total:.2f} kWh; " + ", ".join(f"{k} {v:.2f}" for k, v in sorted(by.items()))
          + f"; baseline/rest {total - sum(by.values()):.2f}")
    if a.csv:
        with open(a.csv, "w", newline="") as f:
            wr = csv.DictWriter(f, fieldnames=list(sess[0].keys())); wr.writeheader(); wr.writerows(sess)


# ---------------------------------------------------------------- hourly mode
def hourly_model(hours):
    """hours: list of (local datetime, kWh). Returns per-hour (oven, dishwasher, other) kWh."""
    v = [k for _, k in hours]
    out = []
    for i, (t, k) in enumerate(hours):
        win = v[max(0, i - 7 * 24):i + 7 * 24]
        base = sorted(win)[len(win) // 5] if win else 0      # 20th percentile of +-7 days
        ex = max(0.0, k - base)
        ex = ex if ex > 0.25 else 0.0                        # below ~15 min of 1 kW = noise
        if t.hour in OVEN_HOURS: out.append((t, ex, 0.0, base))
        elif t.hour in NIGHT_HOURS: out.append((t, 0.0, ex, base))
        else: out.append((t, 0.0, 0.0, base))
    return out


def counter_to_hours(pts):
    hrs = []
    for (a, va), (b, vb) in zip(pts, pts[1:]):
        d = vb - va
        if 0 <= d < 10 and b - a <= 2 * 3600:                # skip resets and gaps
            hrs.append((local(a).replace(minute=0, second=0, microsecond=0), d))
    return hrs


def mode_hourly(a):
    pts = fetch("line3Total", utc(a.frm or "2023-12-11"), utc(a.to if a.to != "now" else "2024-12-08"))
    res = hourly_model(counter_to_hours(pts))
    months = {}
    for t, ov, dw, _ in res:
        m = months.setdefault(t.strftime("%Y-%m"), [0, 0, 0])
        m[0] += ov; m[1] += dw
    tot = {}
    for (a_, va), (b, vb) in zip(pts, pts[1:]):
        d = vb - va
        if 0 <= d < 10: tot[local(a_).strftime("%Y-%m")] = tot.get(local(a_).strftime("%Y-%m"), 0) + d
    print("month     meter3  oven~  dishwasher~")
    for k in sorted(months):
        print(f"{k}  {tot.get(k, 0):7.1f} {months[k][0]:6.1f} {months[k][1]:8.1f}")
    print(f"total     {sum(tot.values()):7.1f} {sum(m[0] for m in months.values()):6.1f} "
          f"{sum(m[1] for m in months.values()):8.1f}   (estimates; see the module docstring)")
    if a.csv:
        with open(a.csv, "w", newline="") as f:
            wr = csv.writer(f); wr.writerow(["hour", "oven_kwh_est", "dishwasher_kwh_est", "baseline_kwh"])
            for t, ov, dw, b in res: wr.writerow([t.isoformat(), round(ov, 3), round(dw, 3), round(b, 3)])


def mode_calibrate(a):
    start, end = utc(a.frm or "2026-11-14T14:00"), utc(a.to)
    sess, total, mins, wh, base = classify_minutes(start, end)
    exact = {}
    for s in sess:
        if s["kind"] in ("oven", "dishwasher"):
            exact[s["kind"]] = exact.get(s["kind"], 0) + s["kwh"]
    hrs = {}
    for m, e in zip(mins, wh):
        h = local(m).replace(minute=0, second=0, microsecond=0)
        hrs[h] = hrs.get(h, 0) + e / 1000
    res = hourly_model(sorted(hrs.items()))
    est = {"oven": sum(r[1] for r in res), "dishwasher": sum(r[2] for r in res)}
    print(f"period {start:%m-%d %H:%M} .. {end:%m-%d %H:%M} UTC, meter 3 total {total:.2f} kWh")
    for k in ("oven", "dishwasher"):
        e, h = exact.get(k, 0), est[k]
        print(f"  {k:<10} minute model {e:6.2f} kWh   hourly model {h:6.2f} kWh   "
              f"ratio {h / e if e else float('nan'):.2f}")


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("mode", choices=["minute", "hourly", "calibrate"])
    p.add_argument("--from", dest="frm")
    p.add_argument("--to", default="now")
    p.add_argument("--csv")
    a = p.parse_args()
    {"minute": mode_minute, "hourly": mode_hourly, "calibrate": mode_calibrate}[a.mode](a)
