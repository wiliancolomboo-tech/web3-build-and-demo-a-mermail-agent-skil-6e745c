import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Keypair, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { expect } from "chai";
import * as crypto from "crypto";

describe("mermail_core Unit & Integration Matrix", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.MermailCore as Program<any>;
  const agentAuthority = Keypair.generate();
  const unauthorizedActor = Keypair.generate();

  let mailboxPda: anchor.web3.PublicKey;

  before(async () => {
    // Airdrop funds to test agents
    const airdrop1 = await provider.connection.requestAirdrop(
      agentAuthority.publicKey,
      2 * LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(airdrop1);

    const airdrop2 = await provider.connection.requestAirdrop(
      unauthorizedActor.publicKey,
      1 * LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(airdrop2);

    [mailboxPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("mermail_box"), agentAuthority.publicKey.toBuffer()],
      program.programId
    );
  });

  it("1. Successfully initializes agent mailbox with deterministic PDA", async () => {
    const fee = new anchor.BN(0.005 * LAMPORTS_PER_SOL);
    const agentEmail = "autonomous-agent@solana.mermail.xyz";

    await program.methods
      .initializeMailbox(agentEmail, fee)
      .accounts({
        mailbox: mailboxPda,
        authority: agentAuthority.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([agentAuthority])
      .rpc();

    const mailboxAccount = await program.account.mailboxState.fetch(mailboxPda);
    expect(mailboxAccount.authority.toBase58()).to.equal(agentAuthority.publicKey.toBase58());
    expect(mailboxAccount.agentEmail).to.equal(agentEmail);
    expect(mailboxAccount.inboundFeeLamports.toNumber()).to.equal(fee.toNumber());
    expect(mailboxAccount.attestationCount.toNumber()).to.equal(0);
    expect(mailboxAccount.isActive).to.be.true;
  });

  it("2. Records outbound attestation with valid SHA-256 digest", async () => {
    const messageId = `msg_tx_${Date.now()}`;
    const recipient = "investor@enterprise-fund.com";
    const payload = "Execute transfer 500 USDC to Treasury";
    const sha256 = crypto.createHash("sha256").update(payload).digest();

    const [attestationPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("mermail_attest"),
        mailboxPda.toBuffer(),
        Buffer.from(messageId),
      ],
      program.programId
    );

    await program.methods
      .recordAttestation(messageId, recipient, Array.from(sha256), true)
      .accounts({
        mailbox: mailboxPda,
        attestation: attestationPda,
        authority: agentAuthority.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([agentAuthority])
      .rpc();

    const attestationAccount = await program.account.attestationRecord.fetch(attestationPda);
    expect(attestationAccount.mailbox.toBase58()).to.equal(mailboxPda.toBase58());
    expect(attestationAccount.messageId).to.equal(messageId);
    expect(attestationAccount.counterparty).to.equal(recipient);
    expect(Buffer.from(attestationAccount.payloadSha256).toString("hex")).to.equal(sha256.toString("hex"));
    expect(attestationAccount.isOutbound).to.be.true;

    // Verify counter increment
    const mailboxAccount = await program.account.mailboxState.fetch(mailboxPda);
    expect(mailboxAccount.attestationCount.toNumber()).to.equal(1);
  });

  it("3. Fails when unauthorized actor attempts to record attestation", async () => {
    const maliciousMsgId = "msg_hacked_001";
    const dummyHash = new Array(32).fill(0);

    const [maliciousPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("mermail_attest"),
        mailboxPda.toBuffer(),
        Buffer.from(maliciousMsgId),
      ],
      program.programId
    );

    try {
      await program.methods
        .recordAttestation(maliciousMsgId, "victim@domain.com", dummyHash, true)
        .accounts({
          mailbox: mailboxPda,
          attestation: maliciousPda,
          authority: unauthorizedActor.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([unauthorizedActor])
        .rpc();

      expect.fail("Unauthorized signer should have been rejected");
    } catch (err: any) {
      expect(err.toString()).to.include("Unauthorized");
    }
  });

  it("4. Enforces spam prevention fee transfer into Mailbox PDA", async () => {
    const depositAmount = new anchor.BN(0.01 * LAMPORTS_PER_SOL);
    const balanceBefore = await provider.connection.getBalance(mailboxPda);

    await program.methods
      .depositContactEscrow("external-user@company.io", depositAmount)
      .accounts({
        mailbox: mailboxPda,
        payer: unauthorizedActor.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([unauthorizedActor])
      .rpc();

    const balanceAfter = await provider.connection.getBalance(mailboxPda);
    expect(balanceAfter - balanceBefore).to.equal(depositAmount.toNumber());
  });

  it("5. Edge Case: Rejects message exceeding maximum length limits", async () => {
    const giantId = "A".repeat(65); // MAX_TOPIC_LEN is 64
    const dummyHash = new Array(32).fill(1);

    const [attestPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("mermail_attest"),
        mailboxPda.toBuffer(),
        Buffer.from(giantId.slice(0, 32)), // avoid PDA seed length issues
      ],
      program.programId
    );

    try {
      await program.methods
        .recordAttestation(giantId, "test@test.com", dummyHash, false)
        .accounts({
          mailbox: mailboxPda,
          attestation: attestPda,
          authority: agentAuthority.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([agentAuthority])
        .rpc();

      expect.fail("Should have failed for exceeding identifier length");
    } catch (err: any) {
      expect(err.toString()).to.include("IdentifierTooLong");
    }
  });
});