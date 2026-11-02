import * as anchor from "@coral-xyz/anchor";
   import { MermailAgentWorker } from "./sdk/mermailSkill";
   import { Keypair } from "@solana/web3.js";

   async function main() {
     const provider = anchor.AnchorProvider.env();
     anchor.setProvider(provider);
     const program = anchor.workspace.MermailSkill;
     const agentKeypair = Keypair.generate();

     // Airdrop SOL to agent for gas
     const sig = await provider.connection.requestAirdrop(agentKeypair.publicKey, 1e9);
     await provider.connection.confirmTransaction(sig);

     const worker = new MermailAgentWorker(program, agentKeypair);
     await worker.registerAgent("ORACLE_PRICE_FEED", 10_000_000, agentKeypair.publicKey);
     console.log("Starting Mermail Agent Daemon...");
     await worker.startWorkerLoop(2000);
   }

   main().catch(console.error);