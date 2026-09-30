// netlify/functions/run-allowances.js
//
// Finds every RecurringContributionDelegate PDA that is due
// (status == Active, next_run_at <= now) and submits
// execute_recurring_contribution for each one. This is the
// "allowance" flow: a parent authorizes a recurring schedule once
// (authorize_recurring_delegate, passkey-gated, happens client-side),
// and from then on this keeper is what actually triggers each
// period's transfer, no further passkey interaction needed, the
// on-chain delegate PDA is the authority, not this function's caller.
//
// Trigger this on a schedule (Netlify scheduled functions, or an
// external cron hitting this URL) rather than per-request. Safe to
// call more often than needed, a delegate that isn't due yet is
// silently skipped, and a delegate that's already Paused/Cancelled is
// filtered out before a transaction is ever attempted.
//
// Needs KEEPER_KEYPAIR_JSON (a JSON array secret key, the same format
// solana-keygen writes) as a Netlify environment variable. This
// keypair only ever pays the tx fee and calls a keeper-safe
// instruction, see instructions/execute_recurring_contribution.rs for
// why a compromised keeper key still can't move funds anywhere but
// the pre-authorized destination.
//
// Made by TJS Code

const { Connection, PublicKey, Keypair, Transaction, TransactionInstruction } = require('@solana/web3.js');
const { getRpcUrl } = require('../../lib/rpcClient');
const SELA_CONFIG = require('../../sela-config.js');

// Cluster and program ID come from sela-config.js, the same file the
// browser reads. The program runs on PROGRAM_CLUSTER (devnet until it
// is deployed to mainnet), so the keeper must talk to that cluster and
// not to the mainnet RPC provider used for payments.
const PROGRAM_CLUSTER = SELA_CONFIG.PROGRAM_CLUSTER;
const IS_MAINNET = PROGRAM_CLUSTER === 'mainnet-beta';
const PROGRAM_ID = new PublicKey(SELA_CONFIG.PROGRAM_ID);
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const JITO_BUNDLES_URL = 'https://mainnet.block-engine.jito.wtf/api/v1/bundles';

// Anchor account discriminator: sha256("account:RecurringContributionDelegate")[0..8]
const DELEGATE_ACCOUNT_DISCRIMINATOR = Buffer.from([153, 189, 225, 219, 200, 123, 201, 10]);
// Anchor ix discriminator: sha256("global:execute_recurring_contribution")[0..8]
const EXECUTE_IX_DISCRIMINATOR = Buffer.from([151, 222, 238, 179, 96, 158, 148, 58]);

const ScheduleStatus = { 0: 'Active', 1: 'Paused', 2: 'Cancelled' };
const GoalStatus = { 0: 'Active', 1: 'Completed', 2: 'Withdrawn' };

function findPda(seeds) {
  const [pda] = PublicKey.findProgramAddressSync(seeds, PROGRAM_ID);
  return pda;
}

function getAta(owner, mint) {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return ata;
}

/**
 * Decodes one RecurringContributionDelegate account, layout copied
 * from state.rs: goal(32) vault(32) authorized_by_role(1)
 * source_token_account(32) amount_per_period(8, u64 LE)
 * frequency(1) next_run_at(8, i64 LE) status(1) bump(1)
 * created_at(8, i64 LE), all after the 8-byte account discriminator.
 */
function decodeDelegate(pubkey, data) {
  let o = 8; // skip discriminator
  const goal = new PublicKey(data.subarray(o, o + 32)); o += 32;
  const vault = new PublicKey(data.subarray(o, o + 32)); o += 32;
  o += 1; // authorized_by_role, not needed here
  const sourceTokenAccount = new PublicKey(data.subarray(o, o + 32)); o += 32;
  const amountPerPeriod = data.readBigUInt64LE(o); o += 8;
  o += 1; // frequency, not needed for this pass
  const nextRunAt = data.readBigInt64LE(o); o += 8;
  const status = ScheduleStatus[data.readUInt8(o)] || 'Unknown'; o += 1;
  return { pubkey, goal, vault, sourceTokenAccount, amountPerPeriod, nextRunAt, status };
}

/**
 * Decodes just enough of a SavingsGoal to get goal_token_account,
 * mint and status. Layout copied from state.rs, after the 8-byte
 * discriminator: vault(32) goal_seq(4) name(32) target_amount(8)
 * current_amount(8) currency(1) deadline(8) status(1) mint(32)
 * goal_token_account(32) bump(1) created_at(8).
 */
function decodeGoalMintAndTokenAccount(data) {
  const STATUS_OFFSET = 8 + 32 + 4 + 32 + 8 + 8 + 1 + 8; // 101
  const status = GoalStatus[data.readUInt8(STATUS_OFFSET)] || 'Unknown';
  const mint = new PublicKey(data.subarray(STATUS_OFFSET + 1, STATUS_OFFSET + 33));
  const goalTokenAccount = new PublicKey(data.subarray(STATUS_OFFSET + 33, STATUS_OFFSET + 65));
  return { mint, goalTokenAccount, status };
}

