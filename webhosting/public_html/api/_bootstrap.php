<?php
/**
 * Shared bootstrap: .env loading, JSON helpers, tiny HTTP client.
 * Every api/*.php endpoint starts with require __DIR__ . '/_bootstrap.php';
 */
declare(strict_types=1);

error_reporting(E_ALL);
ini_set('display_errors', '0');
ini_set('log_errors', '1');

/* ── .env ────────────────────────────────────────────────────────────────
 * Search order: one level above public_html (outside the web root — the
 * preferred place on Hostinger), then inside public_html (protected by
 * .htaccess's deny rule), then a plain PHP env (hPanel environment vars). */
function load_env(): array {
    static $env = null;
    if ($env !== null) return $env;
    $env = [];
    foreach ([__DIR__ . '/../.env', __DIR__ . '/../env', __DIR__ . '/.env'] as $file) {
        if (is_file($file) && is_readable($file)) {
            foreach (file($file, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
                $line = trim($line);
                if ($line === '' || $line[0] === '#') continue;
                $i = strpos($line, '=');
                if ($i === false) continue;
                $key = trim(substr($line, 0, $i));
                $value = trim(substr($line, $i + 1));
                if (strlen($value) >= 2 && ($value[0] === '"' || $value[0] === "'") && $value[0] === $value[strlen($value) - 1]) {
                    $value = substr($value, 1, -1);
                }
                if ($key !== '' && !array_key_exists($key, $env)) $env[$key] = $value;
            }
            break;
        }
    }
    return $env;
}

function env_get(string $key, ?string $default = null): ?string {
    $v = getenv($key);
    if ($v !== false && $v !== '') return $v;
    $env = load_env();
    return $env[$key] ?? $default;
}

function env_list(string $key, array $default): array {
    $raw = env_get($key);
    if ($raw === null || trim($raw) === '') return $default;
    return array_values(array_filter(array_map('trim', explode(',', $raw)), fn($s) => $s !== ''));
}

/* ── config (mirrors server/config.js) ─────────────────────────────────── */
function cfg(): array {
    static $c = null;
    if ($c !== null) return $c;
    $root = dirname(__DIR__); // public_html
    $c = [
        'apiKey'    => env_get('NVIDIA_API_KEY', ''),
        'apiBase'   => rtrim(env_get('NVIDIA_API_BASE', 'https://integrate.api.nvidia.com/v1'), '/'),
        'visionModels' => env_list('VISION_MODELS', [
            'nvidia/nemotron-3.5-super-vl-120b-a12b',
            'meta/llama-3.2-90b-vision-instruct',
            'meta/llama-3.2-11b-vision-instruct',
            'microsoft/phi-3-vision-128k-instruct',
        ]),
        'dataDir'   => $root . '/data',
        'cacheDir'  => $root . '/data/cache',
        'jobsDir'   => $root . '/data/jobs',
        // Free-forever direct-MP4 source (https://www.pexels.com/api/).
        // Empty until the key is added — the app then stays on YouTube.
        'pexelsKey' => trim((string) env_get('PEXELS_API_KEY', '')),
    ];
    foreach (['dataDir', 'cacheDir', 'jobsDir'] as $d) {
        if (!is_dir($c[$d])) @mkdir($c[$d], 0775, true);
    }
    return $c;
}

function limits(): array {
    return [
        'clipCountMin' => 1, 'clipCountMax' => 12,
        'clipLengthMin' => 8, 'clipLengthMax' => 60,
        'sourceMin' => 2, 'sourceMax' => 6,
        'windowMin' => 60, 'windowMax' => 240, 'windowDefault' => 150,
        'frameIntervalSec' => 6, 'frameWidth' => 384, 'framesPerBatch' => 10,
        'searchPoolSize' => 30,
        'minSourceDurationSec' => 45, 'maxSourceDurationSec' => 900,
        'qualityOptions' => [480, 720], 'qualityDefault' => 720,
        'aspectOptions' => ['16:9', '9:16', '1:1'], 'aspectDefault' => '16:9',
        'aiTimeoutSec' => 170,
    ];
}

/* ── JSON I/O ───────────────────────────────────────────────────────────── */
function json_in(): array {
    $raw = file_get_contents('php://input');
    if ($raw === false || $raw === '') return [];
    $data = json_decode($raw, true);
    return is_array($data) ? $data : [];
}

function json_out(mixed $data, int $status = 200): never {
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

function fail(string $message, int $status = 400): never {
    json_out(['error' => $message], $status);
}

/* ── HTTP client (YouTube Innertube + NVIDIA) ─────────────────────────────
 * Uses cURL when available (Hostinger has it) and falls back to stream
 * wrappers, so the site also runs on a bare `php -S` for local testing. */
const UA_BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function http_post_json(string $url, array $body, array $headers = [], int $timeout = 60, int $connectTimeout = 15): array {
    $payload = json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => $payload,
            CURLOPT_HTTPHEADER => array_merge(['Content-Type: application/json', 'Accept: application/json'], $headers),
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_MAXREDIRS => 3,
            CURLOPT_TIMEOUT => $timeout,
            CURLOPT_CONNECTTIMEOUT => $connectTimeout,
            CURLOPT_ENCODING => '',
            CURLOPT_USERAGENT => UA_BROWSER,
        ]);
        $out = curl_exec($ch);
        $errno = curl_errno($ch);
        $error = curl_error($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        curl_close($ch);
        if ($out === false) throw new RuntimeException("HTTP request failed ({$errno}): {$error}");
        return ['status' => $status, 'body' => (string) $out];
    }
    $ctx = stream_context_create(['http' => [
        'method' => 'POST',
        'header' => implode("\r\n", array_merge(['Content-Type: application/json', 'Accept: application/json',
            'User-Agent: ' . UA_BROWSER], $headers)),
        'content' => $payload,
        'timeout' => $timeout,
        'ignore_errors' => true,
        'follow_location' => 1,
    ]]);
    $out = @file_get_contents($url, false, $ctx);
    if ($out === false) throw new RuntimeException('HTTP request failed: ' . implode(' ', $http_response_header ?? []));
    $status = 0;
    if (($http_response_header ?? []) && preg_match('#HTTP/\S+\s+(\d+)#', $http_response_header[0], $m)) $status = (int) $m[1];
    return ['status' => $status, 'body' => (string) $out];
}

