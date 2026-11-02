import http from "http";
import * as dotenv from "dotenv";
import { Connection, Keypair } from "@solana/web3.js";
import { MermailEngine } from "./core/mermailEngine";

dotenv.config();

const PORT = process.env.PORT || 3000;
const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";

let isReady = false;
let engine: MermailEngine;

try {
  const secret = process.env.SOLANA_PRIVATE_KEY;
  if (!secret) {
    throw new Error("Missing SOLANA_PRIVATE_KEY");
  }
  const keypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(secret)));
  const connection = new Connection(RPC_URL, "confirmed");

  engine = new MermailEngine({
    connection,
    agentKeypair: keypair,
    resendApiKey: process.env.RESEND_API_KEY || "mock",
    slackWebhookUrl: process.env.SLACK_WEBHOOK_URL,
  });

  isReady = true;
  console.log(`[+] Mermail Agent Skill Daemon initialized successfully.`);
  console.log(`[+] Authority Public Key: ${keypair.publicKey.toBase58()}`);
} catch (err: any) {
  console.error(`[!] Daemon initialization warning: ${err.message}`);
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    if (!isReady) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "DEGRADED", reason: "Engine uninitialized" }));
      return;
    }

    try {
      const slot = await engine.connection.getSlot();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "HEALTHY",
          uptime: process.uptime(),
          solanaSlot: slot,
          agentAuthority: engine.wallet.publicKey.toBase58(),
          timestamp: new Date().toISOString(),
        })
      );
    } catch (err: any) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "RPC_ERROR", message: err.message }));
    }
  } else {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Route not found" }));
  }
});

server.listen(PORT, () => {
  console.log(`[✔] Mermail Agent Skill Telemetry server active on port ${PORT}`);
});