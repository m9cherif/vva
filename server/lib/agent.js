import { searchVideos } from './ytdlp.js';
import { aiChat, extractJson } from './nvidia.js';
import { limits } from '../config.js';

/**
 * Autonomous research agent.
 *
 * Instead of running one hard-coded query, the model drives the whole hunt:
 * it writes its own search queries, looks at each candidate's COVER (thumbnail)
 * plus title/channel/duration/views, keeps the good ones, discards the rest,
 * and searches again with a sharper query until it has what it needs.
 *
 * @returns {{videos: Array, report: Array}}
 */
const MAX_SEARCHES = 3;
const MAX_ROUNDS = 9;
const IMAGES_PER_TURN = 8;
const THUMB_TIMEOUT_MS = 9_000;

const SYSTEM = `You are the research agent inside an automated viral-clip studio.
Your job: find the BEST source videos to mine for viral clips in a given category.

Each turn you receive:
- the current state (how many you kept, how many you still need, budget left), and
- a list of candidate videos with their title, channel, duration and view count.
When thumbnails are attached they are the video COVERS, in the SAME ORDER as the candidate list.
Judge the covers: does the image clearly show the subject, look exciting, face-driven, high quality?

You answer with EXACTLY ONE JSON object and nothing else — no prose, no code fences:
{
  "reason": "<one short line explaining this decision>",
  "keep": ["<video id>", ...],
  "drop": ["<video id>", ...],
  "search": "<a new, sharper search query, or null>",
  "done": false
}

Rules:
- "keep" only from the candidate list. "drop" what is irrelevant, off-topic, wrong length, duplicate or low quality.
- Prefer covers that clearly show the category subject, strong emotions, action, faces, spectacle.
- Prefer videos with real reach (views) and titles that promise a payoff.
- Duration must be at least MIN_DURATION seconds. Length itself is NEVER a reason to drop a video:
  we only fetch a short window from it, so a 10 minute source costs the same as a 3 minute one.
- What matters is CONTINUITY. Prefer a single continuous subject — one match, one run, one stunt,
  one reaction. Drop "TOP 100" style compilations that cut between unrelated scenes every few
  seconds, because any window we take from one would be several unrelated scenes glued together.
  A long video of one continuous session is GOOD; a 50-scene compilation is BAD.
- Prefer covers with a clear subject, strong emotion or action, and without heavy watermark or
  clickbait text covering the whole frame.
- Use "search" to run a NEW query when candidates are weak or repetitive: narrow to a sub-niche,
  a specific event, a creator style, or an angle you have not tried. Vary every query.
- Keep searching until you have enough videos OR the search budget runs out.
- When you have enough good videos, or the budget is gone and nothing better exists: set "done": true.
- Never return ids you have not been shown. Never keep a video you previously dropped.`;

