// QIB allotment engine — SEBI (ICDR) Regulations, 2018, Schedule XIV (basis of allotment, QIB category).
//
// How the QIB category works in a book-built IPO:
//   * Anchor investors take up to 60% of the QIB portion BEFORE the issue opens. The
//     "QIB" subscription figure the exchanges show (and IPO Premium shows) is for the
//     NET QIB portion, i.e. EXCLUDING the anchor portion. Use net QIB shares, never the gross figure.
//   * 5% of the net QIB portion is reserved for Mutual Funds only, and allotted
//     proportionately among MF bids.
//   * The other 95% (plus any MF reserve that MFs didn't take up) is allotted
//     proportionately to ALL QIBs, MFs included, for the demand still unmet.
//   * So a non-MF QIB's ratio is (0.95 × N) / (D − MF reserve take-up). That is lower
//     than the naive N / D, which is one reason allotments come in below a simple
//     proportion. Rounding down adds a little more loss on top.
//
// Every function is pure, so the browser UI and the Node tests use the same code.

export const DEFAULT_MF_RESERVE_PCT = 5;
export const QIB_MIN_APPLICATION = 200000; // QIB / NII bids must exceed ₹2 lakh

/** Lots/shares you can bid for with `amount` at `price`. */
export function bidFromAmount({ amount, price, lotSize }) {
  if (!(amount > 0) || !(price > 0) || !(lotSize > 0)) {
    return { lots: 0, shares: 0, amountUsed: 0, leftover: amount || 0 };
  }
  const lots = Math.floor(amount / (price * lotSize));
  const shares = lots * lotSize;
  const amountUsed = shares * price;
  return { lots, shares, amountUsed, leftover: amount - amountUsed };
}

/**
 * Expected QIB allotment.
 * @param {object} p
 * @param {number} p.bidShares           shares you bid for (multiple of lot size)
 * @param {number} p.netQibShares        N: shares offered to QIBs EXCLUDING anchor
 * @param {number} p.subscriptionTimes   QIB (ex-anchor) subscription multiple, e.g. 152.3
 * @param {number} [p.lotSize]
 * @param {number} [p.mfReservePct=5]
 * @param {number|null} [p.mfDemandShares] total MF demand in shares (usually unknown,
 *        and if so MF demand is assumed to cover the whole 5% reserve, which gives the conservative answer)
 * @param {boolean} [p.isMutualFund=false]
 * @param {'share'|'lot'|'nearest'|'nearest-lot'} [p.rounding='share']
 *        'share' = round DOWN to whole shares (Mainboard default) · 'lot' = round DOWN to whole lots
 *        (SME default) · 'nearest' / 'nearest-lot' = round to the nearest share / lot
 * @param {number} [p.haircut=1]          empirical calibration factor (from your past allotments)
 * @param {number|null} [p.validDemandShares] EXACT MODE: final valid QIB demand in shares from the
 *        registrar's Basis of Allotment. Live exchange figures include bids later rejected during
 *        reconciliation, so this is usually slightly lower than times × N (BLS Polymers: about 0.5% lower).
 */
