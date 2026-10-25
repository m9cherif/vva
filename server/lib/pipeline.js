import fs from 'node:fs';
import path from 'node:path';
import { config, limits } from '../config.js';
import { downloadSection, probeDuration } from './ytdlp.js';
import { researchSources } from './agent.js';
import { extractFrames, cutClip, rmrf } from './media.js';
import { scoreFrames, generateCopy } from './nvidia.js';
import { emit, log, stage, saveJob } from './jobs.js';

/**
 * Full pipeline for one job:
 * 1. AI agent researches the category: writes its own queries, inspects the covers and
 *    metadata, keeps/drops candidates and searches again until it has enough sources.
 * 2. Download its picks -> 3. sample frames -> 4. vision model watches every frame
 * -> 5. rank highlight windows -> 6. cut clips -> 7. package them (title, hook, caption, tags).
 */
export async function runJob(job) {
  const { category, clipCount, clipLength, sourceCount, windowSeconds, quality, aspect } = job.params;
  const interval = limits.frameIntervalSec;
  const jobDir = path.join(config.workspace, job.id);
  fs.mkdirSync(jobDir, { recursive: true });

  const analyze = []; // per-video work items, kept after cutting for cleanup

  try {
    job.status = 'running';

    /* 1 ─ AI research --------------------------------------------------- */
    stage(job, 'searching', 4, `AI agent is researching ${category} videos`);
    let turn = 0;
    const { videos: sources } = await researchSources({
      category,
      need: sourceCount,
      minDuration: clipLength + 10,
      log: (text) => {
        turn += 1;
        log(job, text);
        stage(job, 'searching', Math.min(9, 4 + turn * 0.35), 'AI agent researching sources');
      },
    });
    if (!sources.length) throw new Error(`No downloadable videos found for "${category}". Try another category.`);

    sources.forEach((v, i) => {
      job.sources.push({
        id: v.id,
        title: v.title,
        channel: v.channel,
        views: v.views,
        duration: v.duration,
        url: v.url,
        thumb: v.thumb,
        status: 'queued',
        percent: 0,
      });
      log(job, `#${i + 1} ${v.title} — ${formatViews(v.views)} views`);
    });

    /* 2 ─ Fetch footage --------------------------------------------------
     * The network tops out around 135 KB/s, so nothing ever downloads whole.
     * We pull the analysis window (360p is plenty — frames are sampled at 384px),
     * and only if that is cheaper do we re-fetch each clip at full quality. */
    const totalClipSecs = clipCount * clipLength;
    const perClipFetch = totalClipSecs < windowSeconds * limits.perClipFetchRatio;
    const analysisHeight = perClipFetch ? limits.analysisHeight : quality;

    stage(job, 'downloading', 10, `Fetching ${sources.length} analysis windows`);
    log(
      job,
      perClipFetch
        ? `Downloading ${windowSeconds}s of each video at ${analysisHeight}p for analysis (clips get their own full-quality fetch)`
        : `Downloading ${windowSeconds}s of each video at ${quality}p — enough for analysis and every clip`
    );

    const downloads = await mapPool(sources, 2, async (video, idx) => {
      const entry = job.sources[idx];
      entry.status = 'downloading';
      emit(job, 'source', { source: publicSource(entry) });
      try {
        const { file, bytes } = await downloadSection(video, jobDir, {
          startSec: 0,
          durationSec: windowSeconds,
          height: analysisHeight,
          tag: 'src',
          onProgress: (pct) => {
            if (pct === entry.percent) return;
            entry.percent = pct;
            emit(job, 'source', { source: publicSource(entry) });
          },
        });
        const full = await probeDuration(file);
        // Only the first `windowSeconds` is analysed; selection never looks past it.
        const duration = Math.min(full || windowSeconds, windowSeconds);
        entry.status = 'downloaded';
        entry.percent = 100;
        entry.localDuration = duration;
        emit(job, 'source', { source: publicSource(entry) });
        log(
          job,
          `Ready "${video.title}" — ${duration.toFixed(0)}s window, ${(bytes / 1048576).toFixed(1)} MB at ${analysisHeight}p`
        );
        return { video, file, duration, index: idx };
      } catch (err) {
        entry.status = 'failed';
        emit(job, 'source', { source: publicSource(entry) });
        log(job, `Skipped "${video.title}" — ${String(err.message || err).slice(0, 160)}`);
        return null;
      } finally {
        const done = job.sources.filter((s) => s.status === 'downloaded' || s.status === 'failed').length;
        stage(job, 'downloading', 10 + (done / sources.length) * 20, 'Downloading source footage');
      }
    });

    const ready = downloads.filter(Boolean);
    if (!ready.length) {
      throw new Error('All source downloads failed — YouTube may be rate-limiting this network. Retry in a minute.');
    }
    log(job, `${ready.length}/${sources.length} videos ready for analysis`);

    /* 3 ─ Sample frames -------------------------------------------------- */
    stage(job, 'downloading', 32, 'Sampling frames from every video');
    for (const item of ready) {
      const framesDir = path.join(jobDir, `frames_${item.video.id}`);
      const { count, files } = await extractFrames(item.file, framesDir, interval, limits.frameWidth, item.duration);
      item.frames = files.map((name, i) => ({ t: i * interval, file: path.join(framesDir, name) }));
      item.frameCount = count;
      log(job, `Sampled ${count} frames from "${item.video.title}" (every ${interval}s)`);
      analyze.push(item);
    }

    /* 4 ─ Vision model watches each video --------------------------------- */
    stage(job, 'watching', 42, 'AI vision model is watching every frame');
    const totalFrames = analyze.reduce((n, a) => n + a.frames.length, 0);
    let scoredFrames = 0;

    await mapPool(analyze, 2, async (item) => {
      try {
        const { scores, model } = await scoreFrames(item.frames, {
          interval,
          videoTitle: item.video.title,
          onWarn: (msg) => log(job, `⚠ ${String(msg).slice(0, 150)}`),
          onBatch: (b) => {
            if (b.model && !job.model) {
              job.model = b.model;
              log(job, `Vision model in use: ${b.model}`);
            }
            scoredFrames += b.done;
            const pct = 42 + (scoredFrames / totalFrames) * 34;
            stage(job, 'watching', pct, `AI watching frames (${scoredFrames}/${totalFrames})`);
          },
        });
        item.scores = scores;
        item.best = scores.reduce((m, s) => Math.max(m, s.score), 0);
        item.avg = Math.round(scores.reduce((n, s) => n + s.score, 0) / scores.length);
        log(job, `"${item.video.title}" — peak virality ${item.best}/100, average ${item.avg}/100`);
        emit(job, 'source', {
          source: {
            ...publicSource(job.sources[item.index]),
            status: 'watched',
            peakScore: item.best,
            avgScore: item.avg,
          },
        });
      } catch (err) {
        item.failed = true;
        log(job, `Analysis failed for "${item.video.title}" — ${String(err.message || err).slice(0, 200)}`);
      }
    });

    const analyzed = analyze.filter((a) => !a.failed && a.scores && a.scores.length >= 3);
    if (!analyzed.length) throw new Error('The AI could not score any source video. Try running again.');

    /* 5 ─ Pick the best highlight windows --------------------------------- */
    stage(job, 'selecting', 78, 'Ranking highlight windows across all videos');
    let segments = selectSegments(analyzed, { clipCount, clipLength, interval });
    if (!segments.length) {
      throw new Error('No highlight windows found for that clip length — try a shorter clip length.');
    }
    if (segments.length < clipCount) {
      log(job, `Only ${segments.length} of ${clipCount} clips available (sources too short)`);
    }
    log(job, `Selected ${segments.length} highlight windows (avg score ${Math.round(
      segments.reduce((n, s) => n + s.score, 0) / segments.length
    )}/100)`);

    /* 6 ─ Cut the clips --------------------------------------------------- */
    const videoById = new Map(ready.map((r) => [r.video.id, r.video]));
    stage(job, 'cutting', 84, `Cutting ${segments.length} clips`);

    // Fetch every highlight's full-quality footage first (in parallel — bandwidth is the
    // bottleneck), then encode. Falls back to the analysis copy if a fetch fails.
    const fetchPct = segments.map(() => 0);
    const footage = await mapPool(segments, 2, async (seg, i) => {
      const span0 = seg.endSec - seg.startSec;
      if (!perClipFetch || !videoById.has(seg.videoId)) return null;
      const report = (pct) => {
        fetchPct[i] = pct;
        const avg = fetchPct.reduce((n, v) => n + v, 0) / segments.length;
        stage(job, 'cutting', 84 + (avg / 100) * 11, `Fetching clip ${i + 1} at ${quality}p (${Math.round(avg)}%)`);
      };
      try {
        const { file, bytes } = await downloadSection(videoById.get(seg.videoId), jobDir, {
          startSec: seg.startSec,
          durationSec: span0,
          height: quality,
          tag: `hi${i}`,
          onProgress: report,
        });
        const local = await probeDuration(file);
        log(job, `Clip ${i + 1} footage ready — ${(bytes / 1048576).toFixed(1)} MB at ${quality}p`);
        return { file, span: local > 1 ? Math.min(span0, local) : span0 };
      } catch (err) {
        log(
          job,
          `Clip ${i + 1} full-quality fetch failed (${String(err.message || err).slice(0, 90)}) — rendering from the ${limits.analysisHeight}p analysis copy`
        );
        return null;
      }
    });

    const cut = [];
    for (let i = 0; i < segments.length; i += 1) {
      const seg = segments[i];
      const name = `clip_${String(i + 1).padStart(2, '0')}.mp4`;
      const hi = footage[i];
      const src = hi ? hi.file : seg.srcFile;
      const offset = hi ? 0 : seg.startSec;
      const span = hi ? hi.span : seg.endSec - seg.startSec;

      try {
        await cutClip(src, path.join(jobDir, name), offset, span, aspect);
        cut.push({ ...seg, name });

        const partial = toClip(job, seg, name, i + 1, null);
        job.clips.push(partial);
        emit(job, 'clip-ready', { clip: partial });
        emit(job, 'clip-progress', { done: i + 1, total: segments.length });
        stage(job, 'cutting', 84 + ((i + 1) / segments.length) * 11, `Cutting clip ${i + 1} of ${segments.length}`);
      } catch (err) {
        log(job, `Clip ${i + 1} failed to render — ${String(err.message || err).slice(0, 160)}`);
      }
    }
    if (!cut.length) throw new Error('ffmpeg could not render any clips.');

    /* 7 ─ Titles + hooks --------------------------------------------------- */
    stage(job, 'cutting', 96, 'Writing titles and hooks');
    const copy = await generateCopy(
      cut.map((c) => ({
        videoTitle: c.videoTitle,
        channel: c.channel,
        startSec: c.startSec,
        endSec: c.endSec,
        highlights: c.highlights,
      })),
      (msg) => log(job, `⚠ ${String(msg).slice(0, 150)}`)
    );

    const byIndex = new Map();
    if (Array.isArray(copy)) {
      for (const c of copy) {
        const n = Number(c?.index);
        if (Number.isFinite(n)) byIndex.set(n, c);
      }
    }
    job.clips = cut.map((c, i) => toClip(job, c, c.name, i + 1, byIndex.get(i + 1) || null));

    /* 8 ─ Finish ------------------------------------------------------------ */
    cleanupSources(jobDir);
    job.status = 'done';
    job.finishedAt = Date.now();
    stage(job, 'done', 100, `${job.clips.length} clips ready`);
    log(job, `Done — ${job.clips.length} clip${job.clips.length === 1 ? '' : 's'} ready to preview`);
    saveJob(job);
    emit(job, 'result', { clips: job.clips, model: job.model, sources: job.sources.map(publicSource) });
  } catch (err) {
    job.status = 'error';
    job.error = String(err?.message || err);
    stage(job, 'error', job.percent, job.error);
    log(job, `ERROR: ${job.error}`);
    saveJob(job);
    emit(job, 'error', { message: job.error });
  }
}

