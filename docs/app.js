import { bidFromAmount, qibAllotment, profitScenarios, calibrationFromHistory, backSolveDemand, SEGMENT_RULES, QIB_MIN_APPLICATION } from './allotment.js';

const $ = (id) => document.getElementById(id);
const v = (id) => { const x = parseFloat($(id).value); return Number.isFinite(x) ? x : null; };
const inr = (n, d = 0) => n == null || !Number.isFinite(n) ? '—'
  : n.toLocaleString('en-IN', { maximumFractionDigits: d, minimumFractionDigits: d });
const cr = (n) => n == null ? '—' : n >= 1e7 ? `₹${inr(n / 1e7, 2)} cr` : n >= 1e5 ? `₹${inr(n / 1e5, 2)} L` : `₹${inr(n)}`;
const sign = (n) => (n > 0 ? 'pos' : n < 0 ? 'neg' : '');
const steps = (id) => $(id).value.split(',').map((s) => parseFloat(s)).filter(Number.isFinite);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtDate = (s) => {
  if (!s) return '—';
  const d = new Date(`${String(s).slice(0, 10)}T00:00:00`);
  return Number.isNaN(d.getTime()) ? esc(s) : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
};

const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, val) { try { localStorage.setItem(k, JSON.stringify(val)); } catch { /* storage unavailable */ } },
};

let IPOS = {};
let currentSlug = '';
let bidMode = 'amount';
const filt = { st: store.get('qib-filter-st', 'open'), board: store.get('qib-filter-board', 'main') };
let repoCalib = { haircut: 1, samples: 0 };

// ------------------------------------------------------------------ data
async function loadData() {
  try {
    const d = await (await fetch('data/ipos.json', { cache: 'no-store' })).json();
    IPOS = d.ipos || {};
    $('stamp').textContent = d.updated ? `Data updated ${new Date(d.updated).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}` : '';
  } catch { $('stamp').textContent = 'No scraped data yet. Enter the numbers by hand.'; }
  try { repoCalib = await (await fetch('data/calibration.json', { cache: 'no-store' })).json(); } catch { /* none */ }
  applyCalibration();
}

function applyCalibration() {
  const local = calibrationFromHistory(store.get('qib-apps', []));
  const c = local.samples ? local : repoCalib;
  if (c?.samples > 0) {
    $('haircut').value = (+c.haircut).toFixed(4);
    $('calibSrc').textContent = `· median of ${c.samples}`;
  }
}

const boardOk = (r) => filt.board === 'all' || (filt.board === 'sme' ? r.is_sme : !r.is_sme);
const stOk = (r) => filt.st === 'all' || (r.status || 'unknown') === filt.st;

function renderPicker() {
  const all = Object.values(IPOS);
  for (const st of ['open', 'upcoming', 'closed', 'listed']) {
    const n = all.filter((r) => r.status === st && boardOk(r)).length;
    $(`c-${st}`).textContent = n ? ` ${n}` : '';
  }
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.st === filt.st));
  document.querySelectorAll('.seg button').forEach((b) => b.classList.toggle('active', b.dataset.board === filt.board));
  const items = all.filter((r) => boardOk(r) && stOk(r));
  const sel = $('ipo');
  sel.innerHTML = '<option value="">— Manual entry —</option>'
    + items.map((r) => `<option value="${esc(r.slug)}">${esc(r.name)}${filt.st === 'all' ? ` · ${esc(r.status)}` : ''}</option>`).join('');
  if (currentSlug && items.some((r) => r.slug === currentSlug)) sel.value = currentSlug;
  else if (!currentSlug && items.length) { sel.value = items[0].slug; pickIpo(items[0].slug); }
}

// ------------------------------------------------------------------ IPO card
function subBars(sub) {
  const rows = [['QIB', 'qib'], ['bNII', 'bnii'], ['sNII', 'snii'], ['NII', 'nii'], ['Retail', 'retail'], ['Employee', 'employee']]
    .filter(([, k]) => sub[k]?.times != null);
  if (!rows.length) return '';
  const max = Math.max(...rows.map(([, k]) => sub[k].times), 1);
  const bar = (t) => `<div class="bar"><i class="${t < 1 ? 'under' : ''}" style="width:${Math.max(2, Math.min(100, (Math.log10(t + 1) / Math.log10(max + 1)) * 100))}%"></i></div>`;
  return `<div class="subs"><h4>Subscription <span class="tot">${sub.total?.times != null ? `${sub.total.times}× total` : ''}</span></h4>
    ${rows.map(([l, k]) => `<div class="srow ${k === 'qib' ? 'hl' : ''}"><span class="lbl">${l}</span>${bar(sub[k].times)}<span class="val">${sub[k].times}×</span></div>`).join('')}</div>`;
}

function qibSplit(split) {
  if (!split) return '';
  const rows = [['FII', 'fii'], ['DII', 'dii'], ['Mutual funds', 'mf'], ['Others', 'others']].filter(([, k]) => split[k] != null);
  const max = Math.max(...rows.map(([, k]) => split[k]), 1);
  return `<div class="split"><h4>QIB demand by investor type <span class="tot">₹ cr</span></h4>
    ${rows.map(([l, k]) => `<div class="srow ${k === 'mf' ? 'hl' : ''}"><span class="lbl">${l}</span><div class="bar"><i class="violet" style="width:${Math.max(2, (split[k] / max) * 100)}%"></i></div><span class="val">${inr(split[k], 2)}</span></div>`).join('')}</div>`;
}

