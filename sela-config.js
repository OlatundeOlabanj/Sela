/**
 * Sela runtime configuration. The one place cluster and address
 * settings live, so switching clusters or going to mainnet is a config
 * change and not a rewrite. Load this before payment-transfer.js,
 * program-client.js and swap.js.
 *
 * PROGRAM_CLUSTER: the cluster the Anchor program and the goal token
 * run on. Payments, swaps, RPC Fast and Solami always run on
 * mainnet-beta regardless of this value.
 *
 * PROGRAM_ID: keep in sync with declare_id! in programs/cognata/src/lib.rs.
 * Live on devnet as of the Oct 1 deploy, see DEPLOY.md.
 *
 * FEE_MODE: where the platform fee on mainnet payments is sent.
 *   'wallet'       send to FEE_WALLET (interim, used while the program is
 *                  not deployed to mainnet, so fees stay recoverable)
 *   'treasury_pda' send to the program's treasury PDA (switch to this
 *                  only after the program is deployed to mainnet and
 *                  init_treasury has been run, see ACCOUNTS.md)
 *
 * Made by TJS Code
 */
const SELA_CONFIG = {
  PROGRAM_CLUSTER: 'devnet',
  PROGRAM_ID: 'EPqdJo6sJP9R3RCKh2RFLMt7T6orrkjV1ub584dcM2Vr',
  FEE_MODE: 'wallet',
  FEE_WALLET: 'CjFuX951H7xEoLD3Gzbht5pqK7baoGZ6q32SfUQxNdWS',
  // The mint goals/allowances are denominated in, on PROGRAM_CLUSTER.
  // Devnet value matches scripts/constants.ts DEVNET_USDC_MINT (a
  // devnet test-USDC mint, not real Circle USDC). Update to
  // EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v once
  // PROGRAM_CLUSTER moves to mainnet-beta, see DEPLOY.md.
  GOAL_MINT: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
  GOAL_MINT_DECIMALS: 6,
};

// Browser: window.SELA_CONFIG. Netlify Functions (Node): require('../../sela-config.js').
if (typeof window !== 'undefined') window.SELA_CONFIG = SELA_CONFIG;
if (typeof module !== 'undefined' && module.exports) module.exports = SELA_CONFIG;
