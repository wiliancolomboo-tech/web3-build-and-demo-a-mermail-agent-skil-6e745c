const http = require('http');
const { Connection } = require('@solana/web3.js');

const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const connection = new Connection(rpcUrl, "confirmed");

async function checkHealth() {
  try {
    const version = await connection.getVersion();
    if (!version) {
      process.exit(1);
    }
    process.exit(0);
  } catch (e) {
    process.exit(1);
  }
}

checkHealth();