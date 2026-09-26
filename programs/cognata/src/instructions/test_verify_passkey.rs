use anchor_lang::prelude::*;
use crate::passkey::verify_passkey_authorization;

/// ⚠️ MUST BE REMOVED BEFORE MAINNET DEPLOYMENT ⚠️
///
/// Kept intentionally (as of the session that first got real-signature
/// verification working) as a standing regression test: an
/// unauthenticated oracle that verifies ANY caller-supplied secp256r1
/// proof against ANY caller-supplied expected pubkey, with no vault/
/// business context. Genuinely useful for confirming passkey.rs still
/// works correctly after future changes — genuinely dangerous to leave
/// reachable on a production deployment, since it has no access
/// control of its own. Strip this file + its lib.rs/mod.rs wiring as
/// part of pre-mainnet cleanup, verified by grep for
/// "test_verify_passkey" returning nothing.
#[derive(Accounts)]
pub struct TestVerifyPasskey<'info> {
    /// CHECK: read via introspection inside verify_passkey_authorization.
    pub instructions_sysvar: UncheckedAccount<'info>,
}

pub fn handler(
    ctx: Context<TestVerifyPasskey>,
    expected_device_pubkey: [u8; 33],
    authenticator_data: Vec<u8>,
    client_data_json: Vec<u8>,
    expected_origin: Vec<u8>,
) -> Result<()> {
    verify_passkey_authorization(
        &ctx.accounts.instructions_sysvar.to_account_info(),
        &expected_device_pubkey,
        &authenticator_data,
        &client_data_json,
        &expected_origin,
        33, // business_data_len: expected_device_pubkey (33 bytes) is the only fixed-size arg before the variable-length ones
    )?;
    msg!("passkey verification succeeded");
    Ok(())
}
