import express from "express";
import { Connection } from "@solana/web3.js";

const app = express();
const port = process.env.PORT || 8080;
const connection = new Connection(process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com");

app.get("/healthz", async (_req, res) => {
  try {
    const version = await connection.getVersion();
    res.status(200).json({
      status: "healthy",
      solanaCoreVersion: version["solana-core"],
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    res.status(503).json({ status: "unhealthy", error: err.message });
  }
});

app.listen(port, () => {
  console.log(`Operational telemetry server active on :${port}`);
});