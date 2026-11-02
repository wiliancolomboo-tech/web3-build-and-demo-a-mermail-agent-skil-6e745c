use anchor_lang::prelude::*;
use anchor_lang::solana_program::system_program;

declare_id!("MermAiL111111111111111111111111111111111111");

#[program]
pub mod mermail_agent_gate {
    use super::*;

    pub fn initialize_mailbox(
        ctx: Context<InitializeMailbox>,
        spam_threshold_lamports: u64,
        allow_unsolicited: bool,
    ) -> Result<()> {
        let mailbox = &mut ctx.accounts.mailbox;
        mailbox.agent = ctx.accounts.agent.key();
        mailbox.spam_threshold_lamports = spam_threshold_lamports;
        mailbox.allow_unsolicited = allow_unsolicited;
        mailbox.message_count = 0;
        mailbox.bump = ctx.bumps.mailbox;

        emit!(MailboxInitializedEvent {
            agent: mailbox.agent,
            spam_threshold_lamports,
            allow_unsolicited,
        });

        Ok(())
    }

    pub fn dispatch_message(
        ctx: Context<DispatchMessage>,
        message_id: [u8; 16],
        payload_hash: [u8; 32],
        staked_lamports: u64,
    ) -> Result<()> {
        let mailbox = &mut ctx.accounts.mailbox;
        let sender = &ctx.accounts.sender;

        require!(
            mailbox.allow_unsolicited || staked_lamports >= mailbox.spam_threshold_lamports,
            MermailError::SpamThresholdNotMet
        );

        if staked_lamports > 0 {
            let cpi_context = CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: sender.to_account_info(),
                    to: ctx.accounts.escrow_vault.to_account_info(),
                },
            );
            system_program::transfer(cpi_context, staked_lamports)?;
        }

        let message_record = &mut ctx.accounts.message_record;
        message_record.message_id = message_id;
        message_record.sender = sender.key();
        message_record.agent = mailbox.agent;
        message_record.payload_hash = payload_hash;
        message_record.staked_lamports = staked_lamports;
        message_record.settled = false;
        message_record.created_at = Clock::get()?.unix_timestamp;
        message_record.bump = ctx.bumps.message_record;

        mailbox.message_count = mailbox.message_count.checked_add(1).ok_or(MermailError::ArithmeticOverflow)?;

        emit!(MessageDispatchedEvent {
            message_id,
            sender: sender.key(),
            agent: mailbox.agent,
            payload_hash,
            staked_lamports,
        });

        Ok(())
    }

    pub fn acknowledge_message(
        ctx: Context<AcknowledgeMessage>,
        slash: bool,
    ) -> Result<()> {
        let message_record = &mut ctx.accounts.message_record;
        require!(!message_record.settled, MermailError::AlreadySettled);

        let staked_amount = message_record.staked_lamports;
        message_record.settled = true;

        if staked_amount > 0 {
            let mailbox_key = ctx.accounts.mailbox.key();
            let bump = ctx.accounts.mailbox.bump;
            let signer_seeds: &[&[&[u8]]] = &[&[
                b"mailbox",
                ctx.accounts.agent.key.as_ref(),
                &[bump],
            ]];

            if slash {
                // Slash: funds transfer to agent as spam restitution fee
                let cpi_context = CpiContext::new_with_signer(
                    ctx.accounts.system_program.to_account_info(),
                    system_program::Transfer {
                        from: ctx.accounts.escrow_vault.to_account_info(),
                        to: ctx.accounts.agent.to_account_info(),
                    },
                    signer_seeds,
                );
                system_program::transfer(cpi_context, staked_amount)?;
            } else {
                // Legitimate: refund sender their stake
                let cpi_context = CpiContext::new_with_signer(
                    ctx.accounts.system_program.to_account_info(),
                    system_program::Transfer {
                        from: ctx.accounts.escrow_vault.to_account_info(),
                        to: ctx.accounts.sender_target.to_account_info(),
                    },
                    signer_seeds,
                );
                system_program::transfer(cpi_context, staked_amount)?;
            }
        }

        emit!(MessageAcknowledgedEvent {
            message_id: message_record.message_id,
            slashed: slash,
            staked_lamports: staked_amount,
        });

        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitializeMailbox<'info> {
    #[account(
        init,
        payer = agent,
        space = 8 + Mailbox::LEN,
        seeds = [b"mailbox", agent.key().as_ref()],
        bump
    )]
    pub mailbox: Account<'info, Mailbox>,
    #[account(mut)]
    pub agent: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(message_id: [u8; 16])]
