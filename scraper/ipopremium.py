"""Parser for www.ipopremium.in (layout checked against saved pages, Oct 2026).

List page  ("/"): a static table (headers: Company Name | Type | GMP (₹) | Open | Close |
    Price Band (₹) | Listing Date) with full dates such as "Nov 2, 2026". The other table on the
    page is filled in by AJAX from a signed URL that expires, so it is not used.
Detail page ("/view/ipo/<id>/<slug>"):
    * .ip-stat blocks        label/value pairs: GMP Rumors, Price Band, Lot Size, Subscribed ...
    * .ip-timeline__step     Open / Close / Allotment / Listing dates (no year, e.g. "Oct 27")
    * .ip-hero__meta         status chip (.ip-status--closed etc.) and "Lists on Nov 3, 2026"
    * table.sp-table #1      Category | Offered | Applied | Times, in SHARES. "QIBs" here is NET
                             of anchor (the anchor portion is listed separately)
    * table.sp-table         the same layout in ₹ crore, including FIIs / DIIs / Mutual funds / Others rows
    * table "Shares offered | Share"   reservation: Anchor / QIB / HNI / Retail
Generic label matching is kept as a fallback in case the layout changes.
"""
from __future__ import annotations

import datetime as dt
import re
from urllib.parse import urljoin

from bs4 import BeautifulSoup
from dateutil import parser as dparser

BASE_URL = "https://www.ipopremium.in/"
DETAIL_LINK_RE = re.compile(r"ipopremium\.in/view/ipo/\d+|^/?view/ipo/\d+", re.I)

NUM_RE = re.compile(r"-?\d[\d,]*\.?\d*")
# Tags IPO Premium appends to names, e.g. "BLS Polymers Ltd (MAINBOARD)", "Vedant Poly Fabs Ltd. (NSE SME)"
TAG_RE = re.compile(r"\(\s*((?:NSE|BSE)?\s*SME|MAIN\s*BOARD|NSE|BSE)\s*\)", re.I)


def num(text):
    """'₹ 1,234.50' -> 1234.5 ; '152.3x' -> 152.3 ; '-' or '' -> None"""
    if text is None:
        return None
    m = NUM_RE.search(str(text).replace("−", "-"))
    if not m:
        return None
    try:
        return float(m.group().replace(",", ""))
    except ValueError:
        return None


def all_nums(text):
    # en/em dashes are range separators ("142–150"), not minus signs
    t = str(text or "").replace("–", " ").replace("—", " ").replace("−", "-")
    return [float(x.replace(",", "")) for x in re.findall(r"\d[\d,]*\.?\d*", t)]


def clean(t):
    return re.sub(r"\s+", " ", (t or "")).strip()


def clean_name(name):
    name = TAG_RE.sub("", name)
    name = re.sub(r"\s*\bIPO\b\s*$", "", name, flags=re.I)
    return clean(name)


def slugify(name):
    s = re.sub(r"\b(ipo|limited|ltd\.?)\b", "", name.lower())
    return re.sub(r"[^a-z0-9]+", "-", s).strip("-")


def iso(text, year_hint=None):
    """'Nov 2, 2026' -> '2026-11-02'; 'Oct 27' + year_hint -> '<year>-10-27'."""
    text = clean(text)
    if not text or not re.search(r"\d", text):
        return None
    try:
        default = dt.datetime((year_hint or dt.date.today().year), 1, 1)
        d = dparser.parse(text, dayfirst=not re.match(r"[A-Za-z]", text), fuzzy=True, default=default).date()
        return d.isoformat()
    except (ValueError, OverflowError):
        return None


def _cells(tr):
    return [clean(td.get_text(" ")) for td in tr.find_all(["td", "th"])]


def _headers(table):
    head = table.find("thead")
    tr = head.find("tr") if head else table.find("tr")
    return [h.lower() for h in _cells(tr)] if tr else []


def _col(headers, *keys):
    for i, h in enumerate(headers):
        if any(k in h for k in keys):
            return i
    return None