function renderCard(r) {
  const card = $('ipoCard');
  if (!r) { card.hidden = true; return; }
  const e = r.effective || {};
  const sub = r.final_subscription || r.subscription || {};
  const lp = r.listing_prices || {};
  const listTxt = Object.keys(lp).length ? Object.entries(lp).map(([x, p]) => `${x.toUpperCase()} ₹${inr(p, 2)}`).join(' · ') : (e.listing_price ? `₹${inr(e.listing_price, 2)}` : '—');
  const gmpPct = r.gmp != null && e.issue_price ? (r.gmp / e.issue_price) * 100 : null;
  card.hidden = false;
  card.innerHTML = `
    <div class="card-top">
      <div><h2>${esc(r.name)}</h2>
        <div class="sub">${esc(r.exchange || r.exchange_tag || '')}${r.sources?.[0] ? ` · <a href="${esc(r.sources[0])}" target="_blank" rel="noopener">IPO Premium ↗</a>` : ''}</div></div>
      <div class="badges"><span class="pill ${r.is_sme ? 'p-sme' : 'p-main'}">${r.is_sme ? 'SME' : 'Mainboard'}</span>
        <span class="pill p-${esc(r.status)}">${esc(r.status)}</span>
        ${r.final_locked ? '<span class="pill p-listed">Final · locked</span>' : r.final_subscription ? '<span class="pill p-closed">Final subscription</span>' : ''}</div>
    </div>
    <div class="facts">
      <div class="fact"><div class="k">Price band</div><div class="v">${r.price_band_low ? `₹${inr(r.price_band_low)}–${inr(r.price_band_high)}` : '—'}</div></div>
      <div class="fact"><div class="k">Issue price</div><div class="v">${e.issue_price ? `₹${inr(e.issue_price, 2)}` : '—'}</div></div>
      <div class="fact"><div class="k">Lot size</div><div class="v">${inr(e.lot_size)} <small>shares</small></div></div>
      <div class="fact"><div class="k">GMP</div><div class="v ${sign(r.gmp)}">${r.gmp != null ? `₹${inr(r.gmp, 2)}` : '—'} ${gmpPct != null ? `<small>${inr(gmpPct, 1)}%</small>` : ''}</div></div>
      <div class="fact"><div class="k">QIB subscription</div><div class="v">${e.qib_times != null ? `${e.qib_times}×` : '—'}</div></div>
      <div class="fact"><div class="k">Net QIB (ex-anchor)</div><div class="v">${inr(e.net_qib_shares)}</div></div>
      <div class="fact"><div class="k">Anchor (excluded)</div><div class="v">${inr(r.anchor_shares)}</div></div>
      <div class="fact"><div class="k">MF demand</div><div class="v">${inr(e.mf_demand_shares)} <small>sh</small></div></div>
      <div class="fact"><div class="k">Listing</div><div class="v ${sign(r.listing_gain_pct)}">${listTxt}${r.listing_gain_pct != null ? ` <small>${r.listing_gain_pct > 0 ? '+' : ''}${r.listing_gain_pct}%</small>` : ''}</div></div>
    </div>
    <div class="dates">
      <span>Open<b>${fmtDate(r.open_date)}</b></span><span>Close<b>${fmtDate(r.close_date)}</b></span>
      <span>Allotment<b>${fmtDate(r.allotment_date)}</b></span><span>Listing<b>${fmtDate(r.listing_date)}</b></span>
    </div>
    <div class="ipo-cols">${subBars(sub)}${qibSplit(r.final_qib_split_cr || r.qib_split_cr)}</div>
    ${r.issue_price_check ? `<div class="note"><b>Check the issue price:</b> ${esc(r.issue_price_check)}. Set it in data/overrides.json.</div>` : ''}
    ${!e.net_qib_shares ? '<div class="note">Net QIB shares are missing. Take them from the RHP or the exchange subscription page.</div>' : ''}`;
}

function pickIpo(slug) {
  currentSlug = slug;
  const r = IPOS[slug];
  renderCard(r);
  if (!r) { $('subSrc').textContent = ''; return calc(); }
  const e = r.effective || {};
  const set = (id, val) => { $(id).value = val ?? ''; };
  set('price', e.issue_price ?? r.price_band_high);
  set('lot', e.lot_size);
  set('netQib', e.net_qib_shares);
  set('times', e.qib_times);
  set('mfDemand', e.mf_demand_shares);
  set('gmp', r.gmp);
  set('listing', e.listing_price);
  set('validDemand', e.valid_demand_shares);
  setSegment(r.is_sme ? 'sme' : 'main');
  $('subSrc').innerHTML = r.override_qib_times ? '<span class="pill p-warn">Manual ×</span>'
    : r.final_subscription ? '<span class="pill p-closed">Final ×</span>' : e.qib_times ? '<span class="pill p-open">Live ×</span>' : '';
  calc();
}

// ------------------------------------------------------------------ calculation
function setSegment(seg) {
  $('segment').value = seg;
  $('rounding').value = SEGMENT_RULES[seg].rounding;
}

