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
/* ── Internet Archive: keyless search + faststart MP4 files ─────────────── */
if ($source === 'archive') {
    try {
        $q = rawurlencode(trim($query) . ' AND mediatype:movies');
        $rows = 40;   // metadata is fetched in parallel; a wide pool matters because
                      // many archive items have no usable mp4 derivative
        $res = http_get_json(
            "https://archive.org/advancedsearch.php?q={$q}&fl%5B%5D=identifier&fl%5B%5D=title"
            . "&fl%5B%5D=downloads&rows={$rows}&output=json",
            [], 30
        );
        if ($res['status'] !== 200) fail("Archive.org search returned HTTP {$res['status']}", 502);
        $data = json_decode($res['body'], true);
        $docs = $data['response']['docs'] ?? [];
        if (!is_array($docs) || !$docs) json_out(['query' => $query, 'source' => 'archive', 'videos' => []]);

        $metas = archive_metadata_bulk(array_map(fn($d) => (string) ($d['identifier'] ?? ''), $docs), 45);
        $videos = [];
        foreach ($docs as $doc) {
            $id = (string) ($doc['identifier'] ?? '');
            if ($id === '' || !isset($metas[$id])) continue;
            $n = archive_normalize($metas[$id], is_array($doc) ? $doc : [], $query);
            if ($n) $videos[] = $n;
        }
        usort($videos, fn($a, $b) => $b['views'] <=> $a['views']);

        // Archive.org lists files that are not downloadable (HTTP 403). Only
        // hand candidates to the AI whose bytes we could actually range-read,
        // otherwise a job dies after the agent has already picked them.
        $probe = [];
        foreach ($videos as $v) {
            if (isset($metas[$v['id']])) $probe[$v['id']] = archive_file_url($metas[$v['id']], $v['file']);
        }
        $ok = archive_probe_urls($probe, 8);
        $checked = count(array_filter($ok));
        $videos = array_values(array_filter($videos, fn($v) => !empty($ok[$probe[$v['id']] ?? ''])));
        json_out([
            'query' => $query, 'source' => 'archive',
            'videos' => array_slice($videos, 0, $limit),
            'checked' => $checked, 'downloadable' => count($videos),
        ]);
    } catch (Throwable $e) {
        fail('Archive.org search failed: ' . $e->getMessage(), 502);
    }
}

if ($source !== 'youtube') fail("unknown source \"{$source}\" (use youtube, pexels or archive)");

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
