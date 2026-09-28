// netlify/functions/rpc-health.js
//
// Live proof of which RPC provider is serving mainnet. It runs real
// getSlot calls through the same code path the proxy uses
// (lib/rpcClient.js) and returns the provider name, an optional region
// label, the slot, and the measured round trip time. It never returns
// the endpoint URL or the key.
//
// Three samples are taken and the median is reported, so one slow call
// does not decide the number. The result is cached for 15 seconds so
// a page full of visitors cannot burn the provider's request quota.
// When a cached result is served, "cached" is true and "measuredAt"
// says when the measurement was really taken.
//
// GET /api/rpc-health
//
// Made by TJS Code

const { getRpcUrl, getProviderInfo } = require('../../lib/rpcClient');
const { isAllowedOrigin } = require('../../lib/originGuard');

const CACHE_MS = 15000;
const SAMPLES = 3;
const TIMEOUT_MS = 6000;
let cache = null;

async function timedGetSlot(url) {
  const started = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSlot', params: [{ commitment: 'confirmed' }] }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const elapsed = Date.now() - started;
  if (!res.ok) throw new Error('upstream HTTP ' + res.status);
  const json = await res.json();
  if (json.error || typeof json.result !== 'number') throw new Error('upstream returned no slot');
  return { slot: json.result, ms: elapsed };
}

function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  };

  if (event.httpMethod && event.httpMethod !== 'GET') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Use GET.' }) };
  }
  if (!isAllowedOrigin(event.headers)) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'Forbidden origin.' }) };
  }

  if (cache && Date.now() - cache.at < CACHE_MS) {
    return { statusCode: 200, headers, body: JSON.stringify({ ...cache.body, cached: true }) };
  }

  let url;
  let provider;
  try {
    url = getRpcUrl();
    provider = getProviderInfo();
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: 'RPC not configured.' }) };
  }

  try {
    const results = [];
    for (let i = 0; i < SAMPLES; i++) results.push(await timedGetSlot(url));
    const body = {
      ok: true,
      provider: provider.name,
      region: provider.region,
      cluster: 'mainnet-beta',
      slot: results[results.length - 1].slot,
      latencyMs: median(results.map((r) => r.ms)),
      samples: SAMPLES,
      measuredAt: new Date().toISOString(),
      cached: false,
    };
    cache = { at: Date.now(), body };
    return { statusCode: 200, headers, body: JSON.stringify(body) };
  } catch (err) {
    // Log the reason server side. The response never carries err.message
    // because a failed fetch can include the request URL.
    console.error('rpc-health failure:', err && err.message);
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({ ok: false, provider: provider.name, error: 'Health check failed.' }),
    };
  }
};
