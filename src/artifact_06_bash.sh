# 1. Build and verify Anchor Smart Contract
anchor build

# 2. Deploy to Solana Devnet / Mainnet
solana program deploy ./target/deploy/mermail_agent_gate.so \
  --program-id MermAiL111111111111111111111111111111111111 \
  --url https://api.devnet.solana.com

# 3. Build & Run Containerized Skill Worker
docker-compose up -d --build

# 4. Confirm Service Telemetry & Health
curl -s http://localhost:8080/healthz | jq