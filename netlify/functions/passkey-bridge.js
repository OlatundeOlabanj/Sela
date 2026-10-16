// netlify/functions/passkey-bridge.js
//
// Passkey handoff for browsers that cannot do WebAuthn. Wallet in-app
// browsers (Phantom on a phone, for example) run the app and hold the
// wallet, but they cannot create or use passkeys. This function lets
// that page pass a passkey request to the phone's real browser, where
// WebAuthn works, and collect the answer afterwards.
//
//   1. the wallet browser POSTs ?action=create with the request
//      (type create or get, a 32 byte challenge, an optional credential
//      id, and a short human readable summary). It gets back a code.
//   2. the user opens passkey-bridge.html?code=CODE in Chrome or Safari.
//      That page GETs ?code=CODE&role=bridge, shows the summary, runs the
//      passkey prompt, and POSTs ?action=complete with the result.
//   3. the wallet browser polls GET ?code=CODE&role=poll until the result
//      arrives. It is returned once, then deleted.
//
// What this does and does not protect:
//   - The code is 128 bits of randomness, valid for 5 minutes, and the
//     result is handed out once.
//   - Nothing here is an authorization. The passkey signature is only
//     useful inside a transaction that the wallet signs and the program
//     verifies on chain. This function carries bytes, it cannot spend.
//   - The summary text is written by whoever created the request, so the
//     approval page shows it as information, not as proof of what is
//     being signed. The challenge is what the chain checks.
//   - There is no rate limiting. The origin check is the same light guard
//     as the other functions, it blocks casual reuse from other sites.
//
// Storage is Netlify Blobs, the same pattern as invite-store.js.
// PASSKEY_BRIDGE_MEMORY=1 swaps in an in-memory map for local tests only.
//
// Made by TJS Code

const crypto = require('crypto');
const { isAllowedOrigin } = require('../../lib/originGuard');
const { scrubSecrets } = require('../../lib/secretScrub');

const TTL_MS = 5 * 60 * 1000;
const CODE_RE = /^[A-Za-z0-9_-]{22}$/;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;

const memory = new Map();

function getBridgeStore() {
  if (process.env.PASSKEY_BRIDGE_MEMORY === '1') {
    return {
      async setJSON(key, value) { memory.set(key, JSON.stringify(value)); },
      async get(key) { const v = memory.get(key); return v ? JSON.parse(v) : null; },
      async delete(key) { memory.delete(key); },
    };
  }
  // Required lazily so local tests that use the memory store do not need
  // the package installed. Netlify's bundler still finds it.
  const { getStore } = require('@netlify/blobs');
  const siteID = process.env.NETLIFY_BLOBS_SITE_ID || process.env.SITE_ID;
  const token = process.env.NETLIFY_BLOBS_TOKEN;
  // Strong consistency so a result written by one invocation is visible to
  // the next poll straight away instead of up to a minute later.
  if (siteID && token) return getStore({ name: 'sela-passkey-bridge', siteID, token, consistency: 'strong' });
  return getStore({ name: 'sela-passkey-bridge', consistency: 'strong' });
}

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body),
});

function cleanText(v, max) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, max);
}

function isB64url(v, maxLen) {
  return typeof v === 'string' && v.length > 0 && v.length <= maxLen && B64URL_RE.test(v);
}

function decodeClientData(b64) {
  try { return JSON.parse(Buffer.from(b64, 'base64url').toString('utf8')); } catch (_) { return null; }
}

