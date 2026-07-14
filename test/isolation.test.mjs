// The single most important test: workspace data isolation. If this ever fails,
// one user could see another user's job search — a privacy breach. It creates
// two workspaces, writes to each, and asserts neither can read the other's data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.JOBPILOT_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'jpweb-'));

const store = await import('../src/store.js');
const { validateTruthfulness, classifyChannel } = await import('../src/pipeline.js');
const { parseProfileForm, normalizeProfile, renderProfileForm } = await import('../src/profile.js');

test('two workspaces cannot see each other\'s jobs or documents', () => {
  const a = store.createWorkspace({ name: 'Alice', anthropicKey: 'sk-a' });
  const b = store.createWorkspace({ name: 'Bob', anthropicKey: 'sk-b' });
  assert.notEqual(a, b);

  const ja = store.upsertJob(a, { company: 'AcmeA', title: 'Engineer', source: 'manual' });
  const jb = store.upsertJob(b, { company: 'AcmeB', title: 'Analyst', source: 'manual' });
  store.saveDocument(a, ja.id, 'resume', 'ALICE SECRET RESUME', 'test');
  store.saveDocument(b, jb.id, 'resume', 'BOB SECRET RESUME', 'test');

  // Each workspace sees only its own job.
  const aJobs = store.listJobs(a);
  const bJobs = store.listJobs(b);
  assert.equal(aJobs.length, 1);
  assert.equal(bJobs.length, 1);
  assert.equal(aJobs[0].company, 'AcmeA');
  assert.equal(bJobs[0].company, 'AcmeB');

  // Alice cannot fetch Bob's job even with the exact id.
  assert.equal(store.getJob(a, jb.id), null);
  assert.equal(store.getJob(b, ja.id), null);

  // Neither can read the other's document even with the exact job id...
  assert.equal(store.latestDocument(a, jb.id, 'resume'), null, "Alice must not read Bob's doc");
  assert.equal(store.latestDocument(b, ja.id, 'resume'), null, "Bob must not read Alice's doc");
  // ...but each reads its own.
  assert.equal(store.latestDocument(b, jb.id, 'resume').content, 'BOB SECRET RESUME');
  assert.equal(store.latestDocument(a, ja.id, 'resume').content, 'ALICE SECRET RESUME');

  // Cross-workspace update is a no-op (WHERE workspace_id filters it out).
  store.updateJob(a, jb.id, { status: 'approved' });
  assert.equal(store.getJob(b, jb.id).status, 'discovered');

  // Dedup keys are per-workspace: same company/title in both is two rows.
  store.upsertJob(a, { company: 'Shared Co', title: 'PM', source: 'manual' });
  const dup = store.upsertJob(b, { company: 'Shared Co', title: 'PM', source: 'manual' });
  assert.equal(dup.deduped, false);
});

test('email+password login returns the same account (persistence across sessions)', () => {
  const id = store.createWorkspace({ name: 'Loginy', email: 'Casey@Example.com', password: 'hunter2horse', anthropicKey: 'sk-x' });
  assert.equal(store.verifyLogin('casey@example.com', 'hunter2horse')?.id, id); // case-insensitive email
  assert.equal(store.verifyLogin('casey@example.com', 'wrong'), null);
  assert.equal(store.verifyLogin('nobody@example.com', 'hunter2horse'), null);
  assert.equal(store.findWorkspaceByEmail('CASEY@example.com')?.id, id);
  // The key persists with the account.
  assert.equal(store.getApiKey(id), 'sk-x');
});

test('one account has multiple profiles; jobs stay separate per profile', () => {
  const id = store.createWorkspace({ name: 'MultiP', email: 'm@e.com', password: 'passwordpass' });
  const def = store.getActiveProfile(id); // auto-created "Default"
  assert.ok(def);
  const backend = store.createProfile(id, 'Backend roles');
  const mgmt = store.createProfile(id, 'Management roles');
  assert.equal(store.listProfiles(id).length, 3);

  // Jobs are tagged to a profile and listed per profile.
  store.upsertJob(id, { company: 'Acme', title: 'Backend Engineer', source: 'manual', profile_id: backend });
  store.upsertJob(id, { company: 'Acme', title: 'Eng Manager', source: 'manual', profile_id: mgmt });
  assert.equal(store.listJobs(id, null, backend).length, 1);
  assert.equal(store.listJobs(id, null, mgmt).length, 1);
  assert.equal(store.listJobs(id, null, backend)[0].title, 'Backend Engineer');
  // Same company+title can exist under two different profiles (per-profile dedup).
  store.upsertJob(id, { company: 'Acme', title: 'Backend Engineer', source: 'manual', profile_id: mgmt });
  assert.equal(store.listJobs(id, null, mgmt).length, 2);

  // Switching the active profile, and deleting one (keeps ≥1, removes its jobs).
  store.activateProfile(id, backend);
  assert.equal(store.getActiveProfile(id).id, backend);
  assert.equal(store.deleteProfile(id, mgmt), true);
  assert.equal(store.listProfiles(id).length, 2);
  assert.equal(store.getJob(id, store.listJobs(id, null, backend)[0].id) != null, true);
});

