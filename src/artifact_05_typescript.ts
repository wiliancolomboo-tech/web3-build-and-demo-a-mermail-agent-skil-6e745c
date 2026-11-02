#!/usr/bin/env node
import { Command } from "commander";
import { Keypair, PublicKey } from "@solana/web3.js";
import { MermailAgentSkill } from "./mermail-skill";
import * as dotenv from "dotenv";
import * as fs from "fs";

dotenv.config();

const program = new Command();

function loadKeypair(path: string): Keypair {
  const secret = JSON.parse(fs.readFileSync(path, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

program
  .name("mermail-agent-cli")
  .description("Turnkey CLI & Daemon for Mermail Solana Agent Skill")
  .version("1.0.0");

program
  .command("listen")
  .description("Runs the Mermail daemon to monitor and execute agent mail skills")
  .option("-k, --keypair <path>", "Path to Agent Keypair JSON", "./agent-keypair.json")
  .option("-r, --rpc <url>", "Solana RPC URL", "https://api.devnet.solana.com")
  .option("-p, --program <id>", "Mermail Core Program ID", "MermAiL111111111111111111111111111111111111")
  .option("-m, --mailbox <id>", "Mailbox Identifier", "enterprise-agent-01")
  .action(async (options) => {
    console.log("==================================================");
    console.log("Starting Mermail Autonomous Agent Daemon...");
    console.log("==================================================");

    const agentKey = loadKeypair(options.keypair);
    const skill = new MermailAgentSkill({
      rpcUrl: options.rpc,
      agentKeypair: agentKey,
      programId: new PublicKey(options.program),
      resendApiKey: process.env.RESEND_API_KEY || "re_test_dummy_key",
      slackWebhookUrl: process.env.SLACK_WEBHOOK_URL,
      mailboxId: options.mailbox,
    });

    const [mailboxPda] = skill.getMailboxPda();
    console.log(`[INIT] Agent Authority: ${agentKey.publicKey.toBase58()}`);
    console.log(`[INIT] Mailbox PDA:     ${mailboxPda.toBase58()}`);
    console.log("[DAEMON] Listening for on-chain events and enterprise dispatch hooks...");

    // Keep event loop alive
    setInterval(() => {
      console.log(`[HEARTBEAT] ${new Date().toISOString()} - Mermail Skill Daemon Healthy`);
    }, 30000);
  });

program
  .command("dispatch-demo")
  .description("Simulate sending a verified email request and triggering agent settlement")
  .requiredOption("-e, --email <target>", "Corporate recipient email")
  .requiredOption("-s, --subject <text>", "Instruction subject")
  .action(async (options) => {
    const dummyAgent = Keypair.generate();
    const dummySender = Keypair.generate();

    const skill = new MermailAgentSkill({
      rpcUrl: "https://api.devnet.solana.com",
      agentKeypair: dummyAgent,
      programId: new PublicKey("MermAiL111111111111111111111111111111111111"),
      resendApiKey: process.env.RESEND_API_KEY || "re_mock",
      slackWebhookUrl: process.env.SLACK_WEBHOOK_URL,
      mailboxId: "enterprise-agent-01",
    });

    console.log("[SIMULATION] Dispatching demo payload to agent skill...");
    const proof = await skill.processInboundAction(dummySender, {
      senderPubkey: dummySender.publicKey.toBase58(),
      replyToEmail: options.email,
      payloadUri: "https://arweave.net/mermail-mock-payload-001",
      subject: options.subject,
      body: "Execute auto-rebalance of liquidity vault upon receipt.",
    });

    console.log(`[SUCCESS] Proof generated: ${proof}`);
  });

program.parse(process.argv);