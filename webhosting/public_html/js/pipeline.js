/* The pipeline — browser-orchestrated port of server/lib/pipeline.js.
 * Same stages, same events, same prompts; the heavy lifting (download, frame
 * sampling, ffmpeg cutting) happens in the visitor's browser so shared
 * hosting only ever sees short PHP requests.
 *
 * Footage flow: AI researches YouTube → VidKraken hands back a trimmed MP4 for
 * each chosen video (built-in Innertube download as the same-video fallback) →
 * frames → vision scoring → windows → ffmpeg. Nothing is downloaded twice and
 * the AI never re-picks a video after the research stage. */
import { api } from './api.js?v=build7';
import { researchSources } from './agent.js?v=build7';
import { acquireFootage } from './downloader.js?v=build7';
import { extractFrames, scoreFrames, generateCopy, cutClip, ffmpeg, onFfmpegLoad } from './media.js?v=build7';

const interval = 4;   // seconds between scored frames — dense enough to catch a
                      // 10-second payoff, cheap enough to keep runs fast

const mapPool = async (items, n, worker) => {
  const res = new Array(items.length);
  let cur = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (cur < items.length) { const i = cur++; res[i] = await worker(items[i], i); }
  }));
  return res;
};

const fmtViews = (n) => { const v = Number(n) || 0;
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`; if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`; return String(v); };

export function newJobId() {
  return (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : Date.now().toString(36) + Math.random().toString(36).slice(2, 12));
}

