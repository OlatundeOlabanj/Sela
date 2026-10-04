# Cognata on-chain accounts reference

For Session B and Session C. If you need an address or a derivation
and it's not here, it's probably a gap in this doc, not a reason to
wait, ping in the meantime but don't block on a reply.

## Treasury PDA (the fee-claimer / DBC treasury account)

This is the resolution to the "personal wallet" issue Session B
flagged. There is exactly one fee-collection address in the whole
program, and it is a program-derived address, not a keypair.

```
seeds:      [b"treasury"]
program:    Cognata program ID (see Program ID below)
account:    programs/cognata/src/state.rs -> pub struct Treasury
```

Rust derivation (inside an Anchor `#[account(...)]` constraint):

```rust
#[account(seeds = [b"treasury"], bump = treasury.bump)]
pub treasury: Box<Account<'info, Treasury>>,
```

Rust derivation (standalone, e.g. in a client or a script):

```rust
let (treasury_pda, bump) = Pubkey::find_program_address(&[b"treasury"], &cognata::ID);
```

JS/TS derivation (already implemented, see `payment-transfer.js` ->
`getTreasuryPda()`):

```js
const [treasuryPda] = web3.PublicKey.findProgramAddressSync(
  [new TextEncoder().encode('treasury')],
  new web3.PublicKey(COGNATA_PROGRAM_ID),
);
```

The PDA itself holds no tokens directly. Its **associated token
account** (standard SPL ATA, owner = the PDA above, mint = whichever
token, USDC in the current flows) is where fees actually land. Derive
that the normal way (`getAssociatedTokenAddress(treasuryPda, mint)`
client-side, or `associated_token::authority = treasury` as an Anchor
constraint on the program side). Any SPL transfer instruction can
send tokens into it, the PDA doesn't need to sign to *receive*.

## Why this is the answer for the DBC treasury too

If the Goal Token / DBC work needs a fee-claimer or treasury account,
point it at this same PDA rather than deriving a second one, unless
there's a concrete reason the two fee streams need to stay legally or
operationally separate. One PDA means one audit trail and one
multisig to manage instead of two. If you do need a second one for a
real reason, follow the identical pattern: `seeds = [b"<name>"]`
under the Cognata program ID, no keypair, and add it to this file
when you do.

## Getting funds OUT of the treasury

The PDA has no private key, so it can't sign a normal transaction.
The only way money leaves is the program's own `claim_fees`
instruction (`programs/cognata/src/instructions/claim_fees.rs`),
which does an `invoke_signed` CPI using the PDA's seeds.

`claim_fees` is gated to `fee_config.admin` as a required signer
(`has_one = admin` against `FeeConfig`). **`admin` must be set to a
multisig (Squads or equivalent) when `init_fee_config` is called at
deploy time.** The PDA solves the receiving-side risk (no wallet to
compromise, no wallet to fat-finger); if `admin` is left as a single
personal keypair, that keypair becomes the new single point of
failure on the spending side. Don't deploy with a personal keypair as
admin, whoever runs the deploy script needs to know this.

```
instruction: claim_fees(amount: u64, decimals: u8)
accounts:
  fee_config              seeds = [b"fee_config"]
  admin                   signer, must equal fee_config.admin
  treasury                seeds = [b"treasury"], mut
  treasury_token_account  ATA, authority = treasury, mint = <mint>, mut
  destination_token_account  wherever the admin wants it sent, mut
  mint
  token_program
```

## Program ID

**Placeholder, not deployed yet:** `6apQZUxBwpBbFNiBpYzGeMBQJ8328xrrsQ3aRcQhM2Av`

Set in `Anchor.toml` (`[programs.localnet]`) and `declare_id!(...)`
in `programs/cognata/src/lib.rs`. Whoever runs the first real deploy
needs to run `anchor keys sync` and then update
`COGNATA_PROGRAM_ID` in `payment-transfer.js` (currently a manually
set constant, not read from an IDL) to match. Every derivation above
depends on this ID being correct, treat a deploy-key mismatch as the
first thing to check if a PDA doesn't derive to what you expect.

## Other PDAs already in the program, for reference

```
FamilyVault              seeds = [b"vault", vault_seed]
SavingsGoal               seeds = [b"goal", vault.key(), goal_seq (u32 LE)]
FeeConfig                 seeds = [b"fee_config"]
Treasury                  seeds = [b"treasury"]          <- this doc
wallet_authority (device) seeds = [b"wallet", vault.key(), device_role]
RecurringContributionDelegate  seeds = [b"delegate", goal.key()]
KeyRotationRequest        seeds = [b"rotation", vault.key(), device_role]
```

Correction: this table previously said `wallet_authority`'s seed prefix
was `b"wallet_authority"`, the real prefix (checked directly against
`contribute.rs` / `authorize_recurring_delegate.rs`) is `b"wallet"`.
Fixed above, flagging the correction here rather than silently editing
it, in case anything was built against the wrong value.

## Family invites and multi-device vaults (device_role, key rotation)

`wallet_authority` above is a funds-custody signing PDA (used via
`invoke_signed` for recurring-contribution token delegation), it does
**not** store a device's passkey public key, despite the name
suggesting a device registry. Worth being precise about this since
it's an easy thing to conflate.

The actual device public keys live as two fixed fields directly on
`FamilyVault`: `primary_contributor_device` (`device_role` 0) and
`partner_device` (`device_role` 1), both `[u8; 33]` compressed
secp256r1 points, both passed as arguments to `init_family_vault` at
vault-creation time. This is a hard v1 constraint: **a vault supports
exactly one owner and one partner, not an arbitrary family size.**
There is no third slot.

Adding a second member after vault creation (the "invite" flow) uses
`request_key_rotation` + `approve_key_rotation`, the same two
instructions documented for lost-device recovery. Nothing on-chain
distinguishes "set a never-before-used slot" from "replace a lost
key", `approve_key_rotation` writes `new_device_pubkey` into the
target slot unconditionally, no check that the slot was previously
non-zero. So inviting a member is, mechanically, requesting a
rotation of an unset slot, guardian-approved. No new on-chain
instruction was added for this, confirmed deliberately rather than
assumed, see `programs/cognata/src/instructions/request_key_rotation.rs`
and `approve_key_rotation.rs`.

`request_key_rotation`'s `backend_authority` signer has no on-chain
constraint tying it to any particular pubkey, so anyone can submit a
request (including the new member, from their own wallet, which is
the join flow this app uses, see `join.html`). The actual security
boundary is `approve_key_rotation`'s `has_one = guardian` check, only
the vault's guardian can make a request take effect.

Revocation has no dedicated instruction either. The guardian approving
a rotation to a 33-byte all-zero `new_device_pubkey` is the existing
mechanism repurposed for this, functional, but worth naming plainly as
a repurposing rather than a clean purpose-built revoke, in case that
distinction matters for a future audit.

Exact seed byte layouts are in `programs/cognata/src/instructions/*.rs`
next to each `#[account(...)]` block, this table is a map, not the
source of truth, check the instruction file if something doesn't
derive.