/** GET returning ['status' => int, 'body' => string] — same shape as http_post_json. */
function http_get_json(string $url, array $headers = [], int $timeout = 30): array {
    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_HTTPHEADER => array_merge(['Accept: application/json'], $headers),
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_MAXREDIRS => 3,
            CURLOPT_TIMEOUT => $timeout,
            CURLOPT_CONNECTTIMEOUT => 10,
            CURLOPT_ENCODING => '',
            CURLOPT_USERAGENT => UA_BROWSER,
        ]);
        $out = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        curl_close($ch);
        if ($out === false) throw new RuntimeException('HTTP request failed: ' . curl_strerror(0));
        return ['status' => $status, 'body' => (string) $out];
    }
    $ctx = stream_context_create(['http' => [
        'header' => implode("\r\n", array_merge(['Accept: application/json', 'User-Agent: ' . UA_BROWSER], $headers)),
        'timeout' => $timeout, 'ignore_errors' => true, 'follow_location' => 1,
    ]]);
    $out = @file_get_contents($url, false, $ctx);
    if ($out === false) throw new RuntimeException('HTTP request failed');
    $status = 0;
    if (($http_response_header ?? []) && preg_match('#HTTP/\S+\s+(\d+)#', $http_response_header[0], $m)) $status = (int) $m[1];
    return ['status' => $status, 'body' => (string) $out];
}

/** Sniff an image's content type from its magic bytes (proxied covers can be
 *  JPEG/PNG/WebP and we must not assume one). */
function image_content_type(string $bytes): string {
    if (str_starts_with($bytes, "\xFF\xD8\xFF")) return 'image/jpeg';
    if (str_starts_with($bytes, "\x89PNG\r\n\x1A\n")) return 'image/png';
    if (str_starts_with($bytes, 'RIFF') && substr($bytes, 8, 4) === 'WEBP') return 'image/webp';
    if (str_starts_with($bytes, 'GIF87a') || str_starts_with($bytes, 'GIF89a')) return 'image/gif';
    return 'image/jpeg';
}

function http_get_bytes(string $url, ?string $range = null, int $timeout = 30): ?string {
    $headers = 'User-Agent: ' . UA_BROWSER . "\r\n";
    if ($range !== null) $headers .= 'Range: bytes=' . $range . "\r\n";
    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_HTTPHEADER => array_filter(explode("\r\n", rtrim($headers, "\r\n"))),
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_TIMEOUT => $timeout,
            CURLOPT_CONNECTTIMEOUT => 10,
            CURLOPT_ENCODING => '',
        ]);
        $out = curl_exec($ch);
        curl_close($ch);
        return $out === false ? null : $out;
    }
    $ctx = stream_context_create(['http' => [
        'header' => $headers, 'timeout' => $timeout, 'ignore_errors' => true, 'follow_location' => 1,
    ]]);
    $out = @file_get_contents($url, false, $ctx);
    return $out === false ? null : $out;
}

