import { bidFromAmount, qibAllotment, profitScenarios, calibrationFromHistory, QIB_MIN_APPLICATION } from './allotment.js';

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
  $('subSrc').innerHTML = r.override_qib_times ? '<span class="pill p-warn">Manual ×</span>'
    : r.final_subscription ? '<span class="pill p-closed">Final ×</span>' : e.qib_times ? '<span class="pill p-open">Live ×</span>' : '';
  calc();
}

// ------------------------------------------------------------------ calculation
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
  $('pnlNote').textContent = has ? `on ${inr(res.allottedShares)} shares` : '';
  $('pnl').querySelector('tbody').innerHTML = rows.map((r) => `<tr class="${r.kind === 'actual' ? 'hl-actual' : r.kind === 'gmp' ? 'hl' : ''}">
    <td>${esc(r.label)}</td><td>${inr(r.listingPrice, 2)}</td><td class="${sign(r.perShare)}">${inr(r.perShare, 2)}</td>
    <td class="${sign(r.net)}">${inr(r.net)}</td><td class="${sign(r.net)}">${inr(r.returnOnAllotted, 2)}%</td>
    <td class="${sign(r.net)}">${inr(r.returnOnBlocked, 3)}%</td></tr>`).join('');

  const t = res.exact && res.breakdown ? res.breakdown.D / res.breakdown.N : v('times');
  $('sens').querySelector('tbody').innerHTML = t && shares ? [0.5, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 2].map((f) => {
    const x = qibAllotment({ ...params(shares, lot, t * f), validDemandShares: null, haircut: res.exact ? 1 : (v('haircut') ?? 1) });
    return `<tr class="${f === 1 ? 'hl' : ''}"><td>${inr(t * f, 2)}×</td><td>${inr(x.allottedShares)}</td><td>${inr(x.ratio * 100, 4)}%</td>
      <td class="${sign(gmp)}">${gmp != null ? inr(x.allottedShares * gmp) : '—'}</td></tr>`;
  }).join('') : '';
  return { res, shares, price, lot };
}

// ------------------------------------------------------------------ book
function renderHistory() {
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
for (const id of ['price', 'lot', 'netQib', 'times', 'mfPct', 'rounding', 'isMf', 'mfDemand', 'haircut', 'charges', 'gmp', 'listing', 'rsSteps', 'pctSteps', 'validDemand']) {
  $(id).addEventListener('input', calc);
}

await loadData();
renderPicker();
renderHistory();
calc();
