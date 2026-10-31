import { bidFromAmount, qibAllotment, profitScenarios, QIB_MIN_APPLICATION } from './allotment.js';

const $ = (id) => document.getElementById(id);
const v = (id) => { const x = parseFloat($(id).value); return Number.isFinite(x) ? x : null; };
const inr = (n, d = 0) => n == null || !Number.isFinite(n) ? '—'
  : n.toLocaleString('en-IN', { maximumFractionDigits: d, minimumFractionDigits: d });
const sign = (n) => (n > 0 ? 'pos' : n < 0 ? 'neg' : '');
const steps = (id) => $(id).value.split(',').map((s) => parseFloat(s)).filter(Number.isFinite);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, val) { try { localStorage.setItem(k, JSON.stringify(val)); } catch { /* storage unavailable */ } },
};

let IPOS = {};
let bidMode = 'amount'; // 'amount' | 'lots' | 'shares': which input the user last edited

async function loadData() {
  try {
    const r = await fetch('data/ipos.json', { cache: 'no-store' });
    const d = await r.json();
    IPOS = d.ipos || {};
    $('updated').textContent = d.updated ? `Data updated ${new Date(d.updated).toLocaleString('en-IN')}.` : '';
  } catch { $('updated').textContent = 'No scraped data yet. Enter the numbers by hand.'; }
  try {
    const c = await (await fetch('data/calibration.json', { cache: 'no-store' })).json();
    if (c.samples > 0) {
      $('haircut').value = c.haircut.toFixed(3);
      $('calibSrc').textContent = `(median of ${c.samples} past IPOs)`;
    }
  } catch { /* none yet */ }

  const groups = { open: 'Open now', upcoming: 'Upcoming', closed: 'Closed, awaiting listing', listed: 'Listed', unknown: 'Other' };
  for (const [st, label] of Object.entries(groups)) {
    const items = Object.values(IPOS).filter((r) => (r.status || 'unknown') === st && !r.is_sme);
    if (!items.length) continue;
    const og = document.createElement('optgroup');
    og.label = label;
    for (const r of items) og.append(new Option(r.name, r.slug));
    $('ipo').append(og);
  }
}

function pickIpo(slug) {
  const r = IPOS[slug];
  if (!r) { $('ipoInfo').innerHTML = ''; $('subSrc').textContent = ''; return calc(); }
  const e = r.effective || {};
  const set = (id, val) => { if (val != null) $(id).value = val; };
  set('price', e.issue_price ?? r.price_band_high);
  set('lot', e.lot_size);
  set('netQib', e.net_qib_shares);
  set('times', e.qib_times);
  $('mfDemand').value = e.mf_demand_shares ?? '';
  $('gmp').value = r.gmp ?? '';
  $('listing').value = e.listing_price ?? '';
  $('subSrc').textContent = r.override_qib_times ? '(manual)' : r.final_subscription ? '(final)' : e.qib_times ? '(live)' : '';
  const sub = r.final_subscription || r.subscription || {};
  const cats = ['qib', 'nii', 'bnii', 'snii', 'retail', 'total'].filter((k) => sub[k]?.times != null)
    .map((k) => `${k.toUpperCase()} ${sub[k].times}×`).join(' · ');
  const split = r.final_qib_split_cr || r.qib_split_cr;
  const splitTxt = split ? `QIB demand ₹cr: FII ${split.fii ?? '–'} · DII ${split.dii ?? '–'} · MF ${split.mf ?? '–'} · Others ${split.others ?? '–'}` : '';
  $('ipoInfo').innerHTML = `<span class="badge ${esc(r.status)}">${esc(r.status)}</span>
    ${r.price_band_low ? `₹${r.price_band_low}–${r.price_band_high}` : ''} · Lot ${esc(e.lot_size ?? '?')}
    · ${esc(r.open_date ?? '')} → ${esc(r.close_date ?? '')}${r.listing_date ? ` · Lists ${esc(r.listing_date)}` : ''}
    ${cats ? `<br>${esc(cats)}` : ''}${splitTxt ? `<br>${esc(splitTxt)}` : ''}${r.anchor_shares ? `<br>Anchor ${inr(r.anchor_shares)} sh (excluded) · Net QIB ${inr(e.net_qib_shares)} sh` : ''}${r.listing_gain_pct != null ? `<br>Listed ${Object.entries(r.listing_prices || {}).map(([x, p]) => `${x.toUpperCase()} ₹${inr(p, 2)}`).join(' · ') || `₹${inr(e.listing_price, 2)}`} · gain ${r.listing_gain_pct}%` : ''}
    ${!e.net_qib_shares ? '<br><b>Net QIB shares missing.</b> Take them from the RHP or the exchange subscription page.' : ''}`;
  calc();
}