export async function researchSources({ category, need, minDuration, log = () => {} }) {
  const seen = new Map(); // id -> candidate
  const kept = [];
  const dropped = new Set();
  const history = [];
  const report = [];
  const thumbCache = new Map();

  let pool = []; // candidates from the most recent search, in model order
  let searches = 0;
  let round = 0;
  let lastQuery = null;
  let malformed = 0;
  let stopped = '';

  const note = (text, kind = 'agent') => {
    report.push({ kind, text });
    log(text);
  };

  note(`🤖 Agent researching "${category}" — needs ${need} videos (≥${minDuration}s)`);

  while (round < MAX_ROUNDS) {
    round += 1;

    /* ── build this turn's state + covers ─────────────────────────── */
    const candidates = pool.filter((v) => !dropped.has(v.id) && !keptIds(kept).includes(v.id));
    const batch = candidates.slice(0, IMAGES_PER_TURN);
    const { images, vids: shown0 } = await loadCovers(batch, thumbCache);
    // Without covers we still list them (metadata only); with covers, list exactly the covered prefix.
    const shown = images.length ? shown0 : batch;

    const user = buildState({
      category,
      need,
      minDuration,
      kept,
      dropped,
      searches,
      round,
      lastQuery,
      shown,
      images: images.length,
    });

    let text;
    try {
      ({ text } = await aiChat({
        system: SYSTEM,
        user,
        images,
        history,
        maxTokens: 2500,
        temperature: 0.3,
        timeoutMs: 90_000,
        attempts: 2,
        onWarn: (msg) => note(`⚠ ${String(msg).slice(0, 160)}`, 'warn'),
      }));
    } catch (err) {
      note(`⚠ agent call failed: ${String(err.message || err).slice(0, 140)}`, 'warn');
      break;
    }

    history.push({ role: 'assistant', content: text });
    history.push({ role: 'user', content: user });
    while (history.length > 12) history.shift();

    const decision = extractJson(text);
    if (!decision || typeof decision !== 'object' || Array.isArray(decision)) {
      malformed += 1;
      if (malformed >= 3) {
        note('⚠ agent stopped: model kept returning unusable decisions', 'warn');
        break;
      }
      history.push({ role: 'user', content: 'Reply with ONLY the JSON object specified. Nothing else.' });
      continue;
    }
    malformed = 0;

    /* ── apply the decision ───────────────────────────────────────── */
    const reason = String(decision.reason || '').trim().slice(0, 220);

    for (const id of asArray(decision.keep)) {
      const cand = seen.get(id);
      if (cand && !dropped.has(id) && !keptIds(kept).includes(id)) {
        kept.push(cand);
        note(`✅ kept "${cand.title}" — ${fmt(cand.duration)} · ${views(cand.views)}`);
      }
    }
    for (const id of asArray(decision.drop)) {
      const cand = seen.get(id);
      if (cand && !keptIds(kept).includes(id) && !dropped.has(id)) {
        dropped.add(id);
        note(`❌ dropped "${cand.title}"${reason ? ` — ${reason}` : ''}`);
      }
    }
    if (decision.done && reason) note(`🧠 ${reason}`);

    if (kept.length >= need) {
      stopped = `found ${kept.length}/${need} videos`;
      break;
    }
    if (decision.done) {
      stopped = reason || 'agent is satisfied with the selection';
      break;
    }

    /* ── optionally run another search ────────────────────────────── */
    const query = typeof decision.search === 'string' ? decision.search.trim().slice(0, 120) : '';
    if (query && searches < MAX_SEARCHES) {
      searches += 1;
      lastQuery = query;
      note(`🔎 search ${searches}/${MAX_SEARCHES}: "${query}"`);
      try {
        const rows = await searchVideos(query, limits.searchPoolSize);
        for (const row of rows) seen.set(row.id, row);
        pool = rows;
        note(`   → ${rows.length} candidates`);
        if (rows.length === 0) {
          history.push({ role: 'user', content: 'That query returned zero results. Try a different one.' });
        }
      } catch (err) {
        note(`   ⚠ ${String(err.message || err).slice(0, 160)}`, 'warn');
        pool = [];
        history.push({ role: 'user', content: `The search failed: ${String(err.message || err).slice(0, 200)}` });
      }
      continue;
    }

    history.push({
      role: 'user',
      content:
        searches >= MAX_SEARCHES
          ? 'Search budget is exhausted — work only with what is on screen, or answer done.'
          : 'Give a decision: keep, drop, search or done.',
    });
  }

  if (!stopped) stopped = `round limit (${MAX_ROUNDS}) reached`;

  /* ── top up from what we have seen if the agent fell short ──────── */
  if (kept.length < need) {
    const candidates = [...seen.values()]
      .filter((v) => !dropped.has(v.id) && !keptIds(kept).includes(v.id))
      .sort((a, b) => b.views - a.views);
    for (const v of candidates) {
      if (kept.length >= need) break;
      kept.push(v);
      note(`➕ topped up with "${v.title}" (${views(v.views)} views)`);
    }
  }

  if (!kept.length) {
    throw new Error(
      `The AI research agent could not find usable videos for "${category}". Try a broader or more specific category.`
    );
  }

  note(`🎯 agent finished: ${kept.length} video${kept.length === 1 ? '' : 's'} selected (${stopped})`);
  return { videos: kept.slice(0, need), report };
}

/* ── helpers ──────────────────────────────────────────────────────────── */

function keptIds(kept) {
  return kept.map((v) => v.id);
}

function asArray(value) {
  if (Array.isArray(value)) return value.map((v) => String(v));
  if (typeof value === 'string' && value) return [value];
  return [];
}

function buildState({ category, need, minDuration, kept, dropped, searches, round, lastQuery, shown, images }) {
  const keptList = kept
    .map((v, i) => `  ${i + 1}. id=${v.id} "${v.title}" | ${fmt(v.duration)} | ${views(v.views)} | ${v.channel}`)
    .join('\n');
  const dropList = [...dropped]
    .slice(-10)
    .map((id) => `  - ${id}`)
    .join('\n');

  const candList = shown.length
    ? shown
        .map(
          (v, i) =>
            `  ${i + 1}. id=${v.id} | "${v.title}" | ${fmt(v.duration)} | ${views(v.views)} views | ${v.channel}`
        )
        .join('\n')
    : '  (none — you must search)';

  return `CATEGORY: ${category}
NEED: ${need} videos total | KEPT: ${kept.length} | MIN_DURATION: ${minDuration}s
SEARCHES USED: ${searches}/${MAX_SEARCHES} | TURN: ${round}/${MAX_ROUNDS}
${lastQuery ? `LAST QUERY: "${lastQuery}"` : 'NO SEARCH RUN YET — start with a query.'}

KEPT SO FAR:
${keptList || '  (none)'}
DROPPED (never suggest again):${dropList ? `\n${dropList}` : '  (none)'}

CURRENT CANDIDATES${images ? ` — ${images} covers attached below, in this exact order` : ''}:
${candList}

Reply with ONLY the JSON object.`;
}

/**
 * Fetch covers for the candidates. Returns a PREFIX of those candidates plus their
 * images so list order and image order can never drift apart (the model is told the
 * covers follow the list in the same order).
 */
async function loadCovers(videos, cache) {
  const results = await Promise.all(
    videos.map(async (v) => {
      const url = v.thumb || `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`;
      if (!cache.has(url)) cache.set(url, await fetchThumb(url));
      return cache.get(url) || null;
    })
  );
  const images = [];
  const vids = [];
  for (let i = 0; i < videos.length; i += 1) {
    if (!results[i]) break;
    images.push(results[i]);
    vids.push(videos[i]);
  }
  return { images, vids };
}

async function fetchThumb(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(THUMB_TIMEOUT_MS) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 500 || buf.length > 3_000_000) return null;
    return buf.toString('base64');
  } catch {
    return null;
  }
}

function fmt(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function views(n) {
  const v = Number(n) || 0;
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(v);
}
