// The agent pipeline, per workspace. Reuses JobPilot's core IP: compliant
// channel classification, deterministic dealbreaker filter, LLM ranking, and
// the tailoring truthfulness gate (every number/credential must trace to the
// user's own verified profile). Nothing is ever auto-submitted.
import { complete } from './llm.js';
import { upsertJob, listJobs, getJob, updateJob, saveDocument } from './store.js';

// --- Compliant channel classification (green auto-drafts, yellow assisted, red manual) ---
const CHANNEL_RULES = [
  { re: /boards\.greenhouse\.io|greenhouse\.io\/.+\/jobs/i, channel: 'green', reason: 'Greenhouse public board' },
  { re: /jobs\.lever\.co/i, channel: 'green', reason: 'Lever public board' },
  { re: /jobs\.ashbyhq\.com|ashbyhq\.com/i, channel: 'green', reason: 'Ashby public board' },
  { re: /linkedin\.com/i, channel: 'yellow', reason: 'LinkedIn, ToS prohibits automation; you apply manually' },
  { re: /indeed\.com/i, channel: 'yellow', reason: 'Indeed, ToS prohibits automation; you apply manually' },
];
export function classifyChannel(applyUrl) {
  if (!applyUrl) return { channel: 'red', reason: 'No direct apply URL, manual only' };
  for (const r of CHANNEL_RULES) if (r.re.test(applyUrl)) return { channel: r.channel, reason: r.reason };
  return { channel: 'yellow', reason: 'Unclassified career page, you apply manually' };
}

const stripHtml = (h) => (h || '').replace(/<[^>]+>/g, ' ').replace(/&\w+;/g, ' ').replace(/\s+/g, ' ').trim();
async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'JobPilot-web/0.1 (personal candidate tool)' }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}
function matchesProfile(title, profiles) {
  const t = title.toLowerCase();
  for (const p of profiles) if ((p.titleKeywords || []).some((k) => t.includes(k.toLowerCase()))) return p.name;
  return null;
}

// --- Discovery: poll the workspace's watchlist of public ATS boards ---
export async function discover(wsId, settings, profileId = null) {
  const profiles = settings.profiles || [];
  const watchlist = settings.watchlist || [];
  let ingested = 0, deduped = 0; const errors = [];
  for (const w of watchlist) {
    try {
      let recs = [];
      if (w.ats === 'greenhouse') {
        const d = await fetchJson(`https://boards-api.greenhouse.io/v1/boards/${w.board}/jobs?content=true`);
        recs = (d.jobs || []).map((j) => ({ company: w.board, title: j.title, location: j.location?.name, apply_url: j.absolute_url, jd_text: stripHtml(j.content), source: 'greenhouse' }));
      } else if (w.ats === 'lever') {
        const d = await fetchJson(`https://api.lever.co/v0/postings/${w.board}?mode=json`);
        recs = (d || []).map((j) => ({ company: w.board, title: j.text, location: j.categories?.location, apply_url: j.applyUrl || j.hostedUrl, jd_text: stripHtml(j.descriptionPlain || j.description), source: 'lever' }));
      } else if (w.ats === 'ashby') {
        const d = await fetchJson(`https://api.ashbyhq.com/posting-api/job-board/${w.board}?includeCompensation=true`);
        recs = (d.jobs || []).map((j) => ({ company: w.board, title: j.title, location: j.location, apply_url: j.applyUrl || j.jobUrl, jd_text: j.descriptionPlain || stripHtml(j.descriptionHtml), source: 'ashby' }));
      }
      for (const rec of recs) {
        if (!matchesProfile(rec.title, profiles)) continue;
        const { channel, reason } = classifyChannel(rec.apply_url);
        const { deduped: d } = upsertJob(wsId, { ...rec, channel, channel_reason: reason, profile_id: profileId });
        d ? deduped++ : ingested++;
      }
    } catch (e) { errors.push(`${w.ats}:${w.board}, ${e.message}`); }
  }
  return { ingested, deduped, errors };
}

