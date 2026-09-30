'use strict';
// GET  /.netlify/functions/goal-token-registry?goalId=...   returns the registered record
// POST /.netlify/functions/goal-token-registry              registers a created goal token
// Body: { goalId, creator, poolAddress, mintAddress, configAddress, name, symbol,
//         goalAmountUsdc, signature }
// The pool must exist on chain and match the claimed creator, config and mint before it is
// stored. First registration for a goal wins.
//
// Known gap: nothing here proves the caller owns the goal itself. That check needs Session
// A's goal or vault data. Until it exists, a caller could register a pool for someone else's
// goal id before its real owner does.

const C = require('../../goal-token-dbc/lib/common');
const adapter = require('../../goal-token-dbc/lib/sdk-adapter');
const registry = require('../../goal-token-dbc/lib/registry');

async function run(event, env, injected) {
  const cluster = C.getCluster(env);
  const store = (injected && injected.store) || registry.openStore();

  if (event.httpMethod === 'GET') {
    const goalId = C.requireGoalId((event.queryStringParameters || {}).goalId);
    const rec = await registry.getRecord(store, cluster.name, goalId);
    if (!rec) throw new C.HttpError(404, 'No goal token registered for this goal');
    return rec;
  }
  if (event.httpMethod !== 'POST') throw new C.HttpError(405, 'GET or POST only');

  const b = C.parseBody(event);
  const goalId = C.requireGoalId(b.goalId);
  const creator = C.requireAddress(b.creator, 'creator');
  const poolAddress = C.requireAddress(b.poolAddress, 'poolAddress');
  const mintAddress = C.requireAddress(b.mintAddress, 'mintAddress');
  const configAddress = C.requireAddress(b.configAddress, 'configAddress');

  const deps = (injected && injected.deps) || adapter.loadDeps(cluster);
  const snap = await adapter.getPoolSnapshot(deps, poolAddress);
  if (!snap) throw new C.HttpError(409, 'Pool not found on chain yet. Wait for confirmation and retry.');
  if (snap.creator !== creator || snap.configAddress !== configAddress || snap.baseMint !== mintAddress) {
    throw new C.HttpError(400, 'On chain pool does not match the submitted creator, config and mint');
  }

  const record = {
    goalId,
    cluster: cluster.name,
    creator,
    poolAddress,
    mintAddress,
    configAddress,
    name: String(b.name || '').slice(0, 32),
    symbol: String(b.symbol || '').slice(0, 10),
    goalAmountUsdc: Number(b.goalAmountUsdc) || null,
    signature: typeof b.signature === 'string' ? b.signature.slice(0, 100) : null,
    createdAt: new Date().toISOString(),
  };
  return registry.putRecord(store, cluster.name, record);
}

exports.run = run;
exports.handler = async (event) => {
  try {
    return C.respond(200, await run(event, process.env));
  } catch (err) {
    return C.handleError(err);
  }
};
