/**
 * VeilPay Wallet Adapter
 * Made by TJS Code
 *
 * Multi-wallet support for Phantom, Solflare, and Backpack, plus generic
 * detection of any other wallet that implements the Solana Wallet Standard
 * (github.com/wallet-standard/wallet-standard, the same discovery mechanism
 * @solana/wallet-adapter-base uses under the hood).
 *
 * This project has no build step (see README), so rather than pulling in
 * @solana/wallet-adapter-react/base via a bundler, this hand-rolls the two
 * discovery mechanisms those packages use:
 *
 *   1. Legacy injected globals (window.solana / window.solflare /
 *      window.backpack). Phantom, Solflare, and Backpack all still expose
 *      these, and they already speak the exact interface the rest of
 *      VeilPay was built around (.connect(), .signTransaction(tx),
 *      .publicKey), so this path needs no translation layer and is the
 *      one actually exercised for the three named wallets.
 *
 *   2. The Wallet Standard's window event protocol, for any wallet that
 *      does NOT expose a legacy global. This path is included for
 *      completeness and has NOT been live-tested against a real
 *      Wallet-Standard-only wallet in this environment. Signing goes
 *      through the wallet's `solana:signTransaction` feature instead of
 *      a plain `.signTransaction(tx)` call, verify this against a real
 *      wallet before relying on it for anything beyond Phantom/Solflare/
 *      Backpack, which don't need it.
 */

