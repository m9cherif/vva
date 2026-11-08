<?php
/**
 * Keyless fallback downloaders — used ONLY when VidKraken cannot serve a
 * video (quota gone, job failed, outage), and always for the SAME video the
 * research agent already picked. Two free public APIs, tried in order:
 *
 *   1. WebDownloader  POST https://save.brianrianrehan.com/api/v1/download
 *      → { downloadUrl, title, duration }. Their file URL answers 200 to any
 *        Range header (it always sends the whole file), so the browser pulls
 *        it in ONE bounded pass through act=stream — a chunked relay would
 *        re-download the entire file per chunk and burn a usage-limited API.
 *   2. WeirdDL         GET https://weirddl.sbs/api/info
 *      → a DIRECT googlevideo.com URL, which supports real 206 ranges and
 *        therefore goes through the ordinary api/range.php 4 MB chunk relay.
 *
 *   GET ?act=info&src=weirddl|webdownloader&url=<youtube watch url>
 *        → { source, streamUrl|downloadUrl, range, title, durationSec }
 *          (`range` = whether the returned file URL honors byte ranges)
 *   GET ?act=probe&u=<base64url file url>
 *        → { ready, status }  — cheap HEAD poll: WebDownloader answers 409
 *          while it is still rendering the file, 200 when it is ready.
 *   GET ?act=stream&u=<base64url file url>[&max=<bytes>]
 *        → bytes, at most `max` (64 MB ceiling). Range is passed through when
 *          the upstream honors it and emulated when it does not, so the
 *          browser always sees a well-formed 200/206 with a Content-Length it
 *          can turn into a progress bar.
 */
require __DIR__ . '/_bootstrap.php';

const FALLBACK_MAX_BYTES = 67108864;      // 64 MB ceiling per streamed file
const FALLBACK_STREAM_TIMEOUT = 120;      // shared hosting: no unbounded request

if (!function_exists('curl_init')) fail('this endpoint requires the PHP cURL extension', 500);

/** Decode and validate a relayed file URL (SSRF guard: allowlisted hosts only). */
function fallback_file_url(): string {
    $u = (string) ($_GET['u'] ?? '');
    $url = $u !== '' ? (string) base64_decode(strtr($u, '-_', '+/')) : '';
    if ($url === '' || !preg_match('#^https://#i', $url)) fail('missing stream url');
    $host = parse_url($url, PHP_URL_HOST);
    if (!is_string($host) || !is_relay_host($host)) fail('url host not allowed', 403);
    return $url;
}

function fallback_watch_url(): string {
    $w = trim((string) ($_GET['url'] ?? ''));
    if ($w === '' || !preg_match('#^https?://(www\.)?youtube\.com/watch\?#i', $w)) fail('youtube watch url required');
    return $w;
}

/** "0:19" / 19 / "19" → 19 */
function fallback_duration(mixed $d): int {
    if (is_numeric($d)) return (int) $d;
    if (!is_string($d) || $d === '') return 0;
    $sec = 0;
    foreach (explode(':', $d) as $part) $sec = $sec * 60 + (int) $part;
    return $sec;
}

function fallback_is_googlevideo(string $url): bool {
    $host = strtolower((string) parse_url($url, PHP_URL_HOST));
    return $host === 'googlevideo.com' || str_ends_with($host, '.googlevideo.com');
}

/**
 * Can THIS server actually pull a byte from that URL?
 *
 * A googlevideo URL that looks perfectly valid can still be unusable: the URL
 * is issued for a particular client and YouTube blocks datacenter IPs, so the
 * same URL relays fine from a home connection and answers 403 from Hostinger.
 * "Looks valid" is therefore not enough — the cheap 1-byte probe below is what
 * decides between the ranged path (prefix only, cheap) and WeirdDL's own
 * whole-file endpoint (always works, but pulls everything).
 */
