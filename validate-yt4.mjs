/* Probe YouTube MP4 atom layout: is moov at the front (faststart) or after mdat?
 * Fetches first 512KB of an adaptive (itag 137) and progressive (itag 18) stream. */
const UA = 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip';
const home = await (await fetch('https://www.youtube.com/', { headers: { 'User-Agent': 'Mozilla/5.0' } })).text();
const key = home.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1];

const j = await (await fetch(`https://www.youtube.com/youtubei/v1/player?key=${key}&prettyPrint=false`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
  body: JSON.stringify({
    context: { client: { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 30 } },
    videoId: 'iq79hnuTyjc', contentCheckOk: true, racyCheckOk: true,
  }),
})).json();

const pick = (itag) => (j.streamingData.adaptiveFormats || []).concat(j.streamingData.formats || []).find((f) => f.itag === itag);

function atoms(buf, upTo) {
  const out = [];
  let off = 0;
  while (off + 8 <= Math.min(buf.length, upTo)) {
    const size = buf.readUInt32BE(off);
    const type = buf.slice(off + 4, off + 8).toString('latin1');
    if (size < 8 || size > 2e9) break;
    out.push(`${type}@${off}${size === 1 ? '(large)' : ''}`);
    if (size === 1) break; // 64-bit size; stop after header for safety
    off += size;
  }
  return out.join(' ');
}

for (const itag of [137, 18, 136]) {
  const f = pick(itag);
  if (!f?.url) { console.log(`itag ${itag}: no direct url`); continue; }
  const r = await fetch(f.url, { headers: { 'User-Agent': UA, Range: 'bytes=0-524287' } });
  const b = Buffer.from(await r.arrayBuffer());
  const ct = r.headers.get('content-range') || '';
  console.log(`itag ${itag}: http=${r.status} got=${b.length} ${ct} sizeHint`);
  console.log(`   top-level atoms in first 512KB: ${atoms(b, b.length)}`);
  // contentLength / target duration from format metadata
  console.log(`   contentLength=${f.contentLength} quality=${f.quality} fps=${f.fps || '-'} bitrate=${f.bitrate || '-'}`);
}

// also: what does contentLength look like for best video/audio itags (download size estimate)?
const ad = j.streamingData.adaptiveFormats || [];
for (const itag of [137, 140, 251, 136, 22]) {
  const f = ad.find((x) => x.itag === itag) || (j.streamingData.formats || []).find((x) => x.itag === itag);
  if (f) console.log(`itag ${itag}: ${f.contentLength} bytes, ${f.mimeType?.slice(0, 50)}`);
}
