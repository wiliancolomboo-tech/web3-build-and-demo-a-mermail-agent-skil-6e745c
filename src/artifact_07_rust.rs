use anchor_lang::prelude::*;
use crate::state::{AgentRegistry, AGENT_REGISTRY_SEED};
use crate::errors::MermailError;

#[derive(Accounts)]
#[instruction(agent_id: String)]
pub struct InitializeAgent<'info> {
    #[account(
        init,
        payer = authority,
        space = AgentRegistry::BASE_LEN,
        seeds = [AGENT_REGISTRY_SEED, authority.key().as_ref(), agent_id.as_bytes()],
        bump
    )]
    pub agent_registry: Account<'info, AgentRegistry>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<InitializeAgent>,
    agent_id: String,
    cooldown_seconds: i64,
) -> Result<()> {
    require!(agent_id.len() <= 32, MermailError::AgentIdTooLong);

    let registry = &mut ctx.accounts.agent_registry;
    registry.authority = ctx.accounts.authority.key();
    registry.agent_id = agent_id;
    registry.cooldown_seconds = cooldown_seconds;
    registry.last_dispatch_timestamp = 0;
    registry.total_messages_dispatched = 0;
    registry.is_active = true;
    registry.bump = ctx.bumps.agent_registry;

    msg!("Mermail Agent initialized: {}", registry.agent_id);
    Ok(())
}