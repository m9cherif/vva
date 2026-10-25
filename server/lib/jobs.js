import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

/** In-memory job registry. Each job broadcasts events to any open SSE stream. */
export const jobs = new Map();

export function createJob(params) {
  const job = {
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    finishedAt: null,
    status: 'queued', // queued | running | done | error
    stage: 'queued', // queued|searching|downloading|watching|selecting|cutting|done|error
    percent: 0,
    params,
    model: null,
    logs: [],
    sources: [],
    clips: [],
    error: null,
    events: [],
    listeners: new Set(),
  };
  jobs.set(job.id, job);
  return job;
}

export function getJob(id) {
  return jobs.get(id) || null;
}

export function emit(job, type, data = {}) {
  const event = { type, at: Date.now(), ...data };
  job.events.push(event);
  if (job.events.length > 400) job.events.shift();
  const frame = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of job.listeners) {
    try {
      res.write(frame);
    } catch {
      job.listeners.delete(res);
    }
  }
}

export function log(job, text) {
  const line = `[${new Date().toLocaleTimeString()}] ${text}`;
  job.logs.push(line);
  if (job.logs.length > 300) job.logs.shift();
  emit(job, 'log', { text: line });
}

export function stage(job, name, percent, message) {
  job.stage = name;
  job.percent = Math.max(job.percent, Math.round(percent));
  emit(job, 'stage', { stage: name, percent: job.percent, message });
}

/**
 * Persist a finished job next to its clips so results survive a server restart.
 * Only serialisable state is written (listeners and the event replay buffer are runtime-only).
 */
export function saveJob(job) {
  try {
    const dir = path.join(config.workspace, job.id);
    fs.mkdirSync(dir, { recursive: true });
    const { listeners, events, ...rest } = job;
    fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify(rest));
  } catch {
    /* persistence must never fail a job */
  }
}

/** Rehydrate every saved job at startup — finished clips stay reachable after a restart. */
export function loadSavedJobs() {
  let names = [];
  try {
    names = fs.readdirSync(config.workspace, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return 0;
  }
  let loaded = 0;
  for (const d of names) {
    const file = path.join(config.workspace, d.name, 'job.json');
    if (!fs.existsSync(file)) continue;
    try {
      const job = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!job?.id || !Array.isArray(job.clips)) continue;
      if (job.status === 'running' || job.status === 'queued') {
        // The process that owned it died — mark it instead of showing a frozen spinner.
        job.status = 'error';
        job.error = job.error || 'Interrupted by a server restart';
        job.stage = 'error';
      }
      job.listeners = new Set();
      job.events = [];
      jobs.set(job.id, job);
      loaded += 1;
    } catch {
      /* skip unreadable history */
    }
  }
  return loaded;
}
