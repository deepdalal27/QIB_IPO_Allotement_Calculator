import json
from pathlib import Path

import pytest

from scraper.allotment import calibration_from_history, qib_allotment

CASES = json.loads((Path(__file__).parent / "allotment_cases.json").read_text())


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_cases(case):
    assert qib_allotment(**case["in"])["allotted_shares"] == case["out"]["allotted_shares"]


def test_calibration_median():
    apps = [{"actual_allotted_shares": a, "predicted_allotted_shares": 100} for a in (90, 95, 100)]
    assert calibration_from_history(apps) == {"haircut": 0.95, "samples": 3}
