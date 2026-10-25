import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { config, limits, ensureWorkspace } from './config.js';
import { createJob, getJob, emit, loadSavedJobs, jobs } from './lib/jobs.js';
import { runJob } from './lib/pipeline.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.vtt': 'text/vtt; charset=utf-8',
};

const CATEGORIES = [
  'Gaming', 'Football', 'Basketball', 'MMA & Boxing', 'Motorsport', 'Pets & Animals',
  'Cooking', 'Comedy Pranks', 'Music', 'Dance', 'Travel Vlogs', 'Fitness',
  'Tech Reviews', 'Cars', 'Fashion & Beauty', 'Science Experiments', 'Magic Tricks',
  'Extreme Sports', 'Street Food', 'Stand-up Comedy', 'Nature & Wildlife', 'Esports Highlights',
];

ensureWorkspace();
pruneWorkspace();
const restored = loadSavedJobs();

/** Keep only the newest few render folders so disk use stays bounded. */
function pruneWorkspace(keep = 8) {
  try {
    const dirs = fs
      .readdirSync(config.workspace, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(config.workspace, d.name))
      .map((p) => ({ p, mtime: fs.statSync(p).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const { p } of dirs.slice(keep)) {
      fs.rmSync(p, { recursive: true, force: true });
    }
  } catch {
    /* nothing to prune */
  }
}

const server = http.createServer(handle);

async function handle(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = decodeURIComponent(url.pathname);

    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      return serveFile(req, res, path.join(config.publicDir, 'index.html'));
    }
    if (req.method === 'GET' && pathname.startsWith('/api/categories')) {
      return sendJson(res, 200, { categories: CATEGORIES, limits: publicLimits() });
    }
    if (req.method === 'POST' && pathname === '/api/generate') {
      return await handleGenerate(req, res);
    }
    if (req.method === 'GET' && pathname === '/api/jobs') {
      return sendJson(res, 200, { jobs: listJobs() });
    }
    if (req.method === 'GET' && pathname.startsWith('/api/jobs/')) {
      return handleJobRoute(req, res, pathname);
    }
    if (req.method === 'GET' && pathname.startsWith('/clips/')) {
      const rel = pathname.slice('/clips/'.length);
      const target = safeJoin(config.workspace, rel);
      if (!target || !fs.existsSync(target)) return sendJson(res, 404, { error: 'clip not found' });
      return serveFile(req, res, target);
    }

    // Static assets from /public
    const target = safeJoin(config.publicDir, pathname === '/' ? 'index.html' : pathname.slice(1));
    if (target && fs.existsSync(target) && fs.statSync(target).isFile()) {
      return serveFile(req, res, target);
    }
    return sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    return sendJson(res, 500, { error: String(err?.message || err) });
  }
}

function publicLimits() {
  return {
    clipCountMin: limits.clipCountMin,
    clipCountMax: limits.clipCountMax,
    clipLengthMin: limits.clipLengthMin,
    clipLengthMax: limits.clipLengthMax,
    sourceMin: limits.sourceMin,
    sourceMax: limits.sourceMax,
    windowDefault: limits.windowDefault,
    windowMax: limits.windowMax,
    qualities: limits.qualityOptions,
    qualityDefault: limits.qualityDefault,
    aspects: limits.aspectOptions,
    aspectDefault: limits.aspectDefault,
  };
}

async function handleGenerate(req, res) {
  const body = await readJson(req);
  const category = String(body.category || '').trim().slice(0, 80);
  if (!category) return sendJson(res, 400, { error: 'Pick or type a category first.' });

  const params = {
    category,
    clipCount: clampInt(body.clipCount, limits.clipCountMin, limits.clipCountMax, 3),
    clipLength: clampInt(body.clipLength, limits.clipLengthMin, limits.clipLengthMax, 20),
    sourceCount: clampInt(body.sourceCount, limits.sourceMin, limits.sourceMax, 4),
    windowSeconds: clampInt(body.windowSeconds, limits.windowMin, limits.windowMax, limits.windowDefault),
    quality: limits.qualityOptions.includes(Number(body.quality)) ? Number(body.quality) : limits.qualityDefault,
    aspect: limits.aspectOptions.includes(String(body.aspect)) ? String(body.aspect) : limits.aspectDefault,
  };

  const job = createJob(params);
  emit(job, 'snapshot', snapshot(job));
  log_start(job);

  // Fire and forget; progress is streamed over SSE.
  setImmediate(() => runJob(job));

  return sendJson(res, 202, { jobId: job.id, params });
}

function log_start(job) {
  // eslint-disable-next-line no-console
  console.log(`[job ${job.id.slice(0, 8)}] started — ${job.params.clipCount}x ${job.params.clipLength}s clips of "${job.params.category}"`);
}

function handleJobRoute(req, res, pathname) {
  const parts = pathname.split('/').filter(Boolean); // api, jobs, id, [events]
  const job = getJob(parts[2]);
  if (!job) return sendJson(res, 404, { error: 'job not found' });

  if (parts[3] === 'events') return streamJob(req, res, job);
  return sendJson(res, 200, snapshot(job));
}

