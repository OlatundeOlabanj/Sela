# Cognata

Family and couples Solana wallet. Allowances, shared savings goals, and
invoicing, all settled through the Smart TX Stack payment engine
(ported in from VeilPay).

Made by TJS Code. Built for the Crypto World's Fair hackathon,
deadline October 12, 2026.

## What this is

Two codebases merged into one:

- **Cognata** (was `family-wallet-phase1`) — the Rust/Anchor program.
  Family vaults, savings goals, passkey-gated device authorization,
  recurring contributions, guardian recovery. Kept as the product
  name and brand.
- **VeilPay** (`github.com/OlatundeOlabanj/veilpay`, private,
  production mainnet) — the payment engine underneath. Real USDC
  transfers as Jito bundles, dynamic tips, a Groq AI retry agent,
  dual-send (Jito + Helius concurrently). This is what actually moves
  money; Cognata's on-chain program is what enforces who's allowed to
  move it and where it's allowed to go.

VeilPay's frontend and Netlify Functions became the web/backend layer
here; the marketing and legal pages (`index.html`, `dashboard.html`,
`pay.html`, `privacy.html`, `tos.html`, `404.html`) are rebranded to
Cognata. Internal JS module names (`VeilEngine`, `VeilSwapModule`,
filenames like `veil-engine.js`) are **not** renamed yet, flagged
below.

## Repo structure

```
programs/cognata/         Anchor program (Rust)
  src/
    lib.rs                 program entrypoint, instruction list
    state.rs                account structs: FamilyVault, SavingsGoal,
                             FeeConfig, Treasury, ...
    fee.rs                  fee-tier resolution
    passkey.rs               WebAuthn/passkey verification
    token_transfer.rs        CPI transfer helpers
    instructions/            one file per instruction
tests/                     Anchor/TS test suite (see Known gaps below)
netlify/functions/         Smart TX Stack backend (Jito bundle submit,
                             dynamic tip, Groq retry agent, RPC proxy,
                             cash-out, buy-crypto, Bitnob webhook)
*.js (root)                 frontend payment logic: payment-transfer.js,
                             smart-tx.js, veil-engine.js, swap.js,
                             wallet-adapter.js, app.js, scanner.js
*.html                     pages: index, dashboard, pay, privacy, tos, 404
Anchor.toml, Cargo.toml    Anchor workspace config
package.json               Netlify Functions dependencies
```

## Branches

Just `main`. This is a fresh repo, no production traffic sits on it
yet (unlike VeilPay's own `main`, which stays untouched and live),
so there's no need for a foundation/staging split. Session B and
Session C branch off `main` once it lands.

## The treasury PDA (was blocking Session B)

Both codebases previously sent their 2% / 1% platform fee straight to
`CjFuX951H7xEoLD3Gzbht5pqK7baoGZ6q32SfUQxNdWS`, a personal-keypair
wallet, hardcoded in `payment-transfer.js`, `swap.js`, and (on the
program side) stored per-vault as an arbitrary caller-supplied
`Pubkey` on `FamilyVault`. That's a single point of failure and
exactly what Session B flagged: the DBC treasury/fee-claimer needs to
be a PDA or multisig owned by the program, not a wallet.

Fixed as follows:

- **`programs/cognata/src/state.rs`**: new `Treasury` singleton PDA,
  seeds `[b"treasury"]`. No private key exists for this address; it's
  a program-derived address, so it can only move funds out via
  `invoke_signed` from inside the program itself.
- **`instructions/init_treasury.rs`**: creates the singleton, run
  once at deploy time, right after `init_fee_config`.
- **`instructions/claim_fees.rs`**: the *only* instruction that can
  move funds out of the treasury. Gated to `fee_config.admin` as
  signer. **`admin` needs to be set to a multisig (Squads or
  similar) at deploy time, not a personal keypair** — the PDA fixes
  the receiving side, but claiming still needs a multisig on the
  spending side, or you've just moved the single-point-of-failure one
  step over instead of removing it.
- **`FamilyVault.fee_destination` removed.** It used to be a
  caller-supplied `Pubkey` set at vault-init time; that field is gone
  entirely, so there's no code path left where a caller can point
  fees somewhere else. `contribute.rs` and
  `execute_recurring_contribution.rs` now constrain the fee account
  to the treasury's own associated token account
  (`associated_token::authority = treasury`), enforced by the
  runtime, not by convention.
- **Client side**: `payment-transfer.js` and `swap.js` no longer
  hardcode the wallet string. Both derive the treasury PDA at
  call-time via `findProgramAddressSync([b"treasury"], COGNATA_PROGRAM_ID)`
  (see `getTreasuryPda()` in `payment-transfer.js`, reused by
  `swap.js` off `window.PaymentTransfer`).

If Session B's DBC "Goal Token" work needs its own fee-claimer
address, wiring it to this same `Treasury` PDA (rather than minting a
second one) keeps a single audit trail and a single multisig to
manage, worth doing unless there's a reason the two fee streams need
to stay separate.

## Known gaps / TODO

- **Program ID is a placeholder** (`6apQZUxBwpBbFNiBpYzGeMBQJ8328xrrsQ3aRcQhM2Av`
  in `Anchor.toml` and `declare_id!` in `lib.rs`). Not deployed under
  this identity yet. Run `anchor keys sync` once you have a real
  deploy keypair, then update `COGNATA_PROGRAM_ID` in
  `payment-transfer.js` to match, it's currently a manually-set
  constant, not read from an IDL.
- **`tests/04_passkey_flow.test.ts`** is updated for the `Treasury`
  change (calls `initTreasury`, derives the treasury ATA instead of a
  throwaway wallet). This is the suite that reflects the current
  instruction surface.
- **`tests/01_setup_and_contribute.test.ts`** and
  **`tests/02_recurring_contribution.test.ts`** were already stale
  against the current program before this merge, they predate the
  passkey rework (old `contribute` account shape, no `device_role` /
  `authenticator_data` params). Pre-existing, not something this
  merge introduced, but they'll need a rewrite to match the current
  IDL before they're trustworthy again.
- **Rebrand is UI-surface only.** `index.html`, `dashboard.html`,
  `pay.html`, `privacy.html`, `tos.html`, `404.html`, titles, meta
  tags, footer, body copy, all say Cognata now. Internal JS object
  names (`VeilEngine`, `VeilSwapModule`), filenames
  (`veil-engine.js`), and the Netlify Functions package name were
  left alone, renaming those touches call sites across most of the
  JS files and wasn't worth the risk of breaking something
  unverifiable in this pass. Fine to leave as internal implementation
  detail unless it's user-visible somewhere I missed.
- **Not compiled or run.** No Solana/Anchor toolchain or RPC access
  in the sandbox this was built in, so none of this has been through
  `anchor build`/`anchor test`. Structurally consistent (crate name,
  instruction wiring, account constraints all line up), but treat the
  first real build as the actual verification step.

## For Session C (infra swap: RPC Fast, Solami)

The Smart TX Stack's provider-facing code lives in
`netlify/functions/`: `submit-bundle.js` (Jito bundle submission),
`get-tip.js` (dynamic tip), `rpc-proxy.js` (currently proxies
Helius), `reason-retry.js` (Groq retry agent, provider-agnostic).
Client-side, `smart-tx.js` and `wallet-adapter.js` talk to these
through `/api/*` Netlify redirects (see `netlify.toml`), not directly
to any RPC URL, so swapping providers should mostly be contained to
`rpc-proxy.js` and `submit-bundle.js`.
