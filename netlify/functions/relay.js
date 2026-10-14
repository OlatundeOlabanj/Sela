// netlify/functions/relay.js
//
// The fee-paying relayer that lets someone use Sela with only a
// passkey, no wallet. All the security-relevant logic is in
// lib/relay-core.js (and tested by scripts/test-relay-core.js), this
// file is routing, rate limits and the actual RPC calls.
//
// Needs one Netlify environment variable:
//   RELAYER_KEYPAIR_JSON   a JSON array secret key (solana-keygen format)
//                          for a dedicated wallet funded with gas only.
//                          Never reuse a personal wallet.
// Optional:
//   RELAY_ALLOWED_ORIGINS  comma-separated origins passkeys may come
//                          from, default https://selaaa.netlify.app
//   DEMO_FAUCET_AMOUNT     devnet test-USDC base units handed out once
//                          per account, default 5000000 (5 USDC). The
//                          relayer's own token account must hold the
//                          test mint for this to work.
//   PROGRAM_RPC_URL        override the RPC for the program cluster
//
// Made by TJS Code

const web3 = require('@solana/web3.js');
const core = require('../../lib/relay-core.js');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const MIN_RELAYER_LAMPORTS = 20_000_000; // 0.02 SOL, below this the relayer reports itself out of funds
const MAX_GOALS = 12;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function newInviteCode(crypto) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(8);
  let code = '';
  for (let i = 0; i < 8; i++) code += alphabet[bytes[i] % alphabet.length];
  return code;
}