# ----------------------------------------------------------------- list page
def parse_list(html, base_url=BASE_URL):
    soup = BeautifulSoup(html, "lxml")
    out, seen = [], set()
    for table in soup.find_all("table"):
        headers = _headers(table)
        i_gmp = _col(headers, "gmp", "premium")
        i_price = _col(headers, "price")
        i_type = _col(headers, "type")
        i_open = _col(headers, "open")
        i_close = next((i for i, h in enumerate(headers) if h == "close" or h.startswith("close")), None)
        i_list = _col(headers, "listing")
        for tr in table.find_all("tr"):
            a = tr.find("a", href=True)
            if not a:
                continue
            href = urljoin(base_url, a["href"])
            if not DETAIL_LINK_RE.search(href) or href in seen:
                continue
            cells = _cells(tr)
            raw = clean(a.get_text(" ")) or (cells[0] if cells else "")
            if not raw:
                continue
            seen.add(href)
            pick = lambda i: cells[i] if i is not None and i < len(cells) else None  # noqa: E731
            tag = TAG_RE.search(raw)
            typ = (pick(i_type) or (tag.group(1) if tag else "")).lower()
            band = all_nums(pick(i_price))
            out.append({
                "name": clean_name(raw),
                "url": href,
                "is_sme": "sme" in typ,
                "exchange_tag": tag.group(1).strip() if tag else None,
                "gmp": num(pick(i_gmp)),
                "price_band_low": min(band) if band else None,
                "price_band_high": max(band) if band else None,
                "open_date": iso(pick(i_open)),
                "close_date": iso(pick(i_close)),
                "listing_date": iso(pick(i_list)),
            })
    return out


# --------------------------------------------------------------- detail page
SUB_ROWS = [
    ("anchor", re.compile(r"anchor", re.I)),
    ("qib", re.compile(r"\bqibs?\b|qualified\s+institution", re.I)),
    ("bnii", re.compile(r"\bb[\s-]?nii|\bbhni|big\s+nii|hnis?\s*\(?\s*10\s*(l|\+)|>\s*(₹|rs\.?)?\s*10\s*l", re.I)),
    ("snii", re.compile(r"\bs[\s-]?nii|\bshni|small\s+nii|hnis?\s*\(?\s*2\s*(-|\+)|<\s*(₹|rs\.?)?\s*10\s*l", re.I)),
    ("nii", re.compile(r"\bnii\b|\bhnis?\b|non[\s-]institution", re.I)),
    ("retail", re.compile(r"retail|\brii\b", re.I)),
    ("employee", re.compile(r"employee", re.I)),
    ("shareholder", re.compile(r"shareholder", re.I)),
    ("total", re.compile(r"^total|overall", re.I)),
]
QIB_SPLIT_ROWS = {"fii": r"\bfiis?\b|\bfpis?\b", "dii": r"\bdiis?\b", "mf": r"mutual", "others": r"other"}


def _category(label):
    for key, rx in SUB_ROWS:
        if rx.search(label):
            if key == "anchor" and re.search(r"\bqib|qualified", label, re.I) and \
                    re.search(r"\bex\b|excl|without|\bnet\b", label, re.I):
                return "qib"  # "QIB (Ex Anchor)" is the net QIB row
            return key
    return None


def _kv_pairs(soup):
    kv = {}
    for st in soup.select(".ip-stat"):
        lab, val = st.select_one(".ip-stat__label"), st.select_one(".ip-stat__value")
        if lab and val:
            k = clean(lab.find(string=True, recursive=False) or lab.get_text(" ")).lower().rstrip(" *:")
            kv.setdefault(k, clean(val.get_text(" ")))
    for tr in soup.find_all("tr"):
        c = _cells(tr)
        if len(c) == 2 and c[0] and len(c[0]) < 60:
            kv.setdefault(c[0].rstrip(":").lower(), c[1])
    for d in soup.find_all("dt"):
        dd = d.find_next_sibling("dd")
        if dd:
            kv.setdefault(clean(d.get_text()).rstrip(":").lower(), clean(dd.get_text(" ")))
    return kv


