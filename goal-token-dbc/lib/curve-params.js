'use strict';
// Curve parameters for a goal token. This mirrors studio-config/dbc_config.goal-token.jsonc,
// which is the file Tunde's devnet proof of concept actually exercises. If the POC output
// forces a change to the config, change it here in the same commit.
//
// Numeric enum values are used on purpose. The SDK renamed enum members between releases
// (for example tokenAuthorityOption became tokenUpdateAuthority), the numbers did not move.
//
// Settled decisions encoded below:
//   single segment curve, USDC quote, DAMM v2 migration, flat 1% fee, dynamic fee off,
//   fees in quote token only, pool creation fee zero, 100% of post graduation LP goes to the
//   creator and is permanently locked.
// Open placeholder: creatorTradingFeePercentage. This value is written into the on chain
// config account and cannot be edited afterwards. Decide it before any mainnet creation.

const { HttpError } = require('./common');

const CREATOR_TRADING_FEE_PERCENTAGE_PLACEHOLDER = 50;

const MIN_GOAL_USDC = 10;
const MAX_GOAL_USDC = 1000000;

function validateGoalAmount(goalAmountUsdc) {
  const n = Number(goalAmountUsdc);
  if (!Number.isFinite(n) || n < MIN_GOAL_USDC || n > MAX_GOAL_USDC) {
    throw new HttpError(400, 'goalAmountUsdc must be between ' + MIN_GOAL_USDC + ' and ' + MAX_GOAL_USDC);
  }
  return n;
}

// Returns the input object for the SDK's buildCurve helper.
// migrationQuoteThreshold is in whole quote tokens (USDC), as in the studio config.
function buildCurveInput(goalAmountUsdc, leftoverReceiver) {
  const goal = validateGoalAmount(goalAmountUsdc);
  return {
    buildCurveMode: 0, // single segment
    percentageSupplyOnMigration: 20,
    migrationQuoteThreshold: goal,
    token: {
      tokenType: 0, // SPL
      totalTokenSupply: 1000000000,
      tokenBaseDecimal: 6,
      tokenQuoteDecimal: 6, // USDC
      tokenAuthorityOption: 1, // immutable (older SDK key)
      tokenUpdateAuthority: 1, // immutable (newer SDK key)
      leftover: 0,
    },
    fee: {
      baseFeeParams: {
        baseFeeMode: 0, // linear scheduler with start equal to end, so a flat fee
        feeSchedulerParam: {
          startingFeeBps: 100,
          endingFeeBps: 100,
          numberOfPeriod: 0,
          totalDuration: 0,
        },
      },
      dynamicFeeEnabled: false,
      collectFeeMode: 0, // quote token only
      creatorTradingFeePercentage: CREATOR_TRADING_FEE_PERCENTAGE_PLACEHOLDER,
      poolCreationFee: 0,
      enableFirstSwapWithMinFee: false,
    },
    migration: {
      migrationOption: 1, // DAMM v2
      migrationFeeOption: 3, // fixed 2% LP fee, same as the studio config
      migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
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
    activationType: 1, // timestamp
    leftoverReceiver,
  };
}

module.exports = {
  buildCurveInput,
  validateGoalAmount,
  CREATOR_TRADING_FEE_PERCENTAGE_PLACEHOLDER,
  MIN_GOAL_USDC,
  MAX_GOAL_USDC,
};
