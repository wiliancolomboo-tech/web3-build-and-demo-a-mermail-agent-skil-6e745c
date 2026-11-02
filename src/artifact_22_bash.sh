# 1. Build & Deploy the Anchor Program
anchor build
solana program deploy target/deploy/mermail_agent_skill.so --program-id MermSC1111111111111111111111111111111111111

# 2. Setup Agent Keypair & Environment
mkdir -p secrets
solana-keygen new --no-bip39-passphrase -o secrets/agent-keypair.json
cp .env.example .env

# 3. Launch the Turnkey Relay Daemon Container
docker compose up -d --build

# 4. Monitor Live WebSocket Logs
docker compose logs -f mermail-relay-agent