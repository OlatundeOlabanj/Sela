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
//   type is one of: 'swap' | 'transfer' | 'deposit' | 'withdrawal' | 'other'
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
// Transport confirmed from Solami's own docs, not guessed:
//   wss://ws.solami.dev/data/subscribe?chain=solana&api_key=KEY
//   auth is the api_key query param, not a header
//   event types: swap, token_create, liquidity, meme, graduation
//   prices/amounts/percentages arrive as JSON strings (parseFloat,
//     never string concatenation), slots/counts/timestamps are plain
//     JSON numbers
//   metered per delivered byte, 64 KiB / $0.06 prepay minimum to open
//     a stream, close code 4002 means the balance ran out
//   requires a key with the DataApi permission specifically
//
// NOT confirmed, and not guessed here: the literal field names inside
// each event payload (what the trade amount field is actually called,
// whether a dex/pool name is exposed and what Meteora's DBC/DAMM v2
// pools are called if so). normalizeBlurEvent() below does generic
// detection (any string field that looks like an amount/volume, any
// numeric field that looks like a timestamp) and keeps the raw payload
// in `detail` so nothing is silently dropped, rather than inventing a
// specific schema. Paste one real captured message per event type and
// this gets a real field mapping instead.
//
// Held-open connections are not possible from a Netlify function, so
// this connects, collects for a short window, and closes, once per
// poll from activity-feed.js. Trade-off, not a free choice: if the
// prepay minimum applies per connection-open rather than per session
// duration, frequent polling could repeatedly spend that minimum for
// very little data each time. SOLAMI_POLL_WINDOW_MS controls the
// window length if that needs tuning.

const COLLECT_WINDOW_MS = Number(process.env.SOLAMI_POLL_WINDOW_MS) || 4000;

function buildBlurUrl() {
  const apiKey = process.env.SOLAMI_DATAAPI_KEY;
  if (!apiKey) {
    throw new Error('SOLAMI_DATAAPI_KEY not set (needs the DataApi permission, confirm in the Solami dashboard)');
  }
  const params = new URLSearchParams({ chain: 'solana', api_key: apiKey });

  // Comma-separated, e.g. "swap,transfer". Defaults to swap: the type
  // most directly useful for a payment/goal activity feed until dex
  // names are known and DBC/DAMM v2 filtering can be added.
  params.set('type', process.env.SOLAMI_ACTIVITY_TYPES || 'swap');

  // Isolates this app's own wallets/mints once a goal token or a
  // specific address exists to filter on, per the "if DBC/DAMM v2
  // events are not visible, isolate this app's own wallets or mints"
  // fallback plan.
  const address = process.env.SOLAMI_ACTIVITY_ADDRESS;
  if (address) params.set('address', address);

  return { url: `wss://ws.solami.dev/data/subscribe?${params.toString()}`, typesUsed: params.get('type'), addressUsed: address || null };
}

function normalizeBlurEvent(raw, index) {
  const type = typeof raw.type === 'string' ? raw.type : 'other';

  let amountUsd;
  for (const key of Object.keys(raw)) {
    if (/usd|amount|volume/i.test(key) && typeof raw[key] === 'string') {
      const parsed = parseFloat(raw[key]);
      if (Number.isFinite(parsed)) { amountUsd = parsed; break; }
    }
  }

  let timestampMs = Date.now();
  for (const key of Object.keys(raw)) {
    if (/timestamp|time|ts$/i.test(key) && typeof raw[key] === 'number') {
      timestampMs = raw[key] < 4102444800 ? raw[key] * 1000 : raw[key];
      break;
    }
  }

  return {
    id: raw.signature || raw.id || `${type}-${timestampMs}-${index}`,
    type: ['swap', 'transfer', 'deposit', 'withdrawal'].includes(type) ? type : 'other',
    label: type.charAt(0).toUpperCase() + type.slice(1).replace('_', ' '),
    detail: `Unmapped fields, raw event: ${JSON.stringify(raw).slice(0, 200)}`,
    amountUsd,
    timestampMs,
  };
}

async function solamiActivitySource() {
  const { url, typesUsed, addressUsed } = buildBlurUrl();

  const events = await new Promise((resolve, reject) => {
    const collected = [];
    let settled = false;
    const ws = new WebSocket(url);

    const finish = () => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch (_) { /* already closing */ }
      resolve(collected);
    };

    const timeout = setTimeout(finish, COLLECT_WINDOW_MS);

    ws.on('message', (raw) => {
      try { collected.push(JSON.parse(raw.toString())); } catch (_) { /* skip malformed frame */ }
    });

    ws.on('unexpected-response', (req, res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const is403 = res.statusCode === 403;
      reject(new Error(
        `Solami Blur WS handshake failed: HTTP ${res.statusCode}` +
        (is403 ? ' (likely missing the DataApi permission on this key, check the dashboard)' : '')
      ));
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
        reject(new Error('Solami Blur WS closed: prepaid balance exhausted (code 4002)'));
      }
    });
  });

  return {
    events: events.map(normalizeBlurEvent),
    filters: { type: typesUsed, address: addressUsed },
  };
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

module.exports = { getActivityFeed, mockActivitySource, solamiActivitySource };
