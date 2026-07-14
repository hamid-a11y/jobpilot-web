// Friendly, editable profile form (replaces the raw-JSON textarea) + the two
// Claude-powered fillers: structure an uploaded CV / pasted text, and merge a
// plain-English update. The profile is still the ONLY source the tailoring AI
// may use, so the human always reviews and Saves — nothing is auto-accepted.
import { esc } from './views.js';
import { complete } from './llm.js';

// --- Normalization: guarantee a complete, render-safe shape ---
const arr = (v) => (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : v == null || v === '' ? [] : [v]);
const lines = (v) => String(v || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

export function normalizeProfile(p = {}) {
  p = p || {};
  return {
    name: p.name || '',
    headline: p.headline || '',
    contact: {
      email: p.contact?.email || '', phone: p.contact?.phone || '',
      linkedin: p.contact?.linkedin || '', location: p.contact?.location || '',
    },
    summary: p.summary || '',
    experienceYears: p.experienceYears || '',
    workAuthorization: p.workAuthorization || '',
    location: {
      base: p.location?.base || '',
      openTo: arr(p.location?.openTo),
      willingToRelocate: p.location?.willingToRelocate || '',
    },
    roles: arr(p.roles).map((r) => ({
      title: r?.title || '', organization: r?.organization || '',
      start: r?.start || '', end: r?.end || '', facts: arr(r?.facts),
    })),
    skills: arr(p.skills),
    certifications: arr(p.certifications).map((c) => ({ name: c?.name || '', year: c?.year || '' })),
    targetRoles: { core: arr(p.targetRoles?.core), stretch: arr(p.targetRoles?.stretch) },
    extraContext: p.extraContext || '',
  };
}

// --- Parse the posted form back into a profile object ---
export function parseProfileForm(body = {}) {
  const openTo = arr(body.loc?.openTo);
  return normalizeProfile({
    name: body.name, headline: body.headline,
    contact: { email: body.email, phone: body.phone, linkedin: body.linkedin, location: body.contactLocation },
    summary: body.summary, experienceYears: body.experienceYears, workAuthorization: body.workAuthorization,
    location: { base: body.base, openTo, willingToRelocate: body.relocate },
    roles: arr(body.roles).map((r) => ({ title: r?.title, organization: r?.organization, start: r?.start, end: r?.end, facts: lines(r?.facts) })),
    skills: lines(body.skills),
    certifications: arr(body.certs).map((c) => ({ name: c?.name, year: c?.year })).filter((c) => c.name),
    targetRoles: { core: lines(body.core), stretch: lines(body.stretch) },
    extraContext: body.extraContext,
  });
}

// --- Render the form (inner HTML; server wraps it in the page shell) ---
const field = (label, name, value, { ph = '', type = 'text', hint = '' } = {}) => `
  <label>${esc(label)}${hint ? ` <span class="note">${esc(hint)}</span>` : ''}</label>
  <input type="${type}" name="${esc(name)}" value="${esc(value)}" placeholder="${esc(ph)}">`;

const OPEN_TO = ['remote', 'hybrid', 'onsite'];

export function renderProfileForm(p, { wsId, banner = '', hasKey = true } = {}) {
  p = normalizeProfile(p);
  const roleCards = p.roles.length ? p.roles.map((r, i) => `
    <div class="fcard">
      <div class="frow">
        <div style="flex:2">${field('Title', `roles[${i}][title]`, r.title, { ph: 'Senior Backend Engineer' })}</div>
        <div style="flex:2">${field('Company', `roles[${i}][organization]`, r.organization, { ph: 'Acme Corp' })}</div>
        <div style="flex:1">${field('Start', `roles[${i}][start]`, r.start, { ph: 'MM/YYYY' })}</div>
        <div style="flex:1">${field('End', `roles[${i}][end]`, r.end, { ph: 'present' })}</div>
      </div>
      <label>What you did — one bullet per line <span class="note">use EXACT numbers; every metric in your résumé must trace to a line here</span></label>
      <textarea name="roles[${i}][facts]" style="min-height:90px">${esc(p.roles[i].facts.join('\n'))}</textarea>
      <div style="margin-top:6px"><button name="action" value="remove-role-${i}" class="mini">Remove this role</button></div>
    </div>`).join('') : '<p class="note">No roles yet — add one below, or use Smart-fill to import from your CV.</p>';

  const certRows = p.certifications.length ? p.certifications.map((c, i) => `
    <div class="frow">
      <div style="flex:3">${field('Certification', `certs[${i}][name]`, c.name, { ph: 'e.g. AWS Solutions Architect' })}</div>
      <div style="flex:1">${field('Year', `certs[${i}][year]`, c.year, { ph: '2024' })}</div>
      <div style="flex:none;align-self:end"><button name="action" value="remove-cert-${i}" class="mini">✕</button></div>
    </div>`).join('') : '';

  return `
  ${banner}
  <div class="section">Smart-fill — let Claude do the typing</div>
  <div class="fcard">
    <p class="note" style="margin-top:0">Give it your CV or describe your background in your own words. It fills the form below; you review, edit, and Save. Nothing is accepted until you Save. ${hasKey ? '' : '<strong style="color:var(--red)">Add your Anthropic key in Settings first.</strong>'}</p>
    <form method="post" action="/w/${wsId}/profile/cv" enctype="multipart/form-data">
      <label>Upload your CV/résumé <span class="note">PDF, Word (.docx/.doc), or .txt — read directly, never stored as a file</span></label>
      <div class="frow" style="align-items:end">
        <input type="file" name="cv" accept=".pdf,.doc,.docx,.txt,.md" style="flex:2">
        <button class="primary" ${hasKey ? '' : 'disabled'} style="flex:none">Read my CV →</button>
      </div>
    </form>
    <form method="post" action="/w/${wsId}/profile/smart" style="margin-top:14px">
      <label>…or paste your LinkedIn profile text / any bio, or just describe an update <span class="note">e.g. “I just moved to a Staff role at Stripe and led a 6-person team”</span></label>
      <textarea name="update" placeholder="Paste your LinkedIn 'About' + experience, or type what's new…"></textarea>
      <div style="margin-top:8px"><button class="primary" ${hasKey ? '' : 'disabled'}>Apply to my profile →</button></div>
    </form>
    <p class="note">We never log into LinkedIn for you (that risks your account). To import it, copy your profile text, or download your data: LinkedIn → Settings → Data Privacy → <em>Get a copy of your data</em>, then paste it here.</p>
  </div>

  <form method="post" action="/w/${wsId}/profile">
    <div class="section">Basics</div>
    <div class="fcard">
      <div class="frow">
        <div style="flex:1">${field('Full name', 'name', p.name, { ph: 'Alex Rivera' })}</div>
        <div style="flex:2">${field('Headline', 'headline', p.headline, { ph: 'Senior Backend Engineer · Distributed Systems' })}</div>
      </div>
      <div class="frow">
        <div style="flex:1">${field('Email', 'email', p.contact.email, { type: 'email' })}</div>
        <div style="flex:1">${field('Phone', 'phone', p.contact.phone)}</div>
      </div>
      <div class="frow">
        <div style="flex:1">${field('LinkedIn URL', 'linkedin', p.contact.linkedin, { ph: 'linkedin.com/in/…' })}</div>
        <div style="flex:1">${field('Location', 'contactLocation', p.contact.location, { ph: 'City, State' })}</div>
      </div>
      <label>Professional summary <span class="note">2–3 sentences, real and specific</span></label>
      <textarea name="summary">${esc(p.summary)}</textarea>
    </div>

    <div class="section">Work authorization &amp; location</div>
    <div class="fcard">
      <div class="frow">
        <div style="flex:1">${field('Years of experience', 'experienceYears', p.experienceYears, { ph: '8+' })}</div>
        <div style="flex:2">${field('Work authorization', 'workAuthorization', p.workAuthorization, { ph: 'US Citizen — no sponsorship required' })}</div>
      </div>
      <div class="frow">
        <div style="flex:1">${field('Based in', 'base', p.location.base, { ph: 'San Francisco Bay Area' })}</div>
        <div style="flex:1"><label>Open to</label>
          <div class="checks">${OPEN_TO.map((o) => `<label class="chk"><input type="checkbox" name="loc[openTo][]" value="${o}" ${p.location.openTo.includes(o) ? 'checked' : ''}> ${o}</label>`).join('')}</div>
        </div>
        <div style="flex:none"><label>Relocate?</label>
          <select name="relocate"><option value=""></option>${['Yes', 'No'].map((v) => `<option ${p.location.willingToRelocate === v ? 'selected' : ''}>${v}</option>`).join('')}</select>
        </div>
      </div>
    </div>

    <div class="section">Experience</div>
    ${roleCards}
    <div style="margin:8px 0 4px"><button name="action" value="add-role">+ Add a role</button></div>

    <div class="section">Skills — one per line</div>
    <div class="fcard"><textarea name="skills" style="min-height:110px">${esc(p.skills.join('\n'))}</textarea></div>

    <div class="section">Certifications</div>
    <div class="fcard">${certRows}<div style="margin-top:6px"><button name="action" value="add-cert">+ Add a certification</button></div></div>

    <div class="section">Target roles — one per line</div>
    <div class="fcard"><div class="frow">
      <div style="flex:1"><label>Core (strongest fit)</label><textarea name="core" style="min-height:90px">${esc(p.targetRoles.core.join('\n'))}</textarea></div>
      <div style="flex:1"><label>Stretch (aspirational)</label><textarea name="stretch" style="min-height:90px">${esc(p.targetRoles.stretch.join('\n'))}</textarea></div>
    </div></div>

    <div class="section">Anything else — extra context for a better search</div>
    <div class="fcard"><textarea name="extraContext" placeholder="Preferences, industries to avoid, must-haves, visa timing, comp expectations, anything the AI should weigh…">${esc(p.extraContext)}</textarea></div>

    <div class="actions" style="position:sticky;bottom:0;background:var(--paper);padding:12px 0;border-top:1px solid var(--line);margin-top:16px">
      <button class="primary">Save profile</button>
      <a class="btn" href="/w/${wsId}">Back to dashboard</a>
    </div>
  </form>`;
}

// --- Claude fillers ---
const SCHEMA_HINT = `Return ONLY JSON matching this exact shape (omit nothing; use "" or [] when unknown):
{"name":"","headline":"","contact":{"email":"","phone":"","linkedin":"","location":""},"summary":"","experienceYears":"","workAuthorization":"","location":{"base":"","openTo":["remote"|"hybrid"|"onsite"],"willingToRelocate":"Yes"|"No"|""},"roles":[{"title":"","organization":"","start":"MM/YYYY","end":"present or MM/YYYY","facts":["accomplishment with EXACT numbers"]}],"skills":[""],"certifications":[{"name":"","year":""}],"targetRoles":{"core":[""],"stretch":[""]},"extraContext":""}`;
const RULES = `Rules: use ONLY facts present in the source — never invent employers, titles, dates, numbers, or certifications. Copy numbers verbatim. Keep any existing CURRENT PROFILE values unless the source clearly updates them. Merge, don't wipe.`;

export async function structureFromCV(wsId, apiKey, current, { pdfBase64 = null, text = '' }) {
  const merged = await complete(wsId, apiKey, {
    purpose: 'profile-cv', json: true, maxTokens: 8000, pdfBase64,
    system: `You extract a job-candidate profile from their CV into a strict schema. ${RULES}`,
    prompt: `${SCHEMA_HINT}\n\nCURRENT PROFILE (preserve verified values, fill gaps, update where the CV is clearly newer):\n${JSON.stringify(normalizeProfile(current))}\n\n${pdfBase64 ? 'The CV is attached as a PDF document.' : `CV TEXT:\n${text.slice(0, 40000)}`}`,
  });
  return normalizeProfile(merged);
}

export async function mergeUpdate(wsId, apiKey, current, updateText) {
  const merged = await complete(wsId, apiKey, {
    purpose: 'profile-update', json: true, maxTokens: 8000,
    system: `You merge a candidate's plain-English update (or pasted profile text) into their existing profile. ${RULES}`,
    prompt: `${SCHEMA_HINT}\n\nCURRENT PROFILE:\n${JSON.stringify(normalizeProfile(current))}\n\nUPDATE / PASTED TEXT FROM THE CANDIDATE:\n${String(updateText).slice(0, 40000)}`,
  });
  return normalizeProfile(merged);
}
