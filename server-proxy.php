<?php
// Simple proxy to forward requests from Apache/PHP (XAMPP) to the local Node API
// Drop this file at the project webroot so front-end calls to /server-proxy.php/api/... are proxied
// to the Node server at http://127.0.0.1:3000.

// Configuration: backend target (adjust port if your node server listens elsewhere)
$BACKEND = getenv('PROXY_TARGET') ?: 'http://127.0.0.1:3000';

// Compute path to forward: remove the script name (e.g. /server-proxy.php) from the URI
// Compute script base robustly: handle cases where SCRIPT_NAME may not exactly appear in REQUEST_URI
$script = isset($_SERVER['SCRIPT_NAME']) ? $_SERVER['SCRIPT_NAME'] : '/server-proxy.php';
$uri = isset($_SERVER['REQUEST_URI']) ? $_SERVER['REQUEST_URI'] : '/';
// Remove only the first occurrence of the script name to compute forwarded path
$path = preg_replace('#' . preg_quote($script, '#') . '#', '', $uri, 1);
if ($path === null) $path = '';
// include query string if present
$query = isset($_SERVER['QUERY_STRING']) && strlen($_SERVER['QUERY_STRING']) ? ('?' . $_SERVER['QUERY_STRING']) : '';
$url = rtrim($BACKEND, '/') . $path . $query;

// Allow quick health check via browser
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    // Allow common and custom headers used by clients and services (AfterShip, X- headers, etc.)
    header('Access-Control-Allow-Origin: *');
    header('Access-Control-Allow-Methods: GET,POST,PUT,DELETE,OPTIONS,PATCH');
    header('Access-Control-Allow-Headers: Content-Type, Authorization, Aftership-Signature, AfterShip-Signature, X-Requested-With, Accept');
    header('Access-Control-Max-Age: 1728000');
    http_response_code(200);
    exit;
}

// We'll attempt multiple backend hosts if the primary target isn't reachable.
// This helps when PHP/cURL can't connect to one localhost address (IPv4 vs IPv6)
// but the Node server is listening on another.
function get_request_headers_lower(){
    $headers = [];
    if (function_exists('getallheaders')){
        foreach (getallheaders() as $k => $v) $headers[$k] = $v;
    } else {
        foreach ($_SERVER as $k => $v) {
            if (substr($k, 0, 5) === 'HTTP_') {
                $name = str_replace(' ', '-', ucwords(strtolower(str_replace('_', ' ', substr($k, 5)))));
                $headers[$name] = $v;
            }
        }
    }
    return $headers;
}

$reqHeaders = get_request_headers_lower();
$forwardHeaders = [];
foreach ($reqHeaders as $hk => $hv){
    $lk = strtolower($hk);
    // Skip hop-by-hop headers that must not be forwarded
    if (in_array($lk, ['host','content-length','connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade'])) continue;
    $forwardHeaders[] = $hk . ': ' . $hv;
}
// Ensure a content-type header is present when a body exists
$body = file_get_contents('php://input');
if ($body !== false && strlen($body) && !array_filter($forwardHeaders, function($h){ return stripos($h,'content-type:') === 0; })) {
    $forwardHeaders[] = 'Content-Type: application/json';
}
// Prepare candidate backend URLs to try. $BACKEND may be set via PROXY_TARGET.

// Build bases to probe for a healthy backend before attempting full proxying.
$bases = [];
$primary = rtrim($BACKEND, '/');
if ($primary) $bases[] = $primary;
// Add common alternatives: localhost hostname (may resolve to IPv6), explicit 127.0.0.1, and IPv6 ::1
$bases[] = 'http://localhost:3000';
$bases[] = 'http://127.0.0.1:3000';
$bases[] = 'http://[::1]:3000';

