<?php
/**
 * POST /api/ai.php  { system, user, images?: [base64 jpeg], history?: [{role,content}],
 *                     maxTokens?, temperature? }  →  { text, model }
 *
 * Server-side proxy to NVIDIA NIM: the API key never reaches the browser, and
 * the model fallback chain (try every configured vision model, retry transient
 * failures) lives here exactly like server/lib/nvidia.js.
 */
require __DIR__ . '/_bootstrap.php';

set_time_limit(170);

$in = json_in();
$cfg = cfg();
if ($cfg['apiKey'] === '') fail('NVIDIA_API_KEY is not configured on the server', 500);

$system = (string) ($in['system'] ?? 'You are a precise multimodal analyst.');
$user = (string) ($in['user'] ?? '');
if ($user === '') fail('user message is required');
$images = [];
foreach ((array) ($in['images'] ?? []) as $b64) {
    $b64 = (string) $b64;
    if ($b64 !== '' && strlen($b64) < 4_000_000) $images[] = preg_replace('/^data:image\/\w+;base64,/', '', $b64);
}
$history = [];
foreach ((array) ($in['history'] ?? []) as $m) {
    $role = (string) ($m['role'] ?? '');
    if (!in_array($role, ['user', 'assistant'], true)) continue;
    $content = $m['content'] ?? '';
    $history[] = ['role' => $role, 'content' => is_string($content) ? $content : json_encode($content)];
}
$maxTokens = max(16, min(8000, (int) ($in['maxTokens'] ?? 1600)));
$temperature = max(0.0, min(2.0, (float) ($in['temperature'] ?? 0.2)));
$attempts = max(1, min(3, (int) ($in['attempts'] ?? 2)));
$timeout = min(limits()['aiTimeoutSec'], max(30, (int) ($in['timeoutSec'] ?? 70)));
/* Hard deadline: the browser aborts at 200s and PHP dies at 170s, so the
 * model chain must always answer in time — with a failure report if nothing
 * worked, never by hanging. */
$deadline = microtime(true) + min(150, limits()['aiTimeoutSec'] - 10);
$remaining = fn(): int => (int) floor($deadline - microtime(true));

/** One call to one model. Returns [ok, text|error, meta]. */
function call_model(string $model, array $messages, int $maxTokens, float $temperature, int $timeout): array {
    $cfg = cfg();
    // Images attach to the final user message (vision models expect them inline).
    if ($GLOBALS['images'] && $messages) {
        $lastIdx = count($messages) - 1;
        $parts = [['type' => 'text', 'text' => (string) $messages[$lastIdx]['content']]];
        foreach ($GLOBALS['images'] as $b64) {
            $parts[] = ['type' => 'image_url', 'image_url' => ['url' => 'data:image/jpeg;base64,' . $b64]];
        }
        $messages[$lastIdx]['content'] = $parts;
    }
    try {
        $res = http_post_json($cfg['apiBase'] . '/chat/completions', [
            'model' => $model,
            'messages' => $messages,
            'temperature' => $temperature,
            'max_tokens' => $maxTokens,
        ], ['Authorization: Bearer ' . $cfg['apiKey']], $timeout, 15);
    } catch (Throwable $e) {
        return [false, 'network: ' . $e->getMessage(), ['rateLimit' => false]];
    }
    $status = $res['status'];
    if ($status < 200 || $status >= 300) {
        return [false, "HTTP {$status} " . substr($res['body'], 0, 220), [
            'rateLimit' => $status === 429, 'serverError' => $status >= 500, 'empty' => false,
        ]];
    }
    $data = json_decode($res['body'], true);
    $text = $data['choices'][0]['message']['content'] ?? null;
    if (!is_string($text) || trim($text) === '') {
        return [false, 'empty content', ['rateLimit' => false, 'serverError' => false, 'empty' => true]];
    }
    return [true, $text, ['truncated' => ($data['choices'][0]['finish_reason'] ?? '') === 'length']];
}

$images = array_values($images); // read by call_model() via $GLOBALS['images']
$warnings = [];
$failures = [];

$messages = [['role' => 'system', 'content' => $system]];
foreach ($history as $m) $messages[] = $m;
$messages[] = ['role' => 'user', 'content' => $user];

for ($round = 0; $round < $attempts; $round++) {
    foreach ($cfg['visionModels'] as $model) {
        $left = $remaining();
        if ($left < 10) break 2;
        [$ok, $text, $meta] = call_model($model, $messages, $maxTokens, $temperature, min($timeout, $left));
        // Transient trouble on this model (5xx / empty reply) — retry it once before falling through.
        $tries = 0;
        while ($tries < 2 && !$ok && $remaining() > 25 && (!empty($meta['serverError']) || !empty($meta['empty']))) {
            $warnings[] = $model . ' ' . (!empty($meta['serverError']) ? 'server error' : 'empty reply') . ' — retrying';
            [$ok, $text, $meta] = call_model($model, $messages, $maxTokens, $temperature, min($timeout, $remaining()));
            $tries++;
        }
        if ($ok) {
            json_out(['text' => $text, 'model' => $model, 'truncated' => !empty($meta['truncated']), 'warnings' => $warnings]);
        }
        $failures[] = "{$model} -> {$text}";
        $warnings[] = "{$model} failed: {$text}";
        if (!empty($meta['rateLimit']) && $remaining() > 15) sleep(min(6 * ($round + 1), $remaining() - 10));
    }
    if ($remaining() < 10) break;
    sleep(1);
}

fail('AI call failed: ' . implode('  | ', array_slice($failures, -3)), 502);
