import {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  SystemProgram,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { Program, AnchorProvider, Wallet, BN, utils } from "@coral-xyz/anchor";
import { createHash } from "crypto";

export interface MermailSkillConfig {
  connection: Connection;
  agentKeypair: Keypair;
  programId: PublicKey;
}

export interface ActionPayload {
  intent: "SWAP" | "ESCROW_TRANSFER" | "SIGN_ORACLE";
  targetProgram: string;
  parameters: Record<string, unknown>;
  nonce: number;
}

export class MermailAgentSkill {
  private connection: Connection;
  private agentKeypair: Keypair;
  private programId: PublicKey;
  private provider: AnchorProvider;

  constructor(config: MermailSkillConfig) {
    this.connection = config.connection;
    this.agentKeypair = config.agentKeypair;
    this.programId = config.programId;

    const wallet = new Wallet(this.agentKeypair);
    this.provider = new AnchorProvider(this.connection, wallet, {
      preflightCommitment: "confirmed",
    });
  }

  /**
   * Derives Mailbox PDA for an authority pubkey
   */
  public getMailboxPDA(authority: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("mailbox"), authority.toBuffer()],
      this.programId
    );
  }

  /**
   * Derives Message PDA for a mailbox and message sequence number
   */
  public getMessagePDA(mailbox: PublicKey, sequenceNumber: BN): [PublicKey, number] {
    const seqBuffer = sequenceNumber.toArrayLike(Buffer, "le", 8);
    return PublicKey.findProgramAddressSync(
      [Buffer.from("message"), mailbox.toBuffer(), seqBuffer],
      this.programId
    );
  }

  /**
   * Hashes structured action payload using SHA-256 for on-chain commitment
   */
  public static hashPayload(payload: ActionPayload): Buffer {
    const serialized = Buffer.from(JSON.stringify(payload));
    return createHash("sha256").update(serialized).digest();
  }

  /**
   * Sends a Mermail action request to a destination agent
   */
  public async sendActionMail(
    recipientAuthority: PublicKey,
    actionPayload: ActionPayload,
    metadataUri: string,
    bountyLamports: number,
    validitySlots: number
  ): Promise<string> {
    const [recipientMailbox] = this.getMailboxPDA(recipientAuthority);
    
    // Fetch mailbox account to read current sequence
    const mailboxAccount = await this.connection.getAccountInfo(recipientMailbox);
    if (!mailboxAccount) {
      throw new Error("Recipient agent does not possess an initialized Mailbox.");
    }
    
    // Read message_count from Mailbox layout (offset 40: 8-byte discriminator + 32-byte pubkey)
    const seqNumber = new BN(mailboxAccount.data.subarray(40, 48), "le");
    const [messagePda] = this.getMessagePDA(recipientMailbox, seqNumber);

    const payloadHash = MermailAgentSkill.hashPayload(actionPayload);
    const currentSlot = await this.connection.getSlot("confirmed");
    const deadlineSlot = new BN(currentSlot + validitySlots);

    // Call Anchor program instruction send_message
    const ix = await this.provider.program.methods
      .sendMessage(
        Array.from(payloadHash),
        metadataUri,
        new BN(bountyLamports),
        deadlineSlot
      )
      .accounts({
        recipientMailbox,
        message: messagePda,
        sender: this.agentKeypair.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const tx = new Transaction().add(ix);
    return await sendAndConfirmTransaction(this.connection, tx, [this.agentKeypair]);
  }

  /**
   * Autonomous Agent Worker: Scans inbox and executes qualifying actions
   */
  public async processInboxAndExecute(
    payloadResolver: (uri: string) => Promise<ActionPayload>
  ): Promise<void> {
    const [myMailbox] = this.getMailboxPDA(this.agentKeypair.publicKey);
    const mailboxInfo = await this.connection.getAccountInfo(myMailbox);
    if (!mailboxInfo) return;

    const totalMessages = new BN(mailboxInfo.data.subarray(40, 48), "le").toNumber();

    for (let i = 0; i < totalMessages; i++) {
      const [msgPda] = this.getMessagePDA(myMailbox, new BN(i));
      const msgAccount = await this.connection.getAccountInfo(msgPda);
      if (!msgAccount) continue;

      // Decode status flag (offset: 8 + 32 + 32 + 32 + 100 + 8 + 8 + 8 = 228)
      // 0 = Pending, 1 = Executed, 2 = Cancelled
      const statusByte = msgAccount.data.readUInt8(228);
      if (statusByte !== 0) continue; // Skip non-pending

      // Extract URI and payload hash
      const expectedHash = msgAccount.data.subarray(72, 104);
      const uriLength = msgAccount.data.readUInt32LE(104);
      const uri = msgAccount.data.subarray(108, 108 + uriLength).toString("utf8");

      try {
        const payload = await payloadResolver(uri);
        const resolvedHash = MermailAgentSkill.hashPayload(payload);

        if (Buffer.compare(expectedHash, resolvedHash) !== 0) {
          console.warn(`[MERMAIL] Security check failed: Hash mismatch for message ${i}`);
          continue;
        }

        console.log(`[MERMAIL] Intent verified: ${payload.intent}. Submitting on-chain execution...`);

        const rawPayloadBuffer = Buffer.from(JSON.stringify(payload));
        const txSig = await this.provider.program.methods
          .executeAction(rawPayloadBuffer)
          .accounts({
            recipientMailbox: myMailbox,
            message: msgPda,
            authority: this.agentKeypair.publicKey,
            executor: this.agentKeypair.publicKey,
          })
          .rpc();

        console.log(`[MERMAIL] Action successfully finalized on-chain. TX: ${txSig}`);
      } catch (err) {
        console.error(`[MERMAIL] Failed processing message ${i}:`, err);
      }
    }
  }
}