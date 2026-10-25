# ViralClips Studio — API layer (PHP)

Every endpoint is a standalone file; no framework, no routing rules needed.

| endpoint | method | purpose |
|---|---|---|
| `categories.php` | GET | category chips + pipeline limits (mirrors `server/config.js`) |
| `search.php` | POST | YouTube search via Innertube (no API key, no yt-dlp) |
| `player.php` | POST | resolve DIRECT stream URLs via Innertube ANDROID client + byte sizes |
| `range.php` | GET | byte-range relay from the YouTube CDN (CORS + keeps each request short) |
| `ai.php` | POST | NVIDIA NIM proxy with the same model-fallback chain as `server/lib/nvidia.js` |
| `jobs.php` | GET/PUT/DELETE | job state persistence (`data/jobs/<id>/job.json`) |
| `upload.php` | POST | store a clip rendered by ffmpeg.wasm in the browser |
| `serve.php` | GET | stream a stored clip with HTTP Range support |

`_bootstrap.php` holds `.env` loading, config, limits, JSON helpers, the HTTP
client (cURL with a stream-wrapper fallback), Innertube helpers and the CDN
host allow-list used to prevent SSRF through `range.php`.
