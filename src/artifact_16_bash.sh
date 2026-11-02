curl -X POST http://localhost:8080/v1/mermail/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "intentId": "d3b07384-d113-494a-9c8e-a9b09a35e012",
    "senderEmail": "treasury@enterprise-dao.com",
    "authorityPubkey": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "recipientPubkey": "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
    "amountSol": 0.05,
    "nonce": 42001,
    "expiryTimestamp": 1893456000,
    "memo": "Turnkey Verification Payout",
    "signatureBase64": "G3eZ0qR8n1h1u..."
  }'