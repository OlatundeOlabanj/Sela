'use strict';
// Offline tests. Run with: node --test goal-token-dbc/test/
// These prove the builders wire the settled decisions into the SDK call and behave correctly
// around it. They do NOT prove the real SDK accepts these parameters. That needs the real
// package, see RUNBOOK.md "App integration check".

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const C = require('../lib/common');
const create = require('../../netlify/functions/goal-token-create');
const registryFn = require('../../netlify/functions/goal-token-registry');
const status = require('../../netlify/functions/goal-token-status');
const buy = require('../../netlify/functions/goal-token-buy');
const send = require('../../netlify/functions/goal-token-send');

// ---------- mocks ----------
const ALPHA = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58(bytes) {
  let digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let j = 0; j < digits.length; j++) { carry += digits[j] << 8; digits[j] = carry % 58; carry = (carry / 58) | 0; }
    while (carry > 0) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let s = '';
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) s += '1';
  for (let i = digits.length - 1; i >= 0; i--) s += ALPHA[digits[i]];
  return s;
}
const randAddr = () => b58(crypto.randomBytes(32));

class FakePk { constructor(v) { this.v = v; } toBase58() { return this.v; } }
class FakeBN { constructor(v) { this.v = BigInt(v); } toString() { return this.v.toString(); } }

function makeDeps(state) {
  const calls = { curveInput: null, createArgs: null, swapArgs: null, partialSigners: null, serializeOpts: null, sent: null };
  class FakeTx {
    constructor(programIds) { this.instructions = (programIds || []).map((id) => ({ programId: new FakePk(id) })); }
    partialSign(...s) { calls.partialSigners = s; }
    serialize(opts) { calls.serializeOpts = opts; return Buffer.from('unsigned-tx'); }
    static from() { return new FakeTx(state.txPrograms || [C.DBC_PROGRAM_ID]); }
  }
  const web3 = {
    PublicKey: FakePk,
    Keypair: { generate: () => ({ publicKey: new FakePk(randAddr()) }) },
    SystemProgram: { programId: new FakePk('11111111111111111111111111111111') },
    Transaction: FakeTx,
  };
  const sdk = {
    SwapMode: { ExactIn: 0 },
    buildCurve: (input) => { calls.curveInput = input; return { built: true }; },
    deriveDbcPoolAddress: () => new FakePk(state.poolAddress || randAddr()),
    DynamicBondingCurveClient: {
      create: () => ({
        pool: {
          createConfigAndPool: async (a) => { calls.createArgs = a; return new FakeTx(); },
          swapQuote2: async () => ({ outputAmount: new FakeBN(5000000), minimumAmountOut: new FakeBN(4950000) }),
          swap: async (a) => { calls.swapArgs = a; return new FakeTx(); },
        },
        state: {
          getPool: async () => state.pool || null,
          getPoolConfig: async () => ({ migrationQuoteThreshold: new FakeBN(state.threshold || 100000000) }),
        },
      }),
    },
  };
  const connection = {
    getLatestBlockhash: async () => ({ blockhash: 'BLOCKHASH', lastValidBlockHeight: 123 }),
    sendRawTransaction: async (raw) => { calls.sent = raw; return 'SIG'.repeat(30); },
    getSignatureStatuses: async () => ({ value: [state.sigStatus || null] }),
  };
  return { deps: { sdk, web3, connection, BN: FakeBN }, calls };
}

function memStore() {
  const m = new Map();
  return {
    m,
    get: async (k) => (m.has(k) ? JSON.parse(m.get(k)) : null),
    setJSON: async (k, v) => { m.set(k, JSON.stringify(v)); },
  };
}

const ENV = { PROGRAM_CLUSTER: 'devnet', GOAL_TREASURY_ADDRESS: randAddr(), URL: 'https://selaaa.netlify.app' };
const ev = (method, body, query) => ({ httpMethod: method, body: body ? JSON.stringify(body) : null, queryStringParameters: query || {} });
const rejects = async (p, status) => {
  await assert.rejects(p, (e) => e instanceof C.HttpError && (status === undefined || e.status === status));
};

