// netlify/functions/rpc-proxy.js
//
// Server side proxy for Solana RPC calls. The endpoint and its key live
// only in Netlify environment variables, never in browser code. See
// lib/rpcClient.js for how each cluster's endpoint is resolved.
//
// Frontend calls /api/rpc (redirected here). Pick a cluster with a
// query parameter:
//   /api/rpc                     mainnet-beta, through RPC Fast
//   /api/rpc?cluster=devnet      devnet, through DEVNET_RPC_URL or the
//                                public devnet endpoint
// The default stays mainnet-beta so existing callers are unchanged.
// A caller can only name a cluster, never supply a URL.
//
// Made by TJS Code

const { getRpcUrlForCluster, isValidCluster } = require('../../lib/rpcClient');
const { isAllowedOrigin } = require('../../lib/originGuard');

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

  if (!isAllowedOrigin(event.headers)) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'Forbidden origin.' }) };
  }

  const cluster = (event.queryStringParameters && event.queryStringParameters.cluster) || 'mainnet-beta';
  if (!isValidCluster(cluster)) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Unknown cluster. Use mainnet-beta or devnet.' }),
    };
  }

  let rpcUrl;
  try {
    rpcUrl = getRpcUrlForCluster(cluster);
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
    // err.message can contain the request URL on some fetch failures,
    // so it is not echoed back. Log server side only.
    console.error('rpc-proxy upstream failure:', err && err.message);
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({ error: 'RPC proxy request failed.' }),
    };
  }
};
