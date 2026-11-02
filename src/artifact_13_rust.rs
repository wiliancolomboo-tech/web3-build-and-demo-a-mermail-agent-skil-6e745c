use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("MermSC1111111111111111111111111111111111111");

#[program]
pub mod mermail_agent_skill {
    use super::*;

    pub fn initialize_mailbox(
        ctx: Context<InitializeMailbox>,
        protocol_fee_bps: u16,
    ) -> Result<()> {
        instructions::initialize_mailbox::handler(ctx, protocol_fee_bps)
    }

    pub fn register_agent(
        ctx: Context<RegisterAgent>,
        base_fee_lamports: u64,
        metadata_uri: String,
    ) -> Result<()> {
        instructions::register_agent::handler(ctx, base_fee_lamports, metadata_uri)
    }

    pub fn send_agent_message(
        ctx: Context<SendAgentMessage>,
        content_digest: [u8; 32],
        ttl_seconds: i64,
    ) -> Result<()> {
        instructions::send_agent_message::handler(ctx, content_digest, ttl_seconds)
    }

    pub fn acknowledge_message(
        ctx: Context<AcknowledgeMessage>,
        external_receipt: [u8; 32],
    ) -> Result<()> {
        instructions::acknowledge_message::handler(ctx, external_receipt)
    }

    pub fn withdraw_fees(ctx: Context<WithdrawFees>) -> Result<()> {
        instructions::withdraw_fees::handler(ctx)
    }
}