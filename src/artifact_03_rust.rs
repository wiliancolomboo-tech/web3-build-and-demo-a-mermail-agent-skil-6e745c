use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};

declare_id!("MermAiL111111111111111111111111111111111111");

pub const MAX_METADATA_URI_LEN: usize = 96;

#[program]
pub mod mermail_core {
    use super::*;

    /// Initializes a mailbox for an autonomous agent or wallet.
    pub fn initialize_mailbox(ctx: Context<InitializeMailbox>) -> Result<()> {
        let mailbox = &mut ctx.accounts.mailbox;
        mailbox.authority = ctx.accounts.authority.key();
        mailbox.message_count = 0;
        mailbox.unread_count = 0;
        mailbox.bump = ctx.bumps.mailbox;
        emit!(MailboxInitializedEvent {
            authority: mailbox.authority,
            mailbox: mailbox.key(),
        });
        Ok(())
    }

    /// Dispatches an action message to a recipient's mailbox, locking an optional bounty escrow.
    pub fn send_message(
        ctx: Context<SendMessage>,
        action_payload_hash: [u8; 32],
        metadata_uri: String,
        bounty_amount: u64,
        deadline_slot: u64,
    ) -> Result<()> {
        require!(
            metadata_uri.len() <= MAX_METADATA_URI_LEN,
            MermailError::UriTooLong
        );
        require!(
            deadline_slot > Clock::get()?.slot,
            MermailError::InvalidDeadline
        );

        // Escrow funds if a bounty is attached
        if bounty_amount > 0 {
            let cpi_context = CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.sender.to_account_info(),
                    to: ctx.accounts.message.to_account_info(),
                },
            );
            transfer(cpi_context, bounty_amount)?;
        }

        let mailbox = &mut ctx.accounts.recipient_mailbox;
        let message = &mut ctx.accounts.message;

        message.sender = ctx.accounts.sender.key();
        message.recipient_mailbox = mailbox.key();
        message.action_payload_hash = action_payload_hash;
        message.metadata_uri = metadata_uri.clone();
        message.bounty_amount = bounty_amount;
        message.deadline_slot = deadline_slot;
        message.sequence_number = mailbox.message_count;
        message.status = MessageStatus::Pending;
        message.bump = ctx.bumps.message;

        mailbox.message_count = mailbox.message_count.checked_add(1).ok_or(MermailError::NumericalOverflow)?;
        mailbox.unread_count = mailbox.unread_count.checked_add(1).ok_or(MermailError::NumericalOverflow)?;

        emit!(MessageDispatchedEvent {
            sender: message.sender,
            recipient_mailbox: mailbox.key(),
            sequence_number: message.sequence_number,
            action_payload_hash,
            bounty_amount,
            deadline_slot,
            metadata_uri,
        });

        Ok(())
    }

    /// Executes the pending message, verifies payload integrity, transfers bounty, and reclaims rent.
    pub fn execute_action(
        ctx: Context<ExecuteAction>,
        revealed_payload: Vec<u8>,
    ) -> Result<()> {
        let message = &mut ctx.accounts.message;
        let current_slot = Clock::get()?.slot;

        require!(
            message.status == MessageStatus::Pending,
            MermailError::MessageAlreadySettled
        );
        require!(
            current_slot <= message.deadline_slot,
            MermailError::MessageExpired
        );

        // Verify that hash(revealed_payload) matches the on-chain action_payload_hash
        let calculated_hash = anchor_lang::solana_program::hash::hash(&revealed_payload).to_bytes();
        require!(
            calculated_hash == message.action_payload_hash,
            MermailError::PayloadHashMismatch
        );

        message.status = MessageStatus::Executed;

        let mailbox = &mut ctx.accounts.recipient_mailbox;
        mailbox.unread_count = mailbox.unread_count.saturating_sub(1);

        // Release bounty lamports to executor
        let bounty = message.bounty_amount;
        if bounty > 0 {
            **message.to_account_info().try_borrow_mut_lamports()? = message
                .to_account_info()
                .lamports()
                .checked_sub(bounty)
                .ok_or(MermailError::InsufficientFunds)?;
            **ctx.accounts.executor.to_account_info().try_borrow_mut_lamports()? = ctx
                .accounts.executor
                .to_account_info()
                .lamports()
                .checked_add(bounty)
                .ok_or(MermailError::NumericalOverflow)?;
        }

        emit!(ActionExecutedEvent {
            message: message.key(),
            executor: ctx.accounts.executor.key(),
            bounty_awarded: bounty,
            slot: current_slot,
        });

        Ok(())
    }

    /// Cancels an expired message, returning the escrowed bounty to the original sender.
    pub fn cancel_expired_message(ctx: Context<CancelExpiredMessage>) -> Result<()> {
        let message = &mut ctx.accounts.message;
        let current_slot = Clock::get()?.slot;

        require!(
            message.status == MessageStatus::Pending,
            MermailError::MessageAlreadySettled
        );
        require!(
            current_slot > message.deadline_slot,
            MermailError::DeadlineNotReached
        );

        message.status = MessageStatus::Cancelled;

        let mailbox = &mut ctx.accounts.recipient_mailbox;
        mailbox.unread_count = mailbox.unread_count.saturating_sub(1);

        // Refund bounty back to sender
        let bounty = message.bounty_amount;
        if bounty > 0 {
            **message.to_account_info().try_borrow_mut_lamports()? = message
                .to_account_info()
                .lamports()
                .checked_sub(bounty)
                .ok_or(MermailError::InsufficientFunds)?;
            **ctx.accounts.sender.to_account_info().try_borrow_mut_lamports()? = ctx
                .accounts.sender
                .to_account_info()
                .lamports()
                .checked_add(bounty)
                .ok_or(MermailError::NumericalOverflow)?;
        }

        emit!(MessageCancelledEvent {
            message: message.key(),
            refund_destination: ctx.accounts.sender.key(),
            amount: bounty,
        });

        Ok(())
    }
}