function poolOf(creator, cfg, mint, reserve, migrated) {
  return {
    creator: new FakePk(creator), config: new FakePk(cfg), baseMint: new FakePk(mint),
    quoteReserve: new FakeBN(reserve), isMigrated: migrated ? 1 : 0,
  };
}

// ---------- common ----------
test('address validation', () => {
  assert.ok(C.isValidAddress(C.DBC_PROGRAM_ID));
  assert.ok(!C.isValidAddress('short'));
  assert.ok(!C.isValidAddress('0'.repeat(44))); // 0 is not in base58
  assert.ok(!C.isValidAddress(null));
});

test('usdc conversion is exact', () => {
  assert.strictEqual(C.usdcToBaseUnits('0.1'), '100000');
  assert.strictEqual(C.usdcToBaseUnits(1), '1000000');
  assert.strictEqual(C.usdcToBaseUnits('12.345678'), '12345678');
  assert.throws(() => C.usdcToBaseUnits('0'), C.HttpError);
  assert.throws(() => C.usdcToBaseUnits('1.1234567'), C.HttpError);
  assert.throws(() => C.usdcToBaseUnits('-5'), C.HttpError);
});

test('treasury fails closed when unset or unresolved', () => {
  assert.throws(() => C.getTreasuryAddress({}), (e) => e.status === 503);
  assert.throws(() => C.getTreasuryAddress({ GOAL_TREASURY_ADDRESS: 'CANNOT_RESOLVE_UNTIL_DEPLOY__x' }), (e) => e.status === 503);
  assert.throws(() => C.getTreasuryAddress({ GOAL_TREASURY_ADDRESS: 'not-an-address' }), (e) => e.status === 500);
});

