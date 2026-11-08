/* Footage acquisition — VidKraken first, then two keyless fallback downloaders,
 * then the built-in downloader. The SAME video the whole way down.
 *
 * VidKraken (https://vidkraken.com/) is a YouTube download-by-URL API: we POST
 * a video id + a time window, poll the job, and pull a ready-made trimmed MP4
 * back from their CDN. Their CDN sends no CORS headers, so every byte travels
 * same-origin through api/range.php in bounded 4 MB pieces (shared hosting
 * kills long requests).
 *
 * Their free plan is one-shot (10 downloads, no reset), so when it runs out —
 * or a job fails — the SAME already-chosen video goes through, in order:
 *
 *   1. WebDownloader  save.brianrianrehan.com  (no key; usage-limited server)
 *      → whole file in ONE pass through api/fallback.php (their URL ignores
 *        Range, so chunking would re-download the file per chunk).
 *   2. WeirdDL        weirddl.sbs              (no key)
 *      → /api/info hands back a DIRECT googlevideo URL with real 206 ranges,
 *        so it uses the cheap chunked prefix path like VidKraken does.
 *   3. Built-in Innertube player + range relay.
 *
 * The research agent never re-chooses anything: only the transport changes.
 */
import { api, b64url } from './api.js?v=build5';
import { planPrefix } from './mp4.js?v=build5';

const HEADER_BYTES = 262_144;          // 256 KB is plenty for ftyp+moov+sidx
const CHUNK_BYTES = 4 * 1024 * 1024;   // 4 MB per relay request
const MAX_ATTEMPTS = 3;
const POLL_MS = 1500;                  // VidKraken jobs finish in ~8-30 s
const JOB_DEADLINE_MS = 180_000;       // never poll a job forever
const FB_MAX_BYTES = 67_108_864;       // must match FALLBACK_MAX_BYTES server-side
const FB_STREAM_DEADLINE_MS = 150_000; // one whole-file pass, never longer
const WD_POLL_MS = 2500;               // WebDownloader renders in ~10-20 s
const WD_POLL_DEADLINE_MS = 120_000;   // long compilations can take minutes to render

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function watchUrl(id) {
  return `https://www.youtube.com/watch?v=${id}`;
}

/* WebDownloader's free API cannot take concurrent submits from one client:
 * a real run's network log showed three simultaneous submits all hanging
 * past the 120 s budget, while the solo submit that followed answered in
 * 21 s (and our own probe showed 8 at once → 7× HTTP 429). So exactly ONE
 * submit is in flight at a time; the others wait their turn. The lock covers
 * only the submit — the render poll and the byte pulls stay concurrent. */
let wdSubmitLock = Promise.resolve();
function wdSubmit(fn) {
  const run = wdSubmitLock.then(fn, fn);
  wdSubmitLock = run.then(() => undefined, () => undefined); // never chain failures
  return run;
}