function syncBid() {
  const price = v('price'), lot = v('lot') || 1;
  if (bidMode === 'amount') {
    const b = bidFromAmount({ amount: v('amount'), price, lotSize: lot });
    $('lots').value = b.lots || ''; $('shares').value = b.shares || '';
  } else if (bidMode === 'lots') {
    $('shares').value = (v('lots') || 0) * lot || '';
  } else {
    const lots = Math.floor((v('shares') || 0) / lot);
    $('lots').value = lots || '';
  }
}

function calc() {
  syncBid();
  const price = v('price'), lot = v('lot') || 1;
  const lots = v('lots') || 0, shares = lots * lot;
  const blocked = shares * (price || 0);
  const amount = v('amount');
  const warnings = [];
  if (bidMode === 'shares' && v('shares') % lot) warnings.push(`Shares rounded down to whole lots (${lots} × ${lot}).`);
  if (shares && blocked <= QIB_MIN_APPLICATION) warnings.push('QIB applications must be above ₹2,00,000.');
  $('bidHint').textContent = shares
    ? `${inr(lots)} lots × ${inr(lot)} = ${inr(shares)} shares at ₹${inr(price, 2)} = ₹${inr(blocked)}`
      + (amount && bidMode === 'amount' ? ` (₹${inr(amount - blocked)} unused)` : '')
    : '';

  const res = qibAllotment({
    bidShares: shares, netQibShares: v('netQib'), subscriptionTimes: v('times'), lotSize: lot,
    mfReservePct: v('mfPct') ?? 5, mfDemandShares: v('mfDemand'), isMutualFund: $('isMf').checked,
    rounding: $('rounding').value, haircut: v('haircut') ?? 1,
  });
  warnings.push(...res.warnings.filter((w) => w !== 'Missing inputs'));

  $('kAllot').textContent = shares && res.allottedShares != null ? inr(res.allottedShares) : '—';
  $('kLots').textContent = shares ? `${inr(res.allottedLots, 2)} lots · value ₹${inr(res.allottedShares * (price || 0))}` : '';
  $('kRatio').textContent = res.ratio ? `${inr(res.ratio * 100, 3)}%` : '—';
  $('kRatioSub').textContent = res.ratio ? `≈ 1 in ${inr(1 / res.ratio, 1)} shares` : '';
  $('kBlocked').textContent = blocked ? `₹${inr(blocked)}` : '—';
  $('kRefund').textContent = blocked ? `refund ₹${inr(blocked - res.allottedShares * (price || 0))}` : '';

  if (res.breakdown && shares) {
    const b = res.breakdown;
    $('why').innerHTML = `Simple proportion (bid ÷ ${inr(v('times'), 2)}×) gives <b>${inr(res.naiveShares)}</b> shares.
      Under SEBI's method, ${inr(b.mfReserve)} shares (${v('mfPct') ?? 5}%) are reserved for MFs first, so
      <b>${inr(b.poolSupply)}</b> shares are shared out across <b>${inr(b.poolDemand)}</b> shares of remaining demand,
      a ratio of ${inr(res.generalRatio * 100, 4)}%, rounded down. Difference: <b>${inr(res.shortfallVsNaive)}</b> shares.`;
  } else $('why').textContent = '';
  $('warnings').innerHTML = warnings.map((w) => `<li>${esc(w)}</li>`).join('');

  const gmp = v('gmp');
  const rows = profitScenarios({
    allottedShares: res.allottedShares || 0, issuePrice: price || 0, rupeeSteps: steps('rsSteps'),
    pctSteps: steps('pctSteps'), gmp, actualListingPrice: v('listing'), sellChargesPct: v('charges') || 0,
    amountBlocked: blocked,
  });
  $('pnl').querySelector('tbody').innerHTML = rows.map((r) => `<tr class="${r.kind === 'gmp' || r.kind === 'actual' ? 'hl' : ''}">
    <td>${esc(r.label)}</td><td>${inr(r.listingPrice, 2)}</td><td class="${sign(r.perShare)}">${inr(r.perShare, 2)}</td>
    <td class="${sign(r.net)}">${inr(r.net)}</td><td class="${sign(r.net)}">${inr(r.returnOnAllotted, 2)}%</td>
    <td class="${sign(r.net)}">${inr(r.returnOnBlocked, 3)}%</td></tr>`).join('');

  const t = v('times');
  const sens = t ? [0.5, 0.75, 1, 1.25, 1.5, 2].map((f) => {
    const x = qibAllotment({ bidShares: shares, netQibShares: v('netQib'), subscriptionTimes: t * f, lotSize: lot,
      mfReservePct: v('mfPct') ?? 5, isMutualFund: $('isMf').checked, mfDemandShares: v('mfDemand'),
      rounding: $('rounding').value, haircut: v('haircut') ?? 1 });
    return `<tr class="${f === 1 ? 'hl' : ''}"><td>${inr(t * f, 2)}×</td><td>${inr(x.allottedShares)}</td>
      <td class="${sign(gmp)}">${gmp != null ? inr(x.allottedShares * gmp) : '—'}</td></tr>`;
  }).join('') : '';
  $('sens').querySelector('tbody').innerHTML = sens;
  return { res, shares, lots, price, lot };
}

