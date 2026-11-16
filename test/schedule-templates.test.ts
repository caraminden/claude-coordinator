// The standard audits' templates (#799): kit/schedules/*.md, rendered per scheme at run time.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../src/db.ts';
import { loadTemplates, nextRun, parseCron, renderTemplate, staggerCron, templateFields } from '../src/schedules.ts';

const vars = { scheme: 'Genesis Tree', citadelShared: '/data/projects/2/shared/project' };

test('every kit template parses, says when it applies, and renders with nothing left to fill in', () => {
  const all = loadTemplates();
  assert.deepEqual([...all.keys()].sort(), ['code-health', 'monthly-retro', 'test-audit', 'upstream-check']);
  for (const [slug, t] of all) {
    assert.ok(t.name && t.type && t.model && t.effort, slug);
    assert.ok(t.applies.length > 20, `${slug} says when a scheme gets it`);
    parseCron(t.cron);
    // Every slot a scheme could take is a real cron: twelve schemes and well past the wrap.
    for (let k = 0; k < 40; k++) assert.ok(nextRun(staggerCron(t.cron, t.stagger, k), Date.now()), `${slug} slot ${k}`);
    const text = renderTemplate(t, 'Merges wait for a go.', vars);
    assert.doesNotMatch(text, /\{[a-z_]+\}/, `${slug} leaves a placeholder`);
    assert.match(text, /Genesis Tree/);
    assert.ok(text.endsWith('\n\nFor Genesis Tree:\nMerges wait for a go.'), slug);
  }
});

test('notes are optional, and a placeholder the renderer does not know is refused rather than sent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tpl-'));
  try {
    writeFileSync(join(dir, 'x.md'), '---\nname: X\ntype: chore\nmodel: claude-sonnet-5-5\neffort: low\nmin_minions:\ncron: 0 5 * * *\nstagger: 10m within 120m\napplies: always\n---\nCheck {scheme}, see {nope}.\n');
    writeFileSync(join(dir, 'y.md'), '---\nname: Y\ntype: chore\nmodel: claude-sonnet-5-5\neffort: low\nmin_minions: 3\ncron: 0 5 * * *\nstagger: 1d within 28d\napplies: always\n---\nCheck {scheme} in {citadel_shared}.\n');
    const t = loadTemplates(dir);
    assert.equal(t.get('x')!.min_minions, null);
    assert.equal(t.get('y')!.min_minions, 3);
    assert.equal(renderTemplate(t.get('y')!, '  ', vars), 'Check Genesis Tree in /data/projects/2/shared/project.');
    assert.throws(() => renderTemplate(t.get('x')!, '', vars), /\{nope\}/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stagger moves each scheme to its own slot and wraps inside the window', () => {
  assert.equal(staggerCron('0 5 * * *', '10m within 120m', 0), '0 5 * * *');
  assert.equal(staggerCron('0 5 * * *', '10m within 120m', 1), '10 5 * * *');
  assert.equal(staggerCron('0 5 * * *', '10m within 120m', 11), '50 6 * * *');
  assert.equal(staggerCron('0 5 * * *', '10m within 120m', 12), '0 5 * * *', 'the 13th scheme shares the first slot');
  assert.equal(staggerCron('0 23 * * *', '30m within 120m', 3), '30 0 * * *', 'past midnight wraps the hour');
  assert.equal(staggerCron('0 7 1 * *', '1d within 28d', 0), '0 7 1 * *');
  assert.equal(staggerCron('0 7 1 * *', '1d within 28d', 27), '0 7 28 * *');
  assert.equal(staggerCron('0 7 1 * *', '1d within 28d', 28), '0 7 1 * *');
  assert.equal(staggerCron('0 7 15 * *', '1d within 14d', 13), '0 7 28 * *', 'never past the 28th, so every month has it');
  assert.equal(staggerCron('0 7 15 * *', '1d within 14d', 14), '0 7 15 * *');
  assert.throws(() => staggerCron('0 7 * * *', '1d within 28d', 1), /day/);
  assert.throws(() => staggerCron('0 7 1 * *', 'often', 1), /stagger/);
});

test("a template's fields seed the row: its slot by scheme id, its defaults, and the rendered brief", () => {
  const t = loadTemplates().get('code-health')!;
  const f = templateFields(t, { id: 9, name: 'Genesis Tree' }, 'Never push.', vars);
  assert.equal(f.cron, '20 6 * * *');
  assert.deepEqual([f.name, f.type, f.model, f.effort, f.min_minions, f.template, f.notes], ['Code health', 'research', 'claude-opus-5-5', 'medium', 40, 'code-health', 'Never push.']);
  assert.equal(f.brief, renderTemplate(t, 'Never push.', vars));
});

