'use strict';
/**
 * Relayer core. Everything security-relevant about the fee-paying
 * relayer lives here as plain functions so it can be tested without a
 * network, netlify/functions/relay.js is a thin wrapper around this.
 *
 * What the relayer is, plainly:
 *  - a funded key that pays transaction fees, so a user with only a
 *    passkey never needs a wallet. contribute/withdraw are authorized
 *    on-chain by the passkey signature, the fee payer has no
 *    privilege (see contribute.rs), so relaying those costs no trust.
 *  - for vaults it creates, the vault's creator AND guardian. Those
 *    roles need an ed25519 signer, and a passkey-only user has none.
 *    That means the relayer can approve a device-key replacement on
 *    those vaults, which is the guardian's job in this program, and
 *    which is also the one real custody trade-off of passkey-only
 *    accounts. It is why every guardian-signed action here requires a
 *    fresh passkey assertion from the vault's owner device, verified
 *    server-side, before the relayer will sign anything.
 */

const crypto = require('crypto');
const web3 = require('@solana/web3.js');

const SECP256R1_PROGRAM_ID = 'Secp256r1SigVerify1111111111111111111111111';
const ATA_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

// Anchor discriminators, sha256("global:<name>")[0..8], same values as program-client.js
const DISC = {
  contribute: '82,33,68,131,32,0,205,95',
  withdraw: '183,18,70,156,148,109,161,34',
};
const FAMILY_VAULT_DISCRIMINATOR = [112, 141, 54, 228, 65, 158, 133, 238];
const FAMILY_VAULT_SIZE = 216;
const KEY_ROTATION_DISCRIMINATOR_NOTE = 'decoded via program-client decodeKeyRotationRequest';

const MAX_TARGET_BASE_UNITS = 1000000n * 1000000n; // 1,000,000 USDC at 6 decimals
const NONCE_TTL_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Program client: the browser file, loaded with a shim so the instruction
// encoders and PDA seeds exist in exactly one place.
// ---------------------------------------------------------------------------
let _cp = null;
function getProgramClient(config) {
  if (_cp) return _cp;
  if (!global.window) global.window = {};
  global.window.SELA_CONFIG = config;
  global.window.solanaWeb3 = web3;
  require('../program-client.js');
  _cp = global.window.CognataProgram;
  return _cp;
}

// ---------------------------------------------------------------------------
// P-256 public key handling
// ---------------------------------------------------------------------------
const P = 0xFFFFFFFF00000001000000000000000000000000FFFFFFFFFFFFFFFFFFFFFFFFn;
const B = 0x5AC635D8AA3A93E7B3EBBD55769886BC651D06B0CC53B0F63BCE3C3E27D2604Bn;

function modPow(base, exp, mod) {
  let result = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}

function bufToBig(buf) { return BigInt('0x' + Buffer.from(buf).toString('hex')); }
function bigToBuf32(n) { return Buffer.from(n.toString(16).padStart(64, '0'), 'hex'); }

/** SEC1 compressed point (33 bytes) to affine x,y. Throws if not on the curve. */
function decompressP256(compressed) {
  const c = Buffer.from(compressed);
  if (c.length !== 33 || (c[0] !== 2 && c[0] !== 3)) throw new Error('Invalid device key format.');
  const x = bufToBig(c.subarray(1));
  if (x >= P) throw new Error('Invalid device key.');
  const rhs = (((x * x * x - 3n * x + B) % P) + P) % P;
  let y = modPow(rhs, (P + 1n) / 4n, P); // P is 3 mod 4, so this is the square root
  if ((y * y) % P !== rhs) throw new Error('Device key is not a point on the P-256 curve.');
  if ((y & 1n) !== BigInt(c[0] & 1)) y = P - y;
  return { x: bigToBuf32(x), y: bigToBuf32(y) };
}

function publicKeyFromCompressed(compressed) {
  const { x, y } = decompressP256(compressed);
  return crypto.createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: x.toString('base64url'), y: y.toString('base64url') },
    format: 'jwk',
  });
}

// ---------------------------------------------------------------------------
// Action challenges and WebAuthn assertion verification
// ---------------------------------------------------------------------------

