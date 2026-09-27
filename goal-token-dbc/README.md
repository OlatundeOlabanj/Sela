# Goal Token (DBC) module

Turns a shared savings goal into a Meteora Dynamic Bonding Curve token. Members buy in with USDC,
early buyers get a better curve price, and the pool graduates into a DAMM v2 liquidity pool once
the goal amount is reached.

Built on top of `meteora-invent` (github.com/MeteoraAg/meteora-invent). This module does not
reimplement any DBC or DAMM v2 program calls. It generates config for, and drives, the official
`studio` actions and Agent Skill from that repo.

Status: devnet POC scaffold. Not yet executed end to end (see "Execution status" below).

## Why this shape

The whole point of using `meteora-invent` instead of hand-rolled SDK calls is that Meteora ships
the safety gates: devnet-first defaults, `dryRun: true` by default, version-pinned SDK packs, and
a CI-validated Agent Skill that knows the correct instruction sequences. This module stays a thin
layer on top of that rather than talking to the DBC or DAMM v2 programs directly.

```
goal-token-dbc/
  README.md
  RUNBOOK.md                          step by step commands for the devnet POC
  package.json
  studio-config/
    dbc_config.goal-token.jsonc       filled-in DBC config template for a goal token
  src/
    types.ts                          GoalDefinition type
    goal-token-config.ts              GoalDefinition -> dbc_config.jsonc generator
    run-poc.ts                        orchestrates create-config -> create-pool -> swap -> migrate
```

## Setup (one time, needs network)

This module assumes `meteora-invent` is cloned as a sibling directory and its `studio` workspace
has been installed:

```
git clone https://github.com/MeteoraAg/meteora-invent.git
cd meteora-invent
pnpm install
cp studio/.env.example studio/.env
pnpm studio generate-keypair --network devnet --airdrop
cp -R skills/meteora ~/.claude/skills/meteora
```

Then this module sits next to `meteora-invent/`:

```
workspace/
  meteora-invent/
  goal-token-dbc/
```

`run-poc.ts` shells out to `pnpm studio <action>` inside `../meteora-invent`, the same commands
a person would type by hand. It does not import the SDK directly, so there is nothing here that
can drift from the pinned, CI-validated version in the studio's `package.json`.

## DBC config decisions for Goal Token

| Setting | Value | Reasoning |
|---|---|---|
| `buildCurveMode` | 0 (buildCurve, single segment) | Price rises monotonically as the pool fills. That alone gives early buyers a better price than late buyers. No need for the 16-segment curve machinery for a savings goal, that complexity is built for speculative launches trying to shape sniper behavior. |
| Quote token | USDC. Devnet: `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`. Mainnet: `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | Matches "members buy in with USDC" directly, and keeps the goal amount and the migration threshold in the same unit. |
| `migrationQuoteThreshold` | = the goal's USDC target. POC value: 100 USDC | Direct mapping: goal hit is the same event as DBC graduation. Real goals plug in their real dollar target here. |
| `migrationOption` | 1 (DAMM v2) | Required by spec: graduated goals get a tradeable DAMM v2 position, not a locked balance. |
| `tokenBaseDecimal` | 6 | Matches USDC, keeps unit math simple across the whole pipeline. |
| `tokenType` | 0 (SPL Token) | No transfer-hook requirement for this feature. Keeps the surface small for the POC. |
| `activationType` | 1 (timestamp) | Easier to reason about for a savings-goal UX than slot-based timing. |
| Base fee | Fee scheduler, flat (`startingFeeBps` = `endingFeeBps` = 100, 1%) | Fee schedulers and rate limiters exist to fight snipers on public meme launches. That is not the threat model here, a flat predictable fee is better UX for people funding a shared goal. |
| `dynamicFeeEnabled` | false for POC | One fewer variable while proving the create -> buy -> graduate pipeline works. Revisit once the pipeline is solid. |
| `collectFeeMode` | 0 (quote token only) | All fee accounting stays in USDC, simpler ledger for a savings goal. |
| `creatorTradingFeePercentage` | 50 (placeholder) | Left as a placeholder per your call. Needs a real product decision on the platform/goal-creator split before mainnet. |
| `poolCreationFee` | 0 SOL | No cost barrier to starting a goal. |
| `liquidityDistribution` | `creatorPermanentLockedLiquidityPercentage: 100`, everything else 0 | Per your call: 100% of the graduated DAMM v2 LP goes to the goal creator, locked forever. This satisfies DBC's "at least 10% of LP must stay locked" rule outright. **Design note below.** |

### Design note: who is "creator" for a family/community goal

DBC's `creator` field and the locked LP it controls need to resolve to an address, not a person.
For a family or community goal, that should not be a single member's personal wallet, since
whoever holds that key effectively controls the graduated pool's liquidity forever. Recommend a
PDA or multisig scoped to the goal (owned by the VeilPay/Cognata program once merged) rather than
an individual's wallet. Flagging this now since it is exactly the kind of decision that is cheap
to get right before mainnet and expensive to fix after.

### Open items (need Session A / product input once merged)

- Real `creatorTradingFeePercentage` split between platform and goal creator.
- Whether `feeClaimer` and `leftoverReceiver` should be a VeilPay-controlled program address or
  the individual goal's PDA.
- Whether goal creation should charge `poolCreationFee` once this is a real product surface
  (currently 0 for frictionless POC testing).

## Execution status

Not yet run. This sandbox has no network access, so I could not `pnpm install`, hit devnet RPC,
or sign and send a transaction from here. Everything above is built against the real
`dbc_config.jsonc` schema and the real studio action list pulled from the `meteora-invent` repo,
but "create a curve, buy in, graduate to DAMM v2, confirmed working end to end" still needs to
be run somewhere with network access. See `RUNBOOK.md` for the exact commands.

## GitHub access

Meteora asked for GitHub ID `dannxbt` to get Read access if the repo stays closed source. I do
not have a GitHub management tool connected in this session, so that has to be added manually by
whoever owns the repo (Settings -> Collaborators and teams -> Add people).