// -----------------------------------------------------------------------------
// ACCOUNT VALIDATION STRUCTS
// -----------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitializeMailbox<'info> {
    #[account(
        init,
        payer = authority,
        space = Mailbox::LEN,
        seeds = [b"mailbox", authority.key().as_ref()],
        bump
    )]
    pub mailbox: Account<'info, Mailbox>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SendMessage<'info> {
    #[account(
        mut,
        seeds = [b"mailbox", recipient_mailbox.authority.as_ref()],
        bump = recipient_mailbox.bump
    )]
    pub recipient_mailbox: Account<'info, Mailbox>,

    #[account(
        init,
        payer = sender,
        space = Message::LEN,
        seeds = [
            b"message",
            recipient_mailbox.key().as_ref(),
            recipient_mailbox.message_count.to_le_bytes().as_ref()
        ],
        bump
    )]
    pub message: Account<'info, Message>,

    #[account(mut)]
    pub sender: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ExecuteAction<'info> {
    #[account(
        mut,
        seeds = [b"mailbox", recipient_mailbox.authority.as_ref()],
        bump = recipient_mailbox.bump,
        has_one = authority @ MermailError::UnauthorizedMailboxAuthority
    )]
    pub recipient_mailbox: Account<'info, Mailbox>,

    #[account(
        mut,
        seeds = [
            b"message",
            recipient_mailbox.key().as_ref(),
            message.sequence_number.to_le_bytes().as_ref()
        ],
        bump = message.bump,
        has_one = recipient_mailbox @ MermailError::InvalidMessageMailbox
    )]
    pub message: Account<'info, Message>,

    /// The recipient agent authority executing this action
    pub authority: Signer<'info>,

    /// Account receiving the escrowed bounty
    #[account(mut)]
    pub executor: SystemAccount<'info>,
}

