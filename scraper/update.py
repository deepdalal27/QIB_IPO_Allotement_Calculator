"""Scheduled job: refresh IPO data from IPO Premium, keep history, fill in saved applications.

    python -m scraper.update                 # normal run (GitHub Actions)
    python -m scraper.update --offline       # skip network, just re-apply overrides & applications

Files:
    docs/data/ipos.json          every IPO ever seen. Records are never deleted, only updated.
    data/overrides.json          your hand-checked numbers (e.g. from the registrar's Basis of
                                 Allotment). Always takes priority over scraped values.
    data/applications.json       your QIB applications; the job fills in predictions, listing P&L
    docs/data/calibration.json   median actual/predicted allotment ratio (no amounts published)
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
import time
from pathlib import Path

from dateutil import parser as dparser

from . import ipopremium
from .allotment import calibration_from_history, qib_allotment

ROOT = Path(__file__).resolve().parent.parent
IPOS = ROOT / "docs/data/ipos.json"
CALIB = ROOT / "docs/data/calibration.json"
OVERRIDES = ROOT / "data/overrides.json"
APPS = ROOT / "data/applications.json"

IST = dt.timezone(dt.timedelta(hours=5, minutes=30))
UA = "Mozilla/5.0 (compatible; ipo-qib-calculator/1.0; personal use; +https://github.com)"
REFRESH_LISTED_DAYS = 10   # keep re-reading a detail page this many days after listing


def now_ist():
    return dt.datetime.now(IST)


def load(path, default):
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def save(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False, sort_keys=False) + "\n")


def to_date(text):
    if not text:
        return None
    if isinstance(text, dt.date):
        return text
    try:
        return dt.date.fromisoformat(str(text)[:10])
    except ValueError:
        pass
    try:
        return dparser.parse(str(text), dayfirst=True, fuzzy=True, default=dt.datetime(now_ist().year, 1, 1)).date()
    except (ValueError, OverflowError):
        return None


def fetch(url, session):
    for attempt in range(4):
        try:
            r = session.get(url, timeout=30, headers={"User-Agent": UA})
            if r.status_code == 200:
                return r.text
            print(f"  HTTP {r.status_code} for {url}", file=sys.stderr)
        except Exception as e:  # noqa: BLE001
            print(f"  error {e!r} for {url}", file=sys.stderr)
        time.sleep(2 ** (attempt + 1))
    return None


def status_of(rec, today):
    o, c, l = (to_date(rec.get(k)) for k in ("open_date", "close_date", "listing_date"))
    if rec.get("listing_price") or (l and today >= l):
        return "listed"
    if c and today > c:
        return "closed"
    if o and today >= o:
        return "open"
    if o:
        return "upcoming"
    site = (rec.get("site_status") or "").lower()
    for st in ("listed", "closed", "open", "upcoming"):
        if st in site:
            return st
    return rec.get("status") or "unknown"


def merge(old, new):
    """New non-empty values win, except fields that are frozen (final_*) or hand-set (override_*)."""
    out = dict(old)
    for k, v in new.items():
        if v in (None, "", {}, []):
            continue
        if k in out and k.startswith(("final_", "override_")):
            continue
        out[k] = v
    return out


def apply_status_and_freeze(rec, today, stamp):
    rec["status"] = status_of(rec, today)
    sub = rec.get("subscription") or {}
    if sub.get("qib", {}).get("times") is not None:
        hist = rec.setdefault("subscription_history", [])
        snap = {k: v.get("times") for k, v in sub.items()}
        if not hist or hist[-1]["times"] != snap:
            hist.append({"at": stamp, "times": snap})
    # Final subscription = the last figures seen after the issue closed. Locked once the IPO lists.
    if rec["status"] in ("closed", "listed") and sub.get("qib") and not rec.get("final_locked"):
        rec["final_subscription"] = sub
        rec["final_net_qib_shares"] = rec.get("qib_shares_offered")
        rec["final_qib_split_cr"] = rec.get("qib_split_cr")
        rec["final_captured_at"] = stamp
        if rec["status"] == "listed" and rec.get("listing_price"):
            rec["final_locked"] = True
    if rec.get("gmp") is not None and rec["status"] in ("upcoming", "open", "closed"):
        g = rec.setdefault("gmp_history", [])
        if not g or g[-1]["gmp"] != rec["gmp"]:
            g.append({"at": stamp, "gmp": rec["gmp"]})
    ip, lo, hi = rec.get("issue_price"), rec.get("price_band_low"), rec.get("price_band_high")
    if ip and lo and hi and not (lo - 0.01 <= ip <= hi + 0.01):   # stored value outside the band
        rec["issue_price_check"] = f"issue price {ip} outside band {lo}-{hi}; used upper band"
        rec["issue_price"] = None
    e = effective(rec)
    if rec.get("issue_price_check") and not rec.get("override_issue_price"):
        rec["listing_gain_pct"] = None   # don't publish a gain built on an issue price we couldn't verify
    elif e["listing_price"] and e["issue_price"]:
        rec["listing_gain_pct"] = round((e["listing_price"] / e["issue_price"] - 1) * 100, 2)
    return rec


def effective(rec):
    """Numbers used for calculations: override > final > live."""
    sub = rec.get("final_subscription") or rec.get("subscription") or {}
    price = rec.get("override_issue_price") or rec.get("issue_price") or rec.get("price_band_high")
    split = rec.get("final_qib_split_cr") or rec.get("qib_split_cr") or {}
    mf_cr = split.get("mf")
    return {
        "issue_price": price,
        # MF demand in shares, from the ₹-crore QIB split (₹1 cr = 1e7)
        "mf_demand_shares": rec.get("override_mf_demand_shares") or (round(mf_cr * 1e7 / price) if mf_cr and price else None),
        "lot_size": rec.get("override_lot_size") or rec.get("lot_size"),
        "net_qib_shares": rec.get("override_net_qib_shares") or rec.get("final_net_qib_shares") or rec.get("qib_shares_offered"),
        "qib_times": rec.get("override_qib_times") or (sub.get("qib") or {}).get("times"),
        "listing_price": rec.get("override_listing_price") or rec.get("listing_price"),
    }


def scrape(db, today, stamp):
    import requests
    s = requests.Session()
    html = fetch(ipopremium.BASE_URL, s)
    if not html:
        print("Could not load IPO Premium list page; keeping existing data.", file=sys.stderr)
        return
    rows = ipopremium.parse_list(html)
    print(f"list page: {len(rows)} IPO links")
    for row in rows:
        slug = ipopremium.slugify(row["name"])
        if not slug:
            continue
        rec = db.setdefault(slug, {"slug": slug, "first_seen": stamp, "sources": []})
        rec = merge(rec, row)
        lst = to_date(rec.get("listing_date"))
        stale = rec.get("final_locked") and lst and (today - lst).days > REFRESH_LISTED_DAYS
        if not stale:
            time.sleep(1.5)  # be polite
            detail = fetch(row["url"], s)
            if detail:
                rec = merge(rec, ipopremium.parse_detail(detail))
                if row["url"] not in rec["sources"]:
                    rec["sources"].append(row["url"])
        rec["last_seen"] = stamp
        db[slug] = rec


def apply_overrides(db):
    for slug, ov in load(OVERRIDES, {}).items():
        if slug.startswith("_"):
            continue
        rec = db.setdefault(slug, {"slug": slug, "name": ov.get("name", slug), "sources": ["manual"]})
        for k, v in ov.items():
            if k in ("issue_price", "lot_size", "net_qib_shares", "qib_times", "listing_price", "mf_demand_shares"):
                rec[f"override_{k}"] = v
            else:
                rec[k] = v


def enrich_applications(db):
    apps = load(APPS, [])
    for a in apps:
        rec = db.get(a.get("ipo_slug"))
        if not rec:
            a["note"] = "IPO not found in docs/data/ipos.json (check ipo_slug)"
            continue
        e = effective(rec)
        price = a.get("bid_price") or e["issue_price"]
        lot = a.get("lot_size") or e["lot_size"] or 1
        bid = a.get("bid_shares") or (int(a["amount"] // (price * lot)) * lot if a.get("amount") and price else 0)
        a["bid_shares"] = bid
        if bid and e["net_qib_shares"] and e["qib_times"]:
            r = qib_allotment(bid, e["net_qib_shares"], e["qib_times"], lot_size=lot,
                              is_mutual_fund=a.get("is_mutual_fund", False),
                              mf_demand_shares=a.get("mf_demand_shares") or e["mf_demand_shares"],
                              rounding=a.get("rounding", "share"))
            a["predicted_allotted_shares"] = r["allotted_shares"]
            a["naive_allotted_shares"] = r["naive_shares"]
            a["used_qib_times"] = e["qib_times"]
            a["used_net_qib_shares"] = e["net_qib_shares"]
        issue = e["issue_price"]
        if e["listing_price"] and issue:
            shares = a.get("actual_allotted_shares", a.get("predicted_allotted_shares")) or 0
            a["listing_price"] = e["listing_price"]
            a["listing_pnl"] = round(shares * (e["listing_price"] - issue), 2)
            a["listing_pnl_basis"] = "actual allotment" if a.get("actual_allotted_shares") is not None else "predicted allotment"
    if apps:
        save(APPS, apps)
    calib = calibration_from_history(apps)
    calib["updated"] = now_ist().isoformat(timespec="minutes")
    save(CALIB, calib)


def migrate_slugs(db):
    """Re-key records whose name still carries an exchange tag, e.g. '(MAINBOARD)'."""
    out = {}
    for slug, rec in db.items():
        name = ipopremium.clean_name(rec.get("name", slug))
        new = ipopremium.slugify(name) or slug
        rec = {**rec, "name": name, "slug": new}
        out[new] = merge(out[new], rec) if new in out else rec
    return out


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--offline", action="store_true")
    args = ap.parse_args(argv)
    now = now_ist()
    stamp, today = now.isoformat(timespec="minutes"), now.date()

    store = load(IPOS, {"ipos": {}})
    db = migrate_slugs(store.get("ipos", {}))
    if not args.offline:
        scrape(db, today, stamp)
    apply_overrides(db)
    for slug, rec in db.items():
        db[slug] = apply_status_and_freeze(rec, today, stamp)
        db[slug]["effective"] = effective(db[slug])

    order = {"open": 0, "upcoming": 1, "closed": 2, "listed": 3, "unknown": 4}
    db = dict(sorted(db.items(), key=lambda kv: (order.get(kv[1].get("status"), 9),
                                                  -(to_date(kv[1].get("open_date")) or dt.date.min).toordinal())))
    save(IPOS, {"updated": stamp, "source": "IPO Premium (www.ipopremium.in) + data/overrides.json", "ipos": db})
    enrich_applications(db)
    print(f"saved {len(db)} IPOs")


if __name__ == "__main__":
    main()
