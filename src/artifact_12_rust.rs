use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("mermaiL11111111111111111111111111111111111");

#[program]
pub mod mermail_core {
    use super::*;

    pub fn initialize_channel(
        ctx: Context<InitializeChannel>,
        fee_lamports: u64,
    ) -> Result<()> {
        instructions::initialize_channel::handler(ctx, fee_lamports)
    }

    pub fn send_mail_intent(
        ctx: Context<SendMailIntent>,
        nonce: u64,
        recipient_hash: [u8; 32],
        content_hash: [u8; 32],
        bounty_lamports: u64,
        valid_slots: u64,
    ) -> Result<()> {
        instructions::send_mail_intent::handler(
            ctx,
            nonce,
            recipient_hash,
            content_hash,
            bounty_lamports,
            valid_slots,
        )
    }

    pub fn confirm_delivery(
        ctx: Context<ConfirmDelivery>,
        external_delivery_id: [u8; 32],
    ) -> Result<()> {
        instructions::confirm_delivery::handler(ctx, external_delivery_id)
    }

    pub fn refund_expired(ctx: Context<RefundExpired>) -> Result<()> {
        instructions::refund_expired::handler(ctx)
    }
}