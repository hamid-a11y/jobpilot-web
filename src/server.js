// JobPilot-web — multi-user hosted assistant. Each workspace is reached by an
// unguessable secret URL (/w/<token>) that acts as its access key, like a
// private document link. No cross-workspace access path exists (see store.js).
// Bring-your-own Anthropic key: the server never holds a shared/owner key.
import express from 'express';
import {
  createWorkspace, getWorkspace, getApiKey, updateProfile, updateSettings, setKey,
  listJobs, getJob, updateJob, latestDocument, saveDocument, monthlySpend,
} from './store.js';
import { addManualJob, runPipeline } from './pipeline.js';
import { page, esc } from './views.js';
import { blankProfile, defaultSettings } from './defaults.js';

const app = express();
app.disable('x-powered-by');
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Security headers. CSP allows the inline stylesheet + Google Fonts (the only
// external origins the pages use) and blocks scripts entirely — there are none.
app.use((_req, res, next) => {
  res.setHeader('Referrer-Policy', 'no-referrer'); // don't leak the secret workspace URL
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  next();
});

// Simple in-memory rate limiter (single instance). Blunt but real: caps abusive
// bursts on the expensive/creating endpoints without external infra.
const hits = new Map();
function rateLimit(key, max, windowMs) {
  const nowMs = Date.now();
  const e = hits.get(key);
  if (!e || nowMs > e.resetAt) { hits.set(key, { count: 1, resetAt: nowMs + windowMs }); return true; }
  if (e.count >= max) return false;
  e.count++; return true;
}
const clientIp = (req) => (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').toString().split(',')[0].trim();
const WS_MONTHLY_CAP = Number(process.env.JOBPILOT_WS_MONTHLY_CAP || 20); // $/workspace/month

// In-memory per-workspace pipeline run state (single instance; fine for a friends tool).
const running = new Map(); // wsId -> { startedAt, result|null, error|null }

const wsOr404 = (req, res) => {
  const w = getWorkspace(req.params.id);
  if (!w) { res.status(404).send(page('Not found', '<div class="empty">Workspace not found. Check your private link.</div>')); return null; }
  return w;
};
const profileComplete = (p) => p && p.name && p.name[0] !== '<' && (p.roles || []).some((r) => r.title && r.title[0] !== '<');

// --- Landing / signup ---
app.get('/', (_req, res) => {
  res.send(page('JobPilot — get started', `
    <div class="hero"><h2>Your AI job-application assistant</h2>
      <p>Tell it about your experience once. It finds relevant roles, ranks them for you, and drafts
      tailored resumes and cover letters — grounded only in facts you verify. You review and apply;
      it never submits anything for you.</p></div>
    <div class="card"><form method="post" action="/create">
      <label>Your name (or a label for this workspace)</label>
      <input name="name" required placeholder="e.g. Alex Rivera" maxlength="80">
      <label>Your Anthropic API key <span class="note">— from console.anthropic.com. Stored only for your workspace; never shown to anyone else. You can add it later.</span></label>
      <input name="anthropicKey" placeholder="sk-ant-..." autocomplete="off">
      <div style="margin-top:16px"><button class="primary">Create my workspace →</button></div>
      <p class="note" style="margin-top:12px">You'll get a private link — bookmark it, it's the only way back into your workspace.</p>
    </form></div>`));
});

app.post('/create', (req, res) => {
  if (!rateLimit(`create:${clientIp(req)}`, 5, 3600e3)) // 5 new workspaces per IP per hour
    return res.status(429).send(page('Slow down', '<div class="empty">Too many workspaces created from your network recently. Try again in a bit.</div>'));
  const id = createWorkspace({ name: (req.body.name || '').slice(0, 80), anthropicKey: (req.body.anthropicKey || '').trim() || null });
  updateProfile(id, blankProfile());
  updateSettings(id, defaultSettings());
  res.redirect(`/w/${id}`);
});

// --- Dashboard ---
app.get('/w/:id', (req, res) => {
  const w = wsOr404(req, res); if (!w) return;
  const profile = JSON.parse(w.profile_json);
  const run = running.get(w.id);
  const jobs = listJobs(w.id, ['pending_approval', 'tailored', 'ranked', 'approved', 'submitted']);
  const spend = monthlySpend(w.id);

  const banner = !w.anthropic_key
    ? `<div class="warn">No Anthropic API key yet — <a href="/w/${w.id}/settings">add yours in Settings</a> before running.</div>`
    : !profileComplete(profile)
      ? `<div class="warn">Your profile is still a template — <a href="/w/${w.id}/profile">fill it in</a> so drafts are grounded in real facts.</div>` : '';

  const runState = run && !run.result && !run.error
    ? `<div class="banner">⏳ Working… discovering, ranking, and drafting. Refresh in ~30–60s.</div>`
    : run && run.error ? `<div class="warn">Last run error: ${esc(run.error)}</div>`
    : run && run.result ? `<div class="banner">✓ Last run: ${run.result.ranked} ranked, ${run.result.tailored} drafted${run.result.errors.length ? ` (${run.result.errors.length} skipped)` : ''}.</div>` : '';

  const cards = jobs.map((j) => {
    const r = JSON.parse(j.fit_rationale || '{}'); const meta = JSON.parse(j.meta || '{}');
    return `<div class="card jobcard"><div class="band ${esc(j.channel || 'red')}"></div>
      <div class="score mono">${j.fit_score ?? '--'}<small>fit</small></div>
      <div style="flex:1;min-width:0">
        <div class="title"><a href="/w/${w.id}/job/${j.id}">${esc(j.company)} — ${esc(j.title)}</a></div>
        <div class="tags">${esc(j.location || '')} · ${esc(j.status.replace('_', ' '))} · ${esc(j.channel || '?')} channel</div>
        <div style="margin-top:4px">${j.fit_tier ? `<span class="pill ${esc(j.fit_tier)}">${esc(j.fit_tier)}</span>` : ''}${meta.truthfulness_flag ? '<span class="pill flag">truthfulness flag</span>' : ''}</div>
        ${r.rationale ? `<div class="rationale">${esc(r.rationale)}</div>` : ''}
      </div></div>`;
  }).join('');

  res.send(page('Your dashboard', `${banner}${runState}
    <div class="row" style="margin-bottom:16px">
      <form method="post" action="/w/${w.id}/run"><button class="primary" ${!w.anthropic_key ? 'disabled' : ''}>Find &amp; draft jobs</button></form>
      <a class="btn" href="/w/${w.id}/profile">Edit profile</a>
      <a class="btn" href="/w/${w.id}/add">Add a job by URL</a>
      <span class="note">This month: $${spend.toFixed(2)} on your key</span>
    </div>
    ${cards || '<div class="empty">No jobs yet. Add your target companies in Settings, or paste a job URL, then hit “Find &amp; draft jobs”.</div>'}`, { workspace: w }));
});

// --- Run pipeline (background) ---
app.post('/w/:id/run', (req, res) => {
  const w = wsOr404(req, res); if (!w) return;
  if (!w.anthropic_key) return res.redirect(`/w/${w.id}/settings`);
  if (!rateLimit(`run:${w.id}`, 12, 3600e3)) // 12 pipeline runs per workspace per hour
    return res.status(429).send(page('Slow down', `<div class="empty">You've run the pipeline a lot in the last hour — give it a rest, then try again. <a href="/w/${w.id}">Back</a></div>`, { workspace: w }));
  // Per-workspace monthly spend cap — hard stop so a runaway loop can't drain a key.
  if (monthlySpend(w.id) >= WS_MONTHLY_CAP) {
    running.set(w.id, { error: `Monthly cap of $${WS_MONTHLY_CAP} reached on your key. Resets next month.` });
    return res.redirect(`/w/${w.id}`);
  }
  const cur = running.get(w.id);
  if (!cur || cur.result || cur.error) {
    running.set(w.id, { startedAt: Date.now(), result: null, error: null });
    const apiKey = getApiKey(w.id); // decrypt only here, at the point of use
    const profile = JSON.parse(w.profile_json); const settings = JSON.parse(w.settings_json);
    runPipeline(w.id, apiKey, profile, settings, { tailorLimit: 5 })
      .then((result) => running.set(w.id, { result, error: null }))
      .catch((e) => running.set(w.id, { result: null, error: e.message }));
  }
  res.redirect(`/w/${w.id}`);
});

// --- Profile form ---
app.get('/w/:id/profile', (req, res) => {
  const w = wsOr404(req, res); if (!w) return;
  res.send(page('Edit profile', `
    <div class="section">Your profile — the ONLY source the AI may use</div>
    <p class="note">Edit the JSON below. Every number and credential in your drafts must trace back to something here — that's how JobPilot stays honest. Keep numbers exact.</p>
    <form method="post" action="/w/${w.id}/profile">
      <textarea name="profile" style="min-height:420px">${esc(JSON.stringify(JSON.parse(w.profile_json), null, 2))}</textarea>
      <div style="margin-top:12px"><button class="primary">Save profile</button> <a class="btn" href="/w/${w.id}">Back</a></div>
    </form>`, { workspace: w }));
});
app.post('/w/:id/profile', (req, res) => {
  const w = wsOr404(req, res); if (!w) return;
  try { updateProfile(w.id, JSON.parse(req.body.profile)); }
  catch { return res.status(400).send(page('Invalid JSON', `<div class="warn">That wasn't valid JSON — <a href="/w/${w.id}/profile">go back</a> and check it.</div>`, { workspace: w })); }
  res.redirect(`/w/${w.id}`);
});

// --- Settings (API key + watchlist) ---
app.get('/w/:id/settings', (req, res) => {
  const w = wsOr404(req, res); if (!w) return;
  res.send(page('Settings', `
    <div class="section">Anthropic API key</div>
    <p class="note">Stored only for your workspace, used only for your runs, never shown back. ${w.anthropic_key ? '✓ A key is set.' : 'No key set yet.'}</p>
    <form method="post" action="/w/${w.id}/key"><input name="anthropicKey" placeholder="sk-ant-... (paste to replace)" autocomplete="off">
      <div style="margin-top:8px"><button class="primary">Save key</button></div></form>
    <div class="section">Search — role keywords &amp; company watchlist</div>
    <p class="note">Which public ATS boards to poll and which job titles to keep. ats is greenhouse | lever | ashby; board is the slug in the careers URL.</p>
    <form method="post" action="/w/${w.id}/settings">
      <textarea name="settings" style="min-height:300px">${esc(JSON.stringify(JSON.parse(w.settings_json), null, 2))}</textarea>
      <div style="margin-top:12px"><button class="primary">Save search settings</button> <a class="btn" href="/w/${w.id}">Back</a></div>
    </form>
    <div class="section">Danger zone</div>
    <p class="note">Your private link is the only key to this workspace. Anyone with it can see and edit your data — don't share it.</p>`, { workspace: w }));
});
app.post('/w/:id/key', (req, res) => {
  const w = wsOr404(req, res); if (!w) return;
  const k = (req.body.anthropicKey || '').trim(); if (k) setKey(w.id, k);
  res.redirect(`/w/${w.id}/settings`);
});
app.post('/w/:id/settings', (req, res) => {
  const w = wsOr404(req, res); if (!w) return;
  try { updateSettings(w.id, JSON.parse(req.body.settings)); }
  catch { return res.status(400).send(page('Invalid JSON', `<div class="warn">That wasn't valid JSON — <a href="/w/${w.id}/settings">go back</a>.</div>`, { workspace: w })); }
  res.redirect(`/w/${w.id}/settings`);
});

// --- Add a job manually ---
app.get('/w/:id/add', (req, res) => {
  const w = wsOr404(req, res); if (!w) return;
  res.send(page('Add a job', `<div class="section">Add a job by URL</div>
    <form method="post" action="/w/${w.id}/add">
      <label>Company</label><input name="company" required maxlength="120">
      <label>Job title</label><input name="title" required maxlength="160">
      <label>Apply URL</label><input name="applyUrl" placeholder="https://...">
      <label>Location</label><input name="location" maxlength="120">
      <label>Job description (paste it — better drafts)</label><textarea name="jdText"></textarea>
      <div style="margin-top:12px"><button class="primary">Add job</button> <a class="btn" href="/w/${w.id}">Back</a></div>
    </form>`, { workspace: w }));
});
app.post('/w/:id/add', (req, res) => {
  const w = wsOr404(req, res); if (!w) return;
  const b = req.body;
  if (!b.company || !b.title) return res.redirect(`/w/${w.id}/add`);
  addManualJob(w.id, { company: b.company.slice(0, 120), title: b.title.slice(0, 160), applyUrl: (b.applyUrl || '').trim(), location: b.location, jdText: b.jdText || '' });
  res.redirect(`/w/${w.id}`);
});

// --- Job detail: review, edit, approve/reject ---
app.get('/w/:id/job/:jobId', (req, res) => {
  const w = wsOr404(req, res); if (!w) return;
  const j = getJob(w.id, req.params.jobId);
  if (!j) return res.status(404).send(page('Not found', '<div class="empty">Job not found.</div>', { workspace: w }));
  const r = JSON.parse(j.fit_rationale || '{}'); const meta = JSON.parse(j.meta || '{}');
  const docs = ['resume', 'cover_letter', 'screening_answers'].map((k) => ({ k, d: latestDocument(w.id, j.id, k) })).filter((x) => x.d);
  const frozen = j.status === 'submitted';

  const docBlocks = docs.map(({ k, d }) => frozen
    ? `<div class="section">${esc(k.replace('_', ' '))} · v${d.version}</div><pre>${esc(d.content)}</pre>`
    : `<div class="section">${esc(k.replace('_', ' '))} · v${d.version}</div>
       <form method="post" action="/w/${w.id}/job/${j.id}/doc"><input type="hidden" name="kind" value="${esc(k)}">
       <textarea name="content" style="min-height:${k === 'cover_letter' ? 220 : 320}px">${esc(d.content)}</textarea>
       <div style="margin-top:6px"><button>Save edit (v${d.version + 1})</button></div></form>`).join('');

  res.send(page(`${j.company} — ${j.title}`, `
    <div class="card"><div class="row" style="align-items:baseline">
      <div class="score mono">${j.fit_score ?? '--'}<small>fit</small></div>
      <div style="flex:1"><div class="title">${esc(j.company)} — ${esc(j.title)}</div>
        <div class="tags">${esc(j.location || '')} · ${esc(j.status.replace('_', ' '))} · ${esc(j.channel)} channel — ${esc(j.channel_reason || '')}</div>
        ${j.apply_url ? `<div class="tags mono"><a href="${esc(j.apply_url)}" rel="noopener noreferrer nofollow" target="_blank">${esc(j.apply_url)}</a></div>` : ''}</div></div>
      ${r.matches ? `<div class="rationale"><strong>Matches:</strong> ${esc((r.matches || []).join('; '))}<br><strong>Gaps:</strong> ${esc((r.gaps || []).join('; ') || 'none')}<br>${esc(r.rationale || '')}</div>` : ''}
      ${meta.truthfulness_flag ? `<div class="warn" style="margin-top:10px"><strong>Truthfulness flag:</strong> the draft contains claims that don't trace to your profile: <span class="mono">${esc(JSON.stringify(meta.truthfulness_flag))}</span>. Fix by editing the documents below (your edit clears the flag), then approve.</div>` : ''}
    </div>
    ${docBlocks || '<div class="empty">No draft yet — run “Find &amp; draft jobs” on the dashboard.</div>'}
    <div class="row" style="margin-top:20px">
      ${!frozen && !meta.truthfulness_flag && ['pending_approval', 'tailored'].includes(j.status) ? `<form method="post" action="/w/${w.id}/job/${j.id}/approve"><button class="primary">Approve</button></form>` : ''}
      ${j.status === 'approved' ? `<form method="post" action="/w/${w.id}/job/${j.id}/submitted"><button class="primary">I applied — mark submitted</button></form>` : ''}
      <form method="post" action="/w/${w.id}/job/${j.id}/reject"><button class="danger">Reject</button></form>
      <a class="btn" href="/w/${w.id}">Back</a>
    </div>
    <p class="note" style="margin-top:12px">Approving records your decision — JobPilot never submits for you. Open the apply URL, use your resume/cover letter, then mark it submitted to track it.</p>`, { workspace: w }));
});
app.post('/w/:id/job/:jobId/doc', (req, res) => {
  const w = wsOr404(req, res); if (!w) return;
  const j = getJob(w.id, req.params.jobId); if (!j) return res.redirect(`/w/${w.id}`);
  if (j.status === 'submitted') return res.redirect(`/w/${w.id}/job/${j.id}`); // frozen
  saveDocument(w.id, j.id, req.body.kind, req.body.content, 'human:edit');
  const meta = JSON.parse(j.meta || '{}'); delete meta.truthfulness_flag;
  updateJob(w.id, j.id, { meta: JSON.stringify(meta) });
  res.redirect(`/w/${w.id}/job/${j.id}`);
});
app.post('/w/:id/job/:jobId/approve', (req, res) => {
  const w = wsOr404(req, res); if (!w) return;
  const j = getJob(w.id, req.params.jobId); if (!j) return res.redirect(`/w/${w.id}`);
  const meta = JSON.parse(j.meta || '{}');
  if (!meta.truthfulness_flag && ['pending_approval', 'tailored'].includes(j.status)) updateJob(w.id, j.id, { status: 'approved' });
  res.redirect(`/w/${w.id}/job/${j.id}`);
});
app.post('/w/:id/job/:jobId/reject', (req, res) => {
  const w = wsOr404(req, res); if (!w) return;
  const j = getJob(w.id, req.params.jobId); if (j) updateJob(w.id, j.id, { status: 'discarded' });
  res.redirect(`/w/${w.id}`);
});
app.post('/w/:id/job/:jobId/submitted', (req, res) => {
  const w = wsOr404(req, res); if (!w) return;
  const j = getJob(w.id, req.params.jobId); if (j && j.status === 'approved') updateJob(w.id, j.id, { status: 'submitted' });
  res.redirect(`/w/${w.id}/job/${j.id}`);
});

app.get('/healthz', (_req, res) => res.json({ ok: true }));

const port = process.env.PORT || 4400;
app.listen(port, '0.0.0.0', () => console.log(`JobPilot-web on :${port}`));
