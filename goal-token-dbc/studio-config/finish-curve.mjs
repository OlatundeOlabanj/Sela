// finish-curve.mjs
//
// Closes the last gap on a Meteora DBC curve so the pool can migrate to
// DAMM v2, without guessing an amount.
//
// Why this exists: the studio's dbc-swap command uses an exact-in swap.
// Near the top of the curve an exact-in swap throws "Insufficient
// Liquidity" if it would overshoot the end of the curve, and any amount
// that fits can still land a hair short of the migration threshold.
// Reproduced offline against this exact config: with 0.417 USDC left,
// only 2 raw amounts out of 100 (0.421213 and 0.421214 USDC) both fit
// and reach the threshold. Nobody finds that by trial and error.
//
// A partial-fill swap (swap2, SwapMode.PartialFill) fills only what the
// curve can still take, stops at the migration price and leaves the rest
// of the input unspent. So you can offer more than enough and it takes
// exactly what is needed.
//
// Usage, from meteora-invent/studio (same folder as keypair.json):
//   cp <Sela repo>/goal-token-dbc/studio-config/finish-curve.mjs .
//   node finish-curve.mjs <baseMint>               quote only, sends nothing
//   node finish-curve.mjs <baseMint> --send        quote, then send the swap
//   node finish-curve.mjs <baseMint> --send --amount 1.5   offer 1.5 USDC (default 1)
//
// Env overrides: RPC_URL (default devnet), KEYPAIR (default ./keypair.json).
// Only imports packages the studio already depends on.
//
// Made by TJS Code

import { readFileSync } from 'node:fs';
import { Connection, Keypair, sendAndConfirmTransaction } from '@solana/web3.js';
import { DynamicBondingCurveClient, SwapMode, getCurrentPoint } from '@meteora-ag/dynamic-bonding-curve-sdk';

const args = process.argv.slice(2);
const baseMint = args.find((a) => !a.startsWith('--') && a.length > 30);
const send = args.includes('--send');
const amountIdx = args.indexOf('--amount');
const offerUsdc = amountIdx >= 0 ? Number(args[amountIdx + 1]) : 1;

if (!baseMint || !Number.isFinite(offerUsdc) || offerUsdc <= 0) {
  console.error('Usage: node finish-curve.mjs <baseMint> [--send] [--amount <USDC>]');
  process.exit(1);
}

const rpcUrl = process.env.RPC_URL || 'https://api.devnet.solana.com';
const keypairPath = process.env.KEYPAIR || './keypair.json';
const USDC_DECIMALS = 6; // devnet and mainnet USDC both use 6
const fmt = (bn) => (Number(bn.toString()) / 10 ** USDC_DECIMALS).toFixed(6);

const connection = new Connection(rpcUrl, 'confirmed');
const client = new DynamicBondingCurveClient(connection, 'confirmed');
const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keypairPath, 'utf8'))));

console.log('RPC:', rpcUrl);
console.log('Wallet:', wallet.publicKey.toBase58());
console.log('Base mint:', baseMint);

const pool = await client.state.getPoolByBaseMint(baseMint);
if (!pool) {
  console.error('No DBC pool found for that base mint on this cluster.');
  process.exit(1);
}
// In this SDK version the pool account wraps everything in poolState,
// including the config address.
const poolState = pool.account.poolState;
const config = await client.state.getPoolConfig(poolState.config);

const reserve = poolState.quoteReserve;
const threshold = config.migrationQuoteThreshold;
console.log(`Quote reserve ${fmt(reserve)} USDC, migration threshold ${fmt(threshold)} USDC`);

if (reserve.gte(threshold)) {
  console.log('The curve is already complete. Next step: pnpm studio dbc-migrate-to-damm-v2 --baseMint ' + baseMint);
  process.exit(0);
}
console.log(`Gap to close: ${fmt(threshold.sub(reserve))} USDC (the 1% fee comes on top of this)`);

// BN class taken from the SDK's own values, so this does not depend on how
// pnpm resolves bn.js for the studio package.
const BN = threshold.constructor;
const amountIn = new BN(Math.round(offerUsdc * 10 ** USDC_DECIMALS));
const currentPoint = await getCurrentPoint(connection, config.activationType);

const quote = client.pool.swapQuote2({
  virtualPool: pool.account,
  config,
  swapBaseForQuote: false,
  hasReferral: false,
  eligibleForFirstSwapWithMinFee: false,
  currentPoint,
  slippageBps: 500,
  swapMode: SwapMode.PartialFill,
  amountIn,
});

const spent = amountIn.sub(quote.amountLeft);
console.log(`Offering ${fmt(amountIn)} USDC, the curve will take about ${fmt(spent)} and leave ${fmt(quote.amountLeft)} unspent`);
console.log(`Reserve after this swap: about ${fmt(reserve.add(quote.excludedFeeInputAmount))} USDC`);

if (!send) {
  console.log('\nQuote only, nothing sent. Add --send to run the swap.');
  process.exit(0);
}

const tx = await client.pool.swap2({
  owner: wallet.publicKey,
  pool: pool.publicKey,
  swapBaseForQuote: false,
  referralTokenAccount: null,
  swapMode: SwapMode.PartialFill,
  amountIn,
  minimumAmountOut: quote.minimumAmountOut,
});
const signature = await sendAndConfirmTransaction(connection, tx, [wallet], { commitment: 'confirmed' });
console.log('Swap confirmed:', signature);

const after = await client.state.getPoolByBaseMint(baseMint);
const afterReserve = after.account.poolState.quoteReserve;
console.log(`Quote reserve now ${fmt(afterReserve)} USDC`);
if (afterReserve.gte(threshold)) {
  console.log('Threshold reached. Next step: pnpm studio dbc-migrate-to-damm-v2 --baseMint ' + baseMint);
} else {
  console.log('Still short of the threshold. Run this again, it will take only what is needed.');
}
