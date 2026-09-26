// netlify/functions/rpc-proxy.js
//
// Server-side proxy for Solana RPC calls. The endpoint (and whatever
// auth it needs) lives only here, as Netlify environment variables,
// never shipped in client-side JS. See lib/rpcClient.js for how the
// endpoint is resolved and how to point this at a different provider.
//
// Frontend calls: /.netlify/functions/rpc-proxy
// instead of calling the provider's RPC URL directly.
//
// Made by TJS Code

const { getRpcUrl } = require('../../lib/rpcClient');

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method not allowed. Use POST.' }),
    };
  }

  // Lightweight abuse guard: only accept requests that look like they
  // came from this site's own pages. Not bulletproof (headers can be
  // spoofed outside a browser), but blocks casual scraping of the RPC
  // key's quota. TODO: real rate limiting per IP if abuse shows up.
  const origin = event.headers?.origin || event.headers?.referer || '';
  if (origin && !origin.includes('veilpay.store') && !origin.includes('veilpay-tjscode.netlify.app') && !origin.includes('localhost')) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'Forbidden origin.' }) };
  }

  let rpcUrl;
  try {
    rpcUrl = getRpcUrl();
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Server misconfigured: ' + err.message }),
    };
  }

  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: event.body,
    });

    const data = await res.text();

    return {
      statusCode: res.status,
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: data,
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({ error: 'RPC proxy request failed: ' + err.message }),
    };
  }
};