/* ── selection ─────────────────────────────────────────────────────────── */

function selectSegments(analyzed, { clipCount, clipLength, interval }) {
  const all = [];
  for (const item of analyzed) {
    const scores = item.scores;
    const maxStart = item.duration || windowEnd(scores, interval);
    const smoothed = scores.map((s, i) => ({
      ...s,
      v: 0.5 * s.score + 0.3 * (scores[i - 1]?.score ?? s.score) + 0.2 * (scores[i + 1]?.score ?? s.score),
    }));

    for (const head of smoothed) {
      const start = Math.max(0, head.t);
      const end = start + clipLength;
      if (end > maxStart) continue; // would run past the analyzed footage
      const inside = smoothed.filter((s) => s.t >= start && s.t < end);
      if (inside.length === 0) continue;
      const score = Math.round(inside.reduce((n, s) => n + s.v, 0) / inside.length);
      const highlights = [...inside]
        .sort((a, b) => b.score - a.score)
        .slice(0, 3)
        .map((s) => s.desc)
        .filter(Boolean);
      all.push({
        videoId: item.video.id,
        videoTitle: item.video.title,
        channel: item.video.channel,
        views: item.video.views,
        videoUrl: item.video.url,
        srcFile: item.file,
        startSec: start,
        endSec: end,
        score,
        highlights,
        index: item.index,
      });
    }
  }

  all.sort((a, b) => b.score - a.score);

  // Progressive per-video caps: spread picks across sources first, then deepen.
  const caps = [1, 2, 3, Number.POSITIVE_INFINITY];
  let best = [];
  for (const cap of caps) {
    const chosen = [];
    const perVideo = new Map();
    for (const cand of all) {
      if (chosen.length >= clipCount) break;
      const n = perVideo.get(cand.videoId) || 0;
      if (n >= cap) continue;
      const clash = chosen.some(
        (c) => c.videoId === cand.videoId && Math.abs(c.startSec - cand.startSec) < clipLength * 0.75
      );
      if (clash) continue;
      perVideo.set(cand.videoId, n + 1);
      chosen.push(cand);
    }
    best = chosen;
    if (chosen.length >= clipCount) break;
  }
  return best.sort((a, b) => a.startSec - b.startSec);
}