export function qibAllotment(p) {
  const {
    bidShares, netQibShares: N, subscriptionTimes, lotSize = 1,
    mfReservePct = DEFAULT_MF_RESERVE_PCT, mfDemandShares = null,
    isMutualFund = false, rounding = 'share', haircut = 1, validDemandShares = null,
  } = p;
  const warnings = [];
  const exact = validDemandShares > 0;
  if (!(bidShares > 0) || !(N > 0) || !(subscriptionTimes > 0 || exact)) {
    return { allottedShares: 0, allottedLots: 0, ratio: 0, naiveShares: 0, warnings: ['Missing inputs'] };
  }
  if (bidShares > N) warnings.push('A QIB bid cannot be larger than the net QIB portion.');

  const D = exact ? validDemandShares : subscriptionTimes * N;   // total valid QIB demand (shares)
  const M = Math.floor((N * mfReservePct) / 100);        // MF-only reserve
  const G = N - M;                                       // general QIB pool
  const Dmf = mfDemandShares == null ? Infinity : Math.max(0, mfDemandShares);

  const mfFromReserve = Math.min(Dmf, M);
  const poolSupply = G + (M - mfFromReserve);            // unused MF reserve rolls into the pool
  const poolDemand = Math.max(D - mfFromReserve, 0);
  const generalRatio = poolDemand > 0 ? Math.min(1, poolSupply / poolDemand) : 1;

  let raw;
  if (isMutualFund) {
    if (!Number.isFinite(Dmf) || Dmf <= 0) {
      warnings.push('For an MF bid, enter total MF demand. Without it the result ignores the 5% reserve.');
      raw = bidShares * generalRatio;
    } else {
      const reserveRatio = Math.min(1, M / Dmf);
      const fromReserve = bidShares * reserveRatio;
      raw = fromReserve + (bidShares - fromReserve) * generalRatio;
    }
  } else {
    raw = bidShares * generalRatio;
  }
  if (!exact) raw *= haircut;                            // calibration only when demand is estimated

  const unit = rounding === 'lot' || rounding === 'nearest-lot' ? lotSize : 1;
  const roundFn = rounding.startsWith('nearest') ? Math.round : (x) => Math.floor(x + 1e-9);
  const allottedShares = Math.min(bidShares, roundFn(raw / unit) * unit);
  const naiveShares = Math.floor(bidShares / Math.max(exact ? D / N : subscriptionTimes, 1));

  return {
    allottedShares,
    allottedLots: lotSize > 0 ? allottedShares / lotSize : 0,
    ratio: bidShares > 0 ? allottedShares / bidShares : 0,
    generalRatio,
    rawShares: raw,
    naiveShares,
    shortfallVsNaive: naiveShares - allottedShares,
    exact,
    breakdown: { N, D, mfReserve: M, generalPool: G, mfFromReserve: Number.isFinite(mfFromReserve) ? mfFromReserve : M, poolSupply, poolDemand },
    warnings,
  };
}

export const DEFAULT_RUPEE_STEPS = [-20, -10, -5, -2, 0, 2, 5, 10, 20];
export const DEFAULT_PCT_STEPS = [];

/**
 * Profit/loss ladder. Steps are measured from the CURRENT GMP: with GMP ₹67 on a ₹150 issue the base
 * listing price is ₹217, and "+₹5" means GMP ₹72 → listing ₹222. With no GMP, the base is the issue price.
 * Rows come back highest listing price first, followed by a reference row at the issue price (GMP ₹0).
 */
export function profitScenarios({
  allottedShares, issuePrice, rupeeSteps = DEFAULT_RUPEE_STEPS, pctSteps = DEFAULT_PCT_STEPS,
  gmp = null, actualListingPrice = null, sellChargesPct = 0, amountBlocked = 0,
}) {
  const hasGmp = gmp != null && Number.isFinite(gmp);
  const base = issuePrice + (hasGmp ? gmp : 0);
  const make = (label, listing, kind, step = null) => {
    if (!(listing > 0)) return null;
    const gross = allottedShares * (listing - issuePrice);
    const charges = (allottedShares * listing * sellChargesPct) / 100;
    const net = gross - charges;
    return {
      label, kind, step, listingPrice: listing, perShare: listing - issuePrice, gmpEquivalent: listing - issuePrice,
      gross, charges, net,
      returnOnAllotted: allottedShares > 0 ? (net / (allottedShares * issuePrice)) * 100 : 0,
      returnOnBlocked: amountBlocked > 0 ? (net / amountBlocked) * 100 : 0,
    };
  };
  const fmt = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(2));
  const ladder = [];
  const steps = [...new Set([0, ...rupeeSteps])];
  for (const st of steps) {
    if (st === 0) ladder.push(make(hasGmp ? `Current GMP (₹${fmt(gmp)})` : 'At issue price', base, hasGmp ? 'gmp' : 'issue', 0));
    else ladder.push(make(`${hasGmp ? 'GMP' : 'Issue'} ${st > 0 ? '+' : '−'}₹${fmt(Math.abs(st))}`, base + st, 'rupee', st));
  }
  for (const pc of pctSteps) {
    ladder.push(make(`${hasGmp ? 'GMP listing' : 'Issue'} ${pc > 0 ? '+' : '−'}${Math.abs(pc)}%`, base * (1 + pc / 100), 'pct', pc));
  }
  const rows = ladder.filter(Boolean).sort((a, b) => b.listingPrice - a.listingPrice);
  if (hasGmp && gmp !== 0 && !rows.some((r) => Math.abs(r.listingPrice - issuePrice) < 1e-9)) {
    const ref = make('At issue price (GMP ₹0)', issuePrice, 'ref');
    if (ref) rows.push(ref);
  }
  if (actualListingPrice) rows.unshift(make('Actual listing', actualListingPrice, 'actual'));
  return rows.filter(Boolean);
}