const VeilWalletAdapter = (() => {
  const KNOWN_WALLETS = [
    {
      name: 'Phantom',
      color: '#AB9FF2',
      installUrl: 'https://phantom.app/',
      // Universal link into Phantom's own in-app browser, where the
      // window.phantom provider actually exists on mobile. A plain
      // install link is useless to someone who already has the app.
      mobileDeepLink: (url) => `https://phantom.app/ul/browse/${encodeURIComponent(url)}?ref=${encodeURIComponent(location.origin)}`,
      getProvider: () => {
        const p = window.phantom?.solana || window.solana;
        return p?.isPhantom ? p : null;
      },
    },
    {
      name: 'Solflare',
      color: '#FC9965',
      installUrl: 'https://solflare.com/',
      mobileDeepLink: (url) => `https://solflare.com/ul/v1/browse/${encodeURIComponent(url)}?ref=${encodeURIComponent(location.origin)}`,
      getProvider: () => (window.solflare?.isSolflare ? window.solflare : null),
    },
    {
      name: 'Backpack',
      color: '#E33E3F',
      installUrl: 'https://backpack.app/',
      // No verified public universal-link scheme for Backpack's in-app
      // browser, don't guess at one, fall back to the plain install link.
      mobileDeepLink: null,
      getProvider: () => {
        const p = window.backpack || window.xnft?.solana;
        return p?.isBackpack || p ? p : null;
      },
    },
  ];

  function _isMobile() {
    return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '');
  }

  // ── Wallet Standard discovery (fallback path, see note above) ──
  const _standardWallets = new Map();

  function _registerStandardWallet(wallet) {
    if (!wallet?.name || !wallet?.chains?.some(c => c.startsWith('solana:'))) return;
    _standardWallets.set(wallet.name, wallet);
  }

  function _initStandardDiscovery() {
    try {
      window.addEventListener('wallet-standard:register-wallet', (event) => {
        // Some wallet extensions dispatch this event with a detail shape
        // that doesn't match the Wallet Standard spec (detail.register
        // should always be a function). Guard instead of letting every
        // such wallet throw on every page load; logged once per event so
        // it's still visible which extension is non-compliant.
        if (typeof event.detail?.register !== 'function') {
          console.warn('[VeilWallet] Ignoring non-compliant register-wallet event (detail.register is not a function):', event.detail);
          return;
        }
        try { event.detail.register(_registerStandardWallet); } catch (err) { console.warn('[VeilWallet] register-wallet handler failed:', err); }
      });
      window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', {
        detail: { register: _registerStandardWallet },
      }));
      const existing = window.navigator?.wallets?.get?.();
      if (Array.isArray(existing)) existing.forEach(_registerStandardWallet);
    } catch (err) {
      console.warn('[VeilWallet] Wallet Standard discovery unavailable:', err);
    }
  }
  _initStandardDiscovery();

  function getAvailableWallets() {
    const found = [];
    const seen = new Set();
    for (const w of KNOWN_WALLETS) {
      const provider = w.getProvider();
      if (provider && !seen.has(w.name)) {
        found.push({ name: w.name, color: w.color, kind: 'legacy', provider });
        seen.add(w.name);
      }
    }
    for (const [name, wallet] of _standardWallets) {
      if (!seen.has(name)) {
        found.push({ name, color: '#F59E0B', kind: 'standard', wallet });
        seen.add(name);
      }
    }
    return found;
  }

  function getNotInstalledWallets() {
    const available = new Set(getAvailableWallets().map(w => w.name));
    return KNOWN_WALLETS.filter(w => !available.has(w.name));
  }

  /** Re-fetch a live provider by wallet name, used to restore a session after reload. */
  function getEntryByName(name) {
    return getAvailableWallets().find(w => w.name === name) || null;
  }

  // Minimal base58 encoder for Wallet Standard public key bytes, kept local
  // since veil-engine.js's copy is private to its own module and this file
  // has no shared-utils file to pull it from (no build step, no bundler).
  const _B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  function _base58Encode(bytes) {
    let digits = [0];
    for (let i = 0; i < bytes.length; i++) {
      let carry = bytes[i];
      for (let j = 0; j < digits.length; j++) {
        carry += digits[j] << 8;
        digits[j] = carry % 58;
        carry = (carry / 58) | 0;
      }
      while (carry > 0) { digits.push(carry % 58); carry = (carry / 58) | 0; }
    }
    let leadingZeros = 0;
    for (let i = 0; i < bytes.length && bytes[i] === 0; i++) leadingZeros++;
    let result = '1'.repeat(leadingZeros);
    for (let i = digits.length - 1; i >= 0; i--) result += _B58[digits[i]];
    return result;
  }

  async function connect(entry) {
    if (entry.kind === 'legacy') {
      const resp = await entry.provider.connect();
      const publicKey = (resp?.publicKey || entry.provider.publicKey)?.toString();
      if (!publicKey) throw new Error(`${entry.name} did not return a public key.`);
      return { publicKey, provider: entry.provider, walletName: entry.name };
    }

    // Wallet Standard path, see the file-level note on verification status.
    const connectFeature = entry.wallet.features['standard:connect'];
    const signTxFeature = entry.wallet.features['solana:signTransaction'];
    if (!connectFeature || !signTxFeature) {
      throw new Error(`${entry.name} doesn't support the features VeilPay needs.`);
    }
    await connectFeature.connect();
    const account = entry.wallet.accounts[0];
    if (!account) throw new Error(`${entry.name} did not return an account.`);
    const publicKey = _base58Encode(account.publicKey);

    // Wrap into the same shape veil-engine.js already expects from a legacy
    // provider, so the rest of the app doesn't need two code paths.
    const provider = {
      publicKey: { toString: () => publicKey },
      isConnected: true,
      signTransaction: async (transaction) => {
        const serialized = transaction.serialize({ requireAllSignatures: false });
        const results = await signTxFeature.signTransaction({ account, transaction: serialized });
        const signedBytes = results?.[0]?.signedTransaction;
        if (!signedBytes) throw new Error(`${entry.name} did not return a signed transaction.`);
        return window.solanaWeb3.Transaction.from(signedBytes);
      },
    };
    return { publicKey, provider, walletName: entry.name };
  }

  // ── Picker modal (injected once, shared by every page that loads this file) ──
  const MODAL_ID = 'veilWalletPickerModal';

  // Simple original glyphs, not traced copies of any wallet's trademarked
  // logo, just a recognizable shape per wallet instead of a letter avatar.
  const WALLET_ICON_PATHS = {
    Phantom: '<path d="M12 3c-4.4 0-8 3.6-8 8v6.5c0 .8.7 1.5 1.5 1.5.5 0 1-.3 1.3-.7l1-1.4c.3.6.9 1 1.6 1s1.3-.4 1.6-1c.3.6.9 1 1.6 1s1.3-.4 1.6-1c.3.6.9 1 1.6 1 .7 0 1.3-.4 1.6-1l1 1.4c.3.4.8.7 1.3.7.8 0 1.5-.7 1.5-1.5V11c0-4.4-3.6-8-8-8Z" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="9.5" cy="11" r="1.2" fill="currentColor"/><circle cx="14.5" cy="11" r="1.2" fill="currentColor"/>',
    Solflare: '<circle cx="12" cy="12" r="3.2" fill="currentColor"/><g stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M12 3.5v2.4"/><path d="M12 18.1v2.4"/><path d="M3.5 12h2.4"/><path d="M18.1 12h2.4"/><path d="M6.3 6.3l1.7 1.7"/><path d="M16 16l1.7 1.7"/><path d="M17.7 6.3L16 8"/><path d="M8 16l-1.7 1.7"/></g>',
    Backpack: '<path d="M8 8V6.5a4 4 0 0 1 8 0V8" fill="none" stroke="currentColor" stroke-width="1.5"/><rect x="5.5" y="8" width="13" height="12" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M9 12h6v4H9z" fill="none" stroke="currentColor" stroke-width="1.5"/>',
  };

  function _walletIconHtml(name, color) {
    const path = WALLET_ICON_PATHS[name] || '<circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" stroke-width="1.5"/>';
    return `<div class="wallet-picker-icon" style="background:${color}22;color:${color};border-color:${color}44;">
      <svg viewBox="0 0 24 24" width="20" height="20" xmlns="http://www.w3.org/2000/svg">${path}</svg>
    </div>`;
  }

  function _ensureModal() {
    if (document.getElementById(MODAL_ID)) return;
    const overlay = document.createElement('div');
    overlay.id = MODAL_ID;
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" style="max-width:380px;">
        <div class="modal-header">
          <span class="modal-title">Connect a wallet</span>
          <button class="modal-close" onclick="VeilWalletAdapter.hidePicker()">
            <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
        <div id="veilWalletPickerList" class="wallet-picker-list"></div>
      </div>
    `;
    document.body.appendChild(overlay);
  }

  let _onConnectCallback = null;

  function showPicker({ onConnect } = {}) {
    _ensureModal();
    _onConnectCallback = onConnect || null;
    const list = document.getElementById('veilWalletPickerList');
    const available = getAvailableWallets();
    const notInstalled = getNotInstalledWallets();

    let html = '';
    if (available.length === 0) {
      html += `<div class="wallet-picker-empty">No Solana wallet detected in this browser. Install one below to continue.</div>`;
    } else {
      html += available.map(w => `
        <button class="wallet-picker-row" onclick="VeilWalletAdapter._handlePick('${w.name}')">
          ${_walletIconHtml(w.name, w.color)}
          <span class="wallet-picker-name">${w.name}</span>
          <span class="wallet-picker-tag">Detected</span>
        </button>
      `).join('');
    }
    if (notInstalled.length > 0) {
      html += `<div class="wallet-picker-divider"></div>`;
      const onMobile = _isMobile();
      html += notInstalled.map(w => {
        const deepLink = onMobile && w.mobileDeepLink ? w.mobileDeepLink(window.location.href) : null;
        const href = deepLink || w.installUrl;
        const label = deepLink ? 'Open app' : 'Install';
        return `
        <a class="wallet-picker-row wallet-picker-row-install" href="${href}" target="_blank" rel="noopener">
          ${_walletIconHtml(w.name, w.color)}
          <span class="wallet-picker-name">${w.name}</span>
          <span class="wallet-picker-tag wallet-picker-tag-install">${label}</span>
        </a>
      `;
      }).join('');
      if (onMobile) {
        html += `<div class="wallet-picker-empty" style="padding-top:0.5rem;font-size:0.75rem;">Already have the app? Tap it above to open this page inside it.</div>`;
      }
    }
    list.innerHTML = html;
    document.getElementById(MODAL_ID).classList.add('active');
  }

  function hidePicker() {
    const overlay = document.getElementById(MODAL_ID);
    if (overlay) overlay.classList.remove('active');
  }

  async function _handlePick(name) {
    const entry = getEntryByName(name);
    if (!entry) return;
    hidePicker();
    if (_onConnectCallback) await _onConnectCallback(entry);
  }

  return {
    getAvailableWallets,
    getNotInstalledWallets,
    getEntryByName,
    connect,
    showPicker,
    hidePicker,
    _handlePick,
  };
})();

window.VeilWalletAdapter = VeilWalletAdapter;
