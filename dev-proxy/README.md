Dev proxy for Snap CameraKit API (development only)

This proxy forwards requests from your browser to the Snap CameraKit API and injects permissive CORS headers so you can test the client SDK locally without running into CORS issues.

WARNING: This proxy is for local development only. Do NOT expose it to the public internet. Do not commit real long-lived secrets here.

Quick start

1. Install dependencies (from project root):

```powershell
npm install
# or if you prefer to install only runtime deps for proxy:
# npm install express http-proxy-middleware --save-dev
```

2. (Optional) Set an environment variable with a CameraKit token to have the proxy add an Authorization header to proxied requests:

```powershell
$env:CAMERA_KIT_TOKEN = 'your_token_here'
```

3. Start the proxy:

```powershell
npm run dev-proxy
```

By default the proxy listens on http://localhost:3000 and forwards /camera-kit-api/* -> https://camera-kit-api.snapar.com/*

How to make the CameraKit bundle use the proxy

Option A (recommended for dev): launch Chrome with host resolver rules that map camera-kit-api.snapar.com to localhost and disable certificate checks for this dev instance. This avoids editing your OS hosts file and works for local testing only.

PowerShell command (Windows) — run this and then use the opened Chrome window to test your app:

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --user-data-dir="$env:USERPROFILE\\chrome-dev-session" --host-resolver-rules="MAP camera-kit-api.snapar.com 127.0.0.1" --ignore-certificate-errors
```

Notes:
- `--ignore-certificate-errors` is required because the proxy serves localhost certs that don't match the camera-kit-api.snapar.com certificate. Only use this Chrome instance for local development and close it when done.
- Alternatively, you can set up a proper TLS certificate and add a hosts entry for camera-kit-api.snapar.com pointing to 127.0.0.1, but that is more work.

Option B (quick, less integrated): use a browser CORS extension or start Chrome with --disable-web-security (unsafe). Not recommended.

Proxy customization

- To change the upstream target, set environment variable `CAMERA_KIT_API_TARGET` before starting the proxy.
- To inject an Authorization header automatically, export `CAMERA_KIT_TOKEN` before starting the proxy.

Example (PowerShell):

```powershell
$env:CAMERA_KIT_TOKEN = 'eyJ...'
npm run dev-proxy
```

If you prefer, I can also update `AR.js` to allow pointing the client directly at `http://localhost:3000/camera-kit-api` rather than using hostname rewriting; tell me if you'd like that change.