/* ── Innertube (YouTube's own API — no key needed) ──────────────────────── */
function innertube_key(): string {
    static $key = null;
    if ($key !== null) return $key;
    $cache = cfg()['cacheDir'] . '/innertube_key.txt';
    if (is_file($cache) && (time() - filemtime($cache)) < 6 * 3600) {
        $k = trim((string) file_get_contents($cache));
        if ($k !== '') return $key = $k;
    }
    $home = http_get_bytes('https://www.youtube.com/', null, 20) ?? '';
    if (preg_match('/"INNERTUBE_API_KEY":"([^"]+)"/', $home, $m)) {
        $key = $m[1];
        @file_put_contents($cache, $key, LOCK_EX);
        return $key;
    }
    // Hard-coded public web key (also published by YouTube's own JS) as last resort.
    return $key = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
}

function innertube_context(string $clientName, string $version, array $extra = []): array {
    return ['client' => array_merge(['clientName' => $clientName, 'clientVersion' => $version], $extra),
            'user' => ['lockedSafetyMode' => false]];
}

/** Recursively collect every videoRenderer in an Innertube response. */
function collect_videos(object|array $node, array &$out): void {
    if (!is_array($node) && !is_object($node)) return;
    $arr = is_object($node) ? get_object_vars($node) : $node;
    if (isset($arr['videoRenderer']) && is_array($arr['videoRenderer'])) {
        $v = $arr['videoRenderer'];
        $id = $v['videoId'] ?? null;
        if ($id) {
            $out[$id] = [
                'id' => $id,
                'title' => runs_text($v['title'] ?? null) ?: 'Untitled',
                'channel' => runs_text($v['ownerText'] ?? $v['longBylineText'] ?? null) ?: 'Unknown channel',
                'duration' => parse_clock($v['lengthText']['simpleText'] ?? ''),
                'views' => parse_views($v['viewCountText']['simpleText'] ?? $v['shortViewCountText']['simpleText'] ?? ''),
                'thumb' => 'https://i.ytimg.com/vi/' . $id . '/hqdefault.jpg',
                'live' => isset($v['lengthText']['accessibility']['accessibilityData']['label'])
                          && str_contains(strtolower($v['lengthText']['accessibility']['accessibilityData']['label']), 'live'),
            ];
        }
    }
    foreach ($arr as $child) {
        if (is_array($child) || is_object($child)) collect_videos($child, $out);
    }
}

function runs_text(?array $node): string {
    if (!$node) return '';
    if (isset($node['simpleText'])) return (string) $node['simpleText'];
    if (isset($node['runs']) && is_array($node['runs'])) {
        $s = '';
        foreach ($node['runs'] as $r) $s .= $r['text'] ?? '';
        return $s;
    }
    return '';
}

function parse_clock(string $text): int {
    if (!preg_match('/^(\d+):(\d+)(?::(\d+))?$/', trim($text), $m)) return 0;
    return isset($m[3]) ? (int) $m[1] * 3600 + (int) $m[2] * 60 + (int) $m[3] : (int) $m[1] * 60 + (int) $m[2];
}

function parse_views(string $text): int {
    if (!preg_match('/([\d,.]+)/', $text, $m)) return 0;
    $n = str_replace([',', ' '], '', $m[1]);
    $mult = 1;
    foreach ([['B', 1e9], ['M', 1e6], ['K', 1e3]] as [$suf, $mul]) {
        if (str_ends_with($text, $suf) || stripos($text, $suf) !== false) { $mult = $mul; break; }
    }
    return (int) round((float) $n * $mult);
}

/** True only for hosts we are willing to relay bytes from (SSRF guard).
 *  Covers the YouTube CDN, the Pexels CDN and Internet Archive (keyless). */
function is_youtube_cdn_host(string $host): bool {
    $host = strtolower($host);
    return $host === 'googlevideo.com' || str_ends_with($host, '.googlevideo.com')
        || $host === 'ytimg.com' || str_ends_with($host, '.ytimg.com')
        || $host === 'youtube.com' || str_ends_with($host, '.youtube.com')
        || $host === 'pexels.com' || str_ends_with($host, '.pexels.com')
        || $host === 'archive.org' || str_ends_with($host, '.archive.org');
}

