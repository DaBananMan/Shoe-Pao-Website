<?php
// server-proxy.php
// Lightweight PHP proxy that will attempt to start the Node server (server.js)
// if it's not already listening on localhost:3000, then proxy the incoming request
// to http://127.0.0.1:3000. Designed for dev use with XAMPP/Apache.

function is_port_open($host, $port, $timeout = 0.2){
    $errno = 0; $errstr = '';
    $fp = @fsockopen($host, $port, $errno, $errstr, $timeout);
    if ($fp){ fclose($fp); return true; }
    return false;
}

// Quote a path for Windows cmd.exe (use double quotes). escapeshellarg on Windows
// can produce single-quoted strings which cmd.exe does not recognize. This
// helper wraps the value in double-quotes and escapes inner quotes.
function quote_win($s){
    return '"' . str_replace('"', '\\"', $s) . '"';
}

$nodeHost = '127.0.0.1';
$nodePort = 3000;
$docRoot = realpath(__DIR__);

// If Node not listening, try to start it (dev convenience)
if (!is_port_open($nodeHost, $nodePort, 0.25)) {
    // Attempt to start node in background. If Node is not in PATH, you can set full path in server-proxy-config.php
    $serverJs = $docRoot . DIRECTORY_SEPARATOR . 'server.js';
    if (file_exists($serverJs)){
        // Load optional config
        $configPath = $docRoot . DIRECTORY_SEPARATOR . 'server-proxy-config.php';
        $nodeExec = 'node';
        $nodeArgs = '';
        if (file_exists($configPath)){
            try{ $cfg = include $configPath; if (is_array($cfg)) { if (!empty($cfg['node_path'])) $nodeExec = $cfg['node_path']; if (!empty($cfg['node_args'])) $nodeArgs = $cfg['node_args']; } }catch(e){}
        }
        // Ensure popen is available
        if (!function_exists('popen')){
            header('Content-Type: application/json', true, 500);
            echo json_encode(['error' => 'PHP cannot execute shell commands (popen is disabled). Please start Node manually: node server.js']);
            exit;
        }
    // Build command: either use an optional 'starter' script (recommended on Windows)
    // or fall back to starting node directly.
    $logFile = $docRoot . DIRECTORY_SEPARATOR . 'server.log';
    $startLog = $docRoot . DIRECTORY_SEPARATOR . 'server-proxy-start.log';
    // If a starter script is provided in config, use it. This is useful on Windows
    // where a batch wrapper can reliably detach the Node process.
    $cmd = null;
    if (!empty($cfg) && is_array($cfg) && !empty($cfg['starter'])) {
        $starter = $cfg['starter'];
        // If a relative filename was given, make it absolute relative to docRoot
        if (!preg_match('/^[A-Za-z]:\\\\|^\\\\/', $starter)) {
            $starter = $docRoot . DIRECTORY_SEPARATOR . $starter;
        }
        // Execute the starter via cmd /c so it can perform its own start/detach logic
        $cmd = 'cd /d ' . quote_win($docRoot) . ' && cmd /c ' . quote_win($starter) . ' > ' . quote_win($startLog) . ' 2>&1';
    } else {
        // Redirect node stdout/stderr into server.log so we can inspect startup errors
        // Use an explicit empty title for start so quoted executable paths are not treated as the window title
        $cmd = 'cd /d ' . quote_win($docRoot) . ' && cmd /c start "" /B ' . quote_win($nodeExec) . ' ' . $nodeArgs . ' ' . quote_win($serverJs) . ' > ' . quote_win($logFile) . ' 2>&1';
    }
    // Write the exact command attempted for debugging
    @file_put_contents($startLog, date('c') . " - attempting: " . $cmd . "\n", FILE_APPEND);
    @pclose(@popen($cmd, 'r'));
        // wait up to ~8 seconds for node to come up
        $ok = false;
        for ($i = 0; $i < 32; $i++){
            if (is_port_open($nodeHost, $nodePort, 0.25)) { $ok = true; break; }
            usleep(250000);
        }
        if (!$ok){
            header('Content-Type: application/json', true, 500);
            echo json_encode(['error' => 'Failed to start Node server (server.js). Ensure Node is installed and in PATH, or set the full node path in server-proxy-config.php. Also ensure PHP can execute shell commands (popen).', 'hint' => 'Try running "node -v" and "node server.js" in PowerShell.']);
            exit;
        }
    } else {
        header('Content-Type: application/json', true, 500);
        echo json_encode(['error' => 'server.js not found in project root']);
        exit;
    }
}