async function handle(event) {
  if (!isAllowedOrigin(event.headers)) return json(403, { error: 'Forbidden origin.' });

  const qs = event.queryStringParameters || {};

  let store;
  try {
    // Functions in Lambda compatibility mode get their Blobs connection from
    // the event, connectLambda hands it to the package.
    if (process.env.PASSKEY_BRIDGE_MEMORY !== '1' && event.blobs) {
      const { connectLambda } = require('@netlify/blobs');
      if (typeof connectLambda === 'function') connectLambda(event);
    }
    store = getBridgeStore();
  } catch (err) {
    console.error('passkey-bridge storage unavailable:', scrubSecrets(err && err.message));
    return json(503, { error: 'The passkey handoff is not available right now.' });
  }

  // ---- create a request (wallet browser) ----
  if (event.httpMethod === 'POST' && qs.action === 'create') {
    if ((event.body || '').length > 2048) return json(413, { error: 'Request too large.' });
    let body;
    try { body = JSON.parse(event.body || '{}'); } catch (_) { return json(400, { error: 'Invalid JSON.' }); }

    const type = body.type;
    if (type !== 'create' && type !== 'get') return json(400, { error: 'type must be create or get.' });
    if (!isB64url(body.challenge, 64) || Buffer.from(body.challenge, 'base64url').length !== 32) {
      return json(400, { error: 'challenge must be 32 bytes, base64url.' });
    }
    if (type === 'get' && !isB64url(body.credentialId, 1400)) {
      return json(400, { error: 'credentialId is required for type get.' });
    }

    const code = crypto.randomBytes(16).toString('base64url');
    const now = Date.now();
    const record = {
      code, type, challenge: body.challenge,
      credentialId: type === 'get' ? body.credentialId : null,
      label: cleanText(body.label, 64),
      summary: cleanText(body.summary, 140),
      status: 'pending', createdAt: now, expiresAt: now + TTL_MS,
    };
    await store.setJSON(code, record);
    return json(200, { code, expiresAt: record.expiresAt });
  }

  const code = qs.code;
  if (!code || !CODE_RE.test(code)) return json(400, { error: 'Missing or malformed code.' });

  // ---- read the request (approval page) or poll for the result (wallet browser) ----
  if (event.httpMethod === 'GET') {
    const record = await store.get(code, { type: 'json' });
    if (!record) return json(404, { status: 'missing', error: 'This request does not exist or was already used.' });
    if (Date.now() > record.expiresAt) {
      await store.delete(code);
      return json(410, { status: 'expired', error: 'This request expired. Start again from the app.' });
    }

    if (qs.role === 'bridge') {
      if (record.status !== 'pending') return json(409, { status: record.status, error: 'This request was already answered.' });
      return json(200, {
        type: record.type, challenge: record.challenge, credentialId: record.credentialId,
        label: record.label, summary: record.summary, expiresAt: record.expiresAt,
      });
    }

    if (qs.role === 'poll') {
      if (record.status === 'pending') return json(200, { status: 'pending' });
      await store.delete(code); // single use, whatever the outcome
      if (record.status === 'error') return json(200, { status: 'error', error: record.error || 'The passkey step did not finish.' });
      return json(200, { status: 'done', result: record.result });
    }
    return json(400, { error: 'role must be bridge or poll.' });
  }

  // ---- complete a request (approval page) ----
  if (event.httpMethod === 'POST' && qs.action === 'complete') {
    if ((event.body || '').length > 4096) return json(413, { error: 'Result too large.' });
    const record = await store.get(code, { type: 'json' });
    if (!record) return json(404, { error: 'This request does not exist or was already used.' });
    if (Date.now() > record.expiresAt) { await store.delete(code); return json(410, { error: 'This request expired.' }); }
    if (record.status !== 'pending') return json(409, { error: 'This request was already answered.' });

    let body;
    try { body = JSON.parse(event.body || '{}'); } catch (_) { return json(400, { error: 'Invalid JSON.' }); }

    if (body.error) {
      record.status = 'error';
      record.error = cleanText(body.error, 120);
      await store.setJSON(code, record);
      return json(200, { ok: true });
    }

    const r = body.result || {};
    if (!isB64url(r.clientDataJSON, 1000)) return json(400, { error: 'clientDataJSON is missing or malformed.' });
    const cd = decodeClientData(r.clientDataJSON);
    const expectedType = record.type === 'create' ? 'webauthn.create' : 'webauthn.get';
    if (!cd || cd.type !== expectedType || cd.challenge !== record.challenge) {
      return json(400, { error: 'The passkey answer does not match this request.' });
    }

    let result;
    if (record.type === 'create') {
      if (!isB64url(r.credentialId, 1400) || !isB64url(r.publicKeySpki, 200)) {
        return json(400, { error: 'credentialId or publicKeySpki is missing or malformed.' });
      }
      result = { credentialId: r.credentialId, publicKeySpki: r.publicKeySpki, clientDataJSON: r.clientDataJSON };
    } else {
      if (!isB64url(r.authenticatorData, 400) || !isB64url(r.signature, 200)) {
        return json(400, { error: 'authenticatorData or signature is missing or malformed.' });
      }
      result = { authenticatorData: r.authenticatorData, clientDataJSON: r.clientDataJSON, signature: r.signature };
    }

    record.status = 'done';
    record.result = result;
    await store.setJSON(code, record);
    return json(200, { ok: true });
  }

  return json(405, { error: 'Method not allowed.' });
}

exports.handler = async (event) => {
  try {
    return await handle(event);
  } catch (err) {
    console.error('passkey-bridge failure:', scrubSecrets(err && err.message));
    return json(500, { error: 'Something went wrong, try again.' });
  }
};
