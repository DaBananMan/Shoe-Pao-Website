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

$ch = curl_init($url);

// If this is a create-account-doc request, attempt to write a local Users/{email}.txt
// This provides a PHP-side fallback for environments where the Node server or
// firebase-admin is not available. The file contains non-sensitive signup details
// (do not include passwords). Errors here are non-fatal — we continue proxying.
$requestPath = $path;
if (stripos($requestPath, '/api/create-account-doc') === 0) {
    try{
        $raw = $body ?: '';
        $data = json_decode($raw, true);
        if (is_array($data)) {
            $email = isset($data['profile']['email']) ? $data['profile']['email'] : (isset($data['email']) ? $data['email'] : null);
            if (!$email && isset($data['profile']) && is_array($data['profile']) && isset($data['profile']['email'])) $email = $data['profile']['email'];
            if ($email) {
                $firstName = isset($data['profile']['firstName']) ? $data['profile']['firstName'] : (isset($data['profile']['name']) ? $data['profile']['name'] : '');
                $phone = isset($data['profile']['phone']) ? $data['profile']['phone'] : '';
                $addressMain = isset($data['profile']['addressMain']) ? $data['profile']['addressMain'] : '';
                $addressDetails = isset($data['profile']['addressDetails']) ? $data['profile']['addressDetails'] : '';
                $uid = isset($data['uid']) ? $data['uid'] : '';
                // Sanitize email for filename
                $safe = preg_replace('/[^a-zA-Z0-9@._+-]/', '_', $email);
                $usersDir = __DIR__ . DIRECTORY_SEPARATOR . 'Users';
                if (!is_dir($usersDir)) { @mkdir($usersDir, 0755, true); }
                $filePath = $usersDir . DIRECTORY_SEPARATOR . $safe . '.txt';
                $lines = [];
                $lines[] = 'Email: ' . $email;
                $lines[] = 'UID: ' . $uid;
                $lines[] = 'Name: ' . $firstName;
                if ($phone) $lines[] = 'Phone: ' . $phone;
                if ($addressMain) $lines[] = 'Address: ' . $addressMain;
                if ($addressDetails) $lines[] = 'Address details: ' . $addressDetails;
                $lines[] = 'CreatedAt: ' . date('c');
                $lines[] = '';
                $lines[] = 'Full profile JSON:';
                $lines[] = json_encode($data['profile']);
                @file_put_contents($filePath, implode("\n", $lines));
                // Return success immediately so this endpoint can be used without a Node backend.
                header('Content-Type: application/json');
                echo json_encode(['ok' => true]);
                exit;
            }
        }
    }catch(Exception $e){ /* non-fatal */ }
}

// method
$method = isset($_SERVER['REQUEST_METHOD']) ? $_SERVER['REQUEST_METHOD'] : 'GET';
curl_setopt($ch, CURLOPT_CUSTOMREQUEST, $method);

// copy request headers
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
if (count($forwardHeaders)) curl_setopt($ch, CURLOPT_HTTPHEADER, $forwardHeaders);

curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_HEADER, true); // capture response headers
curl_setopt($ch, CURLOPT_FOLLOWLOCATION, false);

if ($body !== false && strlen($body)) {
    curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
}

// execute
$resp = curl_exec($ch);
if ($resp === false) {
    http_response_code(502);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'proxy_execution_failed', 'detail' => curl_error($ch)]);
    curl_close($ch);
    exit;
}

$info = curl_getinfo($ch);
$header_size = isset($info['header_size']) ? $info['header_size'] : 0;
$resp_headers_raw = substr($resp, 0, $header_size);
$resp_body = substr($resp, $header_size);
$http_code = isset($info['http_code']) ? intval($info['http_code']) : 200;
curl_close($ch);

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
header('Access-Control-Allow-Methods: GET,POST,PUT,DELETE,OPTIONS');

http_response_code($http_code);
echo $resp_body;
exit;

?>
