const http = require("http");
const { MermailAgentSkill } = require("./mermail-skill");
const bs58 = require("bs58");

const PORT = process.env.PORT || 8080;

const secretKey = process.env.SOLANA_PRIVATE_KEY_BASE58 
  ? bs58.decode(process.env.SOLANA_PRIVATE_KEY_BASE58) 
  : new Uint8Array(64);

const skill = new MermailAgentSkill({
  rpcUrl: process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com",
  agentSecretKey: secretKey,
  mermailApiKey: process.env.MERMAIL_API_KEY || "test_key",
  resendApiKey: process.env.RESEND_API_KEY,
  programId: process.env.PROGRAM_ID || "Merm111111111111111111111111111111111111111",
  defaultSenderEmail: process.env.DEFAULT_SENDER || "agent@mermail.xyz",
});

const server = http.createServer(async (req, res) => {
  // Liveness & Readiness Probe
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ 
      status: "healthy", 
      agent: skill.getAgentPublicKey(), 
      timestamp: Date.now() 
    }));
  }

  // Mermail Webhook Inbound Handler
  if (req.method === "POST" && req.url === "/api/v1/agent/action") {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", async () => {
      try {
        const payload = JSON.parse(body);
        const txSig = await skill.handleInboundAction(payload);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, txSignature: txSig }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
});

server.listen(PORT, () => {
  console.log(`[MermailSkill] Enterprise Worker daemon active on port ${PORT}`);
});