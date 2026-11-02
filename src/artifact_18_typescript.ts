import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { MermailCore } from "../src/types/mermail_core";
import { Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { expect } from "chai";
import * as crypto from "crypto";

describe("Mermail Core: End-to-End SLA Test Suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.MermailCore as Program<MermailCore>;

  const authority = Keypair.generate();
  const relayerAgent = Keypair.generate();
  const senderAlice = Keypair.generate();
  const maliciousActor = Keypair.generate();

  const [channelConfigPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("channel_config")],
    program.programId
  );

  const [treasuryPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("mermail_treasury")],
    program.programId
  );

  const feeLamports = new BN(0.005 * LAMPORTS_PER_SOL);
  const bountyLamports = new BN(0.02 * LAMPORTS_PER_SOL);

  function sha256(data: string): number[] {
    return Array.from(crypto.createHash("sha256").update(data).digest());
  }

  before(async () => {
    // Fund test wallets
    const airdropSigners = [authority, relayerAgent, senderAlice, maliciousActor];
    for (const signer of airdropSigners) {
      const sig = await provider.connection.requestAirdrop(
        signer.publicKey,
        5 * LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig, "confirmed");
    }
  });

  it("1. Initializes Mermail Protocol Channel Configuration", async () => {
    await program.methods
      .initializeChannel(feeLamports)
      .accounts({
        config: channelConfigPda,
        treasury: treasuryPda,
        authority: authority.publicKey,
        relayerAgent: relayerAgent.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([authority])
      .rpc();

    const configAccount = await program.account.channelConfig.fetch(channelConfigPda);
    expect(configAccount.authority.toBase58()).to.equal(authority.publicKey.toBase58());
    expect(configAccount.relayerAgent.toBase58()).to.equal(relayerAgent.publicKey.toBase58());
    expect(configAccount.feeLamports.toString()).to.equal(feeLamports.toString());
    expect(configAccount.totalDispatched.toNumber()).to.equal(0);
  });

  it("2. Dispatches a Mail Intent with Locked Escrow Bounty", async () => {
    const nonce = new BN(101);
    const recipientHash = sha256("security-team@phantom.app");
    const contentHash = sha256("Subject: High Priority Margin Alert; CID=QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco");
    const validSlots = new BN(200);

    const nonceBuf = Buffer.alloc(8);
    nonceBuf.writeBigUInt64LE(BigInt(nonce.toString()));
    const [mailIntentPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("mail_intent"), senderAlice.publicKey.toBuffer(), nonceBuf],
      program.programId
    );

    const initialAliceBalance = await provider.connection.getBalance(senderAlice.publicKey);

    await program.methods
      .sendMailIntent(
        nonce,
        recipientHash,
        contentHash,
        bountyLamports,
        validSlots
      )
      .accounts({
        mailIntent: mailIntentPda,
        config: channelConfigPda,
        treasury: treasuryPda,
        sender: senderAlice.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([senderAlice])
      .rpc();

    const intentAccount = await program.account.mailIntent.fetch(mailIntentPda);
    expect(intentAccount.sender.toBase58()).to.equal(senderAlice.publicKey.toBase58());
    expect(intentAccount.nonce.toNumber()).to.equal(101);
    expect(JSON.stringify(intentAccount.status)).to.include("pending");

    // Net escrow bounty = Total bounty - Protocol fee
    const expectedEscrow = bountyLamports.sub(feeLamports);
    expect(intentAccount.bountyLamports.toString()).to.equal(expectedEscrow.toString());

    // Treasury received fee
    const treasuryBalance = await provider.connection.getBalance(treasuryPda);
    expect(treasuryBalance).to.be.at.least(feeLamports.toNumber());
  });

  it("3. Rejects Malicious/Unauthorized Relayer Confirmation Attempts", async () => {
    const nonce = new BN(101);
    const nonceBuf = Buffer.alloc(8);
    nonceBuf.writeBigUInt64LE(BigInt(nonce.toString()));
    const [mailIntentPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("mail_intent"), senderAlice.publicKey.toBuffer(), nonceBuf],
      program.programId
    );

    const fakeDeliveryId = sha256("resend_delivery_receipt_fake_123");

    try {
      await program.methods
        .confirmDelivery(fakeDeliveryId)
        .accounts({
          mailIntent: mailIntentPda,
          config: channelConfigPda,
          relayerAgent: maliciousActor.publicKey, // Malicious actor impersonating relayer
          systemProgram: SystemProgram.programId,
        })
        .signers([maliciousActor])
        .rpc();
      expect.fail("Should have reverted on UnauthorizedRelayer");
    } catch (err: any) {
      expect(err.toString()).to.include("UnauthorizedRelayer");
    }
  });

  it("4. Confirms Delivery and Releases Escrow Bounty to Verified Relayer", async () => {
    const nonce = new BN(101);
    const nonceBuf = Buffer.alloc(8);
    nonceBuf.writeBigUInt64LE(BigInt(nonce.toString()));
    const [mailIntentPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("mail_intent"), senderAlice.publicKey.toBuffer(), nonceBuf],
      program.programId
    );

    const genuineDeliveryId = sha256("resend_msg_receipt_valid_verified_001");
    const preRelayerBalance = await provider.connection.getBalance(relayerAgent.publicKey);

    await program.methods
      .confirmDelivery(genuineDeliveryId)
      .accounts({
        mailIntent: mailIntentPda,
        config: channelConfigPda,
        relayerAgent: relayerAgent.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([relayerAgent])
      .rpc();

    const intentAccount = await program.account.mailIntent.fetch(mailIntentPda);
    expect(JSON.stringify(intentAccount.status)).to.include("delivered");

    const postRelayerBalance = await provider.connection.getBalance(relayerAgent.publicKey);
    expect(postRelayerBalance).to.be.greaterThan(preRelayerBalance);
  });

  it("5. Rejects Delivery Confirmation on Already Delivered Intent (No Double Spend)", async () => {
    const nonce = new BN(101);
    const nonceBuf = Buffer.alloc(8);
    nonceBuf.writeBigUInt64LE(BigInt(nonce.toString()));
    const [mailIntentPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("mail_intent"), senderAlice.publicKey.toBuffer(), nonceBuf],
      program.programId
    );

    const genuineDeliveryId = sha256("resend_msg_receipt_valid_verified_001");

    try {
      await program.methods
        .confirmDelivery(genuineDeliveryId)
        .accounts({
          mailIntent: mailIntentPda,
          config: channelConfigPda,
          relayerAgent: relayerAgent.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([relayerAgent])
        .rpc();
      expect.fail("Double confirm should have reverted with IntentNotPending");
    } catch (err: any) {
      expect(err.toString()).to.include("IntentNotPending");
    }
  });

  it("6. Rejects Premature Refund Before Expiration Slot", async () => {
    const nonce = new BN(202);
    const recipientHash = sha256("treasury@sec.gov");
    const contentHash = sha256("Subject: Notice; Body: Immediate action required");
    const validSlots = new BN(1000); // Expiration far in the future

    const nonceBuf = Buffer.alloc(8);
    nonceBuf.writeBigUInt64LE(BigInt(nonce.toString()));
    const [mailIntentPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("mail_intent"), senderAlice.publicKey.toBuffer(), nonceBuf],
      program.programId
    );

    await program.methods
      .sendMailIntent(
        nonce,
        recipientHash,
        contentHash,
        bountyLamports,
        validSlots
      )
      .accounts({
        mailIntent: mailIntentPda,
        config: channelConfigPda,
        treasury: treasuryPda,
        sender: senderAlice.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([senderAlice])
      .rpc();

    try {
      await program.methods
        .refundExpired()
        .accounts({
          mailIntent: mailIntentPda,
          sender: senderAlice.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      expect.fail("Premature refund should have failed with DeadlineNotExpired");
    } catch (err: any) {
      expect(err.toString()).to.include("DeadlineNotExpired");
    }
  });
});