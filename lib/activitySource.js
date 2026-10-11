// lib/activitySource.js
//
// Adapter boundary for the activity feed / notifications data source.
// getActivityFeed() returns { source, filters, events }, never a bare
// provider-specific shape, so the frontend can label honestly which
// data it is showing and the provider can change without touching the
// Netlify function or the widget.
//
// Normalized event shape:
//   { id, type, label, detail, amountUsd, timestampMs }
//   type is one of: 'swap' | 'launch' | 'meme' | 'graduation' |
//   'liquidity' | 'transfer' | 'deposit' | 'withdrawal' | 'other'
//
// Made by TJS Code

const WebSocket = require('ws');
const { scrubSecrets } = require('./secretScrub');

// Demo/fallback source. Always synthetic, labelled as such by the
// caller (source: 'mock'), never presented as live data.
function mockActivitySource() {
  const now = Date.now();
  return Promise.resolve([
    { id: 'mock-1', type: 'swap', label: 'SOL to USDC swap', detail: 'Mock event, not live data', amountUsd: 42.5, timestampMs: now - 60000 },
    { id: 'mock-2', type: 'deposit', label: 'Deposit received', detail: 'Mock event, not live data', amountUsd: 100, timestampMs: now - 300000 },
    { id: 'mock-3', type: 'transfer', label: 'Transfer sent', detail: 'Mock event, not live data', amountUsd: 15.75, timestampMs: now - 900000 },
  ]);
}

// --- Solami Blur (real data source) -----------------------------------
//
// Everything below comes from Solami's own Blur data API page (read
// Oct 12), not from guesses:
//   wss://ws.solami.dev/data/subscribe?chain=solana&api_key=KEY
//   the key is a query parameter and must carry the DataApi permission
//     (without it the handshake is refused: 403 "missing required
//     permission: DataApi", confirmed on Oct 11)
//   every message is one event with a type field; fractional values
//     (prices, USD amounts, percentages) are JSON strings and must be
//     parsed, integers (slots, block_time in unix seconds) are numbers
//   filters are connect-time query params: type, dex, address, pool,
//     trader, side, min_volume_usd, min_progress, ... plus
//     backfill=0..200, which replays the last N events per type right
//     on connect (tagged backfill: true), and metadata=false to drop the
//     separate metadata events
//   billing is per delivered byte. A stream is only ADMITTED if the
//     account holds at least 64 KiB of prepaid bandwidth or 0.06 USD,
//     that is a threshold, not a charge per connection. Running out
//     mid-stream closes the socket with code 4002.
//
// A Netlify function cannot hold a socket open, so each refresh
// connects, uses backfill so the first frames already carry data, listens
// briefly, and closes. Results are cached for SOLAMI_CACHE_MS (default
// 20s) and concurrent callers share one connection, which keeps the
// number of simultaneous streams at one however many people have the
// page open.
//
// Event text can contain anything a token creator typed on chain, so
// every string is stripped of control characters and angle brackets and
// length-capped here, and the widget escapes it again before display.

const COLLECT_WINDOW_MS = Number(process.env.SOLAMI_POLL_WINDOW_MS) || 3000;
const CACHE_MS = Number(process.env.SOLAMI_CACHE_MS) || 20000;
const BLUR_BASE = process.env.BLUR_BASE || 'wss://ws.solami.dev';
const MAX_RAW = 400;
const MAX_EVENTS = 30;

function buildBlurUrl() {
  const apiKey = process.env.SOLAMI_API_KEY;
  if (!apiKey) {
    throw new Error('SOLAMI_API_KEY not set (it must be a key with the DataApi permission)');
  }
  const params = new URLSearchParams({ chain: 'solana', api_key: apiKey });

  // Launch lifecycle by default: new tokens, bonding curve progress and
  // graduations. Comma separated, any of swap, liquidity, token_create,
  // pool_create, transfer, meme, graduation.
  const types = process.env.SOLAMI_ACTIVITY_TYPES || 'token_create,meme,graduation';
  params.set('type', types);

  // Narrow to one venue, for example the Meteora DBC name that appears
  // on Solami's DEXes tab. Comma separated.
  const dex = process.env.SOLAMI_ACTIVITY_DEX || '';
  if (dex) params.set('dex', dex);

  // Narrow to specific token mints, for example a goal token once it is
  // on mainnet.
  const address = process.env.SOLAMI_ACTIVITY_ADDRESS || '';
  if (address) params.set('address', address);

  const backfill = Math.min(200, Math.max(0, Number(process.env.SOLAMI_BACKFILL ?? 10) || 0));
  params.set('backfill', String(backfill));
  params.set('metadata', 'false');

  return {
    url: `${BLUR_BASE}/data/subscribe?${params.toString()}`,
    filters: { type: types, dex: dex || null, address: address || null, backfill },
  };
}

const clean = (v, max = 48) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, max);
const short = (s) => { const t = clean(s, 64); return t.length > 12 ? `${t.slice(0, 4)}...${t.slice(-4)}` : t; };
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : undefined; };
const upper1 = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

