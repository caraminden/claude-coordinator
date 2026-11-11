import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { cleanPaths, diffSize, parseShortstat, prepare, UltraReviews, type ReviewResult } from '../src/ultrareview.ts';
import { Auth } from '../src/auth.ts';
import { Store } from '../src/db.ts';
import { bootServer, PASSWORD, SECRET, until } from './helpers.ts';

// Ultra review (#432): every test stubs `claude` with a script, so none of them launches a real (billed) review.
const root = mkdtempSync(join(tmpdir(), 'ultrareview-'));
after(() => rmSync(root, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();
const write = (dir: string, file: string, body: string) => {
  mkdirSync(join(dir, file, '..'), { recursive: true });
  writeFileSync(join(dir, file), body);
};

/** A repo whose main has an area (src/a.ts, lib/) and the rest, plus a minion branch with one change. */
function repo(): string {
  const dir = mkdtempSync(join(root, 'repo-'));
  git(dir, 'init', '-q', '-b', 'main');
  write(dir, 'src/a.ts', 'a\nb\nc\n');
  write(dir, 'src/b.ts', 'outside\n');
  write(dir, 'lib/x.ts', 'x\n');
  write(dir, 'lib/y.ts', 'y\ny\n');
  write(dir, 'README.md', 'readme\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'main');
  git(dir, 'checkout', '-q', '-b', 'ticket/9-thing');
  write(dir, 'src/b.ts', 'outside\nchanged\n');
  git(dir, 'commit', '-q', '-am', 'change');
  git(dir, 'checkout', '-q', 'main');
  return dir;
}

/** A stand-in claude: logs its args and what it sees, then prints findings (or a refusal, with a `refuse` file). */
function fakeClaude(): { bin: string; log: string } {
  const dir = mkdtempSync(join(root, 'bin-'));
  const bin = join(dir, 'claude');
  const log = join(dir, 'log');
  writeFileSync(bin, `#!/bin/sh
{ echo "args: $*"; echo "cwd: $(pwd)"; echo "branch: $(git rev-parse --abbrev-ref HEAD)"; echo "diff: $(git diff --name-only "$2"...HEAD | tr '\\n' ' ')"; } >> '${log}'
if [ -e '${dir}/refuse' ]; then printf '\\033[31mThis diff has 900 changed files; ultrareview reviews at most 500 files and 8,000 lines.\\033[0m\\n' >&2; exit 1; fi
echo "1 bug found: src/a.ts:2 off by one"
`);
  chmodSync(bin, 0o755);
  return { bin, log };
}

test('cleanPaths keeps repo paths and refuses anything that could leave the repo or read as an option', () => {
  assert.deepEqual(cleanPaths('src/a.ts  lib/\n./README.md, src/a.ts'), ['src/a.ts', 'lib', 'README.md']);
  for (const bad of ['../x', '/etc/passwd', '-rf', 'src/../../x', '.git/config', 'src/*.ts', '']) assert.throws(() => cleanPaths(bad), bad);
  assert.throws(() => cleanPaths(42));
});

test('parseShortstat counts files and changed lines', () => {
  assert.deepEqual(parseShortstat(' 14 files changed, 7445 insertions(+), 3 deletions(-)'), { files: 14, lines: 7448 });
  assert.deepEqual(parseShortstat(' 1 file changed, 1 insertion(+)'), { files: 1, lines: 1 });
  assert.deepEqual(parseShortstat(''), { files: 0, lines: 0 });
});

test("an area's diff is just its paths: the base is main without them, the branch adds them back", async () => {
  const r = repo();
  const spec = { mode: 'area' as const, repo: r, base: 'main', paths: ['src/a.ts', 'lib'] };
  assert.deepEqual(await diffSize(spec), { files: 3, lines: 6 });
  await assert.rejects(diffSize({ ...spec, paths: ['src/a.ts', 'nope'] }), /Not in main: nope/);
  const clone = join(root, 'area-clone');
  const base = await prepare(spec, clone);
  assert.equal(base, 'ultrareview-base');
  assert.equal(git(clone, 'rev-parse', '--abbrev-ref', 'HEAD'), 'ultrareview-area');
  assert.deepEqual(git(clone, 'diff', '--name-only', `${base}...HEAD`).split('\n'), ['lib/x.ts', 'lib/y.ts', 'src/a.ts']);
  assert.deepEqual(git(clone, 'ls-tree', '-r', '--name-only', base).split('\n'), ['README.md', 'src/b.ts']);
  assert.equal(git(clone, 'rev-parse', 'HEAD^{tree}'), git(r, 'rev-parse', 'main^{tree}'), 'the reviewed branch is main, whole');
  assert.equal(git(clone, 'status', '--porcelain'), '');
});

test('an area with a non-ASCII path is found in main (#468 S06-9)', async () => {
  const r = repo();
  git(r, 'config', 'core.quotePath', 'true');
  write(r, 'docs/café/a.md', 'one\ntwo\n');
  git(r, 'add', '-A');
  git(r, 'commit', '-q', '-m', 'docs');
  assert.deepEqual(await diffSize({ mode: 'area', repo: r, base: 'main', paths: ['docs/café'] }), { files: 1, lines: 2 });
});

test("a branch review clones the minion's branch, committed work only, against main", async () => {
  const r = repo();
  git(r, 'checkout', '-q', 'ticket/9-thing');
  write(r, 'src/a.ts', 'uncommitted\n');
  const spec = { mode: 'branch' as const, repo: r, base: 'main', branch: 'ticket/9-thing' };
  assert.deepEqual(await diffSize(spec), { files: 1, lines: 1 });
  const clone = join(root, 'branch-clone');
  assert.equal(await prepare(spec, clone), 'main');
  assert.equal(git(clone, 'rev-parse', '--abbrev-ref', 'HEAD'), 'ticket/9-thing');
  assert.equal(git(clone, 'diff', '--name-only', 'main...HEAD'), 'src/b.ts');
  assert.equal(readFileSync(join(clone, 'src/a.ts'), 'utf8'), 'a\nb\nc\n', 'nothing uncommitted came along');
});

function reviews(bin: string, place: any = { host: true }) {
  const events: { ticketId: number; kind: string; data: any }[] = [];
  const settings = new Map<string, unknown>();
  const scratch = mkdtempSync(join(root, 'scratch-'));
  const jobsDir = mkdtempSync(join(root, 'jobs-'));
  const ur = new UltraReviews({
    claudeBin: bin, place: () => place, scratch: () => scratch, hostEnv: { PATH: process.env.PATH! }, jobsDir,
    emit: (ticketId, kind, data) => events.push({ ticketId, kind, data }),
    getSetting: (k) => settings.get(k) as any, setSetting: (k, v) => settings.set(k, v),
  });
  const result = () => until('the result', () => events.find((e) => e.kind === 'ultrareview_result')?.data as ReviewResult | undefined);
  return { ur, events, settings, scratch, jobsDir, result };
}

test("a review runs the CLI on the clicker's login in a scratch clone, posts the findings and deletes the clone", async () => {
  const { bin, log } = fakeClaude();
  const { ur, events, scratch, jobsDir, result } = reviews(bin);
  const shared = mkdtempSync(join(root, 'shared-'));
  const spec = { mode: 'area' as const, repo: repo(), base: 'main', paths: ['src/a.ts'] };
  const ev = await ur.start(7, 1, 'Cara', spec, { files: 1, lines: 3 }, shared);
  assert.equal(events[0].kind, 'ultrareview');
  assert.deepEqual(events[0].data, ev);
  // Without units its CLI runs as the server's child, which a restart would cut off.
  await until('the CLI runs as a child', () => ur.running() === 1);
  await assert.rejects(ur.start(7, 1, 'Cara', spec, { files: 1, lines: 3 }), /already have an ultra review running/, 'one at a time per person: a double click never pays twice');
  const r = await result();
  const [file] = readdirSync(shared);
  assert.deepEqual(r, { id: ev.id, ok: true, code: 0, text: '1 bug found: src/a.ts:2 off by one', file: join(shared, file) });
  assert.match(readFileSync(r.file!, 'utf8'), /^# Ultra review: area `src\/a.ts`[\s\S]*off by one/);
  const seen = readFileSync(log, 'utf8');
  assert.match(seen, /^args: ultrareview ultrareview-base --trust-workspace --timeout 45$/m);
  assert.match(seen, /^branch: ultrareview-area$/m);
  assert.match(seen, /^diff: src\/a.ts $/m);
  assert.equal(ur.running(), 0);
  assert.deepEqual(readdirSync(scratch), [], 'the scratch clone is gone');
  assert.deepEqual(readdirSync(jobsDir), [], 'and its job folder');
});

test("the CLI's refusal (a diff over its limits, credits off) shows as it said it, without colour codes", async () => {
  const { bin } = fakeClaude();
  writeFileSync(join(bin, '..', 'refuse'), '');
  const { ur, result } = reviews(bin);
  const shared = mkdtempSync(join(root, 'shared-'));
  await ur.start(7, 1, 'Cara', { mode: 'branch', repo: repo(), base: 'main', branch: 'ticket/9-thing' }, { files: 1, lines: 1 }, shared);
  const r = await result();
  assert.equal(r.ok, false);
  assert.equal(r.code, 1);
  assert.equal(r.text, 'This diff has 900 changed files; ultrareview reviews at most 500 files and 8,000 lines.');
  assert.deepEqual(readdirSync(shared), [], 'a refusal is not saved as findings');
});

test('nobody without a Claude login of their own can start one, and a restart reports a lost review', async () => {
  const { bin } = fakeClaude();
  const { ur, events } = reviews(bin, null);
  await assert.rejects(ur.start(7, 2, 'Josh', { mode: 'area', repo: repo(), base: 'main', paths: ['lib'] }, { files: 2, lines: 3 }), /isn't linked/);
  assert.equal(events.length, 0);
  const { ur: next, events: after, settings } = reviews(bin);
  const dir = mkdtempSync(join(root, 'lost-'));
  settings.set('ultrareview_running', [{ ticketId: 7, uid: 1, id: 'old', dir }]);
  next.recover();
  assert.equal(after[0].kind, 'ultrareview_result');
  assert.equal(after[0].data.ok, false);
  assert.match(after[0].data.text, /restarted/);
  assert.ok(!existsSync(dir));
  assert.deepEqual(settings.get('ultrareview_running'), []);
});

test("a container review runs in the clicker's own container, with its env and none of the server's", async () => {
  const dir = mkdtempSync(join(root, 'podman-'));
  const log = join(dir, 'log');
  writeFileSync(join(dir, 'podman'), `#!/bin/sh\necho "$@" > '${log}'\necho ok\n`);
  chmodSync(join(dir, 'podman'), 0o755);
  const PATH = process.env.PATH;
  process.env.PATH = `${dir}:${PATH}`;
  try {
    let ensured = false;
    const place = { host: false, container: 'citadel-claude-2', configDir: '/v/.claude', home: '/v', turnsDir: '/t', env: { HOME: '/home/x', CLAUDE_CONFIG_DIR: '/home/x/.claude' }, ensure: async () => void (ensured = true) };
    const { ur, result } = reviews(join(dir, 'podman'), place);
    await ur.start(7, 2, 'Josh', { mode: 'area', repo: repo(), base: 'main', paths: ['lib'] }, { files: 2, lines: 3 });
    assert.equal(ur.inContainer('citadel-claude-2'), 1, 'a turn starting there leaves the container running');
    const r = await result();
    assert.equal(r.ok, true);
    assert.ok(ensured);
    assert.match(readFileSync(log, 'utf8'), /^exec -w \S+\/repo -e HOME=\/home\/x -e CLAUDE_CONFIG_DIR=\/home\/x\/.claude citadel-claude-2 \S+\/podman ultrareview ultrareview-base --trust-workspace --timeout 45$/m);
  } finally {
    process.env.PATH = PATH;
  }
});

test('only a person can start one: minions and the Taskmaster get 403, and a person must confirm the cost', async () => {
  const { bin, log } = fakeClaude();
  const r = repo();
  const dir = mkdtempSync(join(root, 'srv-'));
  const data = join(dir, 'data');
  mkdirSync(data, { recursive: true });
  const store = new Store(join(data, 'coordinator.db'));
  const P = store.createProject('A', null);
  store.setProjectRepoDir(P.id, r);
  const TM = store.createTicket({ project_id: P.id, kind: 'coordinator', title: 'Coordinator', permission_mode: 'default', created_by: 'Cara' });
  const M = store.createTicket({ project_id: P.id, kind: 'ticket', title: 'Thing', permission_mode: 'default', created_by: 'Cara' });
  store.setTicketDir(M.id, r, 'ticket/9-thing');
  store.db.close();
  const srv = await bootServer({ root: dir, env: { CLAUDE_BIN: bin } });
  try {
    const tokens = new Auth(PASSWORD, SECRET);
    const asAgent = (id: number, method: string) => fetch(`${srv.base}/api/tickets/${M.id}/ultrareview?mode=branch`, {
      method, headers: { Authorization: `Bearer ${tokens.agentToken(id)}`, 'Content-Type': 'application/json' },
      ...(method === 'POST' ? { body: JSON.stringify({ mode: 'branch', confirm: true }) } : {}),
    });
    for (const id of [M.id, TM.id]) for (const method of ['GET', 'POST']) assert.equal((await asAgent(id, method)).status, 403, `${id} ${method}`);

    const size = await srv.call(`/api/tickets/${M.id}/ultrareview?mode=branch`);
    assert.equal(size.status, 200, JSON.stringify(size.data));
    assert.deepEqual(size.data.size, { files: 1, lines: 1 });
    assert.equal(size.data.linked, true);
    const area = await srv.call(`/api/tickets/${TM.id}/ultrareview?mode=area&path=lib&path=src/a.ts`);
    assert.deepEqual(area.data.size, { files: 3, lines: 6 });
    assert.equal((await srv.call(`/api/tickets/${TM.id}/ultrareview?mode=branch`)).status, 400, 'the Taskmaster has no branch');
    assert.equal((await srv.call(`/api/tickets/${TM.id}/ultrareview?mode=area&path=../x`)).status, 400);

    const unconfirmed = await srv.call(`/api/tickets/${M.id}/ultrareview`, { mode: 'branch' });
    assert.equal(unconfirmed.status, 400);
    assert.match(unconfirmed.data.error, /Confirm first/);
    assert.ok(!existsSync(log), 'nothing ran before the confirmation');

    const started = await srv.call(`/api/tickets/${M.id}/ultrareview`, { mode: 'branch', confirm: true });
    assert.equal(started.status, 202, JSON.stringify(started.data));
    const events = async () => (await srv.call(`/api/tickets/${M.id}/events`)).data;
    const done = await until('the findings', async () => {
      const list = await events();
      const rows = Array.isArray(list) ? list : list.events;
      return rows?.find((e: any) => e.kind === 'ultrareview_result');
    });
    const res = typeof done.data === 'string' ? JSON.parse(done.data) : done.data;
    assert.equal(res.ok, true, res.text);
    assert.match(res.file, new RegExp(`/shared/${M.id}/ultrareview-`));
    assert.match(readFileSync(res.file, 'utf8'), /off by one/);
    assert.match(readFileSync(log, 'utf8'), /^args: ultrareview main --trust-workspace --timeout 45$/m);
  } finally {
    await srv.stop();
  }
});

// #508: the review's CLI runs in a unit of its own, so a restart neither waits for it (interruptible 0) nor
// kills it, and the next server posts its findings. A fake systemd-run starts it in a session of its own.
test('a review outlives a restart: the next server follows it and posts its findings', async () => {
  const r = repo();
  const dir = mkdtempSync(join(root, 'restart-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'systemd-run'), '#!/usr/bin/env bash\nwhile [ "${1#-}" != "$1" ]; do [ "$1" = -p ] && shift; shift; done\nsetsid "$@" </dev/null >/dev/null 2>&1 &\n', { mode: 0o755 });
  const go = join(dir, 'go');
  const started = join(dir, 'started');
  // At most 30 s, so a failed test leaves nothing running.
  writeFileSync(join(bin, 'claude'), `#!/bin/sh\ntouch '${started}'\nfor i in $(seq 600); do [ -e '${go}' ] && break; sleep 0.05; done\necho "1 bug found: survived the restart"\n`, { mode: 0o755 });
  const data = join(dir, 'data');
  mkdirSync(data, { recursive: true });
  const store = new Store(join(data, 'coordinator.db'));
  const P = store.createProject('A', null);
  store.setProjectRepoDir(P.id, r);
  const M = store.createTicket({ project_id: P.id, kind: 'ticket', title: 'Thing', permission_mode: 'default', created_by: 'Cara' });
  store.setTicketDir(M.id, r, 'ticket/9-thing');
  store.db.close();
  const env = { CLAUDE_BIN: join(bin, 'claude'), TURN_UNITS: '1', PATH: `${bin}:${process.env.PATH}` };
  let srv: Awaited<ReturnType<typeof bootServer>> | null = await bootServer({ root: dir, env });
  try {
    assert.equal((await srv.call(`/api/tickets/${M.id}/ultrareview`, { mode: 'branch', confirm: true })).status, 202);
    await until('the CLI runs', () => existsSync(started));
    assert.equal((await srv.call('/api/health')).data.interruptible, 0, "a restart doesn't wait for the review");
    await srv.stop({ keepTurns: true });
    srv = await bootServer({ root: dir, env });
    writeFileSync(go, '');
    const done = await until('the findings', async () => {
      const list = (await srv!.call(`/api/tickets/${M.id}/events`)).data;
      return (Array.isArray(list) ? list : list.events)?.find((e: any) => e.kind === 'ultrareview_result');
    });
    const res = typeof done.data === 'string' ? JSON.parse(done.data) : done.data;
    assert.equal(res.ok, true, res.text);
    assert.equal(res.text, '1 bug found: survived the restart');
    assert.match(readFileSync(res.file, 'utf8'), /survived the restart/);
  } finally {
    writeFileSync(go, '');
    await srv?.stop();
  }
});
