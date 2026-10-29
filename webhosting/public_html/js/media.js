/* Browser media engine: frame sampling via <video>+canvas, and clip cutting
 * via ffmpeg.wasm (multithreaded core — the COOP/COEP headers enable it). */
import { api, extractJson } from './api.js?v=build1';

/* ── frames ─────────────────────────────────────────────────────────────── */
export async function extractFrames(blob, { intervalSec = 6, width = 384, limitSec = 0, onProgress = () => {} } = {}) {
  const url = URL.createObjectURL(blob);
  const video = document.createElement('video');
  video.muted = true; video.playsInline = true; video.preload = 'auto';
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const frames = [];
  try {
    await new Promise((res, rej) => {
      video.onloadedmetadata = () => res();
      video.onerror = () => rej(new Error('could not decode the footage'));
      setTimeout(() => rej(new Error('video decode timed out')), 20_000);
      video.src = url;
    });
    const dur = limitSec > 0 ? Math.min(limitSec, video.duration || limitSec) : (video.duration || 0);
    if (!dur) throw new Error('empty footage');
    const aspect = (video.videoWidth || 1280) / (video.videoHeight || 720);
    canvas.width = width;
    canvas.height = Math.round(width / aspect);
    let count = 0;
    for (let t = 0; t < dur - 0.25; t += intervalSec) {
      const ok = await seek(video, t);
      if (!ok) break;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const b64 = canvas.toDataURL('image/jpeg', 0.72).split(',')[1];
      frames.push({ t, b64 });
      count++;
      onProgress(Math.round(((t + intervalSec) / dur) * 100));
    }
    if (!count) throw new Error('no frames could be sampled');
    return { frames, duration: dur };
  } finally {
    video.src = ''; URL.revokeObjectURL(url);
  }
}

function seek(video, t) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => { if (!done) { done = true; video.onseeked = null; clearTimeout(timer); resolve(ok); } };
    const timer = setTimeout(() => finish(false), 6000);
    video.onseeked = () => finish(true);
    try { video.currentTime = t; } catch { finish(false); }
  });
}

/* ── vision scoring ─────────────────────────────────────────────────────── */
const SCORING_SYSTEM=`You are a senior short-form video editor and virality analyst.
You are shown consecutive frames sampled from a single video, in chronological order.
Judge each frame on its viral potential as a standalone social clip: genuine emotion and reactions, spectacle or skill, surprise and tension, humor, strong faces, visual clarity, and a payoff. Blurry, static, logo-only, dead-air or uneventful frames must score low. Use the whole 0-100 range.
Think briefly, then reply with ONLY the JSON you were asked for.`;

export async function scoreFrames(frames, { interval, videoTitle, batch = 10, onBatch = () => {} }) {
  const out = [];
  let usedModel = null;
  for (let i = 0; i < frames.length; i += batch) {
    const group = frames.slice(i, i + batch);
    const times = group.map((f) => f.t).join(', ');
    const user=`Video: "${videoTitle}".\nThe ${group.length} attached frames are sampled every ${interval} seconds in this order, captured at t = ${times} seconds.\n\nReturn ONLY a JSON array with exactly ${group.length} objects, one per frame, in the same order:\n[{"t": <seconds>, "desc": "<what is happening, max 10 words>", "score": <integer 0-100>}]`;
    const { text, model } = await api.ai({ system: SCORING_SYSTEM, user, images: group.map((f) => f.b64), maxTokens: 4000, temperature: 0.2, timeoutSec: 110 });
    usedModel = model;
    const parsed = extractJson(text);
    if (!Array.isArray(parsed)) throw new Error(`model returned unparseable frame scores (${model})`);
    group.forEach((frame, idx) => {
      const hit = parsed.find((p) => p && Math.abs(Number(p.t) - frame.t) < interval * 0.75) || parsed[idx] || {};
      const n = Number(hit.score);
      out.push({ t: frame.t, desc: String(hit.desc || '').slice(0, 80), score: Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 40 });
    });
    onBatch({ done: out.length, total: frames.length, model });
  }
  out.sort((a, b) => a.t - b.t);
  return { scores: out, model: usedModel };
}

