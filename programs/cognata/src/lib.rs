// Cognata, Anchor program entrypoint
// Family/couples Solana wallet, on-chain program (merged with VeilPay's
// Smart TX Stack as the payment engine, see /lib/smart-tx-stack.md)
// Made by TJS Code

use anchor_lang::prelude::*;

pub mod errors;
pub mod fee;
pub mod instructions;
pub mod passkey;
pub mod state;
pub mod token_transfer;

use instructions::*;
use state::{Currency, FeeTier, Frequency};

// TODO: replace with the real deployed program ID once `anchor keys sync`
// (or `solana address -k target/deploy/cognata-keypair.json`) has
// been run on your machine, this placeholder will not deploy correctly.
declare_id!("6apQZUxBwpBbFNiBpYzGeMBQJ8328xrrsQ3aRcQhM2Av");

#[program]
pub mod cognata {
    use super::*;

    pub fn init_fee_config(
        ctx: Context<InitFeeConfig>,
        standard_fee_amount: u64,
        founding_fee_amount: u64,
    ) -> Result<()> {
        instructions::init_fee_config::handler(ctx, standard_fee_amount, founding_fee_amount)
    }

    pub fn init_family_vault(
        ctx: Context<InitFamilyVault>,
        vault_seed: Pubkey,
        primary_contributor_device: [u8; 33],
        partner_device: [u8; 33],
        guardian: Pubkey,
        fee_tier: FeeTier,
    ) -> Result<()> {
        instructions::init_family_vault::handler(
            ctx,
            vault_seed,
            primary_contributor_device,
            partner_device,
            guardian,
            fee_tier,
        )
    }

    /// Deploy-time only. Creates the program-wide treasury PDA that is
    /// the sole fee destination for the whole program. Run once, right
    /// after init_fee_config.
    pub fn init_treasury(ctx: Context<InitTreasury>) -> Result<()> {
        instructions::init_treasury::handler(ctx)
    }

    /// The only instruction that can move funds out of the treasury
    /// PDA. Gated to fee_config.admin, see the doc comment on
    /// ClaimFees in instructions/claim_fees.rs for why that admin
    /// pubkey must be a multisig in production.
    pub fn claim_fees(ctx: Context<ClaimFees>, amount: u64, decimals: u8) -> Result<()> {
        instructions::claim_fees::handler(ctx, amount, decimals)
    }

    pub fn init_savings_goal(
        ctx: Context<InitSavingsGoal>,
        name: String,
        target_amount: u64,
        currency: Currency,
        deadline: i64,
    ) -> Result<()> {
        instructions::init_savings_goal::handler(ctx, name, target_amount, currency, deadline)
    }

    pub fn contribute(
        ctx: Context<Contribute>,
        device_role: u8,
        amount: u64,
        decimals: u8,
        authenticator_data: Vec<u8>,
        client_data_json: Vec<u8>,
    ) -> Result<()> {
        instructions::contribute::handler(
            ctx,
            device_role,
            amount,
            decimals,
            authenticator_data,
            client_data_json,
        )
    }

    pub fn authorize_recurring_delegate(
        ctx: Context<AuthorizeRecurringDelegate>,
        device_role: u8,
        amount_per_period: u64,
        frequency: Frequency,
        next_run_at: i64,
        authenticator_data: Vec<u8>,
        client_data_json: Vec<u8>,
    ) -> Result<()> {
        instructions::authorize_recurring_delegate::handler(
            ctx,
            device_role,
            amount_per_period,
            frequency,
            next_run_at,
            authenticator_data,
            client_data_json,
        )
    }

    pub fn execute_recurring_contribution(
        ctx: Context<ExecuteRecurringContribution>,
        decimals: u8,
    ) -> Result<()> {
        instructions::execute_recurring_contribution::handler(ctx, decimals)
    }

    pub fn cancel_recurring_delegate(
        ctx: Context<CancelRecurringDelegate>,
        device_role: u8,
        authenticator_data: Vec<u8>,
        client_data_json: Vec<u8>,
    ) -> Result<()> {
        instructions::cancel_recurring_delegate::handler(
            ctx,
            device_role,
            authenticator_data,
            client_data_json,
        )
    }


    pub fn request_key_rotation(
        ctx: Context<RequestKeyRotation>,
        device_role: u8,
        new_device_pubkey: [u8; 33],
    ) -> Result<()> {
        instructions::request_key_rotation::handler(ctx, device_role, new_device_pubkey)
    }

    pub fn approve_key_rotation(ctx: Context<ApproveKeyRotation>) -> Result<()> {
        instructions::approve_key_rotation::handler(ctx)
    }

    pub fn withdraw(
        ctx: Context<Withdraw>,
        device_role: u8,
        amount: u64,
        decimals: u8,
        authenticator_data: Vec<u8>,
        client_data_json: Vec<u8>,
    ) -> Result<()> {
        instructions::withdraw::handler(
            ctx,
            device_role,
            amount,
            decimals,
            authenticator_data,
            client_data_json,
        )
    }

    // ⚠️ MUST BE REMOVED BEFORE MAINNET, see the doc comment in
    // instructions/test_verify_passkey.rs for why it's being kept for now.
    pub fn test_verify_passkey(
        ctx: Context<TestVerifyPasskey>,
        expected_device_pubkey: [u8; 33],
        authenticator_data: Vec<u8>,
        client_data_json: Vec<u8>,
        expected_origin: Vec<u8>,
    ) -> Result<()> {
        instructions::test_verify_passkey::handler(
            ctx,
            expected_device_pubkey,
            authenticator_data,
            client_data_json,
            expected_origin,
        )
    }
}
