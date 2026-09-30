'use strict';
// GET /.netlify/functions/goal-token-status?goalId=...
// Returns progress toward the goal (quote reserve against the migration threshold) and
// graduation status, read from the pool account on chain.

const C = require('../../goal-token-dbc/lib/common');
const adapter = require('../../goal-token-dbc/lib/sdk-adapter');
const registry = require('../../goal-token-dbc/lib/registry');

function unitsToUsdc(units) {
  const s = String(units).padStart(C.USDC_DECIMALS + 1, '0');
  const whole = s.slice(0, -C.USDC_DECIMALS);
  const frac = s.slice(-C.USDC_DECIMALS).replace(/0+$/, '');
  return frac ? whole + '.' + frac : whole;
}

async function run(event, env, injected) {
  if (event.httpMethod !== 'GET') throw new C.HttpError(405, 'GET only');
  const goalId = C.requireGoalId((event.queryStringParameters || {}).goalId);
  const cluster = C.getCluster(env);
  const store = (injected && injected.store) || registry.openStore();
  const rec = await registry.getRecord(store, cluster.name, goalId);
  if (!rec) return { registered: false, goalId, cluster: cluster.name };

  const deps = (injected && injected.deps) || adapter.loadDeps(cluster);
  const snap = await adapter.getPoolSnapshot(deps, rec.poolAddress);
  if (!snap) return { registered: true, goalId, cluster: cluster.name, poolFound: false, record: rec };

  const raised = BigInt(snap.quoteReserve);
  const target = BigInt(snap.migrationQuoteThreshold);
  const bp = target > 0n ? Number((raised * 10000n) / target) : 0;
  const progressPct = Math.min(100, bp / 100);
  const reached = raised >= target;
  const remaining = reached ? 0n : target - raised;

  return {
    registered: true,
    poolFound: true,
    goalId,
    cluster: cluster.name,
    poolAddress: rec.poolAddress,
    mintAddress: rec.mintAddress,
    name: rec.name,
    symbol: rec.symbol,
    raisedUsdc: unitsToUsdc(raised),
    targetUsdc: unitsToUsdc(target),
    remainingUsdc: unitsToUsdc(remaining),
    progressPct,
    // Graduation is executed by Meteora's migrator once the threshold is met. Until it runs,
    // reached is true and migrated is false.
    thresholdReached: reached,
    migrated: snap.isMigrated,
    explorerPoolUrl: 'https://explorer.solana.com/address/' + rec.poolAddress + cluster.explorerSuffix,
    explorerMintUrl: 'https://explorer.solana.com/address/' + rec.mintAddress + cluster.explorerSuffix,
  };
}

exports.run = run;
exports.unitsToUsdc = unitsToUsdc;
exports.handler = async (event) => {
  try {
    return C.respond(200, await run(event, process.env));
  } catch (err) {
    return C.handleError(err);
  }
};
