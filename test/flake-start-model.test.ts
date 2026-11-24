import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { FlakeFixes } from '../src/flake-fixes.ts';
import { TIERS } from '../public/model-table.js';

// The flake auto-starter (#1719): 61 "Flaky test" minions ran on the default Opus high because its start named no model.
const root = mkdtempSync(join(tmpdir(), 'flake-start-model-'));
after(() => rmSync(root, { recursive: true, force: true }));

test("an auto-started flake minion carries the model table's intermittent-bug model and effort", async () => {
  const st = new Store(join(root, 'c.db'));
  const project = st.createProject('P', null);
  const day = new Date(Date.now() - 3_600_000).toISOString().slice(0, 10);
  mkdirSync(join(root, 'shared', 'retro-log', day), { recursive: true });
  const t = new Date(Date.now() - 3_600_000).toISOString().slice(11, 19);
  writeFileSync(join(root, 'shared', 'retro-log', day, 'land.md'), [1, 2, 3].map(() => `- ${t}Z · flake · test/x.test.ts · load 9.0 · ticket/1-x · in CI`).join('\n') + '\n');
  const briefs: { model?: string | null; effort?: string | null }[] = [];
  const fx = new FlakeFixes({
    store: st,
    sharedDir: () => join(root, 'shared'),
    start: async (_p, b) => {
      briefs.push(b);
      return { id: st.createTicket({ project_id: project.id, title: b.title, permission_mode: 'x', created_by: 'T' }).id };
    },
    runs: async () => [],
    jobs: async () => [],
  });
  await fx.tick([project]);
  const row = TIERS.find((r) => /intermittent/.test(r.work))!;
  assert.equal(briefs.length, 1);
  assert.equal(briefs[0].model, row.model);
  assert.equal(briefs[0].effort, row.effort);
});

test("server.ts hands the flake brief's model and effort to newMinion", () => {
  const src = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
  const call = /new FlakeFixes\(\{[\s\S]*?newMinion\(([^\n]*)\n/.exec(src)?.[1] ?? '';
  assert.match(call, /model: brief\.model/);
  assert.match(call, /effort: brief\.effort/);
});
