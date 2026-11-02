use anchor_lang::prelude::*;

declare_id!("MerM111111111111111111111111111111111111111");

pub const MAX_SUBJECT_LEN: usize = 128;
pub const MAX_RECIPIENT_LEN: usize = 128;
pub const DISPATCH_SEED_PREFIX: &[u8] = b"mermail_dispatch";
pub const AGENT_REGISTRY_SEED_PREFIX: &[u8] = b"mermail_agent";

#[program]
pub mod mermail_skill {
    use super::*;

    /// Registers an AI agent into the Mermail protocol.
    pub fn initialize_agent(
        ctx: Context<InitializeAgent>,
        name: String,
        metadata_uri: String,
    ) -> Result<()> {
        require!(name.len() <= 64, MermailError::StringTooLong);
        require!(metadata_uri.len() <= 200, MermailError::StringTooLong);

        let agent = &mut ctx.accounts.agent_registry;
        agent.authority = ctx.accounts.authority.key();
        agent.name = name;
        agent.metadata_uri = metadata_uri;
        agent.total_dispatches = 0;
        agent.created_at = Clock::get()?.unix_timestamp;
        agent.bump = ctx.bumps.agent_registry;

        emit!(AgentRegistered {
            authority: agent.authority,
            name: agent.name.clone(),
            timestamp: agent.created_at,
        });

        Ok(())
    }

    /// Dispatches an actionable email record with cryptographic hash commitment.
    /// Can optionally hold Lamports in escrow until recipient confirms via acknowledge_mail.
    pub fn dispatch_mail(
        ctx: Context<DispatchMail>,
        recipient_email_hash: [u8; 32],
        payload_hash: [u8; 32],
        subject: String,
        escrow_amount: u64,
    ) -> Result<()> {
        require!(subject.len() <= MAX_SUBJECT_LEN, MermailError::StringTooLong);
        
        let agent = &mut ctx.accounts.agent_registry;
        let dispatch = &mut ctx.accounts.mail_dispatch;
        let clock = Clock::get()?;

        dispatch.agent = agent.key();
        dispatch.authority = ctx.accounts.authority.key();
        dispatch.recipient_email_hash = recipient_email_hash;
        dispatch.payload_hash = payload_hash;
        dispatch.subject = subject.clone();
        dispatch.escrow_amount = escrow_amount;
        dispatch.status = MailStatus::Dispatched;
        dispatch.dispatched_at = clock.unix_timestamp;
        dispatch.acknowledged_at = 0;
        dispatch.nonce = agent.total_dispatches;
        dispatch.bump = ctx.bumps.mail_dispatch;

        // If escrow requested, transfer lamports from agent authority to dispatch PDA
        if escrow_amount > 0 {
            let ix = solana_program::system_instruction::transfer(
                &ctx.accounts.authority.key(),
                &dispatch.key(),
                escrow_amount,
            );
            solana_program::program::invoke(
                &ix,
                &[
                    ctx.accounts.authority.to_account_info(),
                    dispatch.to_account_info(),
                    ctx.accounts.system_program.to_account_info(),
                ],
            )?;
        }

        // Increment monotonically
        agent.total_dispatches = agent.total_dispatches.checked_add(1).ok_or(MermailError::Overflow)?;

        emit!(MailDispatched {
            dispatch_pda: dispatch.key(),
            agent: agent.key(),
            authority: ctx.accounts.authority.key(),
            recipient_email_hash,
            payload_hash,
            escrow_amount,
            nonce: dispatch.nonce,
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }

    /// Recipient or designated executor acknowledges receipt on-chain, unlocking escrow.
    pub fn acknowledge_mail(
        ctx: Context<AcknowledgeMail>,
        receipt_proof: [u8; 32],
    ) -> Result<()> {
        let dispatch = &mut ctx.accounts.mail_dispatch;
        require!(dispatch.status == MailStatus::Dispatched, MermailError::InvalidMailStatus);

        let clock = Clock::get()?;
        dispatch.status = MailStatus::Acknowledged;
        dispatch.acknowledged_at = clock.unix_timestamp;

        // Release escrow if lamports exist
        if dispatch.escrow_amount > 0 {
            let escrow_balance = dispatch.to_account_info().lamports();
            require!(escrow_balance >= dispatch.escrow_amount, MermailError::InsufficientEscrow);

            **dispatch.to_account_info().try_borrow_mut_lamports()? -= dispatch.escrow_amount;
            **ctx.accounts.claimant.try_borrow_mut_lamports()? += dispatch.escrow_amount;
        }

        emit!(MailAcknowledged {
            dispatch_pda: dispatch.key(),
            claimant: ctx.accounts.claimant.key(),
            receipt_proof,
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }

    /// Agent authority can cancel and reclaim escrow if recipient failed to acknowledge within timeout (e.g. 7 days).
    pub fn cancel_expired_mail(
        ctx: Context<CancelExpiredMail>,
        timeout_seconds: i64,
    ) -> Result<()> {
        require!(timeout_seconds >= 86400, MermailError::TimeoutTooShort); // Min 24 hours
        let dispatch = &mut ctx.accounts.mail_dispatch;
        let clock = Clock::get()?;

        require!(dispatch.status == MailStatus::Dispatched, MermailError::InvalidMailStatus);
        require!(
            clock.unix_timestamp >= dispatch.dispatched_at + timeout_seconds,
            MermailError::TimeoutNotElapsed
        );

        dispatch.status = MailStatus::Cancelled;

        if dispatch.escrow_amount > 0 {
            let lamports_to_refund = dispatch.escrow_amount;
            dispatch.escrow_amount = 0;

            **dispatch.to_account_info().try_borrow_mut_lamports()? -= lamports_to_refund;
            **ctx.accounts.authority.try_borrow_mut_lamports()? += lamports_to_refund;
        }

        emit!(MailCancelled {
            dispatch_pda: dispatch.key(),
            authority: ctx.accounts.authority.key(),
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitializeAgent<'info> {
    #[account(
        init,
        payer = authority,
        space = AgentRegistry::LEN,
        seeds = [AGENT_REGISTRY_SEED_PREFIX, authority.key().as_ref()],
        bump
    )]
    pub agent_registry: Account<'info, AgentRegistry>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DispatchMail<'info> {
    #[account(
        mut,
        seeds = [AGENT_REGISTRY_SEED_PREFIX, authority.key().as_ref()],
        bump = agent_registry.bump,
        has_one = authority,
    )]
    pub agent_registry: Account<'info, AgentRegistry>,
    #[account(
        init,
        payer = authority,
        space = MailDispatch::LEN,
        seeds = [
            DISPATCH_SEED_PREFIX,
            agent_registry.key().as_ref(),
            &agent_registry.total_dispatches.to_le_bytes()
        ],
        bump
    )]
    pub mail_dispatch: Account<'info, MailDispatch>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AcknowledgeMail<'info> {
    #[account(
        mut,
        seeds = [
            DISPATCH_SEED_PREFIX,
            mail_dispatch.agent.as_ref(),
            &mail_dispatch.nonce.to_le_bytes()
        ],
        bump = mail_dispatch.bump
    )]
    pub mail_dispatch: Account<'info, MailDispatch>,
    #[account(mut)]
    pub claimant: Signer<'info>,
}

#[derive(Accounts)]
pub struct CancelExpiredMail<'info> {
    #[account(
        mut,
        seeds = [
            DISPATCH_SEED_PREFIX,
            mail_dispatch.agent.as_ref(),
            &mail_dispatch.nonce.to_le_bytes()
        ],
        bump = mail_dispatch.bump,
        has_one = authority
    )]
    pub mail_dispatch: Account<'info, MailDispatch>,
    #[account(mut)]
    pub authority: Signer<'info>,
}