// ---------------------------------------------------------------- applications
function renderHistory() {
  const apps = store.get('qib-apps', []);
  $('history').querySelector('tbody').innerHTML = apps.map((a, i) => `<tr>
    <td>${esc(a.ipo_name || a.ipo_slug)}</td><td>${inr(a.bid_shares)}</td><td>${inr(a.predicted_allotted_shares)}</td>
    <td><input data-i="${i}" class="actual" type="number" placeholder="enter" value="${a.actual_allotted_shares ?? ''}"></td>
    <td><button class="ghost" data-del="${i}" aria-label="Delete">✕</button></td></tr>`).join('');
}

$('save').onclick = () => {
  const { res, shares, price, lot } = calc();
  if (!shares) return;
  const slug = $('ipo').value || prompt('IPO name / slug for this application?');
  if (!slug) return;
  const apps = store.get('qib-apps', []);
  apps.push({
    ipo_slug: slug, ipo_name: IPOS[slug]?.name || slug, saved_at: new Date().toISOString(),
    bid_price: price, lot_size: lot, bid_shares: shares, amount: v('amount'),
    is_mutual_fund: $('isMf').checked, rounding: $('rounding').value,
    predicted_allotted_shares: res.allottedShares, used_qib_times: v('times'), used_net_qib_shares: v('netQib'),
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
  try { const d = JSON.parse(await f.text()); if (Array.isArray(d)) { store.set('qib-apps', d); renderHistory(); } }
  catch { alert('Not a valid applications.json'); }
};

// ---------------------------------------------------------------- wiring
$('ipo').onchange = (e) => pickIpo(e.target.value);
$('amount').addEventListener('input', () => { bidMode = 'amount'; calc(); });
$('lots').addEventListener('input', () => { bidMode = 'lots'; calc(); });
$('shares').addEventListener('input', () => { bidMode = 'shares'; calc(); });
for (const id of ['price', 'lot', 'netQib', 'times', 'mfPct', 'rounding', 'isMf', 'mfDemand', 'haircut', 'charges', 'gmp', 'listing', 'rsSteps', 'pctSteps']) {
  $(id).addEventListener('input', calc);
}
await loadData();
renderHistory();
calc();
