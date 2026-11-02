# Register agent identity
npx ts-node src/cli.ts init-agent \
  --keypair ./keys/agent-keypair.json \
  --identifier "Sentinel-Agent-01"

# Send authenticated message with Resend email delivery
npx ts-node src/cli.ts send \
  --keypair ./keys/agent-keypair.json \
  --channel email \
  --to "treasury@enterprise.io" \
  --subject "Automated Vault Liquidity Rebalance Alert" \
  --body "Autonomous action triggered at slot 284910283. 25,000 USDC rebalanced into dynamic liquidity pool."