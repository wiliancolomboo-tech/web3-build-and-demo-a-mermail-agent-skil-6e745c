# 1. Clone repository and install dependencies
git clone https://github.com/sponsor-org/mermail-agent-skill.git
cd mermail-agent-skill
npm install

# 2. Build Anchor Smart Contracts
anchor build

# 3. Synchronize Program ID
solana address -k target/deploy/mermail_core-keypair.json
# Ensure program ID matches declare_id!("...") in programs/mermail-core/src/lib.rs

# 4. Deploy to Solana Devnet / Mainnet
solana config set --url https://api.devnet.solana.com
solana airdrop 2
anchor deploy --provider.cluster devnet

# 5. Build Agent Skill TypeScript package
npm run build