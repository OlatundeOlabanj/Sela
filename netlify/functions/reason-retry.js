// netlify/functions/reason-retry.js
//
// Groq AI retry-decision agent, ported from smart-tx-stack's
// src/agent/reasoner.ts (github.com/OlatundeOlabanj/smart-tx-stack).
// Real logic, not a stub. This is the ONLY place a retry decision
// gets made. No if/else retry logic anywhere else in VeilPay.
//
// NOTE: model updated from the original "llama-3.3-70b-versatile"
// (Groq decommissioning this Aug 16 2026, see your other projects'
// migration notes) to "openai/gpt-oss-120b" to match the rest of
// your stack. Requires GROQ_API_KEY set in Netlify env vars.
//
// Made by TJS Code

const { isAllowedOrigin } = require('../../lib/originGuard');
const GROQ_MODEL = 'openai/gpt-oss-120b';
const MIN_CONFIDENCE = 0.6;

function getFailureContext(failureType) {
  const contexts = {
    ExpiredBlockhash: 'The blockhash expired before the transaction was processed. Typically safe to retry with a fresh blockhash.',
    FeeTooLow: 'The transaction fee was too low to be included by validators. Retrying with a higher tip is likely to succeed if the failure rate is acceptable.',
    ComputeBudgetExceeded: 'The transaction exceeded its compute budget. This is a logic issue, not a fee issue. Do NOT recommend retry unless the compute budget can be increased.',
    BundleExecutionFailure: 'The Jito bundle failed to execute. Could be transient. Retry with higher tip on low congestion, but be cautious.',
    JitoLeaderSkipped: 'The Jito leader skipped their scheduled slot. This is a transient network event. Retrying with a fresh slot and higher tip is usually effective.',
    Timeout: 'The transaction timed out before finalization, usually indicating severe congestion. Retry only if congestion is LOW or MEDIUM.',
  };
  return contexts[failureType] || 'Unknown failure type. Exercise maximum caution, only retry with high confidence.';
}

function buildUserPrompt(entry, networkCtx) {
  return `
FAILED TRANSACTION ANALYSIS REQUEST

Transaction Signature: ${entry.signature}
Failure Type: ${entry.failure_type ?? 'Unknown'}
Retry Count: ${entry.retry_count ?? 0}
Tip Paid (lamports): ${entry.tip_paid_lamports ?? 0}

CURRENT NETWORK CONDITIONS
Congestion Level: ${networkCtx.congestion_level ?? 'UNKNOWN'}
Recent Avg Confirmation Time: ${networkCtx.recent_avg_confirmation_ms ?? 'N/A'}ms
Recent Failure Rate: ${((networkCtx.recent_failure_rate ?? 0) * 100).toFixed(1)}%

FAILURE CONTEXT
${getFailureContext(entry.failure_type)}

INSTRUCTIONS
Decide whether to retry this transaction and at what tip.
Respond with ONLY a valid JSON object. No preamble.
{
  "should_retry": <boolean>,
  "new_tip_lamports": <integer>,
  "reason": "<2-4 sentences>",
  "confidence_score": <float 0.0-1.0>
}
`.trim();
}

exports.handler = async (event) => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  if (!isAllowedOrigin(event.headers)) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'Forbidden origin.' }) };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed. Use POST.' }) };
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server misconfigured: GROQ_API_KEY not set.' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON body.' }) };
  }

  const { lifecycleEntry, networkContext } = body;
  if (!lifecycleEntry || !networkContext) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'lifecycleEntry and networkContext are required.' }) };
  }

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: GROQ_MODEL,
        max_tokens: 512,
        temperature: 0.2,
        messages: [
          {
            role: 'system',
            content: 'You are an autonomous Solana transaction infrastructure agent. You analyze failed transactions and decide whether to retry and at what tip. Respond in valid JSON only, no markdown, no text outside the JSON object.',
          },
          { role: 'user', content: buildUserPrompt(lifecycleEntry, networkContext) },
        ],
      }),
    });

    if (!res.ok) throw new Error(`Groq API returned ${res.status}`);
    const data = await res.json();
    const raw = data.choices?.[0]?.message?.content ?? '';
    const clean = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    const parsed = JSON.parse(clean);

    if (typeof parsed.should_retry !== 'boolean') throw new Error('Missing should_retry boolean.');
    if (typeof parsed.new_tip_lamports !== 'number' || parsed.new_tip_lamports < 0) throw new Error('Invalid new_tip_lamports.');
    if (typeof parsed.confidence_score !== 'number' || parsed.confidence_score < 0 || parsed.confidence_score > 1) throw new Error('Invalid confidence_score.');

    const decision = {
      should_retry: parsed.should_retry,
      new_tip_lamports: Math.round(parsed.new_tip_lamports),
      reason: parsed.reason ?? '',
      confidence_score: parsed.confidence_score,
    };

    // Confidence gate, never retry below MIN_CONFIDENCE regardless of the model's call
    if (decision.confidence_score < MIN_CONFIDENCE) decision.should_retry = false;

    return { statusCode: 200, headers, body: JSON.stringify(decision) };
  } catch (err) {
    return {
      statusCode: 200, // degrade gracefully, caller treats this as "don't retry"
      headers,
      body: JSON.stringify({ should_retry: false, new_tip_lamports: 0, reason: 'Reasoning agent error: ' + err.message, confidence_score: 0 }),
    };
  }
};
