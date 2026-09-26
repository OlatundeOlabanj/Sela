// netlify/functions/get-tip.js
//
// Dynamic Jito tip calculator, ported from smart-tx-stack's
// src/execution/tips.ts (github.com/OlatundeOlabanj/smart-tx-stack).
// Real logic: fetches live tip floor data + a live tip account from
// Jito's public mainnet APIs.
//
// Made by TJS Code

const JITO_TIP_FLOOR_URL = 'https://bundles.jito.wtf/api/v1/bundles/tip_floor';
const JITO_BUNDLES_URL = 'https://mainnet.block-engine.jito.wtf/api/v1/bundles';
const CACHE_TTL_MS = 30_000;

const FALLBACK_TIPS = { LOW: 1000, MEDIUM: 5000, HIGH: 10000, CRITICAL: 50000 };
// Jito's well-known mainnet tip accounts, used only if the live
// getTipAccounts call fails.
const FALLBACK_TIP_ACCOUNTS = [
  '9n3d1K5YD2vECAbRFhFFGYNNjiXtHXJWn9F31t89vsAV',
  'B1mrQSpdeMU9gCvkJ6VsXVVoYjRGkNA7TtjMyqxrhecH',
];

let tipCache = null;
let tipAccountsCache = null;

async function fetchTipFloor() {
  const now = Date.now();
  if (tipCache && now - tipCache.fetched_at < CACHE_TTL_MS) return tipCache;

  const res = await fetch(JITO_TIP_FLOOR_URL, {
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Jito tip floor API returned ${res.status}`);

  const raw = await res.json();
  const entry = Array.isArray(raw) ? raw[0] : raw;
  if (!entry) throw new Error('Unexpected Jito tip floor response shape');

  const toLamports = (v) => (v < 1 ? Math.round(v * 1_000_000_000) : Math.round(v));

  tipCache = {
    p25: toLamports(entry.landed_tips_25th_percentile ?? entry.landed_tips?.p25 ?? 0.000001),
    p50: toLamports(entry.landed_tips_50th_percentile ?? entry.landed_tips?.p50 ?? 0.000005),
    p75: toLamports(entry.landed_tips_75th_percentile ?? entry.landed_tips?.p75 ?? 0.00001),
    p95: toLamports(entry.landed_tips_95th_percentile ?? entry.landed_tips?.p95 ?? 0.00005),
    fetched_at: now,
  };
  return tipCache;
}

async function fetchTipAccount() {
  const now = Date.now();
  if (tipAccountsCache && now - tipAccountsCache.fetched_at < CACHE_TTL_MS) {
    const list = tipAccountsCache.accounts;
    return list[Math.floor(Math.random() * list.length)];
  }
  try {
    const res = await fetch(JITO_BUNDLES_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTipAccounts', params: [] }),
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json();
    const accounts = data.result;
    if (!Array.isArray(accounts) || accounts.length === 0) throw new Error('Empty tip account list');
    tipAccountsCache = { accounts, fetched_at: now };
    return accounts[Math.floor(Math.random() * accounts.length)];
  } catch {
    return FALLBACK_TIP_ACCOUNTS[Math.floor(Math.random() * FALLBACK_TIP_ACCOUNTS.length)];
  }
}

exports.handler = async (event) => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  const origin = event.headers?.origin || event.headers?.referer || '';
  if (origin && !origin.includes('veilpay.store') && !origin.includes('veilpay-tjscode.netlify.app') && !origin.includes('localhost')) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'Forbidden origin.' }) };
  }
  const urgency = (event.queryStringParameters?.urgency || 'MEDIUM').toUpperCase();

  const tipAccount = await fetchTipAccount();

  try {
    const floor = await fetchTipFloor();
    const map = { LOW: floor.p25, MEDIUM: floor.p50, HIGH: floor.p75, CRITICAL: floor.p95 };
    const tipLamports = Math.max(map[urgency] ?? floor.p50, 1000);
    return { statusCode: 200, headers, body: JSON.stringify({ tipLamports, tipAccount, urgency, source: 'jito-live' }) };
  } catch (err) {
    const tipLamports = FALLBACK_TIPS[urgency] ?? FALLBACK_TIPS.MEDIUM;
    return { statusCode: 200, headers, body: JSON.stringify({ tipLamports, tipAccount, urgency, source: 'fallback', error: err.message }) };
  }
};
