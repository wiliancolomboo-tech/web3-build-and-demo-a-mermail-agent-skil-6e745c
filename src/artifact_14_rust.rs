use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("Merm111111111111111111111111111111111111111");

#[program]
pub mod mermail_agent_skill {
    use super::*;

    pub fn initialize_agent(
        ctx: Context<InitializeAgent>,
        metadata_uri: String,
    ) -> Result<()> {
        instructions::initialize_agent::handler(ctx, metadata_uri)
    }

    pub fn register_skill(
        ctx: Context<RegisterSkill>,
        skill_id: String,
        fee_bps: u16,
        base_fee_lamports: u64,
        cooldown_slots: u64,
        max_compute_budget: u32,
    ) -> Result<()> {
        instructions::register_skill::handler(
            ctx,
            skill_id,
            fee_bps,
            base_fee_lamports,
            cooldown_slots,
            max_compute_budget,
        )
    }

    pub fn create_delegation(
        ctx: Context<CreateDelegation>,
        skill_id: String,
        deposit_amount: u64,
        max_spend_per_tx: u64,
        expiration_slot: u64,
    ) -> Result<()> {
        instructions::create_delegation::handler(
            ctx,
            skill_id,
            deposit_amount,
            max_spend_per_tx,
            expiration_slot,
        )
    }

    pub fn execute_agent_skill(
        ctx: Context<ExecuteAgentSkill>,
        payload_digest: [u8; 32],
        execution_spend_amount: u64,
    ) -> Result<()> {
        instructions::execute_agent_skill::handler(
            ctx,
            payload_digest,
            execution_spend_amount,
        )
    }

    pub fn revoke_delegation(ctx: Context<RevokeDelegation>) -> Result<()> {
        instructions::revoke_delegation::handler(ctx)
    }
}