test('a templated row keeps its template and notes; a whole new brief detaches it into a custom copy', () => {
  const store = new Store(':memory:');
  const p = store.createProject('Genesis Tree', null);
  const t = loadTemplates().get('test-audit')!;
  const s = store.schedules.create({ project_id: p.id, ...templateFields(t, p, 'vitest only.', vars), created_by: 'Cara' });
  assert.deepEqual([s.template, s.notes, s.cron], ['test-audit', 'vitest only.', '0 7 1 * *']);
  const notes = store.schedules.update(s.id, { notes: 'vitest and pytest.', brief: renderTemplate(t, 'vitest and pytest.', vars) });
  assert.deepEqual([notes.template, notes.notes], ['test-audit', 'vitest and pytest.']);
  const detached = store.schedules.update(s.id, { brief: 'My own audit.' });
  assert.deepEqual([detached.template, detached.notes, detached.brief], [null, '', 'My own audit.']);
});

test('the backfill rewires named copies in place, adds only the picked audits, skips unlisted schemes, and runs once', async () => {
  const { backfillStandardAudits, BACKFILL_KEY } = await import('../src/standard-audits.ts');
  const store = new Store(':memory:');
  const cara = store.createUser({ name: 'Cara', login: 'cara', admin: true });
  const alex = store.createUser({ name: 'Alex', login: 'alex' });
  const delve = store.createProject('Delve', null, cara.id);
  const citadel = store.createProject('Citadel', null, cara.id);
  const threadspace = store.createProject('Threadspace', null, cara.id);
  const scaffold = store.createProject('TWIReader', null, cara.id);
  const genesis = store.createProject('Genesis Tree', null, alex.id);
  const row = (project_id: number, name: string, extra = {}) => store.schedules.create({ project_id, name, cron: '0 9 1 * *', brief: 'old copy', type: 'research', created_by: 'Taskmaster', ...extra });
  const up = row(citadel.id, 'Upstream skills check');
  store.schedules.update(up.id, { paused: true });
  store.schedules.ran(up.id, { ticketId: store.createTicket({ project_id: citadel.id, title: 'run', permission_mode: 'bypassPermissions', created_by: 'Cara' }).id });
  const lastRun = store.schedules.get(up.id)!.last_run_at;
  const odd = row(genesis.id, 'Upstream check of copied skills');
  const other = row(citadel.id, 'Daily pipeline check');

  const lines = backfillStandardAudits(store, '/data');
  const by = (p: number) => store.schedules.list(p).map((s) => s.template).filter(Boolean).sort();
  assert.deepEqual(by(delve.id), ['code-health', 'monthly-retro', 'test-audit', 'upstream-check']);
  assert.deepEqual(by(citadel.id), ['code-health', 'monthly-retro', 'test-audit', 'upstream-check']);
  assert.deepEqual(by(threadspace.id), ['monthly-retro', 'upstream-check'], 'a notes vault gets no code or test audit');
  assert.deepEqual(by(scaffold.id), [], 'a scaffold picks its own in setup');

  const rewired = store.schedules.get(up.id)!;
  assert.deepEqual([rewired.template, rewired.name, rewired.paused, rewired.last_run_at, rewired.cron], ['upstream-check', 'Upstream skills check', 1, lastRun, '10 9 1 * *']);
  assert.match(rewired.notes, /skills-survey/);
  assert.match(rewired.brief, /^Run the citadel:upstream-check skill on Citadel's repo/);
  assert.equal(store.schedules.get(odd.id)!.name, 'Upstream skills check', 'renamed to the standard name');
  assert.equal(store.schedules.get(other.id)!.template, null, "a scheme's own schedule is left alone");
  const added = store.schedules.list(genesis.id).find((s) => s.template === 'code-health')!;
  assert.deepEqual([added.created_by, added.notes, added.model, added.min_minions], ['Alex', 'Never push.', 'claude-opus-5-5', 40]);
  assert.ok(lines.some((l) => l.includes('Genesis Tree: added "Code health"')));
  assert.ok(store.getSetting(BACKFILL_KEY));

  // Once: a deleted audit stays deleted.
  store.schedules.remove(added.id);
  assert.deepEqual(backfillStandardAudits(store, '/data'), []);
  assert.ok(!store.schedules.list(genesis.id).some((s) => s.template === 'code-health'));
});

test("the Taskmaster's audit tools offer exactly the kit's templates", async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(join(import.meta.dirname, '..', 'src', 'mcp.ts'), 'utf8');
  const listed = [...src.match(/export const SCHEDULE_TEMPLATES = \[([^\]]*)\]/)![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(listed.sort(), [...loadTemplates().keys()].sort());
});