async function fetchChunk(url, from, to, onRetry) {
  const u = `/api/range.php?u=${b64url(url)}`;
  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60_000);
    try {
      const res = await fetch(u, {
        headers: { Range: `bytes=${from}-${to}` },
        signal: ctrl.signal,
      });
      if (res.status === 416) throw new Error('range not satisfiable');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      if (buf.byteLength === 0) throw new Error('empty chunk');
      return new Uint8Array(buf);
    } catch (err) {
      lastErr = err.name === 'AbortError' ? new Error('chunk timed out') : err;
      if (attempt < MAX_ATTEMPTS) {
        onRetry?.(attempt, lastErr);
        await sleep(700 * attempt);
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new Error('download failed');
}

/** Pull a whole file of known size through the relay, with progress. */
async function pullFile(url, total, onProgress = () => {}) {
  const parts = [];
  let offset = 0;
  while (offset < total) {
    const to = Math.min(total - 1, offset + CHUNK_BYTES - 1);
    const chunk = await fetchChunk(url, offset, to, (attempt) => {
      onProgress(Math.min(99, Math.round((offset / total) * 100)));
      void attempt;
    });
    parts.push(chunk);
    offset += chunk.byteLength;
    onProgress(Math.min(99, Math.round((offset / total) * 100)));
    if (chunk.byteLength < to - offset + 1 + 1 && offset < total) break; // upstream sent less than asked
  }
  if (offset < total) throw new Error(`incomplete download (${offset} of ${total} bytes)`);
  onProgress(100);
  return new Blob(parts, { type: 'video/mp4' });
}

/** Mark an error as "worth another attempt" so the caller can decide. */
function vkError(message, retryable) {
  const e = new Error(message);
  e.retryable = Boolean(retryable);
  return e;
}

/**
 * VidKraken path: submit a trimmed job → poll → pull the bytes.
 *
 * @param {{id: string, windowSec: number, format?: string}} job
 * @param {(pct: number, note?: string) => void} onProgress
 * @returns {Promise<{blob: Blob, bytes: number, method: string, coveredSec: number, height: number}>}
 */
export async function downloadVidkraken({ id, windowSec, format = '480' }, onProgress = () => {}) {
  const started = await api.vk({
    action: 'start', id, startSec: 0, endSec: Math.round(windowSec), format,
  });
  if (!started.jobId) throw vkError(started.error || 'VidKraken did not return a job id', true);

  const t0 = Date.now();
  let note = '';
  for (;;) {
    if (Date.now() - t0 > JOB_DEADLINE_MS) {
      throw vkError('VidKraken job timed out after 3 minutes', true);
    }
    await sleep(POLL_MS);
    let s;
    try {
      s = await api.vk({ action: 'status', jobId: started.jobId });
    } catch (err) {
      // A lost poll must not kill the job: it is still running server-side.
      note = `poll failed (${String(err.message || err).slice(0, 60)}) — retrying`;
      onProgress(0, note);
      continue;
    }

    if (s.status === 'COMPLETED') {
      if (!s.fileSize || !s.downloadUrl) throw vkError('VidKraken completed without a file', true);
      const blob = await pullFile(s.downloadUrl, s.fileSize, (p) => onProgress(p, 'downloading'));
      return {
        blob,
        bytes: blob.size,
        method: 'vidkraken',
        coveredSec: Math.min(Math.round(s.duration || windowSec), Math.round(windowSec)),
        // VidKraken may deliver a lower resolution than requested (a 480 ask on
        // a 240p source returns 240). The cut stage only needs to know that.
        height: Number(s.actualFormat) || Number(format) || 480,
      };
    }

    if (s.status === 'FAILED' || s.status === 'NETWORK_ERROR') {
      const msg = (s.error || s.code || s.status).slice(0, 160);
      throw vkError(`VidKraken: ${msg}`, s.retryable !== false);
    }

    const pct = Number(s.percent) || 0;
    const next = `${s.status.toLowerCase()}${s.stage ? ` ${s.stage}` : ''}${pct ? ` ${pct}%` : ''}`;
    if (next !== note) { note = next; onProgress(0, note); }
  }
}

/**
 * Built-in fallback for the SAME video: resolve an Innertube stream and pull
 * the byte prefix covering the window (mp4.js plans the exact range).
 */
export async function downloadFallback(video, { windowSec, quality = 480 }, onProgress = () => {}) {
  const info = await api.player(video.id, 'youtube');
  const videos = info.streams.filter((s) => s.kind === 'video' && s.mimeType.includes('mp4'));
  const best = videos.filter((s) => s.height <= quality).sort((a, b) => b.height - a.height)[0]
             || videos.sort((a, b) => a.height - b.height)[0];
  if (!best) throw new Error('no compatible video stream');
  const dl = await downloadPrefix({ ...best, durationSec: info.duration || video.duration || windowSec },
    windowSec, onProgress);
  return { ...dl, method: 'innertube', height: best.height, coveredSec: dl.coveredSec };
}

/**
 * Pull a whole file through api/fallback.php in ONE pass — used for upstreams
 * that ignore Range headers (chunking them would re-download the file per
 * chunk, and these fallback APIs are usage-limited).
 */
async function pullViaFallback(fileUrl, onProgress = () => {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FB_STREAM_DEADLINE_MS);
  try {
    const res = await fetch(
      `/api/fallback.php?act=stream&u=${b64url(fileUrl)}&max=${FB_MAX_BYTES}`,
      { signal: ctrl.signal },
    );
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { const j = await res.json(); if (j.error) msg = j.error; } catch { /* not JSON */ }
      throw new Error(msg);
    }
    const total = Number(res.headers.get('content-length')) || 0;
    // When the relay hit its 64 MB ceiling it sends X-File-Total (the REAL
    // upstream size) + X-Truncated — content-length is then just the cap, and
    // coveredSec must be computed from the real total, not treated as a
    // complete file.
    const realTotal = Number(res.headers.get('x-file-total')) || total;
    const truncated = res.headers.get('x-truncated') === '1';
    const reader = res.body.getReader();
    const parts = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      got += value.byteLength;
      if (realTotal) onProgress(Math.min(99, Math.round((got / realTotal) * 100)));
      if (got >= FB_MAX_BYTES) break;
    }
    if (!got) throw new Error('empty file');
    if (!truncated && total && got < total) throw new Error(`incomplete file (${got} of ${total} bytes)`);
    onProgress(100);
    return { blob: new Blob(parts, { type: 'video/mp4' }), bytes: got, total: realTotal || got };
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`download timed out after ${Math.round(FB_STREAM_DEADLINE_MS / 1000)}s`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** coveredSec for a file we took whole (no Range support upstream).
 *  Never exceeds the analysis window: VidKraken and the Innertube path both
 *  deliver [0, windowSec], so the frame sampler and the cutter must agree on
 *  the same span — otherwise one long source would balloon the frame count. */
function coveredByBytes(bytes, total, durationSec, windowSec) {
  const full = (!total || bytes >= total)
    ? durationSec
    : Math.max(1, Math.floor(durationSec * (bytes / total) * 0.95));
  return Math.max(1, Math.min(full, windowSec, durationSec || windowSec));
}

/**
 * Fallback #1 — WebDownloader (keyless). Submit → poll until their server has
 * rendered the file → one whole-file pass. Same video, no re-choosing.
 */
export async function downloadWebdownloader(video, windowSec, onProgress = () => {}, format) {
  // Serialized: their API hangs/429s on parallel submits (see wdSubmit).
  onProgress(0, 'submitting to WebDownloader…');
  const info = await wdSubmit(() => api.fbInfo('webdownloader', watchUrl(video.id), format));
  if (!info.downloadUrl) throw new Error(info.error || 'WebDownloader: no file url');

  const t0 = Date.now();
  for (;;) {
    let probe = null;
    try { probe = await api.fbProbe(info.downloadUrl); } catch { /* transient */ }
    if (probe?.ready) break;
    if (Date.now() - t0 > WD_POLL_DEADLINE_MS) throw new Error('WebDownloader: file not ready after 120s');
    onProgress(0, 'WebDownloader is rendering the file…');
    await sleep(WD_POLL_MS);
  }

  onProgress(0, 'downloading');
  const { blob, bytes, total } = await pullViaFallback(info.downloadUrl, (p) => onProgress(p, 'downloading'));
  const durationSec = info.durationSec || video.duration || windowSec;
  return {
    blob,
    bytes,
    method: 'webdownloader',
    coveredSec: coveredByBytes(bytes, total, durationSec, windowSec),
  };
}

/**
 * Fallback #2 — WeirdDL (keyless). Its /api/info returns a DIRECT googlevideo
 * URL, which honors byte ranges, so this path is as cheap as VidKraken's: only
 * the prefix covering the analysis window is pulled.
 *
 * One retry: their endpoints answer with transient upstream errors (a real
 * run died on a 422 and the source fell all the way through to the dead
 * built-in hop), and the SAME video with a fresh resolve usually goes through.
 */
export async function downloadWeirddl(video, windowSec, onProgress = () => {}) {
  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await weirddlOnce(video, windowSec, onProgress);
    } catch (err) {
      lastErr = err;
      if (attempt < 2) {
        onProgress(0, 'WeirdDL hiccup — retrying…');
        await sleep(2000);
      }
    }
  }
  throw lastErr;
}