function makeHandler(deps) {
  const crypto = require('crypto');
  const { config, stores } = deps;

  const json = (status, body) => ({
    statusCode: status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  });

  function programContext() {
    const CP = core.getProgramClient(config);
    return { CP, programId: new web3.PublicKey(config.PROGRAM_ID), mint: new web3.PublicKey(config.GOAL_MINT) };
  }

  async function signAndSend(conn, relayer, tx) {
    const { blockhash } = await conn.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;
    tx.feePayer = relayer.publicKey;
    tx.partialSign(relayer);
    try {
      return await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3 });
    } catch (err) {
      throw new HttpError(502, 'The network rejected the transaction: ' + String(err.message || err).slice(0, 200));
    }
  }

  async function demoFaucetAvailable(conn, relayer, CP, mint) {
    if (config.PROGRAM_CLUSTER === 'mainnet-beta' || !(deps.demoAmount > 0n)) return false;
    try {
      const src = CP.getAssociatedTokenAddress(relayer.publicKey, mint);
      const bal = await conn.getTokenAccountBalance(src);
      return BigInt(bal.value.amount) >= deps.demoAmount;
    } catch { return false; }
  }

  async function requireVault(conn, ctx, relayer, vaultPda, { needManaged = true } = {}) {
    const pk = core.parsePubkey(vaultPda, 'vault');
    const vault = await core.readVault(conn, ctx.CP, ctx.programId, pk);
    if (!vault) throw new HttpError(404, 'Vault not found.');
    if (needManaged && !core.isRelayerManaged(vault, relayer.publicKey)) {
      throw new HttpError(403, 'This vault is managed by its own wallet, not by Sela. Use that wallet for this action.');
    }
    return { vault, pk };
  }

  /** Verifies the vault owner's passkey for one specific action, consuming the nonce. */
  async function requireOwnerPasskey({ vault, op, vaultPda, params, nonce, assertion }) {
    const ok = await core.consumeNonce(stores.nonces, nonce, deps.now());
    if (!ok) throw new HttpError(401, 'This approval expired or was already used. Please try again.');
    try {
      core.verifyAssertion({
        publicKey33: vault.primaryContributorDevice,
        expectedChallenge: core.actionChallenge({ op, vaultPda, params, nonce }),
        allowedOrigins: deps.allowedOrigins,
        assertion,
      });
    } catch (err) {
      throw new HttpError(401, err.message);
    }
  }

  async function limit(scope, id, max, windowMs, message) {
    const ok = await core.rateLimit(stores.limits, scope, id, max, windowMs, deps.now());
    if (!ok) throw new HttpError(429, message || 'Too many requests. Please wait a bit and try again.');
  }

  return async function handler(event) {
    try {
      const relayer = deps.getRelayer();
      const conn = relayer ? deps.getConnection() : null;

      if (event.httpMethod === 'GET') {
        if (!relayer) return json(200, { configured: false });
        const ctx = programContext();
        return json(200, {
          configured: true,
          feePayer: relayer.publicKey.toBase58(),
          cluster: config.PROGRAM_CLUSTER,
          demoFaucet: await demoFaucetAvailable(conn, relayer, ctx.CP, ctx.mint),
        });
      }
      if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
      if (!relayer) return json(503, { error: 'Passkey-only accounts are not enabled on this deployment yet.' });

      let body;
      try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON body' }); }
      const headers = event.headers || {};
      const ip = headers['x-nf-client-connection-ip'] || String(headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
      const ctx = programContext();
      const { CP, programId, mint } = ctx;

      if (body.op === 'nonce') {
        await limit('nonce-ip', ip, 120, HOUR);
        return json(200, { nonce: await core.issueNonce(stores.nonces, deps.now()) });
      }

      // Everything below spends the relayer's SOL.
      const balance = await conn.getBalance(relayer.publicKey);
      if (balance < MIN_RELAYER_LAMPORTS) throw new HttpError(503, 'Sela is temporarily unable to cover network fees. Please try again later.');

      switch (body.op) {
        case 'create': {
          // Loose cap on raw attempts (validation still costs an RPC read), the tight
          // cap below only counts requests that would actually spend the relayer's SOL,
          // so mistyping a few times never locks someone out of creating an account.
          await limit('create-attempt-ip', ip, 60, HOUR);
          let vaultSeed, primaryDevice, name, target;
          try {
            vaultSeed = core.parsePubkey(body.vaultSeed, 'vault seed');
            primaryDevice = core.parseDevice(body.primaryDevice);
            name = core.parseName(body.name);
            target = core.parseAmount(body.target);
          } catch (err) { throw new HttpError(400, err.message); }

          const built = core.buildCreateTx(CP, relayer.publicKey, { vaultSeed, primaryDevice, name, targetBaseUnits: target, mint });
          if (await conn.getAccountInfo(built.vaultPda)) throw new HttpError(409, 'That account already exists.');
          await limit('create-ip', ip, 5, HOUR, 'Too many new accounts from this connection. Please try again later.');
          const signature = await signAndSend(conn, relayer, built.tx);
          return json(200, {
            signature, vaultPda: built.vaultPda.toBase58(), goalPda: built.goalPda.toBase58(),
            goalTokenAccount: built.goalTokenAccount.toBase58(), holdingAta: built.holdingAta.toBase58(),
          });
        }

        case 'submit': {
          await limit('submit-ip', ip, 120, HOUR);
          if (typeof body.tx !== 'string' || body.tx.length > 3000) throw new HttpError(400, 'Invalid transaction.');
          let tx;
          try { tx = web3.Transaction.from(Buffer.from(body.tx, 'base64')); } catch { throw new HttpError(400, 'Could not read the transaction.'); }
          let checked;
          try { checked = core.validateSubmitTx(tx, { relayer: relayer.publicKey, programId }); } catch (err) { throw new HttpError(400, err.message); }
          await limit('submit-vault', checked.vaultPda, 40, HOUR, 'This account is sending too fast. Please wait a bit.');
          const signature = await signAndSend(conn, relayer, tx);
          return json(200, { signature, kind: checked.kind });
        }

        case 'add_goal': {
          await limit('add-goal-ip', ip, 30, HOUR);
          const { vault, pk } = await requireVault(conn, ctx, relayer, body.vaultPda);
          if (vault.goalSeq >= MAX_GOALS) throw new HttpError(400, `A vault can hold up to ${MAX_GOALS} goals.`);
          await requireOwnerPasskey({ vault, op: 'add_goal', vaultPda: String(body.vaultPda), params: { name: String(body.name), target: String(body.target) }, nonce: body.nonce, assertion: body.assertion });
          let name, target;
          try { name = core.parseName(body.name); target = core.parseAmount(body.target); } catch (err) { throw new HttpError(400, err.message); }
          const built = core.buildAddGoalTx(CP, relayer.publicKey, { vaultPda: pk, goalSeq: vault.goalSeq, name, targetBaseUnits: target, mint });
          const signature = await signAndSend(conn, relayer, built.tx);
          return json(200, { signature, goalPda: built.goalPda.toBase58(), goalTokenAccount: built.goalTokenAccount.toBase58() });
        }

        case 'create_invite': {
          await limit('invite-ip', ip, 20, HOUR);
          const { vault } = await requireVault(conn, ctx, relayer, body.vaultPda);
          if (!core.isZero(vault.partnerDevice)) throw new HttpError(409, 'This account already has its second member.');
          const familyName = String(body.familyName || '').trim().slice(0, 32);
          await requireOwnerPasskey({ vault, op: 'create_invite', vaultPda: String(body.vaultPda), params: { familyName }, nonce: body.nonce, assertion: body.assertion });
          await limit('invite-vault', String(body.vaultPda), 10, HOUR, 'Too many invites for this account. Please wait a bit.');
          const code = newInviteCode(crypto);
          const record = {
            code, vaultPda: String(body.vaultPda), vaultName: familyName || 'Shared goal', deviceRole: 1,
            createdBy: 'relay', createdAt: deps.now(), expiresAt: deps.now() + 7 * DAY,
            used: false, usedBy: null, usedAt: null, managedByRelayer: true,
          };
          await stores.invites.setJSON(code, record);
          return json(200, record);
        }

        case 'request_join': {
          await limit('join-ip', ip, 20, HOUR);
          const code = String(body.code || '').toUpperCase();
          const rec = await stores.invites.get(code, { type: 'json' });
          if (!rec) throw new HttpError(404, 'Invite not found.');
          if (rec.used) throw new HttpError(410, 'This invite was already used.');
          if (deps.now() > rec.expiresAt) throw new HttpError(410, 'This invite has expired.');
          if (!rec.managedByRelayer) throw new HttpError(400, 'This invite is for a wallet-managed account, join it with a wallet.');
          const { vault, pk } = await requireVault(conn, ctx, relayer, rec.vaultPda);
          if (!core.isZero(vault.partnerDevice)) throw new HttpError(409, 'This account already has its second member.');
          const { pda: rotationPda } = CP.deriveRotationRequestPda(pk, 1);
          if (await conn.getAccountInfo(rotationPda)) throw new HttpError(409, 'A join request already exists for this account.');
          let newDevice;
          try { newDevice = core.parseDevice(body.newDevice); } catch (err) { throw new HttpError(400, err.message); }
          const built = core.buildRequestJoinTx(CP, relayer.publicKey, { vaultPda: pk, newDevice });
          const signature = await signAndSend(conn, relayer, built.tx);
          rec.used = true; rec.usedBy = 'relay'; rec.usedAt = deps.now();
          await stores.invites.setJSON(code, rec);
          return json(200, { signature, vaultPda: rec.vaultPda });
        }

        case 'approve_join': {
          await limit('approve-ip', ip, 30, HOUR);
          const { vault, pk } = await requireVault(conn, ctx, relayer, body.vaultPda);
          if (!core.isZero(vault.partnerDevice)) throw new HttpError(409, 'This account already has its second member.');
          const { pda: rotationPda } = CP.deriveRotationRequestPda(pk, 1);
          const info = await conn.getAccountInfo(rotationPda);
          if (!info) throw new HttpError(404, 'There is no pending join request.');
          const req = CP.decodeKeyRotationRequest(new Uint8Array(info.data));
          if (req.status !== 'Pending' || req.deviceRole !== 1) throw new HttpError(409, 'There is no pending join request.');
          // The owner's passkey approves THIS exact device key, taken from the chain here,
          // so a different request can never ride on an old approval.
          const deviceHex = Buffer.from(req.newDevicePubkey).toString('hex');
          await requireOwnerPasskey({ vault, op: 'approve_join', vaultPda: String(body.vaultPda), params: { device: deviceHex }, nonce: body.nonce, assertion: body.assertion });
          const built = core.buildApproveJoinTx(CP, relayer.publicKey, { vaultPda: pk, mint });
          const signature = await signAndSend(conn, relayer, built.tx);
          return json(200, { signature, holdingAta: built.holdingAta.toBase58() });
        }

        case 'demo_fund': {
          if (config.PROGRAM_CLUSTER === 'mainnet-beta') throw new HttpError(403, 'Demo funds are only available on the test network.');
          await limit('demo-ip', ip, 10, DAY);
          const role = Number(body.deviceRole);
          if (role !== 0 && role !== 1) throw new HttpError(400, 'Invalid device.');
          const { vault, pk } = await requireVault(conn, ctx, relayer, body.vaultPda);
          if (role === 1 && core.isZero(vault.partnerDevice)) throw new HttpError(409, 'That member has not joined yet.');
          const first = await core.rateLimit(stores.limits, 'demo-claim', pk.toBase58() + '-' + role, 1, 365 * DAY, deps.now());
          if (!first) throw new HttpError(429, 'Demo funds were already added to this account.');
          if (!(await demoFaucetAvailable(conn, relayer, CP, mint))) throw new HttpError(503, 'Demo funds are temporarily unavailable.');
          const built = core.buildDemoFundTx(CP, relayer.publicKey, { vaultPda: pk, deviceRole: role, mint, amount: deps.demoAmount, decimals: config.GOAL_MINT_DECIMALS });
          const signature = await signAndSend(conn, relayer, built.tx);
          return json(200, { signature, amount: deps.demoAmount.toString() });
        }

        default:
          throw new HttpError(400, 'Unknown operation.');
      }
    } catch (err) {
      if (err instanceof HttpError) return json(err.status, { error: err.message });
      console.error('[relay] unexpected error:', err);
      return json(500, { error: 'Something went wrong on our side. Please try again.' });
    }
  };
}

