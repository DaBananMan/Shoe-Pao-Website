<?php
// php_exec_test.php - attempts to run `node -v` via proc_open/shell_exec to verify PHP can execute processes
header('Content-Type: text/plain');
echo "PHP exec test\n\n";
echo "PHP version: " . PHP_VERSION . "\n";
echo "SAPI: " . PHP_SAPI . "\n";
echo "User: ";
if (function_exists('posix_getpwuid')){
    $u = posix_getpwuid(posix_geteuid()); echo ($u && isset($u['name']) ? $u['name'] : 'unknown') . "\n";
} else {
    // On Windows posix isn't available
    echo "(posix not available)\n";
}

$candidates = [
    'node',
    'C:\\Program Files\\nodejs\\node.exe',
    'C:\\Program Files (x86)\\nodejs\\node.exe'
];

foreach ($candidates as $p){
    echo "Trying: $p\n";
    $cmd = escapeshellcmd($p) . ' -v';
    // Try proc_open first
    if (function_exists('proc_open')){
        $descriptors = [1 => ['pipe','w'], 2 => ['pipe','w']];
        $proc = @proc_open($cmd, $descriptors, $pipes);
        if (is_resource($proc)){
            $out = stream_get_contents($pipes[1]); fclose($pipes[1]);
            $err = stream_get_contents($pipes[2]); fclose($pipes[2]);
            $code = proc_close($proc);
            echo "proc_open output:\n" . trim($out) . "\n";
            if(trim($err)) echo "proc_open stderr:\n" . trim($err) . "\n";
            echo "exit code: $code\n\n";
            continue;
        } else {
            echo "proc_open failed to start process\n";
        }
    }
    // Fallback to shell_exec
    if (function_exists('shell_exec')){
        $o = @shell_exec($cmd . ' 2>&1');
        echo "shell_exec output:\n" . trim($o) . "\n\n";
        continue;
    }
    echo "No execution functions available (proc_open/shell_exec)\n\n";
}

echo "\nNote: If this script shows Node version, PHP can execute processes. If not, edit the php.ini (Loaded Configuration File from phpinfo) and remove proc_open/popen/shell_exec/exec/system from disable_functions, then restart Apache.\n";