def _kv(kv, *patterns, exclude=None):
    for k, v in kv.items():
        if exclude and re.search(exclude, k):
            continue
        if any(re.search(p, k) for p in patterns):
            return v
    return None


def _timeline(soup):
    out = {}
    for step in soup.select(".ip-timeline__step, .ip-timeline li"):
        lab, date = step.select_one(".ip-timeline__label"), step.select_one(".ip-timeline__date")
        if lab and date:
            out[clean(lab.get_text()).lower()] = clean(date.get_text())
    return out


def parse_subscription(soup):
    """Returns (subscription_in_shares, qib_split_in_crore).

    subscription: {category: {'times', 'shares_offered', 'shares_bid', 'label'}}
    qib_split:    {'fii'|'dii'|'mf'|'others': ₹ crore applied}  (if the page has the ₹-crore table)
    """
    share_tables, best_split = [], {}
    for table in soup.find_all("table"):
        headers = _headers(table)
        i_times = _col(headers, "times", "subscri", "(x)")
        if i_times is None:
            continue  # day-wise and reservation tables have no 'times' column
        i_off = _col(headers, "offered", "reserved", "on offer")
        i_bid = _col(headers, "applied", "bid", "demand")
        found, split = {}, {}
        for tr in table.find_all("tr")[1:]:
            c = _cells(tr)
            if len(c) < 2:
                continue
            get = lambda i: num(c[i]) if i is not None and i < len(c) else None  # noqa: E731
            for k, rx in QIB_SPLIT_ROWS.items():
                if re.search(rx, c[0], re.I):
                    split[k] = get(i_bid)
                    break
            else:
                key = _category(c[0])
                if key and key not in found:
                    found[key] = {"times": get(i_times), "shares_offered": get(i_off),
                                  "shares_bid": get(i_bid), "label": c[0]}
        if split:
            best_split = split  # the ₹-crore table: its 'offered' values are crores, not shares
        elif "qib" in found:
            share_tables.append(found)
    sub = max(share_tables, key=len) if share_tables else {}
    return sub, best_split


def parse_reservation(soup):
    """'Shares offered | Share' table -> {'anchor': n, 'qib': n, ...}."""
    for table in soup.find_all("table"):
        h = _headers(table)
        i_sh = _col(h, "shares offered")
        if i_sh is None or _col(h, "times") is not None:
            continue
        res = {}
        for tr in table.find_all("tr")[1:]:
            c = _cells(tr)
            key = _category(c[0]) if c else None
            if key and i_sh < len(c):
                res.setdefault(key, num(c[i_sh]))
        if res:
            return res
    return {}


def parse_listing(soup):
    """'Exchange | Listed at | Gain | %' table -> {'nse': {'price', 'gain'}, 'bse': {...}}.

    Falls back to the hero stat 'Listing Gain (NSE)  +₹460.00  +65.71% · listed at ₹1,160.00'.
    """
    out = {}
    for table in soup.find_all("table"):
        h = _headers(table)
        i_ex, i_at, i_gain = _col(h, "exchange"), _col(h, "listed at", "listing price"), _col(h, "gain")
        if i_ex is None or i_at is None:
            continue
        for tr in table.find_all("tr")[1:]:
            c = _cells(tr)
            if len(c) > i_at and num(c[i_at]) is not None:
                out[c[i_ex].lower()] = {"price": num(c[i_at]),
                                        "gain": num(c[i_gain]) if i_gain is not None and i_gain < len(c) else None}
        if out:
            return out
    for st in soup.select(".ip-stat"):
        text = clean(st.get_text(" "))
        m = re.search(r"listed at\s*₹?\s*([\d,]+\.?\d*)", text, re.I)
        if m:
            ex = re.search(r"\((NSE|BSE)\)", text)
            val = st.select_one(".ip-stat__value")
            out[(ex.group(1) if ex else "nse").lower()] = {
                "price": num(m.group(1)), "gain": num(val.get_text()) if val else None}
            break
    return out


