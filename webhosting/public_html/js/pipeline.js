/* The pipeline — browser-orchestrated port of server/lib/pipeline.js.
 * Same stages, same events, same prompts; the heavy lifting (download, frame
 * sampling, ffmpeg cutting) happens in the visitor's browser so shared
 * hosting only ever sees short PHP requests. */
import { api } from './api.js?v=build1';
import { researchSources } from './agent.js?v=build1';
import { downloadPrefix } from './downloader.js?v=build1';
import { extractFrames, scoreFrames, generateCopy, cutClip, ffmpeg, onFfmpegLoad } from './media.js?v=build1';

const interval = 6;
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
  /* Percent is monotone: a source fallback that rewinds a stage never makes
   * the bar jump backwards. */
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

    /* 0 ─ Source chain: YouTube → Pexels (if a key is configured) → Internet
     * Archive (keyless, free forever). YouTube's player can resolve one probe
     * and then refuse real videos — the bot check is per-request — so the
     * fallback is driven by the ACTUAL stream resolution: when a tier yields
     * nothing playable we drop its sources and re-run research on the next. */
    const explicit = params.source && params.source !== 'auto' ? String(params.source) : '';
    const candidates = explicit ? [explicit] : ['youtube'];
    if (explicit) {
      log(`Source: ${explicit} (chosen explicitly)`);
    } else {
      stageUp('searching', 2, 'Checking which video sources this server can reach');
      try {
        await api.search('nature', 1, 'pexels');
        candidates.push('pexels');
        log('Pexels key configured — using it as the middle tier');
      } catch { /* no key: skip that tier entirely */ }
      candidates.push('archive');
      log(`Source order: ${candidates.join(' → ')}`);
    }

    let source = candidates[0];
    let resolved = [];
    let sources = [];
    let lastFailure = '';

    for (let attempt = 0; attempt < candidates.length && resolved.length === 0; attempt += 1) {
      source = candidates[attempt];
      job.source = source;
      if (attempt > 0) {
        log(`↩︎ Falling back to "${source}" — ${lastFailure.slice(0, 110)}`);
        job.sources = [];
        emit({ type: 'sources-reset' });
      }
      stageUp('searching', 4, `AI agent is researching ${category} videos via ${source}`);
      let turn = 0;
      try {
        /* 1 ─ AI research */
        const found = await researchSources({
          category, need: sourceCount, minDuration: clipLength + 10, spare: 2, source,
          log: (text) => { turn += 1; log(text); stageUp('searching', Math.min(9, 4 + turn * 0.35), 'AI agent researching sources'); },
        });
        sources = found.videos;
        if (!sources.length) throw new Error(`no videos found for "${category}" on this source`);
        sources.forEach((v, i) => {
          const provider = v.provider || 'youtube';
          const isYouTube = provider === 'youtube';
          job.sources.push({ id: v.id, provider, title: v.title, channel: v.channel, views: v.views, duration: v.duration,
            url: isYouTube ? `https://www.youtube.com/watch?v=${v.id}` : (v.page || ''), thumb: api.thumb(v), status: 'queued', percent: 0, peakScore: null, avgScore: null });
          log(`#${i + 1} ${v.title} — ${fmtViews(v.views)} views`);
        });
        save();

        /* 2 ─ Stream resolution */
        stageUp('downloading', 10, `Resolving streams for ${sources.length} videos`);
        const got = [];
        await mapPool(job.sources, 3, async (entry, idx) => {
          try {
            const info = await api.player(entry.id, entry.provider || source);
            entry.duration = info.duration || entry.duration;
            const videos = info.streams.filter((s) => s.kind === 'video' && s.mimeType.includes('mp4'));
            const best = videos.filter((s) => s.height <= quality).sort((a, b) => b.height - a.height)[0]
                       || videos.sort((a, b) => a.height - b.height)[0];
            if (!best) throw new Error('no compatible video stream');
            got.push({ entry, idx, best, info });
          } catch (err) {
            entry.status = 'failed'; srcEvent(entry);
            log(`Skipped "${entry.title}" — ${String(err.message || err).slice(0, 160)}`);
          }
        });
        if (!got.length) throw new Error('none of the selected videos could be played from this server');
        resolved = got;
        log(`✅ source locked: ${source} (${resolved.length} playable video${resolved.length === 1 ? '' : 's'})`);
      } catch (err) {
        lastFailure = String(err.message || err);
        log(`Source "${source}" failed — ${lastFailure.slice(0, 160)}`);
      }
    }
    if (!resolved.length) throw new Error(lastFailure || 'No streams could be resolved. Try again in a minute.');

    /* 2b ─ AI WATCHES A PREVIEW — before downloading any full window.
     * 12 seconds of bytes + 2 frames is enough for the vision model to judge
     * the footage, so weak sources are rejected before we pay for them. */
    stageUp('downloading', 16, `AI previewing ${resolved.length} videos before downloading`);
    const PREVIEW_SEC = 12;
    const previews = await mapPool(resolved, 3, async (r) => {
      try {
        const dl = await downloadPrefix({ ...r.best, durationSec: r.info.duration }, PREVIEW_SEC, () => {});
        const { frames } = await extractFrames(dl.blob, { intervalSec: interval, limitSec: Math.min(PREVIEW_SEC, dl.coveredSec || PREVIEW_SEC) });
        if (frames.length < 2) throw new Error('preview too short to judge');
        const { scores, model } = await scoreFrames(frames, { interval, videoTitle: r.entry.title });
        if (model && !job.model) { job.model = model; log(`Vision model in use: ${model}`); }
        const peak = Math.max(...scores.map((s) => s.score));
        const avg = Math.round(scores.reduce((n, s) => n + s.score, 0) / scores.length);
        return { ...r, preview: { scores, peak, avg } };
      } catch (err) {
        log(`Preview failed for "${r.entry.title}" — ${String(err.message || err).slice(0, 140)}`);
        return null;
      }
    });
    const ranked = previews.filter(Boolean).sort((a, b) => b.preview.peak - a.preview.peak);
    if (!ranked.length) throw new Error('The AI could not preview any source video. Try running again.');
    const keepN = Math.max(1, Math.min(sourceCount, ranked.length));
    const survivors = ranked.slice(0, keepN).filter((r, i) => r.preview.peak >= 10 || i === 0);
    const survivorIds = new Set(survivors.map((s) => s.entry.id));
    ranked.forEach((r) => {
      if (survivorIds.has(r.entry.id)) return;
      r.entry.status = 'failed'; srcEvent(r.entry);
      log(`👀 rejected after preview — "${r.entry.title}" peaked ${r.preview.peak}/100 (keeping the best ${survivors.length})`);
    });
    survivors.forEach((r, i) => {
      log(`👀 AI watched preview ${i + 1}/${survivors.length}: "${r.entry.title}" — peak ${r.preview.peak}/100, avg ${r.preview.avg}/100`);
    });

    /* 2c ─ full window download — only for videos that passed the preview */
    stageUp('downloading', 30, `Downloading ${survivors.length} video${survivors.length === 1 ? '' : 's'} that passed the preview`);
    const prepared = [];
    await mapPool(survivors, 3, async (r) => {
      const entry = r.entry;
      try {
        const window = Math.min(windowSeconds, entry.duration || windowSeconds);
        entry.status = 'downloading'; srcEvent(entry);
        const dl = await downloadPrefix({ ...r.best, durationSec: r.info.duration }, window, (pct) => {
          if (pct === entry.percent) return;
          entry.percent = pct; srcEvent(entry);
        });
        entry.status = 'downloaded'; entry.percent = 100; entry.localDuration = dl.coveredSec; srcEvent(entry);
        log(`Ready "${entry.title}" — ${dl.coveredSec}s window, ${(dl.blob.size / 1048576).toFixed(1)} MB at ${r.best.height}p`);
        prepared.push({ video: entry, blob: dl.blob, duration: dl.coveredSec, height: r.best.height, index: r.idx, base: r.info, preview: r.preview });
      } catch (err) {
        entry.status = 'failed'; srcEvent(entry);
        log(`Skipped "${entry.title}" — ${String(err.message || err).slice(0, 160)}`);
      }
    });
    if (!prepared.length) throw new Error('All source downloads failed — YouTube may be rate-limiting. Retry in a minute.');
    log(`${prepared.length}/${job.sources.length} videos passed the AI preview and are ready`);
    stageUp('downloading', 40, 'Sampling frames from every video');

    /* 3 ─ Frames */
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

    /* 4 ─ Vision */
    stageUp('watching', 42, 'AI vision model is watching every frame');
    const totalFrames = analyze.reduce((n, a) => n + a.frames.length, 0);
    let doneFrames = 0;
    await mapPool(analyze, 2, async (item) => {
      try {
        // Frames already judged during the preview pass are reused — only the
        // remaining footage is sent to the vision model.
        const key = (t) => Math.round(Number(t) * 100) / 100;
        const frameKeys = new Set(item.frames.map((f) => key(f.t)));
        const carried = (item.preview?.scores || []).filter((s) => frameKeys.has(key(s.t)));
        const carriedKeys = new Set(carried.map((s) => key(s.t)));
        const fresh = item.frames.filter((f) => !carriedKeys.has(key(f.t)));
        doneFrames += item.frames.length - fresh.length;
        let freshScores = [];
        if (fresh.length) {
          const res = await scoreFrames(fresh, {
            interval, videoTitle: item.video.title,
            onBatch: (b) => {
              if (b.model && !job.model) { job.model = b.model; log(`Vision model in use: ${b.model}`); }
              doneFrames += b.done;
              stageUp('watching', 42 + (doneFrames / totalFrames) * 34, `AI watching frames (${doneFrames}/${totalFrames})`);
            },
          });
          freshScores = res.scores;
        }
        const scores = [...carried, ...freshScores].sort((a, b) => a.t - b.t);
        if (!scores.length) throw new Error('no frame scores');
        stageUp('watching', 42 + (doneFrames / totalFrames) * 34, `AI watching frames (${Math.min(doneFrames, totalFrames)}/${totalFrames})`);
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
    const analyzed = analyze.filter((a) => !a.failed && a.scores && a.scores.length >= 3);
    if (!analyzed.length) throw new Error('The AI could not score any source video. Try running again.');

    /* 5 ─ Select highlight windows */
    stageUp('selecting', 78, 'Ranking highlight windows across all videos');
    let segments = selectSegments(analyzed, { clipCount, clipLength, interval });
    if (!segments.length) throw new Error('No highlight windows found for that clip length — try a shorter clip length.');
    if (segments.length < clipCount) log(`Only ${segments.length} of ${clipCount} clips available (sources too short)`);
    log(`Selected ${segments.length} highlight windows (avg score ${Math.round(segments.reduce((n, s) => n + s.score, 0) / segments.length)}/100)`);
    save();

    /* 6 ─ Cut clips with ffmpeg.wasm */
    stageUp('cutting', 84, `Cutting ${segments.length} clips`);
    const byId = new Map(analyzed.map((a) => [a.video.id, a]));
    const cut = [];
    for (let i = 0; i < segments.length; i += 1) {
      const seg = segments[i];
      const src = byId.get(seg.videoId);
      try {
        stageUp('cutting', 84 + ((i) / segments.length) * 12, `Cutting clip ${i + 1} of ${segments.length}`);
        const blob = await cutClip({
          videoBlob: src.blob, audioBlob: null, startSec: seg.startSec,
          span: seg.endSec - seg.startSec, aspect,
          onProgress: (p) => stageUp('cutting', 84 + ((i + p / 100) / segments.length) * 12, `Encoding clip ${i + 1} (${p}%)`),
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
    stageUp('cutting', 96, 'Writing titles and hooks');
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

/* Port of selectSegments — smoothed sliding-window ranking with per-video caps. */
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
      const score = Math.round(inside.reduce((n, s) => n + s.v, 0) / inside.length);
      const highlights = [...inside].sort((a, b) => b.score - a.score).slice(0, 3).map((s) => s.desc).filter(Boolean);
      all.push({ videoId: item.video.id, videoTitle: item.video.title, channel: item.video.channel,
        views: item.video.views, videoUrl: item.video.url, startSec: start, endSec: end, score, highlights, index: item.index });
    }
  }
  all.sort((a, b) => b.score - a.score);
  const caps = [1, 2, 3, Infinity];
  let best = [];
  for (const cap of caps) {
    const chosen = [];
    const perVideo = new Map();
    for (const cand of all) {
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