test('cluster comes from PROGRAM_CLUSTER and defaults to devnet', () => {
  assert.strictEqual(C.getCluster({}).name, 'devnet');
  assert.strictEqual(C.getCluster({ PROGRAM_CLUSTER: 'mainnet-beta' }).quoteMint, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
  assert.throws(() => C.getCluster({ PROGRAM_CLUSTER: 'testnet' }), C.HttpError);
});

// ---------- create ----------
test('create encodes the settled decisions and returns an unsigned tx', async () => {
  const { deps, calls } = makeDeps({});
  const creator = randAddr();
  const out = await create.run(ev('POST', { goalId: 'g1', creator, goalAmountUsdc: 100, name: 'Family Trip', symbol: 'trip' }), ENV, { deps, store: memStore() });
  const ci = calls.curveInput;
  assert.strictEqual(ci.migrationQuoteThreshold, 100);
  assert.strictEqual(ci.migration.migrationOption, 1); // DAMM v2
  assert.strictEqual(ci.fee.baseFeeParams.feeSchedulerParam.startingFeeBps, 100);
  assert.strictEqual(ci.fee.baseFeeParams.feeSchedulerParam.endingFeeBps, 100);
  assert.strictEqual(ci.fee.dynamicFeeEnabled, false);
  assert.strictEqual(ci.fee.collectFeeMode, 0);
  assert.strictEqual(ci.fee.poolCreationFee, 0);
  assert.strictEqual(ci.liquidityDistribution.creatorPermanentLockedLiquidityPercentage, 100);
  assert.strictEqual(ci.liquidityDistribution.partnerLiquidityPercentage, 0);
  assert.strictEqual(calls.createArgs.quoteMint.toBase58(), C.CLUSTERS.devnet.quoteMint);
  assert.strictEqual(calls.createArgs.feeClaimer.toBase58(), ENV.GOAL_TREASURY_ADDRESS);
  assert.strictEqual(calls.createArgs.leftoverReceiver.toBase58(), ENV.GOAL_TREASURY_ADDRESS);
  assert.strictEqual(calls.createArgs.preCreatePoolParam.poolCreator.toBase58(), creator);
  assert.strictEqual(calls.createArgs.payer.toBase58(), creator);
  assert.strictEqual(calls.partialSigners.length, 2); // config and mint keypairs only
  assert.deepStrictEqual(calls.serializeOpts, { requireAllSignatures: false, verifySignatures: false });
  assert.strictEqual(out.symbol, 'TRIP');
  assert.ok(out.txBase64 && out.poolAddress && out.mintAddress && out.configAddress);
  assert.ok(!JSON.stringify(out).toLowerCase().includes('secret'));
});

test('create refuses without a resolved treasury, on an existing goal, and on bad input', async () => {
  const { deps } = makeDeps({});
  const creator = randAddr();
  const good = { goalId: 'g1', creator, goalAmountUsdc: 100, name: 'Trip', symbol: 'TRIP' };
  await rejects(create.run(ev('POST', good), { PROGRAM_CLUSTER: 'devnet' }, { deps, store: memStore() }), 503);
  const store = memStore();
  await store.setJSON('devnet:g1', { goalId: 'g1' });
  await rejects(create.run(ev('POST', good), ENV, { deps, store }), 409);
  await rejects(create.run(ev('POST', Object.assign({}, good, { symbol: 'x' })), ENV, { deps, store: memStore() }), 400);
  await rejects(create.run(ev('POST', Object.assign({}, good, { goalAmountUsdc: 1 })), ENV, { deps, store: memStore() }), 400);
  await rejects(create.run(ev('POST', Object.assign({}, good, { creator: 'nope' })), ENV, { deps, store: memStore() }), 400);
  await rejects(create.run(ev('GET'), ENV, { deps, store: memStore() }), 405);
});

test('create on mainnet uses mainnet USDC', async () => {
  const { deps, calls } = makeDeps({});
  await create.run(ev('POST', { goalId: 'g2', creator: randAddr(), goalAmountUsdc: 500, name: 'A', symbol: 'AB' }), Object.assign({}, ENV, { PROGRAM_CLUSTER: 'mainnet-beta' }), { deps, store: memStore() });
  assert.strictEqual(calls.createArgs.quoteMint.toBase58(), C.CLUSTERS['mainnet-beta'].quoteMint);
  assert.strictEqual(calls.curveInput.migrationQuoteThreshold, 500); // goal amount itself in production
});

// ---------- registry ----------
test('registry verifies on chain data, is first write wins', async () => {
  const creator = randAddr(), cfg = randAddr(), mint = randAddr(), pool = randAddr();
  const state = { pool: poolOf(creator, cfg, mint, 0) };
  const { deps } = makeDeps(state);
  const store = memStore();
  const body = { goalId: 'g1', creator, poolAddress: pool, mintAddress: mint, configAddress: cfg, name: 'Trip', symbol: 'TRIP', goalAmountUsdc: 100, signature: 'x' };
  const rec = await registryFn.run(ev('POST', body), ENV, { deps, store });
  assert.strictEqual(rec.poolAddress, pool);
  await rejects(registryFn.run(ev('POST', body), ENV, { deps, store }), 409); // duplicate
  const got = await registryFn.run(ev('GET', null, { goalId: 'g1' }), ENV, { deps, store });
  assert.strictEqual(got.mintAddress, mint);
  await rejects(registryFn.run(ev('GET', null, { goalId: 'nope' }), ENV, { deps, store }), 404);
  // mismatch
  await rejects(registryFn.run(ev('POST', Object.assign({}, body, { goalId: 'g3', creator: randAddr() })), ENV, { deps, store }), 400);
  // pool not on chain yet
  const { deps: d2 } = makeDeps({});
  await rejects(registryFn.run(ev('POST', Object.assign({}, body, { goalId: 'g4' })), ENV, { deps: d2, store }), 409);
});

// ---------- status ----------
async function seeded(reserve, migrated, threshold) {
  const creator = randAddr(), cfg = randAddr(), mint = randAddr(), pool = randAddr();
  const state = { pool: poolOf(creator, cfg, mint, reserve, migrated), threshold };
  const store = memStore();
  await store.setJSON('devnet:g1', { goalId: 'g1', poolAddress: pool, mintAddress: mint, name: 'Trip', symbol: 'TRIP' });
  return { state, store, ...makeDeps(state) };
}

test('status reports progress and graduation', async () => {
  let s = await seeded(25000000, false, 100000000);
  let out = await status.run(ev('GET', null, { goalId: 'g1' }), ENV, s);
  assert.strictEqual(out.progressPct, 25);
  assert.strictEqual(out.raisedUsdc, '25');
  assert.strictEqual(out.targetUsdc, '100');
  assert.strictEqual(out.remainingUsdc, '75');
  assert.strictEqual(out.thresholdReached, false);
  assert.strictEqual(out.migrated, false);
  s = await seeded(100000000, false, 100000000);
  out = await status.run(ev('GET', null, { goalId: 'g1' }), ENV, s);
  assert.strictEqual(out.thresholdReached, true);
  assert.strictEqual(out.migrated, false);
  s = await seeded(100000000, true, 100000000);
  out = await status.run(ev('GET', null, { goalId: 'g1' }), ENV, s);
  assert.strictEqual(out.migrated, true);
  out = await status.run(ev('GET', null, { goalId: 'unknown' }), ENV, s);
  assert.strictEqual(out.registered, false);
});

// ---------- buy ----------
test('buy quotes and builds an unsigned swap', async () => {
  const s = await seeded(10000000, false, 100000000);
  const buyer = randAddr();
  const q = await buy.run(ev('POST', { action: 'quote', goalId: 'g1', buyer, amountUsdc: '10' }), ENV, s);
  assert.strictEqual(q.expectedTokenUnits, '5000000');
  assert.strictEqual(q.amountInUnits, '10000000');
  const b = await buy.run(ev('POST', { action: 'build', goalId: 'g1', buyer, amountUsdc: '10', slippageBps: 50 }), ENV, s);
  assert.ok(b.txBase64);
  assert.strictEqual(s.calls.swapArgs.swapBaseForQuote, false); // buying with USDC
  assert.strictEqual(s.calls.swapArgs.owner.toBase58(), buyer);
  assert.strictEqual(s.calls.swapArgs.minimumAmountOut.toString(), '4950000');
  assert.strictEqual(s.calls.swapArgs.referralTokenAccount, null);
});

test('buy refuses graduated pools, reached goals, oversize buys and bad slippage', async () => {
  const buyer = randAddr();
  const base = { action: 'quote', goalId: 'g1', buyer, amountUsdc: '10' };
  await rejects(buy.run(ev('POST', base), ENV, await seeded(100000000, true, 100000000)), 409);
  await rejects(buy.run(ev('POST', base), ENV, await seeded(100000000, false, 100000000)), 409);
  await rejects(buy.run(ev('POST', Object.assign({}, base, { amountUsdc: '500' })), ENV, await seeded(0, false, 100000000)), 400);
  await rejects(buy.run(ev('POST', Object.assign({}, base, { slippageBps: 9999 })), ENV, await seeded(0, false, 100000000)), 400);
  await rejects(buy.run(ev('POST', Object.assign({}, base, { goalId: 'missing' })), ENV, await seeded(0, false, 100000000)), 404);
});

// ---------- send ----------
test('send relays allowed transactions and refuses foreign programs', async () => {
  const st = {};
  const { deps, calls } = makeDeps(st);
  const okBody = { action: 'send', signedTxBase64: Buffer.from('x').toString('base64') };
  const out = await send.run(ev('POST', okBody), ENV, { deps });
  assert.ok(out.signature);
  assert.ok(calls.sent);
  st.txPrograms = [randAddr()];
  await rejects(send.run(ev('POST', okBody), ENV, { deps }), 400);
  await rejects(send.run(ev('POST', { action: 'send' }), ENV, { deps }), 400);
  st.sigStatus = { confirmationStatus: 'finalized', err: null };
  const s = await send.run(ev('POST', { action: 'status', signature: 'S'.repeat(88) }), ENV, { deps });
  assert.strictEqual(s.state, 'finalized');
});
