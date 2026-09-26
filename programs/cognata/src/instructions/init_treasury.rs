use anchor_lang::prelude::*;

use crate::state::Treasury;

#[derive(Accounts)]
pub struct InitTreasury<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        init,
        payer = payer,
        space = Treasury::SPACE,
        seeds = [b"treasury"],
        bump
    )]
    pub treasury: Account<'info, Treasury>,

    pub system_program: Program<'info, System>,
}

/// Deployed once, ever, per program, right after `init_fee_config`.
/// This PDA (not any keypair) becomes the program-wide fee-collection
/// authority. Its USDC associated token account is created separately
/// (standard `create_associated_token_account`, permissionless, owner
/// = this PDA) the first time a fee actually needs to land there —
/// no special instruction needed for that part, anchor_spl's
/// `associated_token::authority = treasury` constraint on the
/// receiving side just requires the ATA to already exist at the
/// deterministic address, same as any other ATA.
pub fn handler(ctx: Context<InitTreasury>) -> Result<()> {
    let treasury = &mut ctx.accounts.treasury;
    treasury.bump = ctx.bumps.treasury;
    treasury.total_claimed = 0;
    Ok(())
}