function buildExecuteInstruction({ keeper, vault, goal, delegate, goalTokenAccount, treasury, feeDestination, sourceTokenAccount, mint, feeConfig, decimals }) {
  const data = Buffer.concat([EXECUTE_IX_DISCRIMINATOR, Buffer.from([decimals])]);
  const keys = [
    { pubkey: keeper, isSigner: true, isWritable: true },
    { pubkey: feeConfig, isSigner: false, isWritable: false },
    { pubkey: vault, isSigner: false, isWritable: false },
    { pubkey: goal, isSigner: false, isWritable: true },
    { pubkey: delegate, isSigner: false, isWritable: true },
    { pubkey: goalTokenAccount, isSigner: false, isWritable: true },
    { pubkey: treasury, isSigner: false, isWritable: false },
    { pubkey: feeDestination, isSigner: false, isWritable: true },
    { pubkey: sourceTokenAccount, isSigner: false, isWritable: true },
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
  ];
  return new TransactionInstruction({ programId: PROGRAM_ID, keys, data });
}

async function submitDualSend(connection, signedTx) {
  const raw = signedTx.serialize();
  const base64 = raw.toString('base64');
  // Jito only exists on mainnet, skip it on any other cluster.
  const jito = !IS_MAINNET ? Promise.resolve({ error: { message: 'skipped, Jito is mainnet only' } }) : fetch(JITO_BUNDLES_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendBundle', params: [[base64], { encoding: 'base64' }] }),
    signal: AbortSignal.timeout(10000),
  }).then((r) => r.json());
  const rpc = connection.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 3 });
  const [jitoResult, rpcResult] = await Promise.allSettled([jito, rpc]);
  return {
    jitoOk: jitoResult.status === 'fulfilled' && !jitoResult.value?.error,
    rpcOk: rpcResult.status === 'fulfilled',
    rpcSignature: rpcResult.status === 'fulfilled' ? rpcResult.value : null,
    rpcError: rpcResult.status === 'rejected' ? rpcResult.reason?.message : null,
    jitoError: jitoResult.status === 'rejected' ? jitoResult.reason?.message : jitoResult.value?.error?.message,
  };
}

exports.handler = async () => {
  const headers = { 'Content-Type': 'application/json' };

  let keeper;
  try {
    const raw = process.env.KEEPER_KEYPAIR_JSON;
    if (!raw) throw new Error('KEEPER_KEYPAIR_JSON not set');
    keeper = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Keeper misconfigured: ' + err.message }) };
  }

  let rpcUrl;
  try {
    // PROGRAM_RPC_URL (optional env var) overrides. Otherwise mainnet
    // uses the shared provider-agnostic RPC, anything else uses the
    // public endpoint for that cluster.
    rpcUrl = process.env.PROGRAM_RPC_URL
      || (IS_MAINNET ? getRpcUrl() : 'https://api.' + PROGRAM_CLUSTER + '.solana.com');
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'RPC misconfigured: ' + err.message }) };
  }
  const connection = new Connection(rpcUrl, 'confirmed');

  const feeConfig = findPda([Buffer.from('fee_config')]);
  const treasury = findPda([Buffer.from('treasury')]);

  const accounts = await connection.getProgramAccounts(PROGRAM_ID, {
    filters: [{ memcmp: { offset: 0, bytes: DELEGATE_ACCOUNT_DISCRIMINATOR.toString('base64'), encoding: 'base64' } }],
  });

  const now = BigInt(Math.floor(Date.now() / 1000));
  const results = [];

  for (const { pubkey, account } of accounts) {
    const delegate = decodeDelegate(pubkey, account.data);
    if (delegate.status !== 'Active' || delegate.nextRunAt > now) continue;

    try {
      const goalAccountInfo = await connection.getAccountInfo(delegate.goal);
      if (!goalAccountInfo) throw new Error('Goal account not found');
      const { mint, goalTokenAccount, status: goalStatus } = decodeGoalMintAndTokenAccount(goalAccountInfo.data);
      if (goalStatus !== 'Active') {
        results.push({ delegate: delegate.pubkey.toBase58(), skipped: true, reason: `goal status is ${goalStatus}` });
        continue;
      }

      const feeDestination = getAta(treasury, mint);

      // USDC and any other SPL mint used here is 6 decimals in every
      // flow this codebase currently supports (see payment-transfer.js
      // PAYMENT_CONFIG.usdcDecimals). Hardcoded rather than fetched
      // per-call to keep this loop cheap; revisit if a non-6-decimal
      // mint is ever supported.
      const decimals = 6;

      const ix = buildExecuteInstruction({
        keeper: keeper.publicKey,
        vault: delegate.vault,
        goal: delegate.goal,
        delegate: delegate.pubkey,
        goalTokenAccount,
        treasury,
        feeDestination,
        sourceTokenAccount: delegate.sourceTokenAccount,
        mint,
        feeConfig,
        decimals,
      });

      const { blockhash } = await connection.getLatestBlockhash('confirmed');
      const tx = new Transaction({ recentBlockhash: blockhash, feePayer: keeper.publicKey }).add(ix);
      tx.sign(keeper);

      const submission = await submitDualSend(connection, tx);
      results.push({
        delegate: delegate.pubkey.toBase58(),
        goal: delegate.goal.toBase58(),
        amountPerPeriod: delegate.amountPerPeriod.toString(),
        submitted: submission.jitoOk || submission.rpcOk,
        jitoOk: submission.jitoOk,
        rpcOk: submission.rpcOk,
        signature: submission.rpcSignature || null,
        error: !submission.jitoOk && !submission.rpcOk ? `jito: ${submission.jitoError}; rpc: ${submission.rpcError}` : null,
      });
    } catch (err) {
      results.push({ delegate: delegate.pubkey.toBase58(), submitted: false, error: err.message });
    }
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ checked: accounts.length, due: results.length, results }),
  };
};