function fallback_can_relay(string $url): bool {
    $ch = curl_init($url);
    $status = 0;
    curl_setopt_array($ch, [
        CURLOPT_HTTPHEADER => ['User-Agent: ' . UA_BROWSER, 'Range: bytes=0-0'],
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_MAXREDIRS => 2,
        CURLOPT_TIMEOUT => 8,
        CURLOPT_CONNECTTIMEOUT => 6,
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_HEADERFUNCTION => function ($ch, $line) use (&$status) {
            if (preg_match('#^HTTP/\S+\s+(\d{3})#', trim($line), $m)) $status = (int) $m[1];
            return strlen($line);
        },
        // Discard the single byte we asked for — never buffer a body here.
        CURLOPT_WRITEFUNCTION => function ($ch, $chunk) { return strlen($chunk); },
    ]);
    curl_exec($ch);
    curl_close($ch);
    return $status === 200 || $status === 206;
}

$act = (string) ($_GET['act'] ?? 'info');

/* ── act=info: resolve a downloadable URL from one of the two APIs ──────── */
if ($act === 'info') {
    $src = (string) ($_GET['src'] ?? '');
    $watch = fallback_watch_url();

    if ($src === 'weirddl') {
        // http_get_json THROWS on transport failure — an uncaught exception
        // would end the script with an empty body instead of a JSON error.
        // One retry: a real run showed an occasional transport error here that
        // cost the source its whole chain.
        $res = null;
        $lastErr = null;
        for ($try = 0; $try < 2; $try++) {
            try {
                $res = http_get_json('https://weirddl.sbs/api/info?url=' . rawurlencode($watch), [], 45);
                break;
            } catch (Throwable $e) {
                $lastErr = $e;
                usleep(500000);
            }
        }
        if ($res === null) fail('WeirdDL unreachable: ' . $lastErr->getMessage(), 502);
        if ($res['status'] !== 200) fail('WeirdDL HTTP ' . $res['status'], 502);
        $data = json_decode($res['body'], true);
        if (!is_array($data)) fail('WeirdDL returned no data', 502);
        if (($data['ok'] ?? true) === false) fail('WeirdDL: ' . (string) ($data['error'] ?? 'no media'), 502);

        // Prefer a direct googlevideo.com URL: it honors byte ranges, so only the
        // prefix covering the analysis window is ever pulled (same cost model as
        // VidKraken). Their other media hosts are a rotating cast of piped-proxy
        // domains we cannot allowlist, so when there is no googlevideo URL we
        // stream through WeirdDL's own download endpoint instead — a stable host
        // we already relay, at the cost of one whole-file pass.
        $stream = null;
        foreach ((array) ($data['media'] ?? []) as $m) {
            if (!is_array($m) || ($m['type'] ?? '') !== 'video') continue;
            $u = (string) ($m['url'] ?? '');
            if ($u !== '' && fallback_is_googlevideo($u)) { $stream = $u; break; }
        }
        // The ranged path is only worth advertising if the bytes are actually
        // fetchable from here (see fallback_can_relay) — otherwise stream
        // through WeirdDL's own download endpoint: a stable host we already
        // relay, at the cost of one whole-file pass.
        $ranged = is_string($stream) && fallback_can_relay($stream);
        if (!$ranged) $stream = 'https://weirddl.sbs/api/download?url=' . rawurlencode($watch);

        json_out([
            'source' => 'weirddl',
            'streamUrl' => $stream,
            'range' => $ranged,
            'title' => (string) ($data['title'] ?? ''),
            'durationSec' => fallback_duration($data['duration'] ?? 0),
        ]);
    }

    if ($src === 'webdownloader') {
        // Ask for the resolution the pipeline actually uses: "best" pulls 1080p
        // — huge files that risk the 64 MB ceiling — for footage that is only
        // ever analysed and cut at 480/720 anyway.
        $q = (string) ($_GET['q'] ?? '');
        $quality = in_array($q, ['1080', '720'], true) ? $q . 'p' : '480p';
        try {
            $res = http_post_json(
                'https://save.brianrianrehan.com/api/v1/download?wait=false&download=false',
                ['url' => $watch, 'format' => 'video', 'quality' => $quality, 'outputFormat' => 'mp4'],
                [],
                // No retry here (a timed-out submit may still have queued a job
                // server-side; repeating it would burn their usage limit), but a
                // generous budget: extraction of a long compilation took >60 s in
                // a real run, which starved this whole first fallback hop.
                90,
                15
            );
        } catch (Throwable $e) {
            fail('WebDownloader unreachable: ' . $e->getMessage(), 502);
        }
        if ($res['status'] < 200 || $res['status'] >= 300) fail('WebDownloader HTTP ' . $res['status'], 502);
        $data = json_decode($res['body'], true);
        $d = is_array($data) ? ($data['data'] ?? null) : null;
        if (!is_array($d) || empty($d['downloadUrl'])) fail('WebDownloader returned no file url', 502);
        json_out([
            'source' => 'webdownloader',
            'downloadUrl' => (string) $d['downloadUrl'],
            // verified: their file URL sends the whole body to every Range request
            'range' => false,
            'title' => (string) ($d['title'] ?? ''),
            'durationSec' => fallback_duration($d['duration'] ?? 0),
        ]);
    }

    fail('unknown source');
}

