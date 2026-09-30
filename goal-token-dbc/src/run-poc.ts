import { execFileSync } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { writeGoalConfig } from './goal-token-config';
import type { GoalDefinition } from './types';

// Adjust this if your checkout puts meteora-invent somewhere else.
const METEORA_INVENT_DIR = join(__dirname, '..', '..', 'meteora-invent');
const GENERATED_CONFIG_DIR = join(__dirname, '..', 'generated');
const STUDIO_CONFIG_TARGET = join(METEORA_INVENT_DIR, 'studio', 'config', 'dbc_config.jsonc');

const POC_GOAL: GoalDefinition = {
  name: 'Test Family Goal',
  symbol: 'TESTFAM',
  description: 'Devnet POC for the Goal Token feature',
  goalAmountUsdc: 100,
  // Replace before running: a real devnet wallet address that will hold the locked LP.
  // Using the payer keypair's own address is fine for a POC, not fine for production.
  treasuryAddress: 'REPLACE_WITH_DEVNET_TREASURY_ADDRESS',
};

function runStudio(action: string, args: string[] = []): string {
  console.log(`\n=== pnpm studio ${action} ${args.join(' ')} ===`);
  const output = execFileSync('pnpm', ['studio', action, ...args], {
    cwd: METEORA_INVENT_DIR,
    encoding: 'utf-8',
    stdio: ['inherit', 'pipe', 'inherit'],
  });
  console.log(output);
  return output;
}

/**
 * Best effort extraction of the base mint address from studio's create-pool output.
 * This has NOT been verified against a real run in this environment (no network access
 * here). Check the actual CLI output once you run this for real and adjust the pattern
 * if it does not match, or better, read the mint from the transaction result the studio
 * action itself writes out, if it writes one to disk.
 */
function extractBaseMint(createPoolOutput: string): string {
  const match = createPoolOutput.match(/(?:base ?mint|mint address)\s*[:=]?\s*([1-9A-HJ-NP-Za-km-z]{32,44})/i);
  if (!match) {
    throw new Error(
      'Could not find a base mint address in dbc-create-pool output. ' +
        'Inspect the raw output above and update extractBaseMint() to match it.'
    );
  }
  return match[1];
}

async function main() {
  if (!existsSync(METEORA_INVENT_DIR)) {
    throw new Error(
      `Expected meteora-invent at ${METEORA_INVENT_DIR}. Clone it as a sibling directory ` +
        'and run pnpm install there first. See README.md.'
    );
  }

  if (!existsSync(GENERATED_CONFIG_DIR)) {
    mkdirSync(GENERATED_CONFIG_DIR, { recursive: true });
  }

  console.log('Step 0: generating config for POC goal, devnet, dryRun true.');
  const dryRunConfigPath = join(GENERATED_CONFIG_DIR, 'dbc_config.dryrun.json');
  writeGoalConfig(POC_GOAL, { network: 'devnet', dryRun: true }, dryRunConfigPath);
  console.log(`Wrote ${dryRunConfigPath}. Copy it to ${STUDIO_CONFIG_TARGET} and run:`);
  console.log('  pnpm studio dbc-create-config');
  console.log('Confirm the dry run reports no errors before continuing.');
  console.log(
    '\nThis script stops here intentionally. Do not wire this into a fully automated' +
      ' dry-run-to-live flow until a person has read a real dry run output at least once.'
  );

  // ---------------------------------------------------------------------------------
  // The block below is the intended live sequence once the dry run above has been
  // checked by hand and dryRun is flipped to false in a fresh config write. It is left
  // commented out on purpose: this script should not silently send real transactions.
  // ---------------------------------------------------------------------------------
  //
  // const liveConfigPath = join(GENERATED_CONFIG_DIR, 'dbc_config.live.json');
  // writeGoalConfig(POC_GOAL, { network: 'devnet', dryRun: false }, liveConfigPath);
  // // copy liveConfigPath to STUDIO_CONFIG_TARGET here, or point studio at it directly
  // // if your checkout supports a --config-file flag
  //
  // runStudio('dbc-create-config');
  // const createPoolOutput = runStudio('dbc-create-pool');
  // const baseMint = extractBaseMint(createPoolOutput);
  //
  // // Buy-in transaction. amountIn in dbcSwap controls how much USDC this swap spends.
  // runStudio('dbc-swap', ['--baseMint', baseMint]);
  //
  // // Repeat the swap, or send a larger one, until quoteReserve crosses
  // // migrationQuoteThreshold (100 USDC for this POC goal), then migrate:
  // runStudio('dbc-migrate-to-damm-v2', ['--baseMint', baseMint]);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
