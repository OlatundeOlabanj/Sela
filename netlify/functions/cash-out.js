// netlify/functions/cash-out.js
//
// Cash out USDC to naira (bank/Opay) via Bitnob. Two-step, quote-then-confirm,
// never auto-executes. The client fetches a quote (settlement_amount,
// exchange_rate, fees, expiry), shows it to the user, and only calls this
// again with action:"execute" once the user explicitly confirms.
//
// Frontend calls: /api/cash-out
//
// Made by TJS Code

const { createPayoutQuote, initializeQuote, finalizeQuote } = require('../../lib/bitnobClient');

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
      const { quoteId, bankAccountNumber, bankCode, userRef } = payload;
      if (!quoteId || !bankAccountNumber || !bankCode) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'quoteId, bankAccountNumber, and bankCode are required to execute a payout.' }),
        };
      }
      // Confirmed 3-step offramp flow: initialize with beneficiary details,
      // then finalize. Finalize's response includes the on-chain address
      // VeilPay still needs to send the actual USDC to, that step isn't
      // wired up here yet, this just gets the quote fully initialized.
      const reference = `veilpay-${userRef || 'user'}-${Date.now()}`;
      await initializeQuote({
        quoteId,
        beneficiary: { type: 'BANK', accountNumber: bankAccountNumber, bankCode },
        reference,
      });
      const finalized = await finalizeQuote(quoteId);
      return { statusCode: 200, headers, body: JSON.stringify({ payout: finalized }) };
    }

    // Default action: quote
    const { amountUSDC } = payload;
    if (!amountUSDC || amountUSDC <= 0) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'amountUSDC must be a positive number.' }) };
    }

    const quote = await createPayoutQuote({
      fromAsset: 'USDC',
      chain: 'SOLANA',
      toCurrency: 'NGN',
      amount: amountUSDC,
    });

    return { statusCode: 200, headers, body: JSON.stringify({ quote }) };
  } catch (err) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: err.message }) };
  }
};