/** Median of realised / predicted ratios from your past applications (the calibration haircut). */
export function calibrationFromHistory(apps) {
  const r = apps
    .filter((a) => a.actual_allotted_shares != null && a.predicted_allotted_shares > 0)
    .map((a) => a.actual_allotted_shares / a.predicted_allotted_shares)
    .sort((a, b) => a - b);
  if (!r.length) return { haircut: 1, samples: 0 };
  const mid = Math.floor(r.length / 2);
  return { haircut: r.length % 2 ? r[mid] : (r[mid - 1] + r[mid]) / 2, samples: r.length };
}

/**
 * Work backwards from an ACTUAL allotment to the final valid QIB demand the registrar must have used.
 * Assumes the method above (MF demand covers the 5% reserve; non-MF bidder; round down to whole shares).
 * Returns the range of total valid QIB demand D consistent with `actualShares`, and its gap vs live demand.
 */
export function backSolveDemand({ bidShares, actualShares, netQibShares: N, mfReservePct = DEFAULT_MF_RESERVE_PCT,
  liveTimes = null }) {
  if (!(bidShares > 0) || !(actualShares > 0) || !(N > 0)) return null;
  const M = Math.floor((N * mfReservePct) / 100);
  const G = N - M;
  // floor(B·G/(D−M)) = A  ⇔  A ≤ B·G/(D−M) < A+1  ⇔  B·G/(A+1) < D−M ≤ B·G/A
  const dHi = (bidShares * G) / actualShares + M;
  const dLo = (bidShares * G) / (actualShares + 1) + M;
  const mid = (dLo + dHi) / 2;
  const liveD = liveTimes ? liveTimes * N : null;
  return {
    demandLow: dLo, demandHigh: dHi, demand: mid, impliedTimes: mid / N,
    liveDemand: liveD, gapPct: liveD ? ((mid - liveD) / liveD) * 100 : null,
    ratio: actualShares / bidShares,
  };
}

/** Allotment rules by segment (stated on the page, applied by default). */
export const SEGMENT_RULES = {
  main: {
    label: 'Mainboard',
    regs: 'SEBI ICDR Regulations, 2018: Reg. 32 (allocation in the net offer) and Schedule XIV (basis of allotment)',
    rounding: 'share',
    roundingNote: 'QIB allotments are in whole shares, not lots (e.g. BLS Polymers: 11,934 shares on a 100-share lot).',
  },
  sme: {
    label: 'SME',
    regs: 'SEBI ICDR Regulations, 2018: Chapter IX, Reg. 253 (allocation in the net offer) and Schedule XIV (basis of allotment)',
    rounding: 'lot',
    roundingNote: 'SME shares trade and are allotted in market lots, so the allotment is rounded down to whole lots. Check this against one of your SME allotments.',
  },
};
