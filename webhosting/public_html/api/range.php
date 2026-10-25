<?php
/**
 * GET /api/range.php?u=<base64url stream url>[&probe=1]
 *     with optional Range: bytes=a-b request header.
 *
 * Relays a byte range of a YouTube CDN stream to the browser. Two reasons this
 * exists: googlevideo.com sends no CORS headers (the browser may not fetch it
 * directly), and keeping every relay request small means no PHP request ever
 * runs long enough to trip shared-hosting timeouts.
 *
 * probe=1  → 200 + JSON { total, acceptRanges } instead of bytes (cheap way to
 * learn the file size before committing to a download).
 */
require __DIR__ . '/_bootstrap.php';

$u = (string) ($_GET['u'] ?? '');
$url = $u !== '' ? (string) base64_decode(strtr($u, '-_', '+/')) : '';
if ($url === '' || !preg_match('#^https://#i', $url)) fail('missing stream url');
$host = parse_url($url, PHP_URL_HOST);
if (!is_string($host) || !is_youtube_cdn_host($host)) fail('url host not allowed', 403);

$rangeHeader = $_SERVER['HTTP_RANGE'] ?? '';
if ($rangeHeader !== '' && !preg_match('/^bytes=\d*-\d*$/', $rangeHeader)) {
    fail('unsupported Range syntax', 416);
}
$probe = isset($_GET['probe']);

if (!function_exists('curl_init')) {
    fail('this endpoint requires the PHP cURL extension', 500);
}

$ch = curl_init($url);
$curlHeaders = ['User-Agent: ' . UA_BROWSER, 'Accept: */*'];
if ($rangeHeader !== '') $curlHeaders[] = 'Range: ' . $rangeHeader;

$headers = [];
curl_setopt_array($ch, [
    CURLOPT_HTTPHEADER => $curlHeaders,
    CURLOPT_FOLLOWLOCATION => true,
    CURLOPT_MAXREDIRS => 3,
    CURLOPT_TIMEOUT => 45,           // each relay moves at most a few MB
    CURLOPT_CONNECTTIMEOUT => 12,
    CURLOPT_SSL_VERIFYPEER => true,
    CURLOPT_HEADERFUNCTION => function ($ch, $line) use (&$headers) {
        $len = strlen($line);
        $line = trim($line);
        if ($line !== '' && preg_match('/^([A-Za-z-]+):\s*(.*)$/', $line, $m)) {
            $headers[strtolower($m[1])] = $m[2];
        }
        return $len;
    },
]);

if ($probe) {
    // Ask for the first byte only: cheap, and the response header reveals the total size.
    curl_setopt($ch, CURLOPT_RANGE, 'bytes=0-0');
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    $one = curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    $err = curl_error($ch);
    curl_close($ch);
    if ($one === false) fail('upstream fetch failed: ' . $err, 502);
    $total = 0;
    if (preg_match('#/(\d+)$#', $headers['content-range'] ?? '', $m)) $total = (int) $m[1];
    elseif (isset($headers['content-length'])) $total = (int) $headers['content-length'];
    json_out([
        'total' => $total,
        'status' => $status,
        'acceptRanges' => str_contains($headers['accept-ranges'] ?? '', 'bytes') || $status === 206,
        'contentType' => $headers['content-type'] ?? 'application/octet-stream',
    ]);
}

/* ── byte relay ─────────────────────────────────────────────────────────── */
$status = 200;
$started = false;
$rangeWanted = $rangeHeader !== '';
$reject = null;
curl_setopt($ch, CURLOPT_HEADERFUNCTION, function ($ch, $line) use (&$headers, &$status, &$started) {
    $len = strlen($line);
    $line = trim($line);
    if (preg_match('#^HTTP/\S+\s+(\d+)#', $line, $m)) {
        // A new response begins (the CDN answers 302 before the real 206).
        // Drop the previous response's headers so a stale "Content-Length: 0"
        // from the redirect can never leak into ours.
        $status = (int) $m[1];
        if (!$started) $headers = [];
        return $len;
    }
    if ($line !== '' && preg_match('/^([A-Za-z-]+):\s*(.*)$/', $line, $m)) {
        $headers[strtolower($m[1])] = $m[2];
    }
    return $len;
});

curl_setopt($ch, CURLOPT_WRITEFUNCTION, function ($ch, $chunk) use (&$started, &$status, &$headers, &$rangeWanted, &$reject) {
    if (!$started) {
        // Refuse BEFORE sending a single byte: a 200 here means upstream
        // ignored our Range header, and relaying the whole file would silently
        // corrupt the assembled download. Returning 0 aborts the transfer.
        if ($rangeWanted && $status !== 206) {
            $reject = "upstream ignored the Range header (HTTP {$status})";
            return 0;
        }
        $started = true;
        http_response_code($status);
        header('Content-Type: ' . ($headers['content-type'] ?? 'application/octet-stream'));
        if (isset($headers['content-range'])) header('Content-Range: ' . $headers['content-range']);
        if (isset($headers['content-length'])) header('Content-Length: ' . $headers['content-length']);
        header('Accept-Ranges: bytes');
        header('Cache-Control: private, max-age=3600');
        // The URL carries an expiring signature — never let a proxy cache it.
        header('X-Content-Type-Options: nosniff');
        while (ob_get_level() > 0) @ob_end_clean();
    }
    echo $chunk;
    @flush();
    return strlen($chunk);
});

curl_exec($ch);
$err = curl_error($ch);
$errno = curl_errno($ch);
curl_close($ch);

/* Nothing was streamed: report a real error status. Without this the script
 * would end silently and PHP would answer 200 with an empty body — which the
 * downloader would happily treat as a valid (zero-length) chunk. */
if (!$started) {
    if ($reject !== null) fail($reject, 503);                       // retriable
    $detail = $err !== '' ? $err : "upstream HTTP {$status}";
    if ($status === 403 || $status === 416 || $status === 429) {
        fail("upstream refused the range ({$status}): {$detail}", 503);   // retriable
    }
    fail("upstream fetch failed: {$detail}", 502);
}
