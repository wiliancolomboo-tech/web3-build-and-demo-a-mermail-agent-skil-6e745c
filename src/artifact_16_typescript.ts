import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";
import * as crypto from "crypto";

describe("Mermail Core Protocol & Agent Skill QA Suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  // In local test runs, replace with compiled program reference or mocked workspace
  const program = anchor.workspace.MermailCore as Program<any>;
  const authority = Keypair.generate();

  const AGENT_ID = "sentinel-vault-01";
  const COOLDOWN_SECONDS = 3; // 3 seconds for deterministic test execution

  let agentRegistryPDA: PublicKey;
  let agentRegistryBump: number;

  before(async () => {
    // Airdrop SOL to test authority
    const sig = await provider.connection.requestAirdrop(
      authority.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(sig, "confirmed");

    [agentRegistryPDA, agentRegistryBump] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("mermail_agent"),
        authority.publicKey.toBuffer(),
        Buffer.from(AGENT_ID)
      ],
      program.programId
    );
  });

  it("QA-01: Successfully initializes an Agent Identity Registry", async () => {
    await program.methods
      .initializeAgent(AGENT_ID, new anchor.BN(COOLDOWN_SECONDS))
      .accounts({
        agentRegistry: agentRegistryPDA,
        authority: authority.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([authority])
      .rpc();

    const account = await program.account.agentRegistry.fetch(agentRegistryPDA);
    expect(account.authority.toBase58()).to.equal(authority.publicKey.toBase58());
    expect(account.agentId).to.equal(AGENT_ID);
    expect(account.cooldownSeconds.toNumber()).to.equal(COOLDOWN_SECONDS);
    expect(account.totalMessagesDispatched.toNumber()).to.equal(0);
    expect(account.isActive).to.be.true;
  });

  it("QA-02: Dispatches first verifiable message with valid cryptographic proofs", async () => {
    const seqId = 0;
    const recipient = "risk-multisig@dao.sol";
    const body = "EMERGENCY: Collateral ratio dipped below threshold 120%. Executing partial swap.";

    const recipientHash = Array.from(
      crypto.createHash("sha256").update(recipient).digest()
    );
    const payloadHash = Array.from(
      crypto.createHash("sha256").update(body).digest()
    );

    const seqBuffer = Buffer.alloc(8);
    seqBuffer.writeBigUInt64LE(BigInt(seqId));

    const [messageReceiptPDA] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("mermail_receipt"),
        agentRegistryPDA.toBuffer(),
        seqBuffer
      ],
      program.programId
    );

    const tx = await program.methods
      .dispatchMessage(recipientHash, payloadHash, "EMAIL")
      .accounts({
        agentRegistry: agentRegistryPDA,
        messageReceipt: messageReceiptPDA,
        authority: authority.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([authority])
      .rpc();

    expect(tx).to.be.a("string");

    // Verify On-Chain Receipt State
    const receiptAccount = await program.account.messageReceipt.fetch(messageReceiptPDA);
    expect(receiptAccount.agent.toBase58()).to.equal(agentRegistryPDA.toBase58());
    expect(receiptAccount.sequenceId.toNumber()).to.equal(0);
    expect(Buffer.from(receiptAccount.recipientHash).toString("hex")).to.equal(
      Buffer.from(recipientHash).toString("hex")
    );
    expect(Buffer.from(receiptAccount.payloadHash).toString("hex")).to.equal(
      Buffer.from(payloadHash).toString("hex")
    );
    expect(receiptAccount.channelTag).to.equal("EMAIL");

    // Verify Agent Registry State mutations
    const agentAccount = await program.account.agentRegistry.fetch(agentRegistryPDA);
    expect(agentAccount.totalMessagesDispatched.toNumber()).to.equal(1);
    expect(agentAccount.lastDispatchTimestamp.toNumber()).to.be.greaterThan(0);
  });

  it("QA-03: Enforces programmatic rate-limit cooldown (Anti-Spam Circuit Breaker)", async () => {
    const seqId = 1;
    const recipientHash = Array.from(crypto.createHash("sha256").update("ops@enterprise.fi").digest());
    const payloadHash = Array.from(crypto.createHash("sha256").update("Rate limit test").digest());

    const seqBuffer = Buffer.alloc(8);
    seqBuffer.writeBigUInt64LE(BigInt(seqId));

    const [messageReceiptPDA] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("mermail_receipt"),
        agentRegistryPDA.toBuffer(),
        seqBuffer
      ],
      program.programId
    );

    try {
      // Immediately invoke without waiting for cooldown
      await program.methods
        .dispatchMessage(recipientHash, payloadHash, "EMAIL")
        .accounts({
          agentRegistry: agentRegistryPDA,
          messageReceipt: messageReceiptPDA,
          authority: authority.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([authority])
        .rpc();

      expect.fail("Transaction should have reverted with RateLimitExceeded");
    } catch (err: any) {
      expect(err.message).to.include("RateLimitExceeded");
    }
  });

  it("QA-04: Dispatches successfully after cooldown period has elapsed", async () => {
    // Wait for the 3-second cooldown
    await new Promise((resolve) => setTimeout(resolve, 3200));

    const seqId = 1;
    const recipientHash = Array.from(crypto.createHash("sha256").update("ops@enterprise.fi").digest());
    const payloadHash = Array.from(crypto.createHash("sha256").update("Valid dispatch after delay").digest());

    const seqBuffer = Buffer.alloc(8);
    seqBuffer.writeBigUInt64LE(BigInt(seqId));

    const [messageReceiptPDA] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("mermail_receipt"),
        agentRegistryPDA.toBuffer(),
        seqBuffer
      ],
      program.programId
    );

    await program.methods
      .dispatchMessage(recipientHash, payloadHash, "SLACK")
      .accounts({
        agentRegistry: agentRegistryPDA,
        messageReceipt: messageReceiptPDA,
        authority: authority.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([authority])
      .rpc();

    const agentAccount = await program.account.agentRegistry.fetch(agentRegistryPDA);
    expect(agentAccount.totalMessagesDispatched.toNumber()).to.equal(2);
  });

  it("QA-05: Rejects unauthorized authority attempting to dispatch for registered agent", async () => {
    const maliciousAttacker = Keypair.generate();
    const airdropSig = await provider.connection.requestAirdrop(
      maliciousAttacker.publicKey,
      anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(airdropSig, "confirmed");

    const seqId = 2;
    const recipientHash = Array.from(crypto.createHash("sha256").update("ops@enterprise.fi").digest());
    const payloadHash = Array.from(crypto.createHash("sha256").update("Exploit message").digest());

    const seqBuffer = Buffer.alloc(8);
    seqBuffer.writeBigUInt64LE(BigInt(seqId));

    const [messageReceiptPDA] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("mermail_receipt"),
        agentRegistryPDA.toBuffer(),
        seqBuffer
      ],
      program.programId
    );

    try {
      await program.methods
        .dispatchMessage(recipientHash, payloadHash, "EMAIL")
        .accounts({
          agentRegistry: agentRegistryPDA,
          messageReceipt: messageReceiptPDA,
          authority: maliciousAttacker.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([maliciousAttacker])
        .rpc();

      expect.fail("Transaction should have failed with unauthorized authority");
    } catch (err: any) {
      // Anchor has_one constraint violation or custom UnauthorizedAuthority
      expect(err.toString()).to.satisfy(
        (str: string) => str.includes("UnauthorizedAuthority") || str.includes("ConstraintHasOne") || str.includes("custom program error")
      );
    }
  });
});