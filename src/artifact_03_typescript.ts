import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import * as crypto from "crypto";
import axios from "axios";

export interface MermailMessagePayload {
  toAgent: string;
  fromSender: string;
  action: "TRANSFER" | "NOTIFY" | "ARBITRAGE_ALERT" | "INVOICE";
  data: Record<string, unknown>;
  timestamp: number;
}

export interface MermailSkillConfig {
  rpcUrl: string;
  programId: string;
  resendApiKey: string;
  slackWebhookUrl?: string;
  agentKeypair: Keypair;
}

export class MermailAgentSkill {
  private connection: Connection;
  private programId: PublicKey;
  private agentKeypair: Keypair;
  private resendApiKey: string;
  private slackWebhookUrl?: string;

  constructor(config: MermailSkillConfig) {
    this.connection = new Connection(config.rpcUrl, "confirmed");
    this.programId = new PublicKey(config.programId);
    this.agentKeypair = config.agentKeypair;
    this.resendApiKey = config.resendApiKey;
    this.slackWebhookUrl = config.slackWebhookUrl;
  }

  public getMailboxAddress(agentPubkey: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("mailbox"), agentPubkey.toBuffer()],
      this.programId
    );
  }

  public getVaultAddress(mailboxPubkey: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), mailboxPubkey.toBuffer()],
      this.programId
    );
  }

  public getMessageRecordAddress(
    mailboxPubkey: PublicKey,
    messageId: Buffer
  ): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("message"), mailboxPubkey.toBuffer(), messageId],
      this.programId
    );
  }

  public computePayloadHash(payload: MermailMessagePayload): Buffer {
    const serialized = JSON.stringify(payload, Object.keys(payload).sort());
    return crypto.createHash("sha256").update(serialized).digest();
  }

  public async verifySenderSignature(
    payload: MermailMessagePayload,
    signatureHex: string,
    senderPubkey: PublicKey
  ): Promise<boolean> {
    try {
      const hash = this.computePayloadHash(payload);
      const signatureBytes = Buffer.from(signatureHex, "hex");
      return crypto.verify(
        null,
        hash,
        senderPubkey.toBuffer(),
        signatureBytes
      );
    } catch {
      // Fallback Ed25519 signature verification via tweetnacl
      const nacl = await import("tweetnacl");
      const hash = this.computePayloadHash(payload);
      return nacl.sign.detached.verify(
        hash,
        Buffer.from(signatureHex, "hex"),
        senderPubkey.toBytes()
      );
    }
  }

  public async sendEnterpriseNotification(
    recipientEmail: string,
    subject: string,
    bodyHtml: string
  ): Promise<boolean> {
    try {
      const response = await axios.post(
        "https://api.resend.com/emails",
        {
          from: "mermail-agent@notifications.mermail.io",
          to: recipientEmail,
          subject,
          html: bodyHtml,
        },
        {
          headers: {
            Authorization: `Bearer ${this.resendApiKey}`,
            "Content-Type": "application/json",
          },
          timeout: 8000,
        }
      );
      return response.status === 200 || response.status === 201;
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.warn(`[MermailSkill] Resend notification fallback: ${errorMsg}`);
      return false;
    }
  }

  public async forwardToSlack(message: string): Promise<void> {
    if (!this.slackWebhookUrl) return;
    try {
      await axios.post(this.slackWebhookUrl, { text: message }, { timeout: 4000 });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[MermailSkill] Slack dispatch failed: ${msg}`);
    }
  }

  public async parseAndExecuteMessage(
    payload: MermailMessagePayload,
    signatureHex: string,
    messageIdHex: string,
    stakedLamports: number
  ): Promise<{ success: boolean; txHash?: string; reason?: string }> {
    const senderPubkey = new PublicKey(payload.fromSender);
    const valid = await this.verifySenderSignature(payload, signatureHex, senderPubkey);

    const [mailboxPda] = this.getMailboxAddress(this.agentKeypair.publicKey);
    const messageId = Buffer.from(messageIdHex, "hex");
    const [messageRecordPda] = this.getMessageRecordAddress(mailboxPda, messageId);

    if (!valid) {
      await this.forwardToSlack(
        `🚨 *MERMAIL SECURITY ALERT:* Invalid signature on message ${messageIdHex} from ${payload.fromSender}. Slashing stake!`
      );
      return { success: false, reason: "INVALID_CRYPTOGRAPHIC_SIGNATURE" };
    }

    // Process valid skill actions
    switch (payload.action) {
      case "TRANSFER": {
        const destPubkey = new PublicKey(payload.data.destination as string);
        const lamports = Number(payload.data.lamports);

        const tx = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: this.agentKeypair.publicKey,
            toPubkey: destPubkey,
            lamports,
          })
        );

        const txSig = await sendAndConfirmTransaction(this.connection, tx, [this.agentKeypair]);

        await this.sendEnterpriseNotification(
          (payload.data.notifyEmail as string) || "treasury@dao.internal",
          `[EXECUTED] Mermail Transfer: ${lamports} Lamports to ${destPubkey.toBase58()}`,
          `<h3>Transaction Executed</h3><p>Solana Signature: <code>${txSig}</code></p>`
        );

        return { success: true, txHash: txSig };
      }

      case "NOTIFY": {
        await this.forwardToSlack(
          `📬 *Mermail Agent Inbound:* Message from ${payload.fromSender}: ${JSON.stringify(payload.data)}`
        );
        return { success: true };
      }

      default:
        return { success: false, reason: "UNSUPPORTED_ACTION" };
    }
  }
}