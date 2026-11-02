use anchor_lang::prelude::*;
use anchor_lang::solana_program::system_program;

declare_id!("MermAiL111111111111111111111111111111111111");

pub const DISCRIMINATOR_LENGTH: usize = 8;
pub const PUBLIC_KEY_LENGTH: usize = 32;
pub const STRING_LENGTH_PREFIX: usize = 4;
pub const MAX_METADATA_LEN: usize = 128;
pub const HASH_LEN: usize = 32;

#[program]
pub mod mermail_core {
    use super::*;

    /// Initializes a dedicated on-chain Mailbox PDA for an AI Agent
    pub fn initialize_mailbox(
        ctx: Context<InitializeMailbox>,
        agent_id: String,
        spam_fee_lamports: u64,
    ) -> Result<()> {
        require!(
            agent_id.len() <= MAX_METADATA_LEN,
            MermailError::StringTooLong
        );

        let mailbox = &mut ctx.accounts.mailbox;
        mailbox.agent_authority = ctx.accounts.agent_authority.key();
        mailbox.treasury = ctx.accounts.treasury.key();
        mailbox.agent_id = agent_id;
        mailbox.spam_fee_lamports = spam_fee_lamports;
        mailbox.total_messages_received = 0;
        mailbox.total_fees_collected = 0;
        mailbox.is_active = true;
        mailbox.bump = ctx.bumps.mailbox;

        emit!(MailboxInitializedEvent {
            agent_authority: mailbox.agent_authority,
            mailbox: mailbox.key(),
            spam_fee_lamports,
        });

        Ok(())
    }

    /// Dispatches an authenticated message into the Agent's Mailbox with an anti-spam bond
    pub fn post_message(
        ctx: Context<PostMessage>,
        message_hash: [u8; HASH_LEN],
        reply_to_email: String,
        payload_uri: String,
    ) -> Result<()> {
        require!(
            reply_to_email.len() <= MAX_METADATA_LEN,
            MermailError::StringTooLong
        );
        require!(
            payload_uri.len() <= MAX_METADATA_LEN,
            MermailError::StringTooLong
        );

        let mailbox = &mut ctx.accounts.mailbox;
        require!(mailbox.is_active, MermailError::MailboxInactive);

        // Process anti-spam deposit to mailbox treasury
        let spam_fee = mailbox.spam_fee_lamports;
        if spam_fee > 0 {
            let cpi_context = CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.sender.to_account_info(),
                    to: ctx.accounts.treasury.to_account_info(),
                },
            );
            system_program::transfer(cpi_context, spam_fee)?;
            mailbox.total_fees_collected = mailbox
                .total_fees_collected
                .checked_add(spam_fee)
                .ok_or(MermailError::MathOverflow)?;
        }

        // Record immutable receipt
        let receipt = &mut ctx.accounts.message_receipt;
        receipt.mailbox = mailbox.key();
        receipt.sender = ctx.accounts.sender.key();
        receipt.message_hash = message_hash;
        receipt.reply_to_email = reply_to_email;
        receipt.payload_uri = payload_uri;
        receipt.status = MessageStatus::Pending;
        receipt.timestamp = Clock::get()?.unix_timestamp;
        receipt.bump = ctx.bumps.message_receipt;

        mailbox.total_messages_received = mailbox
            .total_messages_received
            .checked_add(1)
            .ok_or(MermailError::MathOverflow)?;

        emit!(MessagePostedEvent {
            mailbox: mailbox.key(),
            receipt: receipt.key(),
            sender: ctx.accounts.sender.key(),
            message_hash,
            timestamp: receipt.timestamp,
        });

        Ok(())
    }

    /// Agent processes and updates message status with an action signature hash
    pub fn resolve_message(
        ctx: Context<ResolveMessage>,
        new_status: MessageStatus,
        execution_proof: [u8; HASH_LEN],
    ) -> Result<()> {
        let receipt = &mut ctx.accounts.message_receipt;
        require!(
            receipt.status == MessageStatus::Pending,
            MermailError::MessageAlreadyProcessed
        );

        receipt.status = new_status;
        receipt.execution_proof = execution_proof;

        emit!(MessageResolvedEvent {
            receipt: receipt.key(),
            status: new_status,
            execution_proof,
        });

        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(agent_id: String)]
