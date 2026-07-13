// Multi-tenant data layer. ISOLATION IS THE #1 CORRECTNESS PROPERTY:
// every workspace's data must be invisible to every other workspace.
// We enforce that two ways, belt-and-suspenders:
//   1. Every row in every tenant table carries workspace_id NOT NULL.
//   2. Every read/write goes through the scoped helpers below, which ALWAYS
//      bind workspace_id — there is no unscoped query path exported.
// A test (test/isolation.test.mjs) proves one workspace cannot read another's.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { randomUUID, createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = process.env.JOBPILOT_DATA_DIR || path.join(ROOT, 'data');
mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'jobpilot-web.sqlite'));
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA busy_timeout = 5000;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,               -- unguessable; doubles as the private URL token
  name TEXT NOT NULL,
  anthropic_key TEXT,                -- BYO key, per workspace; never rendered back
  profile_json TEXT NOT NULL DEFAULT '{}',
  settings_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  last_seen_at TEXT
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  dedup_key TEXT NOT NULL,
  company TEXT NOT NULL,
  title TEXT NOT NULL,
  location TEXT,
  source TEXT NOT NULL,
  apply_url TEXT,
  jd_text TEXT,
  channel TEXT,
  channel_reason TEXT,
  status TEXT NOT NULL DEFAULT 'discovered',
  fit_score INTEGER,
  fit_tier TEXT,
  fit_rationale TEXT,
  created_at TEXT NOT NULL,
  meta TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS jobs_ws_dedup ON jobs(workspace_id, dedup_key);
CREATE INDEX IF NOT EXISTS jobs_ws ON jobs(workspace_id, status);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS docs_ws_job ON documents(workspace_id, job_id, kind, version);

CREATE TABLE IF NOT EXISTS llm_usage (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  purpose TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  est_cost_usd REAL NOT NULL
);
`);

export const now = () => new Date().toISOString();
export const uuid = () => randomUUID();
// Workspace ids are 32 random bytes of URL-safe entropy — unguessable, so the
// private workspace URL functions as the access token (like a private doc link).
export const workspaceToken = () => randomBytes(24).toString('base64url');
export const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const dedupKey = (company, title) =>
  sha256(`${company}|${title}`.toLowerCase().replace(/[^a-z0-9|]+/g, ' ').replace(/\s+/g, ' ').trim());

// --- Workspaces ---
export function createWorkspace({ name, anthropicKey }) {
  const id = workspaceToken();
  db.prepare('INSERT INTO workspaces (id, name, anthropic_key, created_at) VALUES (?,?,?,?)')
    .run(id, name || 'My workspace', anthropicKey || null, now());
  return id;
}
export function getWorkspace(id) {
  const w = db.prepare('SELECT * FROM workspaces WHERE id=?').get(id);
  if (w) db.prepare('UPDATE workspaces SET last_seen_at=? WHERE id=?').run(now(), id);
  return w || null;
}
export function updateProfile(id, profileObj) {
  db.prepare('UPDATE workspaces SET profile_json=? WHERE id=?').run(JSON.stringify(profileObj), id);
}
export function updateSettings(id, settingsObj) {
  db.prepare('UPDATE workspaces SET settings_json=? WHERE id=?').run(JSON.stringify(settingsObj), id);
}
export function setKey(id, key) {
  db.prepare('UPDATE workspaces SET anthropic_key=? WHERE id=?').run(key || null, id);
}

// --- Jobs (ALL scoped by workspace_id) ---
export function upsertJob(wsId, rec) {
  const key = dedupKey(rec.company, rec.title);
  const existing = db.prepare('SELECT id, jd_text FROM jobs WHERE workspace_id=? AND dedup_key=?').get(wsId, key);
  if (existing) {
    if (rec.jd_text && !existing.jd_text) {
      db.prepare('UPDATE jobs SET jd_text=? WHERE id=? AND workspace_id=?').run(rec.jd_text, existing.id, wsId);
    }
    return { id: existing.id, deduped: true };
  }
  const id = uuid();
  db.prepare(`INSERT INTO jobs (id, workspace_id, dedup_key, company, title, location, source, apply_url,
      jd_text, channel, channel_reason, status, created_at, meta)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, wsId, key, rec.company, rec.title, rec.location || null, rec.source, rec.apply_url || null,
      rec.jd_text || null, rec.channel || null, rec.channel_reason || null, 'discovered', now(),
      JSON.stringify(rec.meta || {}));
  return { id, deduped: false };
}
export function listJobs(wsId, statuses) {
  if (statuses && statuses.length) {
    const q = statuses.map(() => '?').join(',');
    return db.prepare(`SELECT * FROM jobs WHERE workspace_id=? AND status IN (${q}) ORDER BY COALESCE(fit_score,0) DESC, created_at DESC`)
      .all(wsId, ...statuses);
  }
  return db.prepare('SELECT * FROM jobs WHERE workspace_id=? ORDER BY COALESCE(fit_score,0) DESC, created_at DESC').all(wsId);
}
export function getJob(wsId, jobId) {
  return db.prepare('SELECT * FROM jobs WHERE workspace_id=? AND id=?').get(wsId, jobId) || null;
}
export function updateJob(wsId, jobId, fields) {
  const cols = Object.keys(fields);
  if (!cols.length) return;
  const set = cols.map((c) => `${c}=?`).join(', ');
  db.prepare(`UPDATE jobs SET ${set} WHERE workspace_id=? AND id=?`).run(...cols.map((c) => fields[c]), wsId, jobId);
}

// --- Documents (scoped) ---
export function saveDocument(wsId, jobId, kind, content, createdBy) {
  const last = db.prepare('SELECT MAX(version) v FROM documents WHERE workspace_id=? AND job_id=? AND kind=?').get(wsId, jobId, kind);
  const version = (last?.v || 0) + 1;
  db.prepare('INSERT INTO documents (id, workspace_id, job_id, kind, version, content, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(uuid(), wsId, jobId, kind, version, content, createdBy, now());
  return version;
}
export function latestDocument(wsId, jobId, kind) {
  return db.prepare('SELECT * FROM documents WHERE workspace_id=? AND job_id=? AND kind=? ORDER BY version DESC LIMIT 1')
    .get(wsId, jobId, kind) || null;
}

// --- LLM usage / budget (scoped) ---
export function recordUsage(wsId, purpose, inTok, outTok, cost) {
  db.prepare('INSERT INTO llm_usage (id, workspace_id, at, purpose, input_tokens, output_tokens, est_cost_usd) VALUES (?,?,?,?,?,?,?)')
    .run(uuid(), wsId, now(), purpose, inTok, outTok, cost);
}
export function monthlySpend(wsId) {
  return db.prepare(`SELECT COALESCE(SUM(est_cost_usd),0) s FROM llm_usage WHERE workspace_id=? AND datetime(at) > datetime('now','start of month')`).get(wsId).s;
}

export { db as _db };
