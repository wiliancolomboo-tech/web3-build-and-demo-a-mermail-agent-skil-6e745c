use anchor_lang::prelude::*;

declare_id!("MermAiL111111111111111111111111111111111111");

pub const MAX_EMAIL_LEN: usize = 128;
pub const MAX_TOPIC_LEN: usize = 64;
pub const DISCRIMINATOR_LENGTH: usize = 8;

#[program]
pub mod mermail_core {
    use super::*;

    /// Initialize a new on-chain Mailbox for an AI Agent
    pub fn initialize_mailbox(
        ctx: Context<InitializeMailbox>,
        agent_email: String,
        inbound_fee_lamports: u64,
    ) -> Result<()> {
        require!(
            agent_email.len() <= MAX_EMAIL_LEN,
            MermailError::EmailTooLong
        );

        let mailbox = &mut ctx.accounts.mailbox;
        mailbox.authority = ctx.accounts.authority.key();
        mailbox.agent_email = agent_email;
        mailbox.inbound_fee_lamports = inbound_fee_lamports;
        mailbox.attestation_count = 0;
        mailbox.is_active = true;
        mailbox.bump = ctx.bumps.mailbox;

        emit!(MailboxInitializedEvent {
            mailbox: mailbox.key(),
            authority: mailbox.authority,
            agent_email: mailbox.agent_email.clone(),
            fee: inbound_fee_lamports,
        });

        Ok(())
    }

    /// Attest an outbound or processed inbound message hash for deterministic auditability
    pub fn record_attestation(
        ctx: Context<RecordAttestation>,
        message_id: String,
        recipient_or_sender: String,
        payload_sha256: [u8; 32],
        is_outbound: bool,
    ) -> Result<()> {
        require!(
            recipient_or_sender.len() <= MAX_EMAIL_LEN,
            MermailError::EmailTooLong
        );
        require!(
            message_id.len() <= MAX_TOPIC_LEN,
            MermailError::IdentifierTooLong
        );

        let mailbox = &mut ctx.accounts.mailbox;
        require!(mailbox.is_active, MermailError::MailboxInactive);

        let attestation = &mut ctx.accounts.attestation;
        let clock = Clock::get()?;

        attestation.mailbox = mailbox.key();
        attestation.message_id = message_id.clone();
        attestation.counterparty = recipient_or_sender.clone();
        attestation.payload_sha256 = payload_sha256;
        attestation.is_outbound = is_outbound;
        attestation.slot = clock.slot;
        attestation.unix_timestamp = clock.unix_timestamp;
        attestation.bump = ctx.bumps.attestation;

        mailbox.attestation_count = mailbox.attestation_count.checked_add(1).ok_or(MermailError::MathOverflow)?;

        emit!(AttestationRecordedEvent {
            mailbox: mailbox.key(),
            attestation: attestation.key(),
            message_id,
            counterparty: recipient_or_sender,
            payload_sha256,
            is_outbound,
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }

    /// Pay spam-prevention deposit to communicate with an agent
    pub fn deposit_contact_escrow(
        ctx: Context<DepositContactEscrow>,
        sender_email: String,
        amount: u64,
    ) -> Result<()> {
        let mailbox = &ctx.accounts.mailbox;
        require!(mailbox.is_active, MermailError::MailboxInactive);
        require!(
            amount >= mailbox.inbound_fee_lamports,
            MermailError::InsufficientFee
        );

        let ix = anchor_lang::solana_program::system_instruction::transfer(
            &ctx.accounts.payer.key(),
            &ctx.accounts.mailbox.key(),
            amount,
        );
        anchor_lang::solana_program::program::invoke(
            &ix,
            &[
                ctx.accounts.payer.to_account_info(),
                ctx.accounts.mailbox.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;

        emit!(ContactFeeDepositedEvent {
            mailbox: mailbox.key(),
            payer: ctx.accounts.payer.key(),
            sender_email,
            amount,
        });

        Ok(())
    }

    /// Update mailbox routing configuration and fee structure
    pub fn update_mailbox_settings(
        ctx: Context<UpdateMailbox>,
        inbound_fee_lamports: u64,
        is_active: bool,
    ) -> Result<()> {
        let mailbox = &mut ctx.accounts.mailbox;
        mailbox.inbound_fee_lamports = inbound_fee_lamports;
        mailbox.is_active = is_active;
        Ok(())
    }
}

// -----------------------------------------------------------------------------
// ACCOUNT STRUCTURES & VALIDATIONS
// -----------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(agent_email: String)]
pub struct InitializeMailbox<'info> {
    #[account(
        init,
        payer = authority,
        space = DISCRIMINATOR_LENGTH + MailboxState::INIT_SPACE,
        seeds = [b"mermail_box", authority.key().as_ref()],
        bump
    )]
    pub mailbox: Account<'info, MailboxState>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(message_id: String)]
pub struct RecordAttestation<'info> {
    #[account(
        mut,
        has_one = authority @ MermailError::Unauthorized
    )]
    pub mailbox: Account<'info, MailboxState>,

    #[account(
        init,
        payer = authority,
        space = DISCRIMINATOR_LENGTH + AttestationRecord::INIT_SPACE,
        seeds = [
            b"mermail_attest",
            mailbox.key().as_ref(),
            message_id.as_bytes()
        ],
        bump
    )]
    pub attestation: Account<'info, AttestationRecord>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DepositContactEscrow<'info> {
    #[account(mut)]
    pub mailbox: Account<'info, MailboxState>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateMailbox<'info> {
    #[account(
        mut,
        has_one = authority @ MermailError::Unauthorized
    )]
    pub mailbox: Account<'info, MailboxState>,

    pub authority: Signer<'info>,
}

// -----------------------------------------------------------------------------
// STATE DEFINITIONS
// -----------------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct MailboxState {
    pub authority: Pubkey,
    #[max_len(128)]
    pub agent_email: String,
    pub inbound_fee_lamports: u64,
    pub attestation_count: u64,
    pub is_active: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct AttestationRecord {
    pub mailbox: Pubkey,
    #[max_len(64)]
    pub message_id: String,
    #[max_len(128)]
    pub counterparty: String,
    pub payload_sha256: [u8; 32],
    pub is_outbound: bool,
    pub slot: u64,
    pub unix_timestamp: i64,
    pub bump: u8,
}

// -----------------------------------------------------------------------------
// EVENTS & ERRORS
// -----------------------------------------------------------------------------

#[event]
pub struct MailboxInitializedEvent {
    pub mailbox: Pubkey,
    pub authority: Pubkey,
    pub agent_email: String,
    pub fee: u64,
}

#[event]
pub struct AttestationRecordedEvent {
    pub mailbox: Pubkey,
    pub attestation: Pubkey,
    pub message_id: String,
    pub counterparty: String,
    pub payload_sha256: [u8; 32],
    pub is_outbound: bool,
    pub timestamp: i64,
}

#[event]
pub struct ContactFeeDepositedEvent {
    pub mailbox: Pubkey,
    pub payer: Pubkey,
    pub sender_email: String,
    pub amount: u64,
}

#[error_code]
pub enum MermailError {
    #[msg("Email parameter exceeds allowed length.")]
    EmailTooLong,
    #[msg("Message identifier exceeds maximum allowed length.")]
    IdentifierTooLong,
    #[msg("The specified Mailbox is currently deactivated.")]
    MailboxInactive,
    #[msg("Provided contact fee does not satisfy minimum mailbox threshold.")]
    InsufficientFee,
    #[msg("Caller lacks required cryptographic authority.")]
    Unauthorized,
    #[msg("Numeric operation caused an overflow.")]
    MathOverflow,
}