// Build target URL
$rawUri = (isset($_SERVER['REQUEST_URI']) ? $_SERVER['REQUEST_URI'] : '/');
// Strip the current script directory (e.g. '/SHOEPAO') from the URI so Node receives the path
$scriptDir = rtrim(dirname($_SERVER['SCRIPT_NAME']), '\/');
$uri = $rawUri;
// If the site is served from a subdirectory (e.g. /SHOEPAO), strip that first.
if ($scriptDir && strpos($uri, $scriptDir) === 0) {
    $uri = substr($uri, strlen($scriptDir));
}
// If the request used path-info (e.g. /server-proxy.php/api/...), strip the
// script filename so the proxied request to Node receives only the intended
// path (/api/...). This avoids forwarding /server-proxy.php/... to Node.
$scriptName = basename($_SERVER['SCRIPT_NAME']);
if ($scriptName && strpos($uri, '/' . $scriptName) === 0) {
    $uri = substr($uri, strlen('/' . $scriptName));
}
if ($uri === '') $uri = '/';
$target = "http://{$nodeHost}:{$nodePort}" . $uri;

// Initialize cURL
$ch = curl_init($target);
$method = $_SERVER['REQUEST_METHOD'];
$headers = [];
// copy request headers
if (function_exists('getallheaders')){
    foreach (getallheaders() as $k => $v){
        // Skip Host header - let cURL set Host
        if (strtolower($k) === 'host') continue;
        $headers[] = $k . ': ' . $v;
    }
}

// Prepare body
$body = file_get_contents('php://input');
if ($method === 'POST'){
    curl_setopt($ch, CURLOPT_POST, true);
    curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
} else {
    curl_setopt($ch, CURLOPT_CUSTOMREQUEST, $method);
    if (strlen($body)) curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
}

curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_HEADER, true);
curl_setopt($ch, CURLOPT_FOLLOWLOCATION, false);
if (!empty($headers)) curl_setopt($ch, CURLOPT_HTTPHEADER, $headers);
// forward client IP info
if (!empty($_SERVER['REMOTE_ADDR'])) curl_setopt($ch, CURLOPT_HTTPHEADER, array_merge($headers, ['X-Forwarded-For: ' . $_SERVER['REMOTE_ADDR']]));

$response = curl_exec($ch);
if ($response === false){
    $err = curl_error($ch);
    curl_close($ch);
    header('Content-Type: application/json', true, 502);
    echo json_encode(['error' => 'Proxy request failed', 'detail' => $err]);
    exit;
}

$header_size = curl_getinfo($ch, CURLINFO_HEADER_SIZE);
$http_code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
$resp_hdr = substr($response, 0, $header_size);
$resp_body = substr($response, $header_size);
curl_close($ch);

// Send status code
http_response_code($http_code);

// Forward headers (simple parse)
$lines = preg_split('/\r?\n/', $resp_hdr);
foreach ($lines as $line){
    if (strpos($line, ':') !== false){
        list($hn, $hv) = explode(':', $line, 2);
        $hn = trim($hn); $hv = trim($hv);
        // Skip hop-by-hop headers
        $skip = ['Transfer-Encoding','Connection','Keep-Alive','Proxy-Authenticate','Proxy-Authorization','TE','Trailers','Upgrade'];
        if (in_array($hn, $skip)) continue;
        header($hn . ': ' . $hv, true);
    }
}

// Output body
echo $resp_body;

