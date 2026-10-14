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
  // Comes from sela-config.js so the ID lives in one place.
  const PROGRAM_ID = (window.SELA_CONFIG || {}).PROGRAM_ID;

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

  function _i64LE(n) {
    const big = typeof n === 'bigint' ? n : BigInt(Math.trunc(n));
    const buf = new Uint8Array(8);
    new DataView(buf.buffer).setBigInt64(0, big, true);
    return buf;
  }

  function _string(str) {
    return _vecU8(new TextEncoder().encode(str));
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
   * Passkey-gated instructions (contribute, withdraw) can't be built
   * in one pass: the challenge WebAuthn signs is a hash over this
   * same instruction's account list and fixed-size argument prefix
   * (see passkey.rs hash_authorized_action), which has to exist
   * BEFORE authenticator_data/client_data_json do, and those are only
   * produced BY the WebAuthn call the challenge feeds into. So every
   * one of these instructions is built in two phases:
   *   1. a "challenge material" function, program_id + keys + the
   *      fixed prefix bytes, everything the challenge hash needs and
   *      nothing that depends on it
   *   2. a "finalize" function that takes that same material plus the
   *      real authenticator_data/client_data_json (from
   *      passkey-client.js, which is what actually calls part 1, then
   *      WebAuthn, then part 2) and returns the real instruction
   * passkey-client.js is what drives this, not code that calls these
   * directly.
   */

  function _contributeChallengeMaterial({
    payer, vaultPda, goalPda, goalTokenAccount, mint,
    contributorTokenAccount, deviceRole, amountBaseUnits, decimals,
  }) {
    const { pda: feeConfigPda } = deriveFeeConfigPda();
    const { pda: treasuryPda } = deriveTreasuryPda();
    const feeDestination = getAssociatedTokenAddress(treasuryPda, mint);
    const { pda: walletAuthorityPda } = deriveWalletAuthorityPda(vaultPda, deviceRole);

    const prefix = _concat([
      new Uint8Array(DISCRIMINATORS.contribute),
      _u8(deviceRole),
      _u64LE(amountBaseUnits),
      _u8(decimals),
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

    return { programId: PROGRAM_ID, keys, prefix };
  }

  function _finalizePasskeyInstruction({ programId, keys, prefix, authenticatorData, clientDataJson }) {
    const web3 = _web3();
    const data = _concat([prefix, _vecU8(authenticatorData), _vecU8(clientDataJson)]);
    return new web3.TransactionInstruction({ programId: new web3.PublicKey(programId), keys, data });
  }

  /** Full one-shot builder, used only when authenticatorData/clientDataJson
   * are already in hand (e.g. re-assembling for a retry). Normal flow
   * goes through passkey-client.js's two-phase orchestration instead. */
  function buildContributeInstruction(args) {
    return _finalizePasskeyInstruction({ ..._contributeChallengeMaterial(args), ...args });
  }

  function _withdrawChallengeMaterial({
    payer, vaultPda, goalPda, goalTokenAccount, mint,
    destinationTokenAccount, deviceRole, amountBaseUnits, decimals,
  }) {
    const prefix = _concat([
      new Uint8Array(DISCRIMINATORS.withdraw),
      _u8(deviceRole),
      _u64LE(amountBaseUnits),
      _u8(decimals),
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

    return { programId: PROGRAM_ID, keys, prefix };
  }

  function buildWithdrawInstruction(args) {
    return _finalizePasskeyInstruction({ ..._withdrawChallengeMaterial(args), ...args });
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

  /**
   * Builds `init_family_vault`. Not passkey-gated, backend_authority
   * is just the connected wallet (see init_family_vault.rs doc
   * comment: vault creation happens before any device is registered,
   * so there is nothing yet to check a passkey signature against).
   * `primaryDeviceCompressedPubkey` is the 33-byte compressed P-256
   * key from registering a passkey, see passkey-client.js
   * registerPasskey(). `partnerDeviceCompressedPubkey` may be null
   * for a single-contributor goal, a placeholder all-zero key is used
   * (device_role 1 simply can never match it, so it can never
   * authorize anything, matches the program's UnauthorizedContributor
   * check on any other value).
   */
  function buildInitFamilyVaultInstruction({
    payer, vaultSeedPubkey, primaryDeviceCompressedPubkey, partnerDeviceCompressedPubkey,
    guardianPubkey, feeTier,
  }) {
    const web3 = _web3();
    const { pda: vaultPda } = deriveVaultPda(vaultSeedPubkey);
    const partnerDevice = partnerDeviceCompressedPubkey || new Uint8Array(33);
    const guardian = guardianPubkey || payer;

    const data = _concat([
      new Uint8Array(DISCRIMINATORS.init_family_vault),
      new web3.PublicKey(vaultSeedPubkey).toBuffer(),
      new Uint8Array(primaryDeviceCompressedPubkey),
      new Uint8Array(partnerDevice),
      new web3.PublicKey(guardian).toBuffer(),
      _u8(feeTier ?? 0),
    ]);

    const keys = [
      _meta(payer, true, true),
      _meta(vaultPda, false, true),
      _meta(web3.SystemProgram.programId, false, false),
    ];

    return { instruction: new web3.TransactionInstruction({ programId: new web3.PublicKey(PROGRAM_ID), keys, data }), vaultPda };
  }

  /**
   * Builds `init_savings_goal`. Caller must be vault.creator (the
   * wallet that called init_family_vault), enforced on-chain. Not
   * passkey-gated either, adding the shared goal to a vault you
   * created is an ordinary wallet action, contributing to and
   * withdrawing from it afterward are what need a passkey.
   * `goalSeq` must be the vault's CURRENT goal_seq (read the vault
   * account first), needed client-side to derive the goal PDA.
   */
  function buildInitSavingsGoalInstruction({
    payer, vaultPda, goalSeq, mint, name, targetAmountBaseUnits, currency, deadlineUnixSeconds,
  }) {
    const web3 = _web3();
    const { pda: goalPda } = deriveGoalPda(vaultPda, goalSeq);
    const goalTokenAccount = getAssociatedTokenAddress(goalPda, mint);
    const ASSOCIATED_TOKEN_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

    const data = _concat([
      new Uint8Array(DISCRIMINATORS.init_savings_goal),
      _string(name),
      _u64LE(targetAmountBaseUnits),
      _u8(currency ?? 1),
      _i64LE(deadlineUnixSeconds),
    ]);

    const keys = [
      _meta(payer, true, true),
      _meta(vaultPda, false, true),
      _meta(goalPda, false, true),
      _meta(goalTokenAccount, false, true),
      _meta(mint, false, false),
      _meta(TOKEN_PROGRAM_ID, false, false),
      _meta(ASSOCIATED_TOKEN_PROGRAM_ID, false, false),
      _meta(web3.SystemProgram.programId, false, false),
    ];

    return { instruction: new web3.TransactionInstruction({ programId: new web3.PublicKey(PROGRAM_ID), keys, data }), goalPda, goalTokenAccount };
  }

  // ---- Account decoders. Browser-side (DataView/TextDecoder, no
  // Node Buffer), field order copied verbatim from state.rs. `data`
  // is the raw account bytes as returned by getAccountInfo (base64
  // decoded to a Uint8Array first). Used to read real on-chain state
  // for display, never to compute anything that gets signed. ----

  function decodeFamilyVault(data) {
    const d = data instanceof Uint8Array ? data : new Uint8Array(data);
    const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
    let o = 8;
    const vaultAuthority = d.slice(o, o + 32); o += 32;
    const vaultSeed = d.slice(o, o + 32); o += 32;
    const primaryContributorDevice = d.slice(o, o + 33); o += 33;
    const partnerDevice = d.slice(o, o + 33); o += 33;
    const guardian = d.slice(o, o + 32); o += 32;
    const feeTier = d[o]; o += 1;
    const goalSeq = dv.getUint32(o, true); o += 4;
    const bump = d[o]; o += 1;
    const createdAt = dv.getBigInt64(o, true); o += 8;
    const creator = d.slice(o, o + 32); o += 32;
    return {
      vaultAuthority: new (_web3().PublicKey)(vaultAuthority),
      vaultSeed: new (_web3().PublicKey)(vaultSeed),
      primaryContributorDevice, partnerDevice,
      guardian: new (_web3().PublicKey)(guardian),
      feeTier, goalSeq, bump, createdAt,
      creator: new (_web3().PublicKey)(creator),
    };
  }

  const GOAL_STATUS = { 0: 'Active', 1: 'Completed', 2: 'Withdrawn' };
  const CURRENCY = { 0: 'Sol', 1: 'Usdc' };

  function decodeSavingsGoal(data) {
    const d = data instanceof Uint8Array ? data : new Uint8Array(data);
    const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
    let o = 8;
    const vault = d.slice(o, o + 32); o += 32;
    const goalSeq = dv.getUint32(o, true); o += 4;
    const nameBytes = d.slice(o, o + 32); o += 32;
    const targetAmount = dv.getBigUint64(o, true); o += 8;
    const currentAmount = dv.getBigUint64(o, true); o += 8;
    const currency = CURRENCY[d[o]] || 'Unknown'; o += 1;
    const deadline = dv.getBigInt64(o, true); o += 8;
    const status = GOAL_STATUS[d[o]] || 'Unknown'; o += 1;
    const mint = d.slice(o, o + 32); o += 32;
    const goalTokenAccount = d.slice(o, o + 32); o += 32;
    const bump = d[o]; o += 1;
    const createdAt = dv.getBigInt64(o, true); o += 8;
    const nullIdx = nameBytes.indexOf(0);
    const name = new TextDecoder().decode(nameBytes.slice(0, nullIdx === -1 ? 32 : nullIdx));
    return {
      vault: new (_web3().PublicKey)(vault), goalSeq, name,
      targetAmount, currentAmount, currency, deadline, status,
      mint: new (_web3().PublicKey)(mint),
      goalTokenAccount: new (_web3().PublicKey)(goalTokenAccount),
      bump, createdAt,
    };
  }

  /**
   * The account contributions are actually paid FROM. Not the user's
   * own wallet: contribute() moves funds with a CPI signed by the
   * wallet_authority PDA, and the token program only accepts that if
   * the source token account is owned by that same PDA. So each device
   * has a "holding" associated token account owned by its
   * wallet_authority PDA, funds go in there first (deposit), and the
   * passkey then authorizes moving them from there into the goal.
   * Passing a normal wallet's token account as the contribute source is
   * rejected by the token program with an owner mismatch.
   */
  function holdingAccountFor(vaultPda, deviceRole, mint) {
    const { pda: owner } = deriveWalletAuthorityPda(vaultPda, deviceRole);
    return { owner, ata: getAssociatedTokenAddress(owner, mint) };
  }

  /**
   * Creates a device's holding account (idempotent, a no-op if it
   * already exists). `payer` funds the rent and signs. Split out so a
   * server can create it at vault creation, which means the account
   * exists from the start and anyone can send USDC straight to its
   * address (a transfer to a token account that doesn't exist yet fails).
   */
  function buildCreateHoldingAccountInstruction({ payer, vaultPda, deviceRole, mint }) {
    const web3 = _web3();
    const ASSOCIATED_TOKEN_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
    const { owner, ata } = holdingAccountFor(vaultPda, deviceRole, mint);
    const instruction = new web3.TransactionInstruction({
      programId: new web3.PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID),
      keys: [
        _meta(payer, true, true),
        _meta(ata, false, true),
        _meta(owner, false, false),
        _meta(mint, false, false),
        _meta(web3.SystemProgram.programId, false, false),
        _meta(TOKEN_PROGRAM_ID, false, false),
      ],
      data: new Uint8Array([1]), // CreateIdempotent
    });
    return { instruction, ata };
  }

  /**
   * Instructions to move USDC from a normal wallet's token account into
   * the device's holding account (creating it first if needed, the
   * idempotent create is a no-op when it already exists). `payer` is
   * the wallet that owns sourceTokenAccount, it signs the transfer.
   * Plain SPL, nothing here touches the Sela program, so it works from
   * any wallet or exchange withdrawal too, the destination address is
   * all anyone needs.
   */
  function buildDepositInstructions({ payer, vaultPda, deviceRole, mint, sourceTokenAccount, amountBaseUnits, decimals }) {
    const web3 = _web3();
    const { ata } = holdingAccountFor(vaultPda, deviceRole, mint);
    const createAta = buildCreateHoldingAccountInstruction({ payer, vaultPda, deviceRole, mint }).instruction;

    const transfer = new web3.TransactionInstruction({
      programId: new web3.PublicKey(TOKEN_PROGRAM_ID),
      keys: [
        _meta(sourceTokenAccount, false, true),
        _meta(mint, false, false),
        _meta(ata, false, true),
        _meta(payer, true, false),
      ],
      data: _concat([new Uint8Array([12]), _u64LE(amountBaseUnits), _u8(decimals)]), // TransferChecked
    });

    return { instructions: [createAta, transfer], holdingAta: ata };
  }

  function deriveRotationRequestPda(vaultPda, deviceRole) {
    const web3 = _web3();
    const [pda, bump] = web3.PublicKey.findProgramAddressSync(
      [new TextEncoder().encode('rotation'), new web3.PublicKey(vaultPda).toBuffer(), _u8(deviceRole)],
      new web3.PublicKey(PROGRAM_ID),
    );
    return { pda, bump };
  }

  /**
   * Builds `request_key_rotation`. This is also how a second family
   * member joins: the same instruction the program calls "key
   * rotation" is, mechanically, the only existing way to set a
   * vault's device_role=1 slot after vault creation (there is no
   * separate "add member" instruction, and none was added for this,
   * see ACCOUNTS.md / the join flow notes). `payer` is the NEW
   * member's own wallet, not the vault owner's, they pay their own
   * account creation rent and sign with their own key, no key
   * material is ever shared between devices.
   */
  function buildRequestKeyRotationInstruction({ payer, vaultPda, deviceRole, newDeviceCompressedPubkey }) {
    const web3 = _web3();
    const { pda: rotationPda } = deriveRotationRequestPda(vaultPda, deviceRole);
    const data = _concat([
      new Uint8Array(DISCRIMINATORS.request_key_rotation),
      _u8(deviceRole),
      new Uint8Array(newDeviceCompressedPubkey),
    ]);
    const keys = [
      _meta(payer, true, true),
      _meta(vaultPda, false, false),
      _meta(rotationPda, false, true),
      _meta(web3.SystemProgram.programId, false, false),
    ];
    return { instruction: new web3.TransactionInstruction({ programId: new web3.PublicKey(PROGRAM_ID), keys, data }), rotationPda };
  }

  /**
   * Builds `approve_key_rotation`. Guardian-only (vault.guardian must
   * sign), writes new_device_pubkey into the vault's device_role slot
   * unconditionally, this is what actually grants authority, the
   * request itself grants nothing. Approving a rotation to a 33-byte
   * all-zero pubkey is also how a device gets revoked, there is no
   * separate revoke instruction, see the join flow notes.
   */
  function buildApproveKeyRotationInstruction({ guardian, vaultPda, deviceRole }) {
    const web3 = _web3();
    const { pda: rotationPda } = deriveRotationRequestPda(vaultPda, deviceRole);
    const data = new Uint8Array(DISCRIMINATORS.approve_key_rotation);
    const keys = [
      _meta(guardian, true, false),
      _meta(vaultPda, false, true),
      _meta(rotationPda, false, true),
    ];
    return new web3.TransactionInstruction({ programId: new web3.PublicKey(PROGRAM_ID), keys, data });
  }

  const ROTATION_STATUS = { 0: 'Pending', 1: 'Approved', 2: 'Executed', 3: 'Rejected' };

  function decodeKeyRotationRequest(data) {
    const d = data instanceof Uint8Array ? data : new Uint8Array(data);
    const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
    let o = 8;
    const vault = d.slice(o, o + 32); o += 32;
    const deviceRole = d[o]; o += 1;
    const lostDevicePubkey = d.slice(o, o + 33); o += 33;
    const newDevicePubkey = d.slice(o, o + 33); o += 33;
    const guardian = d.slice(o, o + 32); o += 32;
    const status = ROTATION_STATUS[d[o]] || 'Unknown'; o += 1;
    const requestedAt = dv.getBigInt64(o, true); o += 8;
    const approvedAt = dv.getBigInt64(o, true); o += 8;
    return {
      vault: new (_web3().PublicKey)(vault), deviceRole, lostDevicePubkey, newDevicePubkey,
      guardian: new (_web3().PublicKey)(guardian), status, requestedAt, approvedAt,
    };
  }

  return {
    PROGRAM_ID,
    deriveVaultPda,
    deriveGoalPda,
    deriveFeeConfigPda,
    deriveTreasuryPda,
    deriveWalletAuthorityPda,
    deriveDelegatePda,
    deriveRotationRequestPda,
    holdingAccountFor,
    buildCreateHoldingAccountInstruction,
    buildDepositInstructions,
    buildRequestKeyRotationInstruction,
    buildApproveKeyRotationInstruction,
    decodeKeyRotationRequest,
    getAssociatedTokenAddress,
    buildContributeInstruction,
    buildWithdrawInstruction,
    buildExecuteRecurringContributionInstruction,
    buildInitFamilyVaultInstruction,
    buildInitSavingsGoalInstruction,
    decodeFamilyVault,
    decodeSavingsGoal,
    // Exposed for passkey-client.js's two-phase orchestration.
    _contributeChallengeMaterial,
    _withdrawChallengeMaterial,
    _finalizePasskeyInstruction,
  };
})();

window.CognataProgram = CognataProgram;
