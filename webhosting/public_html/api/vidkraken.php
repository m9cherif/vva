<?php
/**
 * POST /api/vidkraken.php  { action: 'quota' | 'start' | 'status', ... }
 *
 * Server-side front door to VidKraken (https://vidkraken.com/), the YouTube
 * download-by-URL API every source video now comes through:
 *
 *   quota  → { ok, downloads, plan }                      free, GET /me
 *   start  → { id, startSec, endSec, format, attempt }    → { jobId, title, duration }
 *   status → { jobId }                                    → { status, downloadUrl, fileSize, ... }
 *
 * The API key lives in .env and never reaches the browser — this endpoint is
 * the only thing that carries it. Three hard rules keep this safe on shared
 * hosting:
 *   1. one short request per action (the poll loop runs in the browser, so no
 *      PHP script ever waits on a third party),
 *   2. the browser sends a video ID, never a URL — the YouTube URL is built
 *      here, so this can never be used as an open download proxy,
 *   3. the returned CDN host is checked against the relay allowlist before it
 *      is handed out; range.php re-checks it on every byte.
 *
 * A deterministic Idempotency-Key (video + window + format + attempt) means a
 * retried "start" can never burn a second download credit.
 */
require __DIR__ . '/_bootstrap.php';

$in = json_in();
$action = strtolower(trim((string) ($in['action'] ?? '')));

/* ── quota: how many downloads are left on the plan ─────────────────────── */
if ($action === 'quota') {
    $r = vidkraken_call('GET', '/me', null, [], 20);
    $d = is_array($r['data']) ? $r['data'] : [];
    json_out([
        'ok' => $r['status'] === 200,
        'downloads' => is_numeric($d['balances']['download_count']['remaining'] ?? null)
            ? (int) $d['balances']['download_count']['remaining'] : null,
        'bandwidthMb' => is_numeric($d['balances']['bandwidth_mb']['remaining'] ?? null)
            ? (int) $d['balances']['bandwidth_mb']['remaining'] : null,
        'plan' => $d['plan']['id'] ?? null,
        'error' => $r['status'] === 200 ? null : ($r['error'] ?? ('HTTP ' . $r['status'])),
    ]);
}

/* ── start: enqueue a trimmed download ──────────────────────────────────── */
if ($action === 'start') {
    $id = trim((string) ($in['id'] ?? ''));
    if (!preg_match('/^[A-Za-z0-9_-]{11}$/', $id)) fail('invalid YouTube video id');

    $start = max(0, (int) ($in['startSec'] ?? 0));
    $end = $start + max(5, (int) ($in['endSec'] ?? 0) - $start);
    $end = min($end, $start + 600);                       // never ask for > 10 min
    $format = (string) ($in['format'] ?? '480');
    if (!in_array($format, ['1080', '720', '480', '360'], true)) $format = '480';
    $attempt = max(0, min(9, (int) ($in['attempt'] ?? 0)));

    $r = vidkraken_call(
        'POST',
        '/download',
        [
            'url' => 'https://www.youtube.com/watch?v=' . $id,
            'format' => $format,
            'startTime' => $start,
            'endTime' => $end,
        ],
        // Same key + same payload = same job: retries are free of charge.
        ['Idempotency-Key' => "vva:{$id}:{$start}:{$end}:{$format}:a{$attempt}"],
        45
    );

    if ($r['status'] < 200 || $r['status'] >= 300 || !is_array($r['data']) || empty($r['data']['jobId'])) {
        $msg = $r['error'] ?? ('VidKraken did not accept the job (HTTP ' . $r['status'] . ')');
        $retryable = $r['status'] === 0
            || in_array($r['status'], [429, 500, 502, 503, 504], true)
            || str_contains($msg, 'NETWORK_ERROR');
        json_out(['error' => $msg, 'retryable' => $retryable], 502);
    }

    $d = $r['data'];
    json_out([
        'jobId' => (string) $d['jobId'],
        'title' => (string) ($d['title'] ?? ''),
        'duration' => (int) ($d['duration'] ?? 0),
        'status' => strtoupper((string) ($d['status'] ?? 'IN_QUEUE')),
        'format' => $format,
    ]);
}

/* ── status: one poll of an existing job ────────────────────────────────── */
if ($action === 'status') {
    $jobId = trim((string) ($in['jobId'] ?? ''));
    if (!preg_match('/^[A-Za-z0-9_-]{8,64}$/', $jobId)) fail('invalid job id');

    $r = vidkraken_call('GET', '/download/' . rawurlencode($jobId), null, [], 25);
    $d = is_array($r['data']) ? $r['data'] : [];
    $status = strtoupper((string) ($d['status'] ?? ''));

    if ($status === '') {
        // No job body at all: transport trouble or an unknown id. Both must be
        // reported in a shape the client treats as "keep trying, then fall back".
        json_out([
            'status' => $r['status'] === 0 ? 'NETWORK_ERROR' : 'FAILED',
            'error' => $r['error'] ?? ('unexpected response (HTTP ' . $r['status'] . ')'),
            'retryable' => true,
        ]);
    }

    if ($status === 'COMPLETED') {
        $url = (string) ($d['downloadUrl'] ?? '');
        $host = $url !== '' ? parse_url($url, PHP_URL_HOST) : null;
        if (!is_string($host) || !is_relay_host($host)) {
            json_out(['status' => 'FAILED', 'error' => 'VidKraken returned a download host we cannot relay', 'retryable' => false]);
        }
        json_out([
            'status' => 'COMPLETED',
            'downloadUrl' => $url,
            'fileSize' => (int) ($d['fileSize'] ?? 0),
            'actualFormat' => (string) ($d['actualFormat'] ?? ''),
            'title' => (string) ($d['title'] ?? ''),
            'duration' => (int) ($d['duration'] ?? 0),
        ]);
    }

    $code = (string) ($d['code'] ?? '');
    $retryable = in_array($status, ['IN_QUEUE', 'IN_PROGRESS'], true)
        || $code === 'NETWORK_ERROR'
        || ($status === 'FAILED' && $code === '');
    json_out([
        'status' => $status,
        'stage' => is_array($d['progress'] ?? null) ? ($d['progress']['stage'] ?? '') : '',
        'percent' => is_array($d['progress'] ?? null) ? (int) ($d['progress']['percent'] ?? 0) : 0,
        'code' => $code,
        'error' => (string) ($d['message'] ?? $d['error'] ?? $status),
        'retryable' => $retryable,
    ]);
}

fail('unknown action — use quota, start or status');
