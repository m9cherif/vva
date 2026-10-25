<?php
/**
 * POST /api/player.php  { id } → { id, duration, title, channel, views, streams: [...] }
 *
 * Resolves DIRECT stream URLs through YouTube's Innertube player API using the
 * ANDROID client — that client returns plain URLs (no signature deciphering),
 * which is what lets this app run without yt-dlp. Each stream carries
 * contentLength so the browser can compute exact byte ranges for a time window.
 */
require __DIR__ . '/_bootstrap.php';

$in = json_in();
$id = trim((string) ($in['id'] ?? ''));
$provider = strtolower((string) ($in['provider'] ?? 'youtube'));

/* ── Pexels: direct progressive MP4 files, no signing, no bot check ─────── */
if ($provider === 'pexels') {
    if (!preg_match('/^\d{1,12}$/', $id)) fail('invalid video id');
    try {
        $d = pexels_api('/videos/videos/' . rawurlencode($id));
        $files = [];
        foreach (($d['video_files'] ?? []) as $f) {
            if (!is_array($f) || empty($f['link'])) continue;
            if (($f['file_type'] ?? '') !== 'video/mp4') continue;
            $files[] = [
                'itag' => 0,
                'kind' => 'video',
                'url' => (string) $f['link'],
                'mimeType' => 'video/mp4',
                'width' => (int) ($f['width'] ?? 0),
                'height' => (int) ($f['height'] ?? 0),
                'fps' => 0, 'bitrate' => 0,
                'contentLength' => 0,      // probed on demand by range.php
                'audioQuality' => '',
            ];
        }
        if (!$files) fail('no downloadable mp4 files for this video', 409);
        usort($files, fn($a, $b) => $b['height'] <=> $a['height']);
        json_out([
            'id' => $id,
            'provider' => 'pexels',
            'duration' => (int) ($d['duration'] ?? 0),
            'title' => trim(($d['title'] ?? '') ?: ('Pexels video ' . $id)),
            'channel' => (string) ($d['user']['name'] ?? 'Pexels'),
            'views' => 0,
            'streams' => $files,
        ]);
    } catch (Throwable $e) {
        fail('Pexels stream resolution failed: ' . $e->getMessage(), 502);
    }
}
/* ── Internet Archive: item metadata → direct faststart MP4 ─────────────── */
if ($provider === 'archive') {
    if (!preg_match('/^[A-Za-z0-9._-]{3,80}$/', $id)) fail('invalid item id');
    try {
        $meta = archive_metadata($id);
        if (!$meta) fail('archive item not found', 404);
        $candidates = archive_mp4_files($meta);
        if (!$candidates) fail('this archive item has no mp4 file', 409);
        // Pick a derivative we have actually read bytes from — archive.org
        // lists restricted files that answer 403 to every range request.
        $urls = [];
        foreach ($candidates as $i => $f) $urls[$i] = archive_file_url($meta, $f['name']);
        $ok = archive_probe_urls($urls, 15);
        $file = null;
        $streamUrl = '';
        foreach ($candidates as $i => $f) {            // faststart first: the
            if (!empty($ok[$urls[$i]]['faststart'])) { // browser can decode it
                $file = $f; $streamUrl = $urls[$i]; break;
            }
        }
        if (!$file) {
            foreach ($candidates as $i => $f) {
                if (!empty($ok[$urls[$i]]['ok'])) { $file = $f; $streamUrl = $urls[$i]; break; }
            }
        }
        if (!$file) fail('the mp4 files of this item are not downloadable (HTTP 403)', 409);
        $md = is_array($meta['metadata'] ?? null) ? $meta['metadata'] : [];
        $title = (string) ($md['title'] ?? $id);
        if (is_array($title)) $title = (string) ($title[0] ?? $id);
        $creator = (string) (($md['creator'] ?? '') ?: 'Internet Archive');
        if (is_array($creator)) $creator = (string) ($creator[0] ?? 'Internet Archive');
        json_out([
            'id' => $id,
            'provider' => 'archive',
            'duration' => archive_parse_length($file['length']),
            'title' => mb_substr($title, 0, 90),
            'channel' => $creator,
            'views' => 0,
            'streams' => [[
                'itag' => 0,
                'kind' => 'video',
                'url' => $streamUrl,
                'mimeType' => 'video/mp4',
                'width' => $file['width'],
                'height' => $file['height'],
                'fps' => 0, 'bitrate' => 0,
                'contentLength' => $file['size'],
                'audioQuality' => '',
            ]],
        ]);
    } catch (Throwable $e) {
        fail('Archive stream resolution failed: ' . $e->getMessage(), 502);
    }
}

if ($provider !== 'youtube') fail("unknown provider \"{$provider}\" (use youtube, pexels or archive)");
if (!preg_match('/^[A-Za-z0-9_-]{11}$/', $id)) fail('invalid video id');

try {
    $key = innertube_key();
    $body = [
        'context' => innertube_context('ANDROID', '20.10.38', [
            'androidSdkVersion' => 30,
            'userAgent' => 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip',
        ]),
        'videoId' => $id,
        'contentCheckOk' => true,
        'racyCheckOk' => true,
    ];
    $res = http_post_json(
        "https://www.youtube.com/youtubei/v1/player?key={$key}&prettyPrint=false",
        $body,
        ['User-Agent: com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip'],
        30, 12
    );
    if ($res['status'] !== 200) fail("player API returned HTTP {$res['status']}", 502);
    $data = json_decode($res['body'], true);
    if (!is_array($data)) fail('player API returned malformed data', 502);

    $status = $data['playabilityStatus']['status'] ?? 'UNKNOWN';
    if ($status !== 'OK') {
        $reason = $data['playabilityStatus']['reason'] ?? $status;
        fail("video not playable ({$status}): {$reason}", 409);
    }

    $streams = [];
    $collect = function (?array $list, string $kind) use (&$streams) {
        foreach ($list ?? [] as $f) {
            $url = $f['url'] ?? null;
            if (!$url) continue; // ciphered URLs are unusable without yt-dlp
            $streams[] = [
                'itag' => (int) ($f['itag'] ?? 0),
                'kind' => $kind,                       // 'muxed' | 'video' | 'audio'
                'url' => $url,
                'mimeType' => (string) ($f['mimeType'] ?? ''),
                'width' => (int) ($f['width'] ?? 0),
                'height' => (int) ($f['height'] ?? 0),
                'fps' => (int) ($f['fps'] ?? 0),
                'bitrate' => (int) ($f['bitrate'] ?? 0),
                'contentLength' => (int) ($f['contentLength'] ?? 0),
                'audioQuality' => (string) ($f['audioQuality'] ?? ''),
            ];
        }
    };
    $collect($data['streamingData']['formats'] ?? null, 'muxed');
    $collect($data['streamingData']['adaptiveFormats'] ?? null, 'video');
    // adaptiveFormats holds audio tracks too — split them out by mime.
    foreach ($streams as &$s) {
        if ($s['kind'] === 'video' && str_contains($s['mimeType'], 'audio')) $s['kind'] = 'audio';
    }
    unset($s);

    if (!$streams) fail('no downloadable streams for this video', 409);

    json_out([
        'id' => $id,
        'duration' => (int) ($data['videoDetails']['lengthSeconds'] ?? 0),
        'title' => (string) ($data['videoDetails']['title'] ?? ''),
        'channel' => (string) ($data['videoDetails']['author'] ?? ''),
        'views' => (int) ($data['videoDetails']['viewCount'] ?? 0),
        'streams' => $streams,
    ]);
} catch (Throwable $e) {
    fail('stream resolution failed: ' . $e->getMessage(), 502);
}
