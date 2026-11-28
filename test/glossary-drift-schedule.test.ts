// The monthly glossary drift check (#1774, kit/schedules/glossary-drift.md): every scheme gets one at boot, once, (seeded-once rule: standard-audit-schedules.test.ts).
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { loadTemplates } from '../src/schedules.ts';
import { addGlossaryDrifts } from '../src/standard-audits.ts';

const root = mkdtempSync(join(tmpdir(), 'glossary-drift-'));
after(() => rmSync(root, { recursive: true, force: true }));
const rows = (store: Store, id: number) => store.schedules.list(id).filter((s) => s.template === 'glossary-drift');

test('every scheme, not just Citadel, gets the check, its brief naming the scheme', () => {
  const store = new Store(join(root, 'db.sqlite'));
  const a = store.createProject('Theory of Crafting', null);
  const b = store.createProject('Plain', null);
  const lines = addGlossaryDrifts(store, '/data');
  assert.equal(lines.length, store.listProjects().length);
  for (const p of [a, b]) {
    assert.equal(rows(store, p.id).length, 1);
    assert.match(rows(store, p.id)[0].brief, new RegExp(`for ${p.name}|${p.name}`));
  }
});

test('the template is gated on activity, runs on Sonnet medium, reads only, and proposes on one card', () => {
  const t = loadTemplates().get('glossary-drift')!;
  assert.equal(t.min_minions, 3);
  assert.equal(t.model, 'claude-sonnet-5-5');
  assert.equal(t.effort, 'medium');
  assert.match(t.cron, /^\d+ \d+ \d+ \* \*$/, 'monthly');
  assert.match(t.body, /read-only/);
  assert.match(t.body, /Glossary" key under "Project facts"/);
  assert.match(t.body, /choices page/);
  assert.match(t.body, /[Ss]ynonym/);
});
