// JobPilot-web — multi-user hosted assistant.
// An ACCOUNT (workspace) is created with email + password so people return to
// everything next time (their key, all profiles, all application history). Each
// account owns MANY named profiles — run separate searches for separate skill
// sets, each with its own history. BYO Anthropic key; never auto-submits.
import express from 'express';
import multer from 'multer';
import {
  createWorkspace, getWorkspace, getApiKey, updateSettings, setKey,
  findWorkspaceByEmail, verifyLogin,
  listProfiles, getProfile, getActiveProfile, activateProfile, createProfile, renameProfile, deleteProfile, updateProfileById,
  listJobs, getJob, updateJob, latestDocument, saveDocument, monthlySpend,
} from './store.js';
import { addManualJob, runPipeline } from './pipeline.js';
import mammoth from 'mammoth';
import { signSession, readSession } from './crypto.js';
import { page, esc, steps } from './views.js';
import { blankProfile, defaultSettings } from './defaults.js';
import { renderProfileForm, parseProfileForm, structureFromCV, mergeUpdate } from './profile.js';

const app = express();
app.disable('x-powered-by');
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });
const smartFlash = new Map();

app.use((_req, res, next) => {
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  next();
});

// --- Sessions (signed cookie; no dependency) ---
const parseCookies = (req) => Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=').map(decodeURIComponent)).filter((p) => p[0]));
const sessionWsId = (req) => readSession(parseCookies(req).jp);
const setSession = (res, wsId) => res.setHeader('Set-Cookie', `jp=${signSession(wsId)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${45 * 864e2}`);
const clearSession = (res) => res.setHeader('Set-Cookie', 'jp=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');

