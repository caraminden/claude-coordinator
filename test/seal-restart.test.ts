import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { agentToken, bootServer } from './helpers.ts';
import { until } from './wait.ts';

// A seal set while a turn runs outlasts a restart that cuts the turn off (#1958): the turn that carries it on wakes
// nobody, so only what a person or a wake queued unseals the minion, as at the turn's own end.
test('a minion sealed during a turn a restart cut off stays sealed through the turn that carries it on', async () => {
  const root = mkdtempSync(join(resolve(tmpdir()), 'seal-restart-'));
  const fake = join(root, 'claude-fake');
  const log = join(root, 'prompts.log');
  // Logs its prompt and waits; a SILENT minion's dies with no line written, so its batch runs again, not a resume.
  writeFileSync(
    fake,
    `#!${process.execPath}
const { appendFileSync, existsSync } = require('node:fs');
require('node:readline').createInterface({ input: process.stdin }).once('line', (input) => {
  if (existsSync(${JSON.stringify(join(root, 'release'))})) {
    console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' }));
    appendFileSync(${JSON.stringify(log)}, input + '\\n');
    process.exit(0);
  }
  if (!input.includes('SILENT')) console.log(JSON.stringify({ type: 'system', subtype: 'init' }));
  appendFileSync(${JSON.stringify(log)}, input + '\\n');
});
setInterval(() => {}, 1000);
`,
  );
  chmodSync(fake, 0o755);
  const env = { CLAUDE_BIN: fake };
  const prompts = () => (existsSync(log) ? readFileSync(log, 'utf8') : '');
  let s = await bootServer({ root, env });
  try {
    const { data: p } = await s.call('/api/projects', { name: 'Delve' });
    const tm = (await s.call(`/api/projects/${p.id}`)).data.coordinator;
    const taskmaster = s.as({ token: agentToken(s.data, tm.id) });
    const create = async (message: string) => (await s.call(`/api/projects/${p.id}/tickets`, { title: message, message })).data.id as number;
    const ticket = async (id: number) => (await s.call(`/api/tickets/${id}`)).data.ticket;
    const resumed = await create('resumed-brief');
    const rerun = await create('rerun-brief SILENT');
    const woken = await create('woken-brief');
    for (const m of ['resumed-brief', 'rerun-brief SILENT', 'woken-brief']) await until(`${m} to reach claude`, () => prompts().includes(m));
    const db = new DatabaseSync(join(s.data, 'coordinator.db'), { readOnly: true, timeout: 30_000 });
    const readALine = (id: number) => JSON.parse(String(db.prepare('SELECT value FROM settings WHERE key = ?').get(`turn:${id}`)?.value ?? '{}')).offset > 0;
    for (const id of [resumed, woken]) await until('its first line to be read', () => readALine(id));
    db.close();
    for (const [id, by] of [
      [resumed, s.call],
      [rerun, taskmaster],
      [woken, s.call],
    ] as const) {
      const r = await by(`/api/tickets/${id}`, { state: 'sealed', note: 'until Monday' }, 'PATCH');
      assert.equal(r.status, 200, JSON.stringify(r.data));
      assert.equal((await ticket(id)).state, 'parked');
    }
    // Kept for a turn of its own, which unseals it whether or not a restart comes first.
    assert.equal((await s.call(`/api/tickets/${woken}/messages`, { text: 'wake-up-call', after: true })).status, 202);
    await s.stop(); // its turns go with it
    writeFileSync(log, '');
    writeFileSync(join(root, 'release'), '');

    s = await bootServer({ root, env });
    await until('the three to run again', () => prompts().split('\n').filter(Boolean).length >= 3);
    await until('their turns to end', async () => {
      const all = await Promise.all([resumed, rerun, woken].map(ticket));
      return all.every((t) => t.status === 'idle');
    });
    assert.match(prompts(), /server restarted while you were working/, 'one resumed');
    assert.match(prompts(), /rerun-brief SILENT/, 'one ran its batch again');
    assert.match(prompts(), /wake-up-call/);
    for (const [id, what] of [
      [resumed, 'resumed'],
      [rerun, 'ran again'],
    ] as const) {
      const t = await ticket(id);
      assert.equal(t.state, 'parked', `${what}: still sealed`);
      assert.equal(t.note, 'until Monday');
    }
    assert.equal((await ticket(woken)).state, null, 'a message queued for it unseals it');
    // Sealed still, it is woken as ever: a person's Unseal, and a message that wakes.
    assert.equal((await s.call(`/api/tickets/${resumed}/messages`, { text: 'up again', unpark: true })).status, 202);
    await until('the message to reach claude', () => prompts().includes('up again'));
    assert.equal((await ticket(resumed)).state, null);
  } finally {
    await s.stop();
    rmSync(root, { recursive: true, force: true }); // timing-ok: own temp dir
  }
});
