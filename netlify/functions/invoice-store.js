// Real invoice storage, Netlify Blobs.
// Fixes the core bug: invoices used to live only in the creator's own
// browser localStorage, so a link sent to someone else always 404'd.
// This gives every invoice a real, shared, server-side home.

const { getStore } = require('@netlify/blobs');

// Fields that can never change once an invoice is created, the payment
// details themselves are locked in. Only these mutable fields are allowed
// to update afterward (used when marking an invoice as paid/disputed).
const MUTABLE_FIELDS = ['status', 'txHash', 'depositTxHash', 'paidAt', 'disputeReason'];

// Netlify Blobs' automatic environment detection (siteID/token injected
// implicitly) isn't reliable across every invocation context, it threw
// MissingBlobsEnvironmentError in production on Aug 18 despite this being
// a normal synchronous function on the main branch. Passing siteID/token
// explicitly, as the error itself instructs, sidesteps that entirely.
function getInvoiceStore() {
  const siteID = process.env.NETLIFY_BLOBS_SITE_ID || process.env.SITE_ID;
  const token = process.env.NETLIFY_BLOBS_TOKEN;
  if (siteID && token) {
    return getStore({ name: 'veilpay-invoices', siteID, token });
  }
  // Fall back to automatic detection if explicit env vars aren't set yet,
  // keeps this working today, will just throw the same clear error again
  // if auto-detection fails until the env vars below are added.
  return getStore('veilpay-invoices');
}

exports.handler = async function (event) {
  const store = getInvoiceStore();
  const headers = { 'Content-Type': 'application/json' };

  if (event.httpMethod === 'POST') {
    let incoming;
    try {
      incoming = JSON.parse(event.body);
    } catch {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON body' }) };
    }
    if (!incoming || !incoming.id) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invoice must have an id' }) };
    }

    const existing = await store.get(incoming.id, { type: 'json' });
    let toSave;
    if (!existing) {
      // First write for this ID. This is what locks in the real invoice details.
      toSave = incoming;
    } else {
      // Invoice already exists. Only allow the mutable fields to change.
      // Anything else in the incoming payload (amount, recipientWallet,
      // clientName, etc.) is silently ignored, so a guessed/intercepted
      // invoice ID can't be used to tamper with payment details.
      toSave = { ...existing };
      for (const field of MUTABLE_FIELDS) {
        if (incoming[field] !== undefined) toSave[field] = incoming[field];
      }
    }

    await store.setJSON(incoming.id, toSave);
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  }

  if (event.httpMethod === 'GET') {
    const id = event.queryStringParameters && event.queryStringParameters.id;
    if (!id) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing id query param' }) };
    }
    const invoice = await store.get(id, { type: 'json' });
    if (!invoice) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Invoice not found' }) };
    }
    return { statusCode: 200, headers, body: JSON.stringify(invoice) };
  }

  return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
};