/* ── copywriting ────────────────────────────────────────────────────────── */
export async function generateCopy(segments) {
  const user=`Here are ${segments.length} video segments chosen for their viral potential.\n\n${segments.map((s,i)=>`${i+1}. Source video: "${s.videoTitle}" (channel: ${s.channel}). Clip runs ${clock(s.startSec)}-${clock(s.endSec)}. Observed moments: ${(s.highlights||[]).filter(Boolean).join('; ')||'action beats'}`).join('\n')}\n\nReturn ONLY a JSON array of ${segments.length} objects in the same order:\n[{"index":1,"title":"<max 60 chars>","hook":"<max 120 chars>","caption":"<2 sentence caption>","hashtags":["#one","#two"]}, ...]`;
  try {
    const { text } = await api.ai({ system: 'You write punchy, click-worthy but honest packaging for short viral clips. Reply with ONLY the JSON array requested.', user, maxTokens: 3200, temperature: 0.7 });
    const parsed = extractJson(text);
    return Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

/* ── ffmpeg.wasm ────────────────────────────────────────────────────────── */
let ffPromise = null;
const WASM_GZ_URL = '/assets/ffmpeg/ffmpeg-core.wasm.gz?v=build1';
const WASM_RAW_URL = '/assets/ffmpeg/ffmpeg-core.wasm?v=build1';
const delay = (ms, msg) => new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms));

/* The core is a 33 MB wasm and the server does not gzip it. CI publishes a
 * precompressed .wasm.gz (10 MB) which is fetched here and decompressed in
 * the page, so the first visit waits for a third of the bytes; the raw file
 * stays as the fallback (older browsers, missing copy). The bytes are handed
 * to ffmpeg as a blob URL — one download per page load, visible progress. */
const loadListeners = new Set();
export function onFfmpegLoad(cb) { loadListeners.add(cb); return () => loadListeners.delete(cb); }
const emitLoad = (p) => { for (const cb of loadListeners) { try { cb(p); } catch { /* listener bug */ } } };

