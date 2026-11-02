# 1. Build Solana Anchor Program
anchor build

# 2. Synchronize Program ID
solana address -k target/deploy/mermail_gateway-keypair.json
# (Paste output into declare_id! in src/lib.rs and Anchor.toml)

# 3. Deploy to Solana Devnet
solana config set --url https://api.devnet.solana.com
anchor deploy --provider.cluster devnet

# 4. Run the comprehensive automated test suite
npm install
anchor test