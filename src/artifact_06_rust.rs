use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};

declare_id!("MermA11111111111111111111111111111111111111");

pub const AGENT_REGISTRY_SEED: &[u8] = b"agent-registry";
pub const MESSAGE_RECEIPT_SEED: &[u8] = b"message-receipt";
pub const ESCROW_VAULT_SEED: &[u8] = b"escrow-vault";

#[program]
pub mod mermail_protocol {
    use super::*;

    pub fn initialize_agent(
        ctx: Context<InitializeAgent>,
        agent_name: String,
        metadata_uri: String,
    ) -> Result<()> {
        require!(agent_name.as_bytes().len() <= 32, MermailError::NameTooLong);
        require!(metadata_uri.as_bytes().len() <= 128, MermailError::UriTooLong);

        let registry = &mut ctx.accounts.agent_registry;
        registry.authority = ctx.accounts.authority.key();
        registry.agent_name = agent_name;
        registry.metadata_uri = metadata_uri;
        registry.messages_sent = 0;
        registry.messages_received = 0;
        registry.registered_at = Clock::get()?.unix_timestamp;
        registry.bump = ctx.bumps.agent_registry;

        emit!(AgentRegisteredEvent {
            authority: registry.authority,
            agent_name: registry.agent_name.clone(),
            timestamp: registry.registered_at,
        });

        Ok(())
    }

    pub fn send_message_with_escrow(
        ctx: Context<SendMessageWithEscrow>,
        message_id: u64,
        payload_hash: [u8; 32],
        escrow_amount: u64,
        expiry_seconds: i64,
    ) -> Result<()> {
        require!(expiry_seconds > 60, MermailError::InvalidExpiryTime);
        let clock = Clock::get()?;

        let sender_registry = &mut ctx.accounts.sender_registry;
        sender_registry.messages_sent = sender_registry.messages_sent.checked_add(1)
            .ok_or(MermailError::MathOverflow)?;

        let message = &mut ctx.accounts.message_receipt;
        message.message_id = message_id;
        message.sender = ctx.accounts.sender.key();
        message.recipient = ctx.accounts.recipient.key();
        message.payload_hash = payload_hash;
        message.escrow_amount = escrow_amount;
        message.created_at = clock.unix_timestamp;
        message.expires_at = clock.unix_timestamp.checked_add(expiry_seconds)
            .ok_or(MermailError::MathOverflow)?;
        message.claimed = false;
        message.cancelled = false;
        message.vault_bump = ctx.bumps.escrow_vault;
        message.bump = ctx.bumps.message_receipt;

        if escrow_amount > 0 {
            let cpi_context = CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.sender.to_account_info(),
                    to: ctx.accounts.escrow_vault.to_account_info(),
                },
            );
            transfer(cpi_context, escrow_amount)?;
        }

        emit!(MessageDispatchedEvent {
            message_id,
            sender: message.sender,
            recipient: message.recipient,
            payload_hash,
            escrow_amount,
            expires_at: message.expires_at,
        });

        Ok(())
    }

    pub fn claim_message_escrow(
        ctx: Context<ClaimMessageEscrow>,
        message_id: u64,
        response_hash: [u8; 32],
    ) -> Result<()> {
        let message = &mut ctx.accounts.message_receipt;
        let clock = Clock::get()?;

        require!(!message.claimed, MermailError::AlreadyClaimed);
        require!(!message.cancelled, MermailError::AlreadyCancelled);
        require!(clock.unix_timestamp <= message.expires_at, MermailError::MessageExpired);
        require_keys_eq!(message.recipient, ctx.accounts.recipient.key(), MermailError::UnauthorizedRecipient);

        message.claimed = true;

        let escrow_amount = message.escrow_amount;
        if escrow_amount > 0 {
            let message_id_bytes = message_id.to_le_bytes();
            let signer_seeds: &[&[&[u8]]] = &[&[
                ESCROW_VAULT_SEED,
                message_id_bytes.as_ref(),
                &[message.vault_bump],
            ]];

            let cpi_context = CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.escrow_vault.to_account_info(),
                    to: ctx.accounts.recipient.to_account_info(),
                },
                signer_seeds,
            );
            transfer(cpi_context, escrow_amount)?;
        }

        let recipient_registry = &mut ctx.accounts.recipient_registry;
        recipient_registry.messages_received = recipient_registry.messages_received.checked_add(1)
            .ok_or(MermailError::MathOverflow)?;

        emit!(MessageClaimedEvent {
            message_id,
            recipient: ctx.accounts.recipient.key(),
            escrow_amount,
            response_hash,
            claimed_at: clock.unix_timestamp,
        });

        Ok(())
    }

    pub fn cancel_expired_message(
        ctx: Context<CancelExpiredMessage>,
        message_id: u64,
    ) -> Result<()> {
        let message = &mut ctx.accounts.message_receipt;
        let clock = Clock::get()?;

        require!(!message.claimed, MermailError::AlreadyClaimed);
        require!(!message.cancelled, MermailError::AlreadyCancelled);
        require!(clock.unix_timestamp > message.expires_at, MermailError::MessageNotExpired);
        require_keys_eq!(message.sender, ctx.accounts.sender.key(), MermailError::UnauthorizedSender);

        message.cancelled = true;

        let escrow_amount = message.escrow_amount;
        if escrow_amount > 0 {
            let message_id_bytes = message_id.to_le_bytes();
            let signer_seeds: &[&[&[u8]]] = &[&[
                ESCROW_VAULT_SEED,
                message_id_bytes.as_ref(),
                &[message.vault_bump],
            ]];

            let cpi_context = CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.escrow_vault.to_account_info(),
                    to: ctx.accounts.sender.to_account_info(),
                },
                signer_seeds,
            );
            transfer(cpi_context, escrow_amount)?;
        }

        emit!(MessageCancelledEvent {
            message_id,
            sender: ctx.accounts.sender.key(),
            escrow_refunded: escrow_amount,
            cancelled_at: clock.unix_timestamp,
        });

        Ok(())
    }
}