function streamJob(req, res, job) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`data: ${JSON.stringify({ type: 'snapshot', ...snapshot(job) })}\n\n`);

  const listener = (event) => {
    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch {
      cleanup();
    }
  };
  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      cleanup();
    }
  }, 15_000);

  function cleanup() {
    clearInterval(heartbeat);
    job.listeners.delete(res);
  }

  job.listeners.add(res);
  req.on('close', cleanup);
  req.on('error', cleanup);
}

/** Newest-first summary list for the "Recent runs" history panel. */
function listJobs() {
  return [...jobs.values()]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 12)
    .map((j) => ({
      id: j.id,
      createdAt: j.createdAt,
      finishedAt: j.finishedAt,
      status: j.status,
      category: j.params?.category || '',
      clipCount: j.clips?.length || 0,
      requested: j.params?.clipCount || 0,
      clipLength: j.params?.clipLength || 0,
      aspect: j.params?.aspect || '16:9',
      quality: j.params?.quality || null,
      sources: j.sources?.length || 0,
      error: j.error,
    }));
}

function snapshot(job) {
  return {
    jobId: job.id,
    status: job.status,
    stage: job.stage,
    percent: job.percent,
    params: job.params,
    model: job.model,
    error: job.error,
    logs: job.logs,
    sources: job.sources.map((s) => ({ ...s })),
    clips: job.clips,
  };
}

/* ── plumbing ──────────────────────────────────────────────────────────── */

function sendJson(res, code, data) {
  const payload = JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 32_768) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function safeJoin(base, relative) {
  const target = path.resolve(base, relative);
  const root = path.resolve(base);
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  return target;
}

/** Static file serving with HTTP Range support so <video> seeking works. */
function serveFile(req, res, filePath) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return sendJson(res, 404, { error: 'not found' });
  }

  const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  const range = req.headers.range;

  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      let start = m[1] === '' ? undefined : Number(m[1]);
      let end = m[2] === '' ? undefined : Number(m[2]);
      if (start === undefined) {
        start = Math.max(0, stat.size - (end || 0));
        end = stat.size - 1;
      } else if (end === undefined || end >= stat.size) {
        end = stat.size - 1;
      }
      if (Number.isFinite(start) && start >= 0 && start <= end) {
        res.writeHead(206, {
          'Content-Type': type,
          'Content-Length': end - start + 1,
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-cache',
        });
        if (req.method === 'HEAD') return res.end();
        const rangeStream = fs.createReadStream(filePath, { start, end });
        rangeStream.on('error', () => res.destroy());
        res.on('close', () => rangeStream.destroy());
        return rangeStream.pipe(res);
      }
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      return res.end();
    }
  }

  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': stat.size,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
  });
  if (req.method === 'HEAD') return res.end();
  const stream = fs.createReadStream(filePath);
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

/**
 * Crash resilience: a stray unhandled rejection must never take the whole
 * studio down while a job is rendering. Log it and keep serving.
 */
process.on('unhandledRejection', (reason) => {
  // eslint-disable-next-line no-console
  console.error(`[unhandledRejection] ${new Date().toISOString()} ::`, reason);
});
process.on('uncaughtException', (err) => {
  // eslint-disable-next-line no-console
  console.error(`[uncaughtException] ${new Date().toISOString()} ::`, err?.stack || err);
});

/* ── preflight ────────────────────────────────────────────────────────────
 * A deploy platform ships only what npm installed. If python/yt-dlp/ffmpeg
 * are absent the UI still loads, but every job would fail minutes later — so
 * say it at boot. Warnings only: serving the site beats crashing on start. */
const probe = (cmd, args) =>
  new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: 15_000, windowsHide: true }, (err) => resolve(!err));
    } catch {
      resolve(false);
    }
  });

async function preflight() {
  const missing = [];
  if (!(await probe(config.ffmpeg, ['-version']))) missing.push('ffmpeg');
  if (!(await probe(config.python, ['--version']))) missing.push('python3');
  else if (!(await probe(config.python, ['-m', 'yt_dlp', '--version']))) missing.push('python3 -m yt_dlp');
  if (!config.apiKey) missing.push('NVIDIA_API_KEY');
  if (missing.length) {
    // eslint-disable-next-line no-console
    console.warn(`  ⚠ not available here: ${missing.join(', ')} — related steps will fail\n`);
  }
}
preflight().catch(() => {});

server.on('error', (err) => {
  // eslint-disable-next-line no-console
  console.error(`  ✗ could not listen on ${config.host}:${config.port} — ${err.message}`);
  process.exitCode = 1;
});

server.listen(config.port, config.host, () => {
  // eslint-disable-next-line no-console
  console.log(`\n  Viral Clips Studio → http://${config.host}:${config.port}`);
  if (restored) console.log(`  ${restored} finished job${restored === 1 ? '' : 's'} restored from disk`);
  console.log('');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2_000).unref();
  });
}
