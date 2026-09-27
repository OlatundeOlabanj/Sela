// netlify/functions/submit-bundle.js
//
// Real Jito bundle submission, ported and adapted from
// smart-tx-stack's src/execution/jito.ts
// (github.com/OlatundeOlabanj/smart-tx-stack), changed to accept an
// already wallet-signed transaction (this is a payments app, the
// user's wallet signs, not a server-held Keypair) and to target
// Jito's MAINNET block engine instead of testnet.
//
// DUAL-SEND, not sequential fallback (fixed Aug 2026, see incident
// below). Submits the SAME signed transaction (same blockhash, same
// signature) to Jito AND the plain RPC endpoint concurrently (see
// lib/rpcClient.js for how that endpoint is resolved). This is safe:
// it's one transaction either way, so it lands once or not at all,
// there is no double-charge risk, and _waitForSafeRetry client-side
// still governs actual retries with a genuinely new transaction.
//
// WHY THIS CHANGED: the old version only fell back to plain RPC when
// Jito's sendBundle call itself errored. But a Jito bundle can be
// ACCEPTED (returns a bundleId, no error) and then simply never win
// the tip auction / never get included by a leader. Jito doesn't
// report that as an error, it just silently doesn't land. That gap
// is what produced the Aug 3 2026 "Confirmation timed out" failure:
// Jito said yes, nothing ever hit the chain, and the plain-RPC path
// was never even attempted because no exception was thrown to trigger
// it. Dual-send closes this by giving the transaction two independent
// landing paths from the start, every time.
//
// Made by TJS Code

const { getRpcUrl } = require('../../lib/rpcClient');

const JITO_BUNDLES_URL = 'https://mainnet.block-engine.jito.wtf/api/v1/bundles';

async function submitViaJito(signedTxBase64) {
  const res = await fetch(JITO_BUNDLES_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'sendBundle',
      params: [[signedTxBase64], { encoding: 'base64' }],
    }),
    signal: AbortSignal.timeout(10000),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || 'Jito rejected the bundle');
  // NOTE: a bundleId here means "accepted into the auction queue," NOT
  // "confirmed landing." Never treat this alone as payment success.
  return { bundleId: data.result };
}

async function submitViaRpc(signedTxBase64) {
  const rpcUrl = getRpcUrl();
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'sendTransaction',
      params: [signedTxBase64, { encoding: 'base64', skipPreflight: false, maxRetries: 3 }],
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || 'RPC rejected the transaction');
  return { signature: data.result };
}

/**
 * Short-lived poll of Jito's own getBundleStatuses right after acceptance,
 * purely for diagnostics, logged, never blocks the response on it landing.
 * This is what tells you, from the logs, whether Jito's side ever even
 * picked the bundle up (vs. it just sitting unlanded in the queue), without
 * needing to dig through the Netlify dashboard blind next time.
 * Budgeted to ~3s total so it can't meaningfully delay the response.
 */
async function pollBundleStatusForLogging(bundleId, signature) {
  for (let i = 0; i < 2; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const res = await fetch(JITO_BUNDLES_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getBundleStatuses',
          params: [[bundleId]],
        }),
        signal: AbortSignal.timeout(2000),
      });
      const data = await res.json();
      const entry = data?.result?.value?.[0];
      console.log(`[submit-bundle] sig=${signature} bundleId=${bundleId} jito-status-poll#${i + 1}=${entry ? JSON.stringify(entry) : 'no entry yet (still queued or dropped)'}`);
      if (entry) return; // got a real status, no need to poll again
    } catch (err) {
      console.log(`[submit-bundle] sig=${signature} bundleId=${bundleId} jito-status-poll#${i + 1} FAILED: ${err.message}`);
    }
  }
}

exports.handler = async (event) => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  const origin = event.headers?.origin || event.headers?.referer || '';
  if (origin && !origin.includes('veilpay.store') && !origin.includes('veilpay-tjscode.netlify.app') && !origin.includes('localhost')) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'Forbidden origin.' }) };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed. Use POST.' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON body.' }) };
  }

  const { signedTxBase64, signature } = body;
  if (!signedTxBase64 || !signature) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'signedTxBase64 and signature are required.' }) };
  }

  console.log(`[submit-bundle] start sig=${signature}`);

  const [jitoResult, rpcResult] = await Promise.allSettled([
    submitViaJito(signedTxBase64),
    submitViaRpc(signedTxBase64),
  ]);

  const jitoOk = jitoResult.status === 'fulfilled';
  const rpcOk = rpcResult.status === 'fulfilled';

  console.log(`[submit-bundle] sig=${signature} jito=${jitoOk ? `ok bundleId=${jitoResult.value.bundleId}` : `FAILED: ${jitoResult.reason.message}`}`);
  console.log(`[submit-bundle] sig=${signature} rpc=${rpcOk ? 'ok' : `FAILED: ${rpcResult.reason.message}`}`);

  if (!jitoOk && !rpcOk) {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: false,
        signature,
        error: `Jito failed (${jitoResult.reason.message}); RPC also failed (${rpcResult.reason.message})`,
      }),
    };
  }

  // Log Jito's own bundle status a couple times over the next ~3s, purely
  // for diagnostics. Awaited on purpose, even though it delays the
  // response slightly: Netlify/Lambda can freeze the execution environment
  // right after a response is sent, so fire-and-forget work here isn't
  // reliably captured in logs. The client is also independently polling
  // real on-chain confirmation via /api/rpc regardless of this.
  if (jitoOk) {
    await pollBundleStatusForLogging(jitoResult.value.bundleId, signature);
  }

  // Either channel accepting submission means this signature is now in
  // flight on-chain. This is still NOT confirmation. The caller polls
  // getSignatureStatuses separately to find out whether it actually landed.
  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      success: true,
      signature,
      bundleId: jitoOk ? jitoResult.value.bundleId : null,
      jitoAccepted: jitoOk,
      rpcAccepted: rpcOk,
      jitoError: jitoOk ? null : jitoResult.reason.message,
      usedFallback: !jitoOk && rpcOk,
    }),
  };
};
