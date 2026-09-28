/**
 * VeilPay, Payment Transfer layer
 * Real SPL Token (USDC) transfer on Solana mainnet, wallet-to-wallet.
 * No third-party rollup, no simulation.
 *
 * Why not Confidential Transfers: USDC's mint predates Token-2022 and
 * cannot gain the Confidential Transfer extension retroactively,
 * Circle would need to issue a separate Token-2022 USDC for that to
 * be possible. That's a real ecosystem constraint, not a shortcut.
 * See README for the full note on this.
 *
 * Instructions are built by hand (no @solana/spl-token package) since
 * this project has no build step, the SPL Token program's
 * instruction layout is small, stable, and well-documented, so this
 * carries none of the risk that hand-rolling actual cryptography would.
 *
 * One transaction, one Phantom signature, contains:
 *   1. Create recipient's USDC account (idempotent, no-ops if it exists)
 *   2. Create platform fee wallet's USDC account (idempotent)
 *   3. Transfer 98% to recipient
 *   4. Transfer 2% platform fee
 *   5. Transfer Jito tip (paid by the same signature, landed by Smart TX Stack)
 *
 * Made by TJS Code
 */

const PAYMENT_CONFIG = {
  network: 'mainnet-beta',
  usdcMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  usdcDecimals: 6,
  invoiceFeeBps: 200, // 2.00%
};

const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ASSOCIATED_TOKEN_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

// Program ID and fee routing come from sela-config.js (the one place
// cluster and address settings live). It must be loaded first.
const _SELA_CFG = window.SELA_CONFIG || {};
const COGNATA_PROGRAM_ID = _SELA_CFG.PROGRAM_ID;

