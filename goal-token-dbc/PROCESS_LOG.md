# Goal Token (DBC) - process log

Session type: Session B, Crypto World's Fair hackathon
Deadline: October 12, 2026
Scope: devnet POC for a Meteora Dynamic Bonding Curve based "Goal Token" feature

This document is a full account of what was asked, what was checked, what was decided, and
what was built, so someone else can pick this up without re-deriving any of it.

---

## 1. Original task

Build a Goal Token feature on Meteora's Dynamic Bonding Curve (DBC): shared family/community
savings goals become a bonding curve token, members buy in with USDC, early contributors get a
better curve position, and the token graduates into a DAMM v2 liquidity pool once the goal
amount is hit.

Requirements as given:
- Use Meteora's official Agent Skill and SDK (github.com/MeteoraAg/meteora-invent), not
  hand-rolled DBC/DAMM v2 calls.
- Build as a largely self-contained module, not blocked on a separate in-progress merge.
- Devnet proof of concept first: create a curve, execute a buy-in, trigger graduation to
  DAMM v2, confirmed working end to end, before any UI polish.
- Report back DBC config decisions (curve shape, fee schedule, quote token, graduation
  threshold) before building anything.
- Design system to carry through later UI work: dark theme, amber/gold accents, Space Grotesk +
  JetBrains Mono, inline SVG icons only, "Made by TJS Code" in every footer, no em-dashes
  anywhere, plain HTML/CSS/JS unless React is genuinely needed. (Not yet applicable, no UI has
  been built in this session.)
- Add GitHub ID `dannxbt` with Read access if the repo stays closed source.

---

## 2. Environment checks (before writing anything)

### 2.1 Referenced context files did not exist

The task referenced reading `/areas/crypto-worlds-fair.md`, `/areas/veilpay.md`, and
`/areas/family-wallet.md` "from memory." Checked:

```
ls -la /areas/
-> ls: cannot access '/areas/': No such file or directory
```

Memory is also not enabled for this account. Net effect: this session had no visibility into
whatever Session A, VeilPay, or family-wallet planning already decided. This was flagged
immediately rather than fabricated. If that context exists, it needs to be pasted or uploaded
for a future session to reconcile against the decisions below.

### 2.2 No network access in this sandbox

The bash tool here has network disabled. Confirmed via a failed `npm install` later in the
session (see section 5). Practical effect: nothing in this session could actually run against
Solana, whether devnet or otherwise. No repo clone, no `pnpm install`, no RPC calls, no signed
transactions. This was flagged before building anything, and again at handoff. **The devnet POC
described in the task ("confirmed working end to end") has not been executed. It has been built
correctly against the real schema and action list, but it is unverified until someone runs it
with network access.**

### 2.3 No GitHub tool available

Checked the MCP connector registry for a GitHub/repo management tool:

```
search_mcp_registry(keywords: ["github", "repository", "collaborator"])
-> no GitHub connector in results (Padlet, Tella, Docfarm, Windmill HR, Lucid, Todoist,
   alphaXiv, Frontify, MuleSoft, Signeasy)
```

Conclusion: adding `dannxbt` as a Read collaborator has to be done manually by whoever owns the
`meteora-invent`-consuming repo (or the private repo this feature lands in), via
Settings -> Collaborators and teams -> Add people. Not done in this session.

---

## 3. Research performed

All of the following happened before any code or config was written, per the task's
instruction to report DBC decisions first.

| # | Query / URL | What it confirmed |
|---|---|---|
| 1 | web_search: "Meteora Dynamic Bonding Curve developer guide docs.meteora.ag" | Located the DBC developer guide index, program IDs (`dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN` on both mainnet and devnet), and the existence of the TypeScript SDK. |
| 2 | web_search: "Meteora DBC bonding curve configs quote token migration threshold fee scheduler" | Confirmed `migration_quote_threshold` semantics, that fee schedulers/rate limiters are base fee mechanisms, and the DBC formulas page. |
| 3 | web_search: "Meteora docs.meteora.ag agents skill agent skill DBC" | Found the Agent Skill description directly from the `meteora-invent` README: devnet-first, dry-run-first, explicit owner confirmation gates, version-pinned SDK reference packs. |
| 4 | web_fetch: `https://github.com/MeteoraAg/meteora-invent` | Full repo structure: `packages/`, `scaffolds/fun-launch/`, `skills/meteora/` (the Agent Skill), `studio/` (config + actions). Full list of DBC studio actions: `dbc-create-config`, `dbc-create-pool`, `dbc-swap`, `dbc-migrate-to-damm-v1`, `dbc-migrate-to-damm-v2`, `dbc-claim-trading-fee`, `dbc-transfer-pool-creator`. |
| 5 | web_fetch: `https://github.com/MeteoraAg/meteora-invent/blob/main/studio/config/dbc_config.jsonc` | The real, complete DBC config schema (245 lines): `buildCurveMode` options, `dbcConfig.token`, `dbcConfig.fee`, `dbcConfig.migration`, `dbcConfig.liquidityDistribution` (with the "at least 10% of LP must stay locked" rule), `dbcConfig.lockedVesting`, `dbcPool`, `dbcSwap`. This became the direct basis for the generated config, not a guess. |
| 6 | web_search_fast: "Solana devnet USDC mint address Circle" | Initial pass, inconclusive (mostly pre-mint address blog posts, not the actual mint). |
| 7 | web_search_fast: `"4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" devnet USDC` | Confirmed via Circle's own developer docs (`developers.circle.com/stablecoins/quickstart-transfer-10-usdc-on-solana`) that the Solana devnet USDC mint is `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`, 6 decimals. Cross-checked against two independent third-party sources that cited the same address. Mainnet USDC mint (`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`) was already known and matched a code4rena audit reference. |

