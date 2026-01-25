# Troubleshooting HTTP 405 (Method Not Allowed) — ShoePao

This document explains the common causes of HTTP 405 errors that admins and developers occasionally encounter when using the tracking/admin APIs and how to resolve them. It also lists safeguards we've added to the repository and recommended steps to avoid 405s in development.

## Summary of changes applied to reduce 405s
- Added `PATCH` to the server-side CORS allowed methods in `server.js`.
- Added `PATCH` to the `Access-Control-Allow-Methods` header emitted by `server-proxy.php`.
- Implemented a safe retry in `server-proxy.php`: when a proxied backend responds with 405 to a `PATCH` request, the proxy will retry once using `PUT`. This helps when some local backends/frameworks accept `PUT` but not `PATCH`.
- Kept the `ensure-server.js` client outbox in place to queue POST/PUT writes when the backend is unreachable (prevents clients re-trying with methods while network is down).

## Why 405 happens (common causes)
1. Backend not running (Node server down)
   - The proxy or page may reach PHP/Apache but the Node backend (http://127.0.0.1:3000) isn't running; the proxy may respond with a 502 or the backend may be misconfigured and return 405 for unknown routes.
2. CORS preflight mismatch (OPTIONS or PATCH not allowed)
   - Browser preflight uses `OPTIONS`. If the server/proxy doesn't respond with `Access-Control-Allow-Methods` including the requested method (e.g., `PATCH`) the browser blocks the request and you may see a 405 from an intermediary.
3. Proxy forwarding the wrong method
   - Some proxies or forwarding layers may rewrite or block certain HTTP verbs. Our proxy now preserves the original method and retries PATCH→PUT when needed.
4. Backend route doesn't accept that verb
   - Server implementations sometimes only register `PUT` handlers and not `PATCH`. If client uses PATCH, server returns 405.
5. Incorrect request URL or trailing slash differences
   - The backend may treat `/api/orders/123` and `/api/orders/123/` differently. Ensure exact path formatting.
6. Authentication or firewall/input filtering
   - Some hosts or local dev tools may respond with 405 for requests blocked by mod_security or other filters.

## Recommended verification steps (quick checklist)
- Does the Node server run locally?
  - Check `server-out.log` and `server-err.log` in the project root (if started via `tools/start-node.ps1`).
  - Or run `node server.js` from project root and confirm `Listening` message.
- Is the proxy target reachable?
  - From a terminal: `curl -I http://127.0.0.1:3000/` should return 200/404 depending on route.
- Is the request method allowed by the backend?
  - If the backend returns 405 for `PATCH`, try `PUT` to the same URL; if `PUT` works, our server-proxy retry should help.
- Are preflight OPTIONS requests answered with the expected headers?
  - Use: `curl -X OPTIONS -i http://localhost/server-proxy.php/api/orders -H 'Origin: http://localhost' -H 'Access-Control-Request-Method: PATCH'` and inspect `Access-Control-Allow-Methods`.

## How to start the Node server (Windows)
- From project root, run PowerShell (as normal user):

```powershell
# Start Node and background the process; this writes PID to node.pid
tools\start-node.ps1
```

- If you need to register automatic startup (opt-in), set environment variable `AUTO_REGISTER_STARTUP=true` and run node once. See `tools/register-startup.ps1`.

## If someone still sees 405 — triage steps
1. Capture the failing request in browser DevTools Network tab (copy as cURL). Inspect:
   - URL exactly requested
   - Method
   - Request headers including `Origin` and `Access-Control-Request-Method` (preflight)
2. Re-run the request with curl against the proxy and backend:
   - `curl -v -X PATCH 'http://localhost/server-proxy.php/api/orders/123' -H 'Content-Type: application/json'` (observe response)
   - `curl -v -X PUT 'http://127.0.0.1:3000/api/orders/123' -H 'Content-Type: application/json'` (direct backend)
3. Check `server-out.log`/`server-err.log` and `apache` logs for errors.
4. If proxy returns 405 but backend returns 200 for PUT, our proxy retry should fix it; if not, copy both responses and open an issue.

## Additional mitigations (recommended)
- Keep `ensure-server.js` included on admin pages — it provides an outbox for failed writes and rewrites relative `/api/...` paths to the server proxy.
- Standardize client requests to use `PUT` for full updates and `PATCH` only where the server supports it. If unsure, prefer `PUT` in admin UIs.
- Ensure `server-proxy.php` remains at webroot and `PROXY_TARGET` (env) points to correct host when deploying.

## How we changed the code (files edited)
- `server.js` — added `PATCH` to CORS allow methods.
- `server-proxy.php` — added `PATCH` to CORS allow methods and a safe retry (PATCH -> PUT) when backend returns 405.
- `js/ensure-server.js` — already present; it keeps an outbox for queued POST/PUT operations.

If you'd like, I can:
- Add a small health-check endpoint and a visible admin banner when the backend is unavailable.
- Instrument `server-proxy.php` to log proxied request/response codes to a local file for easier triage (low risk).
- Update client pages to prefer PUT for admin updates where appropriate.

Which follow-up would you like me to do next? (Add logging to proxy, add admin health banner, or update client verbs to PUT.)
