# Deploying the Sela program

Written for Tunde's Fedora machine: Anchor CLI 1.1.1, Solana CLI 3.1.10.
Run every command from the repo root unless it says otherwise.

## What Session A could and could not do

The sandbox Session A works in cannot reach the hosts that serve the Rust
and Solana toolchains, so **the program has not been compiled there and
there is no measured binary size yet.** Do not trust any size number
until you have run step 2 below on your machine. The commands in step 2
give you the exact byte count and the exact rent in one go.

Size work already done in the source, all unverified until you build:

- `opt-level = "z"` added to `[profile.release]` in `Cargo.toml`
  (`lto = "fat"` and `codegen-units = 1` were already there).
- Unused `token_2022` feature dropped from `anchor-spl` in
  `programs/cognata/Cargo.toml` (nothing in the program uses Token-2022).
- The placeholder passkey origin `https://app.familywallet.example` is
  replaced by one constant, `EXPECTED_ORIGIN` in `passkey.rs`, set to
  `https://selaaa.netlify.app`. The old value would have made every
  passkey check fail on the real site.

Still to do by hand before a mainnet build (not done because it cannot be
checked without a compiler): remove the `test_verify_passkey` instruction.
It is a regression oracle marked for removal before mainnet. Delete the
`test_verify_passkey` function in `programs/cognata/src/lib.rs`, its line
in `instructions/mod.rs`, and `instructions/test_verify_passkey.rs`.

## 1. Check your tools

```bash
anchor --version      # expect 1.1.1
solana --version      # expect 3.1.10
solana config get
```

## 2. Build, measure, cost

```bash
anchor keys sync        # writes the real program ID into declare_id! and Anchor.toml
anchor build
ls -l target/deploy/cognata.so
```

Rent for the program data account (the number to fund):

```bash
BYTES=$(stat -c%s target/deploy/cognata.so)
solana rent $((BYTES + 45))          # 45 = ProgramData header
```

Rule of thumb: about 0.00000696 SOL per byte, so a 300 KB binary is
roughly 2.09 SOL. During the deploy the buffer account holds a second
copy, so the deploying wallet needs about double that free, and the
buffer's share is refunded afterwards.

Send Tunde's report to the team as: bytes, `solana rent` output, and the
wallet balance needed (about 2x the rent).

Back up `target/deploy/cognata-keypair.json` somewhere offline. It is the
program's identity. Using the same keypair on devnet and mainnet keeps one
program ID everywhere, which keeps `sela-config.js` simple.

## 3. Devnet deploy

```bash
solana config set --url devnet
solana balance                       # airdrop or use the faucet until there is enough
solana airdrop 2                     # repeat, devnet limits apply
anchor deploy --provider.cluster devnet
solana program show $(solana address -k target/deploy/cognata-keypair.json)
```

On devnet a plain keypair is fine for the fee admin.

## 4. One-time setup (devnet)

Pick the devnet USDC mint the app will use, then:

```bash
npm i @solana/web3.js
node scripts/init-program.js \
  --keypair ~/.config/solana/id.json \
  --mint <DEVNET_USDC_MINT> \
  --standard-fee 10000 --founding-fee 0
```

Fee amounts are USDC base units (6 decimals), so 10000 is 0.01 USDC per
contribution. Choose your own. The script creates `fee_config`, the
`treasury` PDA, and the treasury's token account. Run it right after
deploy: whoever calls `init_fee_config` first becomes the fee admin.

## 5. Point the app at the new program

1. `sela-config.js`: set `PROGRAM_ID` to the address from step 2 and keep
   `PROGRAM_CLUSTER: 'devnet'`. This one file feeds the browser and the
   keeper function.
2. Netlify environment variables:
   - `KEEPER_KEYPAIR_JSON`: a dedicated wallet funded with gas only, JSON
     array secret key format. Never reuse a personal wallet.
   - `PROGRAM_RPC_URL` (optional): override the RPC used for the program
     cluster. Default is the public devnet endpoint.
3. Commit and push. Netlify rebuilds from `main`.

The passkey origin is compiled into the program. If the site ever moves to
another domain, change `EXPECTED_ORIGIN` in `passkey.rs` and upgrade the
program (`anchor build && anchor upgrade ...`).

## 6. Mainnet

Only after devnet works end to end.

1. Fund the deploy wallet with about double the rent from step 2.
2. `solana config set --url mainnet-beta`, then
   `anchor deploy --provider.cluster mainnet`.
3. **The fee admin must be a multisig** (a Squads vault). Do not make a
   plain keypair the admin on mainnet, it would hold the only key that can
   claim every fee. Get the vault address, then:
   ```bash
   node scripts/init-program.js --admin <SQUADS_VAULT_PUBKEY> \
        --standard-fee <N> --founding-fee <N>
   ```
   With no `--keypair` this prints the `init_fee_config` instruction to
   paste into a Squads transaction. Approve and execute it there. Then:
   ```bash
   node scripts/init-program.js --keypair <funded keypair> --skip-fee-config \
        --mint EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
   ```
   to create the treasury and its USDC token account.
4. Move the upgrade authority to the multisig:
   ```bash
   solana program set-upgrade-authority <PROGRAM_ID> --new-upgrade-authority <SQUADS_VAULT_PUBKEY>
   ```
5. `sela-config.js`: set `PROGRAM_CLUSTER: 'mainnet-beta'`. Only now switch
   `FEE_MODE` from `'wallet'` to `'treasury_pda'`. Until the program is
   live on mainnet, fees must go to the wallet, because a treasury PDA of
   an undeployed program cannot be signed for and the money would be lost.
6. Update `KEEPER_KEYPAIR_JSON` funding for mainnet gas, and re-run one
   small allowance end to end before announcing anything.
