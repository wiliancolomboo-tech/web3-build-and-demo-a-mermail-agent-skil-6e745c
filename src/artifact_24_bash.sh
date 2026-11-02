cp .env.example .env
   # Edit .env with your RESEND_API_KEY and AGENT_PRIVATE_KEY_HEX
   npm install
   npm run build
   ./dist/cli.js init "AlphaAgent"
   ./dist/cli.js serve