function defaultDeps() {
  const SELA_CONFIG = require('../../sela-config.js');
  const { getRpcUrlForCluster } = require('../../lib/rpcClient');
  const { getStore } = require('@netlify/blobs');
  const blobs = (name) => {
    const siteID = process.env.NETLIFY_BLOBS_SITE_ID || process.env.SITE_ID;
    const token = process.env.NETLIFY_BLOBS_TOKEN;
    return siteID && token ? getStore({ name, siteID, token }) : getStore(name);
  };
  let relayer = null;
  let loaded = false;
  const cache = {};
  const lazy = (name) => ({
    get: (...a) => (cache[name] = cache[name] || blobs(name)).get(...a),
    setJSON: (...a) => (cache[name] = cache[name] || blobs(name)).setJSON(...a),
    delete: (...a) => (cache[name] = cache[name] || blobs(name)).delete(...a),
  });
  return {
    config: SELA_CONFIG,
    now: () => Date.now(),
    getRelayer() {
      if (!loaded) {
        loaded = true;
        const raw = process.env.RELAYER_KEYPAIR_JSON;
        if (raw) {
          try { relayer = web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw))); } catch { relayer = null; }
        }
      }
      return relayer;
    },
    getConnection() {
      return new web3.Connection(process.env.PROGRAM_RPC_URL || getRpcUrlForCluster(SELA_CONFIG.PROGRAM_CLUSTER), 'confirmed');
    },
    stores: { nonces: lazy('sela-relay-nonces'), invites: lazy('sela-invites'), limits: lazy('sela-relay-limits') },
    allowedOrigins: (process.env.RELAY_ALLOWED_ORIGINS || 'https://selaaa.netlify.app').split(',').map((s) => s.trim()).filter(Boolean),
    demoAmount: process.env.DEMO_FAUCET_AMOUNT ? BigInt(process.env.DEMO_FAUCET_AMOUNT) : 5000000n,
  };
}

exports.handler = makeHandler(defaultDeps());
exports.__makeHandler = makeHandler; // for scripts/test-relay-core.js
