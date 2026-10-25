/* Browser media engine: frame sampling via <video>+canvas, and clip cutting
 * via ffmpeg.wasm (multithreaded core — the COOP/COEP headers enable it). */
import { api, extractJson } from './api.js';

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
You are shown consecutive frames sampled from a single YouTube video, in chronological order.
Judge each frame on its viral potential as a standalone social clip: genuine emotion and reactions, spectacle or skill, surprise and tension, humor, strong faces, visual clarity, and a payoff. Blurry, static, logo-only, dead-air or uneventful frames must score low. Use the whole 0-100 range.
Think briefly, then reply with ONLY the JSON you were asked for.`;

export async function scoreFrames(frames, { interval, videoTitle, batch = 10, onBatch = () => {} }) {
  const out = [];
  let usedModel = null;
  for (let i = 0; i < frames.length; i += batch) {
    const group = frames.slice(i, i + batch);
    const times = group.map((f) => f.t).join(', ');
    const user=`Video: "${videoTitle}".\nThe ${group.length} attached frames are sampled every ${interval} seconds in this order, captured at t = ${times} seconds.\n\nReturn ONLY a JSON array with exactly ${group.length} objects, one per frame, in the same order:\n[{"t": <seconds>, "desc": "<what is happening, max 10 words>", "score": <integer 0-100>}]`;
    const { text, model } = await api.ai({ system: SCORING_SYSTEM, user, images: group.map((f) => f.b64), maxTokens: 4000, temperature: 0.2 });
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
  const user=`Here are ${segments.length} video segments chosen from real YouTube videos for their viral potential.\n\n${segments.map((s,i)=>`${i+1}. Source video: "${s.videoTitle}" (channel: ${s.channel}). Clip runs ${clock(s.startSec)}-${clock(s.endSec)}. Observed moments: ${(s.highlights||[]).filter(Boolean).join('; ')||'action beats'}`).join('\n')}\n\nReturn ONLY a JSON array of ${segments.length} objects in the same order:\n[{"index":1,"title":"<max 60 chars>","hook":"<max 120 chars>","caption":"<2 sentence caption>","hashtags":["#one","#two"]}, ...]`;
  try {
    const { text } = await api.ai({ system: 'You write punchy, click-worthy but honest packaging for short viral clips. Reply with ONLY the JSON array requested.', user, maxTokens: 3200, temperature: 0.7 });
    const parsed = extractJson(text);
    return Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

/* ── ffmpeg.wasm ────────────────────────────────────────────────────────── */
let ffPromise = null;
export function ffmpeg() {
  if (!ffPromise) ffPromise = (async () => {
    await loadScript('/assets/ffmpeg/ffmpeg.js');
    const { FFmpeg } = window.FFmpegWASM;
    const ff = new FFmpeg();
    await ff.load({
      coreURL: '/assets/ffmpeg/ffmpeg-core.js',
      wasmURL: '/assets/ffmpeg/ffmpeg-core.wasm',
      workerURL: '/assets/ffmpeg/ffmpeg-core.worker.js',
    });
    return ff;
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

  const onProg = ({ progress }) => { if (typeof progress === 'number') onProgress(Math.min(100, Math.round(progress * 100))); };
  ff.on('progress', onProg);
  try {
    await ff.exec(args);
    const data = await ff.readFile('out.mp4');
    if (!data || data.byteLength < 10_240) throw new Error('ffmpeg produced no output');
    return new Blob([data.buffer], { type: 'video/mp4' });
  } finally {
    ff.off('progress', onProg);
    for (const f of files) { try { await ff.deleteFile(f); } catch { /* already gone */ } }
    try { await ff.deleteFile('out.mp4'); } catch { /* already gone */ }
  }
}

function clock(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
