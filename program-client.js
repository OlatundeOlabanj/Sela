/**
 * Cognata Program client
 *
 * Hand-rolled Anchor instruction encoder, no @coral-xyz/anchor
 * dependency (matches this codebase's existing no-heavy-client-libs
 * pattern in payment-transfer.js/swap.js). Builds raw
 * TransactionInstruction objects for the three instructions that
 * "power Cognata's family transactions": contribute (shared savings
 * goal contributions), withdraw, and execute_recurring_contribution
 * (allowances).
 *
 * Discriminators below are the standard Anchor sighash
 * (sha256("global:<instruction_name>")[0..8]), computed once offline
 * and hardcoded rather than recomputed with crypto.subtle on every
 * call, they never change for a given instruction name.
 *
 * Account orderings and PDA seeds are copied directly from each
 * instruction's #[derive(Accounts)] struct in
 * programs/cognata/src/instructions/*.rs. If those structs change,
 * this file has to change with them, there is no IDL being read here
 * to keep the two in sync automatically.
 *
 * Made by TJS Code
 */

const CognataProgram = (() => {
  // TODO: keep in sync with declare_id! in programs/cognata/src/lib.rs
  // and Anchor.toml. Still a placeholder, see ACCOUNTS.md.
  const PROGRAM_ID = '6apQZUxBwpBbFNiBpYzGeMBQJ8328xrrsQ3aRcQhM2Av';

  const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  const SYSVAR_INSTRUCTIONS_PUBKEY = 'Sysvar1nstructions1111111111111111111111111';

  const DISCRIMINATORS = {
    init_family_vault: [36, 0, 188, 102, 174, 230, 162, 176],
    init_savings_goal: [135, 151, 140, 195, 2, 208, 16, 10],
    contribute: [82, 33, 68, 131, 32, 0, 205, 95],
    withdraw: [183, 18, 70, 156, 148, 109, 161, 34],
    authorize_recurring_delegate: [230, 242, 4, 87, 97, 63, 91, 10],
    cancel_recurring_delegate: [137, 141, 143, 218, 110, 252, 63, 118],
    execute_recurring_contribution: [151, 222, 238, 179, 96, 158, 148, 58],
    request_key_rotation: [96, 121, 1, 91, 5, 208, 32, 121],
    approve_key_rotation: [174, 131, 66, 9, 23, 69, 255, 22],
    init_fee_config: [212, 138, 200, 114, 73, 176, 7, 197],
    init_treasury: [105, 152, 173, 51, 158, 151, 49, 14],
    claim_fees: [82, 251, 233, 156, 12, 52, 184, 202],
  };

  function _web3() {
    if (typeof window.solanaWeb3 === 'undefined') {
      throw new Error('Solana web3.js not loaded.');
    }
    return window.solanaWeb3;
  }

  // ---- Borsh-style scalar encoders (only the shapes this program's
  // instructions actually use; not a general Borsh implementation) ----

  function _u8(n) {
    return new Uint8Array([n & 0xff]);
  }

  function _u32LE(n) {
    const buf = new Uint8Array(4);
    new DataView(buf.buffer).setUint32(0, n, true);
    return buf;
  }

  function _u64LE(n) {
    // n may be a number, a BigInt, or an anchor-style BN-free plain
    // integer, base-token-unit amounts fit comfortably in a JS number
    // (Number.MAX_SAFE_INTEGER is ~9e15, well past realistic USDC
    // amounts at 6 decimals), but accept BigInt too for callers who
    // prefer it.
    const big = typeof n === 'bigint' ? n : BigInt(Math.trunc(n));
    const buf = new Uint8Array(8);
    const view = new DataView(buf.buffer);
    view.setBigUint64(0, big, true);
    return buf;
  }

  function _vecU8(bytes) {
    const body = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const out = new Uint8Array(4 + body.length);
    out.set(_u32LE(body.length), 0);
    out.set(body, 4);
    return out;
  }

  function _concat(arrays) {
    const total = arrays.reduce((n, a) => n + a.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const a of arrays) { out.set(a, offset); offset += a.length; }
    return out;
  }

  // ---- PDA derivation, seeds copied verbatim from the Rust structs ----

  function deriveVaultPda(vaultSeedPubkey) {
    const web3 = _web3();
    const [pda, bump] = web3.PublicKey.findProgramAddressSync(
      [new TextEncoder().encode('vault'), new web3.PublicKey(vaultSeedPubkey).toBuffer()],
      new web3.PublicKey(PROGRAM_ID),
    );
    return { pda, bump };
  }

  function deriveGoalPda(vaultPda, goalSeq) {
    const web3 = _web3();
    const [pda, bump] = web3.PublicKey.findProgramAddressSync(
      [new TextEncoder().encode('goal'), new web3.PublicKey(vaultPda).toBuffer(), _u32LE(goalSeq)],
      new web3.PublicKey(PROGRAM_ID),
    );
    return { pda, bump };
  }

  function deriveFeeConfigPda() {
    const web3 = _web3();
    const [pda, bump] = web3.PublicKey.findProgramAddressSync(
      [new TextEncoder().encode('fee_config')],
      new web3.PublicKey(PROGRAM_ID),
    );
    return { pda, bump };
  }

  function deriveTreasuryPda() {
    const web3 = _web3();
    const [pda, bump] = web3.PublicKey.findProgramAddressSync(
      [new TextEncoder().encode('treasury')],
      new web3.PublicKey(PROGRAM_ID),
    );
    return { pda, bump };
  }

  function deriveWalletAuthorityPda(vaultPda, deviceRole) {
    const web3 = _web3();
    const [pda, bump] = web3.PublicKey.findProgramAddressSync(
      [new TextEncoder().encode('wallet'), new web3.PublicKey(vaultPda).toBuffer(), _u8(deviceRole)],
      new web3.PublicKey(PROGRAM_ID),
    );
    return { pda, bump };
  }

  function deriveDelegatePda(goalPda) {
    const web3 = _web3();
    const [pda, bump] = web3.PublicKey.findProgramAddressSync(
      [new TextEncoder().encode('delegate'), new web3.PublicKey(goalPda).toBuffer()],
      new web3.PublicKey(PROGRAM_ID),
    );
    return { pda, bump };
  }

  // Reused from payment-transfer.js's own derivation rather than
  // duplicated: same formula (owner, TOKEN_PROGRAM_ID, mint) under the
  // associated token program.
  function getAssociatedTokenAddress(owner, mint) {
    if (typeof window.PaymentTransfer !== 'undefined') {
      return window.PaymentTransfer.getAssociatedTokenAddress(
        new (_web3().PublicKey)(owner),
        new (_web3().PublicKey)(mint),
      );
    }
    // Fallback if payment-transfer.js isn't loaded on this page for
    // some reason, identical derivation, duplicated rather than making
    // this file hard-depend on load order.
    const web3 = _web3();
    const ASSOCIATED_TOKEN_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
    const [ata] = web3.PublicKey.findProgramAddressSync(
      [
        new web3.PublicKey(owner).toBuffer(),
        new web3.PublicKey(TOKEN_PROGRAM_ID).toBuffer(),
        new web3.PublicKey(mint).toBuffer(),
      ],
      new web3.PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID),
    );
    return ata;
  }

  function _meta(pubkey, isSigner, isWritable) {
    return { pubkey: new (_web3().PublicKey)(pubkey), isSigner, isWritable };
  }

  /**
   * Builds the `contribute` instruction. Account order and every
   * PDA/ATA derivation here must match instructions/contribute.rs
   * exactly, Anchor account resolution is strictly positional.
   *
   * `authenticatorData` / `clientDataJson` are raw bytes from a
   * WebAuthn assertion, see passkey-client.js for how those and the
   * accompanying secp256r1 precompile instruction are produced,
   * that precompile instruction MUST be placed immediately before
   * this one in the transaction (or anywhere earlier, but simplest as
   * directly before).
   */
  function buildContributeInstruction({
    payer, vaultPda, goalPda, goalTokenAccount, mint,
    contributorTokenAccount, deviceRole, amountBaseUnits, decimals,
    authenticatorData, clientDataJson,
  }) {
    const web3 = _web3();
    const { pda: feeConfigPda } = deriveFeeConfigPda();
    const { pda: treasuryPda } = deriveTreasuryPda();
    const feeDestination = getAssociatedTokenAddress(treasuryPda, mint);
    const { pda: walletAuthorityPda } = deriveWalletAuthorityPda(vaultPda, deviceRole);

    const data = _concat([
      new Uint8Array(DISCRIMINATORS.contribute),
      _u8(deviceRole),
      _u64LE(amountBaseUnits),
      _u8(decimals),
      _vecU8(authenticatorData),
      _vecU8(clientDataJson),
    ]);

    const keys = [
      _meta(payer, true, true),
      _meta(SYSVAR_INSTRUCTIONS_PUBKEY, false, false),
      _meta(feeConfigPda, false, false),
      _meta(vaultPda, false, false),
      _meta(goalPda, false, true),
      _meta(goalTokenAccount, false, true),
      _meta(treasuryPda, false, false),
      _meta(feeDestination, false, true),
      _meta(contributorTokenAccount, false, true),
      _meta(walletAuthorityPda, false, false),
      _meta(mint, false, false),
      _meta(TOKEN_PROGRAM_ID, false, false),
    ];

    return new web3.TransactionInstruction({ programId: new web3.PublicKey(PROGRAM_ID), keys, data });
  }

  /**
   * Builds the `withdraw` instruction. Same passkey-proof shape as
   * contribute (business_data_len=10: device_role + amount + decimals),
   * different, smaller account list, see instructions/withdraw.rs.
   */
  function buildWithdrawInstruction({
    payer, vaultPda, goalPda, goalTokenAccount, mint,
    destinationTokenAccount, deviceRole, amountBaseUnits, decimals,
    authenticatorData, clientDataJson,
  }) {
    const web3 = _web3();

    const data = _concat([
      new Uint8Array(DISCRIMINATORS.withdraw),
      _u8(deviceRole),
      _u64LE(amountBaseUnits),
      _u8(decimals),
      _vecU8(authenticatorData),
      _vecU8(clientDataJson),
    ]);

    const keys = [
      _meta(payer, true, true),
      _meta(SYSVAR_INSTRUCTIONS_PUBKEY, false, false),
      _meta(vaultPda, false, false),
      _meta(goalPda, false, true),
      _meta(goalTokenAccount, false, true),
      _meta(destinationTokenAccount, false, true),
      _meta(mint, false, false),
      _meta(TOKEN_PROGRAM_ID, false, false),
    ];

    return new web3.TransactionInstruction({ programId: new web3.PublicKey(PROGRAM_ID), keys, data });
  }

  /**
   * Builds the `execute_recurring_contribution` instruction, the
   * "allowance" disbursement. NOT passkey-gated: the spending
   * authority is the on-chain delegate PDA (set up once, earlier, via
   * authorize_recurring_delegate, which IS passkey-gated), this call
   * just triggers a due, already-authorized transfer, so any keeper
   * can submit it (see instructions/execute_recurring_contribution.rs
   * doc comment: a compromised keeper key still can't move more than
   * amount_per_period, early, or anywhere but the fixed destinations).
   *
   * `keeper` pays the tx fee and is the only required signer.
   */
  function buildExecuteRecurringContributionInstruction({
    keeper, vaultPda, goalPda, delegatePda, goalTokenAccount, mint,
    sourceTokenAccount, decimals,
  }) {
    const web3 = _web3();
    const { pda: feeConfigPda } = deriveFeeConfigPda();
    const { pda: treasuryPda } = deriveTreasuryPda();
    const feeDestination = getAssociatedTokenAddress(treasuryPda, mint);

    const data = _concat([
      new Uint8Array(DISCRIMINATORS.execute_recurring_contribution),
      _u8(decimals),
    ]);

    const keys = [
      _meta(keeper, true, true),
      _meta(feeConfigPda, false, false),
      _meta(vaultPda, false, false),
      _meta(goalPda, false, true),
      _meta(delegatePda, false, true),
      _meta(goalTokenAccount, false, true),
      _meta(treasuryPda, false, false),
      _meta(feeDestination, false, true),
      _meta(sourceTokenAccount, false, true),
      _meta(mint, false, false),
      _meta(TOKEN_PROGRAM_ID, false, false),
    ];

    return new web3.TransactionInstruction({ programId: new web3.PublicKey(PROGRAM_ID), keys, data });
  }

  return {
    PROGRAM_ID,
    deriveVaultPda,
    deriveGoalPda,
    deriveFeeConfigPda,
    deriveTreasuryPda,
    deriveWalletAuthorityPda,
    deriveDelegatePda,
    getAssociatedTokenAddress,
    buildContributeInstruction,
    buildWithdrawInstruction,
    buildExecuteRecurringContributionInstruction,
  };
})();

window.CognataProgram = CognataProgram;