export async function runJob(params, emit) {
  const { category, clipCount, clipLength, sourceCount, windowSeconds, quality, aspect } = params;
  const job = {
    id: newJobId(), params, category, status: 'running', createdAt: Date.now(), finishedAt: null,
    stage: 'searching', percent: 0, logs: [], sources: [], clips: [], model: null, error: null,
  };
  const stage = (s, pct, msg) => { job.stage = s; job.percent = pct; emit({ type: 'stage', stage: s, percent: pct, message: msg }); };
  /* Percent is monotone: a fallback that rewinds a stage never makes the bar
   * jump backwards. */
  let pctSeen = 0;
  const stageUp = (s, p, msg) => { pctSeen = Math.max(pctSeen, p || 0); stage(s, pctSeen, msg); };
  const log = (text) => { job.logs.push(text); emit({ type: 'log', text }); };
  const save = () => { api.saveJob(job).catch(() => {}); };
  const srcEvent = (entry) => emit({ type: 'source', source: entry });

  try {
    /* Warm the encoder up while the agent researches: the core is a ~10-33 MB
     * wasm and on a slow link it needs that head start. Progress is surfaced
     * so a first-time visitor sees "downloading encoder", never a stalled bar. */
    let lastLoadPct = -1;
    onFfmpegLoad((p) => {
      if (p !== lastLoadPct && (p === 0 || p === 100 || p - lastLoadPct >= 25)) {
        lastLoadPct = p;
        log(p === 100 ? '🎬 video encoder ready' : `⬇ downloading video encoder… ${p}%`);
      }
      if (job.stage === 'cutting' && p < 100) stageUp('cutting', job.percent, `Loading video encoder… ${p}%`);
    });
    ffmpeg().catch((e) => { log(`⚠ video encoder failed to load: ${String(e.message || e).slice(0, 130)}`); });

    /* 0 ─ AI research — YouTube Innertube search is the only discovery
     * channel: VidKraken has no search endpoint, it only downloads URLs. */
    job.source = 'youtube';
    stageUp('searching', 3, `AI agent is researching ${category} videos`);
    let turn = 0;
    const found = await researchSources({
      category, need: sourceCount, minDuration: clipLength + 10, spare: 1,
      log: (text) => { turn += 1; log(text); stageUp('searching', Math.min(9, 3 + turn * 0.35), 'AI agent researching sources'); },
    });
    const sources = found.videos;
    if (!sources.length) throw new Error(`no videos found for "${category}"`);
    sources.forEach((v, i) => {
      job.sources.push({ id: v.id, provider: 'youtube', title: v.title, channel: v.channel, views: v.views,
        duration: v.duration, url: `https://www.youtube.com/watch?v=${v.id}`, thumb: api.thumb(v),
        status: 'queued', percent: 0, peakScore: null, avgScore: null });
      log(`#${i + 1} ${v.title} — ${fmtViews(v.views)} views`);
    });
    save();

    /* 1 ─ Download capacity: VidKraken is metered (the free plan ships a
     * handful of downloads), so ask what is left BEFORE spending anything.
     * A zero balance, a missing key or an unreachable quota check all land in
     * the same place — WebDownloader → WeirdDL → built-in downloader, for the
     * very same videos. */
    stageUp('downloading', 11, 'Checking download capacity');
    let quota = null;
    try { quota = await api.vk({ action: 'quota' }); } catch { /* offline or 5xx: stay optimistic */ }
    const useVidkraken = !(quota && (quota.ok === false || quota.downloads === 0));
    if (useVidkraken) {
      log(quota?.downloads == null
        ? 'VidKraken ready — downloading through it'
        : `VidKraken ready — ${quota.downloads} download${quota.downloads === 1 ? '' : 's'} left on this plan`);
    } else {
      log(`VidKraken unavailable${quota?.error ? ` (${String(quota.error).slice(0, 90)})` : ' (plan quota exhausted)'} — falling back to WebDownloader → WeirdDL → built-in, same videos`);
    }

    /* 2 ─ Footage: one trimmed window per chosen video, VidKraken first.
     * When VidKraken fails for a video the built-in downloader takes over with
     * the SAME id — the research decision is never redone. */
    stageUp('downloading', 13, `Downloading ${job.sources.length} source videos`);
    const prepared = [];
    const progress = new Map(job.sources.map((s) => [s.id, 0]));
    const notes = new Map();
    await mapPool(job.sources, 3, async (entry, idx) => {
      const window = Math.min(windowSeconds, entry.duration || windowSeconds);
      entry.status = 'downloading'; srcEvent(entry);
      const report = (pct, note) => {
        progress.set(entry.id, Math.max(0, Math.min(100, pct || 0)));
        const avg = [...progress.values()].reduce((a, b) => a + b, 0) / progress.size;
        stageUp('downloading', 13 + (avg / 100) * 29, `Downloading source ${idx + 1} of ${job.sources.length}`);
        if (note && notes.get(entry.id) !== note) {
          notes.set(entry.id, note);
          log(`⏳ "${entry.title}" — ${note}`);
        }
      };
      try {
        const dl = await acquireFootage(entry, {
          windowSec: window,
          format: String(quality >= 720 ? 720 : 480),
          quality,
          useVidkraken,
        }, {
          onProgress: report,
          onFallback: (err, stage) => log(`↩︎ ${stage || 'VidKraken'} failed for "${entry.title}" — ${String(err.message || err).slice(0, 120)} — same video, next downloader`),
        });
        entry.status = 'downloaded'; entry.percent = 100; entry.localDuration = dl.coveredSec;
        srcEvent(entry);
        const via = { vidkraken: 'VidKraken', webdownloader: 'WebDownloader', weirddl: 'WeirdDL', innertube: 'built-in downloader' }[dl.method] || dl.method;
        log(`Ready "${entry.title}" — ${dl.coveredSec}s window, ${(dl.blob.size / 1048576).toFixed(1)} MB via ${via}`);
        prepared.push({ video: entry, blob: dl.blob, duration: dl.coveredSec, height: dl.height || quality, index: idx });
      } catch (err) {
        entry.status = 'failed'; srcEvent(entry);
        log(`Skipped "${entry.title}" — ${String(err.message || err).slice(0, 160)}`);
      }
    });
    if (!prepared.length) throw new Error('All source downloads failed — try running again in a minute.');
    log(`${prepared.length}/${job.sources.length} videos ready`);

    /* 3 ─ Frames — every `interval` seconds across the downloaded window. */
    stageUp('downloading', 45, 'Sampling frames from every video');
    const analyze = [];
    for (const item of prepared) {
      try {
        const { frames, duration } = await extractFrames(item.blob, { intervalSec: interval, limitSec: item.duration });
        item.frames = frames; item.duration = Math.min(item.duration, duration); analyze.push(item);
        log(`Sampled ${frames.length} frames from "${item.video.title}" (every ${interval}s)`);
      } catch (err) {
        item.video.status = 'failed'; srcEvent(item.video);
        log(`Frame sampling failed for "${item.video.title}" — ${String(err.message || err).slice(0, 140)}`);
      }
    }
    if (!analyze.length) throw new Error('Could not sample frames from any source video.');

    /* 4 ─ Vision — every video scored in parallel (was serial: the single
     * biggest wall-clock cost in a run). */
    stageUp('watching', 48, 'AI vision model is watching every frame');
    const totalFrames = analyze.reduce((n, a) => n + a.frames.length, 0);
    /* onBatch reports each video's CUMULATIVE frame count, so with parallel
     * scoring the delta (not the running total) is what advances the bar. */
    const progressSeen = new Map();
    let doneFrames = 0;
    await mapPool(analyze, 3, async (item) => {
      try {
        const res = await scoreFrames(item.frames, {
          interval, videoTitle: item.video.title,
          onBatch: (b) => {
            if (b.model && !job.model) { job.model = b.model; log(`Vision model in use: ${b.model}`); }
            const prev = progressSeen.get(item.video.id) || 0;
            doneFrames += Math.max(0, (b.done || 0) - prev);
            progressSeen.set(item.video.id, b.done || 0);
            stageUp('watching', 48 + (doneFrames / totalFrames) * 30, `AI watching frames (${doneFrames}/${totalFrames})`);
          },
        });
        const scores = res.scores;
        if (!scores.length) throw new Error('no frame scores');
        item.scores = scores;
        item.best = scores.reduce((m, s) => Math.max(m, s.score), 0);
        item.avg = Math.round(scores.reduce((n, s) => n + s.score, 0) / scores.length);
        log(`"${item.video.title}" — peak virality ${item.best}/100, average ${item.avg}/100`);
        Object.assign(job.sources[item.index], { status: 'watched', peakScore: item.best, avgScore: item.avg });
        srcEvent(job.sources[item.index]);
      } catch (err) {
        item.failed = true;
        log(`Analysis failed for "${item.video.title}" — ${String(err.message || err).slice(0, 200)}`);
      }
    });
    let analyzed = analyze.filter((a) => !a.failed && a.scores && a.scores.length >= 3);
    if (!analyzed.length) throw new Error('The AI could not score any source video. Try running again.');

    /* 5 ─ Rank the videos themselves, then their windows: a video that never
     * peaks above 30 is footage we should not be cutting clips from. */
    stageUp('selecting', 79, 'Ranking videos and highlight windows');
    analyzed.sort((a, b) => (b.best - a.best) || (b.avg - a.avg));
    const keepN = Math.max(1, Math.min(sourceCount, analyzed.length));
    const survivors = analyzed.filter((v, i) => i < keepN && (v.best >= 30 || i === 0));
    analyzed.filter((v) => !survivors.includes(v)).forEach((v) => {
      v.video.status = 'failed'; srcEvent(v.video);
      log(`👀 rejected — "${v.video.title}" peaked ${v.best}/100 (keeping the best ${survivors.length})`);
    });
    analyzed = survivors;
    analyzed.forEach((v, i) => log(`👀 watched ${i + 1}/${analyzed.length}: "${v.video.title}" — peak ${v.best}/100, avg ${v.avg}/100`));

    let segments = selectSegments(analyzed, { clipCount, clipLength, interval });
    if (!segments.length) throw new Error('No highlight windows found for that clip length — try a shorter clip length.');
    const topScore = Math.max(...segments.map((s) => s.raw));
    if (topScore < 40) log(`⚠ best window only scores ${topScore}/100 — this footage is weak; results may disappoint`);
    if (segments.length < clipCount) log(`Only ${segments.length} of ${clipCount} clips available (sources too short)`);
    log(`Selected ${segments.length} highlight windows (avg score ${Math.round(segments.reduce((n, s) => n + s.raw, 0) / segments.length)}/100)`);
    save();

    /* 6 ─ Cut clips with ffmpeg.wasm */
    stageUp('cutting', 83, `Cutting ${segments.length} clips`);
    const byId = new Map(analyzed.map((a) => [a.video.id, a]));
    const cut = [];
    for (let i = 0; i < segments.length; i += 1) {
      const seg = segments[i];
      const src = byId.get(seg.videoId);
      try {
        stageUp('cutting', 83 + ((i) / segments.length) * 13, `Cutting clip ${i + 1} of ${segments.length}`);
        const blob = await cutClip({
          videoBlob: src.blob, audioBlob: null, startSec: seg.startSec,
          span: seg.endSec - seg.startSec, aspect,
          onProgress: (p) => stageUp('cutting', 83 + ((i + p / 100) / segments.length) * 13, `Encoding clip ${i + 1} (${p}%)`),
          onLog: (line) => log(`⚙ ffmpeg: ${line}`),
        });
        const name = `clip_${String(i + 1).padStart(2, '0')}.mp4`;
        const up = await api.uploadClip(job.id, name, blob);
        const clip = toClip(job, seg, up.url, i + 1, null);
        job.clips.push(clip);
        emit({ type: 'clip-ready', clip });
        cut.push(seg);
        log(`Clip ${i + 1} rendered — ${(blob.size / 1048576).toFixed(1)} MB`);
        save();
      } catch (err) {
        log(`Clip ${i + 1} failed to render — ${String(err.message || err).slice(0, 160)}`);
      }
    }
    if (!cut.length) throw new Error('ffmpeg could not render any clips.');

    /* 7 ─ Titles + hooks */
    stageUp('cutting', 97, 'Writing titles and hooks');
    const copy = await generateCopy(cut.map((c) => ({ videoTitle: c.videoTitle, channel: c.channel, startSec: c.startSec, endSec: c.endSec, highlights: c.highlights })));
    const byIndex = new Map();
    if (Array.isArray(copy)) for (const c of copy) { const n = Number(c?.index); if (Number.isFinite(n)) byIndex.set(n, c); }
    job.clips = cut.map((c, i) => toClip(job, c, job.clips[i].file, i + 1, byIndex.get(i + 1) || null));

    /* 8 ─ Finish */
    job.status = 'done'; job.finishedAt = Date.now();
    stageUp('done', 100, `${job.clips.length} clips ready`);
    log(`Done — ${job.clips.length} clip${job.clips.length === 1 ? '' : 's'} ready to preview`);
    save();
    emit({ type: 'result', clips: job.clips, model: job.model, sources: job.sources });
  } catch (err) {
    job.status = 'error'; job.error = String(err?.message || err); job.finishedAt = Date.now();
    stageUp('error', job.percent, job.error);
    log(`ERROR: ${job.error}`);
    save();
    emit({ type: 'error', message: job.error });
  }
  return job;
}

