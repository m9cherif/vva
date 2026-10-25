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
