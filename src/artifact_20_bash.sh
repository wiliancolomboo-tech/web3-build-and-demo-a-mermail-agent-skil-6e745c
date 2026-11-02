# 1. Clone repository & install dependencies
git clone https://github.com/mermail-protocol/mermail-solana-skill.git
cd mermail-solana-skill

# 2. Build on-chain Anchor contract
anchor build

# 3. Deploy to Solana Devnet
solana program deploy ./target/deploy/mermail_core.so -u devnet

# 4. Configure local environment
cp .env.example .env
# Edit .env with your actual RESEND_API_KEY

# 5. Execute comprehensive test suite
anchor test

# 6. Run Turnkey Dockerized Relay
docker compose up --build -d