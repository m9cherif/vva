import { api, extractJson } from './api.js?v=build7';
const MAX_SEARCHES = 4, MAX_ROUNDS = 10, IMAGES_PER_TURN = 8;

/* Selection bar, in priority order. The old prompt only said "prefer" things,
 * which is how compilation reels and 400-view uploads kept getting through:
 * the model needs a ranked test it can apply to each candidate. */
const SYSTEM = `You are the research agent inside an automated viral-clip studio.
Your job: find the BEST source videos to mine for viral clips in a given category.
Each turn you receive the state and candidate videos (title, channel, duration, views). Covers are attached in the SAME ORDER as the list.
Reply with EXACTLY one JSON object: {"reason":"...","keep":[ids],"drop":[ids],"search":"new query or null","done":false}

Apply this bar to EVERY candidate, in order:
1. AUDIENCE — real people watched it. Prefer >=100K views; >=1M is a strong yes. When anything better is on screen, drop videos under ~5K views, and always drop obvious spam/re-uploads.
2. CONTINUITY — one continuous subject or event that a 15-45 second moment can be cut from. Strongly prefer single-subject footage. Drop compilations, "top 10 / best of" reels, slideshows, static logo or text-on-screen videos, screen recordings with no action, and narrated talking heads — unless nothing else remains.
3. FIT — the title and cover must promise action, emotion, skill, surprise or humor that fits the category. Reject off-topic videos, misleading titles and covers drowned in watermark/overlay text.
4. LENGTH — prefer duration >= MIN_DURATION: a clip needs a full window of usable footage, not a 40-second stub.

Rules: keep only ids shown this turn. Vary every query — plain keyword phrases a person would actually type (e.g. "funny dog fails", "cat jumps"), never a platform, site name, or words like "archive" and "vintage". Prefer strong covers and high views. Use different channels when you can.
NEVER end with keep=[] while candidates are on screen — pick the best of what exists, even if it only passes bar 4. done:true only when enough are kept or the search budget is gone.`;

