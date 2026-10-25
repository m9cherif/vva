import fs from 'node:fs';
import path from 'node:path';
import { run } from './exec.js';
import { config, limits, ROOT } from '../config.js';

const YT = [config.python, ['-m', 'yt_dlp']];

/**
 * On Windows this host has a broken IPv6 route: Python resolves YouTube to IPv6 first and the
 * connect hangs forever, so children get a sitecustomize shim that drops AAAA answers.
 * Linux in the sandbox has working IPv6 — no shim needed there.
 */
const SHIM_DIR = path.join(ROOT, 'server', 'shims');
function childEnv() {
  if (process.platform !== 'win32') return { ...process.env };
  const env = { ...process.env, IPV4_ONLY: '1' };
  env.PYTHONPATH = env.PYTHONPATH ? `${SHIM_DIR}${path.delimiter}${env.PYTHONPATH}` : SHIM_DIR;
  return env;
}

/** yt-dlp wants a real path for --ffmpeg-location; the system ffmpeg is found on PATH instead. */
function ffmpegLocArg() {
  return config.ffmpegLocation ? ['--ffmpeg-location', config.ffmpegLocation] : [];
}

function ytArgs(...extra) {
  return [...YT[1], ...extra];
}

const NOISE = /Deprecated Feature|no-call-home|issues\/14198|CategoryInfo|FullyQualifiedErrorId|^\s*\+|^\s*\.\.\./;

/** Limit concurrent yt-dlp work across ALL jobs so we never trip YouTube rate limits. */
const MAX_SEARCHES = 1;
const MAX_DOWNLOADS = 2;
function makeSemaphore(limit) {
  let active = 0;
  const queue = [];
  return {
    async acquire() {
      if (active < limit) {
        active += 1;
        return;
      }
      await new Promise((resolve) => queue.push(resolve));
      active += 1;
    },
    release() {
      active -= 1;
      const next = queue.shift();
      if (next) next();
    },
  };
}
const searchGate = makeSemaphore(MAX_SEARCHES);
const downloadGate = makeSemaphore(MAX_DOWNLOADS);

/**
 * Search YouTube for candidate source videos. Returns normalized metadata only
 * (no download). Sorted by view count, best candidates first.
 * Searches are serialized globally and retried: search pages come back empty occasionally.
 */
export function searchVideos(query, poolSize = limits.searchPoolSize) {
  return withGate(searchGate, () => doSearch(query, poolSize));
}

async function withGate(gate, task) {
  await gate.acquire();
  try {
    return await task();
  } finally {
    gate.release();
  }
}

async function doSearch(query, poolSize) {
  const args = ytArgs(
    `ytsearch${poolSize}:${query}`,
    '--flat-playlist',
    '--dump-json',
    '--skip-download',
    '--no-warnings',
    '--socket-timeout', '20',
    '--encoding', 'utf-8'
  );

  let rows = [];
  const errors = [];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const res = await run(config.python, args, { timeoutMs: 150_000, env: childEnv() });
    rows = [];
    for (const line of res.stdout.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) continue;
      try {
        rows.push(JSON.parse(trimmed));
      } catch {
        /* skip malformed line */
      }
    }
    if (rows.length > 0) break;
    errors.push(`attempt ${attempt} (exit ${res.code}): ${cleanStderr(res.stderr) || 'no output'}`);
    await new Promise((r) => setTimeout(r, 1_500 * attempt));
  }

  if (rows.length === 0) {
    throw new Error(`YouTube search returned nothing for "${query}". ${errors[errors.length - 1] || ''}`.trim());
  }

  return rows
    .filter((v) => v.id && v.duration && (v.url || v.webpage_url))
    .map((v) => ({
      id: v.id,
      title: v.title || 'Untitled',
      channel: v.channel || v.uploader || v.uploader_id || 'Unknown channel',
      duration: Number(v.duration) || 0,
      views: Number(v.view_count) || 0,
      url: v.url || v.webpage_url || `https://www.youtube.com/watch?v=${v.id}`,
      thumb: Array.isArray(v.thumbnails) && v.thumbnails.length
        ? v.thumbnails[v.thumbnails.length - 1].url
        : `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`,
      live: Boolean(v.live_status && v.live_status !== 'not_live'),
    }))
    .filter((v) => !v.live)
    .filter((v) => v.duration >= limits.minSourceDurationSec && v.duration <= limits.maxSourceDurationSec)
    .sort((a, b) => b.views - a.views);
}

/** Strip PowerShell/deprecation noise so error messages show the real cause. */
function cleanStderr(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !NOISE.test(l))
    .slice(0, 3)
    .join(' | ');
}

/**
 * Download ONLY `[startSec, startSec + durationSec]` of a source video as a local mp4.
 *
 * This is the workhorse of the whole app: this host only gets ~150 KB/s from YouTube,
 * so pulling a full 10-minute 720p60 compilation (166 MB) would take a third of an hour.
 * A 90-second analysis window at 360p is ~5 MB. yt-dlp hands the section to ffmpeg, which
 * reads the range straight off the CDN (the Python range downloader stalls on this network).
 *
 * Falls back to a full download if the section route fails.
 *
 * @param {{startSec?: number, durationSec?: number, height?: number, tag?: string,
 *          timeoutMs?: number, onProgress?: (percent: number) => void}} opts
 * @returns {Promise<{file: string, bytes: number}>}
 */
