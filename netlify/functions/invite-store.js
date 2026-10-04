// Family vault invite storage, Netlify Blobs. Mirrors invoice-store.js's
// pattern: a small, real, server-side home for something that needs to
// be opened by someone other than the person who created it.
//
// An invite is NOT the on-chain authorization itself, it's a scoped,
// single-use pointer that lets a second device get as far as calling
// request_key_rotation against the right vault, with the right role.
// The actual authorization only happens on-chain when the vault's
// guardian calls approve_key_rotation, this store has no power over
// that, it just carries "which vault, which role, still unused" between
// two people who may never otherwise be in the same browser.
//
// Made by TJS Code

const { getStore } = require('@netlify/blobs');
const crypto = require('crypto');

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function getInviteStore() {
  const siteID = process.env.NETLIFY_BLOBS_SITE_ID || process.env.SITE_ID;
  const token = process.env.NETLIFY_BLOBS_TOKEN;
  if (siteID && token) {
    return getStore({ name: 'sela-invites', siteID, token });
  }
  return getStore('sela-invites');
}

function newCode() {
  // 8 chars, base32-ish (no 0/O/1/I), short enough to read out loud,
  // long enough that guessing one isn't realistic (36^8 space) even
  // though the real security boundary is guardian approval, not this.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  const bytes = crypto.randomBytes(8);
  for (let i = 0; i < 8; i++) code += alphabet[bytes[i] % alphabet.length];
  return code;
}

exports.handler = async function (event) {
  const store = getInviteStore();
  const headers = { 'Content-Type': 'application/json' };

  if (event.httpMethod === 'POST') {
    let body;
    try { body = JSON.parse(event.body); } catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON body' }) }; }
    const { vaultPda, vaultName, deviceRole, createdBy } = body || {};
    if (!vaultPda || deviceRole === undefined || !createdBy) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'vaultPda, deviceRole and createdBy are required' }) };
    }

    const code = newCode();
    const record = {
      code, vaultPda, vaultName: vaultName || 'Shared goal', deviceRole,
      createdBy, createdAt: Date.now(), expiresAt: Date.now() + INVITE_TTL_MS,
      used: false, usedBy: null, usedAt: null,
    };
    await store.setJSON(code, record);
    return { statusCode: 200, headers, body: JSON.stringify(record) };
  }

  if (event.httpMethod === 'GET') {
    const code = event.queryStringParameters && event.queryStringParameters.code;
    if (!code) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing code query param' }) };
    const record = await store.get(code.toUpperCase(), { type: 'json' });
    if (!record) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Invite not found' }) };
    if (record.used) return { statusCode: 410, headers, body: JSON.stringify({ error: 'Invite already used', record }) };
    if (Date.now() > record.expiresAt) return { statusCode: 410, headers, body: JSON.stringify({ error: 'Invite expired', record }) };
    return { statusCode: 200, headers, body: JSON.stringify(record) };
  }

  // Marks an invite used once the new member has actually submitted
  // request_key_rotation on chain, prevents the same link being reused.
  // Does not and cannot approve anything, that's on-chain only.
  if (event.httpMethod === 'PUT') {
    let body;
    try { body = JSON.parse(event.body); } catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON body' }) }; }
    const { code, usedBy } = body || {};
    if (!code || !usedBy) return { statusCode: 400, headers, body: JSON.stringify({ error: 'code and usedBy are required' }) };
    const record = await store.get(code.toUpperCase(), { type: 'json' });
    if (!record) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Invite not found' }) };
    record.used = true;
    record.usedBy = usedBy;
    record.usedAt = Date.now();
    await store.setJSON(code.toUpperCase(), record);
    return { statusCode: 200, headers, body: JSON.stringify(record) };
  }

  return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
};