function syncBid() {
  const price = v('price'), lot = v('lot') || 1;
  if (bidMode === 'amount') {
    const b = bidFromAmount({ amount: v('amount'), price, lotSize: lot });
    $('lots').value = b.lots || ''; $('shares').value = b.shares || '';
  } else if (bidMode === 'lots') {
    $('shares').value = (v('lots') || 0) * lot || '';
  } else {
    $('lots').value = Math.floor((v('shares') || 0) / lot) || '';
  }
}

const params = (shares, lot, times) => ({
  bidShares: shares, netQibShares: v('netQib'), subscriptionTimes: times, lotSize: lot,
  mfReservePct: v('mfPct') ?? 5, mfDemandShares: v('mfDemand'), isMutualFund: $('isMf').checked,
  rounding: $('rounding').value, haircut: v('haircut') ?? 1, validDemandShares: v('validDemand'),
});

function calc() {
  syncBid();
  const price = v('price') || 0, lot = v('lot') || 1;
  const lots = v('lots') || 0, shares = lots * lot;
  const blocked = shares * price;
  const amount = v('amount');
  const warnings = [];
  if (bidMode === 'shares' && v('shares') % lot) warnings.push(`Shares rounded down to whole lots (${inr(lots)} × ${inr(lot)}).`);
  if (shares && blocked <= QIB_MIN_APPLICATION) warnings.push('QIB applications must be above ₹2,00,000.');
  $('bidHint').textContent = shares
    ? `${inr(lots)} lots × ${inr(lot)} = ${inr(shares)} shares at ₹${inr(price, 2)} = ₹${inr(blocked)}`
      + (amount && bidMode === 'amount' ? ` · ₹${inr(amount - blocked)} unused` : '')
    : '';

  const res = qibAllotment(params(shares, lot, v('times')));
  warnings.push(...res.warnings.filter((w) => w !== 'Missing inputs'));
  const hc = v('haircut') ?? 1;
  const mode = res.exact ? ['Exact · Basis of Allotment', 'p-exact'] : Math.abs(hc - 1) > 1e-9 ? [`Calibrated ×${hc.toFixed(4)}`, 'p-cal'] : ['Model · live data', 'p-model'];
  $('modeBadge').textContent = mode[0]; $('modeBadge').className = `pill ${mode[1]}`;

  const has = shares && res.allottedShares != null && res.breakdown;
  $('kAllot').textContent = has ? inr(res.allottedShares) : '—';
  $('kLots').textContent = has ? `${inr(res.allottedLots, 2)} lots · 1 in ${inr(1 / (res.ratio || 1), 1)} shares bid` : '';
  $('kRatio').textContent = has ? `${inr(res.ratio * 100, 4)}%` : '—';
  $('kBlocked').textContent = blocked ? cr(blocked) : '—';
  $('kValue').textContent = has ? cr(res.allottedShares * price) : '—';
  $('kRefund').textContent = has ? cr(blocked - res.allottedShares * price) : '—';

  if (has) {
    const b = res.breakdown;
    $('why').innerHTML = `A simple proportion (bid ÷ ${inr(b.D / b.N, 2)}×) gives <b>${inr(res.naiveShares)}</b> shares.
      Under SEBI's method, <b>${inr(b.mfReserve)}</b> shares (${v('mfPct') ?? 5}%) are reserved for Mutual Funds first. That leaves
      <b>${inr(b.poolSupply)}</b> shares for <b>${inr(b.poolDemand)}</b> shares of remaining ${res.exact ? '<b>final valid</b>' : 'live'} demand,
      a ratio of ${inr(res.generalRatio * 100, 4)}%, rounded down. Difference vs simple proportion: <b class="neg">${inr(res.shortfallVsNaive)}</b> shares.`
      + (res.exact ? '' : ' <br><small>Live demand still includes bids that will be rejected. Use exact mode once the Basis of Allotment is out.</small>');
  } else $('why').textContent = '';
  $('warnings').innerHTML = warnings.map((w) => `<li>${esc(w)}</li>`).join('');

  const gmp = v('gmp');
  const rows = profitScenarios({
    allottedShares: res.allottedShares || 0, issuePrice: price, rupeeSteps: steps('rsSteps'), pctSteps: steps('pctSteps'),
    gmp, actualListingPrice: v('listing'), sellChargesPct: v('charges') || 0, amountBlocked: blocked,
  });
  $('pnlNote').textContent = has ? `on ${inr(res.allottedShares)} shares · each ₹1 of GMP = ₹${inr(res.allottedShares)}` : '';
  $('pnl').querySelector('tbody').innerHTML = rows.map((r) => `<tr class="${r.kind === 'actual' ? 'hl-actual' : r.kind === 'gmp' ? 'hl' : r.kind === 'ref' ? 'ref' : ''}">
    <td>${esc(r.label)}</td><td class="${sign(r.gmpEquivalent)}">${r.gmpEquivalent > 0 ? '+' : ''}${inr(r.gmpEquivalent, 2)}</td><td>${inr(r.listingPrice, 2)}</td>
    <td class="${sign(r.net)}">${inr(r.net)}</td><td class="${sign(r.net)}">${inr(r.returnOnAllotted, 2)}%</td>
    <td class="${sign(r.net)}">${inr(r.returnOnBlocked, 3)}%</td></tr>`).join('');

  const t = res.exact && res.breakdown ? res.breakdown.D / res.breakdown.N : v('times');
  $('sens').querySelector('tbody').innerHTML = t && shares ? [0.5, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 2].map((f) => {
    const x = qibAllotment({ ...params(shares, lot, t * f), validDemandShares: null, haircut: res.exact ? 1 : (v('haircut') ?? 1) });
    return `<tr class="${f === 1 ? 'hl' : ''}"><td>${inr(t * f, 2)}×</td><td>${inr(x.allottedShares)}</td><td>${inr(x.ratio * 100, 4)}%</td>
      <td class="${sign(gmp)}">${gmp != null ? inr(x.allottedShares * gmp) : '—'}</td></tr>`;
  }).join('') : '';
  renderWorking(res, { shares, lots, lot, price, blocked, hc });
  return { res, shares, lots, price, lot, blocked, rows, gmp, hc };
}

