#!/usr/bin/env node
// One-time program setup after deploy: init_fee_config, init_treasury,
// and the treasury's token account for a mint.
//
// Usage (devnet, plain keypair admin is fine):
//   npm i @solana/web3.js
//   node scripts/init-program.js --keypair ~/.config/solana/id.json \
//        --mint <USDC_MINT> --standard-fee 10000 --founding-fee 0
//
// Fee amounts are USDC base units (6 decimals), so 10000 = 0.01 USDC.
// Cluster and program ID come from sela-config.js, so set those first.
//
// Mainnet: the fee admin must be a multisig, and a multisig cannot
// sign this script's transaction. Pass --admin <MULTISIG_VAULT_PUBKEY>
// with no --keypair and the script prints the init_fee_config
// instruction (accounts and base64 data) to paste into a Squads
// transaction. Sending with a plain keypair on mainnet is refused
// unless you add --allow-keypair-admin, which you should not do.
//
// Made by TJS Code

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction,
  sendAndConfirmTransaction,
} = require('@solana/web3.js');
const CFG = require('../sela-config.js');

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]);
    return acc;
  }, []),
);

const disc = (name) => crypto.createHash('sha256').update('global:' + name).digest().subarray(0, 8);
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };

const PROGRAM_ID = new PublicKey(CFG.PROGRAM_ID);
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATA_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const isMainnet = CFG.PROGRAM_CLUSTER === 'mainnet-beta';
const url = args.rpc || (isMainnet ? 'https://api.mainnet-beta.solana.com' : `https://api.${CFG.PROGRAM_CLUSTER}.solana.com`);

const [feeConfig] = PublicKey.findProgramAddressSync([Buffer.from('fee_config')], PROGRAM_ID);
const [treasury] = PublicKey.findProgramAddressSync([Buffer.from('treasury')], PROGRAM_ID);

function initFeeConfigIx(admin) {
  const data = Buffer.concat([disc('init_fee_config'), u64(args['standard-fee'] ?? 0), u64(args['founding-fee'] ?? 0)]);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: admin, isSigner: true, isWritable: true },
      { pubkey: feeConfig, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

function initTreasuryIx(payer) {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: treasury, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: disc('init_treasury'),
  });
}

function treasuryAtaIx(payer, mint) {
  const [ata] = PublicKey.findProgramAddressSync([treasury.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()], ATA_PROGRAM_ID);
  return {
    ata,
    ix: new TransactionInstruction({
      programId: ATA_PROGRAM_ID,
      keys: [
        { pubkey: payer, isSigner: true, isWritable: true },
        { pubkey: ata, isSigner: false, isWritable: true },
        { pubkey: treasury, isSigner: false, isWritable: false },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: Buffer.from([1]), // CreateIdempotent
    }),
  };
}

(async () => {
  console.log(`cluster ${CFG.PROGRAM_CLUSTER}, program ${PROGRAM_ID.toBase58()}`);
  console.log(`fee_config PDA ${feeConfig.toBase58()}`);
  console.log(`treasury PDA   ${treasury.toBase58()}`);

  if (args.admin && !args.keypair) {
    const admin = new PublicKey(args.admin);
    const ix = initFeeConfigIx(admin);
    console.log('\nPaste into a Squads transaction (init_fee_config, signer = the multisig vault):');
    console.log(JSON.stringify({
      programId: ix.programId.toBase58(),
      accounts: ix.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })),
      dataBase64: ix.data.toString('base64'),
    }, null, 2));
    console.log('\nThen run this script again with --keypair <any funded keypair> --skip-fee-config --mint <MINT> for init_treasury and the treasury token account.');
    return;
  }

  if (!args.keypair) throw new Error('Pass --keypair <path> (or --admin <pubkey> to print the multisig instruction).');
  if (isMainnet && !args['allow-keypair-admin'] && !args['skip-fee-config']) {
    throw new Error('Refusing to make a plain keypair the fee admin on mainnet. Use --admin <multisig vault> to print the instruction, see DEPLOY.md.');
  }

  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.resolve(args.keypair.replace(/^~/, process.env.HOME)), 'utf8'))));
  const conn = new Connection(url, 'confirmed');
  const ixs = [];
  if (!args['skip-fee-config']) ixs.push(initFeeConfigIx(payer.publicKey));
  if (!(await conn.getAccountInfo(treasury))) ixs.push(initTreasuryIx(payer.publicKey));
  if (args.mint) {
    const { ata, ix } = treasuryAtaIx(payer.publicKey, new PublicKey(args.mint));
    ixs.push(ix);
    console.log(`treasury token account ${ata.toBase58()}`);
  }
  if (!ixs.length) return console.log('Nothing to do.');
  const sig = await sendAndConfirmTransaction(conn, new Transaction().add(...ixs), [payer]);
  console.log('done, signature', sig);
})().catch((e) => { console.error(e.message); process.exit(1); });
