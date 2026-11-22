import assert from 'node:assert/strict';
import { execFileSync, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Store } from '../src/db.ts';
import { GLOBAL_OWNER } from '../src/properties.ts';
import { bootServer, jsonLines, stopProcs, stopTurns, until, ok, type Booted } from './helpers.ts';

// Host tools (#1147, Josh: "Minion proposes, owner approves"): a minion in any scheme proposes a tool, a member of the
// Citadel scheme approves it on a card, the server installs it with mise and a chore minion in the Citadel scheme ships
// its line in deploy/host-tools.json. Through the real server, with stand-ins for `claude -p`, mise and land.sh.
const root = mkdtempSync(join(tmpdir(), 'host-tool-cards-'));
const procs: ChildProcess[] = [];
after(async () => {
  await stopProcs(procs);
  await stopTurns(root);
  rmSync(root, { recursive: true, force: true });
});

const fakeClaude = join(root, 'claude-fake');
writeFileSync(fakeClaude, `#!${process.execPath}
const { appendFileSync } = require('node:fs');
const { createInterface } = require('node:readline');
createInterface({ input: process.stdin }).once('line', (prompt) => {
  appendFileSync(${JSON.stringify(join(root, 'turns.jsonl'))}, JSON.stringify({ token: process.env.COORDINATOR_TOKEN }) + '\\n');
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' }));
  process.exit(0);
});
`);
chmodSync(fakeClaude, 0o755);
// mise: records each call; a package called "broken" fails as a missing one would.
const miseLog = join(root, 'mise.log');
const fakeMise = join(root, 'mise');
writeFileSync(fakeMise, `#!/bin/sh\necho "$*" >> ${miseLog}\ncase "$5" in *broken*) echo 'npm: no such package' >&2; exit 1;; esac\n`);
chmodSync(fakeMise, 0o755);

// Citadel's repo, whose land.sh records what it would ship.
const landLog = join(root, 'land.log');
const repo = join(root, 'citadel-repo');
mkdirSync(join(repo, 'tools'), { recursive: true });
mkdirSync(join(repo, 'deploy'));
writeFileSync(join(repo, 'deploy', 'host-tools.json'), '[]\n');
writeFileSync(join(repo, 'tools', 'land.sh'), `{ git log -1 --format=%s; cat deploy/host-tools.json; } > ${landLog}.part && mv ${landLog}.part ${landLog}\n`);
const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@x', ...args], { cwd: repo });
git('init', '-q', '-b', 'main');
git('add', '-A');
git('commit', '-qm', 'start');

let base = '';
const cookies: Record<string, string> = {};
const ids: Record<string, number> = {};
let ticket: any;

let srv: Booted;
const call = async (who: string, path: string, opts: { method?: string; body?: unknown } = {}) =>
  ok(await srv.as(who === 'minion' ? { token: live() } : { cookie: cookies[who] })(path, opts.body || undefined, opts.method ?? 'GET'));

const turns = () => jsonLines(join(root, 'turns.jsonl'));
const live = () => turns().filter((t) => t.token.startsWith(`${ticket.id}.`)).at(-1).token;
// Nothing queued too: a message that came in during a turn waits out its save with the minion not running, and the
// next turn's token would log out the one live() last saw.
// The status is the runner's live turns (#1618), not the row's, which on a loaded box still said idle for a minion
// whose turn -- and whose only working token -- had started.
const idle = () => until('the turn to end', async () => {
  const { ticket: t } = await call('Cara', `/api/tickets/${ticket.id}`);
  return t.status !== 'running' && t.queued === 0;
});
const events = async (kind: string) => (await call('Cara', `/api/tickets/${ticket.id}/events?after=0`)).filter((e: any) => e.kind === kind).map((e: any) => JSON.parse(e.data));
const propose = (body: object) => call('minion', `/api/tickets/${ticket.id}/host-tool`, { method: 'POST', body });
const verdict = (who: string, planId: string, v: 'approve' | 'revise', notes?: string) => call(who, `/api/tickets/${ticket.id}/verdict`, { method: 'POST', body: { planId, verdict: v, notes } });
const lastMessage = async () => (await events('user_message')).at(-1).text;
const miseCalls = () => (existsSync(miseLog) ? readFileSync(miseLog, 'utf8').trim().split('\n') : []);
const pyright = { source: 'npm', package: 'pyright', version: '1.1.414', why: 'type-check the Python tools' };

