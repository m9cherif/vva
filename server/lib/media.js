import fs from 'node:fs';
import path from 'node:path';
import { run } from './exec.js';
import { config, limits } from '../config.js';

/**
 * Sample 1 frame every `intervalSec` from a video into a directory.
 * Frame N is captured at t = (N - 1) * intervalSec seconds.
 * Returns { count, files } sorted chronologically.
 */
export async function extractFrames(src, outDir, intervalSec = limits.frameIntervalSec, width = limits.frameWidth, limitSec = 0) {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const pattern = path.join(outDir, 'f%04d.jpg');
  const vf = `fps=1/${intervalSec},scale=${width}:-2`;
  const args = ['-hide_banner', '-loglevel', 'error'];
  if (limitSec > 0) args.push('-t', limitSec.toFixed(2)); // input option: only read the analysis window
  args.push('-i', src, '-vf', vf, '-q:v', '4', '-f', 'image2', '-y', pattern);

  const res = await run(config.ffmpeg, args, { timeoutMs: 180_000 });

  const files = fs
    .readdirSync(outDir)
    .filter((f) => f.toLowerCase().endsWith('.jpg'))
    .sort();

  if (files.length === 0) {
    const tail = (res.stderr || '').split(/\r?\n/).filter(Boolean).slice(-3).join(' | ');
    throw new Error(`frame extraction failed: ${tail || 'no frames produced'}`);
  }
  return { count: files.length, files };
}

/**
 * Cut [startSec, startSec + durationSec] out of a source file into `out` (mp4, h264+aac).
 * `aspect` re-frames the footage: '16:9' as-is, '9:16' vertical, '1:1' square (centre crop).
 */
export async function cutClip(src, out, startSec, durationSec, aspect = '16:9') {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const args = ['-hide_banner', '-loglevel', 'error', '-ss', startSec.toFixed(2), '-i', src, '-t', durationSec.toFixed(2)];
  const vf = aspectFilter(aspect);
  if (vf) args.push('-vf', vf);
  args.push(
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100',
    '-movflags', '+faststart',
    '-avoid_negative_ts', 'make_zero',
    '-y', out
  );

  const res = await run(config.ffmpeg, args, { timeoutMs: 300_000 });
  if (res.code !== 0 || !fs.existsSync(out) || fs.statSync(out).size < 10_240) {
    const tail = (res.stderr || '').split(/\r?\n/).filter(Boolean).slice(-3).join(' | ');
    throw new Error(`clip cut failed: ${tail || `exit ${res.code}`}`);
  }
  return { file: out, bytes: fs.statSync(out).size };
}

/** Centre-crop to the target aspect, then scale to a social-ready size. */
function aspectFilter(aspect) {
  if (aspect === '9:16') {
    return "crop=w='2*trunc(min(iw,ih*9/16)/2)':h='2*trunc(ih/2)',scale=1080:1920:flags=lanczos";
  }
  if (aspect === '1:1') {
    return "crop=w='2*trunc(min(iw,ih)/2)':h='2*trunc(min(iw,ih)/2)',scale=1080:1080:flags=lanczos";
  }
  return '';
}

export function rmrf(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}
