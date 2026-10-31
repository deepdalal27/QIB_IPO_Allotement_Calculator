"""Parser tests against SYNTHETIC fixtures (see tests/fixtures/README.md)."""
import datetime as dt
from pathlib import Path

from scraper import ipopremium, update

F = Path(__file__).parent / "fixtures"


def test_list():
    rows = ipopremium.parse_list((F / "list.html").read_text())
    assert [r["name"] for r in rows] == ["Alpha Tech", "Beta Foods"]
    assert rows[0]["url"] == "https://www.ipopremium.in/view/ipo/901/alpha-tech-ipo"
    assert rows[0]["gmp"] == 25 and not rows[0]["is_sme"] and rows[1]["is_sme"]


def test_detail():
    d = ipopremium.parse_detail((F / "detail.html").read_text())
    assert (d["price_band_low"], d["price_band_high"], d["lot_size"]) == (100, 105, 142)
    assert d["listing_price"] == 131.5 and d["gmp"] == 25
    assert d["subscription"]["qib"]["times"] == 152.31
    assert d["subscription"]["anchor"]["times"] == 1.0
    assert d["qib_shares_offered"] == 4285714
    assert update.to_date(d["listing_date"]) == dt.date(2026, 11, 10)


def test_status_and_freeze():
    d = ipopremium.parse_detail((F / "detail.html").read_text())
    d.pop("listing_price")
    rec = update.apply_status_and_freeze(dict(d), dt.date(2026, 11, 7), "t1")
    assert rec["status"] == "closed" and rec["final_subscription"]["qib"]["times"] == 152.31
    rec["listing_price"] = 131.5
    rec = update.apply_status_and_freeze(rec, dt.date(2026, 11, 10), "t2")
    assert rec["status"] == "listed" and rec["final_locked"]
    # a later scrape must not overwrite the locked final figures
    later = update.merge(rec, {"final_subscription": {"qib": {"times": 1}}, "subscription": {"qib": {"times": 1}}})
    later = update.apply_status_and_freeze(later, dt.date(2026, 11, 12), "t3")
    assert later["final_subscription"]["qib"]["times"] == 152.31


def test_exchange_tags_stripped():
    assert ipopremium.clean_name("BLS Polymers Ltd (MAINBOARD)") == "BLS Polymers Ltd"
    assert ipopremium.clean_name("Johnsoncab Electricals Ltd.(BSE SME)") == "Johnsoncab Electricals Ltd."
    assert ipopremium.slugify(ipopremium.clean_name("Vedant Poly Fabs Ltd. (NSE SME)")) == "vedant-poly-fabs"
    db = update.migrate_slugs({"bls-polymers-mainboard": {"name": "BLS Polymers Ltd (MAINBOARD)", "gmp": 66}})
    assert list(db) == ["bls-polymers"] and db["bls-polymers"]["name"] == "BLS Polymers Ltd"
