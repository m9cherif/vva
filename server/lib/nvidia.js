import fs from 'node:fs';
import { config, limits } from '../config.js';

/** Tiny semaphore so we never blast the endpoint with too many parallel calls. */
let inFlight = 0;
const MAX_CONCURRENT = 3;
const waitQueue = [];
async function acquire() {
  if (inFlight < MAX_CONCURRENT) {
    inFlight += 1;
    return;
  }
  await new Promise((r) => waitQueue.push(r));
  inFlight += 1;
}
function release() {
  inFlight -= 1;
  const next = waitQueue.shift();
  if (next) next();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let activeModelIndex = 0;

async function callModel(model, { messages, images, maxTokens, temperature, timeoutMs }) {
  // Attach images to the final user message (vision models expect them inline).
  const msgs = messages.map((m) => ({ ...m }));
  if (images.length && msgs.length) {
    const last = msgs[msgs.length - 1];
    const text = typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
    const parts = [{ type: 'text', text }];
    for (const b64 of images) {
      parts.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } });
    }
    last.content = parts;
  }

  const payload = {
    model,
    messages: msgs,
    temperature,
    max_tokens: maxTokens,
  };

  let res;
  try {
    res = await fetch(`${config.apiBase}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return { ok: false, error: `network: ${String(err).slice(0, 160)}`, rateLimit: false };
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const rateLimit = res.status === 429;
    return {
      ok: false,
      rateLimit,
      serverError: res.status >= 500,
      error: `HTTP ${res.status} ${body.slice(0, 220)}`,
    };
  }

  let data;
  try {
    data = await res.json();
  } catch (err) {
    return { ok: false, error: `bad json: ${String(err).slice(0, 120)}`, rateLimit: false };
  }

  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || text.trim().length === 0) {
    // Observed on warm-up or when reasoning consumed the whole token budget.
    return { ok: false, error: 'empty content', rateLimit: false, empty: true };
  }
  return { ok: true, text, truncated: data?.choices?.[0]?.finish_reason === 'length' };
}

/**
 * Chat with fallback across the configured vision models.
 * Returns { text, model } or throws with a summary of the failures.
 */
export async function aiChat({
  system = 'You are a precise multimodal analyst.',
  user,
  images = [],
  history = [],
  maxTokens = 1600,
  temperature = 0.2,
  timeoutMs = limits.aiTimeoutMs,
  attempts = 2,
  onWarn = null,
} = {}) {
  if (!config.apiKey) throw new Error('NVIDIA_API_KEY is missing from .env');

  const messages = [
    { role: 'system', content: system },
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: user },
  ];
  const warn = (msg) => {
    try {
      onWarn?.(msg);
    } catch {
      /* logging must never break a call */
    }
  };

  const failures = [];
  await acquire();
  try {
    for (let round = 0; round < attempts; round += 1) {
      for (let offset = 0; offset < config.visionModels.length; offset += 1) {
        const idx = (activeModelIndex + offset) % config.visionModels.length;
        const model = config.visionModels[idx];
        let r = await callModel(model, { messages, images, maxTokens, temperature, timeoutMs });
        // Transient trouble on the primary model (5xx, or reasoning ate the whole token
        // budget and came back empty) — retry the SAME model before falling through.
        for (let tries = 0; tries < 2 && !r.ok && (r.serverError || r.empty); tries += 1) {
          warn(`${model} ${r.serverError ? 'server error' : 'empty reply'} — retrying`);
          r = await callModel(model, { messages, images, maxTokens, temperature, timeoutMs });
        }
        if (r.ok) {
          activeModelIndex = idx;
          if (r.truncated) warn(`${model} reply hit the token cap`);
          return { text: r.text, model, truncated: Boolean(r.truncated) };
        }
        failures.push(`${model} -> ${r.error}`);
        warn(`${model} failed: ${r.error}`);
        if (r.rateLimit) await sleep(6_000 * (round + 1));
      }
      await sleep(1_200);
    }
  } finally {
    release();
  }
  throw new Error(`AI call failed: ${failures.slice(-3).join('  |  ')}`);
}

/** Pull the first JSON array (or object) out of a possibly chatty model reply. */
export function extractJson(text) {
  if (!text) return null;
  let t = String(text).trim();
  t = t.replace(/^```(?:json)?/i, '').replace(/```\s*$/i, '').trim();

  const tryParse = (s) => {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  };

  const openArr = t.indexOf('[');
  const openObj = t.indexOf('{');
  const open = openArr === -1 ? openObj : openObj === -1 ? openArr : Math.min(openArr, openObj);
  if (open === -1) return tryParse(t);

  const openChar = t[open];
  const closeChar = openChar === '[' ? ']' : '}';
  const close = t.lastIndexOf(closeChar);
  if (close > open) {
    const parsed = tryParse(t.slice(open, close + 1));
    if (parsed) return parsed;
  }
  return tryParse(t);
}

const SCORING_SYSTEM = `You are a senior short-form video editor and virality analyst.
You are shown consecutive frames sampled from a single YouTube video, in chronological order.
Judge each frame on its viral potential as a standalone social clip: genuine emotion and reactions, spectacle or skill, surprise and tension, humor, strong faces, visual clarity, and a payoff. Blurry, static, logo-only, dead-air or uneventful frames must score low. Use the whole 0-100 range.
Think briefly, then reply with ONLY the JSON you were asked for.`;

/**
 * Score every sampled frame of one video.
 * @param {Array<{t:number, file:string}>} frames
 * @returns {Promise<Array<{t:number, desc:string, score:number}>>}
 */
export async function scoreFrames(frames, { interval, videoTitle, onBatch, onWarn } = {}) {
  const batch = [];
  for (let i = 0; i < frames.length; i += limits.framesPerBatch) {
    batch.push(frames.slice(i, i + limits.framesPerBatch));
  }

  const out = [];
  let usedModel = null;

  for (let b = 0; b < batch.length; b += 1) {
    const group = batch[b];
    const images = group.map((f) => fs.readFileSync(f.file).toString('base64'));
    const times = group.map((f) => f.t).join(', ');

    const user = `Video: "${videoTitle}".
The ${group.length} attached frames are sampled every ${interval} seconds in this order, captured at t = ${times} seconds.

Return ONLY a JSON array with exactly ${group.length} objects, one per frame, in the same order:
[{"t": <seconds>, "desc": "<what is happening, max 10 words>", "score": <integer 0-100>}]`;

    const { text, model } = await aiChat({
      system: SCORING_SYSTEM,
      user,
      images,
      maxTokens: 4000,
      temperature: 0.2,
      timeoutMs: 120_000,
      onWarn,
    });
    usedModel = model;

    const parsed = Array.isArray(extractJson(text)) ? extractJson(text) : null;
    if (!parsed) throw new Error(`model returned unparseable frame scores (${model})`);

    // Merge by nearest expected timestamp so ordering glitches cannot corrupt alignment.
    group.forEach((frame, i) => {
      const hit =
        parsed.find((p) => p && Math.abs(Number(p.t) - frame.t) < interval * 0.75) ||
        parsed[i] ||
        {};
      out.push({
        t: frame.t,
        desc: String(hit.desc || '').slice(0, 80),
        score: clampScore(hit.score),
      });
    });

    onBatch?.({ done: group.length, total: frames.length, model, partial: out.length });
  }

  out.sort((a, b) => a.t - b.t);
  return { scores: out, model: usedModel };
}

function clampScore(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 40;
  return Math.max(0, Math.min(100, Math.round(n)));
}

const COPY_SYSTEM = `You write punchy, click-worthy but honest packaging for short viral clips.
Reply with ONLY the JSON array requested. No commentary.`;

/** Give every chosen segment a title and a one-line "why it works" hook. */
export async function generateCopy(segments, onWarn = null) {
  const user = `Here are ${segments.length} video segments chosen from real YouTube videos for their viral potential.

${segments
  .map(
    (s, i) =>
      `${i + 1}. Source video: "${s.videoTitle}" (channel: ${s.channel}). Clip runs ${formatClock(
        s.startSec
      )}-${formatClock(s.endSec)}. Observed moments: ${s.highlights.filter(Boolean).join('; ') || 'action beats'}`
  )
  .join('\n')}

Return ONLY a JSON array of ${segments.length} objects in the same order:
[{"index": 1,
  "title": "<max 60 chars, punchy, no quotes, no hashtag>",
  "hook": "<max 120 chars on why this clip grabs attention>",
  "caption": "<2 sentence social caption opening with the strongest hook>",
  "hashtags": ["#one", "#two", "#three", "#four", "#five"]}, ...]`;

  try {
    const { text } = await aiChat({ system: COPY_SYSTEM, user, maxTokens: 3200, temperature: 0.7, timeoutMs: 90_000, onWarn });
    const parsed = extractJson(text);
    if (!Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function formatClock(sec) {
  const s = Math.max(0, Math.round(sec));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