async function weirddlOnce(video, windowSec, onProgress) {
  const info = await api.fbInfo('weirddl', watchUrl(video.id));
  if (!info.streamUrl) throw new Error(info.error || 'WeirdDL: no stream');

  if (info.range) {
    const dl = await downloadPrefix({
      url: info.streamUrl,
      durationSec: info.durationSec || video.duration || windowSec,
    }, windowSec, onProgress);
    return { ...dl, method: 'weirddl' };
  }

  onProgress(0, 'downloading');
  const { blob, bytes, total } = await pullViaFallback(info.streamUrl, (p) => onProgress(p, 'downloading'));
  const durationSec = info.durationSec || video.duration || windowSec;
  return {
    blob,
    bytes,
    method: 'weirddl',
    coveredSec: coveredByBytes(bytes, total, durationSec, windowSec),
  };
}

/**
 * Acquire one source video. VidKraken first, then WebDownloader, then WeirdDL,
 * then the built-in downloader — always the SAME video; every hop only changes
 * the transport and is reported through onFallback(err, stage).
 *
 * @param {{id: string, duration?: number}} video
 * @param {{windowSec: number, format?: string, quality?: number, useVidkraken?: boolean}} opts
 * @param {{onProgress?: Function, onFallback?: Function}} hooks
 */
