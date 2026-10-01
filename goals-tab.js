/**
 * Goals tab controller. Wires the Goals pane in dashboard.html to
 * program-client.js (instruction building + account decoding),
 * passkey-client.js (WebAuthn) and veil-engine.js (dual-send
 * submission). Knows nothing about invoicing or swap, those stay in
 * app.js/swap.js.
 *
 * State for "which goal is mine" (vault/goal addresses, which
 * passkey credential to use) is kept in localStorage, per connected
 * wallet, this is just a pointer, never the balance. Every number
 * shown on screen is read fresh from the chain, see refreshBalance().
 *
 * Made by TJS Code
 */

const GoalsTab = (() => {
  const STORAGE_PREFIX = 'sela_goal_pointer_';
  let initialized = false;
  let connectionCache = null;

  function _web3() { return window.solanaWeb3; }

  function _getConnection() {
    if (connectionCache) return connectionCache;
    const cfg = window.SELA_CONFIG;
    const url = cfg.PROGRAM_CLUSTER === 'mainnet-beta' ? '/api/rpc' : `https://api.${cfg.PROGRAM_CLUSTER}.solana.com`;
    connectionCache = new (_web3().Connection)(url, 'confirmed');
    return connectionCache;
  }

  function _bytesToB64(bytes) {
    let bin = ''; for (const b of bytes) bin += String.fromCharCode(b); return btoa(bin);
  }
  function _b64ToBytes(b64) {
    const bin = atob(b64); const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function _formatAmount(baseUnits, decimals) {
    return (Number(baseUnits) / 10 ** decimals).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function _storePointer(walletPubkey, pointer) {
    localStorage.setItem(STORAGE_PREFIX + walletPubkey, JSON.stringify(pointer));
  }
  function _getPointer(walletPubkey) {
    const raw = localStorage.getItem(STORAGE_PREFIX + walletPubkey);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }

  function _showOnly(id) {
    ['goalsNotDeployed', 'goalsLoading', 'goalsNeedWallet', 'goalsEmpty', 'goalsCreateForm', 'goalsActive', 'goalsContributeForm', 'goalsWithdrawForm']
      .forEach((x) => { const el = document.getElementById(x); if (el) el.style.display = x === id ? '' : 'none'; });
  }

  async function _programIsDeployed() {
    const cfg = window.SELA_CONFIG;
    try {
      const info = await _getConnection().getAccountInfo(new (_web3().PublicKey)(cfg.PROGRAM_ID));
      return !!info && info.executable;
    } catch (err) {
      console.error('[Goals] cluster check failed:', err.message);
      return false;
    }
  }

  async function refresh() {
    const clusterNameEl = document.getElementById('goalsClusterName');
    if (clusterNameEl) clusterNameEl.textContent = window.SELA_CONFIG.PROGRAM_CLUSTER;

    _showOnly('goalsLoading');

    const deployed = await _programIsDeployed();
    if (!deployed) { _showOnly('goalsNotDeployed'); return; }

    const wallet = window.Cognata?.WalletState?.get();
    if (!wallet?.publicKey) { _showOnly('goalsNeedWallet'); return; }

    const pointer = _getPointer(wallet.publicKey);
    if (!pointer) { _showOnly('goalsEmpty'); return; }

    await _showActiveGoal(pointer);
  }

  async function _showActiveGoal(pointer) {
    _showOnly('goalsActive');
    document.getElementById('goalActiveName').textContent = pointer.name || 'Goal';
    const currentEl = document.getElementById('goalCurrentAmount');
    const targetEl = document.getElementById('goalTargetAmount');
    currentEl.textContent = 'Loading\u2026';
    currentEl.classList.remove('accent');
    targetEl.textContent = '-';

    try {
      const info = await _getConnection().getAccountInfo(new (_web3().PublicKey)(pointer.goalPda));
      if (!info) { currentEl.textContent = 'Goal not found on chain'; return; }
      const goal = window.CognataProgram.decodeSavingsGoal(info.data);
      const decimals = window.SELA_CONFIG.GOAL_MINT_DECIMALS;
      currentEl.textContent = _formatAmount(goal.currentAmount, decimals) + ' USDC';
      targetEl.textContent = _formatAmount(goal.targetAmount, decimals);
      // Amber marks a number worth noticing: any real progress.
      // A goal that is still at zero gets plain text, nothing to
      // draw the eye to yet.
      currentEl.classList.toggle('accent', goal.currentAmount > 0n);
      if (goal.status !== 'Active') {
        currentEl.textContent += ` (${goal.status})`;
      }
    } catch (err) {
      currentEl.textContent = 'Could not load balance';
      console.error('[Goals] balance fetch failed:', err.message);
    }
  }

  // ---- Create goal ----

  function showGoalCreateForm() { _showOnly('goalsCreateForm'); }
  function hideGoalCreateForm() { refresh(); }

  async function handleCreateGoal() {
    const name = document.getElementById('goalName').value.trim();
    const targetStr = document.getElementById('goalTarget').value.trim();
    const target = parseFloat(targetStr);

    if (!name) return window.Cognata.showToast('Name the goal.', 'red');
    if (!target || target <= 0) return window.Cognata.showToast('Enter a target amount above 0.', 'red');

    const wallet = window.Cognata.WalletState.get();
    if (!wallet?.publicKey) return window.Cognata.showToast('Connect your wallet first.', 'red');

    const btn = document.getElementById('goalCreateBtn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner" style="width:15px;height:15px;"></span> Registering passkey\u2026';

    try {
      const { compressedPubkey, credentialId } = await window.PasskeyClient.registerPasskey({ label: name });

      btn.innerHTML = '<span class="spinner" style="width:15px;height:15px;"></span> Creating goal\u2026';
      const decimals = window.SELA_CONFIG.GOAL_MINT_DECIMALS;
      const targetBaseUnits = BigInt(Math.round(target * 10 ** decimals));

      const result = await window.VeilEngine.createGoal({
        payerWallet: wallet.publicKey,
        primaryDeviceCompressedPubkey: compressedPubkey,
        guardianPubkey: wallet.publicKey, // v1: creator doubles as guardian unless changed later
        feeTier: 0, // Standard
        name,
        targetAmountBaseUnits: targetBaseUnits,
        currency: 1, // Usdc
        deadlineUnixSeconds: 0, // no deadline
        mint: window.SELA_CONFIG.GOAL_MINT,
      });

      window.PasskeyClient.rememberCredentialForVault(result.vaultPda, credentialId);
      _storePointer(wallet.publicKey, {
        vaultPda: result.vaultPda,
        goalPda: result.goalPda,
        goalTokenAccount: result.goalTokenAccount,
        mint: window.SELA_CONFIG.GOAL_MINT,
        name,
        credentialId: _bytesToB64(credentialId),
        compressedPubkey33: _bytesToB64(compressedPubkey),
        deviceRole: 0,
      });

      window.Cognata.showToast('Goal created.', 'green');
      document.getElementById('goalName').value = '';
      document.getElementById('goalTarget').value = '';
      await refresh();
    } catch (err) {
      window.Cognata.showToast('Could not create goal: ' + (err.message || 'Unknown error'), 'red');
    }
    btn.disabled = false;
    btn.innerHTML = 'Create Goal';
  }

  // ---- Contribute / withdraw ----

  function showGoalContributeForm() { _showOnly('goalsContributeForm'); }
  function showGoalWithdrawForm() { _showOnly('goalsWithdrawForm'); }
  function hideGoalForms() { refresh(); }

  async function _getTokenAccountForWallet(walletPubkey, mint) {
    return window.CognataProgram.getAssociatedTokenAddress(
      new (_web3().PublicKey)(walletPubkey),
      new (_web3().PublicKey)(mint),
    );
  }

  async function handleContribute() {
    const amountStr = document.getElementById('contributeAmount').value.trim();
    const amount = parseFloat(amountStr);
    if (!amount || amount <= 0) return window.Cognata.showToast('Enter an amount above 0.', 'red');

    const wallet = window.Cognata.WalletState.get();
    const pointer = _getPointer(wallet.publicKey);
    if (!pointer) return window.Cognata.showToast('No goal found for this wallet.', 'red');

    const btn = document.getElementById('goalContributeBtn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner" style="width:15px;height:15px;"></span> Waiting for passkey\u2026';

    try {
      const decimals = window.SELA_CONFIG.GOAL_MINT_DECIMALS;
      const contributorTokenAccount = await _getTokenAccountForWallet(wallet.publicKey, pointer.mint);

      await window.VeilEngine.contributeToGoal({
        payerWallet: wallet.publicKey,
        vaultPda: pointer.vaultPda,
        goalPda: pointer.goalPda,
        goalTokenAccount: pointer.goalTokenAccount,
        mint: pointer.mint,
        contributorTokenAccount,
        deviceRole: pointer.deviceRole,
        amountBaseUnits: BigInt(Math.round(amount * 10 ** decimals)),
        decimals,
        credentialId: _b64ToBytes(pointer.credentialId),
        compressedPubkey33: _b64ToBytes(pointer.compressedPubkey33),
        onProgress: (step) => { btn.innerHTML = `<span class="spinner" style="width:15px;height:15px;"></span> ${step === 'transferring' ? 'Submitting\u2026' : 'Building\u2026'}`; },
      });

      window.Cognata.showToast('Contribution confirmed.', 'green');
      document.getElementById('contributeAmount').value = '';
      await refresh();
    } catch (err) {
      window.Cognata.showToast('Contribution failed: ' + (err.message || 'Unknown error'), 'red');
      btn.disabled = false;
      btn.innerHTML = 'Approve &amp; Contribute';
    }
  }

  async function handleWithdraw() {
    const amountStr = document.getElementById('withdrawAmount').value.trim();
    const amount = parseFloat(amountStr);
    if (!amount || amount <= 0) return window.Cognata.showToast('Enter an amount above 0.', 'red');

    const wallet = window.Cognata.WalletState.get();
    const pointer = _getPointer(wallet.publicKey);
    if (!pointer) return window.Cognata.showToast('No goal found for this wallet.', 'red');

    const btn = document.getElementById('goalWithdrawBtn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner" style="width:15px;height:15px;"></span> Waiting for passkey\u2026';

    try {
      const decimals = window.SELA_CONFIG.GOAL_MINT_DECIMALS;
      const destinationTokenAccount = await _getTokenAccountForWallet(wallet.publicKey, pointer.mint);

      await window.VeilEngine.withdrawFromGoal({
        payerWallet: wallet.publicKey,
        vaultPda: pointer.vaultPda,
        goalPda: pointer.goalPda,
        goalTokenAccount: pointer.goalTokenAccount,
        mint: pointer.mint,
        destinationTokenAccount,
        deviceRole: pointer.deviceRole,
        amountBaseUnits: BigInt(Math.round(amount * 10 ** decimals)),
        decimals,
        credentialId: _b64ToBytes(pointer.credentialId),
        compressedPubkey33: _b64ToBytes(pointer.compressedPubkey33),
        onProgress: (step) => { btn.innerHTML = `<span class="spinner" style="width:15px;height:15px;"></span> ${step === 'transferring' ? 'Submitting\u2026' : 'Building\u2026'}`; },
      });

      window.Cognata.showToast('Withdrawal confirmed.', 'green');
      document.getElementById('withdrawAmount').value = '';
      await refresh();
    } catch (err) {
      window.Cognata.showToast('Withdrawal failed: ' + (err.message || 'Unknown error'), 'red');
      btn.disabled = false;
      btn.innerHTML = 'Approve &amp; Withdraw';
    }
  }

  function init() {
    if (initialized) return;
    initialized = true;
    refresh();
    window.addEventListener('sela:tab', (e) => { if (e.detail.tab === 'goals') refresh(); });
    window.addEventListener('sela:wallet-connected', () => refresh());
  }

  return {
    init, refresh,
    showGoalCreateForm, hideGoalCreateForm, handleCreateGoal,
    showGoalContributeForm, showGoalWithdrawForm, hideGoalForms,
    handleContribute, handleWithdraw,
  };
})();

window.GoalsTab = GoalsTab;
document.addEventListener('DOMContentLoaded', () => GoalsTab.init());