/* ── act=probe: HEAD poll ("is the file rendered yet?") ────────────────── */
if ($act === 'probe') {
    $url = fallback_file_url();
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_NOBODY => true,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_MAXREDIRS => 3,
        CURLOPT_TIMEOUT => 20,
        CURLOPT_CONNECTTIMEOUT => 10,
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_USERAGENT => UA_BROWSER,
    ]);
    curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    $err = curl_error($ch);
    curl_close($ch);
    if ($status === 0) fail('upstream probe failed: ' . ($err !== '' ? $err : 'no response'), 502);
    json_out(['ready' => $status === 200, 'status' => $status, 'pending' => $status === 409]);
}

/* ── act=stream: bounded byte relay with Range emulation ───────────────── */
if ($act === 'stream') {
    $url = fallback_file_url();
    $rangeHeader = (string) ($_SERVER['HTTP_RANGE'] ?? '');
    if ($rangeHeader !== '' && !preg_match('/^bytes=(\d+)-(\d*)$/', $rangeHeader, $rm)) {
        fail('unsupported Range syntax', 416);
    }
    $rangeWanted = $rangeHeader !== '';
    $start = $rangeWanted ? (int) $rm[1] : 0;
    $endWanted = $rangeWanted && $rm[2] !== '' ? (int) $rm[2] : -1;

    $cap = (int) ($_GET['max'] ?? 0);
    if ($cap <= 0) $cap = FALLBACK_MAX_BYTES;
    $cap = min($cap, FALLBACK_MAX_BYTES);

    $ch = curl_init($url);
    $curlHeaders = ['User-Agent: ' . UA_BROWSER, 'Accept: */*'];
    if ($rangeWanted) $curlHeaders[] = 'Range: ' . $rangeHeader;

    $headers = [];
    $status = 200;
    curl_setopt_array($ch, [
        CURLOPT_HTTPHEADER => $curlHeaders,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_MAXREDIRS => 3,
        CURLOPT_TIMEOUT => FALLBACK_STREAM_TIMEOUT,
        CURLOPT_CONNECTTIMEOUT => 12,
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_HEADERFUNCTION => function ($ch, $line) use (&$headers, &$status) {
            $len = strlen($line);
            $line = trim($line);
            if (preg_match('#^HTTP/\S+\s+(\d+)#', $line, $m)) {
                // A redirect answers first; keep only the final response's headers.
                $status = (int) $m[1];
                $headers = [];
                return $len;
            }
            if ($line !== '' && preg_match('/^([A-Za-z-]+):\s*(.*)$/', $line, $m)) {
                $headers[strtolower($m[1])] = $m[2];
            }
            return $len;
        },
    ]);

    $started = false;
    $skip = $start;
    $limit = $cap;
    $emitted = 0;
    $reject = null;

    curl_setopt($ch, CURLOPT_WRITEFUNCTION, function ($ch, $chunk) use (
        &$started, &$status, &$headers, &$rangeWanted, &$start, &$endWanted, &$cap, &$skip, &$limit, &$emitted, &$reject
    ) {
        $orig = strlen($chunk);

        if (!$started) {
            $total = 0;
            if (preg_match('#/(\d+)$#', $headers['content-range'] ?? '', $m)) $total = (int) $m[1];
            elseif (isset($headers['content-length']) && (int) $headers['content-length'] > 0) $total = (int) $headers['content-length'];

            // Refuse BEFORE marking anything as started: if we bail out here the
            // caller still sees !$started below and reports a real error status.
            // Marking started first would end the script with a silent empty 200,
            // which the downloader would happily accept as a zero-byte file.
            if ($status >= 400) {
                $reject = "upstream HTTP {$status}";          // 409 = still rendering
                return 0;
            }

            $started = true;
            if ($status === 206) {
                // Upstream honored the Range: pass it straight through.
                $limit = $total > 0 ? min($total, $cap) : $cap;
                $skip = 0;
                http_response_code(206);
                header('Content-Type: ' . ($headers['content-type'] ?? 'video/mp4'));
                if (isset($headers['content-range'])) header('Content-Range: ' . $headers['content-range']);
            } elseif ($rangeWanted && $total > 0) {
                // Upstream ignored the Range (WebDownloader always does): emulate
                // it — drop the bytes before `start`, emit at most `end-start+1`,
                // and advertise a real Content-Range.
                $end = $endWanted >= 0 ? min($endWanted, $total - 1) : $total - 1;
                if ($start > $end) {
                    $reject = "range not satisfiable (total {$total})";
                    return 0;
                }
                $limit = min($end - $start + 1, $cap);
                $skip = $start;
                http_response_code(206);
                header('Content-Type: ' . ($headers['content-type'] ?? 'video/mp4'));
                header("Content-Range: bytes {$start}-{$end}/{$total}");
            } else {
                // Whole-file pass: ONE upstream pull, hard ceiling at $cap.
                $limit = $cap;
                $skip = 0;
                http_response_code(200);
                header('Content-Type: ' . ($headers['content-type'] ?? 'video/mp4'));
                if ($total > 0) header('Content-Length: ' . min($total, $cap));
                if ($total > $cap) {
                    // The body stops at the ceiling, but the CLIENT needs the
                    // real size to know how much of the video those bytes are.
                    header('X-File-Total: ' . $total);
                    header('X-Truncated: 1');
                }
            }
            header('Accept-Ranges: bytes');
            header('Cache-Control: no-store');
            header('X-Content-Type-Options: nosniff');
            while (ob_get_level() > 0) @ob_end_clean();
        }

        if ($skip > 0) {
            if ($orig <= $skip) { $skip -= $orig; return $orig; }   // discard, ask for more
            $chunk = substr($chunk, $skip);
            $skip = 0;
        }

        $room = $limit - $emitted;
        if ($room <= 0) return 0;                                   // ceiling reached
        $emit = strlen($chunk) > $room ? substr($chunk, 0, $room) : $chunk;
        echo $emit;
        $emitted += strlen($emit);
        @flush();

        // Returning 0 stops upstream immediately — the shared host must never
        // keep pulling a file we already have all of.
        if ($emitted >= $limit) return 0;
        return $orig;
    });

    curl_exec($ch);
    $err = curl_error($ch);
    curl_close($ch);

    if (!$started) {
        // Nothing was streamed: report a real status instead of a silent empty 200.
        if ($reject === null && $status >= 400) $reject = "upstream HTTP {$status}";
        if ($reject !== null) {
            if (str_contains($reject, 'not satisfiable')) fail($reject, 416);
            if (str_contains($reject, '409')) fail('upstream file is not ready yet', 503);   // retriable
            fail($reject, 502);
        }
        fail('upstream fetch failed: ' . ($err !== '' ? $err : 'no data'), 502);
    }
    exit;   // streamed to the ceiling or to EOF — both are normal endings
}

fail('unknown action');
