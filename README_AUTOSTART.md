Automatic server start options (Windows)
=====================================

This project contains a Node/Express API server (server.js). On a development machine running Apache/XAMPP, you can make the Node server start automatically using one of the options below.

Files included in this repo to help:
- start-server.bat  -- simple batch script that starts node server.js in the background and writes server.log in the project root.
- start-server.ps1  -- PowerShell script that starts node server.js and redirects stdout/stderr to server.log.

Approach A - PM2 (recommended for daemonized process)
 1) Install PM2 globally:
    npm install -g pm2
 2) Start the app with PM2 from the project root:
    pm2 start server.js --name shoepao
    pm2 save
 3) Configure PM2 to start at system boot. On Windows, see PM2 Windows docs or create a scheduled task that runs `pm2 resurrect` on logon.

Approach B - Windows Task Scheduler (no extra packages)
 1) Create a scheduled task that runs at user logon (or system startup) and executes the included PowerShell script.
 2) Example action (Program/script):
    C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe
    Arguments:
    -NoProfile -ExecutionPolicy Bypass -File "C:\xampp\htdocs\SHOEPAO\start-server.ps1"
 3) Configure the task to run whether user is logged in or not, and set highest privileges if needed.

Approach C - NSSM (create a Windows service)
 1) Download NSSM (the Non-Sucking Service Manager) and install it.
 2) Example NSSM command:
    nssm install ShoePao "C:\Program Files\nodejs\node.exe" "C:\xampp\htdocs\SHOEPAO\server.js"
 3) Configure stdout/stderr logs in NSSM, then start the service with nssm start ShoePao.

Notes and troubleshooting
- If better-sqlite3 fails to install, install the Visual Studio Build Tools (C++ workload) and Python 3, then re-run npm install.
- If Apache's PHP proxy attempts to auto-start Node but fails because popen is disabled in php.ini, use one of the approaches above instead.
- If the PHP proxy is used, set node_path inside server-proxy-config.php to the absolute path of node.exe to help it start Node when possible.

Quick run commands (manual)
- From CMD: start-server.bat
- From PowerShell: powershell -ExecutionPolicy Bypass -File .\start-server.ps1

If you'd like I can add a small PowerShell that registers a scheduled task for you (requires admin). Tell me which approach you prefer and I can add the scaffolding.
