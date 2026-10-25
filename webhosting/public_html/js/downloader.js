/* Chunked byte-range downloader.
 *
 * Pulls [0, endByte) of a YouTube stream through api/range.php in bounded
 * pieces: every request is short (shared hosting kills long ones), has an
 * abort timeout, and retries with backoff. Returns one Blob.
 */
import { api, b64url } from './api.js?v=build1';
import { planPrefix } from './mp4.js?v=build1';

const HEADER_BYTES = 262_144;          // 256 KB is plenty for ftyp+moov+sidx
const CHUNK_BYTES = 4 * 1024 * 1024;   // 4 MB per relay request
const MAX_ATTEMPTS = 3;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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

/**
 * Download the prefix of a stream covering [0, windowSec].
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

  // 2. header â€” parse moov/sidx to plan exact bytes
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
  // Covered time â‰ˆ duration Ã— (bytes / total) when we had to estimate.
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
