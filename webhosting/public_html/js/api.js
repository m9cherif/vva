/* Thin client for the PHP API. Every call has a timeout — nothing in this app
 * is allowed to hang (that was the original complaint this whole stack fixes). */

const DEFAULT_TIMEOUT = 45_000;

async function request(url, opts = {}, timeoutMs = DEFAULT_TIMEOUT) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      return data;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`request timed out after ${Math.round(timeoutMs / 1000)}s`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export const api = {
  categories: () => request('/api/categories.php'),

  search: (query, limit, source = 'youtube') =>
    request('/api/search.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, limit, source }),
    }, 60_000),

  player: (id, provider = 'youtube') =>
    request('/api/player.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, provider }),
    }, 45_000),

  /* AI calls can legitimately take minutes on a cold vision model. */
  ai: (payload) =>
    request('/api/ai.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }, 200_000),

  /* Cover image, always same-origin (COEP isolation + the agent needs bytes).
   * Accepts an id string or a full video object ({id, provider, thumb}). */
  thumb: (video) => {
    const v = typeof video === 'string' ? { id: video } : (video || {});
    if (v.provider === 'pexels' || v.provider === 'archive') {
      return `/api/thumb.php?provider=${encodeURIComponent(v.provider)}&url=${encodeURIComponent(v.thumb || '')}`;
    }
    return `/api/thumb.php?id=${encodeURIComponent(v.id || '')}`;
  },

  jobs: () => request('/api/jobs.php'),
  job: (id) => request(`/api/jobs.php?id=${encodeURIComponent(id)}`),
  saveJob: (job) =>
    request('/api/jobs.php', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(job),
    }, 30_000),

  uploadClip: (jobId, name, blob) => {
    const form = new FormData();
    form.append('jobId', jobId);
    form.append('name', name);
    form.append('file', blob, name);
    return request('/api/upload.php', { method: 'POST', body: form }, 120_000);
  },

  /* Probe a stream: total size + range support, without pulling the bytes. */
  probe: (url) => request(`/api/range.php?u=${b64url(url)}&probe=1`, {}, 30_000),
};

export function b64url(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Extract the first JSON array/object from a chatty model reply. */
export function extractJson(text) {
  if (!text) return null;
  let t = String(text).trim().replace(/^```(?:json)?/i, '').replace(/```\s*$/i, '').trim();
  const tryParse = (s) => { try { return JSON.parse(s); } catch { return null; } };

  const openArr = t.indexOf('[');
  const openObj = t.indexOf('{');
  const open = openArr === -1 ? openObj : openObj === -1 ? openArr : Math.min(openArr, openObj);
  if (open === -1) return tryParse(t);
  const openChar = t[open];
  const closeChar = openChar === '[' ? ']' : '}';
  const close = t.lastIndexOf(closeChar);
  if (close > open) {
    const parsed = tryParse(t.slice(open, close + 1));
    if (parsed) return parsed;
  }
  return tryParse(t);
}
