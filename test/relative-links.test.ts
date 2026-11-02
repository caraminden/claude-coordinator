// A relative file link in a reply resolves against the sender's working directory: a minion's worktree,
// or the Taskmaster's folder. Files in the scheme's shared folder open from either, and nothing outside
// the roots does (#243).
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { App } from '../src/http.ts';
import type { Ticket } from '../src/db.ts';
import { resolveLink } from '../src/artifacts.ts';
import { resolveTicketFile } from '../src/routes/files.ts';
import { projectSharedDir } from '../src/workspace.ts';

const data = mkdtempSync(join(tmpdir(), 'relative-links-'));
after(() => rmSync(data, { recursive: true, force: true }));
const P = join(data, 'projects/3');
const app = { dataDir: data, sharedDir: (t: Ticket) => join(P, 'shared', String(t.id)) } as unknown as App;
const minion = { id: 349, project_id: 3, cwd: join(P, 'tickets/349') } as Ticket;
const taskmaster = { id: 258, project_id: 3, cwd: join(P, 'coordinator') } as Ticket;
const reports = join(projectSharedDir(data, 3), 'reports');
for (const d of [join(minion.cwd, 'docs'), taskmaster.cwd, reports, join(P, 'shared/349'), join(data, 'outside')]) mkdirSync(d, { recursive: true });
for (const f of [join(minion.cwd, 'docs/plan.md'), join(taskmaster.cwd, 'notes.md'), join(reports, 'shots.png'), join(P, 'shared/349/take.png'), join(data, 'outside/secret.png')]) writeFileSync(f, 'x');
symlinkSync(join(data, 'outside/secret.png'), join(minion.cwd, 'docs/link.png'));
const opens = async (t: Ticket, path: string) => (await resolveTicketFile(app, t, path))?.abs ?? null;

test('relative links resolve from a minion worktree, including into the scheme shared folder', async () => {
  assert.equal(await opens(minion, 'docs/plan.md'), join(minion.cwd, 'docs/plan.md'));
  assert.equal(await opens(minion, '../../shared/project/reports/shots.png'), join(reports, 'shots.png'));
  assert.equal(await opens(minion, '../../shared/349/take.png'), join(P, 'shared/349/take.png'));
  assert.equal(await opens(minion, join(reports, 'shots.png')), join(reports, 'shots.png'));
  // The Peek Auras link: one ../ short, so it lands in tickets/shared and opens nothing. The chat's link
  // check finds the one file of its name instead (#281).
  assert.equal(await opens(minion, '../shared/project/reports/shots.png'), null);
  assert.equal((await resolveLink('../shared/project/reports/shots.png', minion.cwd, [minion.cwd, reports]))?.abs, join(reports, 'shots.png'));
});

test('relative links resolve from the Taskmaster folder', async () => {
  assert.equal(await opens(taskmaster, 'notes.md'), join(taskmaster.cwd, 'notes.md'));
  assert.equal(await opens(taskmaster, '../shared/project/reports/shots.png'), join(reports, 'shots.png'));
});

test('a link escaping the roots is still refused, through .., an absolute path or a symlink', async () => {
  for (const p of ['../../../../outside/secret.png', join(data, 'outside/secret.png'), 'docs/link.png', `${minion.cwd}/../../../../outside/secret.png`]) {
    assert.equal(await opens(minion, p), null, p);
  }
  assert.equal(await opens(taskmaster, '../../../outside/secret.png'), null);
  // Only known file types.
  writeFileSync(join(minion.cwd, 'docs/run.sh'), 'x');
  assert.equal(await opens(minion, 'docs/run.sh'), null);
});