// ------------------------------------------------------------------ method & working
const ROUND_TXT = { share: 'round DOWN to whole shares', lot: 'round DOWN to whole lots', nearest: 'round to the NEAREST share', 'nearest-lot': 'round to the NEAREST lot' };

let lastWork = null;

function renderWorking(res, { shares, lots, lot, price, blocked, hc }) {
  const seg = $('segment').value;
  const rules = SEGMENT_RULES[seg];
  const mfPct = v('mfPct') ?? 5;
  const rnd = $('rounding').value;
  $('segBadge').innerHTML = `<span class="pill ${seg === 'sme' ? 'p-sme' : 'p-main'}">${rules.label} rules</span>`;
  $('methodText').innerHTML = `<b>Method.</b> ${esc(rules.regs)}. QIB shares are allotted <b>proportionately</b> within the category.
    Anchor shares are allocated before the issue opens and are <b>excluded</b>: the "QIB ×" figure is on the <b>net</b> QIB portion.
    <b>${mfPct}%</b> of the net QIB portion is reserved for Mutual Funds and allotted among MF bids. Any part they don't take up joins the general pool.
    The rest is allotted proportionately to <b>all</b> QIBs, including MFs for their unmet demand. Then: <b>${ROUND_TXT[rnd]}</b>. ${esc(rules.roundingNote)}`;
  const tb = $('working').querySelector('tbody');
  const b = res.breakdown;
  if (!shares || !b) { lastWork = null; tb.innerHTML = '<tr><td colspan="4" class="small">Enter a bid and the IPO figures to see the working.</td></tr>'; $('checks').innerHTML = ''; return; }
  const mfDemand = v('mfDemand');
  const isMf = $('isMf').checked;
  const r = res.generalRatio;
  const preHc = res.exact ? res.rawShares : res.rawShares / (hc || 1);
  const rows = [
    ['Your bid', 'lots × lot size', `${inr(lots)} × ${inr(lot)}`, `${inr(shares)} sh`],
    ['Amount blocked', 'bid shares × bid price', `${inr(shares)} × ₹${inr(price, 2)}`, cr(blocked)],
    ['Net QIB portion (N)', 'QIB portion − anchor portion', IPOS[currentSlug]?.anchor_shares ? `anchor ${inr(IPOS[currentSlug].anchor_shares)} excluded` : 'ex-anchor, as offered', `${inr(b.N)} sh`],
    [res.exact ? 'Final valid QIB demand (D)' : 'Live QIB demand (D)', res.exact ? 'from the Basis of Allotment' : 'QIB × × N',
      res.exact ? 'registrar figure (exact)' : `${inr(b.D / b.N, 2)} × ${inr(b.N)}`, `${inr(b.D)} sh`],
    ['MF reserve (M)', `floor(${mfPct}% × N)`, `floor(${mfPct}% × ${inr(b.N)})`, `${inr(b.mfReserve)} sh`],
    ['MF take-up from reserve', 'min(MF demand, M)', mfDemand != null ? `min(${inr(mfDemand)}, ${inr(b.mfReserve)})` : 'MF demand not given · assumed ≥ M', `${inr(b.mfFromReserve)} sh`],
    ['General pool supply', 'N − M + unused MF reserve', `${inr(b.N)} − ${inr(b.mfReserve)} + ${inr(b.mfReserve - b.mfFromReserve)}`, `${inr(b.poolSupply)} sh`],
    ['General pool demand', 'D − MF take-up', `${inr(b.D)} − ${inr(b.mfFromReserve)}`, `${inr(b.poolDemand)} sh`],
    ['Allotment ratio (r)', 'min(1, supply ÷ demand)', `${inr(b.poolSupply)} ÷ ${inr(b.poolDemand)}`, `${(r * 100).toFixed(6)}%`],
    isMf
      ? ['Unrounded allotment (MF bidder)', 'bid × M/MF demand + rest × r', 'MF reserve share + general pool share', `${preHc.toFixed(4)} sh`]
      : ['Unrounded allotment', 'bid × r', `${inr(shares)} × ${(r * 100).toFixed(6)}%`, `${preHc.toFixed(4)} sh`],
  ];
  if (!res.exact && Math.abs((hc || 1) - 1) > 1e-9) rows.push(['Calibration', 'unrounded × factor (from your history)', `${preHc.toFixed(4)} × ${(hc).toFixed(4)}`, `${res.rawShares.toFixed(4)} sh`]);
  else rows.push(['Calibration', res.exact ? 'not applied in exact mode' : 'none (factor = 1)', '—', '—']);
  rows.push(['Rounding', ROUND_TXT[rnd], rnd.includes('lot') ? `${rnd.startsWith('nearest') ? 'round' : 'floor'}(${res.rawShares.toFixed(2)} ÷ ${inr(lot)}) × ${inr(lot)}` : `${rnd.startsWith('nearest') ? 'round' : 'floor'}(${res.rawShares.toFixed(4)})`, `${inr(res.allottedShares)} sh`]);
  lastWork = { rows, final: [res.exact ? 'Exact · final valid demand from the Basis of Allotment' : Math.abs((hc || 1) - 1) > 1e-9 ? 'Calibrated estimate · live demand × your factor' : 'Estimate · live demand', `${inr(res.allottedShares)} sh`] };
  tb.innerHTML = rows.map((x, i) => `<tr class="${x[0] === 'Calibration' && x[3] === '—' ? 'muted' : ''}"><td>${i + 1}</td><td>${esc(x[0])}</td><td>${esc(x[1])}<br><span style="color:var(--muted)">${esc(x[2])}</span></td><td>${esc(x[3])}</td></tr>`).join('')
    + `<tr class="final"><td></td><td>Shares allotted</td><td>${res.exact ? 'Exact: final valid demand from the Basis of Allotment' : Math.abs((hc || 1) - 1) > 1e-9 ? 'Calibrated estimate (live demand × your factor)' : 'Estimate from live demand'}</td><td>${inr(res.allottedShares)} sh</td></tr>`;
  const checks = [
    [blocked > QIB_MIN_APPLICATION, `Application above ₹2,00,000 (QIB minimum): ${cr(blocked)}`],
    [shares <= b.N, `Bid within the net QIB portion: ${inr(shares)} ≤ ${inr(b.N)}`],
    [lots === Math.floor(lots), 'Bid in whole lots'],
  ];
  $('checks').innerHTML = checks.map(([ok, t]) => `<li class="${ok ? 'ok' : 'bad'}">${esc(t)}</li>`).join('')
    + `<li class="info">${res.exact ? 'Exact mode: the result follows directly from the registrar\'s final figures.'
      : 'Estimate: live exchange demand includes bids that are later rejected, so the final valid demand is usually a little lower and your allotment a little higher. Use exact mode after the Basis of Allotment, or let the calibration factor learn the gap.'}</li>`;
}