/* ── Internet Archive (free forever, NO key: https://archive.org/developers) ──
 * Progressive faststart MP4s served with real Range support, so the byte-range
 * downloader and the cutting stage work unchanged. Used as the last resort
 * when YouTube blocks the host and no Pexels key is configured. */
function archive_metadata(string $id): ?array {
    try {
        $res = http_get_json('https://archive.org/metadata/' . rawurlencode($id), [], 25);
        if ($res['status'] !== 200) return null;
        $d = json_decode($res['body'], true);
        return is_array($d) && !empty($d['server']) ? $d : null;
    } catch (Throwable) {
        return null;
    }
}

/** Fetch many item metadata records at once (parallel — search stays fast). */
function archive_metadata_bulk(array $ids, int $max = 24): array {
    $ids = array_slice(array_values(array_unique($ids)), 0, $max);
    $out = [];
    if (!function_exists('curl_multi_init')) {
        foreach ($ids as $id) { $m = archive_metadata($id); if ($m) $out[$id] = $m; }
        return $out;
    }
    $mh = curl_multi_init();
    $handles = [];
    foreach ($ids as $id) {
        $ch = curl_init('https://archive.org/metadata/' . rawurlencode($id));
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true, CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_TIMEOUT => 25, CURLOPT_CONNECTTIMEOUT => 8, CURLOPT_USERAGENT => UA_BROWSER,
        ]);
        curl_multi_add_handle($mh, $ch);
        $handles[$id] = $ch;
    }
    do {
        $status = curl_multi_exec($mh, $active);
        if ($active) curl_multi_select($mh, 1.0);
    } while ($active && $status === CURLM_OK);
    foreach ($handles as $id => $ch) {
        $body = (string) curl_multi_getcontent($ch);
        if ((int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE) === 200 && $body !== '') {
            $j = json_decode($body, true);
            if (is_array($j) && !empty($j['server'])) $out[$id] = $j;
        }
        curl_multi_remove_handle($mh, $ch);
        curl_close($ch);
    }
    curl_multi_close($mh);
    return $out;
}

/** "34:56" | "1:02:03" | "1234.56" → seconds. */
function archive_parse_length(string $raw): int {
    $raw = trim($raw);
    if ($raw === '') return 0;
    if (preg_match('/^(\d+):(\d{2})(?::(\d{2}))?$/', $raw, $m)) {
        return isset($m[3]) ? (int) $m[1] * 3600 + (int) $m[2] * 60 + (int) $m[3]
                            : (int) $m[1] * 60 + (int) $m[2];
    }
    return (int) floor((float) $raw);
}

/** Every mp4 derivative of an item, best first: real dimensions, then size. */
function archive_mp4_files(array $meta): array {
    $out = [];
    foreach (($meta['files'] ?? []) as $f) {
        if (!is_array($f)) continue;
        $name = (string) ($f['name'] ?? '');
        if (!preg_match('/\.mp4$/i', $name)) continue;
        $size = (int) ($f['size'] ?? 0);
        $w = (int) ($f['width'] ?? 0);
        $out[] = [
            'score' => $w * 1000 + min($size, 3_000_000_000) / 1e6,
            'name' => $name, 'size' => $size,
            'width' => $w, 'height' => (int) ($f['height'] ?? 0),
            'length' => (string) ($f['length'] ?? ''), 'format' => (string) ($f['format'] ?? ''),
        ];
    }
    usort($out, fn($a, $b) => $b['score'] <=> $a['score']);
    return $out;
}

/** Best mp4 derivative of an item: prefer real dimensions, then file size. */
function archive_best_mp4(array $meta): ?array {
    $all = archive_mp4_files($meta);
    return $all ? $all[0] : null;
}

function archive_file_url(array $meta, string $name): string {
    $server = rtrim((string) ($meta['server'] ?? 'archive.org'), '/');
    if (!preg_match('#^https?://#i', $server)) $server = 'https://' . ltrim($server, '/');
    $dir = trim((string) ($meta['dir'] ?? ''), '/');
    $path = implode('/', array_map('rawurlencode', explode('/', $name)));
    return "{$server}/{$dir}/{$path}";
}

/** Range-probe many file URLs in parallel → [url => bool].
 *  Archive.org lists files that are not actually downloadable (HTTP 403), so
 *  a candidate is only offered to the pipeline after its bytes were seen. */