#[account]
pub struct AgentRegistry {
    pub authority: Pubkey,
    pub name: String,
    pub metadata_uri: String,
    pub total_dispatches: u64,
    pub created_at: i64,
    pub bump: u8,
}

impl AgentRegistry {
    pub const LEN: usize = 8 + 32 + (4 + 64) + (4 + 200) + 8 + 8 + 1;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum MailStatus {
    Dispatched,
    Acknowledged,
    Cancelled,
}

#[account]
pub struct MailDispatch {
    pub agent: Pubkey,
    pub authority: Pubkey,
    pub recipient_email_hash: [u8; 32],
    pub payload_hash: [u8; 32],
    pub subject: String,
    pub escrow_amount: u64,
    pub status: MailStatus,
    pub dispatched_at: i64,
    pub acknowledged_at: i64,
    pub nonce: u64,
    pub bump: u8,
}

impl MailDispatch {
    pub const LEN: usize = 8 + 32 + 32 + 32 + 32 + (4 + MAX_SUBJECT_LEN) + 8 + 1 + 8 + 8 + 8 + 1;
}

#[event]
pub struct AgentRegistered {
    pub authority: Pubkey,
    pub name: String,
    pub timestamp: i64,
}

#[event]
pub struct MailDispatched {
    pub dispatch_pda: Pubkey,
    pub agent: Pubkey,
    pub authority: Pubkey,
    pub recipient_email_hash: [u8; 32],
    pub payload_hash: [u8; 32],
    pub escrow_amount: u64,
    pub nonce: u64,
    pub timestamp: i64,
}

#[event]
pub struct MailAcknowledged {
    pub dispatch_pda: Pubkey,
    pub claimant: Pubkey,
    pub receipt_proof: [u8; 32],
    pub timestamp: i64,
}

#[event]
pub struct MailCancelled {
    pub dispatch_pda: Pubkey,
    pub authority: Pubkey,
    pub timestamp: i64,
}

#[error_code]
pub enum MermailError {
    #[msg("String provided exceeds maximum permitted length")]
    StringTooLong,
    #[msg("Arithmetic overflow occurred")]
    Overflow,
    #[msg("Mail dispatch is not in valid status for this operation")]
    InvalidMailStatus,
    #[msg("Insufficient lamports in dispatch account for escrow release")]
    InsufficientEscrow,
    #[msg("Timeout duration is too short (minimum 86400 seconds)")]
    TimeoutTooShort,
    #[msg("Timeout period has not yet elapsed for mail cancellation")]
    TimeoutNotElapsed,
}