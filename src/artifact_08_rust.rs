use anchor_lang::prelude::*;
use crate::state::{AgentRegistry, MessageReceipt, AGENT_REGISTRY_SEED, MESSAGE_RECEIPT_SEED};
use crate::errors::MermailError;

#[event]
pub struct MessageQueuedEvent {
    pub agent: PubKey,
    pub sequence_id: u64,
    pub recipient_hash: [u8; 32],
    pub payload_hash: [u8; 32],
    pub channel_tag: String,
    pub timestamp: i64,
}

#[derive(Accounts)]
pub struct DispatchMessage<'info> {
    #[account(
        mut,
        seeds = [AGENT_REGISTRY_SEED, authority.key().as_ref(), agent_registry.agent_id.as_bytes()],
        bump = agent_registry.bump,
        has_one = authority @ MermailError::UnauthorizedAuthority
    )]
    pub agent_registry: Account<'info, AgentRegistry>,

    #[account(
        init,
        payer = authority,
        space = MessageReceipt::BASE_LEN,
        seeds = [
            MESSAGE_RECEIPT_SEED,
            agent_registry.key().as_ref(),
            &agent_registry.total_messages_dispatched.to_le_bytes()
        ],
        bump
    )]
    pub message_receipt: Account<'info, MessageReceipt>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<DispatchMessage>,
    recipient_hash: [u8; 32],
    payload_hash: [u8; 32],
    channel_tag: String,
) -> Result<()> {
    let clock = Clock::get()?;
    let current_timestamp = clock.unix_timestamp;

    require!(recipient_hash != [0u8; 32], MermailError::InvalidRecipientHash);
    require!(payload_hash != [0u8; 32], MermailError::InvalidPayloadHash);
    require!(channel_tag.len() <= 16, MermailError::ChannelTagTooLong);

    let registry = &mut ctx.accounts.agent_registry;
    require!(registry.is_active, MermailError::AgentInactive);

    // Enforce cooldown rate limiting
    if registry.last_dispatch_timestamp > 0 {
        let elapsed = current_timestamp.saturating_sub(registry.last_dispatch_timestamp);
        require!(
            elapsed >= registry.cooldown_seconds,
            MermailError::RateLimitExceeded
        );
    }

    let seq_id = registry.total_messages_dispatched;

    // Populate the deterministic on-chain receipt PDA
    let receipt = &mut ctx.accounts.message_receipt;
    receipt.agent = registry.key();
    receipt.sequence_id = seq_id;
    receipt.timestamp = current_timestamp;
    receipt.recipient_hash = recipient_hash;
    receipt.payload_hash = payload_hash;
    receipt.channel_tag = channel_tag.clone();
    receipt.bump = ctx.bumps.message_receipt;

    // Mutate state counter & timestamp
    registry.total_messages_dispatched = registry.total_messages_dispatched.checked_add(1).unwrap();
    registry.last_dispatch_timestamp = current_timestamp;

    // Emit event for real-time WebSocket listening agents
    emit!(MessageQueuedEvent {
        agent: registry.key(),
        sequence_id: seq_id,
        recipient_hash,
        payload_hash,
        channel_tag,
        timestamp: current_timestamp,
    });

    msg!(
        "Mermail: Sequence {} dispatched for agent {}",
        seq_id,
        registry.agent_id
    );

    Ok(())
}