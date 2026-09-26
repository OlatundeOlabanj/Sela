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

// Real Solami-backed source. Left unimplemented on purpose: writing a
// call against unconfirmed endpoint paths would just be another guess,
// same problem the verification script flags. Fill this in once
// solami-verify.js confirms which surface (Blur, Mirage, Beam) actually
// returns 200s, using the real base URL and auth header it reveals.
async function solamiActivitySource() {
  throw new Error(
    'solamiActivitySource() not implemented yet: pending API access verification. ' +
    'See solami-verify.js output for the confirmed base URL and auth header, then fill this in.'
  );
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
