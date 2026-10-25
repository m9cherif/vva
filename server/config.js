import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

// Minimal .env loader (no dependencies).
function loadEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i === -1) continue;
    const key = line.slice(0, i).trim();
    const value = line.slice(i + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadEnv();

const list = (value, fallback) =>
  (value || fallback)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

export const config = {
  // 0.0.0.0 by default: on any deploy platform the app must be reachable from
  // outside the container, and a loopback bind leaves the health check hanging
  // forever. HOST still overrides it for local runs.
  host: process.env.HOST || '0.0.0.0',
  port: Number(process.env.PORT || 3000),
  apiKey: process.env.NVIDIA_API_KEY || '',
  apiBase: (process.env.NVIDIA_API_BASE || 'https://integrate.api.nvidia.com/v1').replace(/\/+$/, ''),
  visionModels: list(
    process.env.VISION_MODELS,
    'nvidia/nemotron-3.5-super-vl-120b-a12b,meta/llama-3.2-90b-vision-instruct,meta/llama-3.2-11b-vision-instruct,microsoft/phi-3-vision-128k-instruct'
  ),
  python: process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
  // Windows ships a bundled binary; Linux uses the system ffmpeg (installed via apt).
  ffmpeg: process.env.FFMPEG || (process.platform === 'win32' ? path.join(ROOT, 'bin', 'ffmpeg.exe') : 'ffmpeg'),
  // yt-dlp wants a filesystem path for --ffmpeg-location — a bare command name is not one.
  ffmpegLocation: process.platform === 'win32' ? path.join(ROOT, 'bin', 'ffmpeg.exe') : '',
  workspace: path.join(ROOT, 'workspace'),
  publicDir: path.join(ROOT, 'public'),
};

// Pipeline defaults / hard limits.
export const limits = {
  clipCountMin: 1,
  clipCountMax: 12,
  clipLengthMin: 8,
  clipLengthMax: 60,
  sourceMin: 2,
  sourceMax: 6,
  windowMin: 60,
  windowMax: 240,
  windowDefault: 150,
  frameIntervalSec: 6,
  frameWidth: 384,
  framesPerBatch: 10,
  searchPoolSize: 30,
  minSourceDurationSec: 45,
  maxSourceDurationSec: 900,
  qualityOptions: [480, 720],
  qualityDefault: 720,
  aspectOptions: ['16:9', '9:16', '1:1'],
  aspectDefault: '16:9',
  // Bandwidth here is ~150 KB/s, so a "section" is the only affordable way to fetch footage:
  // a 90s window at 360p is ~5 MB (~35s) where the full video would be 160+ MB (20 min).
  downloadTimeoutMs: 300_000,
  sectionTimeoutMs: 330_000,
  analysisHeight: 360, // frames are sampled at 384px wide, so 360p is plenty for scoring
  // Fetch the clip's full-quality footage separately when the clips total less than this
  // fraction of the analysis window (otherwise one shared window is cheaper).
  perClipFetchRatio: 0.8,
  aiTimeoutMs: 120_000,
};

export function ensureWorkspace() {
  fs.mkdirSync(config.workspace, { recursive: true });
  return config.workspace;
}
