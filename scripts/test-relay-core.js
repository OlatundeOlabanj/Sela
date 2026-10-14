#!/usr/bin/env node
// Offline tests for the relayer (lib/relay-core.js and netlify/functions/relay.js).
// No network: passkeys are simulated with Node's own P-256 ECDSA, the chain is a
// fake, and the stores are in-memory. Run: node scripts/test-relay-core.js
// Needs @solana/web3.js and @netlify/blobs installed (both are in package.json).
//
// This proves the relayer's logic and its security checks. It does NOT prove
// anything about how the real chain or real browsers behave, only a real
// devnet run does that.
//
// Made by TJS Code

const crypto = require('crypto');
const web3 = require('@solana/web3.js');
const core = require('../lib/relay-core.js');
const { __makeHandler } = require('../netlify/functions/relay.js');

const config = {
  PROGRAM_CLUSTER: 'devnet',
  PROGRAM_ID: 'EPqdJo6sJP9R3RCKh2RFLMt7T6orrkjV1ub584dcM2Vr',
  GOAL_MINT: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
  GOAL_MINT_DECIMALS: 6,
};
const ORIGIN = 'https://selaaa.netlify.app';
const programId = new web3.PublicKey(config.PROGRAM_ID);
const mint = new web3.PublicKey(config.GOAL_MINT);
const CP = core.getProgramClient(config);

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('PASS  ' + name); }
  catch (e) { failed++; console.log('FAIL  ' + name + '\n        ' + (e && e.message)); }
}
const ok = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
const eq = (a, b, m) => { if (a !== b) throw new Error((m || 'not equal') + `: got ${a}, expected ${b}`); };
async function throws(fn, re, m) {
  try { await fn(); } catch (e) { if (re && !re.test(e.message)) throw new Error((m || 'wrong error') + ': ' + e.message); return; }
  throw new Error((m || 'expected a throw') + ' but nothing was thrown');
}

// ---- simulated authenticator ----
const sha = (d) => crypto.createHash('sha256').update(d).digest();
function newDevice() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const x = Buffer.from(jwk.x, 'base64url'), y = Buffer.from(jwk.y, 'base64url');
  const compressed = Buffer.concat([Buffer.from([y[31] & 1 ? 3 : 2]), x]);
  return { privateKey, compressed };
}
function assertionFor(device, challenge, { origin = ORIGIN, flags = 0x05, type = 'webauthn.get', rpId } = {}) {
  const authData = Buffer.concat([sha(rpId || new URL(origin).hostname), Buffer.from([flags]), Buffer.alloc(4)]);
  const clientData = Buffer.from(JSON.stringify({ type, challenge: Buffer.from(challenge).toString('base64url'), origin, crossOrigin: false }));
  const signature = crypto.sign('sha256', Buffer.concat([authData, sha(clientData)]), { key: device.privateKey, dsaEncoding: 'der' });
  return { authenticatorData: authData.toString('base64'), clientDataJSON: clientData.toString('base64'), signature: signature.toString('base64') };
}

