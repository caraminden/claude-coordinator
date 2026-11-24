// The seam trial's enrolment (#1129): groups take turns, stay the same size, and stop at ARM_SIZE each.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ARM_SIZE, armOf, enrol, SEAM_CONTEXT_TOKENS, type SeamTrial } from '../src/seam-trial.ts';

test('only past the mark, once per minion, alternating groups, and nobody once both are full', () => {
  assert.equal(enrol(null, 1, SEAM_CONTEXT_TOKENS, 5), null);
  let t: SeamTrial | null = null;
  const arms: string[] = [];
  for (let id = 1; id <= ARM_SIZE * 2; id++) {
    const r = enrol(t, id, SEAM_CONTEXT_TOKENS + 1, id)!;
    assert.equal(r.filled, id === ARM_SIZE * 2);
    arms.push(r.arm);
    t = r.trial;
    assert.equal(enrol(t, id, 300_000, 99), null, 'enrolled once');
  }
  assert.equal(t!.since, 1);
  assert.deepEqual(arms.slice(0, 4), ['fresh', 'control', 'fresh', 'control']);
  assert.equal(t!.fresh.length, ARM_SIZE);
  assert.equal(t!.control.length, ARM_SIZE);
  assert.equal(t!.full, ARM_SIZE * 2);
  assert.equal(enrol(t, 999, 300_000, 100), null);
  assert.equal(armOf(t, 1), 'fresh');
  assert.equal(armOf(t, 2), 'control');
  assert.equal(armOf(t, 999), null);
});

test("a minion's MCP server offers fresh_session only in the fresh group", async () => {
  const { execFileSync } = await import('node:child_process');
  const names = (flag: string) => {
    const out = execFileSync(process.execPath, ['src/mcp.ts'], {
      input: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n',
      timeout: 20_000,
      env: { ...process.env, COORDINATOR_ROLE: 'thread', COORDINATOR_TICKET: '1', COORDINATOR_SEAM_TRIAL: flag },
    }).toString();
    return JSON.parse(out.split('\n').find((l) => l.includes('"id":1'))!).result.tools.map((t: { name: string }) => t.name) as string[];
  };
  assert.ok(names('1').includes('fresh_session'));
  assert.ok(!names('0').includes('fresh_session'));
});

test('the readout counts each group from enrolment: cost, compactions, reopens, strikes, already-asked', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { collect, render } = await import('../tools/seam-trial.ts');
  const { SEAM_WHY } = await import('../src/seam-trial.ts');
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE tickets (id INTEGER PRIMARY KEY, project_id INT, number INT, title TEXT, status TEXT);
    CREATE TABLE events (id INTEGER PRIMARY KEY, ticket_id INT, kind TEXT, data TEXT, created_at INT);
    CREATE TABLE turns (id INTEGER PRIMARY KEY, ticket_id INT, ended_at INT, cost_usd REAL, cache_read_tokens INT);
    INSERT INTO projects VALUES (1, 'Delve');
    INSERT INTO tickets VALUES (1, 1, 7, 'Fresh one', 'closed'), (2, 1, 8, 'Control one', 'open');
    INSERT INTO turns VALUES (1, 1, 50, 9, 1000000), (2, 1, 150, 2, 500000), (3, 2, 150, 4, 3000000);
    INSERT INTO events (ticket_id, kind, data, created_at) VALUES
      (1, 'fresh', '{"why":"${SEAM_WHY}"}', 120),
      (1, 'note', '{"text":"Claude dismissed this minion: done"}', 130),
      (1, 'user_message', '{"author":"Josh","text":"one more thing"}', 140),
      (2, 'claude', '{"type":"system","subtype":"compact_boundary"}', 120),
      (2, 'claude', '{"type":"system","subtype":"compact_boundary"}', 50),
      (2, 'strike', '{"strikes":[]}', 130),
      (2, 'user_message', '{"author":"Cara","text":"I already said use the blue one"}', 140),
      (2, 'user_message', '{"author":"Cara","text":"I already said that","from":"#3"}', 140),
      (2, 'user_message', '{"author":"System","text":"you already decided"}', 140),
      (2, 'user_message', '{"author":"Cara","text":"as I told you, no"}', 60);
  `);
  const trial = { since: 100, fresh: [{ id: 1, at: 100, context: 180_000 }], control: [{ id: 2, at: 100, context: 160_000 }] };
  const [f, c] = collect(db, trial);
  assert.equal(f.arm, 'fresh');
  assert.deepEqual([f.values['cost after enrolment'], f.values['seam fresh starts'], f.values.reopens, f.values.dismissed], [2, 1, 1, 1], 'the turn before enrolment is left out');
  assert.deepEqual([c.values.compactions, c.values.strikes, c.values['"already asked"'], c.values.reopens, c.values['cache reads after enrolment']], [1, 1, 1, 0, 3], "only after enrolment, and only a person's own words count as already asked");
  const md = render(trial, [f, c], '2026-11-20');
  assert.match(md, /^# Fresh sessions at seams: trial readout \(2026-11-20\)/);
  assert.match(md, /\| cost after enrolment \(USD, turns that ended after it\) \| \$2\.00 \| \$2\.00 \| \$4\.00 \| \$4\.00 \|/);
  assert.match(md, /\| fresh \| #7 Fresh one \| Delve \| 180k \|/);
  assert.match(md, /still enrolling/);
});
