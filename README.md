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

Example: N = 42,85,714, 152.31× subscribed, bid 47,570 shares. A simple proportion gives 312 shares; SEBI's method gives **296**.

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
- The parser recognises tables by header and row labels rather than fixed CSS selectors. It was built without access to the live site and has
  only been tested on the synthetic fixtures in `tests/fixtures/`. **Check the first scheduled run.** If a field comes back empty, adjust
  `scraper/ipopremium.py` (`DETAIL_LINK_RE`, `SUB_ROWS`, `_kv` patterns) or use overrides.

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