// Try probing /api/health on each base to find a healthy backend quickly.
$healthyBase = null;
foreach ($bases as $b) {
    $healthUrl = rtrim($b, '/') . '/api/health';
    $chh = curl_init($healthUrl);
    curl_setopt($chh, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($chh, CURLOPT_NOBODY, true);
    curl_setopt($chh, CURLOPT_CONNECTTIMEOUT, 1);
    curl_setopt($chh, CURLOPT_TIMEOUT, 2);
    $hresp = curl_exec($chh);
    if ($hresp !== false) {
        $hinfo = curl_getinfo($chh);
        $hcode = isset($hinfo['http_code']) ? intval($hinfo['http_code']) : 0;
        if ($hcode >= 200 && $hcode < 300) { $healthyBase = $b; curl_close($chh); break; }
    }
    curl_close($chh);
}

$candidates = [];
if ($healthyBase) {
    // Prefer the healthy base we found
    $candidates[] = rtrim($healthyBase, '/') . $path . $query;
} else {
    // Fall back to trying all bases (this preserves previous behavior)
    if ($primary) $candidates[] = $primary . $path . $query;
    $candidates[] = 'http://localhost:3000' . $path . $query;
    $candidates[] = 'http://127.0.0.1:3000' . $path . $query;
    $candidates[] = 'http://[::1]:3000' . $path . $query;
}

$resp = false;
$info = null;
$lastErr = '';
foreach ($candidates as $candidateUrl) {
    $ch = curl_init($candidateUrl);
    $method = isset($_SERVER['REQUEST_METHOD']) ? $_SERVER['REQUEST_METHOD'] : 'GET';
    curl_setopt($ch, CURLOPT_CUSTOMREQUEST, $method);
    if (count($forwardHeaders)) curl_setopt($ch, CURLOPT_HTTPHEADER, $forwardHeaders);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_HEADER, true);
    curl_setopt($ch, CURLOPT_FOLLOWLOCATION, false);
    if ($body !== false && strlen($body)) {
        curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
    }
    // short timeout for local backends
    curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 2);
    curl_setopt($ch, CURLOPT_TIMEOUT, 5);

    $resp = curl_exec($ch);
    if ($resp === false) {
        $lastErr = curl_error($ch);
        curl_close($ch);
        // try next candidate
        continue;
    }
    $info = curl_getinfo($ch);
    curl_close($ch);
    // successful exec; break out
    break;
}

if ($resp === false) {
    http_response_code(502);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'proxy_execution_failed', 'detail' => $lastErr]);
    exit;
}

$header_size = isset($info['header_size']) ? $info['header_size'] : 0;
$resp_headers_raw = substr($resp, 0, $header_size);
$resp_body = substr($resp, $header_size);
$http_code = isset($info['http_code']) ? intval($info['http_code']) : 200;

// Forward selected response headers
$lines = preg_split('/\r?\n/', $resp_headers_raw);
foreach ($lines as $line) {
    if (strlen(trim($line)) === 0) continue;
    // skip HTTP/1.x status line
    if (stripos($line, 'HTTP/') === 0) continue;
    $p = strpos($line, ':');
    if ($p === false) continue;
    $hn = trim(substr($line, 0, $p));
    $hv = trim(substr($line, $p+1));
    $hn_l = strtolower($hn);
    if (in_array($hn_l, ['transfer-encoding','content-length','connection','keep-alive'])) continue;
    header($hn . ': ' . $hv);
}

// CORS permissive for dev
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET,POST,PUT,PATCH,DELETE,OPTIONS');

// If backend returned 405 (Method Not Allowed) and the original method was PATCH,
// retry once using PUT (some backends / frameworks accept PUT but not PATCH).
if ($http_code === 405 && isset($method) && strtoupper($method) === 'PATCH') {
    // attempt a retry with PUT
    $ch2 = curl_init($candidateUrl);
    curl_setopt($ch2, CURLOPT_CUSTOMREQUEST, 'PUT');
    if (count($forwardHeaders)) curl_setopt($ch2, CURLOPT_HTTPHEADER, $forwardHeaders);
    curl_setopt($ch2, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch2, CURLOPT_HEADER, true);
    curl_setopt($ch2, CURLOPT_FOLLOWLOCATION, false);
    if ($body !== false && strlen($body)) {
        curl_setopt($ch2, CURLOPT_POSTFIELDS, $body);
    }
    curl_setopt($ch2, CURLOPT_CONNECTTIMEOUT, 2);
    curl_setopt($ch2, CURLOPT_TIMEOUT, 5);
    $resp2 = curl_exec($ch2);
    if ($resp2 !== false) {
        $info2 = curl_getinfo($ch2);
        $header_size2 = isset($info2['header_size']) ? $info2['header_size'] : 0;
        $resp_headers_raw = substr($resp2, 0, $header_size2);
        $resp_body = substr($resp2, $header_size2);
        $http_code = isset($info2['http_code']) ? intval($info2['http_code']) : $http_code;
        // forward headers from the retried response (overwrite previous headers)
        $lines = preg_split('/\r?\n/', $resp_headers_raw);
        foreach ($lines as $line) {
            if (strlen(trim($line)) === 0) continue;
            if (stripos($line, 'HTTP/') === 0) continue;
            $p = strpos($line, ':');
            if ($p === false) continue;
            $hn = trim(substr($line, 0, $p));
            $hv = trim(substr($line, $p+1));
            $hn_l = strtolower($hn);
            if (in_array($hn_l, ['transfer-encoding','content-length','connection','keep-alive'])) continue;
            header($hn . ': ' . $hv);
        }
    }
    curl_close($ch2);
}

http_response_code($http_code);
echo $resp_body;
exit;

?>