---

## 4. Decisions made

### 4.1 Reported to the user before building (per task instructions)

| Setting | Decision | Why |
|---|---|---|
| Curve shape | Single segment (`buildCurveMode: 0`) | DBC price rises monotonically as the pool fills, so early buyers already get a better price than late buyers. The 16-segment curve machinery exists to shape sniper behavior on speculative launches, not needed for a savings goal. |
| Quote token | USDC. Devnet `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`, mainnet `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | Matches "members buy in with USDC" directly, keeps the goal amount and the migration threshold in the same unit. |
| Graduation threshold | `migrationQuoteThreshold` = the goal's USDC target | Direct mapping: hitting the goal and DBC graduation become the same on-chain event. |
| Migration option | 1 (DAMM v2) | Required by the spec: a tradeable position instead of a locked balance. |
| Token decimals | 6 (base), 6 (quote) | Matches USDC, simplest unit math across the whole pipeline. |
| Token type | 0 (SPL Token, no transfer hook) | No requirement in this task needs a transfer hook. Smaller surface for the POC. |
| Activation type | 1 (timestamp) | Easier to reason about for a savings-goal UX than slot-based timing. |
| Base fee | Flat fee scheduler, `startingFeeBps` = `endingFeeBps` = 100 (1%) | Fee schedulers/rate limiters exist to fight snipers on public meme launches. Not the threat model for a family/community goal. Flat and predictable is better UX. |
| Dynamic fee | Off for the POC | One fewer variable while proving the pipeline works. |
| collectFeeMode | 0 (quote token / USDC only) | Keeps fee accounting in a single token for a savings-goal ledger. |
| Pool creation fee | 0 SOL | No cost barrier to starting a goal, for now. |

### 4.2 Decisions the user made explicitly (asked via three targeted questions, since these govern who can move money and were not safe to guess)

Asked via `ask_user_input_v0`, three questions, user answered:

1. **Post-graduation LP split** (who holds the DAMM v2 LP after a goal graduates)
   Options offered: 100% to goal creator locked / split between platform and creator / not sure,
   flag as TODO.
   **Answer: 100% to goal creator (family/community organizer), locked.**
   Implemented as `liquidityDistribution.creatorPermanentLockedLiquidityPercentage: 100`, all
   other liquidity distribution fields at 0. This also trivially satisfies DBC's rule that at
   least 10% of LP must stay locked or vesting for 1+ day post-migration.

2. **Pre-graduation trading fee, and who it goes to**
   Options offered: 1% flat to creator / 1% flat split with platform / 0.5% flat minimal
   friction / placeholder, decide later.
   **Answer: placeholder, decide later.**
   Implemented as `creatorTradingFeePercentage: 50` in the config, explicitly commented as a
   placeholder in both the config file and the code, and listed under "Open items" in
   `README.md`. The 1% flat base fee itself (`startingFeeBps`/`endingFeeBps`) was set per the
   pre-question recommendation and was not part of what was left as a placeholder, only the
   creator/platform split percentage was.

3. **Devnet POC graduation threshold**
   Options offered: 10 / 50 / 100 USDC.
   **Answer: 100 USDC.**
   Implemented as `migrationQuoteThreshold: 100` in the POC config and as the default
   `goalAmountUsdc` in `POC_GOAL` inside `src/run-poc.ts`.

### 4.3 A decision flagged but not resolved

`dbcConfig.creator` / `feeClaimer` / `leftoverReceiver` need to resolve to an address. For a
family or community goal, using an individual member's personal wallet would give that one
person permanent control over the graduated pool's locked liquidity. Recommended in
`README.md` that this be a PDA or multisig scoped to the goal, owned by the merged
Cognata/VeilPay program, rather than a personal wallet. Not resolved, since it depends on
account/program architecture from the other side of the merge. Left as
`REPLACE_WITH_GOAL_TREASURY_ADDRESS` placeholders throughout.

---

## 5. What was built

Module: `goal-token-dbc/` (delivered as a zip). Structure:

```
goal-token-dbc/
  README.md                           overview, decisions table, open items, GitHub access note
  RUNBOOK.md                          exact command sequence for a real devnet run
  PROCESS_LOG.md                      this file
  package.json                        minimal, ts-node script + typecheck script
  studio-config/
    dbc_config.goal-token.jsonc       filled DBC config for the POC goal, matches real schema
  src/
    types.ts                          GoalDefinition, GoalTokenNetworkOptions
    goal-token-config.ts              goalToDbcConfig() and writeGoalConfig(), pure functions,
                                       no network calls, generates the config studio consumes
    run-poc.ts                        orchestrator, shells out to `pnpm studio <action>` inside
                                       a sibling meteora-invent checkout. Live transaction steps
                                       are commented out deliberately, dry run only runs by
                                       default.
