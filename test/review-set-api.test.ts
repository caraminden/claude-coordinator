import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { agentToken, bootServer, REPO, stopProcs, stopTurns } from './helpers.ts';

const root = mkdtempSync(join(tmpdir(), 'review-set-api-'));
const procs: ChildProcess[] = [];
after(async () => {
  await stopProcs(procs);
  await stopTurns(root);
  rmSync(root, { recursive: true, force: true });
});

let base = '';
let cookie = '';

/** A request as Cara, or as the minion or Taskmaster `as` (a ticket id) with its token. */
async function call(path: string, opts: { method?: string; body?: unknown; as?: number } = {}) {
  const auth: Record<string, string> = opts.as === undefined ? { Cookie: cookie } : { Authorization: `Bearer ${agentToken(join(root, 'data'), opts.as)}` };
  const res = await fetch(base + path, {
    method: opts.method ?? 'GET',
    headers: { ...auth, ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, data: await res.json() };
}

before(async () => {
  const srv = await bootServer({ root, stdout: true });
  base = srv.base;
  cookie = srv.cookie;
  procs.push(srv.proc);
});

test("a scheme's review set: new on trial, switches, a minion's learning, History, and other schemes kept out", async () => {
  // Not Citadel: the set is keyed by scheme, and nothing here names Citadel.
  const { data: p } = await call('/api/projects', { method: 'POST', body: { name: 'Genesis Tree' } });
  const { data: other } = await call('/api/projects', { method: 'POST', body: { name: 'Other' } });
  const { data: page } = await call(`/api/projects/${p.id}`);
  const { data: otherPage } = await call(`/api/projects/${other.id}`);
  const { data: minion } = await call(`/api/projects/${p.id}/tickets`, { method: 'POST', body: { message: 'hi', properties: { type: 'chore' } } });
  const url = `/api/projects/${p.id}/reviews`;

  const empty = await call(url);
  assert.deepEqual(empty.data.entries, []);
  assert.ok(empty.data.starters.some((s: any) => s.slug === 'ui-screenshots'));

  // From a kit starter: its slug, its when, and on trial whatever the request says (Q12).
  const made = await call(url, { method: 'POST', body: { extends: 'ui-screenshots', name: 'Tree UI', trial: false } });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  assert.deepEqual([made.data.slug, made.data.trial, made.data.stage, made.data.when], ['ui-screenshots', true, 'work', 'diff: public/**, **/*.css, **/*.html']);
  assert.match(made.data.text, /^---\nname: ui-screenshots\nextends: citadel:critique\/rubrics\/ui-screenshots\n/);
  assert.equal((await call(url, { method: 'POST', body: { extends: 'no-such' } })).status, 400);
  assert.equal((await call(url, { method: 'POST', body: { extends: 'ui-screenshots' } })).status, 409);
  const blank = await call(url, { method: 'POST', body: { slug: 'claims', when: 'schedule: monthly', body: '# Claims' }, as: page.coordinator.id });
  assert.deepEqual([blank.status, blank.data.name, blank.data.stage], [201, 'Claims', 'schedule']);

  // A switch is a version; a save from an older one is refused.
  const entry = `${url}/ui-screenshots`;
  const off = await call(entry, { method: 'PATCH', body: { enabled: false, version: 1 } });
  assert.deepEqual([off.status, off.data.enabled, off.data.version], [200, false, 2]);
  const stale = await call(entry, { method: 'PATCH', body: { body: 'mine', version: 1 } });
  assert.equal(stale.status, 409);
  assert.match(stale.data.error, /at version 2 now/);

  // A minion writes what it learned into the body, and no more.
  const learned = await call(entry, { method: 'PATCH', body: { body: '## Notes\n\nA person passed the long labels.', note: 'Learned from a verdict' }, as: minion.id });
  assert.equal(learned.status, 200, JSON.stringify(learned.data));
  assert.equal((await call(entry, { method: 'PATCH', body: { enabled: true }, as: minion.id })).status, 403);
  assert.equal((await call(url, { method: 'POST', body: { slug: 'x' }, as: minion.id })).status, 403);

  const history = await call(`${entry}/versions`);
  assert.deepEqual(history.data.versions.map((v: any) => [v.version, v.note]), [[3, 'Learned from a verdict'], [2, 'Turned off'], [1, 'Made']]);
  const back = await call(`${entry}/restore`, { method: 'POST', body: { version: 1 } });
  assert.deepEqual([back.status, back.data.version, back.data.enabled, back.data.body], [200, 4, true, '']);
  assert.equal((await call(`${entry}/restore`, { method: 'POST', body: { version: 9 } })).status, 404);

  // Another scheme's Taskmaster can't read or change this one's, and its own set is empty.
  assert.equal((await call(url, { as: otherPage.coordinator.id })).status, 403);
  assert.equal((await call(entry, { method: 'PATCH', body: { enabled: false }, as: otherPage.coordinator.id })).status, 403);
  assert.deepEqual((await call(`/api/projects/${other.id}/reviews`)).data.entries, []);

  // The minion's tool: list, read one, save what it learned.
  const tool = async (args: Record<string, unknown>) => {
    const child = spawn(process.execPath, [join(REPO, 'src', 'mcp.ts')], {
      env: { ...process.env, MACHINES_URL: undefined, COORDINATOR_API: base, COORDINATOR_TOKEN: agentToken(join(root, 'data'), minion.id), COORDINATOR_PROJECT: String(p.id), COORDINATOR_TICKET: String(minion.id), COORDINATOR_ROLE: 'thread' },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    try {
      const reply = new Promise<any>((resolve) => createInterface({ input: child.stdout! }).once('line', (l) => resolve(JSON.parse(l))));
      child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'review_set', arguments: args } }) + '\n');
      const { result } = await reply;
      return { error: !!result.isError, text: result.content[0].text as string };
    } finally {
      child.kill();
    }
  };
  assert.match((await tool({})).text, /^ui-screenshots \(critic, on, trial, on kit ui-screenshots\): diff: public\/\*\*, .*\nclaims \(critic, on, trial\): schedule: monthly$/);
  assert.match((await tool({ slug: 'claims' })).text, /^claims, version 1 \(.+ saved it\)\. As the critic reads it:\n\n---\nname: claims\nwhen: "schedule: monthly"\ntrial: true\n---\n\n# Claims\n/);
  const saved = await tool({ slug: 'claims', body: '# Claims\n\n## Notes\n\nCara passed the hedged ones.', version: 1, note: 'Calibration' });
  assert.equal(saved.text, 'Saved claims as version 2.');
  assert.ok((await tool({ slug: 'claims', enabled: false })).error);
});
