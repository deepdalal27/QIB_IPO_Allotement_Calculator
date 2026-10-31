"""Parser for www.ipopremium.in.

The parser does not depend on fixed CSS selectors, so a site redesign is less likely to break it:
  * list page   -> every table row that links to an IPO detail page
  * detail page -> label/value pairs (2-cell rows, <dt>/<dd>, "Label: value" text) plus the
                   subscription table (rows labelled QIB / NII / Retail / Total ...)
If the site changes beyond this, add the values by hand in data/overrides.json.
"""
from __future__ import annotations

import re
from urllib.parse import urljoin

from bs4 import BeautifulSoup

BASE_URL = "https://www.ipopremium.in/"
# Links that point to an IPO detail page. Adjust here if the site changes its URL scheme.
DETAIL_LINK_RE = re.compile(r"ipopremium\.in/.*(view|ipo)/|^/?(view|ipo)/", re.I)

NUM_RE = re.compile(r"-?\d[\d,]*\.?\d*")


def num(text):
    """'₹ 1,234.50' -> 1234.5 ; '152.3x' -> 152.3 ; '' -> None"""
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
    return [float(x.replace(",", "")) for x in NUM_RE.findall(str(text or "").replace("−", "-"))
            if x.replace(",", "").replace(".", "").lstrip("-")]


def clean(t):
    return re.sub(r"\s+", " ", (t or "")).strip()


def slugify(name):
    s = re.sub(r"\b(ipo|limited|ltd\.?)\b", "", name.lower())
    return re.sub(r"[^a-z0-9]+", "-", s).strip("-")


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
        i_type = _col(headers, "type", "board", "category")
        i_date = _col(headers, "date", "open")
        for tr in table.find_all("tr"):
            a = tr.find("a", href=True)
            if not a:
                continue
            href = urljoin(base_url, a["href"])
            if not DETAIL_LINK_RE.search(href) or href in seen:
                continue
            cells = _cells(tr)
            name = clean(a.get_text(" ")) or (cells[0] if cells else "")
            if not name:
                continue
            seen.add(href)
            row_text = " ".join(cells).lower()
            pick = lambda i: cells[i] if i is not None and i < len(cells) else None  # noqa: E731
            out.append({
                "name": re.sub(r"\s*\bIPO\b\s*$", "", name, flags=re.I).strip(),
                "url": href,
                "is_sme": "sme" in (pick(i_type) or row_text).lower(),
                "gmp": num(pick(i_gmp)),
                "price_text": pick(i_price),
                "date_text": pick(i_date),
            })
    return out


# --------------------------------------------------------------- detail page
SUB_ROWS = [
    ("anchor", re.compile(r"anchor", re.I)),
    ("qib", re.compile(r"\bqib|qualified\s+institution", re.I)),
    ("bnii", re.compile(r"\bb[\s-]?nii|big\s+nii|>\s*(₹|rs\.?)?\s*10\s*l", re.I)),
    ("snii", re.compile(r"\bs[\s-]?nii|small\s+nii|<\s*(₹|rs\.?)?\s*10\s*l", re.I)),
    ("nii", re.compile(r"\bnii\b|\bhni\b|non[\s-]institution", re.I)),
    ("retail", re.compile(r"retail|\brii\b", re.I)),
    ("employee", re.compile(r"employee", re.I)),
    ("shareholder", re.compile(r"shareholder", re.I)),
    ("total", re.compile(r"total|overall", re.I)),
]


def _kv_pairs(soup):
    kv = {}
    for tr in soup.find_all("tr"):
        c = _cells(tr)
        if len(c) == 2 and c[0] and len(c[0]) < 60:
            kv.setdefault(c[0].rstrip(":").lower(), c[1])
    for dt in soup.find_all("dt"):
        dd = dt.find_next_sibling("dd")
        if dd:
            kv.setdefault(clean(dt.get_text()).rstrip(":").lower(), clean(dd.get_text(" ")))
    for el in soup.find_all(["li", "p", "div", "span"]):
        if el.find(["li", "p", "div", "table"]):
            continue
        m = re.match(r"^([A-Za-z][A-Za-z ()/.&-]{2,40}):\s*(.+)$", clean(el.get_text(" ")))
        if m:
            kv.setdefault(m.group(1).lower(), m.group(2))
    return kv


def _kv(kv, *patterns, exclude=None):
    for k, v in kv.items():
        if exclude and re.search(exclude, k):
            continue
        if any(re.search(p, k) for p in patterns):
            return v
    return None


def parse_subscription(soup):
    """Return {category: {'times', 'shares_offered', 'shares_bid'}} from the subscription table."""
    best = {}
    for table in soup.find_all("table"):
        headers = _headers(table)
        i_times = _col(headers, "times", "subscri", "(x)")
        i_off = _col(headers, "offered", "reserved", "on offer")
        i_bid = _col(headers, "bid for", "bids", "applied", "demand")
        found = {}
        for tr in table.find_all("tr"):
            c = _cells(tr)
            if len(c) < 2:
                continue
            label = c[0]
            for key, rx in SUB_ROWS:
                if not rx.search(label):
                    continue
                if key == "anchor" and re.search(r"\bqib|qualified", label, re.I) and \
                        re.search(r"\bex\b|excl|without|\bnet\b", label, re.I):
                    key = "qib"  # "QIB (Ex Anchor)" is the net QIB row, not the anchor row
                if key in found:
                    break
                get = lambda i: num(c[i]) if i is not None and i < len(c) else None  # noqa: E731
                times = get(i_times)
                if times is None:  # no header: take a cell ending in 'x'
                    xs = [num(x) for x in c[1:] if re.search(r"\d\s*x\b|times", x, re.I)]
                    times = xs[-1] if xs else (num(c[-1]) if len(c) == 2 else None)
                found[key] = {"times": times, "shares_offered": get(i_off), "shares_bid": get(i_bid), "label": label}
                break
        if "qib" in found and len(found) > len(best):
            best = found
    return best


def parse_detail(html):
    soup = BeautifulSoup(html, "lxml")
    kv = _kv_pairs(soup)
    price_nums = all_nums(_kv(kv, r"price band", r"issue price", r"^price") or "")
    rec = {
        "price_band_low": min(price_nums) if price_nums else None,
        "price_band_high": max(price_nums) if price_nums else None,
        "issue_price": num(_kv(kv, r"final issue price", r"issue price", exclude=r"band")),
        "lot_size": num(_kv(kv, r"lot size", r"market lot", r"min.*(lot|shares)")),
        "open_date": _kv(kv, r"open", exclude=r"price"),
        "close_date": _kv(kv, r"close", exclude=r"price"),
        "allotment_date": _kv(kv, r"allotment", exclude=r"status|link|check"),
        "listing_date": _kv(kv, r"listing date", r"^listing on", r"listing\b(?!.*(price|gain|at))"),
        "listing_price": num(_kv(kv, r"listing price", r"listed at", r"listing at", r"open(ing)? price")),
        "gmp": num(_kv(kv, r"\bgmp\b", r"grey market", r"premium", exclude=r"date|updated|kostak")),
        "exchange": _kv(kv, r"exchange", r"listing at"),
        "qib_shares_offered": num(_kv(kv, r"qib.*(share|quota|offered|reserv)", exclude=r"anchor")),
    }
    rec["subscription"] = parse_subscription(soup)
    q = rec["subscription"].get("qib") or {}
    if q.get("shares_offered"):
        rec["qib_shares_offered"] = q["shares_offered"]
    return rec
