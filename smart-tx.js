/**
 * VeilPay, Smart TX Stack client
 * Thin browser-side wrapper around the Smart TX Stack (Jito bundle
 * submission, dynamic tip calculation, Groq AI retry reasoning). The
 * heavy logic lives server-side in Netlify Functions so the Jito/Groq
 * calls aren't made directly from the browser.
 *
 * Source stack: github.com/OlatundeOlabanj/smart-tx-stack
 * All three functions below are real. No simulation.
 *
 * Made by TJS Code
 */

const SmartTX = (() => {
  function _log(msg, data) {
    data !== undefined ? console.log(`[SMART-TX] ${msg}`, data) : console.log(`[SMART-TX] ${msg}`);
  }

  /** Get a dynamic tip amount (lamports) + a live Jito tip account for a given urgency. */
  async function getTip(urgency = 'MEDIUM') {
    try {
      const res = await fetch(`/api/get-tip?urgency=${urgency}`);
      if (!res.ok) throw new Error(`get-tip returned ${res.status}`);
      const data = await res.json();
      _log(`Tip for urgency=${urgency}:`, data.tipLamports);
      return data;
    } catch (err) {
      _log('Tip fetch failed, using fallback', err.message);
      const fallback = { LOW: 1000, MEDIUM: 5000, HIGH: 10000, CRITICAL: 50000 };
      return { tipLamports: fallback[urgency] ?? 5000, tipAccount: '9n3d1K5YD2vECAbRFhFFGYNNjiXtHXJWn9F31t89vsAV' };
    }
  }

  /**
   * Submit a wallet-signed transaction for landing via Jito bundle,
   * with automatic fallback to a plain RPC send if Jito is unreachable.
   */
  async function submitTransaction({ signedTxBase64, signature }) {
    const res = await fetch('/api/submit-bundle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signedTxBase64, signature }),
    });
    if (!res.ok) throw new Error(`submit-bundle returned ${res.status}`);
    return await res.json();
  }

  /**
   * Ask the Groq AI agent whether a failed/stalled transaction should
   * be retried, and at what tip.
   */
  async function reasonAboutFailure(lifecycleEntry, networkContext) {
    try {
      const res = await fetch('/api/reason-retry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lifecycleEntry, networkContext }),
      });
      if (!res.ok) throw new Error(`reason-retry returned ${res.status}`);
      return await res.json();
    } catch (err) {
      _log('Retry reasoning failed, defaulting to no-retry', err.message);
      return { should_retry: false, new_tip_lamports: 0, reason: 'Reasoning unavailable, held back to be safe.', confidence_score: 0 };
    }
  }

  return { getTip, submitTransaction, reasonAboutFailure };
})();

window.SmartTX = SmartTX;
