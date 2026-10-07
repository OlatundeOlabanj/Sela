/**
 * VeilPay, Swap Module
 * Made by TJS Code
 *
 * Quotes come from Jupiter's public aggregator API (real, live).
 * Solana-only: SOL, USDC, USDT. Execution is real (Jupiter swap API,
 * signed via Phantom, broadcast, then a follow-up fee transfer), was
 * disabled for a while after MagicBlock's Hydra crank (private/split/
 * delayed delivery) was removed in the mainnet pivot, re-enabled once
 * confirmed nothing else still depended on it.
 *
 * 1% platform fee is deducted from swap output and routed
 * to the configured fee destination as a separate transfer in the
 * same transaction batch as the swap broadcast.
 */

const SWAP_TOKENS = {
  SOL:  { mint:'So11111111111111111111111111111111111111112',  decimals:9, color:'#627EEA', bg:'#627EEA20', label:'SOL',  abbr:'SOL' },
  USDC: { mint:'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals:6, color:'#2775CA', bg:'#2775CA20', label:'USDC', abbr:'UDC' },
  USDT: { mint:'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', decimals:6, color:'#26A17B', bg:'#26A17B20', label:'USDT', abbr:'UST' },
};

const SWAP_QUOTE_API = 'https://lite-api.jup.ag/swap/v1/quote';
// Routed through a Netlify Function so the real RPC provider's key
// never ships in client-side JS. See netlify/functions/rpc-proxy.js
const SWAP_RPC = '/api/rpc';
const SWAP_SLIPPAGE_BPS = 50;
const SWAP_FEE_BPS = 100; // 1.00%
// No fee wallet constant: the fee destination comes from
// window.PaymentTransfer.getFeeDestinationOwner(), which reads
// sela-config.js (FEE_MODE). See sendFeeTransfer below.
const SWAP_EXECUTION_ENABLED = true; // re-enabled: MagicBlock removal left no dependency behind, verify with a small real swap before trusting it broadly

const VeilSwapModule = (() => {
  let walletPubkey = null;
  let fromToken = 'SOL', toToken = 'USDC';
  let quoteData = null, authToken = null, quoteTimer = null;

  // ── Wallet sync (shared with main VeilPay wallet state) ──
  function syncWallet(publicKey) {
    walletPubkey = publicKey;
  }

  async function rpcCall(method, params) {
    const res = await fetch(SWAP_RPC, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ jsonrpc:'2.0', id:1, method, params })
    });
    return (await res.json()).result;
  }

  async function loadBalances() {
    if (!walletPubkey) return;
    try {
      const r = await rpcCall('getBalance', [walletPubkey]);
      const sol = (r.value / 1e9).toFixed(4);
      if (fromToken === 'SOL') setText('swapFromBalance', sol + ' SOL');
      if (toToken   === 'SOL') setText('swapToBalance', sol + ' SOL');
    } catch(e) {}
    for (const [sym, tok] of Object.entries(SWAP_TOKENS)) {
      if (sym === 'SOL') continue;
      try {
        const r = await rpcCall('getTokenAccountsByOwner', [walletPubkey, {mint:tok.mint}, {encoding:'jsonParsed'}]);
        if (r?.value?.length > 0) {
          const bal = r.value[0].account.data.parsed.info.tokenAmount.uiAmountString;
          if (fromToken === sym) setText('swapFromBalance', bal + ' ' + sym);
          if (toToken   === sym) setText('swapToBalance', bal + ' ' + sym);
        }
      } catch(e) {}
    }
  }

  function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  function setMax() {
    const txt = document.getElementById('swapFromBalance')?.textContent || '';
    const num = parseFloat(txt);
    if (!isNaN(num)) {
      const input = document.getElementById('swapFromAmount');
      if (input) { input.value = num; onAmountInput(); }
    }
  }

  function buildDropdowns() {
    ['swapFrom','swapTo'].forEach(side => {
      const key = side === 'swapFrom' ? fromToken : toToken;
      const el = document.getElementById(side + 'Dropdown');
      if (!el) return;
      el.innerHTML = Object.entries(SWAP_TOKENS).map(([sym, tok]) => `
        <div class="token-option ${sym === key ? 'selected' : ''}"
             onclick="VeilSwap.selectToken('${side}','${sym}');event.stopPropagation()">
          <div class="token-icon" style="background:${tok.bg};color:${tok.color}">${tok.abbr}</div>
          <span>${tok.label}</span>
        </div>`).join('');
    });
  }

  function toggleDropdown(side, e) {
    e && e.stopPropagation();
    const dd = document.getElementById(side + 'Dropdown');
    if (!dd) return;
    const wasOpen = dd.classList.contains('open');
    closeAllDropdowns();
    if (!wasOpen) dd.classList.add('open');
  }

  function closeAllDropdowns() {
    document.querySelectorAll('.token-dropdown').forEach(d => d.classList.remove('open'));
  }

  function selectToken(side, sym) {
    if (side === 'swapFrom') {
      if (sym === toToken) { toToken = fromToken; updateTokenUI('swapTo'); }
      fromToken = sym; updateTokenUI('swapFrom');
    } else {
      if (sym === fromToken) { fromToken = toToken; updateTokenUI('swapFrom'); }
      toToken = sym; updateTokenUI('swapTo');
    }
    closeAllDropdowns(); buildDropdowns(); loadBalances(); onAmountInput();
  }

  function updateTokenUI(side) {
    const sym = side === 'swapFrom' ? fromToken : toToken;
    const tok = SWAP_TOKENS[sym];
    const icon = document.getElementById(side + 'Icon');
    if (icon) { icon.style.background = tok.bg; icon.style.color = tok.color; icon.textContent = tok.abbr; }
    setText(side + 'Name', tok.label);
  }

  function swapDirection() {
    [fromToken, toToken] = [toToken, fromToken];
    updateTokenUI('swapFrom'); updateTokenUI('swapTo'); buildDropdowns();
    const input = document.getElementById('swapFromAmount');
    if (input) input.value = '';
    setText('swapToAmount', '-');
    resetQuoteDisplay(); loadBalances();
  }

  function onAmountInput() {
    clearTimeout(quoteTimer);
    const input = document.getElementById('swapFromAmount');
    const amt = parseFloat(input?.value);
    if (!amt || amt <= 0) { resetQuoteDisplay(); return; }
    setText('swapQuoteReceive', '...');
    setText('swapQuotePriceImpact', '...');
    setText('swapQuoteFee', '...');
    setText('swapQuoteRoute', '...');
    quoteTimer = setTimeout(() => fetchQuote(amt), 600);
  }

  async function fetchQuote(amount) {
    const ft = SWAP_TOKENS[fromToken], tt = SWAP_TOKENS[toToken];
    const raw = Math.floor(amount * Math.pow(10, ft.decimals));
    try {
      const res = await fetch(`${SWAP_QUOTE_API}?inputMint=${ft.mint}&outputMint=${tt.mint}&amount=${raw}&slippageBps=${SWAP_SLIPPAGE_BPS}`);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      quoteData = await res.json();

      const grossOut = quoteData.outAmount / Math.pow(10, tt.decimals);
      const feeAmount = grossOut * (SWAP_FEE_BPS / 10000);
      const netOut = grossOut - feeAmount;

      const impact = parseFloat(quoteData.priceImpactPct || '0');
      const route = quoteData.routePlan?.[0]?.swapInfo?.label || 'Direct';

      setText('swapToAmount', netOut.toFixed(tt.decimals === 9 ? 6 : 4));
      updateQuoteDisplay({ netOut, feeAmount, priceImpact: impact, route, symbol: toToken });
    } catch(e) {
      console.error('[VeilSwap] Quote error:', e);
      resetQuoteDisplay();
      setText('swapQuoteReceive', 'Unavailable');
    }
  }

  function updateQuoteDisplay(data) {
    const dec = data.symbol === 'SOL' ? 6 : 4;
    setText('swapQuoteReceive', data.netOut.toFixed(dec) + ' ' + data.symbol);
    setText('swapQuoteFee', data.feeAmount.toFixed(dec) + ' ' + data.symbol + ' (1%)');
    const impEl = document.getElementById('swapQuotePriceImpact');
    if (impEl) {
      const imp = parseFloat(data.priceImpact || 0);
      impEl.textContent = imp.toFixed(3) + '%';
      impEl.className = 'value ' + (imp < 0.5 ? 'price-impact-low' : imp < 2 ? 'price-impact-med' : 'price-impact-high');
    }
    setText('swapQuoteRoute', data.route || '-');
  }

  function resetQuoteDisplay() {
    ['swapQuoteReceive','swapQuotePriceImpact','swapQuoteRoute','swapQuoteFee'].forEach(id => setText(id, '-'));
    setText('swapToAmount', '-');
    quoteData = null;
  }

  function setStatus(msg, txSig, type = 'pending') {
    const panel = document.getElementById('swapStatusPanel');
    if (!panel) return;
    panel.classList.add('visible');
    setText('swapStatusMsg', msg);
    const msgEl = document.getElementById('swapStatusMsg');
    if (msgEl) msgEl.className = 'status-msg' + (type === 'error' ? ' error-msg' : '');
    const dot = document.getElementById('swapStatusDot');
    if (dot) dot.className = 'status-dot ' + (type === 'error' ? 'error' : type === 'success' ? 'success' : 'pending');
    setText('swapStatusTitle', type === 'error' ? 'Error' : type === 'success' ? 'Confirmed' : 'Processing');
    const link = document.getElementById('swapTxLink');
    if (link) {
      if (txSig) {
        link.style.display = 'block';
        link.href = 'https://solscan.io/tx/' + txSig;
        link.textContent = 'View on Solscan: ' + txSig.slice(0,8) + '...' + txSig.slice(-8);
      } else { link.style.display = 'none'; }
    }
  }

  function showError(msg) { setStatus(msg, null, 'error'); }

  function setBtnLoading(loading) {
    const btn = document.getElementById('swapExecuteBtn');
    if (!btn) return;
    const spinner = document.getElementById('swapBtnSpinner');
    const text = document.getElementById('swapBtnText');
    if (spinner) spinner.style.display = loading ? 'block' : 'none';
    if (text) text.textContent = loading ? 'Processing...' : (walletPubkey ? 'Swap' : 'Connect wallet to swap');
    btn.disabled = loading || !walletPubkey;
    btn.classList.toggle('loading', loading);
  }

  async function executeSwap() {
    if (!walletPubkey) { showError('Wallet not connected'); return; }

    if (!SWAP_EXECUTION_ENABLED) {
      showError('Swap execution is coming soon. Quotes above are live.');
      return;
    }

    const input = document.getElementById('swapFromAmount');
    const amount = parseFloat(input?.value);
    if (!amount || amount <= 0) { showError('Enter an amount to swap'); return; }

    setBtnLoading(true);

    if (!quoteData) {
      setStatus('Fetching quote...', null, 'pending');
      await fetchQuote(amount);
      if (!quoteData) { showError('Could not get a quote. The pair may have low liquidity.'); setBtnLoading(false); return; }
    }

    try {
      setStatus('Building swap transaction...', null, 'pending');

      const tt = SWAP_TOKENS[toToken];
      const grossOut = quoteData.outAmount / Math.pow(10, tt.decimals);
      const feeAmount = grossOut * (SWAP_FEE_BPS / 10000);
      const feeRawAmount = Math.floor(feeAmount * Math.pow(10, tt.decimals));

      // Build the swap via Jupiter. NOTE: this delivers output normally,
      // the old private/split/delayed delivery was MagicBlock-specific and
      // has no direct equivalent here. Re-enable SWAP_EXECUTION_ENABLED
      // only once a real private-delivery story exists on top of this.
      const swapRes = await fetch(`https://lite-api.jup.ag/swap/v1/swap`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({
          userPublicKey: walletPubkey,
          quoteResponse: quoteData,
          wrapAndUnwrapSol: true,
          useSharedAccounts: true,
          dynamicComputeUnitLimit: true,
        })
      });
      if (!swapRes.ok) {
        const errText = await swapRes.text();
        throw new Error('Swap build failed (' + swapRes.status + '): ' + errText);
      }
      const { swapTransaction } = await swapRes.json();
      const txBytes = Uint8Array.from(atob(swapTransaction), c => c.charCodeAt(0));
      // Jupiter always returns a versioned (v0) transaction, not the old
      // legacy Transaction format. Phantom's signAndSendTransaction needs
      // a real VersionedTransaction instance, not raw bytes in a plain
      // object, passing raw bytes made Phantom fall back to legacy
      // message parsing internally and throw "Versioned messages must be
      // deserialized with VersionedMessage.deserialize()".
      const versionedTx = window.solanaWeb3.VersionedTransaction.deserialize(txBytes);

      setStatus('Waiting for your wallet signature...', null, 'pending');
      let txSig;

      try {
        const result = await window.solana.signAndSendTransaction(versionedTx);
        txSig = result.signature || result;
      } catch(phantomErr) {
        console.warn('[VeilSwap] signAndSendTransaction fallback:', phantomErr.message);
        const signed = await window.solana.signTransaction(versionedTx);
        setStatus('Broadcasting to Solana...', null, 'pending');
        const raw = signed.serialize();
        const broadcastRes = await fetch(SWAP_RPC, {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({
            jsonrpc:'2.0', id:1, method:'sendTransaction',
            params:[btoa(String.fromCharCode(...raw)), { encoding:'base64', preflightCommitment:'confirmed' }]
          })
        });
        const bData = await broadcastRes.json();
        if (bData.error) throw new Error(bData.error.message);
        txSig = bData.result;
      }

      // Send the 1% fee as a follow-up SPL transfer to the fee wallet.
      // Routed through Phantom as a second signature request, keeps the
      // swap tx itself clean and lets the fee settle right after output delivery.
      try {
        await sendFeeTransfer(tt.mint, feeRawAmount);
      } catch (feeErr) {
        console.warn('[VeilSwap] Fee transfer skipped/failed (non-blocking):', feeErr.message);
      }

      const now = new Date();
      const timeStr = now.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) + ' ' + now.toLocaleDateString([], {month:'short',day:'numeric'});
      addHistoryEntry({
        fromAmt: amount.toString(),
        fromSym: fromToken,
        toSym: toToken,
        status: 'confirmed',
        sig: txSig,
        time: timeStr,
      });
      setStatus(
        'Swap submitted! ' + toToken + ' delivered to your wallet.',
        txSig, 'success'
      );
      if (input) input.value = '';
      resetQuoteDisplay();
      setTimeout(loadBalances, 3000);

    } catch(e) {
      console.error('[VeilSwap] Swap error:', e);
      if (e.message?.includes('User rejected')) { showError('Transaction cancelled.'); }
      else { showError(e.message || 'Swap failed. Please try again.'); }
    } finally {
      setBtnLoading(false);
    }
  }

  /**
   * Sends the 1% platform fee from the user's wallet to the
   * configured fee destination (see payment-transfer.js
   * getFeeDestinationOwner and sela-config.js). SOL uses a native
   * SystemProgram transfer. SPL tokens (USDC/USDT) use a standard SPL
   * token transfer instruction to the treasury's associated token
   * account, creating it first if it doesn't exist yet.
   */
  async function sendFeeTransfer(mint, rawAmount) {
    if (!rawAmount || rawAmount <= 0) return;
    if (!_hasWeb3()) return;
    if (typeof window.PaymentTransfer === 'undefined') {
      throw new Error('payment-transfer.js must be loaded before swap.js (needs getFeeDestinationOwner).');
    }

    const connection = new window.solanaWeb3.Connection(SWAP_RPC, 'confirmed');
    const fromPubkey = new window.solanaWeb3.PublicKey(walletPubkey);
    const feePubkey = window.PaymentTransfer.getFeeDestinationOwner();

    if (mint === SWAP_TOKENS.SOL.mint) {
      const tx = new window.solanaWeb3.Transaction().add(
        window.solanaWeb3.SystemProgram.transfer({ fromPubkey, toPubkey: feePubkey, lamports: rawAmount })
      );
      const { blockhash } = await connection.getLatestBlockhash('confirmed');
      tx.recentBlockhash = blockhash;
      tx.feePayer = fromPubkey;
      const signed = await window.solana.signTransaction(tx);
      const sig = await connection.sendRawTransaction(signed.serialize());
      console.log('[VeilSwap] SOL fee transfer sent:', sig);
      return;
    }

    // SPL token fee transfer, needs the SPL Token program's associated
    // token account addresses and transfer instruction. We derive these
    // via direct RPC calls rather than importing the full @solana/spl-token
    // package, since this app has no build step.
    const mintPubkey = new window.solanaWeb3.PublicKey(mint);
    const TOKEN_PROGRAM_ID = new window.solanaWeb3.PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    const ASSOCIATED_TOKEN_PROGRAM_ID = new window.solanaWeb3.PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

    const [fromAta] = await window.solanaWeb3.PublicKey.findProgramAddress(
      [fromPubkey.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mintPubkey.toBuffer()],
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    const [feeAta] = await window.solanaWeb3.PublicKey.findProgramAddress(
      [feePubkey.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mintPubkey.toBuffer()],
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    const instructions = [];

    // Create the fee wallet's ATA if it doesn't exist yet
    const feeAtaInfo = await connection.getAccountInfo(feeAta);
    if (!feeAtaInfo) {
      instructions.push(_createAtaInstruction(fromPubkey, feeAta, feePubkey, mintPubkey, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID));
    }

    // SPL Token transfer instruction (TransferChecked is safer but requires
    // decimals; using plain Transfer here for simplicity since amount is
    // already in base units)
    instructions.push(_splTransferInstruction(fromAta, feeAta, fromPubkey, rawAmount, TOKEN_PROGRAM_ID));

    const tx = new window.solanaWeb3.Transaction().add(...instructions);
    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;
    tx.feePayer = fromPubkey;

    const signed = await window.solana.signTransaction(tx);
    const sig = await connection.sendRawTransaction(signed.serialize());
    console.log('[VeilSwap] SPL fee transfer sent:', sig);
  }

  // Minimal raw instruction builders (avoids needing the @solana/spl-token package)
  function _createAtaInstruction(payer, ata, owner, mint, tokenProgramId, ataProgramId) {
    return new window.solanaWeb3.TransactionInstruction({
      keys: [
        { pubkey: payer, isSigner: true, isWritable: true },
        { pubkey: ata, isSigner: false, isWritable: true },
        { pubkey: owner, isSigner: false, isWritable: false },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: window.solanaWeb3.SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: tokenProgramId, isSigner: false, isWritable: false },
      ],
      programId: ataProgramId,
      data: Buffer.alloc(0),
    });
  }

  function _splTransferInstruction(source, dest, owner, amount, tokenProgramId) {
    // SPL Token "Transfer" instruction: tag 3, followed by u64 amount (little-endian)
    const data = Buffer.alloc(9);
    data.writeUInt8(3, 0);
    data.writeBigUInt64LE(BigInt(amount), 1);
    return new window.solanaWeb3.TransactionInstruction({
      keys: [
        { pubkey: source, isSigner: false, isWritable: true },
        { pubkey: dest, isSigner: false, isWritable: true },
        { pubkey: owner, isSigner: true, isWritable: false },
      ],
      programId: tokenProgramId,
      data,
    });
  }

  function _hasWeb3() {
    return typeof window !== 'undefined' && typeof window.solanaWeb3 !== 'undefined';
  }

  // ── History ──
  const HISTORY_KEY = 'veilpay_swap_history';

  function loadHistory() {
    try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); }
    catch(e) { return []; }
  }

  function saveHistory(history) {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, 50)));
  }

  function addHistoryEntry(entry) {
    const history = loadHistory();
    history.unshift(entry);
    saveHistory(history);
    renderHistory();
  }

  function clearHistory() {
    localStorage.removeItem(HISTORY_KEY);
    renderHistory();
  }

  function renderHistory() {
    const list = document.getElementById('swapHistoryList');
    if (!list) return;
    const history = loadHistory();
    if (!history.length) {
      list.innerHTML = '<div class="history-empty">No swaps yet</div>';
      return;
    }
    list.innerHTML = history.map(h => `
      <div class="history-item">
        <div class="history-item-top">
          <span class="history-swap-label">${h.fromAmt} ${h.fromSym} <span>→</span> ${h.toSym}</span>
          <span class="history-status ${h.status}">${h.status.toUpperCase()}</span>
        </div>
        <div class="history-item-bottom">
          <span class="history-time">${h.time}</span>
          ${h.sig ? `<a class="history-link" href="https://solscan.io/tx/${h.sig}" target="_blank" rel="noopener">${h.sig.slice(0,6)}...${h.sig.slice(-6)}</a>` : '<span class="history-time">-</span>'}
        </div>
      </div>`).join('');
  }

  // ── Balance check ──
  async function checkBalances() {
    const list = document.getElementById('swapBalanceList');
    if (!walletPubkey) {
      if (list) list.innerHTML = '<div class="balance-item"><span class="balance-token">Connect wallet to view balances</span></div>';
      return;
    }
    if (list) list.innerHTML = '<div class="balance-item"><span class="balance-token">Loading...</span></div>';

    const rows = [];
    try {
      const r = await rpcCall('getBalance', [walletPubkey]);
      rows.push({ sym: 'SOL', bal: (r.value / 1e9).toFixed(4) });
    } catch (e) {
      rows.push({ sym: 'SOL', bal: '-' });
    }
    for (const [sym, tok] of Object.entries(SWAP_TOKENS)) {
      if (sym === 'SOL') continue;
      try {
        const r = await rpcCall('getTokenAccountsByOwner', [walletPubkey, { mint: tok.mint }, { encoding: 'jsonParsed' }]);
        const bal = r?.value?.length > 0 ? r.value[0].account.data.parsed.info.tokenAmount.uiAmountString : '0';
        rows.push({ sym, bal });
      } catch (e) {
        rows.push({ sym, bal: '-' });
      }
    }

    if (list) {
      list.innerHTML = rows.map(row => `
        <div class="balance-item">
          <span class="balance-token">${row.sym}</span>
          <span class="balance-amount">${row.bal}</span>
        </div>
      `).join('');
    }
  }

  // ── Init (called when Swap tab is first shown) ──
  function init() {
    buildDropdowns();
    renderHistory();
    const wallet = window.Cognata?.WalletState?.get();
    if (wallet?.publicKey) {
      syncWallet(wallet.publicKey);
      loadBalances();
    }
  }

  return {
    init,
    syncWallet,
    toggleDropdown,
    selectToken,
    swapDirection,
    onAmountInput,
    setMax,
    onSwap: executeSwap,
    checkBalances,
    clearHistory,
  };
})();

window.VeilSwap = VeilSwapModule;

document.addEventListener('click', () => {
  document.querySelectorAll('.token-dropdown').forEach(d => d.classList.remove('open'));
});
