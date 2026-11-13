<?php
/**
 * Server capability probe — token gated, read-only, never returns secrets.
 *
 * The 24/7 worker can only run here if the account may spawn processes and an
 * ffmpeg binary exists. This endpoint answers that in one request:
 *   GET /api/diag.php?token=<sha256(VIDKRAKEN_API_KEY . 'diag') first 32 chars>
 *
 * It is deliberately boring: no paths outside the account, no env values, no
 * write operations.
 */
declare(strict_types=1);
require __DIR__ . '/_bootstrap.php';

$want = substr(hash('sha256', (string) env_get('VIDKRAKEN_API_KEY', '') . 'diag'), 0, 32);
$got  = (string) ($_GET['token'] ?? '');
if ($want === '' || !hash_equals($want, $got)) {
    json_out(['error' => 'forbidden'], 403);
}

function run(string $cmd): array {
    $t0 = microtime(true);
    $out = [];
    $code = 127;
    if (function_exists('shell_exec')) {
        $raw = @shell_exec($cmd . ' 2>&1');
        $out = $raw === null ? [] : preg_split('/\r?\n/', trim((string) $raw));
        $code = $raw === null ? 126 : 0;
    } elseif (function_exists('exec')) {
        @exec($cmd . ' 2>&1', $out, $code);
    }
    return ['cmd' => $cmd, 'code' => $code, 'out' => array_slice($out, 0, 6), 'ms' => (int) ((microtime(true) - $t0) * 1000)];
}

function which(string $bin): array {
    $r = run('command -v ' . $bin . ' || which ' . $bin . ' || echo MISSING');
    $line = trim(implode(' ', $r['out']));
    return ['found' => $line !== '' && !str_contains($line, 'MISSING'), 'path' => str_replace((string) getenv('HOME'), '~', $line), 'ms' => $r['ms']];
}

$disabled = array_filter(array_map('trim', explode(',', (string) ini_get('disable_functions'))));
$ffmpeg = which('ffmpeg');
$ffprobe = which('ffprobe');

json_out([
    'php' => PHP_VERSION,
    'sapi' => PHP_SAPI,
    'os' => PHP_OS . ' ' . php_uname('m'),
    'limits' => [
        'memory_limit' => ini_get('memory_limit'),
        'max_execution_time' => ini_get('max_execution_time'),
        'post_max_size' => ini_get('post_max_size'),
        'upload_max_filesize' => ini_get('upload_max_filesize'),
    ],
    'functions' => [
        'shell_exec' => function_exists('shell_exec') && !in_array('shell_exec', $disabled, true),
        'exec' => function_exists('exec') && !in_array('exec', $disabled, true),
        'proc_open' => function_exists('proc_open') && !in_array('proc_open', $disabled, true),
        'pcntl_fork' => function_exists('pcntl_fork'),
        'curl' => function_exists('curl_init'),
        'gd' => function_exists('imagecreatetruecolor'),
        'imagick' => extension_loaded('imagick'),
        'ffi' => extension_loaded('ffi'),
    ],
    'disabled_functions' => array_values($disabled),
    'ffmpeg' => $ffmpeg,
    'ffprobe' => $ffprobe,
    'ffmpeg_version' => $ffmpeg['found'] ? run('ffmpeg -hide_banner -version | head -n 2') : null,
    'disk' => [
        'free_mb' => (int) (@disk_free_space(__DIR__) / 1048576),
        'total_mb' => (int) (@disk_total_space(__DIR__) / 1048576),
    ],
    'write_test' => (function (): string {
        $f = sys_get_temp_dir() . '/diag_' . bin2hex(random_bytes(4)) . '.txt';
        $ok = @file_put_contents($f, 'ok') === 2;
        if ($ok) @unlink($f);
        return $ok ? 'ok' : 'FAILED';
    })(),
]);
