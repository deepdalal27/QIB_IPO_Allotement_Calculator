"""Python mirror of docs/allotment.js. The scheduled job uses it to fill in saved applications.

Keep it in sync with the JS version: tests/allotment_cases.json is run against both.
"""
from __future__ import annotations

import math
from statistics import median

DEFAULT_MF_RESERVE_PCT = 5


def qib_allotment(bid_shares, net_qib_shares, subscription_times, lot_size=1,
                  mf_reserve_pct=DEFAULT_MF_RESERVE_PCT, mf_demand_shares=None,
                  is_mutual_fund=False, rounding="share", haircut=1.0, valid_demand_shares=None):
    """valid_demand_shares: EXACT MODE. Final valid QIB demand (shares) from the Basis of Allotment."""
    N = net_qib_shares
    exact = bool(valid_demand_shares and valid_demand_shares > 0)
    if not bid_shares or not N or bid_shares <= 0 or N <= 0 or not (exact or (subscription_times or 0) > 0):
        return {"allotted_shares": 0, "ratio": 0.0, "naive_shares": 0}
    D = valid_demand_shares if exact else subscription_times * N
    M = math.floor(N * mf_reserve_pct / 100)
    G = N - M
    Dmf = math.inf if mf_demand_shares is None else max(0, mf_demand_shares)
    mf_from_reserve = min(Dmf, M)
    pool_supply = G + (M - mf_from_reserve)
    pool_demand = max(D - mf_from_reserve, 0)
    general_ratio = min(1.0, pool_supply / pool_demand) if pool_demand > 0 else 1.0

    if is_mutual_fund and math.isfinite(Dmf) and Dmf > 0:
        from_reserve = bid_shares * min(1.0, M / Dmf)
        raw = from_reserve + (bid_shares - from_reserve) * general_ratio
    else:
        raw = bid_shares * general_ratio
    if not exact:
        raw *= haircut

    unit = lot_size if rounding == "lot" else 1
    allotted = min(bid_shares, math.floor(raw / unit + 1e-9) * unit)
    return {
        "allotted_shares": int(allotted),
        "ratio": allotted / bid_shares,
        "general_ratio": general_ratio,
        "naive_shares": math.floor(bid_shares / max(D / N if exact else subscription_times, 1)),
        "exact": exact,
    }


def calibration_from_history(apps):
    r = [a["actual_allotted_shares"] / a["predicted_allotted_shares"]
         for a in apps
         if a.get("actual_allotted_shares") is not None and (a.get("predicted_allotted_shares") or 0) > 0]
    return {"haircut": median(r) if r else 1.0, "samples": len(r)}
