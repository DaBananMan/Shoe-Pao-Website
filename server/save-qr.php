<?php
// server/save-qr.php
// Accepts POST { payload, size } and saves a static QR PNG under IMAGE/QR_<hash>.png
// Returns JSON { url: 'IMAGE/QR_<hash>.png' }

header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET,POST,OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(200); exit; }

function json_res($code, $data){ http_response_code($code); header('Content-Type: application/json'); echo json_encode($data); exit; }

$raw = file_get_contents('php://input');
$data = json_decode($raw, true);
if (!$data) $data = $_POST;

$payload = isset($data['payload']) ? (string)$data['payload'] : '';
$size = isset($data['size']) ? intval($data['size']) : 240;
if ($size <= 0) $size = 240;
if (strlen($payload) === 0) json_res(400, ['error' => 'missing_payload']);
if (strlen($payload) > 1024) json_res(400, ['error' => 'payload_too_long']);

$hash = substr(sha1($payload . '|' . $size), 0, 16);
$filename = 'QR_' . $hash . '.png';

$imageDir = realpath(__DIR__ . '/../IMAGE');
if (!$imageDir) {
    // try to create IMAGE folder relative to project root
    $imageDir = __DIR__ . '/../IMAGE';
}

$fullpath = rtrim($imageDir, DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR . $filename;

// If already exists, return it
if (file_exists($fullpath)){
    json_res(200, ['url' => 'IMAGE/' . $filename, 'cached' => true]);
}

// Build QR API URL
$api = 'https://api.qrserver.com/v1/create-qr-code/?size=' . urlencode($size . 'x' . $size) . '&data=' . urlencode($payload);

$ch = curl_init($api);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_FOLLOWLOCATION, true);
curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 5);
curl_setopt($ch, CURLOPT_TIMEOUT, 10);
curl_setopt($ch, CURLOPT_USERAGENT, 'ShoePao-QR-Saver/1.0');
$body = curl_exec($ch);
$info = curl_getinfo($ch);
$err = curl_error($ch);
curl_close($ch);

if ($body === false || !$info){ json_res(502, ['error' => 'fetch_failed', 'detail' => $err]); }

$http = isset($info['http_code']) ? intval($info['http_code']) : 0;
if ($http < 200 || $http >= 300){ json_res(502, ['error' => 'qr_api_error', 'http_code' => $http]); }

$ctype = isset($info['content_type']) ? $info['content_type'] : '';
if (strpos($ctype, 'image') === false){ json_res(502, ['error' => 'unexpected_content_type', 'content_type' => $ctype]); }

$maxBytes = 300 * 1024; // 300 KB
if (strlen($body) > $maxBytes){ json_res(413, ['error' => 'qr_too_large']); }

// Ensure IMAGE directory exists
if (!is_dir($imageDir)){
    if (!mkdir($imageDir, 0755, true)) { json_res(500, ['error' => 'could_not_create_image_dir']); }
}

$w = file_put_contents($fullpath, $body, LOCK_EX);
if ($w === false){ json_res(500, ['error' => 'could_not_save_file']); }

json_res(200, ['url' => 'IMAGE/' . $filename, 'cached' => false]);

?>
