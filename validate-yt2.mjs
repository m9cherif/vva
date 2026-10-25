/* Debug the Innertube player API: why status=ERROR? Try variants (params, clients, reason dump). */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const home = await (await fetch('https://www.youtube.com/', { headers: { 'User-Agent': UA } })).text();
const key = home.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1];
console.log('key:', key ? 'ok' : 'MISSING');

const videoId = 'dQw4w9WgXcQ';
const variants = [
  { name: 'ANDROID no-params', ctx: { client: { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 30 }, user: { lockedSafetyMode: false } }, ua: 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip', body: {} },
  { name: 'ANDROID params', ctx: { client: { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 30 }, user: { lockedSafetyMode: false } }, ua: 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip', body: { params: 'CgIQBg==' } },
  { name: 'IOS plain', ctx: { client: { clientName: 'IOS', clientVersion: '20.10.4', deviceMake: 'Apple', deviceModel: 'iPhone16,2' }, user: { lockedSafetyMode: false } }, ua: 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 17_5 like Mac OS X;)', body: {} },
  { name: 'TVHTML5 plain', ctx: { client: { clientName: 'TVHTML5', clientVersion: '7.20250316.16.00' }, user: { lockedSafetyMode: false } }, ua: 'Mozilla/5.0 (ChromiumStylePlatform) Cobalt/Version', body: {} },
  { name: 'WEB plain', ctx: { client: { clientName: 'WEB', clientVersion: '2.20251015.01.00' }, user: { lockedSafetyMode: false } }, ua: UA, body: {} },
  { name: 'MWEB plain', ctx: { client: { clientName: 'MWEB', clientVersion: '2.20251015.01.00' }, user: { lockedSafetyMode: false } }, ua: UA, body: {} },
];

for (const v of variants) {
  try {
    const res = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${key}&prettyPrint=false`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': v.ua, 'X-Youtube-Client-Name': '1', 'X-Youtube-Client-Version': v.ctx.client.clientVersion },
      body: JSON.stringify({ context: v.ctx, videoId, contentCheckOk: true, racyCheckOk: true, ...v.body }),
    });
    const j = await res.json();
    const ps = j.playabilityStatus || {};
    const fmts = j.streamingData?.formats || [];
    const direct = fmts.filter((f) => f.url);
    const ad = j.streamingData?.adaptiveFormats || [];
    console.log(`${v.name}: http=${res.status} status=${ps.status} reason=${JSON.stringify(ps.reason || ps.messages || '')} prog=${fmts.length} direct=${direct.length} adaptive=${ad.length}`);
    if (ps.status === 'OK') {
      const best = [...fmts].sort((a, b) => (b.height || 0) - (a.height || 0))[0];
      console.log('   best:', best?.itag, `${best?.width}x${best?.height}`, 'url?', !!best?.url, 'cipher?', !!(best?.signatureCipher || best?.cipher));
      if (best?.url) {
        const r = await fetch(best.url, { headers: { 'User-Agent': v.ua, Range: 'bytes=0-63' } });
        const b = Buffer.from(await r.arrayBuffer());
        console.log('   fetch:', r.status, b.length, 'bytes; ftyp?', b.slice(4, 8).toString() === 'ftyp');
      }
    }
  } catch (e) {
    console.log(`${v.name}: ERROR ${String(e).slice(0, 120)}`);
  }
}
