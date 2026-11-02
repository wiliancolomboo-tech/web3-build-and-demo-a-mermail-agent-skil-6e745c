// File: src/engine/MermailAgentSkill.ts

import { Keypair, PublicKey, Connection, Transaction, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";
import crypto from "crypto";
import { Resend } from "resend";

export interface MermailSkillConfig {
  agentKeypair: Keypair;
  solanaRpcUrl: string;
  resendApiKey: string;
  senderEmail: string;
  operatorEmail: string;
  actionBaseUrl: string;
  slackWebhookUrl?: string;
}

export interface SendAlertParams {
  subject: string;
  summary: string;
  targetAccount?: string;
  actionRequired: boolean;
  actionPayload?: {
    recipientPubkey: string;
    lamports: number;
    memo?: string;
  };
}

export interface VerificationResult {
  isValid: boolean;
  agentPublicKey: string;
  computedHash: string;
  error?: string;
}

export class MermailAgentSkill {
  private keypair: Keypair;
  private connection: Connection;
  private resend: Resend;
  private senderEmail: string;
  private operatorEmail: string;
  private actionBaseUrl: string;
  private slackWebhookUrl?: string;
  private idempotencyCache: Set<string>;

  constructor(config: MermailSkillConfig) {
    if (!config.agentKeypair) throw new Error("Agent keypair is mandatory for cryptographic signing.");
    if (!config.resendApiKey) throw new Error("Resend API key is mandatory for transport delivery.");
    if (!config.senderEmail) throw new Error("Sender email identity is required.");
    if (!config.operatorEmail) throw new Error("Operator destination email is required.");

    this.keypair = config.agentKeypair;
    this.connection = new Connection(config.solanaRpcUrl, "confirmed");
    this.resend = new Resend(config.resendApiKey);
    this.senderEmail = config.senderEmail;
    this.operatorEmail = config.operatorEmail;
    this.actionBaseUrl = config.actionBaseUrl.replace(/\/$/, "");
    this.slackWebhookUrl = config.slackWebhookUrl;
    this.idempotencyCache = new Set<string>();
  }

  /**
   * Returns the agent's authoritative Solana public address
   */
  public getAgentPublicKey(): string {
    return this.keypair.publicKey.toBase58();
  }

  /**
   * Deterministically signs a string payload using the Agent's Ed25519 Solana Private Key
   */
  public signMessagePayload(payload: string): { signature: string; payloadHash: string } {
    const payloadHash = crypto.createHash("sha256").update(payload, "utf8").digest("hex");
    const messageBytes = Buffer.from(payloadHash, "hex");
    const signatureBytes = nacl.sign.detached(messageBytes, this.keypair.secretKey);
    const signature = bs58.encode(signatureBytes);

    return { signature, payloadHash };
  }

  /**
   * Cryptographically verifies an inbound Mermail alert signature against a reported public key
   */
  public static verifyMessageSignature(
    payload: string,
    signatureBase58: string,
    expectedPubkeyBase58: string
  ): VerificationResult {
    try {
      const payloadHash = crypto.createHash("sha256").update(payload, "utf8").digest("hex");
      const messageBytes = Buffer.from(payloadHash, "hex");
      const signatureBytes = bs58.decode(signatureBase58);
      const publicKeyBytes = bs58.decode(expectedPubkeyBase58);

      const isValid = nacl.sign.detached.verify(messageBytes, signatureBytes, publicKeyBytes);

      return {
        isValid,
        agentPublicKey: expectedPubkeyBase58,
        computedHash: payloadHash,
      };
    } catch (err: any) {
      return {
        isValid: false,
        agentPublicKey: expectedPubkeyBase58,
        computedHash: "",
        error: err.message || "Cryptographic verification failure",
      };
    }
  }

  /**
   * Dispatches a signed, verifiable email alert via Resend with Action/Blink deep-links
   */
  public async dispatchAgentAlert(params: SendAlertParams): Promise<{ success: boolean; emailId?: string; signature: string }> {
    const nonce = crypto.randomBytes(16).toString("hex");
    const timestamp = new Date().toISOString();
    
    // Prevent duplicate dispatches of identical anomaly digests within a cycle
    const dedupeKey = `${params.subject}:${params.targetAccount || "global"}:${Math.floor(Date.now() / 60000)}`;
    if (this.idempotencyCache.has(dedupeKey)) {
      throw new Error(`[IDEMPOTENCY_TRIGGERED] Alert suppression active for key: ${dedupeKey}`);
    }
    this.idempotencyCache.add(dedupeKey);

    const canonicalBody = JSON.stringify({
      agentPubkey: this.getAgentPublicKey(),
      subject: params.subject,
      summary: params.summary,
      targetAccount: params.targetAccount || "N/A",
      timestamp,
      nonce,
    });

    const { signature, payloadHash } = this.signMessagePayload(canonicalBody);

    // Format interactive Solana Action / Blink URLs if action is required
    let actionBlinkUrl = "";
    if (params.actionRequired && params.actionPayload) {
      const encodedParams = new URLSearchParams({
        recipient: params.actionPayload.recipientPubkey,
        amount: (params.actionPayload.lamports / LAMPORTS_PER_SOL).toString(),
        memo: params.actionPayload.memo || "Agent Automated Resolution",
        nonce,
      });
      actionBlinkUrl = `${this.actionBaseUrl}/api/actions/rebalance?${encodedParams.toString()}`;
    }

    const htmlContent = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #0c0d0e; color: #f4f4f5; padding: 24px; }
            .container { max-width: 600px; margin: 0 auto; background-color: #18181b; border: 1px solid #27272a; border-radius: 8px; padding: 28px; }
            .header { border-bottom: 1px solid #27272a; padding-bottom: 16px; margin-bottom: 20px; }
            .badge { background-color: #14f195; color: #000000; font-size: 11px; font-weight: 700; padding: 4px 8px; border-radius: 4px; text-transform: uppercase; }
            .pubkey { font-family: monospace; font-size: 12px; color: #9945ff; word-break: break-all; }
            .content { font-size: 14px; line-height: 1.6; color: #d4d4d8; margin-bottom: 24px; }
            .action-card { background-color: #27272a; border-radius: 6px; padding: 16px; margin: 20px 0; }
            .btn { display: inline-block; background-color: #9945ff; color: #ffffff; text-decoration: none; padding: 12px 24px; border-radius: 6px; font-weight: 600; font-size: 14px; }
            .footer { border-top: 1px solid #27272a; padding-top: 16px; margin-top: 24px; font-size: 11px; color: #71717a; font-family: monospace; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <span class="badge">Verified Mermail Solana Agent</span>
              <h2 style="color: #ffffff; margin-top: 12px; margin-bottom: 4px;">${params.subject}</h2>
              <div class="pubkey">Agent: ${this.getAgentPublicKey()}</div>
            </div>
            
            <div class="content">
              <p>${params.summary}</p>
              ${params.targetAccount ? `<p><strong>Monitored Address:</strong> <span class="pubkey">${params.targetAccount}</span></p>` : ""}
            </div>

            ${
              params.actionRequired
                ? `
            <div class="action-card">
              <h4 style="margin: 0 0 8px 0; color: #ffffff;">Actionable Solana Blink Request</h4>
              <p style="margin: 0 0 16px 0; font-size: 13px; color: #a1a1aa;">This anomaly requires executive approval. Click below to inspect and execute via Solana Pay / Dialect Blink.</p>
              <a href="${actionBlinkUrl}" class="btn" target="_blank">Review & Execute Transaction</a>
            </div>
            `
                : ""
            }

            <div class="footer">
              <div>SHA256 Payload Digest: ${payloadHash}</div>
              <div>Ed25519 Signature: ${signature}</div>
              <div style="margin-top: 8px;">Network: Solana Mainnet-Beta | Protocol: Mermail Agent Protocol v1.0</div>
            </div>
          </div>
        </body>
      </html>
    `;

    try {
      const emailResponse = await this.resend.emails.send({
        from: this.senderEmail,
        to: this.operatorEmail,
        subject: `[SOLANA-AGENT-ALERT] ${params.subject}`,
        html: htmlContent,
        headers: {
          "X-Solana-Agent-Pubkey": this.getAgentPublicKey(),
          "X-Solana-Agent-Signature": signature,
          "X-Solana-Payload-Hash": payloadHash,
          "X-Solana-Action-URL": actionBlinkUrl || "none",
        },
      });

      if (this.slackWebhookUrl) {
        await this.dispatchSlackNotification(params, signature, payloadHash);
      }

      return {
        success: true,
        emailId: emailResponse.data?.id,
        signature,
      };
    } catch (error: any) {
      throw new Error(`Failed to transmit Mermail alert via Resend: ${error.message}`);
    }
  }

  /**
   * Redundant Slack / Discord channel dispatch for multi-channel consensus
   */
  private async dispatchSlackNotification(params: SendAlertParams, signature: string, hash: string): Promise<void> {
    if (!this.slackWebhookUrl) return;

    const payload = {
      text: `🚨 *[Mermail Solana Agent Alert]*: ${params.subject}`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Agent Pubkey:* \`${this.getAgentPublicKey()}\`\n*Anomaly:* ${params.summary}\n*Target:* \`${params.targetAccount || "N/A"}\``,
          },
        },
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: `*Payload Hash:* \`${hash}\` | *Ed25519 Sig:* \`${signature.slice(0, 16)}...\``,
            },
          ],
        },
      ],
    };

    try {
      await fetch(this.slackWebhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      console.error("[WARN] Failed to dispatch Slack fallback alert:", err);
    }
  }

  /**
   * Builds an on-chain transaction instruction responding to an approved Blink action
   */
  public async buildResolutionTransaction(
    payer: PublicKey,
    recipient: PublicKey,
    lamports: number
  ): Promise<Transaction> {
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash("confirmed");
    const transaction = new Transaction({
      feePayer: payer,
      blockhash,
      lastValidBlockHeight,
    });

    transaction.add(
      SystemProgram.transfer({
        fromPubkey: payer,
        toPubkey: recipient,
        lamports,
      })
    );

    return transaction;
  }
}