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
            // Chain verified against the live NIM catalog (2026-11): the first
            // two answer vision requests in ~1-2s; muse-glimmer is slower but
            // reliable. The old llama-3.2/phi-3 entries are gone — they 404 or
            // hang now.
            'nvidia/nemotron-3.5-super-vl-120b-a12b',
            'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
            'meta/muse-glimmer-30b',
        ]),
        'dataDir'   => $root . '/data',
        'cacheDir'  => $root . '/data/cache',
        'jobsDir'   => $root . '/data/jobs',
        // VidKraken (https://vidkraken.com/) — the ONLY download source: a
        // YouTube-by-URL API that hands back a ready-made trimmed MP4.
        // The key lives in .env (CI regenerates it from a repo secret) and
        // never reaches the browser: api/vidkraken.php holds it server-side.
        'vidkrakenKey' => trim((string) env_get('VIDKRAKEN_API_KEY', '')),
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
        'frameIntervalSec' => 4, 'frameWidth' => 384, 'framesPerBatch' => 10,
        'searchPoolSize' => 40,
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
        $errno = curl_errno($ch);
        $error = curl_error($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        curl_close($ch);
        if ($out === false) throw new RuntimeException("HTTP request failed ({$errno}): {$error}");
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

/** The visitor token YouTube attaches to a search response. Handing the same
 *  token to the player call makes both requests look like one browser session —
 *  without it the player endpoint answers "sign in to confirm you're not a bot"
 *  far more often. Cached for 6h, best-effort, never fatal. */
function innertube_visitor(): string {
    static $cached = null;
    if ($cached !== null) return $cached;
    $file = cfg()['cacheDir'] . '/innertube_visitor.txt';
    if (is_file($file) && (time() - filemtime($file)) < 6 * 3600) {
        $v = trim((string) file_get_contents($file));
        if ($v !== '') return $cached = $v;
    }
    return $cached = '';
}

function innertube_save_visitor(?string $visitor): void {
    if (!is_string($visitor) || $visitor === '') return;
    @file_put_contents(cfg()['cacheDir'] . '/innertube_visitor.txt', $visitor, LOCK_EX);
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
 *  Covers the YouTube CDN (the built-in fallback downloader), the VidKraken
 *  media CDN — proxy.vidkraken.com sends no CORS headers, so every byte of a
 *  VidKraken download has to be relayed same-origin through range.php — and
 *  the two keyless fallback downloaders (WebDownloader, WeirdDL). */
function is_relay_host(string $host): bool {
    $host = strtolower($host);
    foreach (['googlevideo.com', 'ytimg.com', 'youtube.com', 'vidkraken.com', 'brianrianrehan.com', 'weirddl.sbs'] as $d) {
        if ($host === $d || str_ends_with($host, '.' . $d)) return true;
    }
    return false;
}

/* ── VidKraken (https://vidkraken.com/) ────────────────────────────────────
 * The app's one and only download source: POST a YouTube URL, poll the job,
 * get back a trimmed MP4 on their CDN. The API key lives in .env and is used
 * exclusively here — the browser talks to api/vidkraken.php, never to them.
 * Every call is short and bounded: shared hosting must never run a script
 * that waits on a third party, so the poll loop lives in the browser. */
const VIDKRAKEN_BASE = 'https://vidkraken.com/api/v2';

/**
 * Call the VidKraken API. Never throws and never fails the request by itself:
 * returns ['status' => int, 'data' => ?array, 'error' => ?string] so the
 * caller decides whether to fall back (status 0 = no key / transport failure).
 */
function vidkraken_call(string $method, string $path, ?array $body = null, array $headers = [], int $timeout = 30): array {
    $key = cfg()['vidkrakenKey'];
    if ($key === '') return ['status' => 0, 'data' => null, 'error' => 'VIDKRAKEN_API_KEY is not configured'];
    $auth = ['Authorization: Bearer ' . $key];
    try {
        $res = $method === 'GET'
            ? http_get_json(VIDKRAKEN_BASE . $path, array_merge($auth, $headers), $timeout)
            : http_post_json(VIDKRAKEN_BASE . $path, $body ?? [], array_merge($auth, $headers), $timeout, 12);
    } catch (Throwable $e) {
        return ['status' => 0, 'data' => null, 'error' => $e->getMessage()];
    }
    $data = json_decode($res['body'], true);
    $err = null;
    if ($res['status'] < 200 || $res['status'] >= 300) {
        $msg = null;
        if (is_array($data)) $msg = $data['error'] ?? $data['message'] ?? null;
        if (is_array($msg)) $msg = json_encode($msg);
        if (!is_string($msg) || $msg === '') {
            $msg = 'VidKraken HTTP ' . $res['status'] . ': '
                 . mb_substr(preg_replace('/\s+/', ' ', (string) $res['body']), 0, 200);
        }
        if (is_array($data) && !empty($data['code'])) $msg .= ' [' . $data['code'] . ']';
        $err = $msg;
    }
    return ['status' => $res['status'], 'data' => is_array($data) ? $data : null, 'error' => $err];
}

/** Free quota probe (GET /me) → downloads left on the plan, or null if unknown. */
function vidkraken_downloads_left(): ?int {
    $r = vidkraken_call('GET', '/me', null, [], 20);
    $rem = $r['data']['balances']['download_count']['remaining'] ?? null;
    return is_numeric($rem) ? (int) $rem : null;
}
