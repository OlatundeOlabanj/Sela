'use strict';
// POST /.netlify/functions/goal-token-create
// Body: { goalId, creator, goalAmountUsdc, name, symbol }
// Returns an UNSIGNED config plus pool creation transaction (base64), already signed by the
// two throwaway keypairs it needs (config account, token mint). The creator's wallet signs
// last. This function never sees or stores a user's private key.

const C = require('../../goal-token-dbc/lib/common');
const curve = require('../../goal-token-dbc/lib/curve-params');
const adapter = require('../../goal-token-dbc/lib/sdk-adapter');
const registry = require('../../goal-token-dbc/lib/registry');

async function run(event, env, injected) {
  if (event.httpMethod !== 'POST') throw new C.HttpError(405, 'POST only');
  const body = C.parseBody(event);
  const goalId = C.requireGoalId(body.goalId);
  const creator = C.requireAddress(body.creator, 'creator');
  const goalAmount = curve.validateGoalAmount(body.goalAmountUsdc);

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const symbol = typeof body.symbol === 'string' ? body.symbol.trim().toUpperCase() : '';
  if (name.length < 1 || name.length > 32) throw new C.HttpError(400, 'name must be 1 to 32 characters');
  if (!/^[A-Z0-9]{2,10}$/.test(symbol)) throw new C.HttpError(400, 'symbol must be 2 to 10 letters or digits');

  const cluster = C.getCluster(env);
  const treasury = C.getTreasuryAddress(env);
  const store = (injected && injected.store) || registry.openStore();
  if (await registry.getRecord(store, cluster.name, goalId)) {
    throw new C.HttpError(409, 'A goal token already exists for this goal');
  }

  const deps = (injected && injected.deps) || adapter.loadDeps(cluster);
  const siteUrl = env.URL || '';
  const uri =
    siteUrl +
    '/.netlify/functions/goal-token-metadata?g=' + encodeURIComponent(goalId) +
    '&n=' + encodeURIComponent(name) + '&s=' + encodeURIComponent(symbol);

  const curveInput = curve.buildCurveInput(goalAmount, treasury);
  const built = await adapter.buildCreateGoalTx(deps, {
    creator, name, symbol, uri, quoteMint: cluster.quoteMint, feeClaimer: treasury, curveInput,
  });

  return {
    cluster: cluster.name,
    goalId,
    txBase64: built.txBase64,
    blockhash: built.blockhash,
    lastValidBlockHeight: built.lastValidBlockHeight,
    poolAddress: built.poolAddress,
    mintAddress: built.mintAddress,
    configAddress: built.configAddress,
    goalAmountUsdc: goalAmount,
    name,
    symbol,
  };
}

exports.run = run;
exports.handler = async (event) => {
  try {
    return C.respond(200, await run(event, process.env));
  } catch (err) {
    return C.handleError(err);
  }
};
