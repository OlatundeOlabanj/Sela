# Devnet POC runbook

This is the sequence to actually prove the pipeline works: create a curve, execute a buy-in,
trigger graduation into DAMM v2. Run this from an environment with network access, this
sandbox does not have one.

## 1. Set up meteora-invent

```
git clone https://github.com/MeteoraAg/meteora-invent.git
cd meteora-invent
pnpm install
cp studio/.env.example studio/.env
pnpm studio generate-keypair --network devnet --airdrop
```

Confirm the generated keypair has devnet SOL:

```
pnpm studio airdrop-sol --network devnet
```

## 2. Install the Agent Skill (optional but recommended)

```
cp -R skills/meteora ~/.claude/skills/meteora
```

## 3. Wire in the Goal Token config

Copy `goal-token-dbc/studio-config/dbc_config.goal-token.jsonc` over
`meteora-invent/studio/config/dbc_config.jsonc`, or generate it programmatically with
`writeGoalConfig()` from `goal-token-dbc/src/goal-token-config.ts`.

Replace every `REPLACE_WITH_*` placeholder before running anything. At minimum:
- `keypairFilePath` should point at the keypair generated in step 1.
- `leftoverReceiver`, `feeClaimer`, and `dbcPool.creator` need a real devnet address.

Leave `dryRun: true` for the first pass.

## 4. Dry run

```
pnpm studio dbc-create-config
```

Read the output. It should describe the config it would create without sending a transaction.
If anything looks wrong (wrong quote mint, wrong threshold, wrong percentages), fix the config
and dry run again. Do not proceed until this is clean.

## 5. Go live: create the config and pool

Flip `dryRun` to `false`, then:

```
pnpm studio dbc-create-config
pnpm studio dbc-create-pool
```

Record the base mint address from the output. `dbc-create-pool` will also create the config in
the same call if you have not already created one separately.

## 6. Buy-in transaction

Set `dbcSwap.amountIn` in the config to the USDC amount for this test buy, then:

```
pnpm studio dbc-swap --baseMint <BASE_MINT_FROM_STEP_5>
```

Confirm on a devnet explorer (e.g. solscan.io with the devnet cluster selected) that the swap
landed and the pool's quote reserve increased.

## 7. Cross the graduation threshold

Repeat step 6, or send one larger swap, until the pool's quote reserve exceeds
`migrationQuoteThreshold` (100 USDC for the POC config). Meteora's docs note the pool is eligible
to migrate once `poolState.quoteReserve` > `poolConfig.migrationQuoteThreshold`, which is
effectively 100% bonding curve progress.

## 8. Trigger graduation to DAMM v2

```
pnpm studio dbc-migrate-to-damm-v2 --baseMint <BASE_MINT_FROM_STEP_5>
```

Confirm on a devnet explorer that a DAMM v2 pool now exists for this base mint and that the
locked LP position matches what `liquidityDistribution` specified
(`creatorPermanentLockedLiquidityPercentage: 100` in the POC config).

## 9. Report back

Once this passes, the next step is wiring it to real goal data (`GoalDefinition` in
`src/types.ts`) instead of the hardcoded `POC_GOAL` in `src/run-poc.ts`, and deciding the open
items in README.md before anything touches mainnet.
