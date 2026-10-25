/* MP4 box parsing — just enough to turn a TIME into a BYTE RANGE.
 *
 * YouTube's adaptive streams are fragmented MP4 with a `sidx` box right after
 * `moov`: it lists every fragment's byte size and duration. That lets the
 * browser download exactly the prefix covering an analysis window (or a clip)
 * instead of a 459 MB whole file. If a stream has no sidx we fall back to a
 * bitrate estimate from contentLength.
 */

/** Parse top-level boxes from a header buffer. Returns [{type, offset, size, headerSize}]. */
export function topLevelBoxes(buf, start = 0, end = buf.byteLength) {
  const view = new DataView(buf);
  const out = [];
  let off = start;
  while (off + 8 <= end) {
    let size = view.getUint32(off);
    const type = String.fromCharCode(view.getUint8(off + 4), view.getUint8(off + 5), view.getUint8(off + 6), view.getUint8(off + 7));
    let headerSize = 8;
    if (size === 1) {                       // 64-bit largesize
      const hi = view.getUint32(off + 8);
      const lo = view.getUint32(off + 12);
      size = hi * 4294967296 + lo;
      headerSize = 16;
    } else if (size === 0) {                // box extends to end of file
      size = end - off;
    }
    if (size < headerSize || off + size > end + 1) break; // truncated / corrupt
    out.push({ type, offset: off, size, headerSize });
    off += size;
  }
  return out;
}

/** Parse a sidx box → { segStart, firstOffset, timescale, segments: [{byteSize, startTime, duration}] }. */
export function parseSidx(buf, box) {
  const view = new DataView(buf);
  let p = box.offset + box.headerSize;
  const version = view.getUint8(p);
  p += 4;                                   // version + flags
  p += 4;                                   // reference_ID
  const timescale = view.getUint32(p); p += 4;
  let earliest;
  let firstOffset;
  if (version === 0) {
    earliest = view.getUint32(p); p += 4;
    firstOffset = view.getUint32(p); p += 4;
  } else {
    earliest = Number(view.getBigUint64(p)); p += 8;
    firstOffset = Number(view.getBigUint64(p)); p += 8;
  }
  p += 2;                                   // reserved
  const refCount = view.getUint16(p); p += 2;

  const segments = [];
  let time = earliest / timescale;
  for (let i = 0; i < refCount && p + 12 <= buf.byteLength; i += 1) {
    const word = view.getUint32(p); p += 4;
    const byteSize = word & 0x7fffffff;     // top bit is reference_type (0 = media)
    const duration = view.getUint32(p); p += 4;
    p += 4;                                 // SAP fields (not needed)
    segments.push({ byteSize, startTime: time, duration: duration / timescale });
    time += duration / timescale;
  }
  return { earliest: earliest / timescale, firstOffset, timescale, segments };
}

/**
 * Work out which bytes of a stream cover [0, windowSec].
 *
 * @param {ArrayBuffer} header  first `headerBytes` of the stream
 * @param {number} totalSize    full stream size in bytes
 * @param {number} durationSec  full stream duration
 * @param {number} windowSec    seconds of prefix we need
 * @param {number} headerBytes  how many bytes were fetched into `header`
 * @returns {{ endByte: number, boundaryOk: boolean, method: string }}
 */
export function planPrefix(header, totalSize, durationSec, windowSec, headerBytes) {
  const boxes = topLevelBoxes(header);
  const sidxBox = boxes.find((b) => b.type === 'sidx');
  const moovBox = boxes.find((b) => b.type === 'moov');

  if (sidxBox && sidxBox.offset + sidxBox.size <= headerBytes) {
    try {
      const sidx = parseSidx(header, sidxBox);
      const sidxEnd = sidxBox.offset + sidxBox.size;
      let acc = sidxEnd + sidxFirstOffset(sidx);
      let lastCovered = 0;
      for (const seg of sidx.segments) {
        if (seg.startTime >= windowSec) break;
        acc += seg.byteSize;
        lastCovered = seg.startTime + seg.duration;
      }
      if (acc > 0 && acc <= totalSize) {
        return { endByte: Math.min(acc, totalSize), boundaryOk: lastCovered >= windowSec, method: 'sidx' };
      }
    } catch { /* fall through to estimate */ }
  }

  // No usable sidx: proportional estimate with a 12% safety margin.
  const ratio = durationSec > 0 ? Math.min(1, (windowSec / durationSec) * 1.12) : 1;
  let endByte = Math.ceil(totalSize * ratio);
  // Never cut inside the header itself.
  const minEnd = Math.max(headerBytes, (moovBox ? moovBox.offset + moovBox.size : 0) + 4096);
  endByte = Math.max(endByte, Math.min(minEnd, totalSize));
  return { endByte: Math.min(endByte, totalSize), boundaryOk: false, method: 'estimate' };
}

function sidxFirstOffset(sidx) {
  return Number.isFinite(sidx.firstOffset) ? sidx.firstOffset : 0;
}
