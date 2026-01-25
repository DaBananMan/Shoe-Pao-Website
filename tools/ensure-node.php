<?php
// tools/ensure-node.php
// Lightweight helper for local development: checks whether the Node backend is
// reachable on 127.0.0.1:3000 and if not, attempts to start it using the
// project's PowerShell helper `tools/start-node.ps1`.
// This script intentionally restricts usage to local requests only.

header('Content-Type: application/json');

$remote = isset($_SERVER['REMOTE_ADDR']) ? $_SERVER['REMOTE_ADDR'] : '';
// Allow only localhost callers for safety
if (!in_array($remote, ['127.0.0.1','::1','::ffff:127.0.0.1'])) {
    http_response_code(403);
    echo json_encode(['ok'=>false,'error'=>'forbidden','detail'=>'only localhost may call this endpoint']);
    exit;
}

$backend = getenv('PROXY_TARGET') ?: 'http://127.0.0.1:3000';
$status = ['ok'=>false,'running'=>false,'started'=>false,'detail'=>null];

// Simple HTTP GET helper using curl
function http_get($url, &$http_code = null, $timeout=1){
    $ch = curl_init($url);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_NOBODY, false);
    curl_setopt($ch, CURLOPT_HEADER, false);
    curl_setopt($ch, CURLOPT_TIMEOUT, $timeout);
    $body = curl_exec($ch);
    if ($body === false) { $http_code = 0; curl_close($ch); return false; }
    $info = curl_getinfo($ch);
    $http_code = isset($info['http_code']) ? intval($info['http_code']) : 0;
    curl_close($ch);
    return $body;
}

// Check backend health quickly
$hc = 0; $resp = http_get($backend . '/', $hc, 1);
if ($hc >= 200 && $hc < 500) {
    $status['ok'] = true; $status['running'] = true; $status['detail'] = 'backend reachable';
    // Attempt to include pid if available
    $pidFile = __DIR__ . '/../node.pid';
    if (file_exists($pidFile)) {
        $p = trim(@file_get_contents($pidFile)); if ($p) $status['pid'] = $p;
    }
    echo json_encode($status);
    exit;
}

// Not reachable — attempt to start Node using the PowerShell helper if present
$psScript = __DIR__ . DIRECTORY_SEPARATOR . 'start-node.ps1';
if (!file_exists($psScript)) {
    $status['detail'] = 'start script not found: ' . $psScript;
    echo json_encode($status);
    exit;
}

// Build safe command for PowerShell. Use -NoProfile -ExecutionPolicy Bypass
$ps = 'powershell.exe';
$cmd = sprintf('%s -NoProfile -ExecutionPolicy Bypass -File %s', $ps, escapeshellarg($psScript));

// Execute in background. On Windows, `pclose(popen(...))` trick isn't reliable under Apache,
// so use proc_open and return as soon as the command is launched.
$descriptorspec = [
    0 => ['pipe','r'],
    1 => ['pipe','w'],
    2 => ['pipe','w']
];
try{
    $proc = proc_open($cmd, $descriptorspec, $pipes, __DIR__ . '/..');
    if (is_resource($proc)) {
        // read some output for logging
        $out = stream_get_contents($pipes[1]);
        $err = stream_get_contents($pipes[2]);
        fclose($pipes[1]); fclose($pipes[2]);
        // Do not call proc_close here to avoid blocking — let the PS script detach
        // Try polling for a short period to see whether backend becomes available
        $status['started'] = true;
        $status['detail'] = trim($out . ' ' . $err);
    } else {
        // failed to spawn directly. Attempt to start via Scheduled Task if available
        $status['detail'] = 'failed to spawn process';
        // try schtasks (Windows) to run the registered task ShoePaoNode
        $schedResult = null;
        try{
            $schedCmd = 'schtasks /Run /TN "ShoePaoNode" 2>&1';
            $schedResult = shell_exec($schedCmd);
            $status['detail'] .= ' | schtasks: ' . trim((string)$schedResult);
            // also try PowerShell Start-ScheduledTask (some environments prefer this)
            $psCmd = 'powershell.exe -NoProfile -Command "Start-ScheduledTask -TaskName \"ShoePaoNode\"" 2>&1';
            $psResult = shell_exec($psCmd);
            if ($psResult) $status['detail'] .= ' | Start-ScheduledTask: ' . trim((string)$psResult);
        }catch(Exception $e){ $status['detail'] .= ' | sched attempt ex: ' . $e->getMessage(); }
        // continue so we poll for backend availability below
    }
} catch (Exception $e) {
    $status['detail'] = 'exception: ' . $e->getMessage();
    echo json_encode($status);
    exit;
}

// Poll backend for up to ~6 seconds to detect startup
$up = false; $pid = null;
for ($i=0;$i<12;$i++){
    usleep(500000); // 0.5s
    $hc = 0; $r = http_get($backend . '/', $hc, 1);
    if ($hc >= 200 && $hc < 500){ $up = true; break; }
}

if ($up) {
    $status['ok'] = true; $status['running'] = true; $status['detail'] = 'backend started';
    $pidFile = __DIR__ . '/../node.pid';
    if (file_exists($pidFile)) { $p = trim(@file_get_contents($pidFile)); if ($p) $status['pid'] = $p; }
} else {
    $status['detail'] = 'backend not reachable after start attempt';
    // write a small diagnostic file so developers can inspect attempts without apache logs
    try{
        $diag = __DIR__ . DIRECTORY_SEPARATOR . 'ensure-node.log';
        $entry = date('c') . " - ensure-node: backend not reachable. detail: " . (isset($status['detail']) ? $status['detail'] : '') . "\n";
        file_put_contents($diag, $entry, FILE_APPEND | LOCK_EX);
    }catch(Exception $e){ }
}

echo json_encode($status);
exit;

?>