```

Design intent, stated in `README.md`: this module never reimplements DBC or DAMM v2 program
calls. It only generates config for, and shells out to, the official `studio` actions from
`meteora-invent`. That was a direct response to the task's instruction not to hand-roll
DBC/DAMM v2 calls.

### 5.1 Verification actually performed in this sandbox

Since nothing could be run against Solana, verification was limited to what's checkable
offline:

**JSONC validity of the generated config.** Two naive comment-stripping attempts produced false
failures (they broke on `//` inside URL strings like `https://api.devnet.solana.com`). A proper
state-machine stripper (Python, tracks whether the parser is inside a string) was used instead:

```
python3: state-machine comment stripper, then json.loads()
-> VALID JSON
-> keys: ['rpcUrl', 'dryRun', 'keypairFilePath', 'computeUnitPriceMicroLamports', 'quoteMint',
          'dbcConfig', 'dbcPool', 'dbcSwap', 'dbcTransferPoolCreator']
```

**TypeScript typecheck.** Ran `tsc --noEmit` against `src/*.ts` with `target es2020`,
`module commonjs`, `moduleResolution bundler` (first attempt used `moduleResolution node`,
which threw a deprecation error unrelated to the code, switched to `bundler`). Result: zero
logic errors. The only errors were missing Node type declarations (`Cannot find name 'fs'`,
`'process'`, `'__dirname'`, etc.), which is expected since `@types/node` is declared in
`package.json` but was never actually installed (see below). Confirmed by attempting
`npm install --no-save @types/node`, which failed with `403 Forbidden` from the npm registry,
consistent with no network access in this sandbox.

**What was not verified**, because it requires network/RPC access this session did not have:
- That `pnpm install` succeeds against the real `meteora-invent` repo.
- That `dbc-create-config`, `dbc-create-pool`, `dbc-swap`, and `dbc-migrate-to-damm-v2` actually
  run and produce the expected on-chain state.
- The exact text format of `dbc-create-pool`'s output, which `extractBaseMint()` in
  `run-poc.ts` parses with a best-effort regex. This is explicitly called out as unverified in
  a code comment and in `README.md`.

### 5.2 Delivery

Files were copied to `/mnt/user-data/outputs/goal-token-dbc/` and presented individually first,
then zipped on request:

```
cd /home/claude && zip -r goal-token-dbc.zip goal-token-dbc
-> 10 files, 23844 bytes uncompressed
```

Zip copied to `/mnt/user-data/outputs/goal-token-dbc.zip` and presented.

---

## 6. Handoff: what to do next, in order

1. **Get network access and actually run the POC.** Follow `RUNBOOK.md` exactly. This is the
   single riskiest unverified piece and was called out as the priority in the original task.
2. **Fix `extractBaseMint()` in `run-poc.ts`** once you see real `dbc-create-pool` output. The
   current regex is a guess.
3. **Resolve the treasury address question** (section 4.3 above) once Session A's
   account/program architecture is known. Every `REPLACE_WITH_GOAL_TREASURY_ADDRESS` placeholder
   depends on this.
4. **Resolve the `creatorTradingFeePercentage` placeholder** (currently 50, explicitly flagged
   as not a real decision) once there's a product call on the platform/creator fee split.
5. **Pull in the actual `/areas/crypto-worlds-fair.md`, `/areas/veilpay.md`,
   `/areas/family-wallet.md` context** (paste or upload it), since this session built entirely
   without it and there could be conflicting or overriding decisions in there.
6. **Add `dannxbt` as a GitHub Read collaborator** on whatever repo this code lives in, if it
   stays closed source. Manual step, no tool available to do this from a Claude session in this
   environment.
7. **UI work stays out of scope** until step 1 passes. The design system requirements (dark
   theme, amber/gold, Space Grotesk + JetBrains Mono, inline SVG icons, "Made by TJS Code"
   footer, no em-dashes, plain HTML/CSS/JS unless React is genuinely needed) have not been
   touched yet and apply once this moves to a UI phase.

---

## 7. Constraints that shaped this session, for context

- No memory access, no `/areas/*.md` files existed in this session's filesystem.
- No network access in the bash tool: no git clone, no package installs beyond what's cached
  in the sandbox already, no RPC calls.
- No GitHub management tool connected.
- These were surfaced to the user at the point each became relevant, not held back or worked
  around silently.