const PaymentTransfer = (() => {
  function _web3() {
    if (typeof window.solanaWeb3 === 'undefined') {
      throw new Error('Solana web3.js not loaded.');
    }
    return window.solanaWeb3;
  }

  function _u64LEBytes(amount) {
    const buf = new Uint8Array(8);
    let n = BigInt(amount);
    for (let i = 0; i < 8; i++) { buf[i] = Number(n & 0xffn); n >>= 8n; }
    return buf;
  }

  function _toBaseUnits(amount) {
    return Math.round(amount * Math.pow(10, PAYMENT_CONFIG.usdcDecimals));
  }

  function getAssociatedTokenAddress(owner, mint) {
    const web3 = _web3();
    const [ata] = web3.PublicKey.findProgramAddressSync(
      [owner.toBuffer(), new web3.PublicKey(TOKEN_PROGRAM_ID).toBuffer(), mint.toBuffer()],
      new web3.PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID),
    );
    return ata;
  }

  // Owner of the fee token account for mainnet payments. In 'wallet'
  // mode (the default until the program is deployed to mainnet) this is
  // the configured fee wallet, so fees stay recoverable. In
  // 'treasury_pda' mode it is the program's treasury PDA. A PDA of a
  // program that is not deployed on mainnet must never receive fees,
  // nothing could ever sign for it.
  function getFeeDestinationOwner() {
    const web3 = _web3();
    if (_SELA_CFG.FEE_MODE === 'treasury_pda') return getTreasuryPda();
    if (!_SELA_CFG.FEE_WALLET) throw new Error('FEE_WALLET missing from sela-config.js');
    return new web3.PublicKey(_SELA_CFG.FEE_WALLET);
  }

  // The program treasury PDA. The fee destination is the
  // Cognata program's own [b"treasury"] PDA (see
  // programs/cognata/src/state.rs Treasury /
  // instructions/claim_fees.rs) — a program-owned address with no
  // private key, derived deterministically here from the program ID,
  // not a pubkey that lives as a string anyone could swap out.
  function getTreasuryPda() {
    const web3 = _web3();
    const [treasuryPda] = web3.PublicKey.findProgramAddressSync(
      [new TextEncoder().encode('treasury')],
      new web3.PublicKey(COGNATA_PROGRAM_ID),
    );
    return treasuryPda;
  }

  function createIdempotentAtaInstruction({ payer, owner, mint }) {
    const web3 = _web3();
    const ata = getAssociatedTokenAddress(owner, mint);
    return new web3.TransactionInstruction({
      programId: new web3.PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID),
      keys: [
        { pubkey: payer, isSigner: true, isWritable: true },
        { pubkey: ata, isSigner: false, isWritable: true },
        { pubkey: owner, isSigner: false, isWritable: false },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: web3.SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: new web3.PublicKey(TOKEN_PROGRAM_ID), isSigner: false, isWritable: false },
      ],
      data: new Uint8Array([1]), // CreateIdempotent
    });
  }

  function transferCheckedInstruction({ source, mint, destination, owner, amount, decimals }) {
    const web3 = _web3();
    const data = new Uint8Array(10);
    data[0] = 12; // TransferChecked
    data.set(_u64LEBytes(amount), 1);
    data[9] = decimals;
    return new web3.TransactionInstruction({
      programId: new web3.PublicKey(TOKEN_PROGRAM_ID),
      keys: [
        { pubkey: source, isSigner: false, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: destination, isSigner: false, isWritable: true },
        { pubkey: owner, isSigner: true, isWritable: false },
      ],
      data,
    });
  }

  /**
   * Builds the full unsigned Transaction for an invoice payment:
   * ATA setup + recipient transfer + platform fee + Jito tip.
   * Caller (veil-engine.js) attaches a recent blockhash and asks
   * Phantom to sign it.
   */
  async function buildPaymentTransaction({ payerWallet, recipientWallet, amount, tipLamports, tipAccount }) {
    const web3 = _web3();
    if (payerWallet === recipientWallet) {
      throw new Error('You cannot pay your own invoice. Switch to a different wallet.');
    }

    const payer = new web3.PublicKey(payerWallet);
    const recipient = new web3.PublicKey(recipientWallet);
    const mint = new web3.PublicKey(PAYMENT_CONFIG.usdcMint);
    const feeWallet = getFeeDestinationOwner();

    const totalBaseUnits = _toBaseUnits(amount);
    const feeBaseUnits = Math.floor(totalBaseUnits * PAYMENT_CONFIG.invoiceFeeBps / 10_000);
    const recipientBaseUnits = totalBaseUnits - feeBaseUnits;

    const payerAta = getAssociatedTokenAddress(payer, mint);
    const recipientAta = getAssociatedTokenAddress(recipient, mint);
    const feeAta = getAssociatedTokenAddress(feeWallet, mint);

    const tx = new web3.Transaction();
    tx.add(createIdempotentAtaInstruction({ payer, owner: recipient, mint }));
    tx.add(createIdempotentAtaInstruction({ payer, owner: feeWallet, mint }));
    tx.add(transferCheckedInstruction({
      source: payerAta, mint, destination: recipientAta, owner: payer,
      amount: recipientBaseUnits, decimals: PAYMENT_CONFIG.usdcDecimals,
    }));
    tx.add(transferCheckedInstruction({
      source: payerAta, mint, destination: feeAta, owner: payer,
      amount: feeBaseUnits, decimals: PAYMENT_CONFIG.usdcDecimals,
    }));
    if (tipAccount && tipLamports > 0) {
      tx.add(web3.SystemProgram.transfer({
        fromPubkey: payer, toPubkey: new web3.PublicKey(tipAccount), lamports: tipLamports,
      }));
    }

    return { transaction: tx, recipientBaseUnits, feeBaseUnits };
  }

  return {
    getAssociatedTokenAddress,
    getTreasuryPda,
    getFeeDestinationOwner,
    buildPaymentTransaction,
    config: PAYMENT_CONFIG,
  };
})();

window.PaymentTransfer = PaymentTransfer;