pub struct DispatchMessage<'info> {
    #[account(
        mut,
        seeds = [b"mailbox", mailbox.agent.as_ref()],
        bump = mailbox.bump
    )]
    pub mailbox: Account<'info, Mailbox>,
    #[account(
        init,
        payer = sender,
        space = 8 + MessageRecord::LEN,
        seeds = [b"message", mailbox.key().as_ref(), &message_id],
        bump
    )]
    pub message_record: Account<'info, MessageRecord>,
    #[account(
        mut,
        seeds = [b"vault", mailbox.key().as_ref()],
        bump
    )]
    /// CHECK: Native lamport escrow vault seeded by mailbox PDA
    pub escrow_vault: AccountInfo<'info>,
    #[account(mut)]
    pub sender: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AcknowledgeMessage<'info> {
    #[account(
        mut,
        seeds = [b"mailbox", agent.key().as_ref()],
        bump = mailbox.bump,
        has_one = agent
    )]
    pub mailbox: Account<'info, Mailbox>,
    #[account(
        mut,
        seeds = [b"message", mailbox.key().as_ref(), &message_record.message_id],
        bump = message_record.bump,
        has_one = agent,
    )]
    pub message_record: Account<'info, MessageRecord>,
    #[account(
        mut,
        seeds = [b"vault", mailbox.key().as_ref()],
        bump
    )]
    /// CHECK: Native lamport escrow vault
    pub escrow_vault: AccountInfo<'info>,
    pub agent: Signer<'info>,
    #[account(mut, address = message_record.sender)]
    /// CHECK: Validated against message_record.sender address
    pub sender_target: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

#[account]
pub struct Mailbox {
    pub agent: Pubkey,
    pub spam_threshold_lamports: u64,
    pub allow_unsolicited: bool,
    pub message_count: u64,
    pub bump: u8,
}

impl Mailbox {
    pub const LEN: usize = 32 + 8 + 1 + 8 + 1;
}

#[account]
pub struct MessageRecord {
    pub message_id: [u8; 16],
    pub sender: Pubkey,
    pub agent: Pubkey,
    pub payload_hash: [u8; 32],
    pub staked_lamports: u64,
    pub settled: bool,
    pub created_at: i64,
    pub bump: u8,
}

impl MessageRecord {
    pub const LEN: usize = 16 + 32 + 32 + 32 + 8 + 1 + 8 + 1;
}

#[event]
pub struct MailboxInitializedEvent {
    pub agent: Pubkey,
    pub spam_threshold_lamports: u64,
    pub allow_unsolicited: bool,
}

#[event]
pub struct MessageDispatchedEvent {
    pub message_id: [u8; 16],
    pub sender: Pubkey,
    pub agent: Pubkey,
    pub payload_hash: [u8; 32],
    pub staked_lamports: u64,
}

#[event]
pub struct MessageAcknowledgedEvent {
    pub message_id: [u8; 16],
    pub slashed: bool,
    pub staked_lamports: u64,
}

#[error_code]
pub enum MermailError {
    #[msg("Staked lamports do not satisfy the minimum mailbox anti-spam threshold.")]
    SpamThresholdNotMet,
    #[msg("This message has already been acknowledged and settled.")]
    AlreadySettled,
    #[msg("Integer arithmetic overflow.")]
    ArithmeticOverflow,
}