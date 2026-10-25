<?php
/**
 * Job state persistence — the browser-orchestrated pipeline checkpoints here.
 *
 * GET    /api/jobs.php            → { jobs: [...] }        (summaries, newest first)
 * GET    /api/jobs.php?id=<id>    → full job JSON
 * PUT    /api/jobs.php            ← { id, ...job }         (save / checkpoint)
 * DELETE /api/jobs.php?id=<id>    → delete one run
 *
 * State lives in data/jobs/<id>/job.json (outside any URL space if the host
 * lets us — here under public_html/data, protected by .htaccess deny rules).
 */
require __DIR__ . '/_bootstrap.php';

$jobsDir = cfg()['jobsDir'];

function job_id_ok(string $id): bool {
    return (bool) preg_match('/^[A-Za-z0-9_-]{6,64}$/', $id);
}

function read_job(string $dir, string $id): ?array {
    $file = $dir . '/' . $id . '/job.json';
    if (!is_file($file)) return null;
    $data = json_decode((string) file_get_contents($file), true);
    return is_array($data) ? $data : null;
}

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$id = (string) ($_GET['id'] ?? '');

if ($method === 'GET') {
    if ($id !== '') {
        if (!job_id_ok($id)) fail('invalid job id');
        $job = read_job($jobsDir, $id);
        if (!$job) fail('run not found', 404);
        json_out($job);
    }
    $jobs = [];
    foreach (glob($jobsDir . '/*/job.json') ?: [] as $file) {
        $job = json_decode((string) file_get_contents($file), true);
        if (!is_array($job)) continue;
        $jobs[] = [
            'id' => $job['id'] ?? basename(dirname($file)),
            'category' => $job['category'] ?? ($job['params']['category'] ?? 'Run'),
            'status' => $job['status'] ?? 'unknown',
            'clipCount' => count($job['clips'] ?? []),
            'clipLength' => $job['params']['clipLength'] ?? null,
            'quality' => $job['params']['quality'] ?? null,
            'aspect' => $job['params']['aspect'] ?? null,
            'createdAt' => $job['createdAt'] ?? null,
            'finishedAt' => $job['finishedAt'] ?? null,
        ];
    }
    usort($jobs, fn($a, $b) => ($b['finishedAt'] ?? $b['createdAt'] ?? 0) <=> ($a['finishedAt'] ?? $a['createdAt'] ?? 0));
    json_out(['jobs' => $jobs]);
}

if ($method === 'PUT' || $method === 'POST') {
    $job = json_in();
    $id = (string) ($job['id'] ?? '');
    if (!job_id_ok($id)) fail('invalid job id');
    // Bound the payload: job JSON holds logs + metadata, never megabytes.
    if (strlen(json_encode($job)) > 6_000_000) fail('job state too large', 413);
    $dir = $jobsDir . '/' . $id;
    if (!is_dir($dir) && !@mkdir($dir, 0775, true)) fail('could not create job directory', 500);
    $tmp = $dir . '/.job.tmp';
    if (@file_put_contents($tmp, json_encode($job, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), LOCK_EX) === false) {
        fail('could not write job state', 500);
    }
    rename($tmp, $dir . '/job.json');
    json_out(['ok' => true, 'id' => $id]);
}

if ($method === 'DELETE') {
    if (!job_id_ok($id)) fail('invalid job id');
    $dir = $jobsDir . '/' . $id;
    if (is_dir($dir)) {
        foreach (glob($dir . '/*') ?: [] as $f) @unlink($f);
        @rmdir($dir);
    }
    json_out(['ok' => true]);
}

fail('method not allowed', 405);
