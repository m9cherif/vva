<?php
/**
 * POST /api/upload.php  (multipart: file, jobId, name)
 *
 * The browser renders a clip with ffmpeg.wasm and uploads the finished mp4.
 * Files land in data/jobs/<jobId>/<name> and are served back by serve.php —
 * nothing outside that directory is ever writable or readable through upload.
 */
require __DIR__ . '/_bootstrap.php';

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') fail('method not allowed', 405);

$jobId = (string) ($_POST['jobId'] ?? '');
$name = (string) ($_POST['name'] ?? '');
if (!preg_match('/^[A-Za-z0-9_-]{6,64}$/', $jobId)) fail('invalid job id');
if (!preg_match('/^[A-Za-z0-9_-]{1,64}\.(mp4|webm|mov)$/i', $name)) fail('invalid file name');

$file = $_FILES['file'] ?? null;
if (!$file || ($file['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK) {
    $code = (int) ($file['error'] ?? UPLOAD_ERR_NO_FILE);
    fail('upload failed (error ' . $code . ')', 400);
}
$size = (int) $file['size'];
if ($size <= 0 || $size > 300_000_000) fail('file empty or too large', 413);
// A rendered clip is a real mp4: at least a moov box worth of bytes.
if ($size < 4096) fail('file too small to be a video', 400);

$jobsDir = cfg()['jobsDir'];
$dir = $jobsDir . '/' . $jobId;
if (!is_dir($dir) && !@mkdir($dir, 0775, true)) fail('could not create job directory', 500);

$dest = $dir . '/' . $name;
if (!move_uploaded_file($file['tmp_name'], $dest)) {
    // Some setups disable move_uploaded_file for non-native SAPIs — fall back.
    if (!@copy($file['tmp_name'], $dest)) fail('could not store the file', 500);
}

json_out([
    'ok' => true,
    'name' => $name,
    'bytes' => $size,
    'url' => 'api/serve.php?job=' . rawurlencode($jobId) . '&name=' . rawurlencode($name),
]);
