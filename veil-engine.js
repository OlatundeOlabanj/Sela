/**
 * VeilPay Engine, payment orchestration
 * Composes PaymentTransfer (real SPL USDC transfer) with SmartTX
 * (real Jito submission + tip + Groq retry agent). This is the
 * public API the rest of the app calls (dashboard.html, pay.html,
 * app.js). Everything below is real. No simulation, no testnet.
 *
 * Made by TJS Code
 */

const VeilEngine = (() => {
  const MAX_RETRIES = 2;
  const CONFIRM_TIMEOUT_MS = 45_000;
  const CONFIRM_POLL_MS = 2_000;

  const _B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
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
    for (let i = digits.length - 1; i >= 0; i--) result += _B58_ALPHABET[digits[i]];
    return result;
  }

  function _truncate(pk) {
    if (!pk || pk.length < 10) return pk;
    return `${pk.slice(0, 4)}...${pk.slice(-4)}`;
  }

  // Set once a wallet connects (any of Phantom/Solflare/Backpack/Wallet
  // Standard, via wallet-adapter.js) and read by every function below that
  // needs to sign something. Replaces the old hardcoded window.solana lookup.
  let _activeProvider = null;
  let _activeWalletName = null;

  function _getActiveProvider() {
    return _activeProvider;
  }

  async function _rpc(method, params, cluster = 'mainnet-beta') {
    const url = cluster === 'devnet' ? '/api/rpc?cluster=devnet' : '/api/rpc';
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message || `RPC ${method} failed`);
    return data.result;
  }

  // Devnet has no Jito equivalent, so goal/vault/passkey operations (which
  // run on SELA_CONFIG.PROGRAM_CLUSTER, devnet today) submit with a plain
  // sendTransaction instead of the mainnet Jito dual-send. Preflight stays
  // on, same as a normal wallet send, so a bad transaction is rejected here
  // rather than silently accepted and failing later.
  async function _submitDevnet(signedTxBase64) {
    try {
      await _rpc('sendTransaction', [signedTxBase64, { encoding: 'base64', skipPreflight: false }], 'devnet');
      return { success: true, usedFallback: false };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async function init() {
    console.log('[VeilPay] Engine ready. Real mainnet USDC transfers via Smart TX Stack.');
    return { success: true, simulated: false };
  }

  /**
   * Connects a wallet. Pass the entry the user picked from
   * VeilWalletAdapter.showPicker(); for a silent session-restore after
   * reload, pass a wallet name string instead and this re-fetches that
   * wallet's live provider without prompting a fresh approval.
   */
  async function connectWallet(entryOrWalletName) {
    let entry = entryOrWalletName;
    if (typeof entryOrWalletName === 'string') {
      entry = window.VeilWalletAdapter?.getEntryByName(entryOrWalletName);
      if (!entry) throw new Error(`${entryOrWalletName} is no longer available. Please reconnect.`);
    }
    if (!entry) {
      throw new Error('No wallet selected.');
    }
    const { publicKey, provider, walletName } = await window.VeilWalletAdapter.connect(entry);
    _activeProvider = provider;
    _activeWalletName = walletName;
    console.log('[VeilPay] Wallet connected:', walletName, _truncate(publicKey));
    return { publicKey, truncated: _truncate(publicKey), provider, walletName };
  }

  async function createPrivatePayment({ amount, recipientWallet, invoiceId, description }) {
    try {
      if (typeof window.solanaWeb3 !== 'undefined') new window.solanaWeb3.PublicKey(recipientWallet);
      return {
        paymentId: invoiceId,
        link: `${window.location.origin}/pay.html?id=${invoiceId}`,
        success: true,
      };
    } catch {
      throw new Error('Invalid wallet address. Please reconnect your wallet.');
    }
  }

  /** Waits for a signature to confirm, polling getSignatureStatuses. */
  async function _waitForConfirmation(signature) {
    const start = Date.now();
    while (Date.now() - start < CONFIRM_TIMEOUT_MS) {
      const result = await _rpc('getSignatureStatuses', [[signature], { searchTransactionHistory: true }]);
      const status = result?.value?.[0];
      if (status) {
        if (status.err) return { confirmed: false, failed: true, err: status.err };
        if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
          return { confirmed: true, failed: false };
        }
      }
      await new Promise(r => setTimeout(r, CONFIRM_POLL_MS));
    }
    return { confirmed: false, failed: false, timedOut: true };
  }

  /**
   * SAFETY-CRITICAL: before we're allowed to submit a retry transaction,
   * we must be certain the previous attempt can never land on-chain later,
   * otherwise a timeout + retry could silently double-charge the payer.
   * Solana guarantees a transaction can NEVER confirm once its blockhash
   * has expired, so we poll isBlockhashValid until that's true (or the
   * signature itself confirms in the meantime, in which case we report
   * that as a real success instead of retrying).
   */
  async function _waitForSafeRetry(signature, blockhash) {
    const start = Date.now();
    const SAFE_RETRY_TIMEOUT_MS = 90_000; // generous, blockhashes expire well within this
    while (Date.now() - start < SAFE_RETRY_TIMEOUT_MS) {
      // Did it actually land while we were waiting? Don't retry, it succeeded.
      const statusResult = await _rpc('getSignatureStatuses', [[signature], { searchTransactionHistory: true }]);
      const status = statusResult?.value?.[0];
      if (status && !status.err && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')) {
        return { landedLate: true };
      }
      const validResult = await _rpc('isBlockhashValid', [blockhash, { commitment: 'confirmed' }]);
      const stillValid = validResult?.value ?? validResult;
      if (!stillValid) {
        // Blockhash is expired, so the original transaction can now never land. Safe to retry.
        return { landedLate: false, safeToRetry: true };
      }
      await new Promise(r => setTimeout(r, CONFIRM_POLL_MS));
    }
    // Extremely unlikely to hit this, but fail safe: don't retry if we can't confirm expiry.
    return { landedLate: false, safeToRetry: false };
  }

  /**
   * Executes a real payment: build the transaction, sign with
   * Phantom, submit via the Smart TX Stack, confirm on-chain. On
   * failure or timeout, asks the Groq retry agent whether to try
   * again with a fresh blockhash and higher tip.
   */
  // Worst case a payment needs: tx fee (~0.000005 SOL) + Jito tip (varies,
  // budget generously) + rent for up to 2 new token accounts if neither the
  // recipient nor the fee wallet already holds one (~0.00204 SOL each, per
  // the real Aug 18 transaction). ~0.01 SOL covers that with headroom.
  const MIN_SOL_LAMPORTS = 10_000_000; // 0.01 SOL

  /**
   * Checks the payer has enough raw SOL to cover fees/tip/rent before we
   * even attempt a transaction. Solana needs SOL for this regardless of
   * which token is being sent. A payer can have plenty of USDC and still
   * fail here. Without this check, an underfunded wallet fails with a
   * generic "Confirmation timed out," which doesn't tell the payer what
   * actually went wrong or how to fix it.
   */
  async function _checkSolBalance(payerWallet) {
    const balance = await _rpc('getBalance', [payerWallet, { commitment: 'confirmed' }]).then(r => r.value ?? r);
    if (balance < MIN_SOL_LAMPORTS) {
      const haveSOL = (balance / 1e9).toFixed(4);
      throw new Error(
        `Insufficient SOL for network fees. Your wallet has ${haveSOL} SOL, but at least 0.01 SOL is needed to ` +
        `cover the transaction fee and network tip, even though the payment itself is in USDC. Add a small ` +
        `amount of SOL to your wallet and try again.`
      );
    }
  }

  /**
   * Checks the payer actually holds enough USDC before building a
   * transaction. Without this, a short payer signs a real transaction
   * that then fails on-chain with an opaque SPL error (e.g. a raw
   * "custom program error: 0x1"), instead of a message that tells them
   * what to do. No USDC account at all is treated as a zero balance,
   * not an error, that's a normal state for a wallet that has never
   * held USDC.
   */
  async function _checkUsdcBalance(payerWallet, amount) {
    const usdcMint = PaymentTransfer.config.usdcMint;
    let haveUsdc = 0;
    try {
      const accounts = await _rpc('getTokenAccountsByOwner', [
        payerWallet,
        { mint: usdcMint },
        { encoding: 'jsonParsed' },
      ]);
      for (const { account } of accounts?.value || []) {
        const amt = account?.data?.parsed?.info?.tokenAmount?.uiAmount;
        if (typeof amt === 'number') haveUsdc += amt;
      }
    } catch (err) {
      // If the balance check itself fails (RPC hiccup), don't block the
      // payment on it, on-chain will still catch a real shortfall, this
      // check exists to improve the error message, not gate the flow.
      console.warn('[VeilPay] USDC balance check failed, continuing:', err);
      return;
    }
    if (haveUsdc < amount) {
      throw new Error(
        `Insufficient USDC. This invoice is for ${amount} USDC, but your wallet holds ${haveUsdc.toFixed(2)} USDC. ` +
        `Add more USDC to your wallet and try again.`
      );
    }
  }

  /**
   * Shared dual-send/retry/safety core, extracted from what was
   * executePrivatePayment's body so contributeToGoal/withdrawFromGoal
   * (and anything after them) go through the exact same landing
   * guarantees as invoicing, not a second, divergent copy of this
   * logic. `buildTransaction({ tipLamports, tipAccount })` is called
   * fresh on every attempt and must return a plain, unsigned
   * web3.Transaction (no blockhash/feePayer set yet, this function
   * sets both). For a payment, that means rebuilding with a fresh,
   * possibly-escalated tip each retry, same as before. For a goal
   * instruction, it means wrapping the SAME already-authorized
   * instructions in a new Transaction object each time, cheap, and
   * critically, it does NOT require a fresh passkey touch per retry,
   * see contributeToGoal's comment on why that's sound.
   */
  async function _signAndSubmitWithRetry({ payerWallet, buildTransaction, onProgress, cluster = 'mainnet-beta' }) {
    const activeProvider = _getActiveProvider();
    if (!activeProvider) throw new Error('Wallet not connected.');
    const isDevnet = cluster === 'devnet';

    // Start at HIGH (p75 landed-tip), not MEDIUM (p50). p50 means half of
    // recently landed bundles needed MORE than this to land. A coin flip
    // isn't good enough for a real transfer. The tip itself is fractions
    // of a cent; the cost of losing another real test payment is not.
    let urgency = 'HIGH';
    let attempt = 0;
    let lastError = null;
    let lastMeta = {};

    while (attempt <= MAX_RETRIES) {
      attempt++;
      onProgress?.('depositing'); // "Building transaction" step in the UI

      const { tipLamports, tipAccount } = isDevnet
        ? { tipLamports: 0, tipAccount: null }
        : await SmartTX.getTip(urgency);
      const { blockhash } = await _rpc('getLatestBlockhash', [{ commitment: 'confirmed' }], cluster).then(r => r.value ?? r);

      const { transaction, ...meta } = await buildTransaction({ tipLamports, tipAccount });
      lastMeta = meta;
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = new window.solanaWeb3.PublicKey(payerWallet);

      const signedTx = await activeProvider.signTransaction(transaction);
      const serialized = signedTx.serialize();
      const signedTxBase64 = btoa(String.fromCharCode(...serialized));
      const signature = _base58Encode(signedTx.signatures[0].signature);

      onProgress?.('transferring'); // "Submitting via Smart TX Stack" step in the UI
      const submission = isDevnet
        ? await _submitDevnet(signedTxBase64)
        : await SmartTX.submitTransaction({ signedTxBase64, signature });

      if (!submission.success) {
        lastError = submission.error || 'Submission failed';
        const decision = await SmartTX.reasonAboutFailure(
          { signature, failure_type: 'BundleExecutionFailure', retry_count: attempt - 1, tip_paid_lamports: tipLamports },
          { congestion_level: 'UNKNOWN', recent_avg_confirmation_ms: null, recent_failure_rate: 0.1 },
        );
        if (decision.should_retry && attempt <= MAX_RETRIES) { urgency = 'HIGH'; continue; }
        throw new Error(lastError);
      }

      const outcome = await _waitForConfirmation(signature);
      if (outcome.confirmed) {
        return {
          txHash: signature, status: 'confirmed', success: true, simulated: false,
          tipLamports, usedFallback: submission.usedFallback || false,
          explorerUrl: `https://solscan.io/tx/${signature}`, ...lastMeta,
        };
      }

      // On a hard on-chain failure (not a timeout), it's already safe to retry,
      // the transaction is confirmed dead, it can't land later.
      if (outcome.failed) {
        lastError = `Transaction failed on-chain: ${JSON.stringify(outcome.err)}`;
        const decision = await SmartTX.reasonAboutFailure(
          { signature, failure_type: 'BundleExecutionFailure', retry_count: attempt - 1, tip_paid_lamports: tipLamports },
          { congestion_level: 'MEDIUM', recent_avg_confirmation_ms: CONFIRM_TIMEOUT_MS, recent_failure_rate: 0.15 },
        );
        if (decision.should_retry && attempt <= MAX_RETRIES) { urgency = 'CRITICAL'; continue; }
        throw new Error(lastError);
      }

      // Confirmation timed out. This does NOT mean it failed. It could still
      // land. Never submit a second transaction until we're certain the first
      // one can no longer confirm (blockhash expired).
      onProgress?.('transferring'); // stays on the same step, still safeguarding, not a new attempt yet
      const safety = await _waitForSafeRetry(signature, blockhash);
      if (safety.landedLate) {
        return {
          txHash: signature, status: 'confirmed', success: true, simulated: false,
          tipLamports, usedFallback: submission.usedFallback || false,
          explorerUrl: `https://solscan.io/tx/${signature}`, ...lastMeta,
        };
      }
      if (!safety.safeToRetry) {
        throw new Error('Transaction status is unclear. Please check your wallet history before trying again to avoid a duplicate.');
      }

      lastError = 'Confirmation timed out';
      const decision = await SmartTX.reasonAboutFailure(
        { signature, failure_type: 'Timeout', retry_count: attempt - 1, tip_paid_lamports: tipLamports },
        { congestion_level: 'HIGH', recent_avg_confirmation_ms: CONFIRM_TIMEOUT_MS, recent_failure_rate: 0.15 },
      );
      if (decision.should_retry && attempt <= MAX_RETRIES) { urgency = 'CRITICAL'; continue; }
      throw new Error(lastError);
    }

    throw new Error(lastError || 'Transaction failed after retries.');
  }

  async function executePrivatePayment({ paymentId, payerWallet, recipientWallet, amount, onProgress }) {
    await _checkSolBalance(payerWallet);
    await _checkUsdcBalance(payerWallet, amount);

    return _signAndSubmitWithRetry({
      payerWallet,
      onProgress,
      buildTransaction: async ({ tipLamports, tipAccount }) => {
        const { transaction, feeBaseUnits } = await PaymentTransfer.buildPaymentTransaction({
          payerWallet, recipientWallet, amount, tipLamports, tipAccount,
        });
        return { transaction, feeBaseUnits };
      },
    });
  }

  /**
   * Contributes to a shared savings goal, passkey-approved. The
   * passkey assertion (PasskeyClient.authorizePasskeyInstruction) is
   * obtained ONCE, before any retry attempt, not re-requested per
   * retry. This is intentional, not a shortcut: the WebAuthn challenge
   * only commits to the instruction's accounts and fixed arguments
   * (see passkey.rs hash_authorized_action), never to the blockhash,
   * so the same signed assertion is valid no matter how many times
   * the surrounding transaction gets rebuilt with a fresh blockhash on
   * retry. Asking the user to touch their device again on every retry
   * would be worse UX for no security benefit.
   *
   * No tip instruction is bundled into the transaction (unlike
   * executePrivatePayment). A tip transfer is itself an instruction,
   * and hash_authorized_action hashes every non-precompile
   * instruction's full bytes into the challenge, including its
   * position relative to the business instruction. Supporting that
   * correctly means the challenge computation and the final
   * transaction assembly have to agree on instruction order down to
   * the byte, which passkey-client.js does not attempt yet. Landing
   * still goes through the real dual-send (Jito bundle + RPC
   * concurrently via submit-bundle.js), just without a priority tip
   * on top.
   */
  async function contributeToGoal({
    payerWallet, vaultPda, goalPda, goalTokenAccount, mint, contributorTokenAccount,
    deviceRole, amountBaseUnits, decimals, credentialId, compressedPubkey33, onProgress,
  }) {
    onProgress?.('depositing');
    const { precompileIx, businessIx } = await window.PasskeyClient.authorizePasskeyInstruction({
      kind: 'contribute',
      args: {
        payer: payerWallet, vaultPda, goalPda, goalTokenAccount, mint,
        contributorTokenAccount, deviceRole, amountBaseUnits, decimals,
      },
      credentialId,
      compressedPubkey33,
    });

    return _signAndSubmitWithRetry({
      payerWallet,
      onProgress,
      cluster: window.SELA_CONFIG.PROGRAM_CLUSTER,
      buildTransaction: async () => {
        const web3 = window.solanaWeb3;
        const transaction = new web3.Transaction().add(precompileIx).add(businessIx);
        return { transaction, amountBaseUnits };
      },
    });
  }

  /** Symmetric to contributeToGoal, see its comment for the passkey
   * and no-tip design notes, both apply here unchanged. */
  async function withdrawFromGoal({
    payerWallet, vaultPda, goalPda, goalTokenAccount, mint, destinationTokenAccount,
    deviceRole, amountBaseUnits, decimals, credentialId, compressedPubkey33, onProgress,
  }) {
    onProgress?.('depositing');
    const { precompileIx, businessIx } = await window.PasskeyClient.authorizePasskeyInstruction({
      kind: 'withdraw',
      args: {
        payer: payerWallet, vaultPda, goalPda, goalTokenAccount, mint,
        destinationTokenAccount, deviceRole, amountBaseUnits, decimals,
      },
      credentialId,
      compressedPubkey33,
    });

    return _signAndSubmitWithRetry({
      payerWallet,
      onProgress,
      cluster: window.SELA_CONFIG.PROGRAM_CLUSTER,
      buildTransaction: async () => {
        const web3 = window.solanaWeb3;
        const transaction = new web3.Transaction().add(precompileIx).add(businessIx);
        return { transaction, amountBaseUnits };
      },
    });
  }

  /**
   * Creates a vault and its first shared goal in one atomic
   * transaction (init_family_vault, then init_savings_goal, both
   * signed by the connected wallet). Not passkey-gated, see both
   * instructions' Rust doc comments, vault/goal creation is an
   * ordinary wallet action; contributing to and withdrawing from the
   * goal afterward are what need a passkey. `primaryDeviceCompressedPubkey`
   * must come from PasskeyClient.registerPasskey(), called before
   * this, since device_role 0 is checked against it on every future
   * contribute/withdraw.
   */
  async function createGoal({
    payerWallet, primaryDeviceCompressedPubkey, guardianPubkey, feeTier,
    name, targetAmountBaseUnits, currency, deadlineUnixSeconds, mint, onProgress,
  }) {
    const web3 = window.solanaWeb3;
    const CP = window.CognataProgram;
    const vaultSeed = web3.Keypair.generate().publicKey;

    const result = await _signAndSubmitWithRetry({
      payerWallet,
      onProgress,
      cluster: window.SELA_CONFIG.PROGRAM_CLUSTER,
      buildTransaction: async () => {
        const { instruction: vaultIx, vaultPda } = CP.buildInitFamilyVaultInstruction({
          payer: payerWallet, vaultSeedPubkey: vaultSeed,
          primaryDeviceCompressedPubkey, partnerDeviceCompressedPubkey: null,
          guardianPubkey, feeTier,
        });
        const { instruction: goalIx, goalPda, goalTokenAccount } = CP.buildInitSavingsGoalInstruction({
          payer: payerWallet, vaultPda, goalSeq: 0, mint, name,
          targetAmountBaseUnits, currency, deadlineUnixSeconds,
        });
        const transaction = new web3.Transaction().add(vaultIx).add(goalIx);
        return { transaction, vaultPda: vaultPda.toBase58(), goalPda: goalPda.toBase58(), goalTokenAccount: goalTokenAccount.toBase58() };
      },
    });

    return result;
  }

  /**
   * Adds a goal to a vault that already exists (second, third, ... goal
   * for the same wallet). Unlike createGoal, no passkey registration,
   * the device is already registered from the vault's first goal.
   */
  async function addGoalToVault({ payerWallet, instruction, onProgress }) {
    return _signAndSubmitWithRetry({
      payerWallet,
      onProgress,
      cluster: window.SELA_CONFIG.PROGRAM_CLUSTER,
      buildTransaction: async () => ({ transaction: new window.solanaWeb3.Transaction().add(instruction) }),
    });
  }

  /** New member joining an existing vault: signed by their own wallet,
   * not the owner's, see program-client.js buildRequestKeyRotationInstruction. */
  async function requestJoinVault({ payerWallet, instruction, onProgress }) {
    return _signAndSubmitWithRetry({
      payerWallet, onProgress,
      cluster: window.SELA_CONFIG.PROGRAM_CLUSTER,
      buildTransaction: async () => ({ transaction: new window.solanaWeb3.Transaction().add(instruction) }),
    });
  }

  /** Owner/guardian approving a pending join (or revoking, if the
   * instruction was built with an all-zero new device pubkey). */
  async function approveJoinRequest({ payerWallet, instruction, onProgress }) {
    return _signAndSubmitWithRetry({
      payerWallet, onProgress,
      cluster: window.SELA_CONFIG.PROGRAM_CLUSTER,
      buildTransaction: async () => ({ transaction: new window.solanaWeb3.Transaction().add(instruction) }),
    });
  }

  return {
    init,
    connectWallet,
    createPrivatePayment,
    executePrivatePayment,
    createGoal,
    addGoalToVault,
    requestJoinVault,
    approveJoinRequest,
    contributeToGoal,
    withdrawFromGoal,
    get isSimulated() { return false; },
    get activeWalletName() { return _activeWalletName; },
  };
})();

window.VeilEngine = VeilEngine;

window.addEventListener('DOMContentLoaded', () => {
  VeilEngine.init();
});