// Returns a normalized event, or null for types the feed does not show
// (candle, stats, surge, radar, metadata, list snapshots and anything
// Solami adds later).
function normalizeBlurEvent(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const type = typeof raw.type === 'string' ? raw.type : '';
  const seconds = Number.isFinite(raw.block_time) ? raw.block_time : Number.isFinite(raw.created_time) ? raw.created_time : null;
  const timestampMs = seconds ? seconds * 1000 : Date.now();
  const sig = clean(raw.signature, 100);
  const dex = clean(raw.dex || raw.launchpad, 32);

  switch (type) {
    case 'swap': {
      const side = raw.side === 'sell' ? 'Sell' : 'Buy';
      return {
        id: `swap-${sig}-${clean(raw.pool, 44)}-${side}`,
        type: 'swap',
        label: dex ? `${side} on ${dex}` : side,
        detail: `${short(raw.mint)} at $${clean(raw.price_usd, 16) || '?'}`,
        amountUsd: num(raw.volume_usd),
        timestampMs,
      };
    }
    case 'token_create':
    case 'pool_create': {
      const sym = clean(raw.symbol, 16);
      const name = clean(raw.name, 40);
      const isToken = type === 'token_create';
      return {
        id: `${type}-${sig}-${clean(raw.mint, 44)}`,
        type: 'launch',
        label: isToken ? `New token${sym ? ': ' + sym : ''}` : 'New pool',
        detail: `${name ? name + ' on ' : 'On '}${dex || 'a launchpad'}, ${short(raw.mint)}`,
        timestampMs,
      };
    }
    case 'meme': {
      const meta = raw.metadata && typeof raw.metadata === 'object' ? raw.metadata : {};
      const sym = clean(meta.symbol, 16) || short(raw.mint);
      const pct = clean(raw.progress_pct, 8);
      return {
        id: `meme-${clean(raw.mint, 44)}-${seconds || ''}-${pct}`,
        type: 'meme',
        label: `${sym} on ${dex || 'a launchpad'}`,
        detail: raw.graduated ? 'Bonding curve complete' : `Bonding curve ${pct || '?'}% filled`,
        timestampMs,
      };
    }
    case 'graduation': {
      const from = clean(raw.launchpad, 32);
      const to = clean(raw.dex, 32);
      return {
        id: `graduation-${sig}-${clean(raw.mint, 44)}`,
        type: 'graduation',
        label: 'Token graduated',
        detail: `${short(raw.mint)}${from ? ' from ' + from : ''}${to ? ' to ' + to : ''}`,
        timestampMs,
      };
    }
    case 'liquidity': {
      const removed = raw.kind === 'remove';
      return {
        id: `liquidity-${sig}-${clean(raw.pool, 44)}-${removed ? 'r' : 'a'}`,
        type: 'liquidity',
        label: removed ? 'Liquidity removed' : 'Liquidity added',
        detail: `${dex ? dex + ', ' : ''}${short(raw.base_mint || raw.mint)}`,
        timestampMs,
      };
    }
    case 'transfer': {
      const kind = ['mint', 'burn'].includes(raw.kind) ? raw.kind : 'transfer';
      return {
        id: `transfer-${sig}-${clean(raw.mint, 44)}-${kind}`,
        type: 'transfer',
        label: upper1(kind),
        detail: short(raw.mint),
        timestampMs,
      };
    }
    default:
      return null;
  }
}

function collectFromBlur() {
  const { url, filters } = buildBlurUrl();

  return new Promise((resolve, reject) => {
    const collected = [];
    let settled = false;
    const ws = new WebSocket(url);

    const finish = () => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch (_) { /* already closing */ }
      const seen = new Set();
      const events = [];
      for (const raw of collected) {
        const ev = normalizeBlurEvent(raw);
        if (ev && !seen.has(ev.id)) { seen.add(ev.id); events.push(ev); }
      }
      events.sort((a, b) => b.timestampMs - a.timestampMs);
      resolve({ events: events.slice(0, MAX_EVENTS), filters });
    };

    const timeout = setTimeout(finish, COLLECT_WINDOW_MS);

    ws.on('message', (raw) => {
      if (collected.length >= MAX_RAW) return;
      try {
        const parsed = JSON.parse(raw.toString());
        for (const m of Array.isArray(parsed) ? parsed : [parsed]) collected.push(m);
      } catch (_) { /* skip malformed frame */ }
    });

    ws.on('unexpected-response', (req, res) => {
      res.resume();
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const hint = res.statusCode === 403
        ? ' (the key is missing the DataApi permission, create a key with DataApi in the Solami dashboard)'
        : res.statusCode === 401 ? ' (missing or invalid api key)' : '';
      reject(new Error(`Solami Blur WS handshake failed: HTTP ${res.statusCode}${hint}`));
    });

    ws.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error('Solami Blur WS error: ' + scrubSecrets(err.message)));
    });

    ws.on('close', (code) => {
      if (code === 4002 && !settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new Error('Solami Blur WS closed: streaming balance exhausted (code 4002)'));
      }
    });
  });
}

let cache = null;
let inflight = null;

async function solamiActivitySource() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  if (inflight) return inflight;
  inflight = collectFromBlur()
    .then((value) => { cache = { at: Date.now(), value }; return value; })
    .finally(() => { inflight = null; });
  return inflight;
}

// Central switch. ACTIVITY_SOURCE=solami for real data, defaults to
// mock so the feed always renders something during development. Always
// returns { source, filters, events } so the caller can label honestly.
async function getActivityFeed() {
  if ((process.env.ACTIVITY_SOURCE || 'mock') === 'solami') {
    const { events, filters } = await solamiActivitySource();
    return { source: 'solami', filters, events };
  }
  const events = await mockActivitySource();
  return { source: 'mock', filters: null, events };
}

module.exports = { getActivityFeed, mockActivitySource, solamiActivitySource, normalizeBlurEvent };
