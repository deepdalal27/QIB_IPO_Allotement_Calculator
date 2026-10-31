# IPO QIB Allotment Calculator

Enter an amount and see your bid in lots and shares, the **expected QIB allotment under SEBI's
proportionate basis**, and **listing P&L** at the issue price, ±₹2/5/10/20, ±% steps, the current GMP
and the actual listing price. Every number can be edited.

A GitHub Action scrapes IPO Premium on a schedule, saves every IPO it finds, locks the final
subscription figures once an IPO lists, and adds the listing results to your saved applications.

## Why you get fewer shares than a simple proportion

| Cause | Effect | What the tool does |
|---|---|---|
| Dividing by the **gross** QIB portion (including anchor) | Overestimates by roughly 2.5× (anchors take up to 60%) | Uses **net QIB (ex-anchor)** shares, which is the base the exchanges' "QIB ×" figure uses |
| **5% Mutual Fund reserve** (SEBI ICDR Schedule XIV) | Non-MF QIBs only share in 95% of the net QIB portion | Ratio = 0.95·N ÷ (D − MF reserve), not N ÷ D |
| **Rounding down** to whole shares or lots | A few shares lost per IPO | Rounds down; lot rounding available |
| Live subscription ≠ final valid demand (rejected bids, bids below the final price) | A small extra shortfall | **Calibration haircut**: the median of your actual ÷ predicted allotments, learned automatically |

Real example (BLS Polymers, Oct 2026): net QIB 34,00,000 shares, 200.25× subscribed, ₹5 cr bid at ₹150 = 3,33,300 shares.
A simple proportion gives 1,664 shares; SEBI's method gives **1,581**, about 5% fewer.

## Setup

1. Create a new **private** GitHub repo (your applications are personal) and push this folder:
   ```bash
   git remote add origin https://github.com/<you>/ipo-qib-calculator.git
   git push -u origin main
   ```
2. **Settings → Actions → General → Workflow permissions → Read and write.**
3. **Settings → Pages → Deploy from branch → `main` / `/docs`.** (GitHub Pages on a private repo needs a paid plan.
   On the free plan, run it locally with `cd docs && python -m http.server`, or make the repo public. Your
   application amounts are only in `data/`, which Pages doesn't serve, but a public repo would still show them.)
4. **Actions → Update IPO data → Run workflow** for the first scrape.

## Automated route

`.github/workflows/update-ipos.yml` runs four times each weekday during market hours (IST) plus once a day:

1. Reads the IPO Premium list page and each IPO's detail page (price band, lot size, dates, GMP,
   subscription by category, net QIB shares, listing price).
2. Merges into `docs/data/ipos.json`. **Records are never deleted.** Status moves upcoming → open →
   closed → listed. GMP and subscription history are kept.
3. When the issue closes, the latest figures become `final_subscription`. Once it lists, they are **locked**
   along with the listing price and listing gain.
4. Applies `data/overrides.json`, then fills in `data/applications.json` (predicted allotment, listing P&L)
   and `docs/data/calibration.json`.

## Your workflow per IPO

1. Open the site, pick the IPO, enter the amount, and adjust lots or shares if you want.
2. **Save application**, then **Export** and commit the file as `data/applications.json`.
3. After allotment, type the shares you actually got into the *Actual* column, then export and commit again.
   The calibration haircut updates, so future predictions match what you actually receive.
4. For the most accurate figures, copy the **final QIB (ex-anchor) subscription and net QIB shares from the
   registrar's Basis of Allotment** into `data/overrides.json`. Hand-entered values always take priority.

## Data sources

- **IPO Premium** (www.ipopremium.in) is the only site scraped automatically. Please check its terms of use. The scraper
  sends at most one request every 1.5 s and identifies itself.
- **SEBI does not publish subscription data.** Its site has the DRHP/RHP, which gives the net QIB share count to
  check against. The final, authoritative QIB subscription is in the registrar's **Basis of Allotment**,
  so enter that in `data/overrides.json` when it differs.
- The parser targets IPO Premium's real page layout (checked on 2026-10-31). The IPO list comes from the
  home page's static table, which has full dates, price bands, GMP and the SME/Mainboard type. Details
  come from the IPO page: price band, lot size, the Open/Close/Allotment/Listing timeline, the subscription
  table in shares (its "QIBs" row is **net of anchor**), the anchor reservation, and the QIB demand split
  in ₹ crore (FII / DII / **Mutual funds** / Others).
- **MF demand is used exactly:** the "Mutual funds" ₹-crore figure ÷ issue price gives MF demand in
  shares, which decides how the 5% MF reserve is shared out (see `effective.mf_demand_shares`).
- **Listing price:** read from the page's "Listing Price" table (NSE and BSE rows). NSE is used for P&L and
  both prices are stored. The final issue price is worked out as "Listed at − Gain". Once an IPO lists, its
  final subscription figures and listing data are locked.
- If the site changes its layout, the tests in `tests/test_ipopremium_real.py` (which use excerpts of real pages) show what broke.

## Rules implemented (SEBI ICDR 2018, Schedule XIV: QIB category)

- Net QIB portion = QIB portion minus anchor portion. The anchor portion is allocated separately before the issue opens.
- 5% of net QIB is reserved for MFs and allotted proportionately among MF bids. Any part MFs don't take up is added to the general pool.
- The general pool (95% plus any unused MF reserve) is allotted proportionately to all QIBs, including MFs' unmet demand.
- Undersubscribed (demand ≤ supply): full allotment.
- QIB applications must be above ₹2 lakh, must be priced (no cut-off bids), and cannot be withdrawn or lowered after bidding.
- A bid cannot exceed the net QIB portion.

Rounding (whole shares vs whole lots) differs between registrars and the ICDR text doesn't settle it. Whole shares is the default;
check one past Basis of Allotment and switch to lots if that's what yours shows.

## Develop

```bash
pip install -r requirements.txt && python -m pytest -q   # Python engine + parser
npm test                                                 # JS engine (same test cases)
python -m scraper.update --offline                       # re-apply overrides/applications without scraping
```

*For estimation only. Not investment advice.*