function windowEnd(scores, interval) {
  return scores[scores.length - 1].t + interval;
}

/* ── helpers ───────────────────────────────────────────────────────────── */

async function mapPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const lanes = new Array(Math.min(concurrency, items.length)).fill(null).map(async () => {
    while (cursor < items.length) {
      const i = cursor;
      cursor += 1;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(lanes);
  return results;
}

function publicSource(entry) {
  return {
    id: entry.id,
    title: entry.title,
    channel: entry.channel,
    views: entry.views,
    duration: entry.duration,
    url: entry.url,
    thumb: entry.thumb,
    status: entry.status,
    percent: entry.percent,
    peakScore: entry.peakScore ?? null,
    avgScore: entry.avgScore ?? null,
  };
}

function cleanupSources(jobDir) {
  // Keep the rendered clips; everything else in the job folder (analysis windows,
  // full-quality fetches, frames, half-finished .part files) is disposable.
  for (const name of fs.existsSync(jobDir) ? fs.readdirSync(jobDir) : []) {
    if (/^clip_\d+\.mp4$/i.test(name) || name === 'job.json') continue;
    rmrf(path.join(jobDir, name));
  }
}

function toClip(job, segment, name, index, copy) {
  const hashtags = Array.isArray(copy?.hashtags)
    ? copy.hashtags.filter((h) => typeof h === 'string' && h.trim()).slice(0, 7).map((h) => (h.startsWith('#') ? h : `#${h}`))
    : [];
  return {
    id: `${job.id}-${index}`,
    index,
    title: copy?.title || fallbackTitle(segment),
    hook: copy?.hook || segment.highlights?.[0] || `Highlight from ${segment.videoTitle}`,
    caption: copy?.caption || copy?.hook || '',
    hashtags,
    score: segment.score,
    aspect: job.params.aspect || '16:9',
    startSec: round1(segment.startSec),
    endSec: round1(segment.endSec),
    duration: round1(segment.endSec - segment.startSec),
    videoTitle: segment.videoTitle,
    channel: segment.channel,
    views: segment.views,
    sourceUrl: segment.videoUrl,
    file: `/clips/${job.id}/${name}`,
  };
}

function fallbackTitle(segment) {
  const base = segment.videoTitle.replace(/\s*[-|–]\s*YouTube$/i, '').slice(0, 50);
  return `${base} — ${fmtClock(segment.startSec)} highlight`;
}

function fmtClock(sec) {
  const s = Math.max(0, Math.round(sec));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function formatViews(n) {
  if (!n) return '0';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

function round1(n) {
  return Math.round(n * 10) / 10;
}
