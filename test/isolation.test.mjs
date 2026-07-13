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

test('per-workspace API keys are independent', () => {
  const a = store.createWorkspace({ name: 'K1', anthropicKey: 'sk-one' });
  const b = store.createWorkspace({ name: 'K2', anthropicKey: 'sk-two' });
  assert.equal(store.getWorkspace(a).anthropic_key, 'sk-one');
  assert.equal(store.getWorkspace(b).anthropic_key, 'sk-two');
});

test('channel classifier keeps LinkedIn/Indeed out of automation', () => {
  assert.equal(classifyChannel('https://boards.greenhouse.io/x/jobs/1').channel, 'green');
  assert.equal(classifyChannel('https://www.linkedin.com/jobs/view/1').channel, 'yellow');
  assert.equal(classifyChannel(null).channel, 'red');
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
