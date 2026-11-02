use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("Merm111111111111111111111111111111111111111");

#[program]
pub mod mermail_core {
    use super::*;

    pub fn initialize_agent(
        ctx: Context<InitializeAgent>,
        agent_id: String,
        cooldown_seconds: i64,
    ) -> Result<()> {
        instructions::initialize_agent::handler(ctx, agent_id, cooldown_seconds)
    }

    pub fn dispatch_message(
        ctx: Context<DispatchMessage>,
        recipient_hash: [u8; 32],
        payload_hash: [u8; 32],
        channel_tag: String,
    ) -> Result<()> {
        instructions::dispatch_message::handler(ctx, recipient_hash, payload_hash, channel_tag)
    }
}