before(async () => {
  srv = await bootServer({ root, env: { CLAUDE_BIN: fakeClaude, CITADEL_MISE: fakeMise } });
  base = srv.base;
  cookies.Cara = srv.cookie;
  procs.push(srv.proc);
  const delve = await call('Cara', '/api/projects', { method: 'POST', body: { name: 'Delve' } });
  const citadel = await call('Cara', '/api/projects', { method: 'POST', body: { name: 'Citadel' } });
  assert.equal(citadel.id, GLOBAL_OWNER, 'the second scheme made is the one whose members approve');
  const store = new Store(join(srv.data, 'coordinator.db'));
  store.setProjectRepoDir(citadel.id, repo);
  // Josh is in the Citadel scheme only; Dana is in Delve only, and asks for the minion that proposes.
  for (const [name, scheme] of [['Josh', citadel.id], ['Dana', delve.id]] as const) {
    const made = await call('Cara', '/api/people', { method: 'POST', body: { name } });
    ids[name] = made.person.id;
    const res = await fetch(`${base}/api/invite/${made.token}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: `${name}-password-1` }) });
    cookies[name] = res.headers.get('set-cookie')!.split(';')[0];
    await call('Cara', `/api/projects/${scheme}/members`, { method: 'POST', body: { person: made.person.id } });
    store.updateUser(made.person.id, { server_login: 1 });
  }
  ticket = await call('Dana', `/api/projects/${delve.id}/tickets`, { method: 'POST', body: { message: 'needs pyright' } });
  await until('the first turn', () => turns().length >= 1);
  await idle();
});

test('a minion in any scheme proposes a host tool as a card showing the exact command; bad proposals are refused', async () => {
  const { id, href } = await propose(pyright);
  assert.match(href, /\?e=\d+$/);
  const [card] = await events('plan');
  assert.equal(card.id, id);
  assert.equal(card.summary, 'Install npm:pyright@1.1.414 on the server');
  assert.deepEqual(card.hostTool, { ...pyright, command: 'mise use -g --pin npm:pyright@1.1.414' });
  assert.match(card.plan, /type-check the Python tools/);
  assert.match(card.plan, /mise use -g --pin npm:pyright@1\.1\.414/);
  await assert.rejects(propose({ ...pyright, version: 'latest' }), /400 version must be one exact version/);
  await assert.rejects(propose({ ...pyright, package: 'x; rm -rf ~' }), /400/);
  await assert.rejects(call('Dana', `/api/tickets/${ticket.id}/host-tool`, { method: 'POST', body: pyright }), /403/);
});

test('only a member of the Citadel scheme approves; a rejection installs nothing', async () => {
  const [{ id }] = await events('plan');
  await assert.rejects(verdict('Dana', id, 'approve'), /403 Only a member of the Citadel scheme can approve installing software on the server/);
  await verdict('Dana', id, 'revise', 'Use the one in the repo');
  assert.equal((await events('plan'))[0].status, 'rejected');
  assert.equal(await lastMessage(), 'Rejected installing npm:pyright@1.1.414; nothing was installed.\n\nUse the one in the repo');
  await assert.rejects(verdict('Josh', id, 'approve'), /409/);
  await idle();
  assert.deepEqual(miseCalls(), [], 'nothing ran');
  assert.equal(existsSync(landLog), false, 'nothing shipped');
});

test('an approval installs it with mise, and a chore minion in the Citadel scheme ships its line', async () => {
  const { id } = await propose(pyright);
  await verdict('Josh', id, 'approve');
  await until('the list ships', () => existsSync(landLog));
  assert.deepEqual(miseCalls(), ['use -g --pin --yes npm:pyright@1.1.414']);
  const [subject, ...list] = readFileSync(landLog, 'utf8').trim().split('\n');
  const [, chore] = subject.match(/^#(\d+): list host tool npm:pyright@1\.1\.414, approved by Josh for Delve #1$/) ?? [];
  assert.ok(chore, subject);
  assert.deepEqual(JSON.parse(list.join('\n')), [{ ...pyright, approved_by: 'Josh', approved_on: list.join('').match(/\d{4}-\d\d-\d\d/)![0], asked_by: 'Delve #1' }]);
  await until('the minion hears', async () => /^Installed npm:pyright@1\.1\.414 on the server/.test(await lastMessage()));
  // The chore minion may be dismissed already (its ship was clean), so it is named by its commit.
  assert.match(await lastMessage(), new RegExp(`ships with Citadel #${chore}\\.`));
  await idle();
});

test('a failed install lists nothing and tells the minion why', async () => {
  const { id } = await propose({ ...pyright, package: 'broken', version: '1.0.0' });
  const shipped = readFileSync(landLog, 'utf8');
  await verdict('Josh', id, 'approve');
  await until('the minion hears', async () => /^Installing npm:broken@1\.0\.0 failed/.test(await lastMessage()));
  assert.match(await lastMessage(), /npm: no such package/);
  assert.equal(readFileSync(landLog, 'utf8'), shipped, 'nothing more shipped');
  await idle();
});
