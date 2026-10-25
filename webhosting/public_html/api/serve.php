<?php
/**
 * GET /api/serve.php?job=<id>&name=<clip.mp4>
 *
 * Streams a rendered clip back for preview/download, with HTTP Range support
 * (browsers seek video by range). Path traversal is impossible: both parts are
 * strict character-class validated and joined under jobsDir.
 */
require __DIR__ . '/_bootstrap.php';

$jobId = (string) ($_GET['job'] ?? '');
$name = (string) ($_GET['name'] ?? '');
if (!preg_match('/^[A-Za-z0-9_-]{6,64}$/', $jobId)) fail('invalid job id', 400);
if (!preg_match('/^[A-Za-z0-9_-]{1,64}\.(mp4|webm|mov)$/i', $name)) fail('invalid file name', 400);

$file = cfg()['jobsDir'] . '/' . $jobId . '/' . $name;
if (!is_file($file)) fail('not found', 404);

$size = (int) filesize($file);
$type = str_ends_with(strtolower($name), '.webm') ? 'video/webm' : 'video/mp4';
$fp = fopen($file, 'rb');
if (!$fp) fail('could not open file', 500);

$start = 0;
$end = $size - 1;
$range = $_SERVER['HTTP_RANGE'] ?? '';
$status = 200;
if ($range !== '' && preg_match('/^bytes=(\d*)-(\d*)$/', $range, $m) && ($m[1] !== '' || $m[2] !== '')) {
    if ($m[1] === '') {
        $len = (int) $m[2];               // bytes=-500 → last N bytes
        $start = max(0, $size - $len);
    } else {
        $start = (int) $m[1];
        if ($m[2] !== '') $end = min($size - 1, (int) $m[2]);
    }
    if ($start > $end || $start >= $size) {
        header("Content-Range: bytes */{$size}");
        http_response_code(416);
        exit;
    }
    $status = 206;
}

http_response_code($status);
header("Content-Type: {$type}");
header('Accept-Ranges: bytes');
header("Content-Length: " . ($end - $start + 1));
header('X-Content-Type-Options: nosniff');
if ($status === 206) header("Content-Range: bytes {$start}-{$end}/{$size}");

fseek($fp, $start);
$remaining = $end - $start + 1;
while ($remaining > 0 && !feof($fp)) {
    $chunk = fread($fp, min(262144, $remaining));
    if ($chunk === false) break;
    echo $chunk;
    $remaining -= strlen($chunk);
    @flush();
}
fclose($fp);
