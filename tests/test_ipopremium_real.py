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
