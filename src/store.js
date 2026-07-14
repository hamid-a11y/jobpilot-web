// Multi-tenant data layer. ISOLATION IS THE #1 CORRECTNESS PROPERTY:
// every workspace's data is invisible to every other workspace, enforced by
// scoped-only helpers that always bind workspace_id. A workspace (account) now
// owns MANY named profiles; each job/application belongs to one profile so a
// person can run separate searches for separate skill sets and keep the history
// of each. Login is email+password so people return to everything next time.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { randomUUID, createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encrypt, decrypt, hashPassword, verifyPassword } from './crypto.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = process.env.JOBPILOT_DATA_DIR || path.join(ROOT, 'data');
mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'jobpilot-web.sqlite'));
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA busy_timeout = 5000;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,               -- unguessable; also a private-URL fallback token
  name TEXT NOT NULL,
  anthropic_key TEXT,                -- BYO key, encrypted; never rendered back
  profile_json TEXT NOT NULL DEFAULT '{}',  -- legacy single profile (migrated to profiles)
  settings_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  last_seen_at TEXT
);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  dedup_key TEXT NOT NULL, company TEXT NOT NULL, title TEXT NOT NULL, location TEXT,
  source TEXT NOT NULL, apply_url TEXT, jd_text TEXT, channel TEXT, channel_reason TEXT,
  status TEXT NOT NULL DEFAULT 'discovered', fit_score INTEGER, fit_tier TEXT, fit_rationale TEXT,
  created_at TEXT NOT NULL, meta TEXT
);
CREATE INDEX IF NOT EXISTS jobs_ws ON jobs(workspace_id, status);
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL, kind TEXT NOT NULL, version INTEGER NOT NULL, content TEXT NOT NULL,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS docs_ws_job ON documents(workspace_id, job_id, kind, version);
CREATE TABLE IF NOT EXISTS llm_usage (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  at TEXT NOT NULL, purpose TEXT NOT NULL, input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL, est_cost_usd REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  profile_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS profiles_ws ON profiles(workspace_id);
`);

export const now = () => new Date().toISOString();
export const uuid = () => randomUUID();
export const workspaceToken = () => randomBytes(24).toString('base64url');
export const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const dedupKey = (company, title) =>
  sha256(`${company}|${title}`.toLowerCase().replace(/[^a-z0-9|]+/g, ' ').replace(/\s+/g, ' ').trim());

// --- Idempotent migration: add columns / backfill profiles from legacy data ---
function hasColumn(table, col) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
}
(function migrate() {
  if (!hasColumn('workspaces', 'email')) db.exec('ALTER TABLE workspaces ADD COLUMN email TEXT');
  if (!hasColumn('workspaces', 'password_hash')) db.exec('ALTER TABLE workspaces ADD COLUMN password_hash TEXT');
  if (!hasColumn('workspaces', 'active_profile_id')) db.exec('ALTER TABLE workspaces ADD COLUMN active_profile_id TEXT');
  if (!hasColumn('jobs', 'profile_id')) db.exec('ALTER TABLE jobs ADD COLUMN profile_id TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS ws_email ON workspaces(lower(email)) WHERE email IS NOT NULL');
  db.exec('DROP INDEX IF EXISTS jobs_ws_dedup'); // old per-workspace dedup; now per-profile
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS jobs_dedup ON jobs(workspace_id, COALESCE(profile_id,\'\'), dedup_key)');
  // Backfill: every workspace needs ≥1 profile; migrate the legacy profile_json.
  for (const w of db.prepare('SELECT id, profile_json, active_profile_id FROM workspaces').all()) {
    const existing = db.prepare('SELECT id FROM profiles WHERE workspace_id=? ORDER BY created_at LIMIT 1').get(w.id);
    let pid = existing?.id;
    if (!pid) {
      pid = uuid();
      db.prepare('INSERT INTO profiles (id, workspace_id, name, profile_json, created_at) VALUES (?,?,?,?,?)')
        .run(pid, w.id, 'Default', w.profile_json || '{}', now());
    }
    if (!w.active_profile_id) db.prepare('UPDATE workspaces SET active_profile_id=? WHERE id=?').run(pid, w.id);
    db.prepare('UPDATE jobs SET profile_id=? WHERE workspace_id=? AND profile_id IS NULL').run(pid, w.id);
  }
})();

// --- Accounts / workspaces ---
export function createWorkspace({ name, anthropicKey, email = null, password = null }) {
  const id = workspaceToken();
  const pid = uuid();
  db.prepare('INSERT INTO workspaces (id, name, email, password_hash, anthropic_key, created_at, active_profile_id) VALUES (?,?,?,?,?,?,?)')
    .run(id, name || 'My workspace', email ? email.toLowerCase() : null, password ? hashPassword(password) : null, encrypt(anthropicKey), now(), pid);
  db.prepare('INSERT INTO profiles (id, workspace_id, name, profile_json, created_at) VALUES (?,?,?,?,?)')
    .run(pid, id, 'Default', '{}', now());
  return id;
}
export function getWorkspace(id) {
  const w = db.prepare('SELECT * FROM workspaces WHERE id=?').get(id);
  if (w) db.prepare('UPDATE workspaces SET last_seen_at=? WHERE id=?').run(now(), id);
  return w || null;
}
export function findWorkspaceByEmail(email) {
  if (!email) return null;
  return db.prepare('SELECT * FROM workspaces WHERE lower(email)=lower(?)').get(email) || null;
}
export function verifyLogin(email, password) {
  const w = findWorkspaceByEmail(email);
  if (!w || !w.password_hash || !verifyPassword(password, w.password_hash)) return null;
  return w;
}
export function setCredentials(id, { email, password }) {
  if (email !== undefined) db.prepare('UPDATE workspaces SET email=? WHERE id=?').run(email ? email.toLowerCase() : null, id);
  if (password) db.prepare('UPDATE workspaces SET password_hash=? WHERE id=?').run(hashPassword(password), id);
}
export function getApiKey(id) {
  const w = db.prepare('SELECT anthropic_key FROM workspaces WHERE id=?').get(id);
  return w ? decrypt(w.anthropic_key) : null;
}
export function setKey(id, key) {
  db.prepare('UPDATE workspaces SET anthropic_key=? WHERE id=?').run(encrypt(key), id);
}
export function updateSettings(id, settingsObj) {
  db.prepare('UPDATE workspaces SET settings_json=? WHERE id=?').run(JSON.stringify(settingsObj), id);
}

// --- Profiles (workspace-scoped; a person's multiple searches) ---
export function listProfiles(wsId) {
  return db.prepare('SELECT id, name, created_at FROM profiles WHERE workspace_id=? ORDER BY created_at').all(wsId);
}
export function getProfile(wsId, profileId) {
  return db.prepare('SELECT * FROM profiles WHERE workspace_id=? AND id=?').get(wsId, profileId) || null;
}
export function getActiveProfile(wsId) {
  const w = db.prepare('SELECT active_profile_id FROM workspaces WHERE id=?').get(wsId);
  let p = w?.active_profile_id ? getProfile(wsId, w.active_profile_id) : null;
  if (!p) { p = db.prepare('SELECT * FROM profiles WHERE workspace_id=? ORDER BY created_at LIMIT 1').get(wsId) || null; if (p) activateProfile(wsId, p.id); }
  return p;
}
export function activateProfile(wsId, profileId) {
  const p = getProfile(wsId, profileId);
  if (p) db.prepare('UPDATE workspaces SET active_profile_id=? WHERE id=?').run(profileId, wsId);
}
export function createProfile(wsId, name) {
  const pid = uuid();
  db.prepare('INSERT INTO profiles (id, workspace_id, name, profile_json, created_at) VALUES (?,?,?,?,?)')
    .run(pid, wsId, (name || 'New profile').slice(0, 60), '{}', now());
  return pid;
}
export function renameProfile(wsId, profileId, name) {
  db.prepare('UPDATE profiles SET name=? WHERE workspace_id=? AND id=?').run((name || 'Profile').slice(0, 60), wsId, profileId);
}
export function updateProfileById(wsId, profileId, obj) {
  db.prepare('UPDATE profiles SET profile_json=? WHERE workspace_id=? AND id=?').run(JSON.stringify(obj), wsId, profileId);
}
export function deleteProfile(wsId, profileId) {
  if (db.prepare('SELECT COUNT(*) c FROM profiles WHERE workspace_id=?').get(wsId).c <= 1) return false; // keep at least one
  db.prepare('DELETE FROM jobs WHERE workspace_id=? AND profile_id=?').run(wsId, profileId);
  db.prepare('DELETE FROM profiles WHERE workspace_id=? AND id=?').run(wsId, profileId);
  const w = db.prepare('SELECT active_profile_id FROM workspaces WHERE id=?').get(wsId);
  if (w.active_profile_id === profileId) activateProfile(wsId, db.prepare('SELECT id FROM profiles WHERE workspace_id=? ORDER BY created_at LIMIT 1').get(wsId).id);
  return true;
}

// --- Jobs (scoped by workspace AND, when given, profile) ---
export function upsertJob(wsId, rec) {
  const profileId = rec.profile_id || null;
  const key = dedupKey(rec.company, rec.title);
  const existing = db.prepare('SELECT id, jd_text FROM jobs WHERE workspace_id=? AND COALESCE(profile_id,\'\')=COALESCE(?,\'\') AND dedup_key=?').get(wsId, profileId, key);
  if (existing) {
    if (rec.jd_text && !existing.jd_text) db.prepare('UPDATE jobs SET jd_text=? WHERE id=? AND workspace_id=?').run(rec.jd_text, existing.id, wsId);
    return { id: existing.id, deduped: true };
  }
  const id = uuid();
  db.prepare(`INSERT INTO jobs (id, workspace_id, profile_id, dedup_key, company, title, location, source, apply_url,
      jd_text, channel, channel_reason, status, created_at, meta) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, wsId, profileId, key, rec.company, rec.title, rec.location || null, rec.source, rec.apply_url || null,
      rec.jd_text || null, rec.channel || null, rec.channel_reason || null, 'discovered', now(), JSON.stringify(rec.meta || {}));
  return { id, deduped: false };
}
export function listJobs(wsId, statuses, profileId = null) {
  const where = ['workspace_id=?']; const args = [wsId];
  if (profileId) { where.push('profile_id=?'); args.push(profileId); }
  if (statuses && statuses.length) { where.push(`status IN (${statuses.map(() => '?').join(',')})`); args.push(...statuses); }
  return db.prepare(`SELECT * FROM jobs WHERE ${where.join(' AND ')} ORDER BY COALESCE(fit_score,0) DESC, created_at DESC`).all(...args);
}
export function getJob(wsId, jobId) {
  return db.prepare('SELECT * FROM jobs WHERE workspace_id=? AND id=?').get(wsId, jobId) || null;
}
export function updateJob(wsId, jobId, fields) {
  const cols = Object.keys(fields); if (!cols.length) return;
  db.prepare(`UPDATE jobs SET ${cols.map((c) => `${c}=?`).join(', ')} WHERE workspace_id=? AND id=?`).run(...cols.map((c) => fields[c]), wsId, jobId);
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
  return db.prepare('SELECT * FROM documents WHERE workspace_id=? AND job_id=? AND kind=? ORDER BY version DESC LIMIT 1').get(wsId, jobId, kind) || null;
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