function archive_probe_urls(array $urls, int $timeout = 10): array {
    $urls = array_values(array_unique($urls));
    $out = array_fill_keys($urls, false);
    if (!$urls || !function_exists('curl_multi_init')) return $out;
    $mh = curl_multi_init();
    $handles = [];
    foreach ($urls as $u) {
        $ch = curl_init($u);
        curl_setopt_array($ch, [
            CURLOPT_HTTPHEADER => ['Range: bytes=0-1023'],
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_MAXREDIRS => 3,
            CURLOPT_TIMEOUT => $timeout,
            CURLOPT_CONNECTTIMEOUT => 6,
            CURLOPT_USERAGENT => UA_BROWSER,
        ]);
        curl_multi_add_handle($mh, $ch);
        $handles[$u] = $ch;
    }
    do {
        $status = curl_multi_exec($mh, $active);
        if ($active) curl_multi_select($mh, 1.0);
    } while ($active && $status === CURLM_OK);
    foreach ($handles as $u => $ch) {
        $code = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $out[$u] = ($code === 206 || $code === 200);
        curl_multi_remove_handle($mh, $ch);
        curl_close($ch);
    }
    curl_multi_close($mh);
    return $out;
}

/** Normalize an archive item into the shape the research agent expects. */
function archive_normalize(array $meta, array $doc, string $query): ?array {
    $file = archive_best_mp4($meta);
    if (!$file) return null;
    $id = (string) ($doc['identifier'] ?? $meta['metadata']['identifier'] ?? '');
    if ($id === '') return null;
    $dur = archive_parse_length($file['length']);
    if ($dur < limits()['minSourceDurationSec'] || $dur > 3600) return null;
    $title = trim((string) ($doc['title'] ?? $meta['metadata']['title'] ?? ''));
    if (is_array($title)) $title = trim((string) ($title[0] ?? ''));
    if ($title === '') $title = $query;
    $creator = trim((string) (($meta['metadata']['creator'] ?? '') ?: ($meta['metadata']['sponsor'] ?? '')));
    if (is_array($creator)) $creator = trim((string) ($creator[0] ?? ''));
    return [
        'id' => $id,
        'title' => mb_substr($title, 0, 90),
        'channel' => $creator !== '' ? $creator : 'Internet Archive',
        'duration' => $dur,
        'views' => (int) ($doc['downloads'] ?? 0),
        'thumb' => "https://archive.org/services/img/{$id}",
        'live' => false,
        'provider' => 'archive',
        'page' => "https://archive.org/details/{$id}",
        'file' => $file['name'],
    ];
}
/* ── Pexels source (free forever: https://www.pexels.com/api/) ──────────────
 * Direct progressive MP4 files — used when it is configured, ahead of the
 * Internet Archive fallback. */
function pexels_available(): bool {
    return cfg()['pexelsKey'] !== '';
}

function pexels_api(string $pathAndQuery): array {
    if (!pexels_available()) fail('PEXELS_API_KEY is not set in .env — add the free key from pexels.com/api to use this source', 400);
    $res = http_get_json('https://api.pexels.com' . $pathAndQuery, ['Authorization: ' . cfg()['pexelsKey']], 30);
    if ($res['status'] !== 200) {
        fail('Pexels API returned HTTP ' . $res['status'] . ': ' . mb_substr(preg_replace('/\s+/', ' ', $res['body']), 0, 180), 502);
    }
    $d = json_decode($res['body'], true);
    if (!is_array($d)) fail('Pexels API returned malformed data', 502);
    return $d;
}

/** Normalize a Pexels video object into the shape the research agent expects. */
function pexels_normalize(array $v, string $query): ?array {
    $dur = (int) ($v['duration'] ?? 0);
    if ($dur < limits()['minSourceDurationSec'] || $dur > limits()['maxSourceDurationSec']) return null;
    $id = (string) ($v['id'] ?? '');
    if ($id === '') return null;
    $who = (string) ($v['user']['name'] ?? '');
    $photos = $v['video_pictures'] ?? [];
    $cover = (string) ($photos[0]['picture'] ?? $v['image'] ?? '');
    return [
        'id' => $id,
        'title' => trim(($query !== '' ? $query : 'Stock footage') . ($who !== '' ? " — {$who}" : '')),
        'channel' => $who !== '' ? $who : 'Pexels',
        'duration' => $dur,
        'views' => 0,
        'thumb' => $cover,
        'live' => false,
        'provider' => 'pexels',
        'page' => (string) ($v['url'] ?? ''),
    ];
}