// ------------------------------------------------------------------ printable PDF report
function buildReport() {
  const { res, shares, lots, price, lot, blocked, rows, gmp, hc } = calc();
  const r = IPOS[currentSlug] || null;
  const e = r?.effective || {};
  const name = r?.name || 'Manual entry';
  const seg = $('segment').value;
  const has = shares && res.breakdown;
  const allotted = has ? res.allottedShares : 0;
  const allottedVal = allotted * price;
  const mode = res.exact ? ['Exact · Basis of Allotment', 'exact'] : Math.abs((hc || 1) - 1) > 1e-9 ? [`Calibrated ×${hc.toFixed(4)}`, 'cal'] : ['Estimate · live data', 'model'];
  const gRow = rows.find((x) => x.kind === 'gmp');
  const aRow = rows.find((x) => x.kind === 'actual');
  const head = aRow || gRow;
  const now = new Date();
  const sub = r ? (r.final_subscription || r.subscription || {}) : {};
  const fact = (k, val) => `<div class="f"><div class="k">${k}</div><div class="v">${val}</div></div>`;
  const money = (n) => `${n < 0 ? '−' : ''}₹${inr(Math.abs(n))}`;
  const pctTxt = (n, d = 2) => `${n > 0 ? '+' : ''}${inr(n, d)}%`;
  const step = (n) => rows.find((x) => x.kind === 'rupee' && x.step === n);
  const plus5 = step(5), minus5 = step(-5);

  const profitTile = head ? `<div class="rp-tile ${head.net >= 0 ? 'profit' : 'loss'}">
      <div class="k">${aRow ? 'Profit at actual listing' : 'Profit at current GMP'}</div>
      <div class="v">${money(head.net)}</div>
      <div class="s">${aRow ? `Listed <b>₹${inr(aRow.listingPrice, 2)}</b>` : `GMP <b>₹${inr(gmp, 2)}</b> → listing <b>₹${inr(gRow.listingPrice, 2)}</b>`} · <b>${pctTxt(head.returnOnAllotted)}</b><br>
        Each ₹1 of GMP = <b>₹${inr(allotted)}</b>${plus5 && minus5 && !aRow ? ` · ±₹5 → <b>${money(minus5.net)}</b> to <b>${money(plus5.net)}</b>` : ''}</div></div>`
    : '<div class="rp-tile"><div class="k">Profit at current GMP</div><div class="v">—</div><div class="s">Enter a GMP to see the profit.</div></div>';

  const ladder = rows.filter((x) => x.kind !== 'pct' || true);
  const maxAbs = Math.max(...ladder.map((x) => Math.abs(x.net)), 1);
  const bar = (n) => `<span class="rp-bar ${n < 0 ? 'neg' : ''}"><i style="width:${Math.max(1, (Math.abs(n) / maxAbs) * 100)}%"></i></span>`;
  const work = lastWork?.rows || [];

  $('report').innerHTML = `<div class="rp rp-page">
    <div class="rp-head">
      <img src="logo.png" alt="">
      <div><div class="t1">FinDeependence · QIB Allotment Report</div><div class="t2">${esc(name)}</div>
        <div class="t3">${seg === 'sme' ? 'SME' : 'Mainboard'}${r ? ` · ${esc(r.status)} · ${esc(r.exchange || r.exchange_tag || '')}` : ''}${r?.listing_date ? ` · Listing ${fmtDate(r.listing_date)}` : ''}</div></div>
      <div class="rt">Generated <b>${now.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}</b><br>
        <span class="rp-mode ${mode[1]}">${esc(mode[0])}</span></div>
    </div>

    <div class="rp-hero">
      <div class="rp-tile"><div class="k">You applied</div><div class="v">${cr(blocked)}</div>
        <div class="s"><b>${inr(lots)}</b> lots × ${inr(lot)} = <b>${inr(shares)}</b> shares<br>at ₹${inr(price, 2)} per share</div></div>
      <div class="rp-tile allot"><div class="k">Expected allotment</div><div class="v">${has ? inr(allotted) : '—'}<span class="u">shares</span></div>
        <div class="s"><b>${has ? inr(res.allottedLots, 2) : '—'}</b> lots · ratio <b>${has ? inr(res.ratio * 100, 4) : '—'}%</b><br>≈ 1 share for every ${has && res.ratio ? inr(1 / res.ratio, 1) : '—'} bid</div></div>
      ${profitTile}
      <div class="rp-tile"><div class="k">Funds</div><div class="v">${cr(allottedVal)}</div>
        <div class="s">invested in allotted shares<br>Refund <b>${cr(blocked - allottedVal)}</b></div></div>
    </div>

    ${r ? `<div class="rp-sec"><h3><span>IPO snapshot</span><span>${r.final_locked ? 'Final · locked' : r.final_subscription ? 'Final subscription' : 'Live subscription'}</span></h3>
      <div class="rp-facts">
        ${fact('Price band', r.price_band_low ? `₹${inr(r.price_band_low)}–${inr(r.price_band_high)}` : '—')}
        ${fact('Issue price', e.issue_price ? `₹${inr(e.issue_price, 2)}` : '—')}
        ${fact('Lot size', `${inr(e.lot_size)} sh`)}
        ${fact('GMP', r.gmp != null ? `₹${inr(r.gmp, 2)}${e.issue_price ? ` <small>(${inr((r.gmp / e.issue_price) * 100, 1)}%)</small>` : ''}` : '—')}
        ${fact('QIB × (ex-anchor)', e.qib_times != null ? `${e.qib_times}×` : '—')}
        ${fact('Overall ×', sub.total?.times != null ? `${sub.total.times}×` : '—')}
        ${fact('Net QIB shares', inr(e.net_qib_shares))}
        ${fact('Anchor (excluded)', inr(r.anchor_shares))}
        ${fact('MF demand', `${inr(e.mf_demand_shares)} sh`)}
        ${fact('Open → Close', `${fmtDate(r.open_date).replace(/ \d{4}$/, '')} → ${fmtDate(r.close_date).replace(/ \d{4}$/, '')}`)}
        ${fact('Allotment', fmtDate(r.allotment_date))}
        ${fact('Listing', fmtDate(r.listing_date))}
      </div></div>` : ''}

    <div class="rp-sec rp-cols">
      <div><h3><span>Profit / loss ladder · from current GMP</span><span>${inr(allotted)} shares</span></h3>
        <table class="rp-ladder"><thead><tr><th>Scenario</th><th>GMP ₹</th><th>Listing ₹</th><th>Net P&amp;L ₹</th><th>Return</th><th></th></tr></thead><tbody>
        ${ladder.map((x) => `<tr class="${x.kind === 'actual' ? 'hl-actual' : x.kind === 'gmp' ? 'hl' : x.kind === 'ref' ? 'ref' : ''}"><td>${esc(x.label)}</td>
          <td class="${sign(x.gmpEquivalent)}">${x.gmpEquivalent > 0 ? '+' : ''}${inr(x.gmpEquivalent, 2)}</td><td>${inr(x.listingPrice, 2)}</td>
          <td class="${sign(x.net)}">${inr(x.net)}</td><td class="${sign(x.net)}">${pctTxt(x.returnOnAllotted)}</td><td class="b">${bar(x.net)}</td></tr>`).join('')}
        </tbody></table></div>
      <div><h3><span>If final QIB × changes</span><span>P&amp;L at GMP</span></h3>
        <table><thead><tr><th>QIB ×</th><th>Shares</th><th>Ratio</th><th>P&amp;L ₹</th></tr></thead><tbody>${[...$('sens').querySelector('tbody').rows].slice(1, 7).map((tr) => tr.outerHTML).join('')}</tbody></table>
        <div class="rp-callout ${mode[1]}"><b>${res.exact ? 'Exact result.' : 'Estimate.'}</b> ${res.exact
          ? 'Uses the registrar\'s final valid QIB demand from the Basis of Allotment.'
          : 'Uses live exchange demand, which still includes bids rejected later. The final allotment is usually slightly higher. For an exact figure, enter the Basis of Allotment demand.'}</div>
      </div>
    </div>

    <div class="rp-sec"><h3><span>Calculation working</span><span>${seg === 'sme' ? 'SME' : 'Mainboard'} rules · ${esc(SEGMENT_RULES[seg].regs.replace('SEBI ICDR Regulations, 2018: ', 'ICDR 2018 · '))}</span></h3>
      <table class="rp-work"><thead><tr><th>#</th><th>Step</th><th>Formula</th><th>Calculation</th><th>Value</th></tr></thead><tbody>
        ${work.filter((x) => x[3] !== '—').map((x, i) => `<tr><td>${i + 1}</td><td>${esc(x[0])}</td><td>${esc(x[1])}</td><td>${esc(x[2])}</td><td>${esc(x[3])}</td></tr>`).join('')}
        ${lastWork ? `<tr class="final"><td></td><td>Shares allotted</td><td colspan="2">${esc(lastWork.final[0])}</td><td>${esc(lastWork.final[1])}</td></tr>` : ''}
      </tbody></table>
      <p class="rp-note"><b>Method.</b> QIB shares are allotted proportionately. The anchor portion is excluded (the QIB × is on the net portion). ${v('mfPct') ?? 5}% of the net QIB portion is reserved for Mutual Funds, and anything they don't take up joins the general pool, which is shared proportionately among all QIBs. ${esc(SEGMENT_RULES[seg].roundingNote)}</p>
    </div>

    <div class="rp-foot"><img src="logo.png" alt="">
      <div><b>FinDeependence</b> · Freedom with Finance · Created by <b>CA Deep Dalal</b> · Data: IPO Premium${r?.sources?.[0] ? ` (${esc(r.sources[0].replace(/^https?:\/\//, ''))})` : ''} and manual overrides.
        Estimates are indicative; the registrar's Basis of Allotment is final. GMP is unofficial grey-market data. <b>Education only. Not investment advice.</b></div>
      <div class="pg">${now.toLocaleDateString('en-IN')}</div></div>
  </div>`;
}

function printReport() {
  buildReport();
  const prev = document.title;
  const name = (IPOS[currentSlug]?.name || 'Manual').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '');
  document.title = `FinDeependence_QIB_Report_${name}_${new Date().toISOString().slice(0, 10)}`;
  const restore = () => { document.title = prev; window.removeEventListener('afterprint', restore); };
  window.addEventListener('afterprint', restore);
  // wait for the logo images in the report to load before opening the print dialog
  const imgs = [...$('report').querySelectorAll('img')];
  Promise.all(imgs.map((i) => (i.complete ? 0 : new Promise((ok) => { i.onload = i.onerror = ok; })))).then(() => window.print());
}
$('pdfBtn').onclick = printReport;

// ------------------------------------------------------------------ verify vs past allotments
function renderVerify() {
  const apps = store.get('qib-apps', []).map((a, i) => ({ ...a, i }))
    .filter((a) => a.actual_allotted_shares > 0 && a.used_net_qib_shares > 0 && a.used_qib_times > 0 && a.bid_shares > 0);
  const tb = $('verify').querySelector('tbody');
  if (!apps.length) {
    tb.innerHTML = '<tr><td colspan="8" class="small">No applications with an actual allotment yet. Save an application below, then type the shares you received in its <b>Actual</b> cell.</td></tr>';
    $('verifySummary').innerHTML = ''; $('verifyStat').textContent = ''; return;
  }
  const rows = apps.map((a) => {
    const model = qibAllotment({ bidShares: a.bid_shares, netQibShares: a.used_net_qib_shares, subscriptionTimes: a.used_qib_times,
      lotSize: a.lot_size || 1, mfDemandShares: a.used_mf_demand_shares ?? null, isMutualFund: !!a.is_mutual_fund,
      rounding: a.rounding || 'share', haircut: 1 });
    const bs = backSolveDemand({ bidShares: a.bid_shares, actualShares: a.actual_allotted_shares, netQibShares: a.used_net_qib_shares, liveTimes: a.used_qib_times });
    return { a, model: model.allottedShares, bs, diff: a.actual_allotted_shares - model.allottedShares };
  });
  tb.innerHTML = rows.map(({ a, model, bs, diff }) => `<tr><td>${esc(a.ipo_name || a.ipo_slug)}</td><td>${inr(a.bid_shares)}</td><td>${inr(model)}</td>
    <td>${inr(a.actual_allotted_shares)}</td><td class="${diff === 0 ? 'match' : 'miss'}">${diff === 0 ? 'exact' : `${diff > 0 ? '+' : ''}${inr(diff)} (${((diff / model) * 100).toFixed(2)}%)`}</td>
    <td>${inr(a.used_qib_times, 2)}×</td><td>${bs ? `${inr(bs.impliedTimes, 2)}×` : '—'}</td><td class="${sign(-(bs?.gapPct ?? 0))}">${bs?.gapPct != null ? `${bs.gapPct.toFixed(2)}%` : '—'}</td></tr>`).join('');
  const gaps = rows.map((x) => x.bs?.gapPct).filter(Number.isFinite).sort((p, q) => p - q);
  const med = gaps.length ? gaps[Math.floor(gaps.length / 2)] : null;
  const spread = gaps.length > 1 ? gaps[gaps.length - 1] - gaps[0] : 0;
  const exact = rows.filter((x) => x.diff === 0).length;
  const c = calibrationFromHistory(store.get('qib-apps', []));
  $('verifyStat').textContent = `${rows.length} checked · ${exact} exact on live data`;
  $('verifySummary').innerHTML = `<b>Finding:</b> working backwards from your actual allotments, the registrar's final valid QIB demand was
    <b>${med != null ? `${Math.abs(med).toFixed(2)}% ${med < 0 ? 'below' : 'above'}` : '—'}</b> the live figure (median${gaps.length > 1 ? `, range ${gaps[0].toFixed(2)}% to ${gaps[gaps.length - 1].toFixed(2)}%` : ''}).
    ${gaps.length > 1 && spread < 2 ? 'The gap is small and consistent, so the method is right and the calibration factor corrects for it.' : ''}
    ${gaps.length > 1 && spread >= 2 ? '<b class="neg">The gap varies a lot between IPOs.</b> Check those IPOs\' inputs (net QIB shares, QIB ×, rounding, segment), or use exact mode with the Basis of Allotment figure.' : ''}
    Calibration factor now in use: <b>×${c.samples ? c.haircut.toFixed(4) : '1.0000'}</b>. Exact mode with the Basis of Allotment figure needs no factor.`;
}

// ------------------------------------------------------------------ book
function renderHistory() {
  renderVerify();
  const apps = store.get('qib-apps', []);
  const c = calibrationFromHistory(apps);
  $('bookStat').textContent = apps.length ? `${apps.length} saved · calibration ${c.samples ? `×${c.haircut.toFixed(4)} from ${c.samples}` : 'n/a'}` : '';
  $('history').querySelector('tbody').innerHTML = apps.map((a, i) => {
    const r = a.actual_allotted_shares != null && a.predicted_allotted_shares ? a.actual_allotted_shares / a.predicted_allotted_shares : null;
    return `<tr><td>${esc(a.ipo_name || a.ipo_slug)}</td><td>${inr(a.bid_shares)}</td><td>${inr(a.predicted_allotted_shares)}</td>
      <td><input data-i="${i}" class="actual" type="number" inputmode="numeric" placeholder="enter" value="${a.actual_allotted_shares ?? ''}" aria-label="Actual shares allotted"></td>
      <td>${r ? r.toFixed(4) : '—'}</td><td><button class="x" data-del="${i}" aria-label="Delete">✕</button></td></tr>`;
  }).join('') || '<tr><td colspan="6" class="small">No applications saved yet.</td></tr>';
}

$('save').onclick = () => {
  const { res, shares, price, lot } = calc();
  if (!shares) return;
  const slug = $('ipo').value || prompt('IPO name / slug for this application?');
  if (!slug) return;
  // Store the un-calibrated model prediction so the calibration factor learns from the model, not from itself
  const base = qibAllotment({ ...params(shares, lot, v('times')), haircut: 1, validDemandShares: null });
  const apps = store.get('qib-apps', []);
  apps.push({
    ipo_slug: slug, ipo_name: IPOS[slug]?.name || slug, saved_at: new Date().toISOString(),
    bid_price: price, lot_size: lot, bid_shares: shares, amount: v('amount'),
    is_mutual_fund: $('isMf').checked, rounding: $('rounding').value,
    predicted_allotted_shares: base.allottedShares, shown_allotted_shares: res.allottedShares,
    used_qib_times: v('times'), used_net_qib_shares: v('netQib'), used_mf_demand_shares: v('mfDemand'),
    segment: $('segment').value, used_valid_demand_shares: v('validDemand'),
    actual_allotted_shares: null,
  });
  store.set('qib-apps', apps); renderHistory();
};
$('history').addEventListener('change', (e) => {
  if (!e.target.classList.contains('actual')) return;
  const apps = store.get('qib-apps', []);
  const n = parseFloat(e.target.value);
  apps[e.target.dataset.i].actual_allotted_shares = Number.isFinite(n) ? n : null;
  store.set('qib-apps', apps);
  // re-render after the input's blur/change cycle has finished
  setTimeout(() => { renderHistory(); applyCalibration(); calc(); }, 0);
});
$('history').addEventListener('click', (e) => {
  const i = e.target.dataset.del; if (i == null) return;
  const apps = store.get('qib-apps', []); apps.splice(i, 1); store.set('qib-apps', apps); renderHistory();
});
$('export').onclick = () => {
  const blob = new Blob([JSON.stringify(store.get('qib-apps', []), null, 2)], { type: 'application/json' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'applications.json' });
  a.click(); URL.revokeObjectURL(a.href);
};
$('import').onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try { const d = JSON.parse(await f.text()); if (Array.isArray(d)) { store.set('qib-apps', d); renderHistory(); applyCalibration(); calc(); } }
  catch { alert('Not a valid applications.json'); }
};

// ------------------------------------------------------------------ wiring
document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => {
  filt.st = b.dataset.st; store.set('qib-filter-st', filt.st); currentSlug = ''; renderPicker();
}));
document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => {
  filt.board = b.dataset.board; store.set('qib-filter-board', filt.board); currentSlug = ''; renderPicker();
}));
$('ipo').onchange = (e) => pickIpo(e.target.value);
$('amount').addEventListener('input', () => { bidMode = 'amount'; calc(); });
$('lots').addEventListener('input', () => { bidMode = 'lots'; calc(); });
$('shares').addEventListener('input', () => { bidMode = 'shares'; calc(); });
$('segment').addEventListener('input', () => { setSegment($('segment').value); calc(); });
for (const id of ['price', 'lot', 'netQib', 'times', 'mfPct', 'rounding', 'isMf', 'mfDemand', 'haircut', 'charges', 'gmp', 'listing', 'rsSteps', 'pctSteps', 'validDemand']) {
  $(id).addEventListener('input', calc);
}

await loadData();
renderPicker();
renderHistory();
calc();
