// netlify/functions/buy-crypto.js
//
// Buy USDC with naira via Bitnob. Two-step, quote-then-confirm, never
// auto-executes. The client fetches a quote (rate, fees, expiry), shows
// it to the user, and only calls this again with action:"execute" once
// the user explicitly confirms.
//
// Frontend calls: /api/buy-crypto
//
// Made by TJS Code

const { createTradingQuote, executeTrade } = require('../../lib/bitnobClient');

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed. Use POST.' }) };
  }

  const origin = event.headers?.origin || event.headers?.referer || '';
  if (origin && !origin.includes('veilpay.store') && !origin.includes('veilpay-tjscode.netlify.app') && !origin.includes('localhost')) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'Forbidden origin.' }) };
  }

  if (!process.env.BITNOB_API_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server misconfigured: Bitnob credentials not set.' }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const { action } = payload;

  try {
    if (action === 'execute') {
      const { quoteId } = payload;
      if (!quoteId) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'quoteId is required to execute a trade.' }) };
      }
      const result = await executeTrade(quoteId);
      return { statusCode: 200, headers, body: JSON.stringify({ result }) };
    }

    // Default action: quote
    const { amountNGN } = payload;
    if (!amountNGN || amountNGN <= 0) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'amountNGN must be a positive number.' }) };
    }

    const quote = await createTradingQuote({
      baseCurrency: 'NGN',
      quoteCurrency: 'USDC',
      side: 'buy',
      quantity: amountNGN,
    });

    return { statusCode: 200, headers, body: JSON.stringify({ quote }) };
  } catch (err) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: err.message }) };
  }
};