def parse_detail(html):
    soup = BeautifulSoup(html, "lxml")
    kv = _kv_pairs(soup)
    tl = _timeline(soup)

    hero = soup.select_one(".ip-hero__meta")
    hero_text = clean(hero.get_text(" ")) if hero else ""
    year = re.search(r"\b(20\d\d)\b", hero_text)
    year = int(year.group(1)) if year else None
    st = soup.select_one(".ip-status")
    site_status = None
    if st:
        cls = " ".join(st.get("class", []))
        m = re.search(r"ip-status--(\w+)", cls)
        site_status = (m.group(1) if m else clean(st.get_text())).lower()

    def tdate(label_rx, kv_rx):
        v = next((v for k, v in tl.items() if re.search(label_rx, k)), None) or _kv(kv, kv_rx, exclude=r"price|gain|status")
        return iso(v, year) if v else None

    # Timeline dates have no year; the year comes from "Lists on <date>, <year>". Near New Year,
    # a date that lands after the listing date belongs to the previous year.
    lst = tdate(r"^list", r"listing date")
    def fix(d):
        if d and lst and d > lst:
            y, rest = d.split("-", 1)
            return f"{int(y) - 1}-{rest}"
        return d

    band = all_nums(_kv(kv, r"price band", r"^issue price", r"^price") or "")
    rec = {
        "price_band_low": min(band) if band else None,
        "price_band_high": max(band) if band else None,
        "issue_price": num(_kv(kv, r"final issue price", r"^issue price$")),
        "lot_size": num(_kv(kv, r"lot size", r"market lot")),
        "open_date": fix(tdate(r"^open", r"open date")),
        "close_date": fix(tdate(r"^close", r"close date")),
        "allotment_date": fix(tdate(r"allot", r"allotment date")),
        "listing_date": lst,
        "listing_price": num(_kv(kv, r"listing price", r"listed at", r"listing open", r"open(ing)? price")),
        "gmp": num(_kv(kv, r"\bgmp\b", r"grey market", exclude=r"date|updated|kostak")),
        "exchange": _kv(kv, r"listing at", r"exchange"),
        "site_status": site_status,
        "is_sme": bool(re.search(r"\bsme\b", hero_text, re.I)) if hero_text else None,
    }
    listing = parse_listing(soup)
    if listing:
        main = listing.get("nse") or next(iter(listing.values()))
        rec["listing_prices"] = {k: v["price"] for k, v in listing.items()}
        rec["listing_price"] = main["price"]
        if main.get("gain") is not None and not rec["issue_price"]:
            derived = round(main["price"] - main["gain"], 2)
            lo, hi = rec["price_band_low"], rec["price_band_high"]
            # Accept "listed at − gain" only if it lies inside the price band. Some pages (seen on
            # SME issues) show gains that don't match the band; the upper band is used for those.
            if lo is None or hi is None or lo - 0.01 <= derived <= hi + 0.01:
                rec["issue_price"] = derived
            else:
                rec["issue_price_check"] = f"listed-at minus gain gave {derived}, outside band {lo}-{hi}; used upper band"
        if not rec["listing_date"]:
            m = re.search(r"listed on\s+([A-Za-z]{3,9}\s+\d{1,2},\s*\d{4})", hero_text, re.I)
            rec["listing_date"] = iso(m.group(1)) if m else None

    sub, split = parse_subscription(soup)
    rec["subscription"] = sub
    if split:
        rec["qib_split_cr"] = split
    res = parse_reservation(soup)
    if res.get("anchor"):
        rec["anchor_shares"] = res["anchor"]
    q = sub.get("qib") or {}
    rec["qib_shares_offered"] = q.get("shares_offered") or res.get("qib")
    return rec