async function downloadBytes(url, fromZero = false) {
  const res = await fetch(url, { cache: 'force-cache' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const declared = Number(res.headers.get('content-length')) || 1;
  if (!res.body) {
    emitLoad(100);
    return new Uint8Array(await res.arrayBuffer());
  }
  if (fromZero) emitLoad(0);
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0, last = -1;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    const p = Math.min(99, Math.round((got / declared) * 100));
    if (p >= last + 10) { last = p; emitLoad(p); }
  }
  const out = new Uint8Array(got);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

async function gunzip(bytes) {
  if (typeof DecompressionStream === 'undefined') throw new Error('no DecompressionStream');
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const isWasm = (b) => b && b.length > 1024 && b[0] === 0x00 && b[1] === 0x61 && b[2] === 0x73 && b[3] === 0x6d;

async function wasmBytes() {
  try {
    const raw = await gunzip(await downloadBytes(WASM_GZ_URL));
    if (isWasm(raw)) return raw;
    throw new Error('decompressed core is not wasm');
  } catch {
    // precompressed copy unavailable or could not be unpacked — raw fallback
    const raw = await downloadBytes(WASM_RAW_URL, true);
    if (!isWasm(raw)) throw new Error('encoder download is corrupt');
    return raw;
  }
}

export function ffmpeg() {
  if (!ffPromise) ffPromise = (async () => {
    emitLoad(0);
    const load = (async () => {
      await loadScript('/assets/ffmpeg/ffmpeg.js');
      const { FFmpeg } = window.FFmpegWASM;
      const ff = new FFmpeg();
      const wasmURL = URL.createObjectURL(new Blob([await wasmBytes()], { type: 'application/wasm' }));
      await ff.load({
        coreURL: '/assets/ffmpeg/ffmpeg-core.js',
        wasmURL,
        workerURL: '/assets/ffmpeg/ffmpeg-core.worker.js',
      });
      return ff;
    })();
    // A stalled fetch must never hang the job: race the load against a hard
    // deadline (first visit downloads ~10 MB) and drop the cached promise
    // on timeout so the next attempt starts clean.
    return await Promise.race([
      load,
      delay(180_000, 'video encoder did not finish loading within 180s (network stall) — retrying on the next clip'),
    ]);
  })().catch((e) => { ffPromise = null; throw e; });
  return ffPromise;
}

function loadScript(src) {
  return new Promise((res, rej) => {
    if (document.querySelector(`script[src="${src}"]`)) return res();
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = () => rej(new Error('failed to load ffmpeg.wasm runtime'));
    document.head.appendChild(s);
  });
}

export function aspectFilter(aspect) {
  if (aspect === '9:16') return "crop=w='2*trunc(min(iw,ih*9/16)/2)':h='2*trunc(ih/2)',scale=1080:1920:flags=lanczos";
  if (aspect === '1:1') return "crop=w='2*trunc(min(iw,ih)/2)':h='2*trunc(min(iw,ih)/2)',scale=1080:1080:flags=lanczos";
  return null;
}

/**
 * Cut [startSec, startSec+span] from downloaded video/audio blobs into an mp4.
 * @returns {Promise<Blob>}
 */
export async function cutClip({ videoBlob, audioBlob, startSec, span, aspect = '16:9', onProgress = () => {} }) {
  const ff = await ffmpeg();
  const files = [];
  let lastBeat = Date.now();
  const beat = () => { lastBeat = Date.now(); };
  /* Stall watchdog: if ffmpeg reports nothing for 45 s the encode is dead
   * (worker died, socket wedged) — fail the clip instead of hanging forever. */
  let timer = null;
  const watchdog = new Promise((_, rej) => {
    timer = setInterval(() => {
      if (Date.now() - lastBeat > 45_000) {
        rej(new Error('encoding stalled — ffmpeg made no progress for 45s'));
      }
    }, 5_000);
  });

  const run = async () => {
    await ff.writeFile('in.mp4', new Uint8Array(await videoBlob.arrayBuffer()));
    files.push('in.mp4');
    let inputs = ['-ss', startSec.toFixed(2), '-i', 'in.mp4'];
    if (audioBlob && audioBlob.size > 1024) {
      await ff.writeFile('in_audio.mp4', new Uint8Array(await audioBlob.arrayBuffer()));
      files.push('in_audio.mp4');
      inputs = ['-ss', startSec.toFixed(2), '-i', 'in.mp4', '-ss', startSec.toFixed(2), '-i', 'in_audio.mp4',
                '-map', '0:v:0', '-map', '1:a:0'];
    }
    const vf = aspectFilter(aspect);
    const args = [...inputs, '-t', span.toFixed(2)];
    if (vf) args.push('-vf', vf);
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22',
              '-c:a', 'aac', '-b:a', '128k', '-ar', '44100',
              '-movflags', '+faststart', '-avoid_negative_ts', 'make_zero', '-y', 'out.mp4');

    const onProg = ({ progress }) => { beat(); if (typeof progress === 'number') onProgress(Math.min(100, Math.round(progress * 100))); };
    ff.on('progress', onProg);
    try {
      beat();
      await ff.exec(args);
      beat();
      const data = await ff.readFile('out.mp4');
      if (!data || data.byteLength < 10_240) throw new Error('ffmpeg produced no output');
      return new Blob([data.buffer], { type: 'video/mp4' });
    } finally {
      ff.off('progress', onProg);
    }
  };

  try {
    return await Promise.race([run(), watchdog]);
  } catch (err) {
    /* A wedged runtime is unusable for the next clip either — tear it down
     * and let the following call reload it from scratch. */
    try { if (typeof ff.terminate === 'function') ff.terminate(); } catch { /* ignore */ }
    ffPromise = null;
    throw err;
  } finally {
    clearInterval(timer);
    for (const f of files) { try { await ff.deleteFile(f); } catch { /* already gone */ } }
    try { await ff.deleteFile('out.mp4'); } catch { /* already gone */ }
  }
}

function clock(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
