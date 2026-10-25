# 🎬 ViralClips AI

Pick a video category → an AI vision model **watches the videos frame by frame** → it ranks the
viral moments → you get **as many cut clips as you want**, titled and ready to download.

No build step, no framework, no npm dependencies. Node serves the site, Python's `yt-dlp`
finds and downloads the source videos, ffmpeg samples the frames and cuts the clips, and an
NVIDIA NIM vision model does the actual "watching".

## Run it

```bash
cd viral-clips-studio
node server/index.js
# → http://127.0.0.1:3000
```

Requirements (already installed on this machine):

| Piece   | Where it comes from                                          |
| ------- | ------------------------------------------------------------ |
| Node 18+ | system                                                     |
| yt-dlp  | `pip install yt-dlp` (called as `python -m yt_dlp`)        |
| ffmpeg  | bundled at `bin/ffmpeg.exe`                                 |
| API key | `.env` → `NVIDIA_API_KEY`                                   |

## How it works

1. **Research (agentic)** — an AI research agent drives the hunt instead of a fixed query. Each
   turn it gets the current state plus candidate videos *with their covers (thumbnails)*, title,
   channel, duration and view count. It **keeps** the good ones, **drops** the irrelevant ones,
   and issues **new, sharper searches** (sub-niches, events, creator styles) until it has enough
   sources or the search budget runs out. Every decision is logged in the UI console.
2. **Download (section-based)** — nothing is ever downloaded whole. yt-dlp asks ffmpeg to pull only
   the analysis window (the first 60–240s, at 360p — frames are sampled at 384px, so that is all the
   AI needs to watch), then each chosen highlight is fetched *again* at full quality right before it is
   cut — a few MB per clip instead of a 160 MB source video. On this host (~135 KB/s from YouTube) that
   is the difference between a job that never finishes and one that finishes in minutes. Python does the
   fetching behind an IPv4-only shim because this machine's IPv6 route is broken; if the section route
   fails outright there is a full-download fallback for short sources.
3. **Sample** — ffmpeg extracts one frame every 6 seconds (384px wide) from the analysis window
   (the first 60–240s of each video, so runs stay fast).
4. **Watch** — frames are sent in batches to a vision-language model
   (`nvidia/nemotron-3.5-super-vl-120b-a12b`, with automatic fallback to other vision models in
   `.env`) which returns, for **every frame**: a short description and a viral score 0–100.
5. **Select** — scores are smoothed over neighbouring frames, then every sliding window of the
   requested clip length is scored. Windows are picked greedily with diversity caps so clips are
   spread across different source videos and never overlap.
6. **Cut** — ffmpeg re-encodes each window to h264/aac mp4 with `+faststart`, re-framed to your
   chosen format: 16:9, 9:16 vertical (1080×1920) or 1:1 square (1080×1080).
7. **Package** — the model writes a title, a hook, a ready-to-post caption and hashtags for every clip.

Progress is streamed to the browser over Server-Sent Events: stage stepper, per-video status with
**live download percentages**, a live research log, and cards appearing the moment each clip finishes
rendering. Finished runs are written to `workspace/<jobId>/job.json`, so results survive a server
restart and can be reopened any time from the **Recent runs** panel on the home page.

## Configuration (`.env`)

```dotenv
NVIDIA_API_KEY=nvapi-...            # NVIDIA NIM key
NVIDIA_API_BASE=https://integrate.api.nvidia.com/v1
VISION_MODELS=nvidia/nemotron-3.5-super-vl-120b-a12b,meta/muse-glimmer-30b,nvidia/nemotron-3-nano-omni-30b-a3b-reasoning,meta/llama-3.2-90b-vision-instruct
PORT=3000
HOST=127.0.0.1
```

Models are tried in order; a 404/5xx on one moves to the next automatically.

## API

| Method | Path                      | Purpose                                    |
| ------ | ------------------------- | ------------------------------------------ |
| GET    | `/api/categories`         | preset categories + slider limits          |
| POST   | `/api/generate`           | `{category, clipCount, clipLength, sourceCount, windowSeconds, quality, aspect}` → `{jobId}` |
| GET    | `/api/jobs`               | recent runs (newest first, max 12)         |
| GET    | `/api/jobs/:id`           | job snapshot                               |
| GET    | `/api/jobs/:id/events`    | SSE stream (`stage`, `log`, `source`, `clip-ready`, `result`, `error`) |
| GET    | `/clips/:jobId/:file`     | rendered clip (HTTP Range supported)       |

`node smoke.mjs "Category" [clips] [length]` runs the whole pipeline from the terminal.

## Files

```
server/index.js        HTTP server, static files, Range requests, SSE, run history
server/lib/pipeline.js the 8-stage orchestration + highlight selection algorithm
server/lib/agent.js    autonomous research agent (own queries, cover judging, keep/drop)
server/lib/nvidia.js   vision API client (batching, JSON parsing, model fallback)
server/lib/ytdlp.js    YouTube search + section downloads with progress
server/lib/media.js    ffmpeg frame sampling + clip cutting
server/lib/jobs.js     job store, event bus, on-disk persistence
public/                single-page UI (vanilla JS)
workspace/<jobId>/     job.json + rendered clips (analysis footage is deleted after cutting)
```

> Source videos are downloaded for analysis. Only use this for content you have the right to
> process, and respect YouTube's Terms of Service.
