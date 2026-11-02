import { Command } from "commander";
import * as dotenv from "dotenv";
import * as fs from "fs";
import { Keypair, PublicKey } from "@solana/web3.js";
import { MermailAgentSkill, logger } from "./MermailSkill";

dotenv.config();

const program = new Command();

program
  .name("mermail-cli")
  .description("Turnkey CLI for Mermail Solana Agent Skill Operations")
  .version("1.0.0");

function loadKeypair(path: string): Keypair {
  const secret = JSON.parse(fs.readFileSync(path, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

function getIDL() {
  return {
    version: "0.1.0",
    name: "mermail_core",
    instructions: [
      {
        name: "initializeMailbox",
        accounts: [
          { name: "mailbox", isMut: true, isSigner: false },
          { name: "authority", isMut: true, isSigner: true },
          { name: "systemProgram", isMut: false, isSigner: false },
        ],
        args: [
          { name: "agentEmail", type: "string" },
          { name: "inboundFeeLamports", type: "u64" },
        ],
      },
      {
        name: "recordAttestation",
        accounts: [
          { name: "mailbox", isMut: true, isSigner: false },
          { name: "attestation", isMut: true, isSigner: false },
          { name: "authority", isMut: true, isSigner: true },
          { name: "systemProgram", isMut: false, isSigner: false },
        ],
        args: [
          { name: "messageId", type: "string" },
          { name: "recipientOrSender", type: "string" },
          { name: "payloadSha256", type: { array: ["u8", 32] } },
          { name: "isOutbound", type: "bool" },
        ],
      },
    ],
  };
}

program
  .command("init")
  .description("Initialize agent mailbox on Solana")
  .option("-k, --keypair <path>", "Path to keypair JSON", process.env.SOLANA_KEYPAIR_PATH || "~/.config/solana/id.json")
  .option("-e, --email <email>", "Sender Agent Email", process.env.MERMAIL_SENDER_EMAIL || "agent@mermail.xyz")
  .option("-f, --fee <sol>", "Contact fee in SOL", "0.001")
  .action(async (opts) => {
    try {
      const keypair = loadKeypair(opts.keypair);
      const skill = new MermailAgentSkill(
        {
          rpcUrl: process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com",
          agentKeypair: keypair,
          programId: new PublicKey(process.env.MERMAIL_PROGRAM_ID || "MermAiL111111111111111111111111111111111111"),
          resendApiKey: process.env.RESEND_API_KEY || "re_test_dummy",
          senderAddress: opts.email,
        },
        getIDL() as any
      );

      const res = await skill.ensureMailboxInitialized(parseFloat(opts.fee));
      console.log(`Success! Result: ${res}`);
    } catch (err: any) {
      logger.error(`Init failed: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command("send")
  .description("Attest on Solana and send verified enterprise email")
  .requiredOption("-r, --recipient <email>", "Recipient email address")
  .requiredOption("-s, --subject <text>", "Subject line")
  .requiredOption("-b, --body <text>", "Body content")
  .option("-k, --keypair <path>", "Path to keypair JSON", process.env.SOLANA_KEYPAIR_PATH || "./agent-wallet.json")
  .action(async (opts) => {
    try {
      const keypair = loadKeypair(opts.keypair);
      const skill = new MermailAgentSkill(
        {
          rpcUrl: process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com",
          agentKeypair: keypair,
          programId: new PublicKey(process.env.MERMAIL_PROGRAM_ID || "MermAiL111111111111111111111111111111111111"),
          resendApiKey: process.env.RESEND_API_KEY || "",
          senderAddress: process.env.MERMAIL_SENDER_EMAIL || "agent@mermail.xyz",
          auditWebhookUrl: process.env.AUDIT_WEBHOOK_URL,
        },
        getIDL() as any
      );

      const outcome = await skill.sendAttestedEmail({
        recipient: opts.recipient,
        subject: opts.subject,
        body: opts.body,
      });

      console.log("\n=======================================================");
      console.log("             MERMAIL ATTESTED DISPATCH COMPLETED       ");
      console.log("=======================================================");
      console.log(`Message ID    : ${outcome.messageId}`);
      console.log(`Solana Tx     : ${outcome.txSignature}`);
      console.log(`Resend Ref    : ${outcome.resendId}`);
      console.log("=======================================================\n");
    } catch (err: any) {
      logger.error(`Send execution failed: ${err.message}`);
      process.exit(1);
    }
  });

program.parse(process.argv);