const hits = new Map();
function rateLimit(key, max, windowMs) {
  const nowMs = Date.now(); const e = hits.get(key);
  if (!e || nowMs > e.resetAt) { hits.set(key, { count: 1, resetAt: nowMs + windowMs }); return true; }
  if (e.count >= max) return false; e.count++; return true;
}
const clientIp = (req) => (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').toString().split(',')[0].trim();
const WS_MONTHLY_CAP = Number(process.env.JOBPILOT_WS_MONTHLY_CAP || 20);
const running = new Map();

const wsOr404 = (req, res) => {
  const w = getWorkspace(req.params.id);
  if (!w) { res.status(404).send(page('Not found', '<div class="empty">Account not found. Log in from the home page.</div>')); return null; }
  return w;
};
const profileComplete = (p) => p && p.name && p.name[0] !== '<' && (p.roles || []).some((r) => r.title && r.title[0] !== '<');

// --- Landing: log in or sign up ---
app.get('/', (req, res) => {
  const wsId = sessionWsId(req);
  if (wsId && getWorkspace(wsId)) return res.redirect(`/w/${wsId}`);
  res.send(page('Sign in', `
    <div class="hero"><h2>Hamid&#39;s Friend Agentic Job Portal</h2>
      <p>Tell it about your experience once. It finds relevant roles, ranks them, and drafts tailored
      resumes and cover letters — grounded only in facts you verify. You review and apply; it never
      submits for you. Make a few different profiles for different kinds of roles.</p></div>
    <div class="row" style="align-items:flex-start;gap:16px">
      <div class="card" style="flex:1;min-width:280px">
        <div class="section" style="margin-top:0">Create your account</div>
        <form method="post" action="/create">
          <label>Your name</label><input name="name" required maxlength="80" placeholder="Alex Rivera">
          <label>Email</label><input type="email" name="email" required placeholder="you@email.com">
          <label>Password <span class="note">— 8+ characters</span></label><input type="password" name="password" required minlength="8">
          <label>Anthropic API key <span class="note">optional now — add later in Settings</span></label>
          <input name="anthropicKey" placeholder="sk-ant-..." autocomplete="off">
          <div style="margin-top:14px"><button class="primary">Create account →</button></div>
        </form>
      </div>
      <div class="card" style="flex:1;min-width:280px">
        <div class="section" style="margin-top:0">Welcome back</div>
        <form method="post" action="/login">
          <label>Email</label><input type="email" name="email" required>
          <label>Password</label><input type="password" name="password" required>
          <div style="margin-top:14px"><button class="primary">Log in →</button></div>
        </form>
        <p class="note" style="margin-top:12px">Everything's saved to your account — your key, profiles, and application history are all here next time.</p>
      </div>
    </div>`));
});

app.post('/create', (req, res) => {
  if (!rateLimit(`create:${clientIp(req)}`, 5, 3600e3))
    return res.status(429).send(page('Slow down', '<div class="empty">Too many sign-ups from your network recently. Try again shortly.</div>'));
  const email = (req.body.email || '').trim().toLowerCase();
  const password = req.body.password || '';
  if (!email || password.length < 8) return res.status(400).send(page('Check details', `<div class="warn">Email and an 8+ character password are required. <a href="/">Back</a></div>`));
  if (findWorkspaceByEmail(email)) return res.status(400).send(page('Already registered', `<div class="warn">That email already has an account — <a href="/">log in</a> instead.</div>`));
  const id = createWorkspace({ name: (req.body.name || '').slice(0, 80), email, password, anthropicKey: (req.body.anthropicKey || '').trim() || null });
  updateProfileById(id, getActiveProfile(id).id, blankProfile());
  updateSettings(id, defaultSettings());
  setSession(res, id);
  res.redirect(`/w/${id}`);
});

app.post('/login', (req, res) => {
  if (!rateLimit(`login:${clientIp(req)}`, 10, 900e3))
    return res.status(429).send(page('Slow down', '<div class="empty">Too many attempts. Wait a few minutes.</div>'));
  const w = verifyLogin((req.body.email || '').trim(), req.body.password || '');
  if (!w) return res.status(401).send(page('Login failed', `<div class="warn">Email or password is incorrect. <a href="/">Try again</a></div>`));
  setSession(res, w.id);
  res.redirect(`/w/${w.id}`);
});

app.post('/logout', (req, res) => { clearSession(res); res.redirect('/'); });

// Profiles bar shown atop the dashboard.
function profilesBar(w, active) {
  const profs = listProfiles(w.id);
  const pills = profs.map((p) => p.id === active.id
    ? `<span class="pill core" style="font-weight:600">${esc(p.name)}</span>`
    : `<form method="post" action="/w/${w.id}/profiles/activate" style="display:inline"><input type="hidden" name="pid" value="${esc(p.id)}"><button class="pill" style="cursor:pointer;background:none">${esc(p.name)}</button></form>`).join(' ');
  return `<div class="row" style="align-items:center;gap:8px;margin-bottom:12px;flex-wrap:wrap">
    <span class="note">Profile:</span> ${pills}
    <form method="post" action="/w/${w.id}/profiles/new" style="display:inline"><input name="name" placeholder="＋ new profile name" style="width:150px;padding:4px 8px;font-size:13px"> <button class="mini">Add</button></form>
    <a class="note" href="/w/${w.id}/profiles" style="margin-left:auto">Manage profiles</a>
  </div>`;
}

// --- Dashboard (per active profile) ---
app.get('/w/:id', (req, res) => {
  const w = wsOr404(req, res); if (!w) return;
  const active = getActiveProfile(w.id);
  const profile = JSON.parse(active.profile_json || '{}');
  const run = running.get(w.id);
  const jobs = listJobs(w.id, ['pending_approval', 'tailored', 'ranked', 'approved', 'submitted'], active.id);
  const spend = monthlySpend(w.id);

  const banner = !w.anthropic_key
    ? `<div class="warn">No Anthropic API key yet — <a href="/w/${w.id}/settings">add yours in Settings</a> before running.</div>`
    : !profileComplete(profile)
      ? `<div class="warn">The “${esc(active.name)}” profile is still a template — <a href="/w/${w.id}/profile">fill it in</a> so drafts are grounded in real facts.</div>` : '';
  const runState = run && !run.result && !run.error
    ? `<div class="banner">⏳ Working… discovering, ranking, and drafting. Refresh in ~30–60s.</div>`
    : run && run.error ? `<div class="warn">Last run: ${esc(run.error)}</div>`
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

  const stepNum = !w.anthropic_key ? 1 : !profileComplete(profile) ? 2 : jobs.length === 0 ? 3 : 4;
  res.send(page('Your dashboard', `${steps(stepNum)}
    <p class="lede">Your applications for the <strong>${esc(active.name)}</strong> profile. Switch profiles or start a new search below — then review each draft, edit it, and apply.</p>
    ${profilesBar(w, active)}${banner}${runState}
    <div class="row" style="margin-bottom:16px">
      <form method="post" action="/w/${w.id}/run"><button class="primary" ${!w.anthropic_key ? 'disabled' : ''}>Find &amp; draft jobs</button></form>
      <a class="btn" href="/w/${w.id}/profile">Edit “${esc(active.name)}” profile</a>
      <a class="btn" href="/w/${w.id}/add">Add a job by URL</a>
      <span class="note">This month: $${spend.toFixed(2)} on your key</span>
    </div>
    ${cards || `<div class="empty">No jobs in “${esc(active.name)}” yet. Set target companies in Settings or paste a job URL, then “Find &amp; draft jobs”.</div>`}`, { workspace: w, nav: 'dashboard' }));
});

// --- Profile switching / management ---
app.post('/w/:id/profiles/new', (req, res) => {
  const w = wsOr404(req, res); if (!w) return;
  const pid = createProfile(w.id, req.body.name);
  updateProfileById(w.id, pid, blankProfile());
  activateProfile(w.id, pid);
  res.redirect(`/w/${w.id}/profile`);
});
app.post('/w/:id/profiles/activate', (req, res) => {
  const w = wsOr404(req, res); if (!w) return;
  activateProfile(w.id, req.body.pid);
  res.redirect(`/w/${w.id}`);
});
app.get('/w/:id/profiles', (req, res) => {
  const w = wsOr404(req, res); if (!w) return;
  const rows = listProfiles(w.id).map((p) => `
    <div class="fcard"><div class="row" style="align-items:center;gap:10px">
      <form method="post" action="/w/${w.id}/profiles/rename" class="row" style="flex:1;gap:8px;margin:0">
        <input type="hidden" name="pid" value="${esc(p.id)}"><input name="name" value="${esc(p.name)}" style="flex:1"><button class="mini">Rename</button>
      </form>
      <span class="note">${listJobs(w.id, null, p.id).length} jobs</span>
      <form method="post" action="/w/${w.id}/profiles/activate" style="margin:0"><input type="hidden" name="pid" value="${esc(p.id)}"><button class="mini">Use</button></form>
      <form method="post" action="/w/${w.id}/profiles/delete" style="margin:0"><input type="hidden" name="pid" value="${esc(p.id)}"><button class="mini danger">Delete</button></form>
    </div></div>`).join('');
  res.send(page('Profiles', `<div class="section">Your profiles</div>
    <p class="lede">Each profile is a separate search with its own résumé facts and application history — e.g. one for backend roles, one for management. Pick “Use” to switch which one the dashboard shows.</p>
    ${rows}
    <form method="post" action="/w/${w.id}/profiles/new" class="row" style="gap:8px;margin-top:8px">
      <input name="name" placeholder="New profile name" style="flex:1"><button class="primary">+ Add profile</button>
    </form>
    <div style="margin-top:16px"><a class="btn" href="/w/${w.id}">Back to dashboard</a></div>`, { workspace: w, nav: 'profiles' }));
});
app.post('/w/:id/profiles/rename', (req, res) => { const w = wsOr404(req, res); if (!w) return; renameProfile(w.id, req.body.pid, req.body.name); res.redirect(`/w/${w.id}/profiles`); });
app.post('/w/:id/profiles/delete', (req, res) => { const w = wsOr404(req, res); if (!w) return; deleteProfile(w.id, req.body.pid); res.redirect(`/w/${w.id}/profiles`); });

// --- Run pipeline for the active profile (background) ---
app.post('/w/:id/run', (req, res) => {
  const w = wsOr404(req, res); if (!w) return;
  if (!w.anthropic_key) return res.redirect(`/w/${w.id}/settings`);
  if (!rateLimit(`run:${w.id}`, 12, 3600e3))
    return res.status(429).send(page('Slow down', `<div class="empty">You've run a lot in the last hour — rest, then retry. <a href="/w/${w.id}">Back</a></div>`, { workspace: w }));
  if (monthlySpend(w.id) >= WS_MONTHLY_CAP) { running.set(w.id, { error: `Monthly cap of $${WS_MONTHLY_CAP} reached on your key.` }); return res.redirect(`/w/${w.id}`); }
  const cur = running.get(w.id);
  if (!cur || cur.result || cur.error) {
    const active = getActiveProfile(w.id);
    running.set(w.id, { startedAt: Date.now(), result: null, error: null });
    runPipeline(w.id, getApiKey(w.id), JSON.parse(active.profile_json || '{}'), JSON.parse(w.settings_json), { tailorLimit: 5, profileId: active.id })
      .then((result) => running.set(w.id, { result, error: null }))
      .catch((e) => running.set(w.id, { result: null, error: e.message }));
  }
  res.redirect(`/w/${w.id}`);
});

// --- Profile form (active profile) ---
app.get('/w/:id/profile', (req, res) => {
  const w = wsOr404(req, res); if (!w) return;
  const active = getActiveProfile(w.id);
  const flash = smartFlash.get(w.id); smartFlash.delete(w.id);
  res.send(page(`Edit “${active.name}”`, `<p class="lede">Editing the <strong>${esc(active.name)}</strong> profile · <a href="/w/${w.id}/profiles">switch or manage profiles</a>. This is the only source the AI may use — upload a CV or describe your background below, review, then Save.</p>` +
    renderProfileForm(JSON.parse(active.profile_json || '{}'), { wsId: w.id, hasKey: !!w.anthropic_key, banner: flash || '' }), { workspace: w, nav: 'profiles' }));
});
app.post('/w/:id/profile', (req, res) => {
  const w = wsOr404(req, res); if (!w) return;
  const active = getActiveProfile(w.id);
  const profile = parseProfileForm(req.body);
  const action = req.body.action || '';
  if (action) {
    if (action === 'add-role') profile.roles.push({ title: '', organization: '', start: '', end: '', facts: [] });
    else if (action === 'add-cert') profile.certifications.push({ name: '', year: '' });
    else if (action.startsWith('remove-role-')) profile.roles.splice(Number(action.slice(12)), 1);
    else if (action.startsWith('remove-cert-')) profile.certifications.splice(Number(action.slice(12)), 1);
    updateProfileById(w.id, active.id, profile);
    return res.send(page(`Edit “${active.name}”`, renderProfileForm(profile, { wsId: w.id, hasKey: !!w.anthropic_key }), { workspace: w }));
  }
  updateProfileById(w.id, active.id, profile);
  res.redirect(`/w/${w.id}`);
});
app.post('/w/:id/profile/smart', async (req, res) => {
  const w = wsOr404(req, res); if (!w) return;
  const active = getActiveProfile(w.id);
  const text = (req.body.update || '').trim();
  if (!w.anthropic_key || !text) return res.redirect(`/w/${w.id}/profile`);
  try {
    const merged = await mergeUpdate(w.id, getApiKey(w.id), JSON.parse(active.profile_json || '{}'), text);
    updateProfileById(w.id, active.id, merged);
    smartFlash.set(w.id, `<div class="banner" style="background:var(--green);color:#fff;border-radius:8px;padding:12px 16px;margin-bottom:14px">✓ Applied your update — review below and <strong>Save</strong>.</div>`);
  } catch (e) { smartFlash.set(w.id, `<div class="warn">Couldn't apply that: ${esc(e.message)}</div>`); }
  res.redirect(`/w/${w.id}/profile`);
});
app.post('/w/:id/profile/cv', upload.single('cv'), async (req, res) => {
  const w = wsOr404(req, res); if (!w) return;
  const active = getActiveProfile(w.id);
  if (!w.anthropic_key || !req.file) return res.redirect(`/w/${w.id}/profile`);
  try {
    const name = req.file.originalname || '';
    const isPdf = req.file.mimetype === 'application/pdf' || /\.pdf$/i.test(name);
    const isDocx = /officedocument\.wordprocessingml|msword/i.test(req.file.mimetype) || /\.docx?$/i.test(name);
    let src;
    if (isPdf) src = { pdfBase64: req.file.buffer.toString('base64') };
    else if (isDocx) src = { text: (await mammoth.extractRawText({ buffer: req.file.buffer })).value };
    else src = { text: req.file.buffer.toString('utf8') };
    const merged = await structureFromCV(w.id, getApiKey(w.id), JSON.parse(active.profile_json || '{}'), src);
    updateProfileById(w.id, active.id, merged);
    smartFlash.set(w.id, `<div class="banner" style="background:var(--green);color:#fff;border-radius:8px;padding:12px 16px;margin-bottom:14px">✓ Read your CV and filled “${esc(active.name)}” — review and <strong>Save</strong>.</div>`);
  } catch (e) { smartFlash.set(w.id, `<div class="warn">Couldn't read that CV: ${esc(e.message)}. Try a PDF or paste the text.</div>`); }
  res.redirect(`/w/${w.id}/profile`);
});

// --- Settings ---
app.get('/w/:id/settings', (req, res) => {
  const w = wsOr404(req, res); if (!w) return;
  res.send(page('Settings', `
    <div class="section">Anthropic API key</div>
    <p class="note">Encrypted and saved to your account, used only for your runs, never shown back. ${w.anthropic_key ? '✓ A key is set.' : 'No key set yet.'}</p>
    <form method="post" action="/w/${w.id}/key"><input name="anthropicKey" placeholder="sk-ant-... (paste to replace)" autocomplete="off">
      <div style="margin-top:8px"><button class="primary">Save key</button></div></form>
    <div class="section">Search — role keywords &amp; company watchlist</div>
    <p class="note">Which public ATS boards to poll and which titles to keep. ats is greenhouse | lever | ashby; board is the slug in the careers URL.</p>
    <form method="post" action="/w/${w.id}/settings">
      <textarea name="settings" style="min-height:280px">${esc(JSON.stringify(JSON.parse(w.settings_json), null, 2))}</textarea>
      <div style="margin-top:12px"><button class="primary">Save search settings</button> <a class="btn" href="/w/${w.id}">Back</a></div>
    </form>`, { workspace: w, nav: 'settings' }));
});
app.post('/w/:id/key', (req, res) => { const w = wsOr404(req, res); if (!w) return; const k = (req.body.anthropicKey || '').trim(); if (k) setKey(w.id, k); res.redirect(`/w/${w.id}/settings`); });
app.post('/w/:id/settings', (req, res) => {
  const w = wsOr404(req, res); if (!w) return;
  try { updateSettings(w.id, JSON.parse(req.body.settings)); }
  catch { return res.status(400).send(page('Invalid JSON', `<div class="warn">That wasn't valid JSON — <a href="/w/${w.id}/settings">go back</a>.</div>`, { workspace: w })); }
  res.redirect(`/w/${w.id}/settings`);
});

// --- Add a job manually (to the active profile) ---
app.get('/w/:id/add', (req, res) => {
  const w = wsOr404(req, res); if (!w) return;
  res.send(page('Add a job', `<div class="section">Add a job by URL</div>
    <p class="lede">Found a role yourself? Add it here and it joins your active profile's pipeline for ranking and drafting.</p>
    <form method="post" action="/w/${w.id}/add">
      <label>Company</label><input name="company" required maxlength="120">
      <label>Job title</label><input name="title" required maxlength="160">
      <label>Apply URL</label><input name="applyUrl" placeholder="https://...">
      <label>Location</label><input name="location" maxlength="120">
      <label>Job description (paste it — better drafts)</label><textarea name="jdText"></textarea>
      <div style="margin-top:12px"><button class="primary">Add job</button> <a class="btn" href="/w/${w.id}">Back</a></div>
    </form>`, { workspace: w, nav: 'add' }));
});
app.post('/w/:id/add', (req, res) => {
  const w = wsOr404(req, res); if (!w) return;
  const b = req.body; if (!b.company || !b.title) return res.redirect(`/w/${w.id}/add`);
  addManualJob(w.id, { company: b.company.slice(0, 120), title: b.title.slice(0, 160), applyUrl: (b.applyUrl || '').trim(), location: b.location, jdText: b.jdText || '' }, getActiveProfile(w.id).id);
  res.redirect(`/w/${w.id}`);
});

// --- Job detail ---
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
      ${meta.truthfulness_flag ? `<div class="warn" style="margin-top:10px"><strong>Truthfulness flag:</strong> claims that don't trace to your profile: <span class="mono">${esc(JSON.stringify(meta.truthfulness_flag))}</span>. Edit the docs below (clears the flag), then approve.</div>` : ''}
    </div>
    ${docBlocks || '<div class="empty">No draft yet — run “Find &amp; draft jobs”.</div>'}
    <div class="row" style="margin-top:20px">
      ${!frozen && !meta.truthfulness_flag && ['pending_approval', 'tailored'].includes(j.status) ? `<form method="post" action="/w/${w.id}/job/${j.id}/approve"><button class="primary">Approve</button></form>` : ''}
      ${j.status === 'approved' ? `<form method="post" action="/w/${w.id}/job/${j.id}/submitted"><button class="primary">I applied — mark submitted</button></form>` : ''}
      <form method="post" action="/w/${w.id}/job/${j.id}/reject"><button class="danger">Reject</button></form>
      <a class="btn" href="/w/${w.id}">Back</a>
    </div>
    <p class="note" style="margin-top:12px">Approving records your decision — this portal never submits for you. Open the apply URL, use your résumé/cover letter, then mark it submitted to track it.</p>`, { workspace: w }));
});
app.post('/w/:id/job/:jobId/doc', (req, res) => {
  const w = wsOr404(req, res); if (!w) return;
  const j = getJob(w.id, req.params.jobId); if (!j) return res.redirect(`/w/${w.id}`);
  if (j.status === 'submitted') return res.redirect(`/w/${w.id}/job/${j.id}`);
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
