<?php
/**
 * POST /api/search.php  { query, limit? } → { videos: [...] }
 *
 * YouTube search through the public Innertube API (no API key, no yt-dlp).
 * Same normalization as server/lib/ytdlp.js: drop live/short/long videos,
 * sort by views, most promising candidates first.
 */
require __DIR__ . '/_bootstrap.php';

$in = json_in();
$query = trim((string) ($in['query'] ?? ''));
if ($query === '') fail('query is required');
$limit = max(1, min(60, (int) ($in['limit'] ?? limits()['searchPoolSize'])));

try {
    $key = innertube_key();
    $body = [
        'context' => innertube_context('WEB', '2.20251015.01.00'),
        'query' => $query,
    ];
    $res = http_post_json("https://www.youtube.com/youtubei/v1/search?key={$key}&prettyPrint=false", $body, [], 30, 12);
    if ($res['status'] !== 200) fail("YouTube search returned HTTP {$res['status']}", 502);
    $data = json_decode($res['body'], true);
    if (!is_array($data)) fail('YouTube search returned malformed data', 502);

    $found = [];
    collect_videos($data, $found);

    $videos = array_values(array_filter($found, function ($v) {
        return $v['duration'] >= limits()['minSourceDurationSec']
            && $v['duration'] <= limits()['maxSourceDurationSec']
            && !$v['live'];
    }));
    usort($videos, fn($a, $b) => $b['views'] <=> $a['views']);

    json_out(['query' => $query, 'videos' => array_slice($videos, 0, $limit)]);
} catch (Throwable $e) {
    fail('YouTube search failed: ' . $e->getMessage(), 502);
}
