// Shape of a savings goal as it will eventually come from the merged Cognata/VeilPay product.
// Kept minimal on purpose so this module stays usable before that merge lands.

export interface GoalDefinition {
  /** Human readable goal name, e.g. "Family trip to Kyoto" */
  name: string;
  /** Short token symbol, max 10 chars, e.g. "KYOTO" */
  symbol: string;
  /** One line description shown in token metadata */
  description: string;
  /** Target amount in USDC. Becomes migrationQuoteThreshold. */
  goalAmountUsdc: number;
  /**
   * Address that receives the locked LP position and pool fees once the goal graduates.
   * Should be a program-owned or multisig address scoped to this goal, not a personal wallet.
   * See README.md, "Design note: who is creator for a family/community goal".
   */
  treasuryAddress: string;
  /** Optional links for token metadata */
  website?: string;
  twitter?: string;
  telegram?: string;
  /** Optional path to a token image, defaults to the studio's test image for the POC */
  imagePath?: string;
}

export interface GoalTokenNetworkOptions {
  network: 'devnet' | 'mainnet' | 'localnet';
  /** Refuses to run against mainnet unless this is explicitly set to true */
  confirmMainnet?: boolean;
  /** If true, generates the config with dryRun: true regardless of network */
  dryRun: boolean;
}