function canonicalJson(obj) {
  const out = {};
  for (const k of Object.keys(obj || {}).sort()) out[k] = obj[k];
  return JSON.stringify(out);
}

/**
 * The challenge a passkey must sign to authorize one specific relayer
 * action. Binds the operation, the vault, the exact parameters and a
 * single-use server nonce, so a signature for one request can never be
 * replayed for another. relay-client.js builds the identical string
 * (scripts/test-relay-core.js checks the two stay byte-identical).
 * All param values must be strings.
 */
function actionChallenge({ op, vaultPda, params, nonce }) {
  return crypto.createHash('sha256')
    .update(`sela-relay-v1|${op}|${vaultPda}|${canonicalJson(params)}|${nonce}`)
    .digest();
}

function sha256(data) { return crypto.createHash('sha256').update(data).digest(); }

/**
 * Verifies a WebAuthn assertion against a device's compressed P-256 key.
 * Checks type, origin, challenge, rpIdHash, user presence AND user
 * verification (biometric or screen lock, not just a touch), then the
 * signature over authenticatorData || sha256(clientDataJSON).
 * Throws a user-readable Error on any failure.
 */
function verifyAssertion({ publicKey33, expectedChallenge, allowedOrigins, assertion }) {
  if (!assertion) throw new Error('Passkey approval is required.');
  const authData = Buffer.from(String(assertion.authenticatorData || ''), 'base64');
  const clientDataRaw = Buffer.from(String(assertion.clientDataJSON || ''), 'base64');
  const signature = Buffer.from(String(assertion.signature || ''), 'base64');

  let cd;
  try { cd = JSON.parse(clientDataRaw.toString('utf8')); } catch { throw new Error('Malformed passkey response.'); }
  if (cd.type !== 'webauthn.get') throw new Error('Wrong passkey response type.');
  if (!allowedOrigins.includes(cd.origin)) throw new Error('This passkey response came from a different site.');
  if (cd.challenge !== Buffer.from(expectedChallenge).toString('base64url')) {
    throw new Error('Passkey response does not match this request.');
  }
  if (authData.length < 37) throw new Error('Malformed passkey data.');
  const rpId = new URL(cd.origin).hostname;
  if (!authData.subarray(0, 32).equals(sha256(rpId))) throw new Error('Passkey was made for a different site.');
  const flags = authData[32];
  if ((flags & 0x01) === 0) throw new Error('Passkey did not confirm user presence.');
  if ((flags & 0x04) === 0) throw new Error('Passkey did not verify you (fingerprint, Face ID or screen lock).');

  const key = publicKeyFromCompressed(publicKey33);
  const signed = Buffer.concat([authData, sha256(clientDataRaw)]);
  if (!crypto.verify('sha256', signed, { key, dsaEncoding: 'der' }, signature)) {
    throw new Error('Passkey signature is not valid for this account.');
  }
  return true;
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

function parsePubkey(value, what) {
  try { return new web3.PublicKey(String(value)); } catch { throw new Error(`Invalid ${what}.`); }
}

function parseDevice(b64) {
  const buf = Buffer.from(String(b64 || ''), 'base64');
  if (buf.length !== 33) throw new Error('Invalid device key.');
  decompressP256(buf); // proves it is a real point on the curve
  return new Uint8Array(buf);
}

function parseName(value) {
  const name = String(value || '').trim();
  if (!name || Buffer.byteLength(name, 'utf8') > 32) throw new Error('Goal name must be 1 to 32 characters.');
  return name;
}

function parseAmount(value, max = MAX_TARGET_BASE_UNITS) {
  if (!/^[0-9]{1,15}$/.test(String(value))) throw new Error('Invalid amount.');
  const n = BigInt(value);
  if (n <= 0n || n > max) throw new Error('Amount is out of range.');
  return n;
}

// ---------------------------------------------------------------------------
// Submit-transaction validation (contribute / withdraw only)
// ---------------------------------------------------------------------------

/**
 * A relayable transaction is exactly: [secp256r1 precompile, one
 * contribute-or-withdraw instruction], fee payer = the relayer, and the
 * relayer appears in that instruction only as its fee-paying `payer`
 * (first account). Anything else is refused, so nobody can use the
 * relayer's signature to move its own SOL or sign for something else.
 */
function validateSubmitTx(tx, { relayer, programId }) {
  if (!tx.feePayer || !tx.feePayer.equals(relayer)) throw new Error('Wrong fee payer.');
  if (tx.instructions.length !== 2) throw new Error('Unexpected transaction shape.');
  const [pre, biz] = tx.instructions;

  if (pre.programId.toBase58() !== SECP256R1_PROGRAM_ID) throw new Error('Unexpected first instruction.');
  if (pre.keys.length !== 0 || pre.data.length > 512) throw new Error('Unexpected passkey instruction.');

  if (!biz.programId.equals(programId)) throw new Error('Unexpected program.');
  const disc = Array.from(biz.data.subarray(0, 8)).join(',');
  if (disc !== DISC.contribute && disc !== DISC.withdraw) throw new Error('That instruction cannot be relayed.');
  if (biz.data.length > 1100) throw new Error('Instruction data too large.');

  const first = biz.keys[0];
  if (!first || !first.pubkey.equals(relayer) || !first.isSigner) throw new Error('Relayer must be the fee payer account.');
  const relayerRefs = biz.keys.filter((k) => k.pubkey.equals(relayer)).length;
  const signers = biz.keys.filter((k) => k.isSigner);
  if (relayerRefs !== 1 || signers.length !== 1) throw new Error('Unexpected signer in transaction.');

  const kind = disc === DISC.contribute ? 'contribute' : 'withdraw';
  // account order, from contribute.rs / withdraw.rs: vault is 4th for contribute, 3rd for withdraw
  const vaultKey = kind === 'contribute' ? biz.keys[3] : biz.keys[2];
  if (!vaultKey) throw new Error('Malformed instruction accounts.');
  return { kind, vaultPda: vaultKey.pubkey.toBase58() };
}

// ---------------------------------------------------------------------------
// Vault reads
// ---------------------------------------------------------------------------

/** Returns the decoded vault, or null if the account is missing or isn't a Sela vault. */
async function readVault(conn, CP, programId, vaultPda) {
  const info = await conn.getAccountInfo(new web3.PublicKey(vaultPda));
  if (!info || !info.owner.equals(programId)) return null;
  const d = info.data;
  if (d.length !== FAMILY_VAULT_SIZE) return null;
  if (!FAMILY_VAULT_DISCRIMINATOR.every((b, i) => d[i] === b)) return null;
  return CP.decodeFamilyVault(new Uint8Array(d));
}

function isRelayerManaged(vault, relayer) {
  return !!vault && vault.guardian.equals(relayer) && vault.creator.equals(relayer);
}

function isZero(bytes) { return Array.from(bytes).every((b) => b === 0); }

// ---------------------------------------------------------------------------
// Transaction builders (unsigned, the caller sets blockhash and signs)
// ---------------------------------------------------------------------------

function buildCreateTx(CP, relayer, { vaultSeed, primaryDevice, name, targetBaseUnits, mint }) {
  const { instruction: vaultIx, vaultPda } = CP.buildInitFamilyVaultInstruction({
    payer: relayer, vaultSeedPubkey: vaultSeed,
    primaryDeviceCompressedPubkey: primaryDevice, partnerDeviceCompressedPubkey: null,
    guardianPubkey: relayer, feeTier: 0,
  });
  const { instruction: goalIx, goalPda, goalTokenAccount } = CP.buildInitSavingsGoalInstruction({
    payer: relayer, vaultPda, goalSeq: 0, mint, name,
    targetAmountBaseUnits: targetBaseUnits, currency: 1, deadlineUnixSeconds: 0,
  });
  const { instruction: holdingIx, ata } = CP.buildCreateHoldingAccountInstruction({ payer: relayer, vaultPda, deviceRole: 0, mint });
  const tx = new web3.Transaction().add(vaultIx).add(goalIx).add(holdingIx);
  return { tx, vaultPda, goalPda, goalTokenAccount, holdingAta: ata };
}

function buildAddGoalTx(CP, relayer, { vaultPda, goalSeq, name, targetBaseUnits, mint }) {
  const { instruction, goalPda, goalTokenAccount } = CP.buildInitSavingsGoalInstruction({
    payer: relayer, vaultPda, goalSeq, mint, name, targetAmountBaseUnits: targetBaseUnits, currency: 1, deadlineUnixSeconds: 0,
  });
  return { tx: new web3.Transaction().add(instruction), goalPda, goalTokenAccount };
}

function buildRequestJoinTx(CP, relayer, { vaultPda, newDevice }) {
  const { instruction } = CP.buildRequestKeyRotationInstruction({ payer: relayer, vaultPda, deviceRole: 1, newDeviceCompressedPubkey: newDevice });
  return { tx: new web3.Transaction().add(instruction) };
}

function buildApproveJoinTx(CP, relayer, { vaultPda, mint }) {
  const approve = CP.buildApproveKeyRotationInstruction({ guardian: relayer, vaultPda, deviceRole: 1 });
  const { instruction: holdingIx, ata } = CP.buildCreateHoldingAccountInstruction({ payer: relayer, vaultPda, deviceRole: 1, mint });
  return { tx: new web3.Transaction().add(approve).add(holdingIx), holdingAta: ata };
}

/** Devnet demo funds: a plain SPL TransferChecked from the relayer's own token account. */
function buildDemoFundTx(CP, relayer, { vaultPda, deviceRole, mint, amount, decimals }) {
  const { ata: dest } = CP.holdingAccountFor(vaultPda, deviceRole, mint);
  const source = CP.getAssociatedTokenAddress(relayer, mint);
  const data = Buffer.alloc(10);
  data[0] = 12; // TransferChecked
  data.writeBigUInt64LE(amount, 1);
  data[9] = decimals;
  const ix = new web3.TransactionInstruction({
    programId: new web3.PublicKey(TOKEN_PROGRAM_ID),
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: new web3.PublicKey(mint), isSigner: false, isWritable: false },
      { pubkey: dest, isSigner: false, isWritable: true },
      { pubkey: relayer, isSigner: true, isWritable: false },
    ],
    data,
  });
  return { tx: new web3.Transaction().add(ix), source, dest };
}

