# 1. Clone & Bootstrap Workspace
cd /workspace/mermail-gateway
anchor build
anchor test

# 2. Deploy Anchor Program to Solana Devnet
solana program deploy \
  --program-id target/deploy/mermail_gateway-keypair.json \
  target/deploy/mermail_gateway.so \
  --url devnet

# 3. Configure Skill Environment
cd /workspace/mermail-skill
cat << 'EOF' > .env
SOLANA_RPC_URL=https://api.devnet.solana.com
MERMAIL_PROGRAM_ID=<YOUR_DEPLOYED_PROGRAM_ID>
MERMAIL_AGENT_PRIVATE_KEY=[12,34,56,...] # Solana Keypair Secret Key
RESEND_API_KEY="mock_development_token_00000000000000"
MERMAIL_SENDER=agent@mermail.network
EOF

# 4. Build and Link Skill CLI
npm install
npm run build
npm link

# 5. Initialize Agent Profile On-Chain
mermail init-agent --name "LiquidityGuardian" --uri "https://mermail.network/agents/lg.json"

# 6. Execute an End-to-End Test Dispatch
mermail send \
  --name "LiquidityGuardian" \
  --to "treasury-admin@enterprise.com" \
  --subject "Automated Rebalance Executed" \
  --body "Solana Agent rebalanced Vault #402. Profit harvested: 4.82 SOL." \
  --urgent

# 7. Start Standalone Dockerized Worker
docker compose up -d --build
docker logs -f mermail-agent-skill