import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { MermailGuard } from "../target/types/mermail_guard";
import { PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { expect } from "chai";
import crypto from "crypto";

describe("mermail_guard Anchor Integration Tests", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.MermailGuard as Program<MermailGuard>;
  const authority = provider.wallet as anchor.Wallet;
  const agentKeypair = Keypair.generate();
  const recipient = Keypair.generate();

  const email = "treasury@corp.mermail.xyz";
  const emailHash = Array.from(crypto.createHash("sha256").update(email).digest());

  let policyPda: PublicKey;
  let vaultPda: PublicKey;

  const MAX_SINGLE_CAP = new anchor.BN(0.5 * LAMPORTS_PER_SOL);
  const DAILY_CAP = new anchor.BN(1.0 * LAMPORTS_PER_SOL);
  const COOLDOWN_SECONDS = new anchor.BN(3);

  before(async () => {
    [policyPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("mermail_agent_state"), authority.publicKey.toBuffer(), Buffer.from(emailHash)],
      program.programId
    );

    [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("mermail_vault"), policyPda.toBuffer()],
      program.programId
    );

    // Fund the agent keypair for gas
    const fundAgentTx = await provider.connection.requestAirdrop(
      agentKeypair.publicKey,
      2 * LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(fundAgentTx);

    // Fund the vault PDA so it can disburse lamports
    const fundVaultTx = new anchor.web3.Transaction().add(
      SystemProgram.transfer({
        fromPubkey: authority.publicKey,
        toPubkey: vaultPda,
        lamports: 3 * LAMPORTS_PER_SOL,
      })
    );
    await provider.sendAndConfirm(fundVaultTx);
  });

  it("1. Initializes agent policy account successfully", async () => {
    await program.methods
      .initializeAgent(emailHash, MAX_SINGLE_CAP, DAILY_CAP, COOLDOWN_SECONDS)
      .accounts({
        policyAccount: policyPda,
        authority: authority.publicKey,
        agentSigner: agentKeypair.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const policyAccount = await program.account.agentPolicyAccount.fetch(policyPda);
    expect(policyAccount.authority.toBase58()).to.equal(authority.publicKey.toBase58());
    expect(policyAccount.agentSigner.toBase58()).to.equal(agentKeypair.publicKey.toBase58());
    expect(policyAccount.maxSingleCap.toNumber()).to.equal(MAX_SINGLE_CAP.toNumber());
    expect(policyAccount.dailyCap.toNumber()).to.equal(DAILY_CAP.toNumber());
  });

  it("2. Executes valid action within caps", async () => {
    const transferAmount = new anchor.BN(0.1 * LAMPORTS_PER_SOL);
    const msgHash = Array.from(crypto.createHash("sha256").update("msg_001").digest());

    const initialRecipientBal = await provider.connection.getBalance(recipient.publicKey);

    await program.methods
      .executeAction(transferAmount, msgHash)
      .accounts({
        policyAccount: policyPda,
        agentSigner: agentKeypair.publicKey,
        vault: vaultPda,
        recipient: recipient.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([agentKeypair])
      .rpc();

    const updatedRecipientBal = await provider.connection.getBalance(recipient.publicKey);
    expect(updatedRecipientBal - initialRecipientBal).to.equal(0.1 * LAMPORTS_PER_SOL);
  });

  it("3. Rejects action when single transfer cap is exceeded", async () => {
    const invalidAmount = new anchor.BN(0.6 * LAMPORTS_PER_SOL); // Max is 0.5 SOL
    const msgHash = Array.from(crypto.createHash("sha256").update("msg_002").digest());

    try {
      await program.methods
        .executeAction(invalidAmount, msgHash)
        .accounts({
          policyAccount: policyPda,
          agentSigner: agentKeypair.publicKey,
          vault: vaultPda,
          recipient: recipient.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([agentKeypair])
        .rpc();
      expect.fail("Expected transaction to fail due to single cap excess");
    } catch (err: any) {
      expect(err.error.errorMessage).to.include("Action exceeds single-transaction transfer cap.");
    }
  });

  it("4. Enforces cooldown interval between executions", async () => {
    const validAmount = new anchor.BN(0.1 * LAMPORTS_PER_SOL);
    const msgHash = Array.from(crypto.createHash("sha256").update("msg_003").digest());

    try {
      // Immediate call without waiting 3 seconds
      await program.methods
        .executeAction(validAmount, msgHash)
        .accounts({
          policyAccount: policyPda,
          agentSigner: agentKeypair.publicKey,
          vault: vaultPda,
          recipient: recipient.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([agentKeypair])
        .rpc();
      expect.fail("Expected cooldown check to fail");
    } catch (err: any) {
      expect(err.error.errorMessage).to.include("Agent action cooldown period has not elapsed.");
    }
  });

  it("5. Rejects execution from unauthorized rogue signer", async () => {
    const rogueKeypair = Keypair.generate();
    const airdrop = await provider.connection.requestAirdrop(rogueKeypair.publicKey, LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(airdrop);

    // Wait 3 seconds to clear cooldown
    await new Promise((r) => setTimeout(r, 3100));

    const validAmount = new anchor.BN(0.05 * LAMPORTS_PER_SOL);
    const msgHash = Array.from(crypto.createHash("sha256").update("msg_004").digest());

    try {
      await program.methods
        .executeAction(validAmount, msgHash)
        .accounts({
          policyAccount: policyPda,
          agentSigner: rogueKeypair.publicKey,
          vault: vaultPda,
          recipient: recipient.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([rogueKeypair])
        .rpc();
      expect.fail("Unauthorized signer must be rejected");
    } catch (err: any) {
      expect(err.error.errorMessage).to.include("Operator is not authorized");
    }
  });
});