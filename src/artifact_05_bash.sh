# 1. Clone repository & install dependencies
git clone https://github.com/enterprise/mermail-solana-agent.git
cd mermail-solana-agent
npm install

# 2. Build Anchor smart contract
anchor build

# 3. Deploy to Solana Devnet
solana config set --url https://api.devnet.solana.com
solana airdrop 2
anchor deploy --provider.cluster devnet

# 4. Run test suite
anchor test