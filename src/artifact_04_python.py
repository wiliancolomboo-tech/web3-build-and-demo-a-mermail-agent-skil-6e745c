#!/usr/bin/env python3
"""
Mermail Autonomous Agent Skill Daemon
Monitors an on-chain Mermail Mailbox, processes incoming AI payloads,
and submits execution proofs along with bounty settlement CPIs.
"""

import asyncio
import hashlib
import json
import struct
import logging
from typing import Optional

from solana.rpc.async_api import AsyncClient
from solana.rpc.commitment import Confirmed
from solders.pubkey import Pubkey
from solders.keypair import Keypair
from solders.transaction import Transaction
from solders.instruction import Instruction, AccountMeta
from solders.system_program import ID as SYS_PROGRAM_ID

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("MermailAgent")

PROGRAM_ID = Pubkey.from_string("MermSkiLL1111111111111111111111111111111111")
MAILBOX_SEED = b"mailbox"
MESSAGE_SEED = b"message"
ESCROW_SEED = b"escrow"

# Anchor 8-byte instruction discriminators (pre-computed via sha256("global:<name>")[..8])
IX_EXECUTE_SKILL = hashlib.sha256(b"global:execute_skill").digest()[:8]

class MermailSkillAgent:
    def __init__(self, agent_keypair: Keypair, rpc_endpoint: str):
        self.keypair = agent_keypair
        self.client = AsyncClient(rpc_endpoint, commitment=Confirmed)
        self.mailbox_pda, self.mailbox_bump = Pubkey.find_program_address(
            [MAILBOX_SEED, bytes(self.keypair.pubkey())], PROGRAM_ID
        )
        logger.info(f"Initialized Agent: {self.keypair.pubkey()} | Mailbox PDA: {self.mailbox_pda}")

    async def execute_reasoning_pipeline(self, skill_opcode: int, payload_hash: bytes) -> bytes:
        """
        Simulates AI LLM execution / tool action for specific skill opcode.
        Returns a 64-byte deterministic cryptographic proof of execution.
        """
        logger.info(f"AI Skill Engine processing Opcode: {skill_opcode} | Hash: {payload_hash.hex()[:16]}...")
        await asyncio.sleep(0.5)  # Simulated inference delay
        
        # Opcode 1: DeFi Liquidity Routing; Opcode 2: Signature Multi-Validation; Opcode 3: Oracle Computation
        proof_core = hashlib.sha256(payload_hash + bytes([skill_opcode]) + bytes(self.keypair.pubkey())).digest()
        proof_signature = hashlib.sha256(proof_core + b"RESOLVED_SUCCESSFULLY").digest()
        
        # Combine into 64-byte proof
        return proof_core + proof_signature

    async def settle_skill_task(self, message_nonce: int, sender_pubkey: Pubkey, proof: bytes):
        """Constructs and dispatches the on-chain execute_skill transaction."""
        nonce_bytes = struct.pack("<Q", message_nonce)
        message_pda, _ = Pubkey.find_program_address(
            [MESSAGE_SEED, bytes(self.mailbox_pda), nonce_bytes], PROGRAM_ID
        )
        escrow_vault_pda, _ = Pubkey.find_program_address(
            [ESCROW_SEED, bytes(message_pda)], PROGRAM_ID
        )

        # Accounts ordered as declared in ExecuteSkill struct:
        # mailbox, message, escrow_vault, agent, agent_payout_target, sender, system_program
        accounts = [
            AccountMeta(pubkey=self.mailbox_pda, is_signer=False, is_writable=False),
            AccountMeta(pubkey=message_pda, is_signer=False, is_writable=True),
            AccountMeta(pubkey=escrow_vault_pda, is_signer=False, is_writable=True),
            AccountMeta(pubkey=self.keypair.pubkey(), is_signer=True, is_writable=False),
            AccountMeta(pubkey=self.keypair.pubkey(), is_signer=False, is_writable=True),
            AccountMeta(pubkey=sender_pubkey, is_signer=False, is_writable=True),
            AccountMeta(pubkey=SYS_PROGRAM_ID, is_signer=False, is_writable=False),
        ]

        instruction_data = IX_EXECUTE_SKILL + proof
        ix = Instruction(PROGRAM_ID, instruction_data, accounts)

        latest_blockhash_resp = await self.client.get_latest_blockhash()
        recent_blockhash = latest_blockhash_resp.value.blockhash

        tx = Transaction.new_signed_with_payer(
            [ix],
            self.keypair.pubkey(),
            [self.keypair],
            recent_blockhash,
        )

        tx_sig = await self.client.send_transaction(tx)
        logger.info(f"Task {message_nonce} Settled On-Chain! Signature: {tx_sig.value}")
        return tx_sig.value

    async def run_daemon_loop(self):
        """Monitors account storage or logs for dispatched tasks."""
        logger.info("Agent Daemon listening for incoming Mermail Tasks...")
        while True:
            try:
                # Polling state for active mailbox verification
                account_info = await self.client.get_account_info(self.mailbox_pda)
                if account_info.value:
                    data = account_info.value.data
                    # Offset 40 contains the 8-byte little-endian message_nonce
                    nonce = struct.unpack("<Q", data[40:48])[0]
                    logger.debug(f"Mailbox Active. Current Nonce Counter: {nonce}")
            except Exception as e:
                logger.error(f"Error in polling loop: {str(e)}")
            await asyncio.sleep(5)

if __name__ == "__main__":
    test_agent_keypair = Keypair()
    agent = MermailSkillAgent(test_agent_keypair, "http://127.0.0.1:8899")
    asyncio.run(agent.run_daemon_loop())