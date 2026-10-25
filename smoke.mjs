/* End-to-end smoke test: start a job, stream SSE progress, print the outcome.
   Usage: node smoke.mjs [category] [clips] [lengthSeconds]
          node smoke.mjs --job <jobId>          (attach to an already-running job) */
const BASE = 'http://127.0.0.1:3000';
const args = process.argv.slice(2);
const jobAt = args.indexOf('--job');

const started = Date.now();
const stamp = () => `[${((Date.now() - started) / 1000).toFixed(1)}s]`;

let jobId = null;
if (jobAt !== -1) {
  jobId = args[jobAt + 1];
  console.log(stamp(), 'attaching to job', jobId);
} else {
  const params = {
    category: args[0] || 'Pets & Animals',
    clipCount: Number(args[1] || 2),
    clipLength: Number(args[2] || 15),
    sourceCount: 2,
    windowSeconds: 90,
  };
  const res = await fetch(`${BASE}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const init = await res.json();
  if (!res.ok) {
    console.error('FAILED TO START', init);
    process.exit(1);
  }
  jobId = init.jobId;
  console.log(stamp(), 'job', jobId, JSON.stringify(params));
}

const timer = setTimeout(() => {
  console.error(stamp(), 'TIMEOUT after 15 min');
  process.exit(2);
}, 15 * 60 * 1000);

const timeout = AbortSignal.timeout(16 * 60 * 1000);
const res = await fetch(`${BASE}/api/jobs/${jobId}/events`, { signal: timeout });
const reader = res.body.getReader();
const decoder = new TextDecoder();
let buffer = '';

for (;;) {
  const { value, done } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  let idx;
  while ((idx = buffer.indexOf('\n\n')) !== -1) {
    const chunk = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 2);
    const line = chunk.split('\n').find((l) => l.startsWith('data: '));
    if (!line) continue;
    let ev;
    try {
      ev = JSON.parse(line.slice(6));
    } catch {
      continue;
    }
    if (ev.type === 'log') console.log(stamp(), ev.text);
    else if (ev.type === 'stage') console.log(stamp(), `stage=${ev.stage} ${ev.percent}% ${ev.message}`);
    else if (ev.type === 'clip-ready') console.log(stamp(), `clip ${ev.clip.index}: ${ev.clip.title} (${ev.clip.duration}s @ ${ev.clip.score})`);
    else if (ev.type === 'result') {
      console.log(stamp(), 'DONE. model=', ev.model, 'clips=', ev.clips.length);
      for (const c of ev.clips) console.log(`  #${c.index} "${c.title}" score=${c.score} ${c.duration}s ${c.file}`);
      clearTimeout(timer);
      process.exit(0);
    } else if (ev.type === 'error') {
      console.error(stamp(), 'JOB ERROR:', ev.message);
      clearTimeout(timer);
      process.exit(1);
    }
  }
}
console.log(stamp(), 'stream closed');
clearTimeout(timer);
process.exit(0);
