'use strict';
// POST /.netlify/functions/goal-token-send
// Body: { action: 'send', signedTxBase64 } or { action: 'status', signature }
// Relays a wallet signed goal token transaction to the PROGRAM_CLUSTER RPC and reports its
// status. It refuses any transaction that calls a program outside the goal token allowlist,
// so it cannot be used as a general purpose relay. The RPC URL stays server side.
//
// Note: this is not the Jito plus RPC dual send used for mainnet payments. The goal token
// runs on PROGRAM_CLUSTER, which is devnet until the program is deployed, and Jito bundles do
// not apply on devnet.

const C = require('../../goal-token-dbc/lib/common');
const adapter = require('../../goal-token-dbc/lib/sdk-adapter');

async function run(event, env, injected) {
  if (event.httpMethod !== 'POST') throw new C.HttpError(405, 'POST only');
  const b = C.parseBody(event);
  const cluster = C.getCluster(env);
  const deps = (injected && injected.deps) || adapter.loadDeps(cluster);

  if (b.action === 'status') {
    if (typeof b.signature !== 'string' || b.signature.length < 64 || b.signature.length > 100) {
      throw new C.HttpError(400, 'signature is required');
    }
    const res = await deps.connection.getSignatureStatuses([b.signature], { searchTransactionHistory: true });
    const s = res && res.value && res.value[0];
    if (!s) return { signature: b.signature, state: 'unknown' };
    return { signature: b.signature, state: s.err ? 'failed' : (s.confirmationStatus || 'processed'), error: s.err ? JSON.stringify(s.err) : null };
  }

  if (typeof b.signedTxBase64 !== 'string' || b.signedTxBase64.length > 4000) {
    throw new C.HttpError(400, 'signedTxBase64 is required and must be a single transaction');
  }
  const raw = Buffer.from(b.signedTxBase64, 'base64');
  let tx;
  try {
    tx = deps.web3.Transaction.from(raw);
  } catch (e) {
    throw new C.HttpError(400, 'Could not decode the transaction');
  }
  const allowed = adapter.allowedProgramIds(deps);
  for (const ix of tx.instructions) {
    const id = ix.programId.toBase58();
    if (!allowed.has(id)) throw new C.HttpError(400, 'Transaction calls a program that is not allowed: ' + id);
  }
  const signature = await deps.connection.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 3 });
  return { signature, cluster: cluster.name };
}

exports.run = run;
exports.handler = async (event) => {
  try {
    return C.respond(200, await run(event, process.env));
  } catch (err) {
    return C.handleError(err);
  }
};