export function downloadSection(video, jobDir, opts = {}) {
  return withGate(downloadGate, () => doSection(video, jobDir, opts));
}

async function doSection(video, jobDir, { startSec = 0, durationSec = 90, height = 360, tag = 'src', timeoutMs, onProgress } = {}) {
  const cap = Math.max(144, Math.min(720, Math.round(Number(height) || 360)));
  const start = Math.max(0, Number(startSec) || 0);
  const end = start + Math.max(5, Number(durationSec) || 90);
  const outBase = path.join(jobDir, `${tag}_${video.id}`);
  const progress = makeProgress(end - start, onProgress);

  const sectionArgs = ytArgs(
    ...ffmpegLocArg(),
    '--no-playlist',
    '--no-warnings',
    '--retries', '5',
    '--fragment-retries', '5',
    '--socket-timeout', '25',
    '--playlist-end', '1',
    '-f', `bv*[height<=${cap}]+ba/b[height<=${cap}]/b`,
    '--download-sections', `*${start.toFixed(2)}-${end.toFixed(2)}`,
    '--force-keyframes-at-cuts',
    '--merge-output-format', 'mp4',
    '-o', `${outBase}.%(ext)s`,
    video.url
  );

  const res = await run(config.python, sectionArgs, {
    timeoutMs: timeoutMs || limits.sectionTimeoutMs,
    env: childEnv(),
    onData: progress,
  });

  let file = pickFile(outBase);
  if (!file && !res.timedOut) {
    // Section route failed (not just slow) — retry once before giving up.
    const retry = await run(config.python, sectionArgs, {
      timeoutMs: timeoutMs || limits.sectionTimeoutMs,
      env: childEnv(),
      onData: progress,
    });
    file = pickFile(outBase);
    if (!file) {
      res.stderr = retry.stderr;
      res.timedOut = retry.timedOut;
      res.code = retry.code;
    }
  }
  if (file) return { file, bytes: fs.statSync(file).size };

  // A full download is only affordable for short sources: at ~150 KB/s a long video
  // would never finish, so don't burn eight minutes proving it.
  if (Number(video.duration) > 180) {
    const reason = cleanStderr(res.stderr) || (res.timedOut ? 'timed out' : `exit ${res.code}`);
    throw new Error(`section download failed: ${reason || 'no output'}`);
  }
  return fullDownloadFallback(video, jobDir, { tag, cap, outBase, stderr: res.stderr, timedOut: res.timedOut, code: res.code });
}

/** Last resort: pull the whole file through the Python downloader (slow, but it does finish). */
async function fullDownloadFallback(video, jobDir, { tag, cap, outBase, stderr, timedOut, code }) {
  const altBase = outBase.replace(/$/, ''); // keep the same base so cleanup still matches the tag
  const args = ytArgs(
    ...ffmpegLocArg(),
    '--no-playlist',
    '--no-warnings',
    '--retries', '3',
    '--fragment-retries', '3',
    '--socket-timeout', '25',
    '--playlist-end', '1',
    '-f', `b[height<=${cap}]/bv*[height<=${cap}]+ba/b`,
    '--merge-output-format', 'mp4',
    '-o', `${altBase}.%(ext)s`,
    video.url
  );
  await run(config.python, args, { timeoutMs: limits.downloadTimeoutMs, env: childEnv() });
  const file = pickFile(altBase);
  if (!file) {
    const reason = cleanStderr(stderr) || (timedOut ? 'timed out' : `exit ${code}`);
    throw new Error(`download failed: ${reason}`);
  }
  return { file, bytes: fs.statSync(file).size };
}

function pickFile(outBase) {
  return ['.mp4', '.mkv', '.webm']
    .map((ext) => `${outBase}${ext}`)
    .find((p) => fs.existsSync(p) && fs.statSync(p).size > 40_960);
}

/**
 * Turns raw yt-dlp/ffmpeg output into a 0-100 percent.
 * yt-dlp prints `[download] 43.2% of ...` for its own transfers; while ffmpeg is doing the
 * fetching (section downloads) we read the `time=HH:MM:SS.xx` from its progress lines.
 */
function makeProgress(sectionSeconds, onProgress) {
  if (!onProgress) return null;
  let last = -1;
  // Only ever emits a strictly larger integer percent (never repeats, never goes back).
  const push = (raw) => {
    const rounded = Math.max(0, Math.min(99, Math.round(raw)));
    if (!Number.isFinite(rounded) || rounded <= last) return;
    last = rounded;
    onProgress(rounded);
  };
  return (chunk) => {
    // yt-dlp's own transfer: "[download] 43.2% of 12.70MiB at 137.72KiB/s"
    const m = /\[download\]\s+(\d+(?:\.\d+)?)%/.exec(chunk);
    if (m) return push(Number(m[1]));

    // ffmpeg progress (section downloads): "time=00:00:42.34" or "out_time_us=42340000"
    const clock = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(chunk);
    if (clock) return push(((Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3])) / sectionSeconds) * 100);
    const us = /out_time_(?:us|ms)=(\d+)/.exec(chunk);
    if (us) return push((Number(us[1]) / 1e6 / sectionSeconds) * 100);
  };
}

/** Read container duration in seconds (ffmpeg, no ffprobe available). */
export async function probeDuration(file) {
  const res = await run(config.ffmpeg, ['-hide_banner', '-i', file], { timeoutMs: 30_000 });
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(res.stderr || '');
  if (!m) return 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}
