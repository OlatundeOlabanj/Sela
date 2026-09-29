// Real secp256r1 signature test — generates an actual P-256 keypair,
// signs a WebAuthn-shaped message, hand-builds the precompile
// instruction, and calls the on-chain test_verify_passkey instruction.
// This is what actually validates passkey.rs's assumptions against
// real cryptography, not just "does it compile."

import * as crypto from "crypto";
import {
  Connection,
  Keypair,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { getProgram, loadTestWallet } from "../tests/helpers";

const SECP256R1_PROGRAM_ID = new PublicKey("Secp256r1SigVerify1111111111111111111111111");
const EXPECTED_ORIGIN = "https://selaaa.netlify.app";

// P-256 curve order, needed for low-S normalization.
const CURVE_ORDER = BigInt(
  "0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551"
);

function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function getCompressedPubkey(publicKey: crypto.KeyObject): Buffer {
  const jwk = publicKey.export({ format: "jwk" }) as any;
  const x = Buffer.from(jwk.x, "base64url");
  const y = Buffer.from(jwk.y, "base64url");
  const yIsOdd = (y[y.length - 1] & 1) === 1;
  return Buffer.concat([Buffer.from([yIsOdd ? 0x03 : 0x02]), x]);
}

function lowSNormalize(signature: Buffer): Buffer {
  // ieee-p1363 raw format: r (32 bytes) || s (32 bytes)
  const r = signature.subarray(0, 32);
  let s = signature.subarray(32, 64);
  const sBig = BigInt("0x" + s.toString("hex"));
  const halfOrder = CURVE_ORDER / 2n;
  if (sBig > halfOrder) {
    const normalized = CURVE_ORDER - sBig;
    let hex = normalized.toString(16);
    if (hex.length % 2) hex = "0" + hex;
    hex = hex.padStart(64, "0");
    s = Buffer.from(hex, "hex");
  }
  return Buffer.concat([r, s]);
}

function anchorDiscriminator(methodName: string): Buffer {
  return crypto.createHash("sha256").update(`global:${methodName}`).digest().subarray(0, 8);
}

async function main() {
  const { program, provider } = getProgram();
  const connection = provider.connection;

  console.log("Generating P-256 (secp256r1) keypair...");
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const compressedPubkey = getCompressedPubkey(publicKey);
  console.log("  actual signing pubkey (33 bytes):", compressedPubkey.toString("hex"));

  // NEGATIVE TEST: claim a DIFFERENT device pubkey than the one that
  // actually signed. Everything downstream (challenge computation,
  // instruction args) uses this WRONG value consistently, so the
  // challenge-match check passes — isolating specifically whether the
  // program's verified_pubkey == expected_device_pubkey check catches
  // a real, validly-signed proof from the wrong claimed device.
  const wrongPubkey = Buffer.concat([Buffer.from([0x02]), crypto.randomBytes(32)]);
  console.log("  CLAIMED (wrong) pubkey (33 bytes):", wrongPubkey.toString("hex"));
  const claimedPubkey = wrongPubkey;

  // --- Step 1: compute the challenge (must match hash_authorized_action exactly) ---
  const discriminator = anchorDiscriminator("test_verify_passkey");
  const accounts = [
    { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
  ];

  const businessPrefix = Buffer.concat([discriminator, claimedPubkey]); // 8 + 33 = 41 bytes

  let hashInput = Buffer.concat([
    program.programId.toBuffer(),
    ...accounts.map((a) =>
      Buffer.concat([a.pubkey.toBuffer(), Buffer.from([a.isSigner ? 1 : 0, a.isWritable ? 1 : 0])])
    ),
    businessPrefix,
  ]);
  const challengeHash = crypto.createHash("sha256").update(hashInput).digest();
  const challengeB64 = base64UrlEncode(challengeHash);
  console.log("  computed challenge:", challengeB64);

  // --- Step 2: build WebAuthn-shaped authenticatorData + clientDataJSON ---
  const rpIdHash = crypto.createHash("sha256").update("selaaa.netlify.app").digest(); // 32 bytes
  const flags = Buffer.from([0x01]); // user present
  const signCount = Buffer.from([0, 0, 0, 0]); // 4 bytes big-endian
  const authenticatorData = Buffer.concat([rpIdHash, flags, signCount]); // 37 bytes

  const clientDataJson = Buffer.from(
    JSON.stringify({
      type: "webauthn.get",
      challenge: challengeB64,
      origin: EXPECTED_ORIGIN,
    })
  );

  const clientDataHash = crypto.createHash("sha256").update(clientDataJson).digest();
  const message = Buffer.concat([authenticatorData, clientDataHash]); // 37 + 32 = 69 bytes

  // --- Step 3: sign with the P-256 private key, low-S normalized ---
  const rawSignature = crypto.sign(null, message, {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  });
  const signature = lowSNormalize(rawSignature);
  console.log("  signature (64 bytes):", signature.toString("hex"));

  // --- Step 4: hand-build the secp256r1 precompile instruction ---
  const HEADER_LEN = 2;
  const OFFSETS_ENTRY_LEN = 14;
  const dataStart = HEADER_LEN + OFFSETS_ENTRY_LEN; // 16
  const sigOffset = dataStart;
  const pubkeyOffset = sigOffset + 64;
  const messageOffset = pubkeyOffset + 33;

  const precompileData = Buffer.alloc(messageOffset + message.length);
  precompileData.writeUInt8(1, 0); // num_signatures
  precompileData.writeUInt8(0, 1); // padding
  precompileData.writeUInt16LE(sigOffset, 2); // signature_offset
  precompileData.writeUInt16LE(0xffff, 4); // signature_instruction_index (same ix)
  precompileData.writeUInt16LE(pubkeyOffset, 6); // public_key_offset
  precompileData.writeUInt16LE(0xffff, 8); // public_key_instruction_index
  precompileData.writeUInt16LE(messageOffset, 10); // message_data_offset
  precompileData.writeUInt16LE(message.length, 12); // message_data_size
  precompileData.writeUInt16LE(0xffff, 14); // message_instruction_index
  signature.copy(precompileData, sigOffset);
  compressedPubkey.copy(precompileData, pubkeyOffset);
  message.copy(precompileData, messageOffset);

  const precompileIx = new TransactionInstruction({
    programId: SECP256R1_PROGRAM_ID,
    keys: [],
    data: precompileData,
  });

  // --- Step 5: build our own instruction with real proof fields ---
  const testIx = await program.methods
    .testVerifyPasskey(
      Array.from(claimedPubkey),
      authenticatorData,
      clientDataJson,
      Buffer.from(EXPECTED_ORIGIN)
    )
    .accounts({
      instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
    })
    .instruction();

  const tx = new Transaction().add(precompileIx).add(testIx);
  console.log("\nSending transaction...");
  try {
    const sig = await provider.sendAndConfirm(tx);
    console.log("SUCCESS. signature:", sig);
    const confirmed = await connection.getTransaction(sig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    console.log("logs:");
    (confirmed?.meta?.logMessages ?? []).forEach((l) => console.log("  " + l));
  } catch (err: any) {
    console.log("FAILED:", err.message ?? err);
    if (err.logs) {
      console.log("logs:");
      err.logs.forEach((l: string) => console.log("  " + l));
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
