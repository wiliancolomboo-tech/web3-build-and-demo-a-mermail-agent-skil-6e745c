const http = require("http");
const port = process.env.PORT || 8080;

const server = http.createServer((req, res) => {
  if (req.url === "/health" || req.url === "/metrics") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "UP",
        agentSkill: "mermail-agent-skill",
        timestamp: new Date().toISOString(),
        solanaCluster: process.env.SOLANA_RPC_URL || "devnet",
        uptimeSeconds: process.uptime(),
      })
    );
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(port, () => {
  console.log(`[+] Mermail Agent Skill Telemetry running on port ${port}`);
});