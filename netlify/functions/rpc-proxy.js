// netlify/functions/rpc-proxy.js
//
// Server-side proxy for Solana RPC calls via Helius.
// The Helius API key lives only here, as a Netlify environment variable
// (HELIUS_API_KEY), never shipped in client-side JS.
//
// Frontend calls: /.netlify/functions/rpc-proxy
// instead of: https://mainnet.helius-rpc.com/?api-key=<key>
//
// Made by TJS Code

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
  // spoofed outside a browser), but blocks casual scraping of the
  // Helius key's quota. TODO: real rate limiting per IP if abuse shows up.
  const origin = event.headers?.origin || event.headers?.referer || '';
  if (origin && !origin.includes('veilpay.store') && !origin.includes('veilpay-tjscode.netlify.app') && !origin.includes('localhost')) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'Forbidden origin.' }) };
  }

  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Server misconfigured: HELIUS_API_KEY not set.' }),
    };
  }

  try {
    const heliusUrl = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;

    const res = await fetch(heliusUrl, {
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
