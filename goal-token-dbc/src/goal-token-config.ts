import { writeFileSync } from 'fs';
import type { GoalDefinition, GoalTokenNetworkOptions } from './types';

const RPC_URLS: Record<GoalTokenNetworkOptions['network'], string> = {
  devnet: 'https://api.devnet.solana.com',
  mainnet: 'https://api.mainnet-beta.solana.com',
  localnet: 'http://localhost:8899',
};

const USDC_MINTS: Record<GoalTokenNetworkOptions['network'], string> = {
  devnet: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
  mainnet: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  // localnet has no canonical USDC mint, caller must supply their own test mint
  localnet: 'REPLACE_WITH_LOCAL_TEST_USDC_MINT',
};

/**
 * Builds the studio dbc_config.jsonc object for a single goal.
 *
 * This does not talk to Solana or the DBC program directly. It only produces the config
 * file that the official meteora-invent studio actions (dbc-create-config, dbc-create-pool,
 * dbc-swap, dbc-migrate-to-damm-v2) consume. All program-level logic stays inside
 * meteora-invent, which is the point: this module never hand-rolls DBC or DAMM v2 calls.
 */
export function goalToDbcConfig(goal: GoalDefinition, options: GoalTokenNetworkOptions) {
  if (options.network === 'mainnet' && !options.confirmMainnet) {
    throw new Error(
      'Refusing to generate a mainnet config without confirmMainnet: true. ' +
        'This is a deliberate safety gate, do not remove it casually.'
    );
  }

  if (goal.goalAmountUsdc <= 0) {
    throw new Error('goalAmountUsdc must be a positive number');
  }

  if (goal.symbol.length > 10) {
    throw new Error('symbol must be 10 characters or fewer');
  }

  return {
    rpcUrl: RPC_URLS[options.network],
    dryRun: options.dryRun,
    keypairFilePath: './keypair.json',
    computeUnitPriceMicroLamports: 100000,
    quoteMint: USDC_MINTS[options.network],

    dbcConfig: {
      buildCurveMode: 0,
      percentageSupplyOnMigration: 20,
      migrationQuoteThreshold: goal.goalAmountUsdc,

      token: {
        totalTokenSupply: 1000000000,
        tokenBaseDecimal: 6,
        tokenQuoteDecimal: 6,
        tokenType: 0,
        tokenAuthorityOption: 1,
        leftover: 0,
      },

      fee: {
        baseFeeParams: {
          baseFeeMode: 0,
          feeSchedulerParam: {
            startingFeeBps: 100,
            endingFeeBps: 100,
            numberOfPeriod: 0,
            totalDuration: 0,
          },
        },
        dynamicFeeEnabled: false,
        collectFeeMode: 0,
        // Placeholder, see README.md "Open items". Needs a real product decision.
        creatorTradingFeePercentage: 50,
        poolCreationFee: 0,
        enableFirstSwapWithMinFee: false,
      },

      migration: {
        migrationOption: 1,
        migrationFeeOption: 3,
        migrationFee: {
          feePercentage: 0,
          creatorFeePercentage: 0,
        },
      },

      liquidityDistribution: {
        partnerLiquidityPercentage: 0,
        creatorLiquidityPercentage: 0,
        partnerPermanentLockedLiquidityPercentage: 0,
        creatorPermanentLockedLiquidityPercentage: 100,
      },

      lockedVesting: {
        totalLockedVestingAmount: 0,
        numberOfVestingPeriod: 0,
        cliffUnlockAmount: 0,
        totalVestingDuration: 0,
        cliffDurationFromMigrationTime: 0,
      },

      activationType: 1,
      leftoverReceiver: goal.treasuryAddress,
      feeClaimer: goal.treasuryAddress,
    },

    dbcPool: {
      creator: goal.treasuryAddress,
      name: goal.name,
      symbol: goal.symbol,
      metadata: {
        image: goal.imagePath ?? './data/image/test-token.jpg',
        description: goal.description,
        website: goal.website ?? '',
        twitter: goal.twitter ?? '',
        telegram: goal.telegram ?? '',
      },
    },

    dbcSwap: {
      amountIn: 0, // set per swap call, not per goal, see run-poc.ts
      slippageBps: 100,
      swapBaseForQuote: false,
      referralTokenAccount: null,
    },

    dbcTransferPoolCreator: {
      newCreator: '',
    },
  };
}

/**
 * Writes the generated config to disk as JSON. The studio CLI reads JSONC (JSON with comments),
 * and plain JSON is valid JSONC, so this is safe to hand to the studio commands as is.
 */
export function writeGoalConfig(
  goal: GoalDefinition,
  options: GoalTokenNetworkOptions,
  outPath: string
): void {
  const config = goalToDbcConfig(goal, options);
  writeFileSync(outPath, JSON.stringify(config, null, 2), 'utf-8');
}
