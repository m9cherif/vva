/* ViralClips AI — front-end controller */
const $ = (s) => document.querySelector(s);

const els = {
  chips: $('#chips'),
  custom: $('#customCategory'),
  clipCount: $('#clipCount'),
  clipLength: $('#clipLength'),
  sourceCount: $('#sourceCount'),
  windowSeconds: $('#windowSeconds'),
  generate: $('#generate'),
  pipeline: $('#pipeline'),
  results: $('#results'),
  stepper: $('#stepper'),
  barFill: $('#barFill'),
  stageMsg: $('#stageMsg'),
  percentLabel: $('#percentLabel'),
  sources: $('#sources'),
  console: $('#console'),
  clipGrid: $('#clipGrid'),
  resultsMeta: $('#resultsMeta'),
  quality: $('#quality'),
  aspect: $('#aspect'),
  engine: $('#engineBadge'),
  toast: $('#toast'),
  again: $('#againBtn'),
  estimate: $('#estimate'),
  history: $('#history'),
  historyList: $('#historyList'),
};

const state = { category: '', source: 'chip', es: null, jobId: null, clips: [], running: false };

const STAGES = ['searching', 'downloading', 'watching', 'selecting', 'cutting', 'done'];

/* ── boot ────────────────────────────────────────────── */
init();

async function init() {
  try {
    const res = await fetch('/api/categories');
    const data = await res.json();
    renderChips(data.categories);
    applyLimits(data.limits);
  } catch {
    renderChips(['Gaming', 'Football', 'Comedy Pranks', 'Cooking', 'Cars', 'Music']);
  }

  bindControls();
  document.querySelectorAll('input[type="range"]').forEach(syncSlider);
  updateEstimate();
  loadHistory();
}

function renderChips(categories) {
  els.chips.innerHTML = '';
  for (const label of categories) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip';
    btn.textContent = label;
    btn.addEventListener('click', () => {
      document.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
      btn.classList.add('active');
      els.custom.value = '';
      state.category = label;
      state.source = 'chip';
    });
    els.chips.appendChild(btn);
  }
  const first = els.chips.querySelector('.chip');
  if (first) {
    first.classList.add('active');
    state.category = first.textContent;
  }
}

function applyLimits(l) {
  if (!l) return;
  setRange(els.clipCount, l.clipCountMin, l.clipCountMax);
  setRange(els.clipLength, l.clipLengthMin, l.clipLengthMax);
  setRange(els.sourceCount, l.sourceMin, l.sourceMax);
  setRange(els.windowSeconds, l.windowMin, l.windowMax, l.windowDefault);
}

function setRange(input, min, max, value) {
  input.min = min;
  input.max = max;
  if (value != null) input.value = value;
}

