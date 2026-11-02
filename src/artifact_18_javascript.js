const express = require('express');
const client = require('prom-client');

const app = express();
const register = new client.Registry();
client.collectDefaultMetrics({ register });

const mailCounter = new client.Counter({
  name: 'mermail_dispatches_total',
  help: 'Total verifiable emails dispatched by Solana agents',
  labelNames: ['status'],
});
register.registerMetric(mailCounter);

app.get('/metrics', async (req, res) => {
  res.setHeader('Content-Type', register.contentType);
  res.end(await register.metrics());
});

app.get('/healthz', (req, res) => {
  res.status(200).json({ status: 'HEALTHY', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 9090;
app.listen(PORT, () => console.log(`Telemetry endpoint live on port ${PORT}`));