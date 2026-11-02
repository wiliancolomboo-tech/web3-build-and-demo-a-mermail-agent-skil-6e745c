# Set cluster configuration
solana config set --url https://api.devnet.solana.com

# Build and sync Anchor program keys
anchor build
solana address -k target/deploy/mermail_core-keypair.json
# (Paste address into declare_id! inside programs/mermail_core/src/lib.rs)

# Final deploy
anchor deploy --provider.cluster devnet