export async function researchSources({ category, need, minDuration, spare = 0, log = () => {} }) {
  const target = need + spare;
  const seen = new Map(), kept = [], dropped = new Set(), history = [];
  let pool = [], searches = 0, round = 0, lastQuery = null, malformed = 0, stopped = '', aiFails = 0;
  const note = (t) => log(t);
  note(`🤖 Agent researching "${category}" — needs ${need} videos (≥${minDuration}s)${spare ? ` (+${spare} spare)` : ''}`);

  while (round < MAX_ROUNDS) {
    round++;
    const cands = pool.filter((v) => !dropped.has(v.id) && !kept.some((k) => k.id === v.id)).slice(0, IMAGES_PER_TURN);
    const images = (await Promise.all(cands.map(async (v) => {
      try {
        const r = await fetch(api.thumb(v));
        if (!r.ok) return null;
        const b = await r.blob();
        if (b.size < 500 || b.size > 3e6) return null;
        return await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result.split(',')[1]); fr.readAsDataURL(b); });
      } catch { return null; }
    }))).filter(Boolean);
    const shown = images.length ? cands.slice(0, images.length) : cands;

    const user = `CATEGORY: ${category}
SOURCE: YouTube search results (a real audience: read the view counts carefully — they are the fastest signal of whether footage is worth cutting).
QUERY STYLE: plain keyword phrases a person would actually type (e.g. "funny dog fails", "cat jumps") — never mention a platform, site name, "archive" or "vintage"; vary the wording every time.
NEED: ${need} | KEPT: ${kept.length} | MIN_DURATION: ${minDuration}s
SEARCHES: ${searches}/${MAX_SEARCHES} | TURN: ${round}/${MAX_ROUNDS}
${lastQuery ? `LAST QUERY: "${lastQuery}"` : 'NO SEARCH YET — start with a query.'}

KEPT SO FAR:
${kept.map((v, i) => `  ${i + 1}. id=${v.id} "${v.title}" | ${v.duration}s | ${v.views} views | ${v.channel}`).join('\n') || '  (none)'}
DROPPED: ${[...dropped].slice(-10).join(', ') || '(none)'}

CANDIDATES${images.length ? ` — ${images.length} covers attached, in this exact order` : ''}:
${shown.map((v, i) => `  ${i + 1}. id=${v.id} | "${v.title}" | ${v.duration}s | ${v.views} views | ${v.channel}`).join('\n') || '  (none — you must search)'}

Reply with ONLY the JSON object.`;

    let text;
    try {
      ({ text } = await api.ai({ system: SYSTEM, user, images, history, maxTokens: 2500, temperature: 0.3, attempts: 2 }));
    } catch (e) {
      aiFails++;
      note(`⚠ agent call failed (${String(e.message || e).slice(0, 110)}) — retrying (${aiFails}/2)`);
      if (aiFails > 2) break;
      history.push({ role: 'user', content: 'Your previous reply did not arrive. Reply again with ONLY the JSON object specified.' });
      continue;
    }
    history.push({ role: 'assistant', content: text });
    history.push({ role: 'user', content: user });
    while (history.length > 12) history.shift();

    const d = extractJson(text);
    if (!d || typeof d !== 'object' || Array.isArray(d)) {
      malformed++;
      if (malformed >= 3) { note('⚠ agent stopped: unusable decisions'); break; }
      history.push({ role: 'user', content: 'Reply with ONLY the JSON object specified.' });
      continue;
    }
    malformed = 0; aiFails = 0;

    const reason = String(d.reason || '').trim().slice(0, 220);
    for (const id of Array.isArray(d.keep) ? d.keep : []) {
      const c = seen.get(String(id));
      if (c && !dropped.has(c.id) && !kept.some((k) => k.id === c.id)) {
        kept.push(c);
        note(`✅ kept "${c.title}" — ${c.duration}s · ${c.views} views`);
      }
    }
    for (const id of Array.isArray(d.drop) ? d.drop : []) {
      const c = seen.get(String(id));
      if (c && !kept.some((k) => k.id === c.id) && !dropped.has(c.id)) {
        dropped.add(c.id);
        note(`❌ dropped "${c.title}"${reason ? ` — ${reason}` : ''}`);
      }
    }
    if (d.done && reason) note(`🧠 ${reason}`);
    if (kept.length >= target) { stopped = `found ${kept.length}/${need} videos`; break; }
    if (d.done) { stopped = reason || 'agent satisfied'; break; }

    const q = typeof d.search === 'string' ? d.search.trim().slice(0, 120) : '';
    if (q && searches < MAX_SEARCHES) {
      searches++; lastQuery = q;
      note(`🔎 search ${searches}/${MAX_SEARCHES}: "${q}"`);
      try {
        const rows = (await api.search(q)).videos || [];
        rows.forEach((r) => seen.set(r.id, r));
        pool = rows;
        note(`   → ${rows.length} candidates`);
        if (!rows.length) history.push({ role: 'user', content: 'That query returned zero results. Try a different one.' });
      } catch (e) {
        note(`   ⚠ ${String(e.message || e).slice(0, 160)}`);
        pool = [];
        history.push({ role: 'user', content: `Search failed: ${String(e.message || e).slice(0, 200)}` });
      }
      continue;
    }
    history.push({ role: 'user', content: searches >= MAX_SEARCHES ? 'Search budget exhausted — decide with what is on screen.' : 'Give a decision: keep, drop, search or done.' });
  }

  if (!stopped) stopped = `round limit (${MAX_ROUNDS}) reached`;

  /* Fill up from everything we ever saw — including videos the agent dropped —
   * rather than failing the whole job over a strict judgment call. The most
   * viewed ones go first: popularity is the best proxy for usable footage. */
  if (kept.length < target) {
    [...seen.values()]
      .filter((v) => !kept.some((k) => k.id === v.id))
      .sort((a, b) => b.views - a.views)
      .forEach((v) => { if (kept.length < target) { kept.push(v); note(`➕ topped up with "${v.title}" (${v.views} views)`); } });
  }
  if (!kept.length) throw new Error(`The AI research agent found no videos at all for "${category}". Try another category.`);

  note(`🎯 agent finished: ${kept.length} video${kept.length === 1 ? '' : 's'} selected (${stopped})`);
  return { videos: kept.slice(0, target) };
}
