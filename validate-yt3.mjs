/* Full chain check: search parse quality, ANDROID player on search results, adaptive URLs direct?, range fetch. */
const t0 = Date.now();
const stamp = () => `[${((Date.now() - t0) / 1000).toFixed(1)}s]`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const home = await (await fetch('https://www.youtube.com/', { headers: { 'User-Agent': UA } })).text();
const key = home.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1];

// --- search with robust extraction (fallback to ytInitialData-ish regex scan) ---
const s = await (await fetch(`https://www.youtube.com/youtubei/v1/search?key=${key}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
  body: JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion: '2.20251015.01.00' } }, query: 'funny animal moments' }),
})).json();

const found = new Map();
(function walk(o) {
  if (!o || typeof o !== 'object') return;
  if (o.videoRenderer?.videoId) {
    const v = o.videoRenderer;
    found.set(v.videoId, {
      id: v.videoId,
      title: v.title?.runs?.[0]?.text || '',
      len: v.lengthText?.simpleText || '',
      views: v.viewCountText?.simpleText || v.shortViewCountText?.simpleText || '',
      channel: v.ownerText?.runs?.[0]?.text || '',
    });
  }
  for (const k in o) walk(o[k]);
})(s);
console.log(stamp(), `search found ${found.size} videos`);
const list = [...found.values()];
list.slice(0, 5).forEach((v) => console.log('  -', v.title.slice(0, 55), '|', v.len, '|', v.views));

// --- player on each of the first 3 real results, ANDROID client ---
for (const v of list.slice(0, 3)) {
  const res = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${key}&prettyPrint=false`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip' },
    body: JSON.stringify({
      context: { client: { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 30 } },
      videoId: v.id, contentCheckOk: true, racyCheckOk: true,
    }),
  });
  const j = await res.json();
  const ps = j.playabilityStatus || {};
  const fmts = j.streamingData?.formats || [];
  const ad = j.streamingData?.adaptiveFormats || [];
  const directAd = ad.filter((f) => f.url);
  const cipherAd = ad.filter((f) => f.signatureCipher || f.cipher);
  console.log(stamp(), `${v.id} [${v.len}] status=${ps.status}${ps.reason ? ' ' + ps.reason : ''} prog=${fmts.length}(${fmts.filter(f=>f.url).length} direct) adaptive=${ad.length} (direct=${directAd.length}, ciphered=${cipherAd.length})`);
  if (ps.status === 'OK') {
    const itags = directAd.map((f) => `${f.itag}:${f.height || f.audioQuality?.slice(-3) || '?'}${f.mimeType?.startsWith('audio') ? '' : 'p'}`);
    console.log('   direct adaptive itags:', itags.join(' '));
    const video = directAd.filter((f) => f.height).sort((a, b) => b.height - a.height)[0];
    const audio = directAd.find((f) => !f.height && f.audioQuality);
    for (const [label, f] of [['video', video], ['audio', audio]]) {
      if (!f) { console.log(`   ${label}: none`); continue; }
      const r = await fetch(f.url, { headers: { 'User-Agent': 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip', Range: 'bytes=0-15' } });
      const b = Buffer.from(await r.arrayBuffer());
      console.log(`   ${label} itag=${f.itag} range-fetch: HTTP ${r.status} ${b.length}B`);
    }
  }
}
console.log(stamp(), 'done');
