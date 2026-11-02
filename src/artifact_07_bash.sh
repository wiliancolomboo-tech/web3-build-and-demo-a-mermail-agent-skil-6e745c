# 1. Clone repository & install dependencies
git clone https://github.com/mermail-protocol/mermail-agent-skill.git
cd mermail-agent-skill
yarn install

# 2. Build Anchor Smart Contracts
anchor build

# 3. Execute Complete Test Matrix (Anchor Localnet)
anchor test

# 4. Deploy Smart Contract to Solana Devnet
solana config set --url https://api.devnet.solana.com
anchor deploy --provider.cluster devnet