// -----------------------------------------------------------------------------
// ACCOUNT VALIDATION CONTEXTS
// -----------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(agent_name: String)]
pub struct InitializeAgent<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + AgentRegistry::INIT_SPACE,
        seeds = [AGENT_REGISTRY_SEED, authority.key().as_ref()],
        bump
    )]
    pub agent_registry: Account<'info, AgentRegistry>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(message_id: u64)]
pub struct SendMessageWithEscrow<'info> {
    #[account(
        init,
        payer = sender,
        space = 8 + MessageReceipt::INIT_SPACE,
        seeds = [MESSAGE_RECEIPT_SEED, message_id.to_le_bytes().as_ref()],
        bump
    )]
    pub message_receipt: Account<'info, MessageReceipt>,

    /// CHECK: PDA acting as the lamport vault for this message ID
    #[account(
        mut,
        seeds = [ESCROW_VAULT_SEED, message_id.to_le_bytes().as_ref()],
        bump
    )]
    pub escrow_vault: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [AGENT_REGISTRY_SEED, sender.key().as_ref()],
        bump = sender_registry.bump
    )]
    pub sender_registry: Account<'info, AgentRegistry>,

    #[account(mut)]
    pub sender: Signer<'info>,

    /// CHECK: Recipient wallet address
    pub recipient: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(message_id: u64)]
pub struct ClaimMessageEscrow<'info> {
    #[account(
        mut,
        seeds = [MESSAGE_RECEIPT_SEED, message_id.to_le_bytes().as_ref()],
        bump = message_receipt.bump
    )]
    pub message_receipt: Account<'info, MessageReceipt>,

    /// CHECK: PDA acting as the lamport vault
    #[account(
        mut,
        seeds = [ESCROW_VAULT_SEED, message_id.to_le_bytes().as_ref()],
        bump = message_receipt.vault_bump
    )]
    pub escrow_vault: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [AGENT_REGISTRY_SEED, recipient.key().as_ref()],
        bump = recipient_registry.bump
    )]
    pub recipient_registry: Account<'info, AgentRegistry>,

    #[account(mut)]
    pub recipient: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(message_id: u64)]
