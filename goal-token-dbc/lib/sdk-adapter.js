'use strict';
// The only file that touches the Meteora DBC SDK. Every SDK call in the app goes through
// here, so a version change means editing this file and nothing else.
//
// STATUS: written from the public SDK docs, NOT run against the real package. The sandbox
// that produced this file has no npm access. Calls marked UNVERIFIED must be confirmed on a
// machine with the SDK installed (see RUNBOOK.md, "App integration check").
//
// Dependencies are injected (deps.sdk, deps.web3, deps.connection) so the builders can be
// tested offline against mocks. In production, loadDeps() requires the real packages.
//
// Required packages and the pin to use: the same SDK version the devnet POC ran on.
//   @meteora-ag/dynamic-bonding-curve-sdk  (pin exactly, no caret)
//   @solana/web3.js  @solana/spl-token  bn.js  @netlify/blobs

const { HttpError, DBC_PROGRAM_ID } = require('./common');

function loadDeps(cluster) {
  const sdk = require('@meteora-ag/dynamic-bonding-curve-sdk');
  const web3 = require('@solana/web3.js');
  const connection = new web3.Connection(cluster.rpcUrl, 'confirmed');
  return { sdk, web3, connection, BN: require('bn.js') };
}

function makeClient(deps) {
  const C = deps.sdk.DynamicBondingCurveClient;
  // Docs show both `new Client(connection, commitment)` and `Client.create(...)`.
  return typeof C.create === 'function' ? C.create(deps.connection, 'confirmed') : new C(deps.connection, 'confirmed');
}

async function finalizeUnsigned(deps, tx, feePayer, extraSigners) {
  const { blockhash, lastValidBlockHeight } = await deps.connection.getLatestBlockhash('confirmed');
  tx.feePayer = new deps.web3.PublicKey(feePayer);
  tx.recentBlockhash = blockhash;
  if (extraSigners && extraSigners.length) tx.partialSign.apply(tx, extraSigners);
  const bytes = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
  return {
    txBase64: Buffer.from(bytes).toString('base64'),
    blockhash,
    lastValidBlockHeight,
  };
}

// Creates a config and a pool in one transaction (UNVERIFIED: createConfigAndPool and the
// preCreatePoolParam field name come from the docs, not from a run).
// The config account and the base mint are fresh keypairs generated here. Their secret keys
// sign the transaction server side and are discarded. No user key is ever held.
// The user's wallet is payer and poolCreator and signs last.
async function buildCreateGoalTx(deps, input) {
  const { creator, name, symbol, uri, quoteMint, feeClaimer, curveInput } = input;
  const configKp = deps.web3.Keypair.generate();
  const mintKp = deps.web3.Keypair.generate();
  const client = makeClient(deps);

  const curveConfig = deps.sdk.buildCurve(curveInput);
  const tx = await client.pool.createConfigAndPool(
    Object.assign({}, curveConfig, {
      payer: new deps.web3.PublicKey(creator),
      config: configKp.publicKey,
      feeClaimer: new deps.web3.PublicKey(feeClaimer),
      leftoverReceiver: new deps.web3.PublicKey(curveInput.leftoverReceiver),
      quoteMint: new deps.web3.PublicKey(quoteMint),
      preCreatePoolParam: {
        baseMint: mintKp.publicKey,
        name,
        symbol,
        uri,
        poolCreator: new deps.web3.PublicKey(creator),
      },
    })
  );

  const out = await finalizeUnsigned(deps, tx, creator, [configKp, mintKp]);
  const poolAddress = deps.sdk.deriveDbcPoolAddress(
    new deps.web3.PublicKey(quoteMint),
    mintKp.publicKey,
    configKp.publicKey
  );
  return Object.assign(out, {
    configAddress: configKp.publicKey.toBase58(),
    mintAddress: mintKp.publicKey.toBase58(),
    poolAddress: poolAddress.toBase58(),
  });
}

// Reads pool and config accounts (UNVERIFIED: state.getPool / getPoolConfig and the field
// names quoteReserve, migrationQuoteThreshold, isMigrated come from the IDL as documented).
async function getPoolSnapshot(deps, poolAddress) {
  const client = makeClient(deps);
  const pool = await client.state.getPool(new deps.web3.PublicKey(poolAddress));
  if (!pool) return null;
  const config = await client.state.getPoolConfig(pool.config);
  return {
    creator: pool.creator.toBase58(),
    configAddress: pool.config.toBase58(),
    baseMint: pool.baseMint.toBase58(),
    quoteReserve: pool.quoteReserve.toString(),
    migrationQuoteThreshold: config.migrationQuoteThreshold.toString(),
    isMigrated: Number(pool.isMigrated) === 1,
    _pool: pool,
    _config: config,
  };
}

// Quotes a buy of the goal token with USDC (UNVERIFIED: swapQuote2 vs swapQuote depends on
// the SDK release, both are handled).
async function quoteBuy(deps, snapshot, amountInUnits, slippageBps) {
  const client = makeClient(deps);
  const BN = deps.BN;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const base = {
    virtualPool: snapshot._pool,
    config: snapshot._config,
    swapBaseForQuote: false,
    amountIn: new BN(amountInUnits),
    slippageBps,
    hasReferral: false,
    currentPoint: new BN(nowSeconds), // activationType 1 is timestamp
  };
  let q;
  if (typeof client.pool.swapQuote2 === 'function') {
    q = await client.pool.swapQuote2(Object.assign({ swapMode: deps.sdk.SwapMode ? deps.sdk.SwapMode.ExactIn : 0 }, base));
  } else {
    q = await client.pool.swapQuote(base);
  }
  const out = q.outputAmount || q.amountOut || q.excludedTransferFeeAmountOut;
  const min = q.minimumAmountOut;
  if (!out || !min) throw new HttpError(502, 'Unexpected quote shape from the SDK');
  return { outputAmount: out.toString(), minimumAmountOut: min.toString() };
}

// Builds an unsigned swap transaction. The SDK is expected to add the buyer's token account
// creation itself (UNVERIFIED).
async function buildBuyTx(deps, input) {
  const client = makeClient(deps);
  const tx = await client.pool.swap({
    amountIn: new deps.BN(input.amountInUnits),
    minimumAmountOut: new deps.BN(input.minimumAmountOut),
    swapBaseForQuote: false,
    owner: new deps.web3.PublicKey(input.buyer),
    pool: new deps.web3.PublicKey(input.poolAddress),
    referralTokenAccount: null,
  });
  return finalizeUnsigned(deps, tx, input.buyer, []);
}

// Programs an unsigned transaction is allowed to call. Used by the send relay so it cannot
// be used to push arbitrary transactions through our RPC.
function allowedProgramIds(deps) {
  const ids = new Set([DBC_PROGRAM_ID]);
  const add = (v) => v && ids.add(v.toBase58 ? v.toBase58() : String(v));
  add(deps.web3.SystemProgram && deps.web3.SystemProgram.programId);
  ids.add('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'); // SPL Token
  ids.add('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'); // Associated Token
  ids.add('ComputeBudget111111111111111111111111111111');
  ids.add('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s'); // Metaplex Token Metadata
  ids.add('11111111111111111111111111111111');
  return ids;
}

module.exports = {
  loadDeps,
  buildCreateGoalTx,
  getPoolSnapshot,
  quoteBuy,
  buildBuyTx,
  allowedProgramIds,
};
