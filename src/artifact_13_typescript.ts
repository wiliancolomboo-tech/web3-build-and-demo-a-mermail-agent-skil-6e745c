import http from "http";
import { Connection } from "@solana/web3.js";

const PORT = process.env.PORT || 8080;
const connection = new Connection(process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com");

const server = http.createServer(async (req, res) => {
  if (req.url === "/health" && req.method === "GET") {
    try {
      const slot = await connection.getSlot("confirmed");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "HEALTHY",
          solanaCurrentSlot: slot,
          timestamp: new Date().toISOString(),
          uptimeSeconds: process.uptime(),
        })
      );
    } catch (err: any) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "DEGRADED",
          error: err.message,
        })
      );
    }
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(PORT, () => {
  console.log(`[HealthCheck] Diagnostic server operational on port ${PORT}`);
});