// Manual single-job intake (paste a URL + JD)
export function addManualJob(wsId, { company, title, applyUrl, location, jdText }, profileId = null) {
  const { channel, reason } = classifyChannel(applyUrl);
  return upsertJob(wsId, { company, title, apply_url: applyUrl, location, jd_text: jdText, source: 'manual', channel, channel_reason: reason, profile_id: profileId });
}

// --- Ranking ---
const RANK_SYSTEM = `You are the Matching & Ranking agent in JobPilot, scoring a job for one candidate.
Score honestly. Read the candidate's location, work authorization, relocation stance, seniority, and
target role families from the CANDIDATE PROFILE, never assume them. Respond ONLY with JSON:
{"score":<0-100 int>,"tier":"core"|"stretch"|"discard","matches":[<3-5 short strings>],"gaps":[<1-3 short strings>],"rationale":"<2-3 sentences>"}
tier=discard if score<40 or a hard dealbreaker (clearance the candidate lacks; sponsorship the role won't give but the candidate needs; seniority far below the candidate).`;

export async function rankJob(wsId, apiKey, profile, job) {
  const r = await complete(wsId, apiKey, {
    purpose: 'matching', system: RANK_SYSTEM, maxTokens: 1200, json: true,
    prompt: `CANDIDATE PROFILE:\n${JSON.stringify(profile)}\n\nJOB:\nCompany: ${job.company}\nTitle: ${job.title}\nLocation: ${job.location || 'unknown'}\n\nJOB DESCRIPTION:\n${(job.jd_text || '(none)').slice(0, 10000)}`,
  });
  if (!Number.isFinite(r.score) || !['core', 'stretch', 'discard'].includes(r.tier)) throw new Error('Malformed ranking response');
  updateJob(wsId, job.id, { fit_score: r.score, fit_tier: r.tier, fit_rationale: JSON.stringify(r), status: r.tier === 'discard' ? 'discarded' : 'ranked' });
  return r;
}

// --- Tailoring with truthfulness gate ---
const TAILOR_SYSTEM = `You are the Tailoring agent in JobPilot, writing application materials for one candidate.
NON-NEGOTIABLE:
1. TRUTH ONLY. Reorder, re-emphasize, rephrase facts from the CANDIDATE PROFILE. NEVER invent or inflate
   employers, titles, dates, metrics, tools, certifications, or accomplishments not in the profile.
2. Every quantitative claim (numbers, %, years, team sizes, $) must be copied verbatim from the profile.
3. Align to the job by LABELED ANALOGY only ("directly analogous to…"); never rewrite a fact's purpose to mirror the JD.
4. Write like a strong human candidate. No AI boilerplate ("I am excited to apply", "proven track record", "passionate about").
5. PUNCTUATION: never use em dashes or en dashes. Use commas, colons, parentheses, or periods instead. The only dash allowed is the ordinary hyphen in compound words.
Respond ONLY with JSON:
{"resume_md":"<tailored resume, Markdown>","cover_letter_md":"<cover letter <=350 words, Markdown>","screening_answers":[{"question":"","answer":"","source":"profile"|"needs-human"}],"claims":[{"claim":"","trace":"<profile field it comes from>"}]}`;

