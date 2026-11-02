#!/usr/bin/env node
import { Command } from "commander";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { MermailAgentSkill, MessagePriority } from "./client";
import * as fs from "fs";
import * as dotenv from "dotenv";

dotenv.config();

const program = new Command();
program.name("mermail-cli").description("Enterprise CLI for Mermail Agent Skills on Solana").version("1.0.0");

function loadKeypair(path: string): Keypair {
  const raw = fs.readFileSync(path, "utf-8");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
}

program
  .command("init-mailbox")
  .description("Initialize an on-chain mailbox for an AI Agent")
  .requiredOption("-k, --keypair <path>", "Path to Agent keypair JSON file")
  .requiredOption("-r, --relayer <pubkey>", "Target authorized relayer public key")
  .option("-u, --rpc-url <url>", "Solana RPC URL", "http://127.0.0.1:8899")
  .action(async (options) => {
    const keypair = loadKeypair(options.keypair);
    const connection = new Connection(options.rpcUrl, "confirmed");
    const agentSkill = new MermailAgentSkill(connection, keypair);

    console.log(`Registering mailbox for agent: ${keypair.publicKey.toBase58()}...`);
    const tx = await agentSkill.initMailbox(new PublicKey(options.relayer));
    console.log(`Mailbox created successfully! TX: ${tx}`);
    const [pda] = agentSkill.getMailboxPda(keypair.publicKey);
    console.log(`Mailbox PDA: ${pda.toBase58()}`);
  });

program
  .command("send-alert")
  .description("Queue an enterprise alert email on-chain")
  .requiredOption("-k, --keypair <path>", "Path to Agent keypair JSON file")
  .requiredOption("-to, --recipient <email>", "Destination email address")
  .requiredOption("-s, --subject <subject>", "Email subject line")
  .requiredOption("-m, --message <body>", "Plaintext or HTML body payload")
  .option("-p, --priority <level>", "Priority: low, normal, high, critical", "high")
  .option("-u, --rpc-url <url>", "Solana RPC URL", "http://127.0.0.1:8899")
  .action(async (options) => {
    const keypair = loadKeypair(options.keypair);
    const connection = new Connection(options.rpcUrl, "confirmed");
    const agentSkill = new MermailAgentSkill(connection, keypair);

    const result = await agentSkill.dispatchMailIntent({
      recipient: options.recipient,
      subject: options.subject,
      htmlContent: options.message,
      priority: options.priority as MessagePriority,
    });

    console.log("Transaction dispatched successfully!");
    console.log(`Signature:   ${result.txSignature}`);
    console.log(`Message PDA: ${result.messagePda.toBase58()}`);
    console.log(`Sequence ID: ${result.sequenceId}`);
    console.log(`Digest:      ${result.sha256Hex}`);
  });

program.parse(process.argv);