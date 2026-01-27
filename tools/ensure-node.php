<?php
// ensure-node.php
// Lightweight helper for local dev: ensure the Node API server is running by
// starting the project's start-node.ps1 script if Node is not detected.
// THIS SCRIPT SHOULD ONLY BE USED IN LOCAL/DEV ENVIRONMENTS.

header('Content-Type: application/json');

// Restrict execution to Windows only for now (start-node.ps1 is Windows-specific)
if (strtoupper(PHP_OS_FAMILY ?? '') !== 'WINDOWS') {
    echo json_encode(['ok' => false, 'reason' => 'not-windows']);
    exit(0);
}

// Simple safety: allow only local requests by default
$remote = $_SERVER['REMOTE_ADDR'] ?? '';
if (!in_array($remote, ['127.0.0.1', '::1', 'localhost'])) {
    // allow if explicitly enabled via env var
    if (empty(getenv('ALLOW_REMOTE_NODE_START')) || getenv('ALLOW_REMOTE_NODE_START') !== 'true') {
        echo json_encode(['ok' => false, 'reason' => 'remote_requests_disabled', 'remote' => $remote]);
        exit(0);
    }
}

// Check if node.exe already running
exec('tasklist /FI "IMAGENAME eq node.exe" /NH', $out, $rc);
$running = false;
foreach ($out as $line) {
    if (stripos($line, 'node.exe') !== false) { $running = true; break; }
}
if ($running) {
    echo json_encode(['ok' => true, 'running' => true]);
    exit(0);
}

// Attempt to start the node server via the start-node.ps1 helper.
$script = __DIR__ . DIRECTORY_SEPARATOR . 'start-node.ps1';
if (!file_exists($script)) {
    echo json_encode(['ok' => false, 'reason' => 'script_not_found', 'script' => $script]);
    exit(0);
}

// Build a PowerShell command that starts the helper as a detached process
$psCmd = 'Start-Process -FilePath "powershell.exe" -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File \"' . addslashes($script) . '\"" -WindowStyle Hidden';
$cmd = 'powershell -NoProfile -ExecutionPolicy Bypass -Command "' . $psCmd . '"';

exec($cmd . ' 2>&1', $startOut, $startRc);

// Return the result and any startup output
echo json_encode(['ok' => ($startRc === 0), 'started' => ($startRc === 0), 'out' => $startOut]);
exit(0);

?>