#[derive(Accounts)]
pub struct CancelExpiredMessage<'info> {
    #[account(
        mut,
        seeds = [b"mailbox", recipient_mailbox.authority.as_ref()],
        bump = recipient_mailbox.bump
    )]
    pub recipient_mailbox: Account<'info, Mailbox>,

    #[account(
        mut,
        seeds = [
            b"message",
            recipient_mailbox.key().as_ref(),
            message.sequence_number.to_le_bytes().as_ref()
        ],
        bump = message.bump,
        has_one = recipient_mailbox @ MermailError::InvalidMessageMailbox,
        has_one = sender @ MermailError::InvalidSenderRefundAddress
    )]
    pub message: Account<'info, Message>,

    /// The original sender reclaiming funds
    #[account(mut)]
    pub sender: Signer<'info>,
}

// -----------------------------------------------------------------------------
// STATE STRUCTS
// -----------------------------------------------------------------------------

#[account]
pub struct Mailbox {
    pub authority: Pubkey,   // 32
    pub message_count: u64,  // 8
    pub unread_count: u64,   // 8
    pub bump: u8,            // 1
}

impl Mailbox {
    pub const LEN: usize = 8 + 32 + 8 + 8 + 1;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum MessageStatus {
    Pending,
    Executed,
    Cancelled,
}

#[account]
pub struct Message {
    pub sender: Pubkey,                  // 32
    pub recipient_mailbox: Pubkey,       // 32
    pub action_payload_hash: [u8; 32],   // 32
    pub metadata_uri: String,            // 4 + 96
    pub bounty_amount: u64,              // 8
    pub deadline_slot: u64,              // 8
    pub sequence_number: u64,            // 8
    pub status: MessageStatus,           // 1
    pub bump: u8,                        // 1
}

impl Message {
    pub const LEN: usize = 8 + 32 + 32 + 32 + (4 + MAX_METADATA_URI_LEN) + 8 + 8 + 8 + 1 + 1;
}

// -----------------------------------------------------------------------------
// EVENTS & ERRORS
// -----------------------------------------------------------------------------

#[event]
pub struct MailboxInitializedEvent {
    pub authority: Pubkey,
    pub mailbox: Pubkey,
}

#[event]
pub struct MessageDispatchedEvent {
    pub sender: Pubkey,
    pub recipient_mailbox: Pubkey,
    pub sequence_number: u64,
    pub action_payload_hash: [u8; 32],
    pub bounty_amount: u64,
    pub deadline_slot: u64,
    pub metadata_uri: String,
}

#[event]
pub struct ActionExecutedEvent {
    pub message: Pubkey,
    pub executor: Pubkey,
    pub bounty_awarded: u64,
    pub slot: u64,
}

#[event]
pub struct MessageCancelledEvent {
    pub message: Pubkey,
    pub refund_destination: Pubkey,
    pub amount: u64,
}

#[error_code]
pub enum MermailError {
    #[msg("Metadata URI exceeds maximum limit of 96 bytes")]
    UriTooLong,
    #[msg("Deadline must be strictly greater than the current slot")]
    InvalidDeadline,
    #[msg("Arithmetic overflow")]
    NumericalOverflow,
    #[msg("Message already settled or cancelled")]
    MessageAlreadySettled,
    #[msg("Message execution deadline exceeded")]
    MessageExpired,
    #[msg("Supplied payload hash does not match expected commitment")]
    PayloadHashMismatch,
    #[msg("Unauthorized mailbox authority")]
    UnauthorizedMailboxAuthority,
    #[msg("Message is not associated with this mailbox")]
    InvalidMessageMailbox,
    #[msg("Invalid sender address for refund")]
    InvalidSenderRefundAddress,
    #[msg("Message has not yet passed its expiration deadline")]
    DeadlineNotReached,
    #[msg("Insufficient escrow funds")]
    InsufficientFunds,
}