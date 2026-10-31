"""Tests against excerpts of REAL IPO Premium pages (saved 2026-10-31)."""
from pathlib import Path

from scraper import ipopremium, update
from scraper.allotment import qib_allotment

F = Path(__file__).parent / "fixtures"


def test_list_excerpt():
    rows = ipopremium.parse_list((F / "ipopremium_list_excerpt.html").read_text())
    assert len(rows) == 12
    v = rows[0]
    assert v["name"] == "Vedant Poly Fabs Ltd." and v["is_sme"] and v["exchange_tag"] == "NSE SME"
    assert (v["price_band_low"], v["price_band_high"], v["gmp"]) == (88, 94, 4.25)
    assert (v["open_date"], v["close_date"], v["listing_date"]) == ("2026-11-02", "2026-11-04", "2026-11-09")
    assert v["url"] == "https://www.ipopremium.in/view/ipo/1432/vedant-poly-fabs-ltd"
    bls = next(r for r in rows if r["name"] == "BLS Polymers Ltd")
    assert not bls["is_sme"] and bls["listing_date"] == "2026-11-03"


def test_detail_excerpt():
    d = ipopremium.parse_detail((F / "ipopremium_detail_excerpt.html").read_text())
    assert (d["price_band_low"], d["price_band_high"], d["lot_size"], d["gmp"]) == (142, 150, 100, 67)
    assert (d["open_date"], d["close_date"], d["allotment_date"], d["listing_date"]) == \
        ("2026-10-27", "2026-10-29", "2026-10-30", "2026-11-03")
    assert d["site_status"] == "closed" and d["is_sme"] is False
    q = d["subscription"]["qib"]
    assert (q["times"], q["shares_offered"]) == (200.25, 3_400_000)      # net of anchor
    assert d["anchor_shares"] == 5_100_000
    assert d["subscription"]["bnii"]["times"] == 592.83 and d["subscription"]["snii"]["times"] == 491.95
    assert d["qib_split_cr"] == {"fii": 1366.36, "dii": 4542.43, "mf": 60.54, "others": 4243.54}


def test_end_to_end_effective_and_allotment():
    d = ipopremium.parse_detail((F / "ipopremium_detail_excerpt.html").read_text())
    import datetime as dt
    rec = update.apply_status_and_freeze(d, dt.date(2026, 10, 31), "t")
    e = update.effective(rec)
    assert rec["status"] == "closed"
    assert e["net_qib_shares"] == 3_400_000 and e["qib_times"] == 200.25
    assert e["mf_demand_shares"] == 4_036_000          # ₹60.54 cr / ₹150
    # ₹5 cr bid at ₹150 = 3,33,300 shares (3,333 lots of 100)
    r = qib_allotment(333_300, e["net_qib_shares"], e["qib_times"], lot_size=100,
                      mf_demand_shares=e["mf_demand_shares"])
    assert r["naive_shares"] == 1664 and r["allotted_shares"] == 1581


def test_listed_excerpt_listing_price_and_lock():
    import datetime as dt
    d = ipopremium.parse_detail((F / "ipopremium_listed_excerpt.html").read_text())
    assert d["listing_price"] == 1160 and d["listing_prices"] == {"nse": 1160, "bse": 1162}
    assert d["issue_price"] == 700                      # listed at 1,160 − gain 460
    assert d["listing_date"] == "2026-10-23" and d["site_status"] == "listed"
    assert d["subscription"]["qib"]["times"] == 293.56 and d["anchor_shares"] == 3_648_013
    rec = update.apply_status_and_freeze(d, dt.date(2026, 10, 31), "t")
    assert rec["status"] == "listed" and rec["final_locked"] and rec["listing_gain_pct"] == 65.71


def test_derived_issue_price_outside_band_is_rejected():
    html = (F / "ipopremium_listed_excerpt.html").read_text().replace("+₹460.00", "+₹900.00")
    d = ipopremium.parse_detail(html)
    assert d["issue_price"] is None and "outside band" in d["issue_price_check"]
    assert update.effective(d)["issue_price"] == 700          # falls back to the upper band


def test_stored_issue_price_outside_band_is_corrected():
    import datetime as dt
    rec = {"issue_price": 55.8, "price_band_low": 88, "price_band_high": 93, "listing_price": 74.4,
           "listing_date": "2026-10-20"}
    rec = update.apply_status_and_freeze(rec, dt.date(2026, 10, 31), "t")
    assert rec["issue_price"] is None and update.effective(rec)["issue_price"] == 93
    assert rec["listing_gain_pct"] is None   # unverified issue price: no gain published


def _row_html(n, name, status_date):
    return (f'<tr><td><a href="https://www.ipopremium.in/view/ipo/{n}/{name.lower()}">{name} Ltd (MAINBOARD)</a></td>'
            f'<td>Mainboard</td><td>5</td><td>{status_date}</td><td>{status_date}</td><td>100–105</td><td></td></tr>')


def test_scrape_reads_all_list_pages_and_refreshes_ipos_that_dropped_off(monkeypatch):
    import datetime as dt
    head = "<table><tr><th>Company Name</th><th>Type</th><th>GMP (₹)</th><th>Open</th><th>Close</th><th>Price Band (₹)</th><th>Listing Date</th></tr>"
    home = head + _row_html(1, "Alpha", "Oct 30, 2026") + "</table>"
    subs = head + _row_html(1, "Alpha", "Oct 30, 2026") + _row_html(2, "Beta", "Oct 30, 2026") + "</table>"
    detail = (F / "ipopremium_detail_excerpt.html").read_text()
    calls = []

    def get(url):
        calls.append(url)
        if url == update.ipopremium.BASE_URL:
            return home
        if url.endswith("view/subscription"):
            return subs
        if url.endswith("calendar"):
            return None                      # a missing page is skipped
        return detail

    monkeypatch.setattr(update.time, "sleep", lambda s: None)
    db = {"gamma": {"slug": "gamma", "name": "Gamma Ltd", "url": "https://www.ipopremium.in/view/ipo/3/gamma", "sources": []}}
    stats = update.scrape(db, dt.date(2026, 10, 31), "t", get=get)
    assert {"alpha", "beta", "gamma"} <= set(db)            # Beta only appears on the subscription page
    assert stats["list_rows"] == 2 and stats["list_pages_ok"] == 2
    assert stats["refreshed_off_list"] == 1                 # Gamma is not on any list but was refreshed
    assert "https://www.ipopremium.in/view/ipo/3/gamma" in calls
    assert db["gamma"]["lot_size"] == 100                   # filled from its detail page


def test_health_check_flags_empty_scrape_and_missing_fields():
    import datetime as dt
    assert update.health_check({}, {"list_rows": 0, "details_failed": []}, dt.date(2026, 10, 31))
    db = {"x": {"name": "X", "status": "open", "is_sme": False, "effective": {"issue_price": 100}}}
    probs = update.health_check(db, {"list_rows": 5, "details_failed": []}, dt.date(2026, 10, 31))
    assert any("missing lot_size, qib_times" in p for p in probs)
