# 1. Clone & install dependencies
git clone https://github.com/mermail-protocol/mermail-agent-skill.git
cd mermail-agent-skill
npm install

# 2. Build Anchor smart contract & deploy to Solana Devnet
anchor build
solana airdrop 2 $(solana address) --url devnet
anchor deploy --provider.cluster devnet

# 3. Compile TypeScript skill library & CLI
npm run build

# 4. Initialize Agent Mailbox PDA on-chain
node dist/cli.js init \
  --keypair ./agent-wallet.json \
  --email agent@mermail.xyz \
  --fee 0.001

# 5. Dispatch Attested Test Email
node dist/cli.js send \
  --recipient target-auditor@enterprise.com \
  --subject "Automated Daily Treasury Report" \
  --body "All LP pools rebalanced within 0.02% slippage tolerance. Slot: 284910281" \
  --keypair ./agent-wallet.json