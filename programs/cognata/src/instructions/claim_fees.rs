use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::errors::FamilyWalletError;
use crate::state::{FeeConfig, Treasury};
use crate::token_transfer::transfer_checked_cpi_signed;

/// The only way funds ever leave the treasury PDA. Gated to
/// `fee_config.admin`, in production this must be a multisig (e.g. a
/// Squads vault), not a personal keypair, or the PDA-owned-treasury
/// protection on the receiving side is undone by a single-key
/// authority on the spending side.
#[derive(Accounts)]
pub struct ClaimFees<'info> {
    #[account(seeds = [b"fee_config"], bump = fee_config.bump, has_one = admin)]
    pub fee_config: Box<Account<'info, FeeConfig>>,

    pub admin: Signer<'info>,

    #[account(mut, seeds = [b"treasury"], bump = treasury.bump)]
    pub treasury: Box<Account<'info, Treasury>>,

    #[account(
        mut,
        associated_token::authority = treasury,
        associated_token::mint = mint,
    )]
    pub treasury_token_account: Box<Account<'info, TokenAccount>>,

    /// Wherever the admin wants claimed fees sent. Deliberately NOT
    /// constrained to any particular address here, since this whole
    /// instruction is already gated to the admin signer, the fixed-
    /// destination guarantee lives on the receiving side (contribute /
    /// execute_recurring_contribution), not here.
    #[account(mut)]
    pub destination_token_account: Box<Account<'info, TokenAccount>>,

    pub mint: Box<Account<'info, Mint>>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<ClaimFees>, amount: u64, decimals: u8) -> Result<()> {
    require!(amount > 0, FamilyWalletError::ZeroAmount);

    let treasury_bump = ctx.accounts.treasury.bump;
    let treasury_seeds: &[&[u8]] = &[b"treasury", &[treasury_bump]];
    let signer_seeds: &[&[&[u8]]] = &[treasury_seeds];

    transfer_checked_cpi_signed(
        &ctx.accounts.token_program,
        &ctx.accounts.treasury_token_account,
        &ctx.accounts.mint,
        &ctx.accounts.destination_token_account,
        &ctx.accounts.treasury.to_account_info(),
        amount,
        decimals,
        signer_seeds,
    )?;

    let treasury = &mut ctx.accounts.treasury;
    treasury.total_claimed = treasury
        .total_claimed
        .checked_add(amount)
        .ok_or(FamilyWalletError::Overflow)?;

    Ok(())
}