pub struct InitializeMailbox<'info> {
    #[account(
        init,
        payer = agent_authority,
        space = DISCRIMINATOR_LENGTH + Mailbox::LEN,
        seeds = [b"mailbox", agent_authority.key().as_ref(), agent_id.as_bytes()],
        bump
    )]
    pub mailbox: Account<'info, Mailbox>,

    #[account(mut)]
    pub agent_authority: Signer<'info>,

    /// CHECK: Safe recipient account for anti-spam bond accumulation
    pub treasury: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(message_hash: [u8; HASH_LEN])]
pub struct PostMessage<'info> {
    #[account(
        mut,
        seeds = [b"mailbox", mailbox.agent_authority.as_ref(), mailbox.agent_id.as_bytes()],
        bump = mailbox.bump,
    )]
    pub mailbox: Account<'info, Mailbox>,

    #[account(
        init,
        payer = sender,
        space = DISCRIMINATOR_LENGTH + MessageReceipt::LEN,
        seeds = [b"receipt", mailbox.key().as_ref(), message_hash.as_ref()],
        bump
    )]
    pub message_receipt: Account<'info, MessageReceipt>,

    #[account(mut)]
    pub sender: Signer<'info>,

    #[account(mut, address = mailbox.treasury @ MermailError::InvalidTreasury)]
    /// CHECK: Validated against mailbox.treasury
    pub treasury: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ResolveMessage<'info> {
    #[account(
        has_one = agent_authority @ MermailError::UnauthorizedAgent
    )]
    pub mailbox: Account<'info, Mailbox>,

    #[account(
        mut,
        seeds = [b"receipt", mailbox.key().as_ref(), message_receipt.message_hash.as_ref()],
        bump = message_receipt.bump,
    )]
    pub message_receipt: Account<'info, MessageReceipt>,

    pub agent_authority: Signer<'info>,
}

#[account]
pub struct Mailbox {
    pub agent_authority: Pubkey,         // 32
    pub treasury: Pubkey,                // 32
    pub spam_fee_lamports: u64,          // 8
    pub total_messages_received: u64,    // 8
    pub total_fees_collected: u64,       // 8
    pub is_active: bool,                 // 1
    pub bump: u8,                        // 1
    pub agent_id: String,                // 4 + 128
}

impl Mailbox {
    pub const LEN: usize = PUBLIC_KEY_LENGTH
        + PUBLIC_KEY_LENGTH
        + 8
        + 8
        + 8
        + 1
        + 1
        + STRING_LENGTH_PREFIX
        + MAX_METADATA_LEN;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum MessageStatus {
    Pending,
    ProcessedSuccess,
    ProcessedFailure,
    RejectedSpam,
}

#[account]
pub struct MessageReceipt {
    pub mailbox: Pubkey,                 // 32
    pub sender: Pubkey,                  // 32
    pub message_hash: [u8; 32],          // 32
    pub reply_to_email: String,          // 4 + 128
    pub payload_uri: String,             // 4 + 128
    pub status: MessageStatus,           // 1
    pub execution_proof: [u8; 32],       // 32
    pub timestamp: i64,                  // 8
    pub bump: u8,                        // 1
}

impl MessageReceipt {
    pub const LEN: usize = PUBLIC_KEY_LENGTH
        + PUBLIC_KEY_LENGTH
        + 32
        + STRING_LENGTH_PREFIX
        + MAX_METADATA_LEN
        + STRING_LENGTH_PREFIX
        + MAX_METADATA_LEN
        + 1
        + 32
        + 8
        + 1;
}

#[event]
pub struct MailboxInitializedEvent {
    pub agent_authority: Pubkey,
    pub mailbox: Pubkey,
    pub spam_fee_lamports: u64,
}

#[event]
pub struct MessagePostedEvent {
    pub mailbox: Pubkey,
    pub receipt: Pubkey,
    pub sender: Pubkey,
    pub message_hash: [u8; 32],
    pub timestamp: i64,
}

#[event]
pub struct MessageResolvedEvent {
    pub receipt: Pubkey,
    pub status: MessageStatus,
    pub execution_proof: [u8; 32],
}

#[error_code]
pub enum MermailError {
    #[msg("String exceeds maximum allowable buffer length.")]
    StringTooLong,
    #[msg("Target Mailbox is currently marked inactive.")]
    MailboxInactive,
    #[msg("Integer arithmetic overflow encountered.")]
    MathOverflow,
    #[msg("Target treasury does not match configured Mailbox treasury.")]
    InvalidTreasury,
    #[msg("Signer is not authorized to act on behalf of this Agent.")]
    UnauthorizedAgent,
    #[msg("The specified message receipt has already been processed.")]
    MessageAlreadyProcessed,
}