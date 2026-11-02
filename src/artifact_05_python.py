#!/usr/bin/env python3
"""
Mermail Autonomous Agent Skill Daemon
Monitors an on-chain Mermail inbox, processes requests via skill handlers,
and submits atomic receipts to claim escrow bounties.
"""

import asyncio
import hashlib
import json
import logging
import os
from typing import Dict, Any

from solana.rpc.async_api import AsyncClient
from solders.pubkey import Pubkey
from solders.keypair import Keypair
from solders.instruction import Instruction, AccountMeta
from solders.transaction import VersionedTransaction
from solders.message import MessageV0

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("MermailDaemon")

PROGRAM_ID = Pubkey.from_string("Mail111111111111111111111111111111111111111")
RPC_ENDPOINT = os.getenv("SOLANA_RPC_URL", "http://127.0.0.1:8899")

class MermailSkillAgent:
    def __init__(self, keypair_path: str):
        with open(keypair_path, "r") as f:
            secret = json.load(f)
        self.keypair = Keypair.from_bytes(bytes(secret))
        self.client = AsyncClient(RPC_ENDPOINT)
        self.inbox_pda, _ = Pubkey.find_program_address(
            [b"inbox", bytes(self.keypair.pubkey())], PROGRAM_ID
        )
        logger.info(f"Agent Initialized: {self.keypair.pubkey()}")
        logger.info(f"Monitoring Inbox: {self.inbox_pda}")

    def execute_skill(self, skill_id: bytes, payload_hash: bytes) -> bytes:
        """
        Tool Router / AI Skill Engine Invocation.
        Matches skill_id to executable agent skills (e.g. Swaps, Data Feeds, RAG).
        """
        logger.info(f"Dispatching skill execution for SkillID: {skill_id.hex()}")
        # Simulated execution of deterministic skill routine
        result = {
            "status": "COMPLETED",
            "skill_id": skill_id.hex(),
            "payload_hash": payload_hash.hex(),
            "output": "Agent successfully performed automated liquidity routing."
        }
        raw_result = json.dumps(result, sort_keys=True).encode("utf-8")
        receipt_hash = hashlib.sha256(raw_result).digest()
        logger.info(f"Task completed. Receipt Hash: {receipt_hash.hex()}")
        return receipt_hash

    async def poll_inbox_and_execute(self):
        """Monitors the inbox PDA and automatically executes tasks."""
        logger.info("Starting Mermail listener event loop...")
        last_processed_nonce = -1

        while True:
            try:
                acc_info = await self.client.get_account_info(self.inbox_pda)
                if acc_info.value is None:
                    logger.warning("Inbox PDA not yet initialized on-chain. Waiting...")
                    await asyncio.sleep(5)
                    continue

                data = acc_info.value.data
                # Anchor discriminator (8) + owner (32) = 40
                total_messages = int.from_bytes(data[40:48], "little")
                unread_messages = int.from_bytes(data[48:56], "little")

                if unread_messages > 0 and total_messages > (last_processed_nonce + 1):
                    target_nonce = total_messages - 1
                    logger.info(f"New incoming message detected! Target Nonce: {target_nonce}")

                    nonce_bytes = target_nonce.to_bytes(8, "little")
                    message_pda, _ = Pubkey.find_program_address(
                        [b"message", bytes(self.inbox_pda), nonce_bytes], PROGRAM_ID
                    )

                    msg_info = await self.client.get_account_info(message_pda)
                    if msg_info.value is not None:
                        # Extract Message data
                        msg_data = msg_info.value.data
                        # seeds: discriminator (8) + inbox (32) + sender (32) + nonce (8)
                        skill_id = bytes(msg_data[80:96])
                        payload_hash = bytes(msg_data[96:128])

                        receipt_hash = self.execute_skill(skill_id, payload_hash)
                        logger.info(f"Acknowledging message {message_pda} with receipt...")
                        # Acknowledge instruction can be dispatched on-chain
                        last_processed_nonce = target_nonce

            except Exception as e:
                logger.error(f"Error in agent processing loop: {str(e)}")

            await asyncio.sleep(2.5)

if __name__ == "__main__":
    agent = MermailSkillAgent("tests/fixtures/agent_keypair.json")
    asyncio.run(agent.poll_inbox_and_execute())