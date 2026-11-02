import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { MermailSkill } from "../programs/mermail-skill/src/mermail_skill";
import { PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { expect } from "chai";
import { ethers } from "ethers";

describe("mermail_skill protocol tests", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.MermailSkill as Program<any>;
  const agentAuthority = Keypair.generate();
  const recipientClaimant = Keypair.generate();

  let agentPda: PublicKey;
  let agentBump: number;

  before(async () => {
    // Airdrop SOL to test participants
    const airdrop1 = await provider.connection.requestAirdrop(agentAuthority.publicKey, 10 * LAMPORTS_PER_SOL);
    const airdrop2 = await provider.connection.requestAirdrop(recipientClaimant.publicKey, 2 * LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(airdrop1);
    await provider.connection.confirmTransaction(airdrop2);

    [agentPda, agentBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("mermail_agent"), agentAuthority.publicKey.toBuffer()],
      program.programId
    );
  });

  it("1. Successfully registers an agent registry PDA", async () => {
    const tx = await program.methods
      .initializeAgent("AgentZero", "https://mermail.network/metadata.json")
      .accounts({
        agentRegistry: agentPda,
        authority: agentAuthority.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([agentAuthority])
      .rpc();

    expect(tx).to.be.a("string");

    const account = await program.account.agentRegistry.fetch(agentPda);
    expect(account.name).to.equal("AgentZero");
    expect(account.authority.toBase58()).to.equal(agentAuthority.publicKey.toBase58());
    expect(account.totalDispatches.toNumber()).to.equal(0);
  });

  it("2. Dispatches a verified email record with escrow attachment", async () => {
    const agentBefore = await program.account.agentRegistry.fetch(agentPda);
    const currentNonce = agentBefore.totalDispatches.toNumber();

    const nonceBuf = Buffer.alloc(8);
    nonceBuf.writeBigUInt64LE(BigInt(currentNonce));

    const [dispatchPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("mermail_dispatch"), agentPda.toBuffer(), nonceBuf],
      program.programId
    );

    const emailHash = Array.from(Buffer.from(ethers.keccak256(ethers.toUtf8Bytes("enterprise@solana.org")).slice(2), "hex"));
    const payloadHash = Array.from(Buffer.from(ethers.keccak256(ethers.toUtf8Bytes("invoice_claim_amount_1_sol")).slice(2), "hex"));
    const escrowAmount = new anchor.BN(1 * LAMPORTS_PER_SOL);

    const tx = await program.methods
      .dispatchMail(emailHash, payloadHash, "Enterprise Liquidity Invoice #441", escrowAmount)
      .accounts({
        agentRegistry: agentPda,
        mailDispatch: dispatchPda,
        authority: agentAuthority.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([agentAuthority])
      .rpc();

    expect(tx).to.be.a("string");

    const dispatchAccount = await program.account.mailDispatch.fetch(dispatchPda);
    expect(dispatchAccount.subject).to.equal("Enterprise Liquidity Invoice #441");
    expect(dispatchAccount.escrowAmount.toNumber()).to.equal(1 * LAMPORTS_PER_SOL);
    expect(dispatchAccount.status).to.deep.equal({ dispatched: {} });

    // Verify Dispatch PDA holds the escrow balance
    const pdaBalance = await provider.connection.getBalance(dispatchPda);
    expect(pdaBalance).to.be.gte(1 * LAMPORTS_PER_SOL);

    // Verify agent totalDispatches incremented
    const agentAfter = await program.account.agentRegistry.fetch(agentPda);
    expect(agentAfter.totalDispatches.toNumber()).to.equal(currentNonce + 1);
  });

  it("3. Recipient acknowledges mail on-chain and unlocks the escrow", async () => {
    const nonce = 0;
    const nonceBuf = Buffer.alloc(8);
    nonceBuf.writeBigUInt64LE(BigInt(nonce));

    const [dispatchPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("mermail_dispatch"), agentPda.toBuffer(), nonceBuf],
      program.programId
    );

    const balanceBefore = await provider.connection.getBalance(recipientClaimant.publicKey);
    const receiptProof = Array.from(Buffer.from(ethers.keccak256(ethers.toUtf8Bytes("receipt_dkim_verified_ok")).slice(2), "hex"));

    await program.methods
      .acknowledgeMail(receiptProof)
      .accounts({
        mailDispatch: dispatchPda,
        claimant: recipientClaimant.publicKey,
      })
      .signers([recipientClaimant])
      .rpc();

    const dispatchAccount = await program.account.mailDispatch.fetch(dispatchPda);
    expect(dispatchAccount.status).to.deep.equal({ acknowledged: {} });
    expect(dispatchAccount.acknowledgedAt.toNumber()).to.be.greaterThan(0);

    const balanceAfter = await provider.connection.getBalance(recipientClaimant.publicKey);
    expect(balanceAfter).to.be.gt(balanceBefore); // Received 1 SOL escrow (minus minimal tx fee)
  });

  it("4. Prevents duplicate acknowledgment replay attack", async () => {
    const nonce = 0;
    const nonceBuf = Buffer.alloc(8);
    nonceBuf.writeBigUInt64LE(BigInt(nonce));

    const [dispatchPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("mermail_dispatch"), agentPda.toBuffer(), nonceBuf],
      program.programId
    );

    const receiptProof = Array.from(Buffer.alloc(32, 1));
    let failed = false;
    try {
      await program.methods
        .acknowledgeMail(receiptProof)
        .accounts({
          mailDispatch: dispatchPda,
          claimant: recipientClaimant.publicKey,
        })
        .signers([recipientClaimant])
        .rpc();
    } catch (err: any) {
      failed = true;
      expect(err.error.errorCode.code).to.equal("InvalidMailStatus");
    }
    expect(failed).to.be.true;
  });

  it("5. Rejects premature cancellation before timeout threshold", async () => {
    // Dispatch another mail with nonce = 1
    const [dispatchPda2] = PublicKey.findProgramAddressSync(
      [Buffer.from("mermail_dispatch"), agentPda.toBuffer(), Buffer.from([1, 0, 0, 0, 0, 0, 0, 0])],
      program.programId
    );

    const emailHash = Array.from(Buffer.alloc(32, 2));
    const payloadHash = Array.from(Buffer.alloc(32, 3));

    await program.methods
      .dispatchMail(emailHash, payloadHash, "Timeout test", new anchor.BN(0))
      .accounts({
        agentRegistry: agentPda,
        mailDispatch: dispatchPda2,
        authority: agentAuthority.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([agentAuthority])
      .rpc();

    let timeoutFailed = false;
    try {
      // Try to cancel with 86400s timeout immediately
      await program.methods
        .cancelExpiredMail(new anchor.BN(86400))
        .accounts({
          mailDispatch: dispatchPda2,
          authority: agentAuthority.publicKey,
        })
        .signers([agentAuthority])
        .rpc();
    } catch (err: any) {
      timeoutFailed = true;
      expect(err.error.errorCode.code).to.equal("TimeoutNotElapsed");
    }
    expect(timeoutFailed).to.be.true;
  });
});