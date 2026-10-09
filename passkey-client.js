/**
 * Sela passkey client.
 *
 * Drives the two-phase flow program-client.js's contribute/withdraw
 * builders expect: compute the challenge from the instruction that
 * will be sent, get a WebAuthn assertion over that exact challenge,
 * then assemble the secp256r1 precompile instruction plus the real
 * business instruction from the result. See passkey.rs for the
 * on-chain half of this protocol, this file exists to produce bytes
 * that satisfy it exactly, not a general WebAuthn library.
 *
 * Requires PublicKeyCredential.prototype.getPublicKey() to read the
 * registered device's public key (broadly supported: Chrome/Edge
 * 2022+, Firefox, Safari 16.4+). No fallback CBOR/COSE parser is
 * implemented for browsers without it, registerPasskey() throws a
 * clear error naming this instead of silently failing.
 *
 * Made by TJS Code
 */

const PasskeyClient = (() => {
  // secp256r1 curve order, needed to normalize signatures to low-S
  // (Solana's precompile requires it, WebAuthn/browser ECDSA output
  // does not guarantee it).
  const CURVE_ORDER = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551n;
  const HALF_ORDER = CURVE_ORDER / 2n;

  const SECP256R1_PROGRAM_ID = 'Secp256r1SigVerify1111111111111111111111111';
  const STORAGE_PREFIX = 'sela_passkey_credential_';

  function _web3() {
    if (typeof window.solanaWeb3 === 'undefined') throw new Error('Solana web3.js not loaded.');
    return window.solanaWeb3;
  }

  // Wallet apps (Phantom among them) open sites in an embedded WebView,
  // and embedded WebViews generally don't expose WebAuthn unless the
  // host app wires it up (iOS WKWebView needs the host app's associated
  // domains entitlement, Android System WebView needs an opt-in
  // Credential Manager bridge). Safari and Chrome do support it, so the
  // fix for a user in that situation is "open this page in your normal
  // browser", which is what these messages say.
  const BROWSER_HINT = "Passkeys aren't available in this browser. This usually happens inside a wallet app's built-in browser. Open this page in Safari or Chrome instead.";

  function checkSupport() {
    const ok = !!(window.PublicKeyCredential && navigator.credentials && typeof navigator.credentials.create === 'function');
    return ok ? { ok: true } : { ok: false, reason: BROWSER_HINT };
  }

  // NotAllowedError is what WebAuthn throws both when the user cancels
  // and when an embedded browser refuses the request outright, the two
  // are indistinguishable from here, so the message covers both.
  function _friendlyError(err) {
    if (err && err.name === 'NotAllowedError') {
      return new Error("The passkey prompt was cancelled or isn't available here. If you're inside a wallet app's built-in browser, open this page in Safari or Chrome instead.");
    }
    if (err && err.name === 'SecurityError') {
      return new Error("Passkeys can't be used on this web address. Open Sela from its normal link (" + window.location.hostname + ") in Safari or Chrome.");
    }
    return err;
  }

  function _b64urlToBytes(b64url) {
    const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(b64url.length / 4) * 4, '=');
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function _bytesToB64url(bytes) {
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  async function _sha256(bytes) {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return new Uint8Array(digest);
  }

  function _concat(arrays) {
    const total = arrays.reduce((n, a) => n + a.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const a of arrays) { out.set(a, offset); offset += a.length; }
    return out;
  }

  // ---- SPKI DER -> compressed 33-byte P-256 point ----
  // getPublicKey() returns an SPKI-wrapped DER key. For a P-256 key
  // this is a fixed-length structure: a 26-byte algorithm-identifier
  // header (constant for every id-ecPublicKey + prime256v1 key,
  // browsers do not vary this) followed by a 0x04 uncompressed-point
  // marker and the 64-byte X||Y coordinates, 91 bytes total. Verified
  // structurally below rather than assumed blind.
  function _spkiToCompressedPoint(spkiDer) {
    const bytes = new Uint8Array(spkiDer);
    if (bytes.length !== 91 || bytes[bytes.length - 65] !== 0x04) {
      throw new Error('Unexpected SPKI key format, expected a 91-byte P-256 SPKI key with an uncompressed point.');
    }
    const x = bytes.slice(bytes.length - 64, bytes.length - 32);
    const y = bytes.slice(bytes.length - 32);
    const yIsOdd = (y[y.length - 1] & 1) === 1;
    const compressed = new Uint8Array(33);
    compressed[0] = yIsOdd ? 0x03 : 0x02;
    compressed.set(x, 1);
    return compressed;
  }

  // ---- DER ECDSA signature -> raw low-S r||s (64 bytes) ----
  function _derSignatureToRawLowS(derSig) {
    const d = new Uint8Array(derSig);
    if (d[0] !== 0x30) throw new Error('Not a DER ECDSA signature.');
    let o = 2; // skip SEQUENCE tag + length
    function readInt() {
      if (d[o] !== 0x02) throw new Error('Expected DER INTEGER.');
      o++;
      let len = d[o]; o++;
      let bytes = d.slice(o, o + len); o += len;
      while (bytes.length > 1 && bytes[0] === 0x00 && (bytes[1] & 0x80) === 0) bytes = bytes.slice(1);
      return bytes;
    }
    const rBytes = readInt();
    const sBytes = readInt();
    const toBig = (b) => b.reduce((acc, byte) => (acc << 8n) | BigInt(byte), 0n);
    const r = toBig(rBytes);
    let s = toBig(sBytes);
    if (s > HALF_ORDER) s = CURVE_ORDER - s;

    const toFixed32 = (big) => {
      const out = new Uint8Array(32);
      let v = big;
      for (let i = 31; i >= 0; i--) { out[i] = Number(v & 0xffn); v >>= 8n; }
      return out;
    };
    return _concat([toFixed32(r), toFixed32(s)]);
  }

  // ---- Credential storage (which credential goes with which vault) ----
  function _storeCredentialId(vaultPdaBase58, credentialIdBytes) {
    localStorage.setItem(STORAGE_PREFIX + vaultPdaBase58, _bytesToB64url(credentialIdBytes));
  }

  function getStoredCredentialId(vaultPdaBase58) {
    const v = localStorage.getItem(STORAGE_PREFIX + vaultPdaBase58);
    return v ? _b64urlToBytes(v) : null;
  }

  /**
   * Registers a new passkey on this device. Returns the 33-byte
   * compressed P-256 public key to pass as primary_contributor_device
   * / partner_device to init_family_vault, and the credential ID to
   * store (this also happens automatically, keyed by vault, once the
   * caller knows the vault's address, see rememberCredentialForVault).
   */
  async function registerPasskey({ label }) {
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const userId = crypto.getRandomValues(new Uint8Array(16));

    const support = checkSupport();
    if (!support.ok) throw new Error(support.reason);

    let credential;
    try {
      credential = await navigator.credentials.create({
      publicKey: {
        challenge,
        rp: { name: 'Sela', id: window.location.hostname },
        user: { id: userId, name: label || 'Sela device', displayName: label || 'Sela device' },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }], // ES256 / P-256, matches secp256r1
        authenticatorSelection: { userVerification: 'required', residentKey: 'preferred' },
        timeout: 60000,
        attestation: 'none',
      },
      });
    } catch (err) {
      throw _friendlyError(err);
    }

    if (typeof credential.response.getPublicKey !== 'function') {
      throw new Error('This browser does not support getPublicKey() on WebAuthn credentials, cannot extract the passkey public key. Use a recent Chrome, Edge, Firefox, or Safari 16.4+.');
    }
    const spki = credential.response.getPublicKey();
    const compressedPubkey = _spkiToCompressedPoint(spki);

    return { compressedPubkey, credentialId: new Uint8Array(credential.rawId) };
  }

  function rememberCredentialForVault(vaultPdaBase58, credentialIdBytes) {
    _storeCredentialId(vaultPdaBase58, credentialIdBytes);
  }

  /**
   * Builds the secp256r1 precompile instruction. Layout per Solana's
   * SIMD-0075: 1-byte signature count, 1-byte padding, one 14-byte
   * offsets entry (7 x u16 LE), then the signature/pubkey/message
   * bytes themselves in the same instruction's data, each offsets
   * field's instruction_index set to the u16::MAX "this instruction"
   * sentinel, matching what passkey.rs's CURRENT_INSTRUCTION_SENTINEL
   * expects (mirrors the Ed25519 precompile's documented convention).
   */
  function _buildSecp256r1Instruction({ compressedPubkey33, rawSignature64, message }) {
    const web3 = _web3();
    const HEADER_LEN = 2, ENTRY_LEN = 14;
    const sigOffset = HEADER_LEN + ENTRY_LEN;
    const pubkeyOffset = sigOffset + 64;
    const msgOffset = pubkeyOffset + 33;
    const SENTINEL = 0xffff;

    const header = new Uint8Array([1, 0]); // num_signatures=1, padding
    const offsets = new Uint8Array(ENTRY_LEN);
    const dv = new DataView(offsets.buffer);
    dv.setUint16(0, sigOffset, true);
    dv.setUint16(2, SENTINEL, true);
    dv.setUint16(4, pubkeyOffset, true);
    dv.setUint16(6, SENTINEL, true);
    dv.setUint16(8, msgOffset, true);
    dv.setUint16(10, message.length, true);
    dv.setUint16(12, SENTINEL, true);

    const data = _concat([header, offsets, rawSignature64, compressedPubkey33, message]);
    return new web3.TransactionInstruction({
      programId: new web3.PublicKey(SECP256R1_PROGRAM_ID),
      keys: [],
      data,
    });
  }

  /**
   * The main entry point. `kind` is 'contribute' or 'withdraw',
   * `args` is whatever CognataProgram.buildContributeInstruction /
   * buildWithdrawInstruction takes (minus authenticatorData/
   * clientDataJson, this produces those). `credentialId` and
   * `compressedPubkey33` come from registerPasskey() (or
   * getStoredCredentialId() for a device already registered).
   *
   * Returns { precompileIx, businessIx }, put precompileIx first in
   * the transaction, immediately before businessIx.
   */
  async function authorizePasskeyInstruction({ kind, args, credentialId, compressedPubkey33 }) {
    const CP = window.CognataProgram;
    if (!CP) throw new Error('program-client.js must be loaded before passkey-client.js.');

    const material = kind === 'contribute' ? CP._contributeChallengeMaterial(args)
      : kind === 'withdraw' ? CP._withdrawChallengeMaterial(args)
      : (() => { throw new Error('Unknown passkey instruction kind: ' + kind); })();

    // Exactly hash_authorized_action's single-non-precompile-instruction
    // case: program_id, then per account pubkey+is_signer+is_writable,
    // then the fixed prefix (discriminator + business args).
    const web3 = _web3();
    const parts = [new web3.PublicKey(material.programId).toBytes()];
    for (const k of material.keys) {
      parts.push(k.pubkey.toBytes());
      parts.push(new Uint8Array([k.isSigner ? 1 : 0]));
      parts.push(new Uint8Array([k.isWritable ? 1 : 0]));
    }
    parts.push(material.prefix);
    const challenge = await _sha256(_concat(parts));

    const support = checkSupport();
    if (!support.ok) throw new Error(support.reason);

    let assertion;
    try {
      assertion = await navigator.credentials.get({
      publicKey: {
        challenge,
        allowCredentials: [{ type: 'public-key', id: credentialId }],
        userVerification: 'required',
        timeout: 60000,
      },
      });
    } catch (err) {
      throw _friendlyError(err);
    }

    const authenticatorData = new Uint8Array(assertion.response.authenticatorData);
    const clientDataJson = new Uint8Array(assertion.response.clientDataJSON);
    const rawSignature64 = _derSignatureToRawLowS(assertion.response.signature);

    const clientDataHash = await _sha256(clientDataJson);
    const message = _concat([authenticatorData, clientDataHash]);

    const precompileIx = _buildSecp256r1Instruction({ compressedPubkey33, rawSignature64, message });
    const businessIx = CP._finalizePasskeyInstruction({
      ...material,
      authenticatorData,
      clientDataJson,
    });

    return { precompileIx, businessIx };
  }

  return {
    checkSupport,
    registerPasskey,
    rememberCredentialForVault,
    getStoredCredentialId,
    authorizePasskeyInstruction,
  };
})();

window.PasskeyClient = PasskeyClient;
