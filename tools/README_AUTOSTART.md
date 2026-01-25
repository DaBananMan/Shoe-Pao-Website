Auto-start Node server (ShoePao)

This folder contains helper scripts to start/stop the Node server in the background and to register a Scheduled Task so the server starts automatically when you log in.

Files:
- `start-node.ps1` — Starts `npm start` in the project root in the background, writes logs to `server-out.log` and `server-err.log`, and stores the PID in `node.pid`.
- `stop-node.ps1` — Stops the process recorded in `node.pid`.
- `register-startup.ps1` — Registers a Windows Scheduled Task (for the current user) that runs `start-node.ps1` at user logon.
- `unregister-startup.ps1` — Removes the scheduled task created above.

Quick usage (PowerShell):

1) Test start/stop manually (current PowerShell session):

```powershell
# from project root (c:\xampp\htdocs\SHOEPAO)
cd tools
.\start-node.ps1
# verify logs or check that node is listening on port 3000
.\stop-node.ps1
```

2) Register auto-start at logon (runs for the current user):

```powershell
# run once as the user who should own the task
cd c:\xampp\htdocs\SHOEPAO\tools
.\register-startup.ps1
```

3) To remove the scheduled task:

```powershell
.\unregister-startup.ps1
```

Notes and alternatives:
- The scripts assume `npm` and Node.js are installed and available via PATH.
- `register-startup.ps1` registers the scheduled task for the current user and does not require admin privileges if run as that user.
- If you prefer a production-like process manager, consider installing pm2 and the pm2-windows-service package (requires npm global install privileges):

  npm i -g pm2
  pm2 install pm2-windows-service

  Then use `pm2 start server.js --name shoepao` and `pm2 save` to restore on system startup.

- If you need the Node server to run as a system service or under a dedicated account, use NSSM or create a Task Scheduler task configured to run with highest privileges and a service account. Those options may require administrator privileges.

If you'd like, I can register the scheduled task for you now (I can create it in this environment), or add a pm2-based alternative script — tell me which you prefer.

Auto-register from the Node server (optional)
------------------------------------------
If you prefer the Node server to attempt registration automatically when it starts, set the environment variable `AUTO_REGISTER_STARTUP=true` before launching the server on Windows. The server will run `tools/register-startup.ps1` (with `-Force`) and log the result. This is opt-in to avoid unexpected changes on other hosts.