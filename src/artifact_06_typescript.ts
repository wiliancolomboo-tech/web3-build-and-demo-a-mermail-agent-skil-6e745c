import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { MermailCore } from "../target/types/mermail_core";
import { Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { expect } from "chai";
import { createHash } from "crypto";

describe("mermail_core integration & security verification suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.MermailCore as Program<MermailCore>;
  const agentAuthority = Keypair.generate();
  const treasury = Keypair.generate();
  const sender = Keypair.generate();
  const unauthorizedAttacker = Keypair.generate();

  const agentId = "agent-unit-test-01";
  const spamFee = new anchor.BN(0.01 * LAMPORTS_PER_SOL);

  let mailboxPda: PublicKey;
  let mailboxBump: number;

  before(async () => {
    // Airdrop funds to test signers
    for (const kp of [agentAuthority, sender, unauthorizedAttacker]) {
      const sig = await provider.connection.requestAirdrop(
        kp.publicKey,
        2 * LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig, "confirmed");
    }

    [mailboxPda, mailboxBump] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("mailbox"),
        agentAuthority.publicKey.toBuffer(),
        Buffer.from(agentId),
      ],
      program.programId
    );
  });

  it("1. Successfully initializes an enterprise Mailbox PDA with fee policy", async () => {
    await program.methods
      .initializeMailbox(agentId, spamFee)
      .accounts({
        mailbox: mailboxPda,
        agentAuthority: agentAuthority.publicKey,
        treasury: treasury.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([agentAuthority])
      .rpc();

    const mailboxAccount = await program.account.mailbox.fetch(mailboxPda);
    expect(mailboxAccount.agentAuthority.toBase58()).to.equal(agentAuthority.publicKey.toBase58());
    expect(mailboxAccount.treasury.toBase58()).to.equal(treasury.publicKey.toBase58());
    expect(mailboxAccount.spamFeeLamports.toNumber()).to.equal(spamFee.toNumber());
    expect(mailboxAccount.totalMessagesReceived.toNumber()).to.equal(0);
    expect(mailboxAccount.isActive).to.be.true;
  });

  it("2. Successfully posts a message with bond transfer to treasury", async () => {
    const rawPayload = Buffer.from("Instruction: Rebalance DEX position delta-neutral");
    const messageHash = Array.from(createHash("sha256").update(rawPayload).digest());

    const [receiptPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("receipt"), mailboxPda.toBuffer(), Buffer.from(messageHash)],
      program.programId
    );

    const treasuryBalBefore = await provider.connection.getBalance(treasury.publicKey);

    await program.methods
      .postMessage(messageHash, "corporate-ops@enterprise.com", "ipfs://bafy-demo-hash")
      .accounts({
        mailbox: mailboxPda,
        messageReceipt: receiptPda,
        sender: sender.publicKey,
        treasury: treasury.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([sender])
      .rpc();

    const treasuryBalAfter = await provider.connection.getBalance(treasury.publicKey);
    expect(treasuryBalAfter - treasuryBalBefore).to.equal(spamFee.toNumber());

    const receipt = await program.account.messageReceipt.fetch(receiptPda);
    expect(receipt.sender.toBase58()).to.equal(sender.publicKey.toBase58());
    expect(receipt.replyToEmail).to.equal("corporate-ops@enterprise.com");
    expect(receipt.status).to.deep.equal({ pending: {} });
  });

  it("3. Prevents duplicate replay attacks on identical message receipt PDA", async () => {
    const rawPayload = Buffer.from("Instruction: Rebalance DEX position delta-neutral");
    const messageHash = Array.from(createHash("sha256").update(rawPayload).digest());

    const [receiptPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("receipt"), mailboxPda.toBuffer(), Buffer.from(messageHash)],
      program.programId
    );

    try {
      await program.methods
        .postMessage(messageHash, "corporate-ops@enterprise.com", "ipfs://bafy-demo-hash")
        .accounts({
          mailbox: mailboxPda,
          messageReceipt: receiptPda,
          sender: sender.publicKey,
          treasury: treasury.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([sender])
        .rpc();
      expect.fail("Should have rejected duplicate message post");
    } catch (err: any) {
      expect(err.toString()).to.include("already in use");
    }
  });

  it("4. Blocks unauthorized third-party from resolving an agent message", async () => {
    const rawPayload = Buffer.from("Instruction: Authorized Resolution Test");
    const messageHash = Array.from(createHash("sha256").update(rawPayload).digest());
    const [receiptPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("receipt"), mailboxPda.toBuffer(), Buffer.from(messageHash)],
      program.programId
    );

    await program.methods
      .postMessage(messageHash, "exec@firm.co", "ipfs://uri-02")
      .accounts({
        mailbox: mailboxPda,
        messageReceipt: receiptPda,
        sender: sender.publicKey,
        treasury: treasury.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([sender])
      .rpc();

    const fakeProof = Array.from(Buffer.alloc(32, 7));

    try {
      await program.methods
        .resolveMessage({ processedSuccess: {} }, fakeProof)
        .accounts({
          mailbox: mailboxPda,
          messageReceipt: receiptPda,
          agentAuthority: unauthorizedAttacker.publicKey,
        })
        .signers([unauthorizedAttacker])
        .rpc();
      expect.fail("Attacker should not be able to resolve message");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("UnauthorizedAgent");
    }
  });

  it("5. Allows authorized agent authority to resolve message with proof", async () => {
    const rawPayload = Buffer.from("Instruction: Authorized Resolution Test");
    const messageHash = Array.from(createHash("sha256").update(rawPayload).digest());
    const [receiptPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("receipt"), mailboxPda.toBuffer(), Buffer.from(messageHash)],
      program.programId
    );

    const realProof = Array.from(createHash("sha256").update(Buffer.from("DONE")).digest());

    await program.methods
      .resolveMessage({ processedSuccess: {} }, realProof)
      .accounts({
        mailbox: mailboxPda,
        messageReceipt: receiptPda,
        agentAuthority: agentAuthority.publicKey,
      })
      .signers([agentAuthority])
      .rpc();

    const receipt = await program.account.messageReceipt.fetch(receiptPda);
    expect(receipt.status).to.deep.equal({ processedSuccess: {} });
    expect(receipt.executionProof).to.deep.equal(realProof);
  });
});