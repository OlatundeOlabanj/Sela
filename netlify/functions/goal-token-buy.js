'use strict';
// POST /.netlify/functions/goal-token-buy
// Body: { action: 'quote' | 'build', goalId, buyer, amountUsdc, slippageBps? }
// quote returns the expected token amount. build returns an UNSIGNED swap transaction (base64)
// for the buyer's wallet to sign. No user key is ever held here.

const C = require('../../goal-token-dbc/lib/common');
const adapter = require('../../goal-token-dbc/lib/sdk-adapter');
const registry = require('../../goal-token-dbc/lib/registry');

const DEFAULT_SLIPPAGE_BPS = 100;
const MAX_SLIPPAGE_BPS = 500;

async function run(event, env, injected) {
  if (event.httpMethod !== 'POST') throw new C.HttpError(405, 'POST only');
  const b = C.parseBody(event);
  const action = b.action === 'build' ? 'build' : 'quote';
  const goalId = C.requireGoalId(b.goalId);
  const buyer = C.requireAddress(b.buyer, 'buyer');
  const amountInUnits = C.usdcToBaseUnits(b.amountUsdc);
  const slippageBps = b.slippageBps === undefined ? DEFAULT_SLIPPAGE_BPS : Number(b.slippageBps);
  if (!Number.isInteger(slippageBps) || slippageBps < 1 || slippageBps > MAX_SLIPPAGE_BPS) {
    throw new C.HttpError(400, 'slippageBps must be an integer from 1 to ' + MAX_SLIPPAGE_BPS);
  }

  const cluster = C.getCluster(env);
  const store = (injected && injected.store) || registry.openStore();
  const rec = await registry.getRecord(store, cluster.name, goalId);
  if (!rec) throw new C.HttpError(404, 'No goal token registered for this goal');

  const deps = (injected && injected.deps) || adapter.loadDeps(cluster);
  const snap = await adapter.getPoolSnapshot(deps, rec.poolAddress);
  if (!snap) throw new C.HttpError(409, 'Pool not found on chain');
  if (snap.isMigrated) throw new C.HttpError(409, 'This goal has graduated. Trade the token on its DAMM v2 pool instead.');

  const raised = BigInt(snap.quoteReserve);
  const target = BigInt(snap.migrationQuoteThreshold);
  if (raised >= target) {
    throw new C.HttpError(409, 'The goal amount has been reached. Waiting for graduation.');
  }
  // Soft cap: a buy far beyond the remaining capacity would fail on chain or be partly
  // filled. The 2 percent allowance covers the trading fee. UNVERIFIED against a real run.
  const remaining = target - raised;
  if (BigInt(amountInUnits) > (remaining * 102n) / 100n) {
    throw new C.HttpError(400, 'Amount is more than the goal still needs (' + remaining.toString() + ' base units)');
  }

  const q = await adapter.quoteBuy(deps, snap, amountInUnits, slippageBps);
  if (action === 'quote') {
    return { goalId, cluster: cluster.name, amountInUnits, slippageBps, expectedTokenUnits: q.outputAmount, minimumTokenUnits: q.minimumAmountOut, tokenDecimals: 6 };
  }
  const built = await adapter.buildBuyTx(deps, {
    buyer, poolAddress: rec.poolAddress, amountInUnits, minimumAmountOut: q.minimumAmountOut,
  });
  return {
    goalId, cluster: cluster.name, txBase64: built.txBase64, blockhash: built.blockhash,
    lastValidBlockHeight: built.lastValidBlockHeight, expectedTokenUnits: q.outputAmount, minimumTokenUnits: q.minimumAmountOut,
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