/* Sliding-window ranking with per-video caps.
 *
 * Two things the old version got wrong: every window in a mediocre video was
 * as good as the best window in a great one, and a popular source video got no
 * credit for having an audience. Both are fixed here — a quality floor first,
 * then a small popularity bonus on top of the vision score. */
function selectSegments(analyzed, { clipCount, clipLength, interval }) {
  const all = [];
  for (const item of analyzed) {
    const scores = item.scores;
    const maxStart = item.duration || (scores[scores.length - 1].t + interval);
    const smoothed = scores.map((s, i) => ({ ...s,
      v: 0.5 * s.score + 0.3 * (scores[i - 1]?.score ?? s.score) + 0.2 * (scores[i + 1]?.score ?? s.score) }));
    for (const head of smoothed) {
      const start = Math.max(0, head.t);
      const end = start + clipLength;
      if (end > maxStart) continue;
      const inside = smoothed.filter((s) => s.t >= start && s.t < end);
      if (!inside.length) continue;
      const raw = Math.round(inside.reduce((n, s) => n + s.v, 0) / inside.length);
      const highlights = [...inside].sort((a, b) => b.score - a.score).slice(0, 3).map((s) => s.desc).filter(Boolean);
      all.push({ videoId: item.video.id, videoTitle: item.video.title, channel: item.video.channel,
        views: item.video.views, videoUrl: item.video.url, startSec: start, endSec: end, raw, highlights, index: item.index });
    }
  }
  if (!all.length) return [];

  const FLOOR = 40;
  const strong = all.filter((c) => c.raw >= FLOOR);
  const pool = strong.length >= clipCount ? strong : all;   // fall back rather than return nothing
  const bonus = (v) => (v >= 1e6 ? 8 : v >= 1e5 ? 6 : v >= 1e4 ? 3 : v >= 1e3 ? 1 : 0);
  for (const c of pool) c.score = c.raw + bonus(c.views);
  pool.sort((a, b) => b.score - a.score);

  const caps = [1, 2, 3, Infinity];
  let best = [];
  for (const cap of caps) {
    const chosen = [];
    const perVideo = new Map();
    for (const cand of pool) {
      if (chosen.length >= clipCount) break;
      const n = perVideo.get(cand.videoId) || 0;
      if (n >= cap) continue;
      if (chosen.some((c) => c.videoId === cand.videoId && Math.abs(c.startSec - cand.startSec) < clipLength * 0.75)) continue;
      perVideo.set(cand.videoId, n + 1);
      chosen.push(cand);
    }
    best = chosen;
    if (chosen.length >= clipCount) break;
  }
  return best.sort((a, b) => a.startSec - b.startSec);
}

function toClip(job, segment, file, index, copy) {
  const hashtags = (Array.isArray(copy?.hashtags) ? copy.hashtags.filter((h) => typeof h === 'string' && h.trim()).slice(0, 7).map((h) => (h.startsWith('#') ? h : `#${h}`)) : []);
  const base = segment.videoTitle.replace(/\s*[-|–]\s*YouTube$/i, '').slice(0, 50);
  const round1 = (n) => Math.round(n * 10) / 10;
  return {
    id: `${job.id}-${index}`, index,
    title: copy?.title || `${base} — ${clock(segment.startSec)} highlight`,
    hook: copy?.hook || segment.highlights?.[0] || `Highlight from ${segment.videoTitle}`,
    caption: copy?.caption || copy?.hook || '', hashtags,
    score: segment.score, aspect: job.params.aspect,
    startSec: round1(segment.startSec), endSec: round1(segment.endSec), duration: round1(segment.endSec - segment.startSec),
    videoTitle: segment.videoTitle, channel: segment.channel, views: segment.views, sourceUrl: segment.videoUrl, file,
  };
}
const clock = (sec) => { const s = Math.max(0, Math.round(sec)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
