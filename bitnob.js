/**
 * VeilPay, Naira On/Off-Ramp (Bitnob)
 * Made by TJS Code
 *
 * Buy USDC with naira, or cash out USDC to a bank/Opay account, via
 * Bitnob. Quote-then-confirm only: fetching a quote never moves money,
 * the user must explicitly hit "Confirm" before anything executes.
 * Quotes expire client-side on a countdown matched to Bitnob's quote
 * expiry so a stale rate can never be confirmed by accident.
 */

const ONRAMP_BUY_API = '/api/buy-crypto';
const ONRAMP_CASHOUT_API = '/api/cash-out';
const ONRAMP_QUOTE_DEBOUNCE_MS = 600;
// Fallback quote lifetime if the API response doesn't include an expiry,
// conservative, since Bitnob's own quote window is the source of truth
// once wired up against the live API.
const ONRAMP_DEFAULT_QUOTE_TTL_MS = 30_000;

const VeilOnrampModule = (() => {
  let mode = 'buy'; // 'buy' | 'cashout'
  let quote = null;
  let quoteTimer = null;
  let expiryInterval = null;
  let quoteExpiresAt = null;

  function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  function setMode(next) {
    mode = next;
    document.getElementById('onrampModeBuyBtn')?.classList.toggle('active', mode === 'buy');
    document.getElementById('onrampModeCashoutBtn')?.classList.toggle('active', mode === 'cashout');
    document.getElementById('onrampBuyFields').style.display = mode === 'buy' ? '' : 'none';
    document.getElementById('onrampCashoutFields').style.display = mode === 'cashout' ? '' : 'none';
    setText('onrampReceiveLabel', mode === 'buy' ? 'You receive' : 'You receive (bank/Opay)');
    resetQuote();
  }

  function onAmountInput() {
    clearTimeout(quoteTimer);
    resetQuote();
    const amount = currentAmount();
    if (!amount || amount <= 0) return;
    quoteTimer = setTimeout(fetchQuote, ONRAMP_QUOTE_DEBOUNCE_MS);
  }

  function currentAmount() {
    const id = mode === 'buy' ? 'onrampNGNAmount' : 'onrampUSDCAmount';
    return parseFloat(document.getElementById(id)?.value);
  }

  async function fetchQuote() {
    const amount = currentAmount();
    if (!amount || amount <= 0) return;

    setBtnState('loading', 'Getting quote…');

    try {
      let res, data;
      if (mode === 'buy') {
        res = await fetch(ONRAMP_BUY_API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ amountNGN: amount }),
        });
      } else {
        res = await fetch(ONRAMP_CASHOUT_API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ amountUSDC: amount }),
        });
      }
      data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Quote request failed');

      quote = data.quote;
      renderQuote(quote);
      startExpiryCountdown(quote);
      setBtnState('ready', mode === 'buy' ? 'Confirm & Buy' : 'Confirm & Cash Out');
    } catch (err) {
      console.error('[VeilOnramp] Quote error:', err);
      resetQuote();
      showError(err.message || 'Could not get a quote. Please try again.');
    }
  }

  function renderQuote(q) {
    if (mode === 'buy') {
      const received = q.quantity_received ?? q.received_amount ?? q.output_amount;
      setText('onrampReceiveAmount', received != null ? `${received} USDC` : '-');
      setText('onrampRate', q.rate ?? q.exchange_rate ?? '-');
      setText('onrampFees', q.fee ?? q.fees ?? '-');
    } else {
      const settled = q.settlement_amount ?? q.received_amount ?? q.output_amount;
      setText('onrampReceiveAmount', settled != null ? `₦${settled}` : '-');
      setText('onrampRate', q.exchange_rate ?? q.rate ?? '-');
      setText('onrampFees', q.fee ?? q.fees ?? '-');
    }
  }

  function startExpiryCountdown(q) {
    clearInterval(expiryInterval);
    const ttlMs = q.expires_in_ms || (q.expires_at ? (new Date(q.expires_at) - Date.now()) : ONRAMP_DEFAULT_QUOTE_TTL_MS);
    quoteExpiresAt = Date.now() + Math.max(ttlMs, 1000);

    const tick = () => {
      const remainingMs = quoteExpiresAt - Date.now();
      if (remainingMs <= 0) {
        clearInterval(expiryInterval);
        setText('onrampExpiry', 'Expired, refresh');
        setBtnState('expired', 'Quote expired. Edit amount to refresh');
        return;
      }
      setText('onrampExpiry', Math.ceil(remainingMs / 1000) + 's');
    };
    tick();
    expiryInterval = setInterval(tick, 1000);
  }

  function resetQuote() {
    clearInterval(expiryInterval);
    quote = null;
    quoteExpiresAt = null;
    ['onrampReceiveAmount', 'onrampRate', 'onrampFees', 'onrampExpiry'].forEach(id => setText(id, '-'));
    setBtnState('idle', 'Enter an amount to get a quote');
  }

  function setBtnState(state, label) {
    const btn = document.getElementById('onrampConfirmBtn');
    const spinner = document.getElementById('onrampBtnSpinner');
    const text = document.getElementById('onrampBtnText');
    if (!btn) return;
    text.textContent = label;
    spinner.style.display = state === 'loading' || state === 'confirming' ? 'inline-block' : 'none';
    btn.disabled = state !== 'ready';
  }

  function showError(msg) {
    const panel = document.getElementById('onrampStatusPanel');
    if (!panel) return;
    panel.classList.add('visible');
    document.getElementById('onrampStatusDot').className = 'status-dot error';
    document.getElementById('onrampStatusTitle').textContent = 'Error';
    document.getElementById('onrampStatusMsg').textContent = msg;
  }

  function setStatus(msg, type) {
    const panel = document.getElementById('onrampStatusPanel');
    if (!panel) return;
    panel.classList.add('visible');
    document.getElementById('onrampStatusDot').className = 'status-dot ' + type;
    document.getElementById('onrampStatusTitle').textContent =
      type === 'success' ? 'Success' : type === 'error' ? 'Error' : 'Processing';
    document.getElementById('onrampStatusMsg').textContent = msg;
  }

  async function onConfirm() {
    if (!quote || Date.now() >= (quoteExpiresAt || 0)) {
      showError('This quote has expired. Edit the amount to get a fresh one.');
      return;
    }

    const wallet = window.Cognata?.WalletState?.get();
    const userRef = wallet?.publicKey || 'guest';

    setBtnState('confirming', 'Confirming…');

    try {
      if (mode === 'buy') {
        const res = await fetch(ONRAMP_BUY_API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'execute', quoteId: quote.quote_id, userRef }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Trade execution failed');
        setStatus('USDC purchase submitted. It will land in your Bitnob-linked wallet shortly.', 'success');
      } else {
        const bankAccountNumber = document.getElementById('onrampBankAccount')?.value?.trim();
        const bankCode = document.getElementById('onrampBankCode')?.value?.trim();
        if (!bankAccountNumber || !bankCode) {
          throw new Error('Enter your bank account number and bank code first.');
        }
        const res = await fetch(ONRAMP_CASHOUT_API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'execute', quoteId: quote.quote_id, bankAccountNumber, bankCode, userRef }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Payout failed');
        setStatus('Payout initiated. Funds typically land within a few minutes, we\u2019ll update this once Bitnob confirms.', 'pending');
      }
      resetQuote();
    } catch (err) {
      console.error('[VeilOnramp] Confirm error:', err);
      setStatus(err.message || 'Something went wrong. Please try again.', 'error');
      setBtnState('idle', mode === 'buy' ? 'Confirm & Buy' : 'Confirm & Cash Out');
    }
  }

  function init() {
    setMode('buy');
  }

  return { init, setMode, onAmountInput, onConfirm };
})();

window.VeilOnramp = VeilOnrampModule;
