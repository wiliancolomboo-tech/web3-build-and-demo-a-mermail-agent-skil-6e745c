import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { MermailCore } from "../target/types/mermail_core";
import { PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { expect } from "chai";
import { MermailAgentSkill, ActionPayload } from "../client/MermailAgentSkill";

describe("Mermail Protocol Test Suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.MermailCore as Program<MermailCore>;
  const senderKeypair = Keypair.generate();
  const agentKeypair = Keypair.generate();

  let agentMailboxPda: PublicKey;

  before(async () => {
    // Fund test keypairs
    const airdrop1 = await provider.connection.requestAirdrop(senderKeypair.publicKey, 5 * LAMPORTS_PER_SOL);
    const airdrop2 = await provider.connection.requestAirdrop(agentKeypair.publicKey, 5 * LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(airdrop1);
    await provider.connection.confirmTransaction(airdrop2);

    [agentMailboxPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("mailbox"), agentKeypair.publicKey.toBuffer()],
      program.programId
    );
  });

  it("QA-01: Initializes agent mailbox with zeroed counters", async () => {
    await program.methods
      .initializeMailbox()
      .accounts({
        mailbox: agentMailboxPda,
        authority: agentKeypair.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([agentKeypair])
      .rpc();

    const mailboxAccount = await program.account.mailbox.fetch(agentMailboxPda);
    expect(mailboxAccount.authority.toBase58()).to.equal(agentKeypair.publicKey.toBase58());
    expect(mailboxAccount.messageCount.toNumber()).to.equal(0);
    expect(mailboxAccount.unreadCount.toNumber()).to.equal(0);
  });

  it("QA-02: Dispatches action message with locked SOL bounty", async () => {
    const payload: ActionPayload = {
      intent: "SWAP",
      targetProgram: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
      parameters: { amountIn: 1000000, minOut: 2500000 },
      nonce: 1,
    };

    const payloadHash = Array.from(MermailAgentSkill.hashPayload(payload));
    const currentSlot = await provider.connection.getSlot();
    const bounty = new anchor.BN(0.5 * LAMPORTS_PER_SOL);
    const seqNum = new anchor.BN(0);

    const [messagePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("message"), agentMailboxPda.toBuffer(), seqNum.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    const preBalance = await provider.connection.getBalance(senderKeypair.publicKey);

    await program.methods
      .sendMessage(payloadHash, "https://arweave.net/example-action-manifest", bounty, new anchor.BN(currentSlot + 100))
      .accounts({
        recipientMailbox: agentMailboxPda,
        message: messagePda,
        sender: senderKeypair.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([senderKeypair])
      .rpc();

    const messageAccount = await program.account.message.fetch(messagePda);
    expect(messageAccount.bountyAmount.eq(bounty)).to.be.true;
    expect(messageAccount.status).to.deep.equal({ pending: {} });

    const mailboxAccount = await program.account.mailbox.fetch(agentMailboxPda);
    expect(mailboxAccount.messageCount.toNumber()).to.equal(1);
    expect(mailboxAccount.unreadCount.toNumber()).to.equal(1);
  });

  it("QA-03: Rejects execution if payload hash does not match on-chain commitment", async () => {
    const seqNum = new anchor.BN(0);
    const [messagePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("message"), agentMailboxPda.toBuffer(), seqNum.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    const forgedPayload = Buffer.from(JSON.stringify({ intent: "DRAIN_FUNDS", nonce: 999 }));

    try {
      await program.methods
        .executeAction(forgedPayload)
        .accounts({
          recipientMailbox: agentMailboxPda,
          message: messagePda,
          authority: agentKeypair.publicKey,
          executor: agentKeypair.publicKey,
        })
        .signers([agentKeypair])
        .rpc();
      expect.fail("Execution should have failed with PayloadHashMismatch");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("PayloadHashMismatch");
    }
  });

  it("QA-04: Successfully verifies payload, executes action, and disburses bounty", async () => {
    const legitimatePayload: ActionPayload = {
      intent: "SWAP",
      targetProgram: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
      parameters: { amountIn: 1000000, minOut: 2500000 },
      nonce: 1,
    };

    const seqNum = new anchor.BN(0);
    const [messagePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("message"), agentMailboxPda.toBuffer(), seqNum.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    const preBalance = await provider.connection.getBalance(agentKeypair.publicKey);
    const rawBuffer = Buffer.from(JSON.stringify(legitimatePayload));

    await program.methods
      .executeAction(rawBuffer)
      .accounts({
        recipientMailbox: agentMailboxPda,
        message: messagePda,
        authority: agentKeypair.publicKey,
        executor: agentKeypair.publicKey,
      })
      .signers([agentKeypair])
      .rpc();

    const postBalance = await provider.connection.getBalance(agentKeypair.publicKey);
    const messageAccount = await program.account.message.fetch(messagePda);

    expect(messageAccount.status).to.deep.equal({ executed: {} });
    expect(postBalance).to.be.greaterThan(preBalance); // Bounty deposited
  });

  it("QA-05: Reverts unauthorized attempt to settle an already executed message", async () => {
    const legitimatePayload: ActionPayload = {
      intent: "SWAP",
      targetProgram: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
      parameters: { amountIn: 1000000, minOut: 2500000 },
      nonce: 1,
    };
    const seqNum = new anchor.BN(0);
    const [messagePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("message"), agentMailboxPda.toBuffer(), seqNum.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    try {
      await program.methods
        .executeAction(Buffer.from(JSON.stringify(legitimatePayload)))
        .accounts({
          recipientMailbox: agentMailboxPda,
          message: messagePda,
          authority: agentKeypair.publicKey,
          executor: agentKeypair.publicKey,
        })
        .signers([agentKeypair])
        .rpc();
      expect.fail("Settlement should have reverted on already executed message");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("MessageAlreadySettled");
    }
  });
});