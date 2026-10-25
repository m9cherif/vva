/* Validate the no-yt-dlp YouTube approach: Innertube search + player API (mobile clients)
 * returning DIRECT stream URLs (no signature decipher needed). Run before porting to PHP. */
const t0 = Date.now();
const stamp = () => `[${((Date.now() - t0) / 1000).toFixed(1)}s]`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const guard = setTimeout(() => { console.log(stamp(), 'TIMEOUT 90s'); process.exit(2); }, 90_000);

async function post(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.json();
}

try {
  // 1. public Innertube key from the homepage
  const home = await (await fetch('https://www.youtube.com/', { headers: { 'User-Agent': UA } })).text();
  const key = home.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1];
  console.log(stamp(), key ? `innertube key ok (${key.slice(0, 8)}…)` : 'NO INNERTUBE KEY');
  const ctx = (clientName, clientVersion, extra = {}) => ({
    client: { clientName, clientVersion, ...extra },
    user: { lockedSafetyMode: false },
  });

  // 2. search (no API key)
  const s = await post(`https://www.youtube.com/youtubei/v1/search?key=${key}`, {
    context: ctx('WEB', '2.20251015.01.00'),
    query: 'gaming clutch moments short',
  });
  const items = s?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents
    ?.flatMap((c) => c.itemSectionRenderer?.contents || [])
    ?.map((r) => r.videoRenderer)
    ?.filter(Boolean) || [];
  console.log(stamp(), `search: ${items.length} videos`);
  for (const v of items.slice(0, 4)) {
    const views = v.viewCountText?.simpleText || v.shortViewCountText?.simpleText || '?';
    console.log('   -', (v.title?.runs?.[0]?.text || '').slice(0, 60), '|', v.lengthText?.simpleText || 'live', '|', views);
  }

  // 3. player API with mobile/TV clients -> direct URLs?
  const testId = items.find((v) => v.lengthText?.simpleText)?.videoId || 'dQw4w9WgXcQ';
  console.log(stamp(), `player for ${testId}`);
  const clients = [
    ['ANDROID', '20.10.38', { androidSdkVersion: 30, userAgent: 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip' }],
    ['IOS', '20.10.4', { deviceMake: 'Apple', deviceModel: 'iPhone16,2', userAgent: 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 17_5 like Mac OS X;)' }],
    ['TVHTML5', '7.20250316.16.00', { userAgent: 'Mozilla/5.0 (ChromiumStylePlatform) Cobalt/Version' }],
    ['MWEB', '2.20251015.01.00', {}],
  ];
  for (const [name, ver, extra] of clients) {
    try {
      const p = await post(`https://www.youtube.com/youtubei/v1/player?key=${key}`, {
        context: ctx(name, ver, extra),
        videoId: testId,
        contentCheckOk: true,
        racyCheckOk: true,
        params: 'CgIQBg==',
      }, extra.userAgent ? { 'User-Agent': extra.userAgent } : {});
      const sd = p.playabilityStatus?.status;
      const fmts = p.streamingData?.formats || [];          // progressive (video+audio)
      const adaptive = p.streamingData?.adaptiveFormats || [];
      const direct = fmts.filter((f) => f.url);
      const ciphered = fmts.filter((f) => f.signatureCipher || f.cipher);
      console.log(
        stamp(),
        `${name}: status=${sd} progressive=${fmts.length} direct=${direct.length} ciphered=${ciphered.length} adaptive=${adaptive.length}`
      );
      if (direct.length) {
        const f = direct.sort((a, b) => (b.height || 0) - (a.height || 0))[0];
        console.log(`    best direct: itag=${f.itag} ${f.width}x${f.height} ${f.mimeType?.slice(0, 40)}`);
        // 4. can we actually fetch bytes?
        const r = await fetch(f.url, { headers: { 'User-Agent': extra.userAgent || UA, Range: 'bytes=0-1023' } });
        const buf = Buffer.from(await r.arrayBuffer());
        console.log(`    fetch: HTTP ${r.status} got ${buf.length} bytes, ftyp? ${buf.slice(4, 8).toString() === 'ftyp'}`);
        if (r.status === 206 || r.status === 200) {
          console.log(stamp(), 'RESULT: direct-download chain WORKS');
          clearTimeout(guard);
          process.exit(0);
        }
      }
    } catch (err) {
      console.log(stamp(), `${name}: ERROR ${String(err).slice(0, 100)}`);
    }
  }
  console.log(stamp(), 'RESULT: no client returned a direct URL');
  clearTimeout(guard);
  process.exit(1);
} catch (err) {
  console.log(stamp(), 'FAILED:', String(err).slice(0, 300));
  clearTimeout(guard);
  process.exit(1);
}
