# Webhook testing (AfterShip) — local development

This file explains how to test the AfterShip webhook handler locally.

Files added:
- `server/simulate-webhook.js` — small Node script that POSTs a sample AfterShip-style payload to your local webhook endpoint.

Quick usage

1. Start the server (default port 3000):

   ```powershell
   node server.js
   ```

2a. Send a simulated webhook by tracking number:

   ```powershell
   node server/simulate-webhook.js --tracking=TRK123456
   ```

2b. Or send by orderId (the script will fetch `/api/orders/:orderId` to find the tracking number):

   ```powershell
   node server/simulate-webhook.js --orderId=ORD123456
   ```

Configuring signatures

- If you want the simulator to compute the HMAC signature header it will use the value of the `AFTERSHIP_SECRET` environment variable if present.
- Alternatively place a `trackingapi_key.json` file next to `server.js` with an `api_secret` or `secret` field. Example:

```json
{
  "api_key": "YOUR_AFTERSHIP_API_KEY",
  "api_secret": "YOUR_AFTERSHIP_WEBHOOK_SECRET"
}
```

When a secret is available the script sets the `aftership-signature` header (base64 HMAC-SHA256) so the server's signature verification path is exercised.

Using ngrok / exposing local server

- To receive real AfterShip webhooks from their service you must expose your local server to the internet (ngrok, localtunnel). Start ngrok and register the forwarded HTTPS URL in AfterShip dashboard as the webhook endpoint.

Local helper script

If you'd like a one-shot helper that downloads ngrok into the repo and runs it, use the included PowerShell helper:

```powershell
# from repo root
powershell -ExecutionPolicy Bypass -File server/start-ngrok.ps1
```

The script places the ngrok binary in `server/.tools/ngrok.exe` (the binary itself is not committed to git). This makes it easy to run ngrok on Windows without manual installation.

Notes

- The script posts a minimal payload with one `in_transit` checkpoint. Edit the script to send other tags or multiple checkpoints for testing.
- The server's webhook route is `/api/aftership/webhook` (see `server.js`). The route is idempotent and will upsert tracking events into the `OrderTracking` table and try to update the order status.
