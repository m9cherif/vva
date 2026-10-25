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
$source = strtolower((string) ($in['source'] ?? 'youtube'));

/* ── Pexels source: direct MP4 stock footage (used when YouTube is blocked) ─ */
if ($source === 'pexels') {
    try {
        $data = pexels_api('/videos/search?query=' . rawurlencode($query)
            . '&per_page=' . min(80, max(10, $limit * 2)) . '&orientation=landscape');
        $videos = [];
        foreach (($data['videos'] ?? []) as $v) {
            $n = pexels_normalize(is_array($v) ? $v : [], $query);
            if ($n) $videos[] = $n;
        }
        // Pexels has no view counts — rank by duration (more footage to mine).
        usort($videos, fn($a, $b) => $b['duration'] <=> $a['duration']);
        json_out(['query' => $query, 'source' => 'pexels', 'videos' => array_slice($videos, 0, $limit)]);
    } catch (Throwable $e) {
        fail('Pexels search failed: ' . $e->getMessage(), 502);
    }
}
if ($source !== 'youtube') fail("unknown source \"{$source}\" (use youtube or pexels)");

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

    json_out(['query' => $query, 'source' => 'youtube', 'videos' => array_slice($videos, 0, $limit)]);
} catch (Throwable $e) {
    fail('YouTube search failed: ' . $e->getMessage(), 502);
}
