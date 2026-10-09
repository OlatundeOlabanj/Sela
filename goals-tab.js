/**
 * Goals + Home dashboard controller.
 *
 * Data model: localStorage keeps exactly one thing per wallet, which
 * vault is theirs (vaultPda, the registered passkey credential and
 * device pubkey). It is a pointer, never a balance. Which goals exist
 * is read from the chain every time: fetch the vault, read its
 * goal_seq (a count), derive and fetch each goal PDA 0..goal_seq-1.
 * Every amount shown anywhere in this file comes from a decoded
 * on-chain account at render time.
 *
 * The one local log this file keeps is activity (contribute/withdraw
 * events, timestamp + amount), written the moment this UI confirms
 * one, nothing else. That log is what the weekly bar chart and the
 * Home activity preview are built from, merged with real invoice
 * payment history from Cognata.getAllInvoices(). A day with nothing
 * logged renders as a zero bar, not an invented number. There is no
 * historical backfill, a fresh deploy's activity log starts empty and
 * only grows from real confirmed actions, which is the honest state
 * for a product with no activity yet, not a bug.
 *
 * No balance-over-time series exists anywhere (no snapshot log, no
 * history endpoint), so there is no sparkline and no week-over-week
 * percentage here. Faking either would be exactly the thing this
 * project's rules forbid. See the chat report for the flag back to
 * Tunde on whether to build that data source.
 *
 * Made by TJS Code
 */

