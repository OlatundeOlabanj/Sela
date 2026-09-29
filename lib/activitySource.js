// lib/activitySource.js
//
// Adapter boundary for the activity feed / notifications data source.
// The rest of the app calls getActivityFeed() and gets back a normalized
// event list, never a provider-specific shape. Swapping data sources
// (mock, Solami Blur, Solami Mirage, Solami Beam, whatever ends up
// working) means writing one function here, not touching the frontend
// or the Netlify function that serves it.
//
// Normalized event shape:
//   { id, type, label, detail, amountUsd, timestampMs }
//   type is one of: 'swap' | 'transfer' | 'deposit' | 'withdrawal' | 'other'
//
// Made by TJS Code

// Demo/fallback source. Used until a real Solami source below is
// confirmed working and wired in. Clearly synthetic, not live data.
function mockActivitySource() {
  const now = Date.now();
  return Promise.resolve([
    { id: 'mock-1', type: 'swap', label: 'SOL to USDC swap', detail: 'Mock event, not live data', amountUsd: 42.5, timestampMs: now - 60000 },
    { id: 'mock-2', type: 'deposit', label: 'Deposit received', detail: 'Mock event, not live data', amountUsd: 100, timestampMs: now - 300000 },
    { id: 'mock-3', type: 'transfer', label: 'Transfer sent', detail: 'Mock event, not live data', amountUsd: 15.75, timestampMs: now - 900000 },
  ]);
}

// Real Solami-backed source, using the Blur data stream
// (wss://ws.solami.dev/data/subscribe). Connection, auth, filtering and
// billing-safety handling below are built against Solami's own docs.
// The requesting key needs the DataApi permission specifically, not
// just general RPC access. Confirm that in the Solami dashboard before
// relying on this. This has NOT been run against a real Solami server
// (no network path to solami.dev from this environment), so treat the
// connection layer as "built to spec, not yet field-tested."
//
// NOT guessed: URL, api_key query param, filter params, close code 4002
// (all given explicitly). GUESSED, marked TODO below: the actual field
// names inside each event payload, since no sample message was
// available. Paste one real captured message per event type
// (swap / token_create / liquidity / meme / graduation) and
// normalizeBlurEvent() gets filled in for real instead of passing
// events through mostly-unparsed.
const WebSocket = require('ws');

// A short-lived connect/collect/close window per poll rather than a
// held-open connection, so this fits the existing serverless Netlify
// function model (which can't hold a WebSocket open indefinitely).
// Trade-off: if the 64 KiB / $0.06 minimum applies per connection-open
// rather than per byte-over-the-session, polling frequently could
// burn that minimum repeatedly for little data each time. Widen
// SOLAMI_POLL_WINDOW_MS / call this less often if that turns out true.
const COLLECT_WINDOW_MS = Number(process.env.SOLAMI_POLL_WINDOW_MS) || 4000;

function buildBlurUrl() {
  const apiKey = process.env.SOLAMI_DATAAPI_KEY;
  if (!apiKey) {
    throw new Error('SOLAMI_DATAAPI_KEY not set (needs the DataApi permission, confirm in the Solami dashboard)');
  }
  const params = new URLSearchParams({ chain: 'solana', api_key: apiKey });

  // Comma-separated list, e.g. "swap,transfer". Defaults to swap since
  // that is the event type most directly useful for a payment activity
  // feed.
  const types = process.env.SOLAMI_ACTIVITY_TYPES || 'swap';
  params.set('type', types);

  // Once a specific goal/wallet token exists to filter on, set this so
  // the feed only shows activity relevant to it instead of all Solana
  // swap traffic.
  const address = process.env.SOLAMI_ACTIVITY_ADDRESS;
  if (address) params.set('address', address);

  return `wss://ws.solami.dev/data/subscribe?${params.toString()}`;
}

// TODO: fill in real field names once a sample message per event type
// is available. For now this passes the type through, treats anything
// that looks like a numeric-string money/percentage field as such
// (parseFloat, never string concatenation, per the docs' own warning
// about silent corruption), and otherwise keeps the raw payload visible
// in `detail` so nothing is silently lost while the mapping is unknown.
function normalizeBlurEvent(raw, index) {
  const type = typeof raw.type === 'string' ? raw.type : 'other';

  // Solami's docs say prices/amounts/percentages arrive as JSON strings
  // and slots/counts/timestamps as real numbers. Without confirmed
  // field names, scan generically rather than assume a specific key.
  let amountUsd;
  for (const key of Object.keys(raw)) {
    if (/usd|amount|volume/i.test(key) && typeof raw[key] === 'string') {
      const parsed = parseFloat(raw[key]);
      if (Number.isFinite(parsed)) {
        amountUsd = parsed;
        break;
      }
    }
  }

  let timestampMs = Date.now();
  for (const key of Object.keys(raw)) {
    if (/timestamp|time|ts$/i.test(key) && typeof raw[key] === 'number') {
      // Solana/Unix timestamps in seconds vs ms both show up in the
      // wild; treat anything below year-2100-in-seconds as seconds.
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
  const url = buildBlurUrl();

  return new Promise((resolve, reject) => {
    const collected = [];
    let settled = false;
    const ws = new WebSocket(url);

    const finish = () => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch (_) { /* already closing */ }
      resolve(collected.map(normalizeBlurEvent));
    };

    const timeout = setTimeout(finish, COLLECT_WINDOW_MS);

    ws.on('message', (raw) => {
      try {
        collected.push(JSON.parse(raw.toString()));
      } catch (_) {
        // Malformed frame, skip it rather than fail the whole poll.
      }
    });

    ws.on('unexpected-response', (req, res) => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      const is403 = res.statusCode === 403;
      reject(new Error(
        `Solami Blur WS handshake failed: HTTP ${res.statusCode}` +
        (is403 ? ' (likely the DataApi permission missing from this key, check the dashboard)' : '')
      ));
    });

    ws.on('error', (err) => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      reject(new Error('Solami Blur WS error: ' + err.message));
    });

    ws.on('close', (code) => {
      if (code === 4002) {
        clearTimeout(timeout);
        if (!settled) {
          settled = true;
          reject(new Error('Solami Blur WS closed: prepaid balance exhausted (code 4002)'));
        }
      }
    });
  });
}

// Central switch. Set ACTIVITY_SOURCE=solami once solamiActivitySource
// is implemented and confirmed; defaults to mock so the feed always
// renders something during development.
async function getActivityFeed() {
  const source = process.env.ACTIVITY_SOURCE || 'mock';
  if (source === 'solami') {
    return solamiActivitySource();
  }
  return mockActivitySource();
}

module.exports = { getActivityFeed, mockActivitySource, solamiActivitySource };
