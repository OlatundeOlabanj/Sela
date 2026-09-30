# Goal token app integration

Server functions build UNSIGNED transactions and the user's wallet signs. No user key is held anywhere.
Status: written and unit tested offline against mocks. Not yet run against the real SDK or a real cluster.

## Files (repo relative)

| File | Purpose |
|---|---|
| netlify/functions/goal-token-create.js | Builds the unsigned config plus pool creation tx |
| netlify/functions/goal-token-buy.js | Quote or build an unsigned buy tx |
| netlify/functions/goal-token-status.js | Progress against the migration threshold, graduation state |
| netlify/functions/goal-token-registry.js | goal id to pool and mint, in Netlify Blobs, verified on chain before storing |
| netlify/functions/goal-token-send.js | Relays a wallet signed tx to the cluster RPC, program allowlisted |
| netlify/functions/goal-token-metadata.js | Serves the token metadata JSON the pool uri points at |
| goal-token-client.js | Browser client for the functions above |
| goal-token-panel.js | Mounts into #goal-token-mount |
| goal-token-dbc/lib/*.js | common helpers, curve params, registry, and sdk-adapter.js (the only file that touches the SDK) |
| goal-token-dbc/test/goal-token.test.js | Offline tests, run `node --test goal-token-dbc/test/goal-token.test.js` |

## Environment variables

| Name | Needed | Notes |
|---|---|---|
| PROGRAM_CLUSTER | no | `devnet` (default) or `mainnet-beta`. Drives quote mint and RPC |
| GOAL_TREASURY_ADDRESS | yes | Treasury PDA base58. Unknown until the Cognata program is deployed. Create refuses to run without it. For a devnet trial before deploy, use a devnet wallet you control. Never on mainnet |
| GOAL_TOKEN_RPC_URL | no | Server side only. Falls back to the public RPC for the cluster |
| URL | provided | Set by Netlify. Used to build the metadata uri |

## Dependencies to add (package.json is not owned by this session)

`@meteora-ag/dynamic-bonding-curve-sdk` pinned EXACTLY to the version the devnet POC ran on, plus `@solana/web3.js`, `@solana/spl-token`, `bn.js`, `@netlify/blobs`.
The browser page also needs `@solana/web3.js` as `window.solanaWeb3`.

## App integration check (run on a machine with network, after the POC passes)

1. `npm i` with the pinned SDK, then `node --test goal-token-dbc/test/goal-token.test.js` (must still pass).
2. `netlify dev` with PROGRAM_CLUSTER=devnet and GOAL_TREASURY_ADDRESS set to a devnet test wallet.
3. POST goal-token-create with a devnet wallet as creator. Confirm it returns without an SDK error. If it errors on a parameter name, fix sdk-adapter.js only. Record the exact message in PROCESS_LOG.md.
4. Sign and send it through the panel. Confirm the pool exists, then that goal-token-registry stored it.
5. Buy 10 USDC from the panel. Confirm the quote, the tx, and that progress moves.
6. Buy up to the threshold. Record what actually happens when the last buy crosses it, and whether graduation runs on its own.
7. Fill in RUNBOOK.md and PROCESS_LOG.md from what happened, not from this plan.

## Not verified (each is a hypothesis until step 3 to 6 above)

- `client.pool.createConfigAndPool` with a `preCreatePoolParam` object, and the config field names passed to it
- `buildCurve` accepting the nested input in curve-params.js, including ignoring the extra `buildCurveMode` and `leftoverReceiver` keys
- `swapQuote2` (or `swapQuote`) argument and result shapes, and that `swap` creates the buyer's token account itself
- `state.getPool` / `getPoolConfig` field names (`quoteReserve`, `migrationQuoteThreshold`, `isMigrated`)
- behaviour of a buy that crosses the threshold (a soft cap in goal-token-buy.js blocks buys above remaining plus 2 percent)
- the panel in a browser (no DOM was available, only `node --check`)

## Known gaps and decisions needed

1. SDK version drift. Meteora's docs show `tokenAuthorityOption` in one release and `tokenUpdateAuthority` in another, and an SDK 2.0.0 that deprecates `createConfig` for `createConfig2` and trims the package exports. curve-params.js sets both authority keys and sdk-adapter.js feature detects the quote call, but the pin must match the POC. Do not bump the SDK between the POC and the demo.
2. Pool creator cannot be the Treasury PDA in this flow. The creator must sign pool creation, and a PDA cannot sign a client transaction. So `creator` is the connected wallet. `feeClaimer` and `leftoverReceiver` are plain addresses and do take the PDA. Because 100 percent of post graduation LP is locked to the creator, the creator wallet is who can claim that position's fees. If that should be the treasury, the pool creator has to be transferred to the PDA after creation (the studio has a dbc-transfer-pool-creator action, the SDK equivalent is not yet wired here). This corrects the earlier note that all three fields take the PDA.
3. creatorTradingFeePercentage is a placeholder (50) and is written into the on chain config. It cannot be edited afterwards. Decide before any mainnet creation.
4. Goal ownership is unchecked. Registration verifies the pool on chain but nothing proves the caller owns the goal id. Needs Session A's goal or vault data. Registration is first wins in the meantime.
5. Sending is not the Jito plus RPC pipeline. The goal token runs on PROGRAM_CLUSTER (devnet for now) where Jito bundles do not apply, so goal-token-send.js relays to the cluster RPC instead.
6. No token image yet. The metadata JSON has name, symbol and description only.
7. Mainnet cost (task 3) is not measured. It comes from the dry run output.
8. Assumed, to be checked against Session A files: CommonJS functions, the Blobs bootstrap in registry.js, the wallet contract in goal-token-client.js, the `window.SelaWallet` name, and the mount attributes in goal-token-panel.js.
