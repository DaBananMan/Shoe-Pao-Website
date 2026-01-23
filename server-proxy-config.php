<?php
// Optional config for server-proxy.php
// Return an array with optional keys:
// - 'node_path' : full path to node executable (e.g., 'C:\\Program Files\\nodejs\\node.exe')
// - 'node_args' : additional args to pass to node when starting (string)
// Example:
// return ['node_path' => 'C:\\Program Files\\nodejs\\node.exe', 'node_args' => ''];

return [
    'node_path' => 'C:\\Program Files\\nodejs\\node.exe',
    'node_args' => '',
    // Optional: a starter batch/script that will launch Node in a detached/background way.
    // If provided, the proxy will execute this script instead of invoking node directly.
    // Provide the absolute path to the starter script, for example:
    // 'starter' => 'C:\\xampp\\htdocs\\SHOEPAO\\start-server.bat'
    'starter' => 'C:\\xampp\\htdocs\\SHOEPAO\\start-server.bat'
];
