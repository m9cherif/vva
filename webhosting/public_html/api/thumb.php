<?php
/**
 * GET /api/thumb.php?id=<videoId>[&res=hqdefault]
 *
 * Relays a YouTube thumbnail. Two reasons this exists: the page runs under
 * COEP isolation (cross-origin images would be blocked unless CORP is set),
 * and the research agent needs cover bytes as base64 for the vision model.
 * Images are cached on disk for a day — the agent judges the same covers
 * every round.
 */
require __DIR__ . '/_bootstrap.php';

$id = (string) ($_GET['id'] ?? '');
$res = (string) ($_GET['res'] ?? 'hqdefault');
if (!preg_match('/^[A-Za-z0-9_-]{11}$/', $id)) fail('invalid video id', 400);
if (!in_array($res, ['hqdefault', 'mqdefault', 'maxresdefault', 'sddefault'], true)) $res = 'hqdefault';

$cache = cfg()['cacheDir'] . "/thumb_{$id}_{$res}.jpg";
if (is_file($cache) && (time() - filemtime($cache)) < 86400 && filesize($cache) > 500) {
    header('Content-Type: image/jpeg');
    header('Cache-Control: public, max-age=86400');
    readfile($cache);
    exit;
}

$bytes = http_get_bytes("https://i.ytimg.com/vi/{$id}/{$res}.jpg", null, 15);
if ($bytes === false || $bytes === null || strlen($bytes) < 500 || substr($bytes, 0, 2) !== "\xFF\xD8") {
    // Fall back to the always-present hqdefault before giving up.
    if ($res !== 'hqdefault') $bytes = http_get_bytes("https://i.ytimg.com/vi/{$id}/hqdefault.jpg", null, 15);
}
if ($bytes === null || $bytes === false || strlen($bytes) < 500 || substr((string) $bytes, 0, 2) !== "\xFF\xD8") {
    fail('thumbnail unavailable', 404);
}

@file_put_contents($cache, $bytes, LOCK_EX);
header('Content-Type: image/jpeg');
header('Cache-Control: public, max-age=86400');
echo $bytes;
