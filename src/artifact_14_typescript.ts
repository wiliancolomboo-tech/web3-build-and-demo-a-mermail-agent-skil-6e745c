import * as http from "http";

const HEALTH_PORT = process.env.PORT || 8080;
const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "healthy", cluster: RPC_URL, timestamp: Date.now() }));
  } else {
    res.writeHead(404);
    res.end();
  }
});
server.listen(HEALTH_PORT, () => {
  console.log(`[Telemetry] Health endpoint active on :${HEALTH_PORT}/health`);
});