function bindControls() {
  els.custom.addEventListener('input', () => {
    const v = els.custom.value.trim();
    if (v) {
      document.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
      state.category = v;
      state.source = 'custom';
    } else {
      const active = document.querySelector('.chip.active');
      state.category = active ? active.textContent : '';
      state.source = 'chip';
    }
  });

  for (const input of [els.clipCount, els.clipLength, els.sourceCount, els.windowSeconds]) {
    input.addEventListener('input', () => {
      syncSlider(input);
      updateEstimate();
    });
  }

  els.generate.addEventListener('click', start);
  els.again.addEventListener('click', () => {
    els.results.hidden = true;
    els.pipeline.hidden = true;
    els.generate.disabled = false;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
}

function syncSlider(input) {
  const min = Number(input.min) || 0;
  const max = Number(input.max) || 100;
  const pct = ((Number(input.value) - min) / (max - min)) * 100;
  input.style.setProperty('--fill', `${pct}%`);
  const out = document.getElementById(`${input.id}Out`);
  if (out) out.textContent = input.id === 'clipLength' || input.id === 'windowSeconds' ? `${input.value}s` : input.value;
}

function updateEstimate() {
  const clips = Number(els.clipCount.value);
  const sources = Number(els.sourceCount.value);
  const secs = Math.round(45 + sources * 18 + clips * 9);
  els.estimate.textContent = `≈ ${Math.floor(secs / 60)}–${Math.ceil(secs / 60) + 2} minutes per run · ${sources} videos watched by AI`;
}

/* ── run ─────────────────────────────────────────────── */
async function start() {
  if (state.running) return;
  const category = (state.category || els.custom.value).trim();
  if (!category) {
    toast('Pick a category or type your own first.');
    els.custom.focus();
    return;
  }

  state.running = true;
  els.generate.disabled = true;
  els.generate.querySelector('.cta-label').textContent = 'Pipeline running…';
  els.results.hidden = true;
  els.pipeline.hidden = false;
  resetPipelineUI();

  try {
    const res = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        category,
        clipCount: Number(els.clipCount.value),
        clipLength: Number(els.clipLength.value),
        sourceCount: Number(els.sourceCount.value),
        windowSeconds: Number(els.windowSeconds.value),
        quality: Number(els.quality.value),
        aspect: els.aspect.value,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not start the job');
    state.jobId = data.jobId;
    openStream(data.jobId);
  } catch (err) {
    finishRun(false);
    toast(String(err.message || err));
  }
}

function openStream(jobId) {
  if (state.es) state.es.close();
  const es = new EventSource(`/api/jobs/${jobId}/events`);
  state.es = es;

  es.onmessage = (msg) => {
    let ev;
    try {
      ev = JSON.parse(msg.data);
    } catch {
      return;
    }
    switch (ev.type) {
      case 'snapshot':
        setStage(ev.stage, ev.percent, '');
        if (ev.logs?.length) renderLogs(ev.logs);
        (ev.sources || []).forEach(upsertSource);
        (ev.clips || []).forEach(addClipCard);
        break;
      case 'stage':
        setStage(ev.stage, ev.percent, ev.message);
        break;
      case 'log':
        appendLog(ev.text);
        break;
      case 'source':
        upsertSource(ev.source);
        break;
      case 'clip-ready':
        addClipCard(ev.clip, true);
        break;
      case 'result':
        renderResults(ev);
        es.close();
        state.es = null;
        finishRun(true);
        break;
      case 'error':
        setStage('error', null, ev.message);
        appendLog(`ERROR: ${ev.message}`, 'bad');
        toast(ev.message);
        es.close();
        state.es = null;
        finishRun(false);
        break;
      default:
        break;
    }
  };

  es.onerror = () => {
    // EventSource retries automatically; only treat it as fatal if the job already finished.
    if (state.running && !state.es) return;
  };
}

function finishRun(ok) {
  state.running = false;
  els.generate.disabled = false;
  els.generate.querySelector('.cta-label').textContent = ok ? 'Run it again' : 'Generate viral clips';
  loadHistory();
}

/* ── history ─────────────────────────────────────────── */
async function loadHistory() {
  try {
    const res = await fetch('/api/jobs');
    if (!res.ok) return;
    const { jobs } = await res.json();
    if (!Array.isArray(jobs) || !jobs.length) return;
    els.history.hidden = false;
    els.historyList.innerHTML = '';
    for (const j of jobs) els.historyList.appendChild(historyRow(j));
  } catch {
    /* history is optional */
  }
}

function historyRow(j) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = `history-row${j.status === 'error' ? ' bad' : ''}`;
  const when = new Date(j.finishedAt || j.createdAt).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  row.innerHTML = `
    <span class="hist-cat"></span>
    <span class="hist-meta"></span>
    <span class="hist-when"></span>
    <span class="hist-go"></span>`;
  row.querySelector('.hist-cat').textContent = j.category;
  row.querySelector('.hist-meta').textContent = j.clipCount
    ? `${j.clipCount} clip${j.clipCount === 1 ? '' : 's'} · ${j.clipLength}s · ${j.aspect}${j.quality ? ` · ${j.quality}p` : ''}`
    : `${j.requested} requested · ${j.status}`;
  row.querySelector('.hist-when').textContent = when;
  row.querySelector('.hist-go').textContent = j.clipCount ? 'Open' : 'Details';
  row.addEventListener('click', () => openRun(j.id));
  return row;
}

async function openRun(id) {
  try {
    const res = await fetch(`/api/jobs/${id}`);
    const snap = await res.json();
    if (!res.ok) throw new Error(snap.error || 'Run not found');
    if (!snap.clips?.length) {
      toast(snap.error || `That run produced no clips (${snap.status}).`);
      return;
    }
    if (state.es) { state.es.close(); state.es = null; }
    state.jobId = id;
    els.pipeline.hidden = true;
    renderResults({ clips: snap.clips, model: snap.model, sources: snap.sources });
  } catch (err) {
    toast(String(err.message || err));
  }
}

/* ── UI updates ──────────────────────────────────────── */
function resetPipelineUI() {
  state.lastStage = null;
  els.console.innerHTML = '<div class="console-line dim">Booting pipeline…</div>';
  els.sources.innerHTML = '';
  els.clipGrid.innerHTML = '';
  state.clips = [];
  els.barFill.style.width = '0%';
  els.percentLabel.textContent = '0%';
  els.stageMsg.textContent = 'Starting…';
  els.engine.textContent = 'vision engine · starting';
  els.engine.classList.remove('live');
  document.querySelectorAll('.step').forEach((s) => s.classList.remove('active', 'done', 'error'));
}

function setStage(stage, percent, message) {
  let idx = STAGES.indexOf(stage);
  if (stage === 'error') idx = STAGES.indexOf(state.lastStage); // flag the step we died on
  if (idx >= 0) state.lastStage = STAGES[idx];

  document.querySelectorAll('.step').forEach((el) => {
    const elIdx = STAGES.indexOf(el.dataset.stage);
    el.classList.remove('active', 'done', 'error');
    if (stage === 'error') {
      if (elIdx === idx) el.classList.add('error');
      else if (elIdx < idx) el.classList.add('done');
    } else if (elIdx < idx) {
      el.classList.add('done');
    } else if (elIdx === idx) {
      el.classList.add('active');
    }
  });

  if (typeof percent === 'number') {
    els.barFill.style.width = `${percent}%`;
    els.percentLabel.textContent = `${percent}%`;
  }
  if (message) els.stageMsg.textContent = message;
}

function appendLog(text, kind) {
  const empty = els.console.querySelector('.dim');
  if (empty && els.console.children.length === 1) els.console.innerHTML = '';
  const line = document.createElement('div');
  line.className = `console-line${kind ? ` ${kind}` : ''}`;
  line.textContent = text;
  els.console.appendChild(line);
  while (els.console.children.length > 220) els.console.removeChild(els.console.firstChild);
  els.console.scrollTop = els.console.scrollHeight;

  if (text.includes('Vision model in use:')) {
    els.engine.textContent = text.split('Vision model in use:')[1].trim();
    els.engine.classList.add('live');
  }
}

function renderLogs(logs) {
  els.console.innerHTML = '';
  logs.forEach((l) => appendLog(l));
}

function upsertSource(src) {
  if (!src) return;
  let card = document.getElementById(`src-${src.id}`);
  if (!card) {
    card = document.createElement('div');
    card.className = 'source';
    card.id = `src-${src.id}`;
    card.innerHTML = `
      <img alt="" loading="lazy" />
      <div class="source-body">
        <div class="source-title"></div>
        <div class="source-meta"><span class="pill status">queued</span><span class="views"></span></div>
      </div>`;
    els.sources.appendChild(card);
  }
  const img = card.querySelector('img');
  if (src.thumb && img.getAttribute('src') !== src.thumb) {
    img.src = src.thumb;
    img.onerror = () => { img.style.visibility = 'hidden'; };
  }
  card.querySelector('.source-title').textContent = src.title;
  card.querySelector('.views').textContent = formatViews(src.views);

  const meta = card.querySelector('.source-meta');
  let status = meta.querySelector('.pill.status');
  status.className = `pill status ${src.status}`;
  status.textContent = src.status;

  const existingScore = meta.querySelector('.pill.score');
  if (src.peakScore != null) {
    if (!existingScore) {
      const b = document.createElement('span');
      b.className = 'pill score';
      meta.appendChild(b);
    }
    meta.querySelector('.pill.score').textContent = `peak ${src.peakScore}`;
  }
}

function addClipCard(clip, animate) {
  if (!clip || state.clips.some((c) => c.file === clip.file)) return;
  state.clips.push(clip);
  els.clipGrid.appendChild(buildCard(clip, animate));
  els.results.hidden = false;
}

function renderResults(ev) {
  state.clips = ev.clips || [];
  els.clipGrid.innerHTML = '';
  state.clips.forEach((c) => els.clipGrid.appendChild(buildCard(c, true)));
  els.results.hidden = state.clips.length === 0;
  els.resultsMeta.textContent = `${state.clips.length} clips · scored by ${ev.model || 'vision model'} · ${ev.sources?.length || 0} videos watched`;
  els.results.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function buildCard(clip, animate) {
  const card = document.createElement('article');
  card.className = 'card';
  if (!animate) card.style.animation = 'none';

  const scoreClass = clip.score >= 70 ? '' : clip.score >= 50 ? 'mid' : 'low';
  card.innerHTML = `
    <video controls preload="metadata" playsinline></video>
    <div class="card-body">
      <div class="card-top">
        <h3></h3>
        <span class="score ${scoreClass}">${Math.round(clip.score)} 🔥</span>
      </div>
      <p class="hook"></p>
      <div class="tags" hidden></div>
      <div class="caption" hidden><button class="copy-btn" type="button">Copy</button><span class="caption-text"></span></div>
      <div class="card-meta">
        <span class="range"></span>
        <a class="src-link" target="_blank" rel="noopener">Watch source ↗</a>
      </div>
      <div class="card-meta" style="border-top:0;padding-top:8px">
        <span class="who"></span>
        <a class="dl" download>Download MP4</a>
      </div>
    </div>`;

  card.querySelector('video').src = clip.file;
  card.querySelector('h3').textContent = clip.title;
  card.querySelector('.hook').textContent = clip.hook;

  const tags = card.querySelector('.tags');
  (clip.hashtags || []).forEach((t) => {
    const chip = document.createElement('span');
    chip.className = 'tag';
    chip.textContent = t;
    tags.appendChild(chip);
  });
  tags.hidden = tags.children.length === 0;

  const capBlock = card.querySelector('.caption');
  if (clip.caption) {
    capBlock.hidden = false;
    capBlock.querySelector('.caption-text').textContent = clip.caption;
    capBlock.querySelector('.copy-btn').addEventListener('click', async (e) => {
      const payload = [clip.caption, (clip.hashtags || []).join(' ')].filter(Boolean).join('\n\n');
      try {
        await navigator.clipboard.writeText(payload);
        e.target.textContent = 'Copied!';
      } catch {
        e.target.textContent = 'Copy failed';
      }
      setTimeout(() => { e.target.textContent = 'Copy'; }, 1800);
    });
  }
  card.querySelector('.range').textContent = `${fmt(clip.startSec)} → ${fmt(clip.endSec)} · ${clip.duration}s`;
  const link = card.querySelector('.src-link');
  link.href = clip.sourceUrl;
  card.querySelector('.who').textContent = `${clip.channel} · ${formatViews(clip.views)} views`;
  const dl = card.querySelector('.dl');
  dl.href = clip.file;
  dl.download = `${clip.title.replace(/[^\w\s-]/g, '').trim().slice(0, 60) || 'clip'}.mp4`;
  return card;
}

/* ── utils ───────────────────────────────────────────── */
function toast(message, kind) {
  els.toast.textContent = message;
  els.toast.className = `toast${kind ? ` ${kind}` : ''}`;
  els.toast.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { els.toast.hidden = true; }, 7000);
}

function fmt(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function formatViews(n) {
  const v = Number(n) || 0;
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(v);
}