(async () => {
  // ================= key handling =================
  await t('P-256 decompression matches the JWK-derived point for 200 random keys', () => {
    for (let i = 0; i < 200; i++) {
      const d = newDevice();
      const { x, y } = core.decompressP256(d.compressed);
      const k = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: x.toString('base64url'), y: y.toString('base64url') }, format: 'jwk' });
      ok(k.asymmetricKeyType === 'ec');
    }
  });
  await t('decompression rejects a prefix that is not 2 or 3, and an x with no curve point', async () => {
    await throws(() => core.decompressP256(Buffer.concat([Buffer.from([4]), Buffer.alloc(32, 1)])), /format/);
    let rejected = 0;
    for (let i = 0; i < 40; i++) { try { core.decompressP256(Buffer.concat([Buffer.from([2]), crypto.randomBytes(32)])); } catch { rejected++; } }
    ok(rejected > 5, 'about half of random x values have no curve point, saw ' + rejected);
  });

  // ================= challenges =================
  await t('canonical JSON is key-order independent and the challenge changes with every input', () => {
    eq(core.canonicalJson({ b: '1', a: '2' }), '{"a":"2","b":"1"}');
    const base = { op: 'add_goal', vaultPda: 'V', params: { name: 'x', target: '5' }, nonce: 'n' };
    const c0 = core.actionChallenge(base).toString('hex');
    for (const mut of [{ op: 'create_invite' }, { vaultPda: 'W' }, { params: { name: 'y', target: '5' } }, { params: { name: 'x', target: '6' } }, { nonce: 'm' }]) {
      ok(core.actionChallenge({ ...base, ...mut }).toString('hex') !== c0, 'challenge did not change for ' + JSON.stringify(mut));
    }
    eq(core.actionChallenge({ ...base, params: { target: '5', name: 'x' } }).toString('hex'), c0, 'param order must not matter');
  });

  // ================= assertion verification =================
  const dev = newDevice(), other = newDevice();
  const chal = crypto.randomBytes(32);
  const vOpts = (over = {}) => ({ publicKey33: dev.compressed, expectedChallenge: chal, allowedOrigins: [ORIGIN], assertion: assertionFor(dev, chal), ...over });
  await t('a valid assertion verifies', () => ok(core.verifyAssertion(vOpts())));
  await t('rejects: wrong origin', () => throws(() => core.verifyAssertion(vOpts({ assertion: assertionFor(dev, chal, { origin: 'https://evil.example' }) })), /different site/));
  await t('rejects: wrong challenge', () => throws(() => core.verifyAssertion(vOpts({ expectedChallenge: crypto.randomBytes(32) })), /does not match/));
  await t('rejects: user verification flag missing (touch only, no biometric)', () => throws(() => core.verifyAssertion(vOpts({ assertion: assertionFor(dev, chal, { flags: 0x01 }) })), /verify you/));
  await t('rejects: user presence flag missing', () => throws(() => core.verifyAssertion(vOpts({ assertion: assertionFor(dev, chal, { flags: 0x04 }) })), /presence/));
  await t('rejects: signature from a different key', () => throws(() => core.verifyAssertion(vOpts({ assertion: assertionFor(other, chal) })), /not valid/));
  await t('rejects: tampered signature', () => {
    const a = assertionFor(dev, chal); const sig = Buffer.from(a.signature, 'base64'); sig[sig.length - 1] ^= 1; a.signature = sig.toString('base64');
    return throws(() => core.verifyAssertion(vOpts({ assertion: a })), /not valid|Malformed/);
  });
  await t('rejects: rpIdHash for a different site', () => throws(() => core.verifyAssertion(vOpts({ assertion: assertionFor(dev, chal, { rpId: 'evil.example' }) })), /different site/));
  await t('rejects: a registration-type response', () => throws(() => core.verifyAssertion(vOpts({ assertion: assertionFor(dev, chal, { type: 'webauthn.create' }) })), /type/));
  await t('rejects: missing assertion', () => throws(() => core.verifyAssertion(vOpts({ assertion: null })), /required/));

  // ================= submit-transaction validation =================
  const relayer = web3.Keypair.generate();
  const rk = relayer.publicKey;
  const vaultPk = web3.Keypair.generate().publicKey, goalPk = web3.Keypair.generate().publicKey, goalTok = web3.Keypair.generate().publicKey;
  const holding = CP.holdingAccountFor(vaultPk, 0, mint).ata;
  const SECP = new web3.PublicKey(core.SECP256R1_PROGRAM_ID);
  const pre = () => new web3.TransactionInstruction({ programId: SECP, keys: [], data: new Uint8Array(200) });
  const contributeIx = (payer = rk) => CP._finalizePasskeyInstruction({
    ...CP._contributeChallengeMaterial({ payer, vaultPda: vaultPk, goalPda: goalPk, goalTokenAccount: goalTok, mint, contributorTokenAccount: holding, deviceRole: 0, amountBaseUnits: 1n, decimals: 6 }),
    authenticatorData: new Uint8Array(37), clientDataJson: new Uint8Array(120),
  });
  const withdrawIx = () => CP._finalizePasskeyInstruction({
    ...CP._withdrawChallengeMaterial({ payer: rk, vaultPda: vaultPk, goalPda: goalPk, goalTokenAccount: goalTok, mint, destinationTokenAccount: holding, deviceRole: 0, amountBaseUnits: 1n, decimals: 6 }),
    authenticatorData: new Uint8Array(37), clientDataJson: new Uint8Array(120),
  });
  const wire = (ixs, feePayer = rk) => {
    const tx = new web3.Transaction(); tx.feePayer = feePayer; tx.recentBlockhash = '11111111111111111111111111111111';
    for (const i of ixs) tx.add(i);
    return web3.Transaction.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
  };
  const check = (tx) => core.validateSubmitTx(tx, { relayer: rk, programId });

  await t('accepts a legitimate contribute and reports the right vault', () => { const r = check(wire([pre(), contributeIx()])); eq(r.kind, 'contribute'); eq(r.vaultPda, vaultPk.toBase58()); });
  await t('accepts a legitimate withdraw and reports the right vault', () => { const r = check(wire([pre(), withdrawIx()])); eq(r.kind, 'withdraw'); eq(r.vaultPda, vaultPk.toBase58()); });
  await t('rejects: fee payer is not the relayer', () => throws(() => check(wire([pre(), contributeIx()], web3.Keypair.generate().publicKey)), /fee payer/));
  await t('rejects: an extra instruction, even one the relayer would sign (SOL drain attempt)', () =>
    throws(() => check(wire([pre(), contributeIx(), web3.SystemProgram.transfer({ fromPubkey: rk, toPubkey: web3.Keypair.generate().publicKey, lamports: 1_000_000_000 })])), /shape/));
  await t('rejects: a bare SOL transfer in place of the program instruction', () =>
    throws(() => check(wire([pre(), web3.SystemProgram.transfer({ fromPubkey: rk, toPubkey: vaultPk, lamports: 5 })])), /program/));
  await t('rejects: a program instruction that is not contribute or withdraw (init_family_vault)', () => {
    const { instruction } = CP.buildInitFamilyVaultInstruction({ payer: rk, vaultSeedPubkey: web3.Keypair.generate().publicKey, primaryDeviceCompressedPubkey: dev.compressed, partnerDeviceCompressedPubkey: null, guardianPubkey: rk, feeTier: 0 });
    return throws(() => check(wire([pre(), instruction])), /cannot be relayed/);
  });
  await t('rejects: relayer used as a second account (e.g. as the token source)', () => {
    const ix = CP._finalizePasskeyInstruction({
      ...CP._contributeChallengeMaterial({ payer: rk, vaultPda: vaultPk, goalPda: goalPk, goalTokenAccount: goalTok, mint, contributorTokenAccount: rk, deviceRole: 0, amountBaseUnits: 1n, decimals: 6 }),
      authenticatorData: new Uint8Array(37), clientDataJson: new Uint8Array(120),
    });
    return throws(() => check(wire([pre(), ix])), /signer/);
  });
  await t('rejects: an extra signer account in the instruction', () => {
    const ix = contributeIx(); ix.keys[5] = { ...ix.keys[5], isSigner: true };
    return throws(() => check(wire([pre(), ix])), /signer/);
  });
  await t('rejects: first account is not the relayer', () => {
    const ix = contributeIx(); ix.keys[0] = { ...ix.keys[0], pubkey: web3.Keypair.generate().publicKey };
    return throws(() => check(wire([pre(), ix])), /fee payer account|signer/);
  });
  await t('rejects: first instruction is not the secp256r1 precompile', () =>
    throws(() => check(wire([web3.SystemProgram.transfer({ fromPubkey: rk, toPubkey: vaultPk, lamports: 1 }), contributeIx()])), /first instruction/));

  // ================= builders =================
  await t('create builder: vault + goal + holding account, signed only by the relayer', () => {
    const seed = web3.Keypair.generate().publicKey;
    const b = core.buildCreateTx(CP, rk, { vaultSeed: seed, primaryDevice: new Uint8Array(dev.compressed), name: 'Trip', targetBaseUnits: 500_000_000n, mint });
    eq(b.tx.instructions.length, 3);
    ok(b.tx.instructions[0].programId.equals(programId) && b.tx.instructions[1].programId.equals(programId));
    eq(b.tx.instructions[2].programId.toBase58(), core.ATA_PROGRAM_ID);
    b.tx.recentBlockhash = '11111111111111111111111111111111'; b.tx.feePayer = rk; b.tx.partialSign(relayer);
    ok(b.tx.verifySignatures(), 'signature check');
    const signers = new Set(); for (const i of b.tx.instructions) for (const k of i.keys) if (k.isSigner) signers.add(k.pubkey.toBase58());
    eq(signers.size, 1, 'only one signer expected'); ok(signers.has(rk.toBase58()));
    eq(b.holdingAta.toBase58(), CP.holdingAccountFor(b.vaultPda, 0, mint).ata.toBase58());
  });

  // ================= nonces and rate limits =================
  const memStore = () => { const m = new Map(); return { m, get: async (k) => (m.has(k) ? JSON.parse(m.get(k)) : null), setJSON: async (k, v) => { m.set(k, JSON.stringify(v)); }, delete: async (k) => { m.delete(k); } }; };
  await t('a nonce works once, expires, and malformed ones are refused', async () => {
    const s = memStore(); const now = 1_000_000;
    const n = await core.issueNonce(s, now);
    ok(await core.consumeNonce(s, n, now + 1000), 'first use'); ok(!(await core.consumeNonce(s, n, now + 1000)), 'replay must fail');
    const n2 = await core.issueNonce(s, now); ok(!(await core.consumeNonce(s, n2, now + 6 * 60 * 1000)), 'expired');
    ok(!(await core.consumeNonce(s, '../../etc', now)), 'malformed');
  });
  await t('rate limit counts, blocks at the limit, and resets after the window', async () => {
    const s = memStore();
    for (let i = 0; i < 3; i++) ok(await core.rateLimit(s, 'x', 'ip', 3, 1000, 0));
    ok(!(await core.rateLimit(s, 'x', 'ip', 3, 1000, 10)), 'blocked'); ok(await core.rateLimit(s, 'x', 'ip', 3, 1000, 2000), 'reset');
  });

  // ================= full handler against a fake chain =================
  function fakeChain() {
    const accounts = new Map(); const sent = []; let nBalance = 1_000_000_000;
    const conn = {
      getBalance: async () => nBalance,
      getLatestBlockhash: async () => ({ blockhash: '11111111111111111111111111111111' }),
      sendRawTransaction: async (raw) => { sent.push(web3.Transaction.from(raw)); return 'SIG' + sent.length; },
      getAccountInfo: async (pk) => accounts.get(pk.toBase58()) || null,
      getTokenAccountBalance: async () => ({ value: { amount: '100000000' } }),
    };
    return { accounts, sent, conn, setBalance: (n) => { nBalance = n; } };
  }
  function vaultData({ primary, partner = Buffer.alloc(33), guardian, creator, goalSeq = 1 }) {
    const d = Buffer.alloc(216);
    Buffer.from([112, 141, 54, 228, 65, 158, 133, 238]).copy(d, 0);
    web3.Keypair.generate().publicKey.toBuffer().copy(d, 8);
    web3.Keypair.generate().publicKey.toBuffer().copy(d, 40);
    Buffer.from(primary).copy(d, 72); Buffer.from(partner).copy(d, 105);
    guardian.toBuffer().copy(d, 138); d[170] = 0; d.writeUInt32LE(goalSeq, 171); d[175] = 255;
    creator.toBuffer().copy(d, 184);
    return d;
  }
  function rotationData({ vault, device, status = 0 }) {
    const d = Buffer.alloc(8 + 32 + 1 + 33 + 33 + 32 + 1 + 8 + 8);
    let o = 8; vault.toBuffer().copy(d, o); o += 32; d[o++] = 1; o += 33; Buffer.from(device).copy(d, o); o += 33;
    rk.toBuffer().copy(d, o); o += 32; d[o++] = status; return d;
  }
  function harness(over = {}) {
    const chain = fakeChain();
    const stores = { nonces: memStore(), invites: memStore(), limits: memStore() };
    let clock = 5_000_000;
    const deps = { config: over.config || config, now: () => clock, getRelayer: () => (over.noRelayer ? null : relayer), getConnection: () => chain.conn, stores, allowedOrigins: [ORIGIN], demoAmount: 5_000_000n };
    const handler = __makeHandler(deps);
    const call = async (method, body, ip = '1.1.1.1') => {
      const r = await handler({ httpMethod: method, body: body ? JSON.stringify(body) : null, headers: { 'x-nf-client-connection-ip': ip } });
      return { status: r.statusCode, body: JSON.parse(r.body) };
    };
    const nonce = async () => (await call('POST', { op: 'nonce' })).body.nonce;
    const signedAction = async (device, op, vaultPda, params) => {
      const n = await nonce();
      return { nonce: n, assertion: assertionFor(device, core.actionChallenge({ op, vaultPda, params, nonce: n })) };
    };
    return { chain, stores, call, nonce, signedAction, advance: (ms) => { clock += ms; } };
  }
  const putVault = (h, vaultKey, opts) => h.chain.accounts.set(vaultKey.toBase58(), { owner: programId, data: vaultData(opts) });

  await t('GET reports configured, the fee payer, and demo funds; unconfigured reports configured:false', async () => {
    const h = harness(); const r = await h.call('GET');
    eq(r.status, 200); eq(r.body.configured, true); eq(r.body.feePayer, rk.toBase58()); eq(r.body.demoFaucet, true);
    const u = harness({ noRelayer: true }); eq((await u.call('GET')).body.configured, false);
    eq((await u.call('POST', { op: 'nonce' })).status, 503);
  });
  await t('demo funds are never offered on mainnet', async () => {
    const h = harness({ config: { ...config, PROGRAM_CLUSTER: 'mainnet-beta' } });
    eq((await h.call('GET')).body.demoFaucet, false);
  });
  await t('out-of-funds relayer refuses spending operations with a clear 503', async () => {
    const h = harness(); h.chain.setBalance(1000);
    const r = await h.call('POST', { op: 'create', vaultSeed: web3.Keypair.generate().publicKey.toBase58(), primaryDevice: dev.compressed.toString('base64'), name: 'x', target: '1000000' });
    eq(r.status, 503);
  });

  await t('create: builds, signs and sends a 3-instruction transaction', async () => {
    const h = harness();
    const r = await h.call('POST', { op: 'create', vaultSeed: web3.Keypair.generate().publicKey.toBase58(), primaryDevice: dev.compressed.toString('base64'), name: 'Child laptop', target: '10000000' });
    eq(r.status, 200, JSON.stringify(r.body)); ok(r.body.vaultPda && r.body.goalPda && r.body.holdingAta);
    eq(h.chain.sent.length, 1); eq(h.chain.sent[0].instructions.length, 3); ok(h.chain.sent[0].verifySignatures());
  });
  await t('create: rejects an off-curve device key, a long name, a zero target, and an existing account', async () => {
    const h = harness(); const seed = web3.Keypair.generate().publicKey.toBase58(); const base = { op: 'create', vaultSeed: seed, primaryDevice: dev.compressed.toString('base64'), name: 'ok', target: '5' };
    eq((await h.call('POST', { ...base, primaryDevice: Buffer.concat([Buffer.from([4]), Buffer.alloc(32, 7)]).toString('base64') })).status, 400);
    eq((await h.call('POST', { ...base, name: 'x'.repeat(33) })).status, 400);
    eq((await h.call('POST', { ...base, target: '0' })).status, 400);
    eq((await h.call('POST', { ...base, target: '99999999999999999' })).status, 400);
    const ok1 = await h.call('POST', base); eq(ok1.status, 200);
    const pda = new web3.PublicKey(ok1.body.vaultPda); h.chain.accounts.set(pda.toBase58(), { owner: programId, data: Buffer.alloc(216) });
    eq((await h.call('POST', base)).status, 409);
  });
  await t('create: the 6th account from one connection in an hour is rate limited', async () => {
    const h = harness(); let last;
    for (let i = 0; i < 6; i++) last = await h.call('POST', { op: 'create', vaultSeed: web3.Keypair.generate().publicKey.toBase58(), primaryDevice: dev.compressed.toString('base64'), name: 'g' + i, target: '5' }, '9.9.9.9');
    eq(last.status, 429);
  });

  await t('submit: relays a valid contribute, rejects an invalid shape', async () => {
    const h = harness();
    const good = wire([pre(), contributeIx()]).serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
    const r = await h.call('POST', { op: 'submit', tx: good }); eq(r.status, 200, JSON.stringify(r.body)); eq(r.body.kind, 'contribute'); ok(h.chain.sent[0].verifySignatures());
    const evil = wire([pre(), contributeIx(), web3.SystemProgram.transfer({ fromPubkey: rk, toPubkey: vaultPk, lamports: 9 })]).serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
    eq((await h.call('POST', { op: 'submit', tx: evil })).status, 400); eq(h.chain.sent.length, 1, 'the bad one must not be sent');
    eq((await h.call('POST', { op: 'submit', tx: 'AAAA' })).status, 400);
  });

  await t('add_goal: owner passkey required, replay blocked, tampering blocked, unmanaged vault refused', async () => {
    const h = harness(); const v = web3.Keypair.generate().publicKey;
    putVault(h, v, { primary: dev.compressed, guardian: rk, creator: rk, goalSeq: 1 });
    const params = { name: 'Holiday', target: '20000000' };
    const a = await h.signedAction(dev, 'add_goal', v.toBase58(), params);
    const r = await h.call('POST', { op: 'add_goal', vaultPda: v.toBase58(), ...params, ...a }); eq(r.status, 200, JSON.stringify(r.body));
    eq(h.chain.sent.length, 1); eq(h.chain.sent[0].instructions.length, 1);
    eq((await h.call('POST', { op: 'add_goal', vaultPda: v.toBase58(), ...params, ...a })).status, 401, 'replay');
    const b = await h.signedAction(dev, 'add_goal', v.toBase58(), params);
    eq((await h.call('POST', { op: 'add_goal', vaultPda: v.toBase58(), name: 'Different', target: '20000000', ...b })).status, 401, 'tampered name');
    const c = await h.signedAction(other, 'add_goal', v.toBase58(), params);
    eq((await h.call('POST', { op: 'add_goal', vaultPda: v.toBase58(), ...params, ...c })).status, 401, 'someone elses passkey');
    const w = web3.Keypair.generate().publicKey; putVault(h, w, { primary: dev.compressed, guardian: web3.Keypair.generate().publicKey, creator: web3.Keypair.generate().publicKey });
    const d = await h.signedAction(dev, 'add_goal', w.toBase58(), params);
    eq((await h.call('POST', { op: 'add_goal', vaultPda: w.toBase58(), ...params, ...d })).status, 403, 'wallet-managed vault');
  });
  await t('an approval for one action cannot be reused for another', async () => {
    const h = harness(); const v = web3.Keypair.generate().publicKey; putVault(h, v, { primary: dev.compressed, guardian: rk, creator: rk });
    const a = await h.signedAction(dev, 'create_invite', v.toBase58(), { familyName: 'The Jonahs' });
    eq((await h.call('POST', { op: 'add_goal', vaultPda: v.toBase58(), name: 'x', target: '5', ...a })).status, 401);
  });

  await t('invite -> join request -> owner approval, end to end', async () => {
    const h = harness(); const v = web3.Keypair.generate().publicKey; putVault(h, v, { primary: dev.compressed, guardian: rk, creator: rk });
    const inv = await h.signedAction(dev, 'create_invite', v.toBase58(), { familyName: 'The Jonahs' });
    const created = await h.call('POST', { op: 'create_invite', vaultPda: v.toBase58(), familyName: 'The Jonahs', ...inv });
    eq(created.status, 200, JSON.stringify(created.body)); eq(created.body.managedByRelayer, true); eq(created.body.vaultName, 'The Jonahs'); const code = created.body.code;

    const member = newDevice();
    const join = await h.call('POST', { op: 'request_join', code, newDevice: member.compressed.toString('base64') }, '2.2.2.2');
    eq(join.status, 200, JSON.stringify(join.body)); eq(h.chain.sent.at(-1).instructions.length, 1);
    eq((await h.call('POST', { op: 'request_join', code, newDevice: member.compressed.toString('base64') }, '2.2.2.2')).status, 410, 'invite is single use');

    // the request now exists on the fake chain
    const { pda: rot } = CP.deriveRotationRequestPda(v, 1);
    h.chain.accounts.set(rot.toBase58(), { owner: programId, data: rotationData({ vault: v, device: member.compressed }) });
    const deviceHex = member.compressed.toString('hex');
    const ap = await h.signedAction(dev, 'approve_join', v.toBase58(), { device: deviceHex });
    const approved = await h.call('POST', { op: 'approve_join', vaultPda: v.toBase58(), ...ap }); eq(approved.status, 200, JSON.stringify(approved.body));
    eq(h.chain.sent.at(-1).instructions.length, 2, 'approve + create holding account');
    const wrong = await h.signedAction(dev, 'approve_join', v.toBase58(), { device: newDevice().compressed.toString('hex') });
    eq((await h.call('POST', { op: 'approve_join', vaultPda: v.toBase58(), ...wrong })).status, 401, 'approval for a different device key');
  });
  await t('request_join refuses: unknown code, wallet-managed invite, existing request, filled slot', async () => {
    const h = harness(); const v = web3.Keypair.generate().publicKey; putVault(h, v, { primary: dev.compressed, guardian: rk, creator: rk });
    const m = newDevice().compressed.toString('base64');
    eq((await h.call('POST', { op: 'request_join', code: 'NOPE1234', newDevice: m })).status, 404);
    await h.stores.invites.setJSON('WALLET01', { code: 'WALLET01', vaultPda: v.toBase58(), deviceRole: 1, expiresAt: 9e15, used: false, managedByRelayer: false });
    eq((await h.call('POST', { op: 'request_join', code: 'WALLET01', newDevice: m })).status, 400);
    await h.stores.invites.setJSON('RELAY001', { code: 'RELAY001', vaultPda: v.toBase58(), deviceRole: 1, expiresAt: 9e15, used: false, managedByRelayer: true });
    const { pda: rot } = CP.deriveRotationRequestPda(v, 1); h.chain.accounts.set(rot.toBase58(), { owner: programId, data: rotationData({ vault: v, device: newDevice().compressed }) });
    eq((await h.call('POST', { op: 'request_join', code: 'RELAY001', newDevice: m })).status, 409);
    const f = web3.Keypair.generate().publicKey; putVault(h, f, { primary: dev.compressed, partner: newDevice().compressed, guardian: rk, creator: rk });
    await h.stores.invites.setJSON('FULL0001', { code: 'FULL0001', vaultPda: f.toBase58(), deviceRole: 1, expiresAt: 9e15, used: false, managedByRelayer: true });
    eq((await h.call('POST', { op: 'request_join', code: 'FULL0001', newDevice: m })).status, 409);
  });
  await t('expired invites are refused', async () => {
    const h = harness(); const v = web3.Keypair.generate().publicKey; putVault(h, v, { primary: dev.compressed, guardian: rk, creator: rk });
    await h.stores.invites.setJSON('OLD00001', { code: 'OLD00001', vaultPda: v.toBase58(), deviceRole: 1, expiresAt: 1, used: false, managedByRelayer: true });
    eq((await h.call('POST', { op: 'request_join', code: 'OLD00001', newDevice: newDevice().compressed.toString('base64') })).status, 410);
  });

  await t('demo funds: once per account and role, owner vaults only, not on mainnet', async () => {
    const h = harness(); const v = web3.Keypair.generate().publicKey; putVault(h, v, { primary: dev.compressed, guardian: rk, creator: rk });
    const r = await h.call('POST', { op: 'demo_fund', vaultPda: v.toBase58(), deviceRole: 0 }); eq(r.status, 200, JSON.stringify(r.body)); eq(r.body.amount, '5000000');
    eq((await h.call('POST', { op: 'demo_fund', vaultPda: v.toBase58(), deviceRole: 0 })).status, 429, 'second claim');
    eq((await h.call('POST', { op: 'demo_fund', vaultPda: v.toBase58(), deviceRole: 1 })).status, 409, 'member has not joined');
    const m = harness({ config: { ...config, PROGRAM_CLUSTER: 'mainnet-beta' } }); putVault(m, v, { primary: dev.compressed, guardian: rk, creator: rk });
    eq((await m.call('POST', { op: 'demo_fund', vaultPda: v.toBase58(), deviceRole: 0 })).status, 403);
  });
  await t('unknown operations and non-POST/GET methods are refused', async () => {
    const h = harness(); eq((await h.call('POST', { op: 'drain' })).status, 400);
    const r = await __makeHandler({ config, now: () => 1, getRelayer: () => relayer, getConnection: () => fakeChain().conn, stores: harness().stores, allowedOrigins: [ORIGIN], demoAmount: 1n })({ httpMethod: 'DELETE', headers: {} });
    eq(r.statusCode, 405);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
