<?php
/**
 * POST /api/player.php  { id } → { id, duration, title, channel, views, streams: [...] }
 *
 * Resolves DIRECT stream URLs through YouTube's Innertube player API. This is
 * the built-in fallback path: VidKraken is the primary source, and when it
 * fails (quota gone, job refused, network) the SAME already-chosen videos are
 * fetched through here — the research agent never re-chooses.
 *
 * Why several clients at once: YouTube's bot check is per client and per
 * visitor, so ANDROID can answer LOGIN_REQUIRED while IOS still hands over
 * plain URLs. All candidates are queried in parallel (one 8 s window, not
 * 4 x 8 s) and the first playable answer wins. Each stream carries
 * contentLength so the browser can compute exact byte ranges for a window.
 */
require __DIR__ . '/_bootstrap.php';

$in = json_in();
$id = trim((string) ($in['id'] ?? ''));
$provider = strtolower((string) ($in['provider'] ?? 'youtube'));
if ($provider !== 'youtube') fail("unknown provider \"{$provider}\" (only youtube is supported)");
if (!preg_match('/^[A-Za-z0-9_-]{11}$/', $id)) fail('invalid video id');

/** Every stream with a usable URL, split by kind (ciphered ones are dropped:
 *  deciphering needs the player JS, which this host cannot run). */
function yt_collect_streams(array $data): array {
    $streams = [];
    $collect = function (?array $list, string $kind) use (&$streams) {
        foreach ($list ?? [] as $f) {
            $url = $f['url'] ?? null;
            if (!$url) continue;
            $streams[] = [
                'itag' => (int) ($f['itag'] ?? 0),
                'kind' => $kind,
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
    foreach ($streams as &$s) {
        if ($s['kind'] === 'video' && str_contains($s['mimeType'], 'audio')) $s['kind'] = 'audio';
    }
    return $streams;
}

/** Ask every client for the same video at the same time (bounded, one window). */
function yt_player_parallel(string $key, string $id, array $clients, string $visitor): array {
    $mh = curl_multi_init();
    $handles = [];
    foreach ($clients as $i => $c) {
        $client = ['clientName' => $c['name'], 'clientVersion' => $c['version']] + $c['extra'];
        if ($visitor !== '') $client['visitorData'] = $visitor;
        $headers = [
            'Content-Type: application/json',
            'Accept: application/json',
            'User-Agent: ' . $c['ua'],
            'X-Youtube-Client-Name: ' . $c['code'],
            'X-Youtube-Client-Version: ' . $c['version'],
        ];
        if ($visitor !== '') $headers[] = 'X-Goog-Visitor-Id: ' . $visitor;
        $ch = curl_init("https://www.youtube.com/youtubei/v1/player?key={$key}&prettyPrint=false");
        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => json_encode([
                'context' => ['client' => $client, 'user' => ['lockedSafetyMode' => false]],
                'videoId' => $id,
                'contentCheckOk' => true,
                'racyCheckOk' => true,
            ], JSON_UNESCAPED_SLASHES),
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_TIMEOUT => 8,
            CURLOPT_CONNECTTIMEOUT => 5,
            CURLOPT_ENCODING => '',
        ]);
        curl_multi_add_handle($mh, $ch);
        $handles[$i] = $ch;
    }
    $active = null;
    do {
        $status = curl_multi_exec($mh, $active);
        if ($active) curl_multi_select($mh, 1.0);
    } while ($active && $status === CURLM_OK);

    $out = [];
    foreach ($handles as $i => $ch) {
        $out[$i] = [
            'status' => (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE),
            'body' => (string) curl_getcontent($ch),
        ];
        curl_multi_remove_handle($mh, $ch);
        curl_close($ch);
    }
    curl_multi_close($mh);
    return $out;
}

$clients = [
    // code = X-Youtube-Client-Name enum. ANDROID first: it returns the plainst
    // URLs, which is exactly what a browser-side byte range needs.
    ['name' => 'ANDROID', 'code' => 3, 'version' => '20.10.38',
     'extra' => ['androidSdkVersion' => 30, 'userAgent' => 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip'],
     'ua' => 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip'],
    ['name' => 'IOS', 'code' => 5, 'version' => '20.10.34',
     'extra' => ['deviceMake' => 'Apple', 'deviceModel' => 'iPhone16,2'],
     'ua' => 'com.google.ios.youtube/20.10.34 (iPhone16,2; U; CPU OS 17_5_1 like Mac OS X;)'],
    ['name' => 'TVHTML5', 'code' => 7, 'version' => '7.20250101.00.00',
     'extra' => [],
     'ua' => 'Mozilla/5.0 (ChromiumStylePlatform) Cobalt/Version'],
    ['name' => 'WEB', 'code' => 1, 'version' => '2.20251015.01.00',
     'extra' => [],
     'ua' => UA_BROWSER],
];

try {
    $key = innertube_key();
    $visitor = innertube_visitor();
    $responses = yt_player_parallel($key, $id, $clients, $visitor);

    $best = null;
    $bestStreams = [];
    $reasons = [];
    foreach ($responses as $i => $r) {
        $d = json_decode($r['body'], true);
        if (!is_array($d)) {
            $reasons[] = $clients[$i]['name'] . ': HTTP ' . $r['status'];
            continue;
        }
        $status = (string) ($d['playabilityStatus']['status'] ?? 'UNKNOWN');
        $streams = yt_collect_streams($d);
        if ($status === 'OK' && $streams) { $best = $d; $bestStreams = $streams; break; }
        $why = (string) ($d['playabilityStatus']['reason'] ?? $d['playabilityStatus']['messages'][0] ?? $status);
        $reasons[] = $clients[$i]['name'] . ': ' . $status . ' ' . mb_substr($why, 0, 70);
    }

    if ($best === null) {
        fail('video not playable from this server — ' . (implode(' | ', $reasons) ?: 'no client answered'), 409);
    }

    json_out([
        'id' => $id,
        'duration' => (int) ($best['videoDetails']['lengthSeconds'] ?? 0),
        'title' => (string) ($best['videoDetails']['title'] ?? ''),
        'channel' => (string) ($best['videoDetails']['author'] ?? ''),
        'views' => (int) ($best['videoDetails']['viewCount'] ?? 0),
        'streams' => $bestStreams,
    ]);
} catch (Throwable $e) {
    fail('stream resolution failed: ' . $e->getMessage(), 502);
}
