# 1. Clone repository and navigate to root
git clone https://github.com/mermail-solana/mermail-agent-skill.git
cd mermail-agent-skill

# 2. Install dependencies
yarn install

# 3. Synchronize program keys
anchor keys sync

# 4. Build Anchor binary and verify compile validity
anchor build

# 5. Run local test suite covering all PDA edge cases, permission checks, and expiry
anchor test