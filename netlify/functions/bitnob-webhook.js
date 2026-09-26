// netlify/functions/bitnob-webhook.js
//
// Receives Bitnob webhook events for payouts and stablecoin deposits/transfers,
// and persists the latest status per reference so the frontend can poll it
// (same Netlify Blobs pattern as invoice-store.js).
//
// Event sequence for payouts: payouts.initialized -> payouts.processing ->
// payouts.withdrawal.success | payouts.withdrawal.expired
//
// IMPORTANT: `.processing` is NOT terminal. Only `.withdrawal.success` means
// funds actually landed. `.withdrawal.expired` means it failed and can be retried.
//
// TODO for Claude 2: verify the webhook signature against Bitnob's webhook
// docs before trusting the payload in production. This currently checks a
// shared-secret header (BITNOB_WEBHOOK_SECRET) if one is configured, but
// that is a stand-in, not Bitnob's real signature scheme.
//
// Made by TJS Code

const { getStore } = require('@netlify/blobs');

function getEventsStore() {
  const siteID = process.env.NETLIFY_BLOBS_SITE_ID || process.env.SITE_ID;
  const token = process.env.NETLIFY_BLOBS_TOKEN;
  if (siteID && token) {
    return getStore({ name: 'veilpay-bitnob-events', siteID, token });
  }
  return getStore('veilpay-bitnob-events');
}

const TERMINAL_SUCCESS = ['payouts.withdrawal.success'];
const TERMINAL_FAILURE = ['payouts.withdrawal.expired'];

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json' };

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // Stand-in signature check, see TODO above.
  const configuredSecret = process.env.BITNOB_WEBHOOK_SECRET;
  if (configuredSecret) {
    const provided = event.headers?.['x-bitnob-signature'] || event.headers?.['X-Bitnob-Signature'];
    if (provided !== configuredSecret) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid webhook signature.' }) };
    }
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const { event: eventType, data } = payload;
  const reference = data?.reference || data?.customerReference || data?.id;

  if (!eventType || !reference) {
    // Ack anyway so Bitnob doesn't retry a malformed payload forever, but
    // don't pretend we processed anything meaningful.
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, ignored: true }) };
  }

  let status = 'processing';
  if (TERMINAL_SUCCESS.includes(eventType)) status = 'success';
  else if (TERMINAL_FAILURE.includes(eventType)) status = 'failed';

  try {
    const store = getEventsStore();
    await store.setJSON(reference, {
      eventType,
      status,
      data,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    // Don't fail the webhook ack over a storage hiccup, Bitnob will retry
    // otherwise, and the dashboard just polls Bitnob's status directly as
    // a fallback in that case. Log for visibility.
    console.error('[bitnob-webhook] Failed to persist event:', err.message);
  }

  return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
};