test('profiles are workspace-scoped — no cross-account profile access', () => {
  const a = store.createWorkspace({ name: 'A', email: 'a1@e.com', password: 'passwordpass' });
  const b = store.createWorkspace({ name: 'B', email: 'b1@e.com', password: 'passwordpass' });
  const pa = store.getActiveProfile(a).id;
  assert.equal(store.getProfile(b, pa), null);          // B cannot read A's profile
  store.updateProfileById(b, pa, { name: 'HACK' });      // cross write is a no-op
  assert.notEqual(JSON.parse(store.getProfile(a, pa).profile_json).name, 'HACK');
});

test('per-workspace API keys are independent and encrypted at rest', () => {
  const a = store.createWorkspace({ name: 'K1', anthropicKey: 'sk-one' });
  const b = store.createWorkspace({ name: 'K2', anthropicKey: 'sk-two' });
  // Stored blob is ciphertext, not the plaintext key.
  const storedA = store.getWorkspace(a).anthropic_key;
  assert.ok(storedA.startsWith('v1:'), 'key must be encrypted at rest');
  assert.ok(!storedA.includes('sk-one'), 'plaintext key must not appear in storage');
  // Decrypts back correctly, and per-workspace.
  assert.equal(store.getApiKey(a), 'sk-one');
  assert.equal(store.getApiKey(b), 'sk-two');
  // setKey re-encrypts.
  store.setKey(a, 'sk-rotated');
  assert.equal(store.getApiKey(a), 'sk-rotated');
  assert.ok(store.getWorkspace(a).anthropic_key.startsWith('v1:'));
});

test('channel classifier keeps LinkedIn/Indeed out of automation', () => {
  assert.equal(classifyChannel('https://boards.greenhouse.io/x/jobs/1').channel, 'green');
  assert.equal(classifyChannel('https://www.linkedin.com/jobs/view/1').channel, 'yellow');
  assert.equal(classifyChannel(null).channel, 'red');
});

test('profile form parses posted fields back into the profile schema', () => {
  const body = {
    name: 'Alex Rivera', headline: 'Staff Engineer',
    email: 'a@x.com', phone: '555', linkedin: 'in/alex', contactLocation: 'SF',
    summary: 'Builder.', experienceYears: '9+', workAuthorization: 'US Citizen',
    base: 'SF Bay Area', loc: { openTo: ['remote', 'hybrid'] }, relocate: 'Yes',
    roles: { 0: { title: 'Staff Eng', organization: 'Stripe', start: '01/2022', end: 'present', facts: 'Led a team of 6\nCut latency 40%' } },
    skills: 'Go\nKubernetes\nPostgres',
    certs: { 0: { name: 'AWS SA', year: '2023' }, 1: { name: '', year: '' } },
    core: 'Staff Engineer\nPrincipal Engineer', stretch: 'Eng Manager',
    extraContext: 'Avoid crypto.',
  };
  const p = parseProfileForm(body);
  assert.equal(p.name, 'Alex Rivera');
  assert.deepEqual(p.location.openTo, ['remote', 'hybrid']);
  assert.equal(p.location.willingToRelocate, 'Yes');
  assert.equal(p.roles.length, 1);
  assert.deepEqual(p.roles[0].facts, ['Led a team of 6', 'Cut latency 40%']);
  assert.deepEqual(p.skills, ['Go', 'Kubernetes', 'Postgres']);
  assert.equal(p.certifications.length, 1); // blank cert dropped
  assert.deepEqual(p.targetRoles.core, ['Staff Engineer', 'Principal Engineer']);
  assert.equal(p.extraContext, 'Avoid crypto.');
});

test('profile normalizer and renderer tolerate empty/partial input without crashing', () => {
  const empty = normalizeProfile();
  assert.deepEqual(empty.roles, []);
  assert.deepEqual(empty.location.openTo, []);
  const html = renderProfileForm({ name: 'X', roles: [{ title: 'Dev', facts: ['did <stuff> & things'] }] }, { wsId: 'w1', hasKey: false });
  assert.match(html, /Save profile/);
  assert.match(html, /Read my CV/);
  assert.ok(html.includes('did &lt;stuff&gt; &amp; things'), 'user content is HTML-escaped');
  assert.ok(html.includes('disabled'), 'no-key state disables the smart-fill buttons');
});

test('truthfulness gate blocks fabricated numbers and credentials', () => {
  const profile = { roles: [{ facts: ['led a team of 12', 'grew revenue 30%'] }] };
  const bad = validateTruthfulness({ resume_md: 'Led a team of 40. CISSP certified.', cover_letter_md: 'Grew revenue 30%.', claims: [] }, profile);
  assert.equal(bad.pass, false);
  assert.ok(bad.failures.some((f) => f.type === 'untraceable_number' && f.token.includes('40')));
  assert.ok(bad.failures.some((f) => f.type === 'unverified_credential' && f.token === 'CISSP'));
  const good = validateTruthfulness({ resume_md: 'Led a team of 12.', cover_letter_md: 'Grew revenue 30%.', claims: [{ claim: 'team of 12', trace: 'roles[0].facts' }] }, profile);
  assert.equal(good.pass, true, JSON.stringify(good.failures));
});