export async function acquireFootage(video, opts, hooks = {}) {
  const onProgress = hooks.onProgress || (() => {});
  const hop = (stage, err) => hooks.onFallback?.(err, stage);

  if (opts.useVidkraken !== false) {
    try {
      return await downloadVidkraken(
        { id: video.id, windowSec: opts.windowSec, format: opts.format },
        onProgress,
      );
    } catch (err) {
      hop('VidKraken', err);
    }
  }

  try {
    return await downloadWebdownloader(video, opts.windowSec, onProgress, opts.format);
  } catch (err) {
    hop('WebDownloader', err);
  }

  try {
    return await downloadWeirddl(video, opts.windowSec, onProgress);
  } catch (err) {
    hop('WeirdDL', err);
  }

  try {
    return await downloadFallback(video, { windowSec: opts.windowSec, quality: opts.quality }, onProgress);
  } catch (err) {
    hop('YouTube', err);
    throw err;                              // last resort failed: let the caller log it
  }
}

/**
 * Download the prefix of a stream covering [0, windowSec] — the fallback path.
 *
 * @param {{url: string, contentLength?: number, durationSec: number}} stream
 * @param {number} windowSec
 * @param {(pct: number) => void} onProgress  0..100
 * @returns {Promise<{blob: Blob, bytes: number, method: string, coveredSec: number}>}
 */
export async function downloadPrefix(stream, windowSec, onProgress = () => {}) {
  const { url, contentLength = 0 } = stream;

  // 1. total size (cheap probe: one byte round-trip)
  let total = contentLength;
  if (!total) {
    const probe = await api.probe(url);
    total = probe.total;
  }
  if (!total) throw new Error('could not determine stream size');

  // 2. header — parse moov/sidx to plan exact bytes
  const head = await fetchChunk(url, 0, HEADER_BYTES - 1);
  let endByte = total;
  let method = 'full';
  let boundaryOk = true;
  try {
    const plan = planPrefix(head.buffer, total, stream.durationSec, windowSec, head.byteLength);
    endByte = plan.endByte;
    method = plan.method;
    boundaryOk = plan.boundaryOk;
  } catch {
    // planning is best-effort; the proportional fallback inside planPrefix rarely throws
  }
  if (endByte <= head.byteLength) endByte = Math.min(total, head.byteLength);

  // 3. remaining chunks with progress
  const parts = [head];
  let got = head.byteLength;
  const target = endByte;
  let offset = head.byteLength;
  while (offset < target) {
    const to = Math.min(target - 1, offset + CHUNK_BYTES - 1);
    const chunk = await fetchChunk(url, offset, to, (attempt, err) => {
      onProgress(Math.round((got / target) * 100));
      void attempt; void err;
    });
    parts.push(chunk);
    got += chunk.byteLength;
    offset += chunk.byteLength;
    onProgress(Math.min(99, Math.round((got / target) * 100)));
    if (chunk.byteLength < to - offset + 1 + 1 && offset < target) break; // upstream sent less than asked: stop early
  }

  onProgress(100);
  // Covered time ≈ duration × (bytes / total) when we had to estimate.
  const coveredSec = boundaryOk || method === 'sidx'
    ? windowSec
    : Math.floor(stream.durationSec * (got / total) * 0.95);

  return {
    blob: new Blob(parts, { type: 'video/mp4' }),
    bytes: got,
    method,
    coveredSec: Math.max(1, Math.min(windowSec, coveredSec || windowSec)),
  };
}