export async function tailorJob(wsId, apiKey, profile, job) {
  const r = await complete(wsId, apiKey, {
    purpose: 'tailoring', system: TAILOR_SYSTEM, maxTokens: 20000, json: true,
    prompt: `JOB:\nCompany: ${job.company}\nTitle: ${job.title}\n\nJOB DESCRIPTION:\n${(job.jd_text || '(none)').slice(0, 10000)}\n\nCANDIDATE PROFILE (the ONLY permissible source of claims):\n${JSON.stringify(profile, null, 2)}`,
  });
  if (typeof r.resume_md !== 'string' || !r.resume_md.trim() || typeof r.cover_letter_md !== 'string' || !r.cover_letter_md.trim())
    throw new Error('Malformed tailoring response');
  const validation = validateTruthfulness(r, profile);
  saveDocument(wsId, job.id, 'resume', r.resume_md, 'agent:tailoring');
  saveDocument(wsId, job.id, 'cover_letter', r.cover_letter_md, 'agent:tailoring');
  saveDocument(wsId, job.id, 'screening_answers', JSON.stringify(r.screening_answers ?? [], null, 2), 'agent:tailoring');
  const meta = JSON.parse(job.meta || '{}');
  if (!validation.pass) meta.truthfulness_flag = validation.failures;
  else delete meta.truthfulness_flag;
  updateJob(wsId, job.id, { status: 'pending_approval', meta: JSON.stringify(meta) });
  return { validation };
}

// Deterministic truthfulness check: numbers/credentials must appear in the profile.
export function validateTruthfulness(result, profile) {
  const source = JSON.stringify(profile).toLowerCase();
  const sourceNums = new Set((source.match(/\d[\d,.]*/g) || []).map((s) => s.replace(/,/g, '').replace(/[.]+$/, '')));
  const generated = `${result.resume_md}\n${result.cover_letter_md}`;
  const failures = []; const seen = new Set();
  const flag = (type, token) => { if (!seen.has(type + token)) { seen.add(type + token); failures.push({ type, token }); } };
  const num = (s) => s.replace(/,/g, '').replace(/[.]+$/, '');
  for (const m of generated.matchAll(/(\$)?(\d[\d,.]*)\s*(%|percent\b|years?\b|yrs\b|people\b|engineers?\b|members?\b|million\b|billion\b|[kmb]\b)?/gi)) {
    const hasUnit = Boolean(m[1] || m[3]); const n = num(m[2]);
    if (!n) continue;
    if (!hasUnit && /^(19|20)\d\d$/.test(n)) continue;
    if (!hasUnit && n.length < 2) continue;
    if (!sourceNums.has(n)) flag('untraceable_number', m[0].trim());
  }
  const NOT_CERTS = new Set(['GDPR', 'GAAP', 'GLBA']);
  for (const c of new Set(generated.match(/\b(CISSP|CISM|CISA|CRISC|CCSP|CEH|OSCP|GIAC|G[A-Z]{3}|Security\+|PMP|AIGP)\b/g) || [])) {
    if (NOT_CERTS.has(c)) continue;
    if (!source.includes(c.toLowerCase())) flag('unverified_credential', c);
  }
  for (const cl of result.claims || []) if (!cl.trace || /none|n\/a|unknown/i.test(cl.trace)) flag('claim_without_trace', cl.claim);
  return { pass: failures.length === 0, failures };
}

// Run the whole pipeline for one PROFILE: discover -> rank new -> tailor top N.
// All jobs are tagged with profileId so each profile keeps its own history.
export async function runPipeline(wsId, apiKey, profile, settings, { tailorLimit = 5, profileId = null } = {}) {
  const out = { discover: null, ranked: 0, tailored: 0, errors: [] };
  if ((settings.watchlist || []).length) out.discover = await discover(wsId, settings, profileId);
  for (const job of listJobs(wsId, ['discovered'], profileId)) {
    try { await rankJob(wsId, apiKey, profile, job); out.ranked++; }
    catch (e) { out.errors.push(`rank ${job.company}/${job.title}: ${e.message}`); }
  }
  const top = listJobs(wsId, ['ranked'], profileId).filter((j) => j.fit_tier === 'core' || j.fit_tier === 'stretch').slice(0, tailorLimit);
  for (const job of top) {
    try { await tailorJob(wsId, apiKey, profile, getJob(wsId, job.id)); out.tailored++; }
    catch (e) { out.errors.push(`tailor ${job.company}/${job.title}: ${e.message}`); }
  }
  return out;
}