pub struct CancelExpiredMessage<'info> {
    #[account(
        mut,
        seeds = [MESSAGE_RECEIPT_SEED, message_id.to_le_bytes().as_ref()],
        bump = message_receipt.bump
    )]
    pub message_receipt: Account<'info, MessageReceipt>,

    /// CHECK: PDA acting as the lamport vault
    #[account(
        mut,
        seeds = [ESCROW_VAULT_SEED, message_id.to_le_bytes().as_ref()],
        bump = message_receipt.vault_bump
    )]
    pub escrow_vault: AccountInfo<'info>,

    #[account(mut)]
    pub sender: Signer<'info>,

    pub system_program: Program<'info, System>,
}

// -----------------------------------------------------------------------------
// STATE SCHEMAS
// -----------------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct AgentRegistry {
    pub authority: Pubkey,       // 32
    #[max_len(32)]
    pub agent_name: String,      // 4 + 32
    #[max_len(128)]
    pub metadata_uri: String,    // 4 + 128
    pub messages_sent: u64,      // 8
    pub messages_received: u64,  // 8
    pub registered_at: i64,      // 8
    pub bump: u8,                // 1
}

#[account]
#[derive(InitSpace)]
pub struct MessageReceipt {
    pub message_id: u64,         // 8
    pub sender: Pubkey,          // 32
    pub recipient: Pubkey,       // 32
    pub payload_hash: [u8; 32],  // 32
    pub escrow_amount: u64,      // 8
    pub created_at: i64,         // 8
    pub expires_at: i64,         // 8
    pub claimed: bool,           // 1
    pub cancelled: bool,         // 1
    pub vault_bump: u8,          // 1
    pub bump: u8,                // 1
}

// -----------------------------------------------------------------------------
// EVENTS & ERRORS
// -----------------------------------------------------------------------------

#[event]
pub struct AgentRegisteredEvent {
    pub authority: Pubkey,
    pub agent_name: String,
    pub timestamp: i64,
}

#[event]
pub struct MessageDispatchedEvent {
    pub message_id: u64,
    pub sender: Pubkey,
    pub recipient: Pubkey,
    pub payload_hash: [u8; 32],
    pub escrow_amount: u64,
    pub expires_at: i64,
}

#[event]
pub struct MessageClaimedEvent {
    pub message_id: u64,
    pub recipient: Pubkey,
    pub escrow_amount: u64,
    pub response_hash: [u8; 32],
    pub claimed_at: i64,
}

#[event]
pub struct MessageCancelledEvent {
    pub message_id: u64,
    pub sender: Pubkey,
    pub escrow_refunded: u64,
    pub cancelled_at: i64,
}

#[error_code]
pub enum MermailError {
    #[msg("Agent name exceeds maximum length of 32 characters.")]
    NameTooLong,
    #[msg("Metadata URI exceeds maximum length of 128 characters.")]
    UriTooLong,
    #[msg("Escrow expiry duration must be greater than 60 seconds.")]
    InvalidExpiryTime,
    #[msg("Arithmetic overflow detected.")]
    MathOverflow,
    #[msg("Message escrow has already been claimed.")]
    AlreadyClaimed,
    #[msg("Message has already been cancelled and refunded.")]
    AlreadyCancelled,
    #[msg("Message validity period has expired.")]
    MessageExpired,
    #[msg("Message has not yet passed its expiration timestamp.")]
    MessageNotExpired,
    #[msg("Signer is not authorized to claim this message.")]
    UnauthorizedRecipient,
    #[msg("Signer is not authorized to cancel this message.")]
    UnauthorizedSender,
}