// ---------------------------------------------------------------------------
// Nonces and rate limiting (any store with get/setJSON/delete, Netlify Blobs in production)
// ---------------------------------------------------------------------------

async function issueNonce(store, now = Date.now()) {
  const nonce = crypto.randomBytes(16).toString('base64url');
  await store.setJSON('n-' + nonce, { expiresAt: now + NONCE_TTL_MS });
  return nonce;
}

/** Single use: the nonce is deleted whether or not the request that follows succeeds. */
async function consumeNonce(store, nonce, now = Date.now()) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(String(nonce || ''))) return false;
  const rec = await store.get('n-' + nonce, { type: 'json' });
  if (!rec) return false;
  await store.delete('n-' + nonce);
  return rec.expiresAt >= now;
}

/** Fixed-window counter. Returns false once `limit` is reached inside the window. */
async function rateLimit(store, scope, id, limit, windowMs, now = Date.now()) {
  const key = ('rl-' + scope + '-' + id).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120);
  const rec = (await store.get(key, { type: 'json' })) || { count: 0, windowStart: now };
  if (now - rec.windowStart > windowMs) { rec.count = 0; rec.windowStart = now; }
  if (rec.count >= limit) return false;
  rec.count += 1;
  await store.setJSON(key, rec);
  return true;
}

module.exports = {
  SECP256R1_PROGRAM_ID, ATA_PROGRAM_ID, TOKEN_PROGRAM_ID, DISC, MAX_TARGET_BASE_UNITS,
  getProgramClient, decompressP256, publicKeyFromCompressed,
  canonicalJson, actionChallenge, verifyAssertion,
  parsePubkey, parseDevice, parseName, parseAmount,
  validateSubmitTx, readVault, isRelayerManaged, isZero,
  buildCreateTx, buildAddGoalTx, buildRequestJoinTx, buildApproveJoinTx, buildDemoFundTx,
  issueNonce, consumeNonce, rateLimit,
};