const GoalsTab = (() => {
  const VAULT_PREFIX = 'sela_vault_pointer_';
  const ACTIVITY_PREFIX = 'sela_activity_log_';
  const MAX_GOALS_TO_SCAN = 12; // sane ceiling on how many goal_seq slots to fetch
  let initialized = false;
  let connectionCache = null;
  let selectedGoal = null; // the goal currently open in the detail/contribute/withdraw forms

  function _web3() { return window.solanaWeb3; }

  // Every show/hide in this file goes through here. An unguarded
  // el.style.display on a missing element throws, and when that happens
  // partway through a render function the rest of the function never
  // runs, leaving the screen half-updated (header says connected, body
  // still says welcome). A missing element is skipped, not fatal.
  function _show(id, visible) {
    const el = typeof id === 'string' ? document.getElementById(id) : id;
    if (el) el.style.display = visible ? '' : 'none';
  }

  function _getConnection() {
    if (connectionCache) return connectionCache;
    const cfg = window.SELA_CONFIG;
    const url = cfg.PROGRAM_CLUSTER === 'mainnet-beta' ? '/api/rpc' : `https://api.${cfg.PROGRAM_CLUSTER}.solana.com`;
    connectionCache = new (_web3().Connection)(url, 'confirmed');
    return connectionCache;
  }

  function _bytesToB64(bytes) { let bin = ''; for (const b of bytes) bin += String.fromCharCode(b); return btoa(bin); }
  function _b64ToBytes(b64) { const bin = atob(b64); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
  function _decimals() { return window.SELA_CONFIG.GOAL_MINT_DECIMALS; }
  function _fmt(baseUnits) {
    return (Number(baseUnits) / 10 ** _decimals()).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // ---- Vault pointer (one per wallet) ----
  function _getVaultPointer(wallet) {
    const raw = localStorage.getItem(VAULT_PREFIX + wallet);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }
  function _setVaultPointer(wallet, pointer) {
    localStorage.setItem(VAULT_PREFIX + wallet, JSON.stringify(pointer));
  }

  // ---- Activity log (real, appended to on confirmed actions only) ----
  function _getActivityLog(wallet) {
    const raw = localStorage.getItem(ACTIVITY_PREFIX + wallet);
    if (!raw) return [];
    try { return JSON.parse(raw); } catch { return []; }
  }
  function _logActivity(wallet, entry) {
    const log = _getActivityLog(wallet);
    log.push({ ...entry, timestamp: Date.now() });
    localStorage.setItem(ACTIVITY_PREFIX + wallet, JSON.stringify(log));
  }

  // ---- Chain reads ----
  async function _programIsDeployed() {
    try {
      const info = await _getConnection().getAccountInfo(new (_web3().PublicKey)(window.SELA_CONFIG.PROGRAM_ID));
      return !!info && info.executable;
    } catch (err) {
      console.error('[Goals] cluster check failed:', err.message);
      return false;
    }
  }

  /** Real enumeration: reads the vault's goal_seq, fetches every goal
   * index up to it. No locally-cached list of "which goals exist". */
  async function _fetchAllGoals(vaultPdaStr) {
    const conn = _getConnection();
    const CP = window.CognataProgram;
    const vaultPda = new (_web3().PublicKey)(vaultPdaStr);
    const vaultInfo = await conn.getAccountInfo(vaultPda);
    if (!vaultInfo) return { vault: null, goals: [] };
    const vault = CP.decodeFamilyVault(vaultInfo.data);
    const count = Math.min(vault.goalSeq, MAX_GOALS_TO_SCAN);
    const goals = [];
    for (let seq = 0; seq < count; seq++) {
      const { pda: goalPda } = CP.deriveGoalPda(vaultPda, seq);
      const info = await conn.getAccountInfo(goalPda);
      if (!info) continue;
      const goal = CP.decodeSavingsGoal(info.data);
      goals.push({ ...goal, goalPda: goalPda.toBase58(), goalSeq: seq, vaultPda: vaultPdaStr });
    }
    return { vault, goals };
  }

  // ---- Shared ring renderer (used by both Home and Goals view) ----
  function _ringSvg(pct, status) {
    const r = 30, c = 2 * Math.PI * r;
    const clamped = Math.max(0, Math.min(100, pct));
    const color = status === 'Completed' || clamped >= 100 ? 'var(--success)' : 'var(--accent)';
    const offset = c - (clamped / 100) * c;
    return `
      <svg class="goal-ring-svg" viewBox="0 0 72 72">
        <circle cx="36" cy="36" r="${r}" fill="none" stroke="var(--border-light)" stroke-width="6"/>
        <circle cx="36" cy="36" r="${r}" fill="none" stroke="${color}" stroke-width="6"
          stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${offset}"
          transform="rotate(-90 36 36)"/>
        <text x="36" y="41" text-anchor="middle" class="goal-ring-pct">${Math.round(clamped)}%</text>
      </svg>`;
  }

  function _renderRingRow(container, goals, { tappable }) {
    if (!goals.length) {
      container.innerHTML = '<div class="goal-ring-empty pane-note">No goals yet.</div>';
      return;
    }
    container.innerHTML = goals.map((g, i) => {
      const pct = g.targetAmount > 0n ? Number((g.currentAmount * 100n) / g.targetAmount) : 0;
      return `
        <div class="goal-ring-card" ${tappable ? `onclick="GoalsTab.openGoalDetail(${i})"` : ''}>
          ${_ringSvg(pct, g.status)}
          <div class="goal-ring-name">${_escape(g.name)}</div>
          <div class="goal-ring-amounts">${_fmt(g.currentAmount)} / ${_fmt(g.targetAmount)}</div>
        </div>`;
    }).join('');
  }

  function _escape(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  // ---- Weekly contributions bar chart: real data, calendar week Mon-Sun ----
  function _computeWeekData(wallet) {
    const now = new Date();
    const day = (now.getDay() + 6) % 7; // 0 = Monday
    const monday = new Date(now); monday.setHours(0, 0, 0, 0); monday.setDate(now.getDate() - day);

    const buckets = [0, 0, 0, 0, 0, 0, 0]; // USDC units, Mon..Sun
    const decimals = _decimals();

    for (const entry of _getActivityLog(wallet)) {
      if (entry.type !== 'contribute') continue;
      const d = new Date(entry.timestamp);
      const diffDays = Math.floor((d - monday) / 86400000);
      if (diffDays >= 0 && diffDays < 7) buckets[diffDays] += Number(entry.amountBaseUnits) / 10 ** decimals;
    }
    for (const inv of (window.Cognata?.getAllInvoices?.() || [])) {
      if (inv.status !== 'paid') continue;
      // No separate "paid at" timestamp exists on an invoice record,
      // createdAt is the closest real field, used as-is rather than
      // inventing a field that was never actually recorded.
      if (!inv.createdAt) continue;
      const d = new Date(inv.createdAt);
      const diffDays = Math.floor((d - monday) / 86400000);
      if (diffDays >= 0 && diffDays < 7) buckets[diffDays] += Number(inv.amount || 0);
    }
    return { buckets, todayIndex: day };
  }

  function _renderWeekChart(wallet) {
    const { buckets, todayIndex } = _computeWeekData(wallet);
    const max = Math.max(...buckets, 0.01);
    const total = buckets.reduce((s, v) => s + v, 0);
    const labels = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
    const bars = document.getElementById('weekChartBars');
    if (bars) {
      bars.innerHTML = buckets.map((v, i) => `
        <div class="week-bar-col ${i === todayIndex ? 'is-today' : ''}">
          <div class="week-bar" style="height:${Math.max(3, (v / max) * 100)}%" title="${v.toFixed(2)} USDC"></div>
          <div class="week-bar-day">${labels[i]}</div>
        </div>`).join('');
    }
    const totalEl = document.getElementById('weekChartTotal');
    if (totalEl) totalEl.textContent = total.toFixed(2) + ' total';
  }

  // ---- Recent activity (merged, real) ----
  function _mergedActivity(wallet, limit) {
    const items = [];
    for (const entry of _getActivityLog(wallet)) {
      items.push({
        title: entry.type === 'contribute' ? `Contributed to ${entry.goalName}` : `Withdrew from ${entry.goalName}`,
        sub: _relativeTime(entry.timestamp),
        amount: Number(entry.amountBaseUnits) / 10 ** _decimals(),
        direction: entry.type === 'contribute' ? 'out' : 'in', // money leaving the user = out icon, matches the action
        timestamp: entry.timestamp,
      });
    }
    for (const inv of (window.Cognata?.getAllInvoices?.() || [])) {
      if (inv.status !== 'paid') continue;
      // Same createdAt-as-proxy note as _computeWeekData above.
      const ts = inv.createdAt ? new Date(inv.createdAt).getTime() : 0;
      items.push({
        title: `Invoice paid: ${inv.clientName || 'client'}`,
        sub: _relativeTime(ts),
        amount: Number(inv.amount || 0),
        direction: 'in',
        timestamp: ts,
      });
    }
    items.sort((a, b) => b.timestamp - a.timestamp);
    return items.slice(0, limit);
  }

  function _relativeTime(ts) {
    if (!ts) return '';
    const diff = Date.now() - ts;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  }

  function _renderActivityList(containerId, wallet, limit) {
    const el = document.getElementById(containerId);
    if (!el) return;
    const items = _mergedActivity(wallet, limit);
    if (!items.length) { el.innerHTML = '<div class="activity-empty">No activity yet.</div>'; return; }
    el.innerHTML = items.map((it) => `
      <div class="activity-row">
        <span class="activity-icon ${it.direction}">
          ${it.direction === 'in'
            ? '<svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>'
            : '<svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>'}
        </span>
        <div>
          <div class="activity-row-title">${_escape(it.title)}</div>
          <div class="activity-row-sub">${_escape(it.sub)}</div>
        </div>
        <span class="activity-row-amount ${it.direction}">${it.direction === 'in' ? '+' : ''}${it.amount.toFixed(2)}</span>
      </div>`).join('');
  }

  // ---- Home dashboard ----
  async function renderHome() {
    const clusterEl = document.getElementById('heroClusterName');
    if (clusterEl) clusterEl.textContent = window.SELA_CONFIG.PROGRAM_CLUSTER;

    const wallet = window.Cognata?.WalletState?.get();
    const welcomeEl = document.getElementById('homeWelcome');
    const connectedEl = document.getElementById('homeConnected');

    if (!wallet?.publicKey) {
      _show(welcomeEl, true);
      _show(connectedEl, false);
      return;
    }
    _show(welcomeEl, false);
    _show(connectedEl, true);

    const amountEl = document.getElementById('heroBalanceAmount');
    const unitEl = document.getElementById('heroBalanceUnit');

    const pointer = _getVaultPointer(wallet.publicKey);
    if (!pointer) {
      amountEl.textContent = '0.00';
      unitEl.textContent = 'USDC';
      document.getElementById('homeGoalRings').innerHTML = '<div class="goal-ring-empty pane-note">No goals yet, create one in the Goals tab.</div>';
    } else {
      const { goals } = await _fetchAllGoals(pointer.vaultPda);
      const total = goals.reduce((s, g) => s + g.currentAmount, 0n);
      amountEl.textContent = _fmt(total);
      unitEl.textContent = 'USDC';
      _renderRingRow(document.getElementById('homeGoalRings'), goals, { tappable: false });
    }

    _renderWeekChart(wallet.publicKey);
    _renderActivityList('homeActivityList', wallet.publicKey, 5);
  }

  // ---- Family (invite / approve / revoke) ----
  // v1 constraint, not a bug to work around: FamilyVault has exactly two
  // fixed device slots on-chain (primary_contributor_device at role 0,
  // partner_device at role 1), not an extensible list, so this is "one
  // partner per vault," full stop, until the program itself changes.
  const ZERO_DEVICE = new Uint8Array(33); // all-zero = slot never set

  function _isZeroDevice(bytes) { return bytes.every((b) => b === 0); }

  let currentVault = null; // decoded FamilyVault, refreshed alongside the goals list

  async function _renderFamilySection(wallet, pointer, vault) {
    const listEl = document.getElementById('familyMemberList');
    const isGuardian = vault.guardian.toBase58() === wallet;
    const partnerSet = !_isZeroDevice(vault.partnerDevice);

    listEl.innerHTML = `
      <div class="activity-row" style="border-top:none;padding-top:0;">
        <span class="activity-icon in"><svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/></svg></span>
        <div><div class="activity-row-title">${isGuardian ? 'You (Owner)' : 'Owner'}</div></div>
      </div>
      <div class="activity-row">
        <span class="activity-icon ${partnerSet ? 'in' : 'out'}"><svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/></svg></span>
        <div><div class="activity-row-title">${partnerSet ? (pointer.deviceRole === 1 ? 'You (Member)' : 'Member') : 'No member yet'}</div></div>
      </div>`;

    _show('inviteBtn', isGuardian && !partnerSet);
    _show('inviteFull', isGuardian && partnerSet);
    _show('inviteLinkBox', false);

    const pendingBox = document.getElementById('pendingJoinRequest');
    _show(pendingBox, false);
    if (isGuardian && !partnerSet) {
      try {
        const { pda: rotationPda } = window.CognataProgram.deriveRotationRequestPda(pointer.vaultPda, 1);
        const info = await _getConnection().getAccountInfo(rotationPda);
        if (info) {
          const req = window.CognataProgram.decodeKeyRotationRequest(info.data);
          if (req.status === 'Pending') {
            _show(pendingBox, true);
            document.getElementById('pendingJoinDevice').textContent =
              'New device key: ' + Array.from(req.newDevicePubkey).map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16) + '\u2026';
          }
        }
      } catch (err) { console.error('[Goals] pending-request check failed:', err.message); }
    }
  }

  let lastInviteCode = null;

  async function handleCreateInvite() {
    const wallet = window.Cognata.WalletState.get();
    const pointer = _getVaultPointer(wallet.publicKey);
    if (!pointer || !currentVault) return;

    const btn = document.getElementById('inviteBtn');
    btn.disabled = true;
    btn.textContent = 'Creating invite\u2026';
    try {
      const res = await fetch('/api/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vaultPda: pointer.vaultPda,
          vaultName: currentGoalsList[0]?.name || 'Shared goal',
          deviceRole: 1,
          createdBy: wallet.publicKey,
        }),
      });
      if (!res.ok) throw new Error('Could not create invite (' + res.status + ')');
      const record = await res.json();
      lastInviteCode = record.code;
      const link = `${window.location.origin}/join.html?code=${record.code}`;
      document.getElementById('inviteLinkText').value = link;
      _show('inviteLinkBox', true);
    } catch (err) {
      window.Cognata.showToast('Could not create invite: ' + err.message, 'red');
    }
    btn.disabled = false;
    btn.textContent = 'Invite a Family Member';
  }

  function copyInviteLink() {
    const input = document.getElementById('inviteLinkText');
    input.select();
    navigator.clipboard?.writeText(input.value);
    window.Cognata.showToast('Link copied.', 'green');
  }

  async function handleApproveJoin() {
    const wallet = window.Cognata.WalletState.get();
    const pointer = _getVaultPointer(wallet.publicKey);
    if (!pointer) return;

    const btn = document.querySelector('#pendingJoinRequest button');
    btn.disabled = true;
    btn.textContent = 'Approving\u2026';
    try {
      const instruction = window.CognataProgram.buildApproveKeyRotationInstruction({
        guardian: wallet.publicKey, vaultPda: pointer.vaultPda, deviceRole: 1,
      });
      await window.VeilEngine.approveJoinRequest({ payerWallet: wallet.publicKey, instruction });
      window.Cognata.showToast('Family member approved.', 'green');
      await refreshGoalsView();
    } catch (err) {
      window.Cognata.showToast('Approval failed: ' + err.message, 'red');
    }
    btn.disabled = false;
    btn.textContent = 'Approve';
  }

  // ---- Goals view ----
  let currentGoalsList = [];

  function _showOnly(id) {
    ['goalsNotDeployed', 'goalsLoading', 'goalsNeedWallet', 'goalsListWrap', 'goalsEmpty', 'goalsCreateForm', 'goalsActive', 'goalsDepositForm', 'goalsContributeForm', 'goalsWithdrawForm']
      .forEach((x) => { const el = document.getElementById(x); if (el) el.style.display = x === id ? '' : 'none'; });
  }

  async function refreshGoalsView() {
    _showOnly('goalsLoading');
    const deployed = await _programIsDeployed();
    const clusterNameEl = document.getElementById('goalsClusterName');
    if (clusterNameEl) clusterNameEl.textContent = window.SELA_CONFIG.PROGRAM_CLUSTER;
    if (!deployed) { _showOnly('goalsNotDeployed'); return; }

    const wallet = window.Cognata?.WalletState?.get();
    if (!wallet?.publicKey) { _showOnly('goalsNeedWallet'); return; }

    const pointer = _getVaultPointer(wallet.publicKey);
    if (!pointer) { _showOnly('goalsEmpty'); return; }

    const { vault, goals } = await _fetchAllGoals(pointer.vaultPda);
    currentGoalsList = goals;
    currentVault = vault;
    if (!goals.length) { _showOnly('goalsEmpty'); return; }

    _showOnly('goalsListWrap');
    _renderRingRow(document.getElementById('goalsRingRow'), goals, { tappable: true });
    if (vault) await _renderFamilySection(wallet.publicKey, pointer, vault);
  }

  function openGoalDetail(index) {
    selectedGoal = currentGoalsList[index];
    if (!selectedGoal) return;
    _showOnly('goalsActive');
    document.getElementById('goalActiveName').textContent = selectedGoal.name;
    document.getElementById('goalCurrentAmount').textContent = _fmt(selectedGoal.currentAmount) + ' USDC' + (selectedGoal.status !== 'Active' ? ` (${selectedGoal.status})` : '');
    document.getElementById('goalCurrentAmount').classList.toggle('accent', selectedGoal.currentAmount > 0n);
    document.getElementById('goalTargetAmount').textContent = _fmt(selectedGoal.targetAmount);
    _refreshHoldingBalance();
  }

  function closeGoalDetail() { selectedGoal = null; refreshGoalsView(); }

  // ---- Create goal ----
  function showGoalCreateForm() {
    const wallet = window.Cognata?.WalletState?.get();
    const hasVault = wallet?.publicKey && _getVaultPointer(wallet.publicKey);
    document.getElementById('goalCreateNote').textContent = hasVault
      ? 'Approved with the passkey already registered on this device.'
      : 'Creating your first goal registers a passkey on this device for approving contributions and withdrawals. Your browser will prompt you.';
    _showOnly('goalsCreateForm');
  }
  function hideGoalCreateForm() { refreshGoalsView(); }

  async function handleCreateGoal() {
    const name = document.getElementById('goalName').value.trim();
    const target = parseFloat(document.getElementById('goalTarget').value.trim());
    if (!name) return window.Cognata.showToast('Name the goal.', 'red');
    if (!target || target <= 0) return window.Cognata.showToast('Enter a target amount above 0.', 'red');

    const wallet = window.Cognata.WalletState.get();
    if (!wallet?.publicKey) return window.Cognata.showToast('Connect your wallet first.', 'red');

    const btn = document.getElementById('goalCreateBtn');
    btn.disabled = true;
    const decimals = _decimals();
    const targetBaseUnits = BigInt(Math.round(target * 10 ** decimals));
    const existingPointer = _getVaultPointer(wallet.publicKey);

    try {
      if (!existingPointer) {
        // First goal ever for this wallet: register a passkey and create
        // both the vault and the goal in one atomic transaction.
        btn.innerHTML = '<span class="spinner" style="width:15px;height:15px;"></span> Registering passkey\u2026';
        const { compressedPubkey, credentialId } = await window.PasskeyClient.registerPasskey({ label: name });

        btn.innerHTML = '<span class="spinner" style="width:15px;height:15px;"></span> Creating goal\u2026';
        const result = await window.VeilEngine.createGoal({
          payerWallet: wallet.publicKey,
          primaryDeviceCompressedPubkey: compressedPubkey,
          guardianPubkey: wallet.publicKey,
          feeTier: 0,
          name,
          targetAmountBaseUnits: targetBaseUnits,
          currency: 1,
          deadlineUnixSeconds: 0,
          mint: window.SELA_CONFIG.GOAL_MINT,
        });

        window.PasskeyClient.rememberCredentialForVault(result.vaultPda, credentialId);
        _setVaultPointer(wallet.publicKey, {
          vaultPda: result.vaultPda,
          deviceRole: 0,
          credentialId: _bytesToB64(credentialId),
          compressedPubkey33: _bytesToB64(compressedPubkey),
        });
      } else {
        // Vault already exists: just add a goal to it, current goal_seq
        // read fresh from chain, no new passkey needed.
        btn.innerHTML = '<span class="spinner" style="width:15px;height:15px;"></span> Creating goal\u2026';
        const conn = _getConnection();
        const vaultPda = new (_web3().PublicKey)(existingPointer.vaultPda);
        const vaultInfo = await conn.getAccountInfo(vaultPda);
        if (!vaultInfo) throw new Error('Vault not found on chain.');
        const vault = window.CognataProgram.decodeFamilyVault(vaultInfo.data);

        const { instruction } = window.CognataProgram.buildInitSavingsGoalInstruction({
          payer: wallet.publicKey, vaultPda, goalSeq: vault.goalSeq, mint: window.SELA_CONFIG.GOAL_MINT,
          name, targetAmountBaseUnits: targetBaseUnits, currency: 1, deadlineUnixSeconds: 0,
        });
        await window.VeilEngine.addGoalToVault({ payerWallet: wallet.publicKey, instruction });
      }

      window.Cognata.showToast('Goal created.', 'green');
      document.getElementById('goalName').value = '';
      document.getElementById('goalTarget').value = '';
      await refreshGoalsView();
      await renderHome();
    } catch (err) {
      window.Cognata.showToast('Could not create goal: ' + (err.message || 'Unknown error'), 'red');
    }
    btn.disabled = false;
    btn.innerHTML = 'Create Goal';
  }

  // ---- Holding account: where contributions are actually paid from ----
  // contribute() moves funds with a CPI signed by this device's
  // wallet_authority PDA, so the source has to be a token account OWNED
  // BY THAT PDA, not the user's own wallet account (the token program
  // rejects that with an owner mismatch). Funds are added to it first
  // (see handleDeposit), the passkey then authorizes moving them on.
  function _holdingFor(pointer, mintStr) {
    return window.CognataProgram.holdingAccountFor(pointer.vaultPda, pointer.deviceRole, mintStr);
  }

  /** null = account never created, undefined = couldn't read it, bigint = real balance */
  async function _holdingBalance(pointer, mintStr) {
    const { ata } = _holdingFor(pointer, mintStr);
    try {
      const conn = _getConnection();
      const info = await conn.getAccountInfo(ata);
      if (!info) return null;
      const bal = await conn.getTokenAccountBalance(ata);
      return BigInt(bal.value.amount);
    } catch (err) {
      console.error('[Goals] holding balance read failed:', err.message);
      return undefined;
    }
  }

  async function _refreshHoldingBalance() {
    const el = document.getElementById('goalHoldingBalance');
    if (!el || !selectedGoal) return;
    const wallet = window.Cognata?.WalletState?.get();
    const pointer = wallet?.publicKey ? _getVaultPointer(wallet.publicKey) : null;
    if (!pointer) { el.textContent = '-'; return; }
    el.textContent = 'Checking\u2026';
    const bal = await _holdingBalance(pointer, selectedGoal.mint.toBase58());
    el.textContent = bal === null ? 'No funds added yet' : bal === undefined ? 'Could not load' : _fmt(bal) + ' USDC';
  }

  function showGoalDepositForm() {
    const wallet = window.Cognata?.WalletState?.get();
    const pointer = wallet?.publicKey ? _getVaultPointer(wallet.publicKey) : null;
    if (selectedGoal && pointer) {
      const { ata } = _holdingFor(pointer, selectedGoal.mint.toBase58());
      const addr = document.getElementById('holdingAddressText');
      if (addr) addr.value = ata.toBase58();
    }
    _showOnly('goalsDepositForm');
  }

  function copyHoldingAddress() {
    const input = document.getElementById('holdingAddressText');
    if (!input) return;
    input.select();
    navigator.clipboard?.writeText(input.value);
    window.Cognata.showToast('Address copied.', 'green');
  }

  async function handleDeposit() {
    if (!selectedGoal) return window.Cognata.showToast('No goal selected.', 'red');
    const amount = parseFloat(document.getElementById('depositAmount').value.trim());
    if (!amount || amount <= 0) return window.Cognata.showToast('Enter an amount above 0.', 'red');

    const wallet = window.Cognata.WalletState.get();
    if (!wallet?.publicKey) return window.Cognata.showToast('Connect your wallet first.', 'red');
    const pointer = _getVaultPointer(wallet.publicKey);
    if (!pointer) return window.Cognata.showToast('No vault found for this wallet.', 'red');

    const btn = document.getElementById('goalDepositBtn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner" style="width:15px;height:15px;"></span> Adding funds\u2026';
    try {
      const decimals = _decimals();
      const mint = selectedGoal.mint.toBase58();
      const sourceTokenAccount = await _getTokenAccountForWallet(wallet.publicKey, mint);
      const sourceInfo = await _getConnection().getAccountInfo(sourceTokenAccount);
      if (!sourceInfo) throw new Error('This wallet has no USDC on ' + window.SELA_CONFIG.PROGRAM_CLUSTER + ' to add.');

      const { instructions } = window.CognataProgram.buildDepositInstructions({
        payer: wallet.publicKey, vaultPda: pointer.vaultPda, deviceRole: pointer.deviceRole, mint,
        sourceTokenAccount, amountBaseUnits: BigInt(Math.round(amount * 10 ** decimals)), decimals,
      });
      await window.VeilEngine.submitInstructions({ payerWallet: wallet.publicKey, instructions });

      window.Cognata.showToast('Funds added.', 'green');
      document.getElementById('depositAmount').value = '';
      hideGoalForms();
    } catch (err) {
      window.Cognata.showToast('Could not add funds: ' + (err.message || 'Unknown error'), 'red');
    }
    btn.disabled = false;
    btn.innerHTML = 'Add from connected wallet';
  }

  // ---- Contribute / withdraw (against selectedGoal) ----
  function showGoalContributeForm() { _showOnly('goalsContributeForm'); }
  function showGoalWithdrawForm() { _showOnly('goalsWithdrawForm'); }
  function hideGoalForms() { if (selectedGoal) openGoalDetail(currentGoalsList.indexOf(selectedGoal)); else refreshGoalsView(); }

  async function _getTokenAccountForWallet(walletPubkey, mint) {
    return window.CognataProgram.getAssociatedTokenAddress(new (_web3().PublicKey)(walletPubkey), new (_web3().PublicKey)(mint));
  }

  async function handleContribute() {
    if (!selectedGoal) return window.Cognata.showToast('No goal selected.', 'red');
    const amount = parseFloat(document.getElementById('contributeAmount').value.trim());
    if (!amount || amount <= 0) return window.Cognata.showToast('Enter an amount above 0.', 'red');

    const wallet = window.Cognata.WalletState.get();
    const pointer = _getVaultPointer(wallet.publicKey);
    if (!pointer) return window.Cognata.showToast('No vault found for this wallet.', 'red');

    const btn = document.getElementById('goalContributeBtn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner" style="width:15px;height:15px;"></span> Waiting for passkey\u2026';

    try {
      const decimals = _decimals();
      const mintStr = selectedGoal.mint.toBase58();
      // Paid from the PDA-owned holding account, see _holdingFor above.
      const contributorTokenAccount = _holdingFor(pointer, mintStr).ata;
      const amountBaseUnits = BigInt(Math.round(amount * 10 ** decimals));

      const available = await _holdingBalance(pointer, mintStr);
      if (available === null || (available !== undefined && available < amountBaseUnits)) {
        throw new Error('Not enough in your Sela balance. Tap Add funds first.');
      }

      await window.VeilEngine.contributeToGoal({
        payerWallet: wallet.publicKey,
        vaultPda: pointer.vaultPda,
        goalPda: selectedGoal.goalPda,
        goalTokenAccount: selectedGoal.goalTokenAccount.toBase58(),
        mint: selectedGoal.mint.toBase58(),
        contributorTokenAccount,
        deviceRole: pointer.deviceRole,
        amountBaseUnits, decimals,
        credentialId: _b64ToBytes(pointer.credentialId),
        compressedPubkey33: _b64ToBytes(pointer.compressedPubkey33),
        onProgress: (step) => { btn.innerHTML = `<span class="spinner" style="width:15px;height:15px;"></span> ${step === 'transferring' ? 'Submitting\u2026' : 'Building\u2026'}`; },
      });

      _logActivity(wallet.publicKey, { type: 'contribute', goalName: selectedGoal.name, amountBaseUnits: amountBaseUnits.toString() });
      window.Cognata.showToast('Contribution confirmed.', 'green');
      document.getElementById('contributeAmount').value = '';
      await refreshGoalsView();
      await renderHome();
      closeGoalDetail();
    } catch (err) {
      window.Cognata.showToast('Contribution failed: ' + (err.message || 'Unknown error'), 'red');
      btn.disabled = false;
      btn.innerHTML = 'Approve &amp; Contribute';
    }
  }

  async function handleWithdraw() {
    if (!selectedGoal) return window.Cognata.showToast('No goal selected.', 'red');
    const amount = parseFloat(document.getElementById('withdrawAmount').value.trim());
    if (!amount || amount <= 0) return window.Cognata.showToast('Enter an amount above 0.', 'red');

    const wallet = window.Cognata.WalletState.get();
    const pointer = _getVaultPointer(wallet.publicKey);
    if (!pointer) return window.Cognata.showToast('No vault found for this wallet.', 'red');

    const btn = document.getElementById('goalWithdrawBtn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner" style="width:15px;height:15px;"></span> Waiting for passkey\u2026';

    try {
      const decimals = _decimals();
      const destinationTokenAccount = await _getTokenAccountForWallet(wallet.publicKey, selectedGoal.mint.toBase58());
      const amountBaseUnits = BigInt(Math.round(amount * 10 ** decimals));

      await window.VeilEngine.withdrawFromGoal({
        payerWallet: wallet.publicKey,
        vaultPda: pointer.vaultPda,
        goalPda: selectedGoal.goalPda,
        goalTokenAccount: selectedGoal.goalTokenAccount.toBase58(),
        mint: selectedGoal.mint.toBase58(),
        destinationTokenAccount,
        deviceRole: pointer.deviceRole,
        amountBaseUnits, decimals,
        credentialId: _b64ToBytes(pointer.credentialId),
        compressedPubkey33: _b64ToBytes(pointer.compressedPubkey33),
        onProgress: (step) => { btn.innerHTML = `<span class="spinner" style="width:15px;height:15px;"></span> ${step === 'transferring' ? 'Submitting\u2026' : 'Building\u2026'}`; },
      });

      _logActivity(wallet.publicKey, { type: 'withdraw', goalName: selectedGoal.name, amountBaseUnits: amountBaseUnits.toString() });
      window.Cognata.showToast('Withdrawal confirmed.', 'green');
      document.getElementById('withdrawAmount').value = '';
      await refreshGoalsView();
      await renderHome();
      closeGoalDetail();
    } catch (err) {
      window.Cognata.showToast('Withdrawal failed: ' + (err.message || 'Unknown error'), 'red');
      btn.disabled = false;
      btn.innerHTML = 'Approve &amp; Withdraw';
    }
  }

  // ---- You view: passkey card + program explorer link ----
  function renderYou() {
    const explorerLink = document.getElementById('youExplorerLink');
    if (explorerLink) {
      const cfg = window.SELA_CONFIG;
      const clusterParam = cfg.PROGRAM_CLUSTER === 'mainnet-beta' ? '' : `?cluster=${cfg.PROGRAM_CLUSTER}`;
      explorerLink.href = `https://explorer.solana.com/address/${cfg.PROGRAM_ID}${clusterParam}`;
    }

    const wallet = window.Cognata?.WalletState?.get();
    const noneEl = document.getElementById('youPasskeyNone');
    const activeEl = document.getElementById('youPasskeyActive');
    if (!noneEl || !activeEl) return;

    const pointer = wallet?.publicKey ? _getVaultPointer(wallet.publicKey) : null;
    if (!pointer) {
      _show(noneEl, true);
      _show(activeEl, false);
      return;
    }
    _show(noneEl, false);
    _show(activeEl, true);
    document.getElementById('youPasskeyRole').textContent = pointer.deviceRole === 0 ? 'Owner' : 'Member';
  }

  function init() {
    if (initialized) return;
    initialized = true;
    renderHome();
    refreshGoalsView();
    renderYou();
    window.addEventListener('sela:tab', (e) => {
      if (e.detail.tab === 'home') renderHome();
      if (e.detail.tab === 'goals') refreshGoalsView();
      if (e.detail.tab === 'you') renderYou();
    });
    window.addEventListener('sela:wallet-connected', () => { renderHome(); refreshGoalsView(); renderYou(); });
  }

  return {
    init, renderHome, refreshGoalsView, renderYou, openGoalDetail, closeGoalDetail,
    showGoalCreateForm, hideGoalCreateForm, handleCreateGoal,
    showGoalContributeForm, showGoalWithdrawForm, hideGoalForms,
    handleContribute, handleWithdraw,
    handleCreateInvite, copyInviteLink, handleApproveJoin,
    showGoalDepositForm, handleDeposit, copyHoldingAddress,
  };
})();

window.GoalsTab = GoalsTab;
document.addEventListener('DOMContentLoaded', () => GoalsTab.init());
