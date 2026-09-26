/**
 * VeilPay, Wallet Risk Scanner
 * Uses Helius RPC + public Solana data for on-chain heuristics
 * Made by TJS Code
 */

const WalletScanner = (() => {

  const HELIUS_RPC = 'https://api.devnet.solana.com';
  const KNOWN_SCAM_PATTERNS = [
    'pump', 'rug', 'scam', 'fake', 'honeypot'
  ];

  async function rpc(method, params = []) {
    const res = await fetch(HELIUS_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
    });
    const json = await res.json();
    if (json.error) throw new Error(json.error.message);
    return json.result;
  }

  async function scanWallet(address) {
    const result = {
      address,
      risk: 'UNKNOWN',
      score: 0, // 0 = safe, 100 = high risk
      flags: [],
      stats: {},
      scannedAt: new Date().toISOString()
    };

    try {
      // Validate address format
      if (!address || address.length < 32 || address.length > 44) {
        result.risk = 'INVALID';
        result.flags.push({ type: 'error', msg: 'Invalid wallet address format' });
        return result;
      }

      // 1. Check account exists + get balance
      const accountInfo = await rpc('getAccountInfo', [address, { encoding: 'base64' }]);
      const balanceResult = await rpc('getBalance', [address]);
      const balanceSol = (balanceResult?.value ?? 0) / 1e9;
      result.stats.balance = balanceSol.toFixed(4) + ' SOL';

      if (!accountInfo?.value) {
        result.flags.push({ type: 'warn', msg: 'New or empty account, no on-chain history' });
        result.score += 15;
      }

      // 2. Get recent transaction signatures
      const sigs = await rpc('getSignaturesForAddress', [address, { limit: 20 }]);
      const txCount = sigs?.length ?? 0;
      result.stats.recentTxCount = txCount;

      if (txCount === 0) {
        result.flags.push({ type: 'warn', msg: 'No transaction history found' });
        result.score += 20;
      }

      // 3. Check for failed transactions (spam/bot pattern)
      const failedTxs = sigs?.filter(s => s.err !== null) ?? [];
      const failRate = txCount > 0 ? failedTxs.length / txCount : 0;
      result.stats.failedTxs = failedTxs.length;

      if (failRate > 0.5 && txCount > 5) {
        result.flags.push({ type: 'danger', msg: `High failed transaction rate (${Math.round(failRate * 100)}%), possible bot or spam wallet` });
        result.score += 30;
      }

      // 4. Check account age via oldest transaction
      if (sigs?.length > 0) {
        const oldest = sigs[sigs.length - 1];
        if (oldest.blockTime) {
          const ageMs = Date.now() - (oldest.blockTime * 1000);
          const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));
          result.stats.walletAgeDays = ageDays;
          if (ageDays < 3) {
            result.flags.push({ type: 'warn', msg: `Very new wallet, created ${ageDays} day(s) ago` });
            result.score += 20;
          }
        }
      }

      // 5. Low balance warning
      if (balanceSol < 0.001) {
        result.flags.push({ type: 'warn', msg: 'Near-zero SOL balance, may not be able to cover fees' });
        result.score += 10;
      }

      // 6. Assign final risk level
      if (result.score === 0) {
        result.risk = 'LOW';
        result.flags.push({ type: 'safe', msg: 'No suspicious patterns detected' });
      } else if (result.score < 25) {
        result.risk = 'LOW';
      } else if (result.score < 55) {
        result.risk = 'MEDIUM';
      } else {
        result.risk = 'HIGH';
      }

    } catch (err) {
      result.risk = 'ERROR';
      result.flags.push({ type: 'error', msg: 'Could not complete scan: ' + (err.message || 'Network error') });
    }

    return result;
  }

  function getRiskColor(risk) {
    const map = {
      LOW: '#10b981',
      MEDIUM: '#f59e0b',
      HIGH: '#ef4444',
      UNKNOWN: '#6b7280',
      INVALID: '#ef4444',
      ERROR: '#6b7280'
    };
    return map[risk] || '#6b7280';
  }

  function getRiskBg(risk) {
    const map = {
      LOW: 'rgba(16,185,129,0.1)',
      MEDIUM: 'rgba(245,158,11,0.1)',
      HIGH: 'rgba(239,68,68,0.1)',
      UNKNOWN: 'rgba(107,114,128,0.1)',
      INVALID: 'rgba(239,68,68,0.1)',
      ERROR: 'rgba(107,114,128,0.1)'
    };
    return map[risk] || 'rgba(107,114,128,0.1)';
  }

  function getFlagIcon(type) {
    const icons = {
      safe:   `<svg width="13" height="13" fill="none" viewBox="0 0 24 24" stroke="#10b981" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`,
      warn:   `<svg width="13" height="13" fill="none" viewBox="0 0 24 24" stroke="#f59e0b" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
      danger: `<svg width="13" height="13" fill="none" viewBox="0 0 24 24" stroke="#ef4444" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`,
      error:  `<svg width="13" height="13" fill="none" viewBox="0 0 24 24" stroke="#6b7280" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`
    };
    return icons[type] || icons.error;
  }

  function renderResult(result) {
    const color = getRiskColor(result.risk);
    const bg = getRiskBg(result.risk);

    const statsHtml = Object.entries(result.stats).map(([k, v]) => {
      const labels = {
        balance: 'Balance',
        recentTxCount: 'Recent Txs',
        failedTxs: 'Failed Txs',
        walletAgeDays: 'Wallet Age'
      };
      const vals = k === 'walletAgeDays' ? v + ' days' : v;
      return `
        <div class="scanner-stat">
          <div class="scanner-stat-label">${labels[k] || k}</div>
          <div class="scanner-stat-value">${vals}</div>
        </div>`;
    }).join('');

    const flagsHtml = result.flags.map(f => `
      <div class="scanner-flag scanner-flag-${f.type}">
        ${getFlagIcon(f.type)}
        <span>${f.msg}</span>
      </div>`).join('');

    return `
      <div class="scanner-result" style="animation: fadeSlideIn 0.3s ease">
        <div class="scanner-risk-header" style="background:${bg};border-color:${color}30;">
          <div>
            <div class="scanner-risk-label">RISK LEVEL</div>
            <div class="scanner-risk-level" style="color:${color}">${result.risk}</div>
          </div>
          <div class="scanner-risk-score" style="color:${color};border-color:${color}40;background:${color}15;">
            ${result.score}/100
          </div>
        </div>
        ${statsHtml ? `<div class="scanner-stats">${statsHtml}</div>` : ''}
        <div class="scanner-flags">${flagsHtml}</div>
        <div class="scanner-address">
          <span style="color:var(--text-muted);font-size:0.72rem;">SCANNED</span>
          <span style="font-family:var(--font-mono);font-size:0.72rem;color:var(--text-dim);">${result.address.slice(0,8)}...${result.address.slice(-8)}</span>
        </div>
      </div>`;
  }

  return { scanWallet, renderResult, getRiskColor };
})();

window.WalletScanner = WalletScanner;
