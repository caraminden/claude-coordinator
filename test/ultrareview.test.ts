import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { cleanPaths, diffSize, parseShortstat, prepare, UltraReviews, type ReviewResult } from '../src/ultrareview.ts';
import { Auth } from '../src/auth.ts';
import { Store } from '../src/db.ts';
import { bootServer, PASSWORD, SECRET, until } from './helpers.ts';
import { Readable } from 'node:stream';
import { ticketRoutes } from '../src/routes/tickets.ts';

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

function reviews(bin: string, place: any = { host: true }, extra: Record<string, unknown> = {}) {
  const events: { ticketId: number; kind: string; data: any }[] = [];
  const settings = new Map<string, unknown>();
  const scratch = mkdtempSync(join(root, 'scratch-'));
  const jobsDir = mkdtempSync(join(root, 'jobs-'));
  const ur = new UltraReviews({
    claudeBin: bin, place: () => place, scratch: () => scratch, hostEnv: { PATH: process.env.PATH! }, jobsDir,
    emit: (ticketId, kind, data) => events.push({ ticketId, kind, data }),
    getSetting: (k) => settings.get(k) as any, setSetting: (k, v) => settings.set(k, v),
    github: () => null, ...extra,
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
  // Still cloning, and then its CLI as the server's child (no units): a restart would cut it off either way.
  assert.equal(ur.running(), 1);
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
  const josh = store.createUser({ name: 'Josh', login: 'josh' });
  store.updateTicket(M.id, { person_id: josh.id });
  const M2 = store.createTicket({ project_id: P.id, kind: 'ticket', title: 'Other', permission_mode: 'default', created_by: 'Cara' });
  store.db.close();
  const srv = await bootServer({ root: dir, env: { CLAUDE_BIN: bin } });
  try {
    const tokens = new Auth(PASSWORD, SECRET);
    const asAgent = (id: number, method: string) => fetch(`${srv.base}/api/tickets/${M.id}/ultrareview?mode=branch`, {
      method, headers: { Authorization: `Bearer ${tokens.agentToken(id)}`, 'Content-Type': 'application/json' },
      ...(method === 'POST' ? { body: JSON.stringify({ mode: 'branch', confirm: true }) } : {}),
    });
    for (const id of [M.id, TM.id]) for (const method of ['GET', 'POST']) assert.equal((await asAgent(id, method)).status, 403, `${id} ${method}`);
    // The batch routes (#1399): no turn starts or discards one, and only the chat's own minion preps, for its turn's person.
    const batchAs = (id: number, method: string, path: string, on = M.id) => fetch(`${srv.base}/api/tickets/${on}/ultrareview/${path}`, { method, headers: { Authorization: `Bearer ${tokens.agentToken(id)}`, 'Content-Type': 'application/json' }, ...(method === 'GET' ? {} : { body: JSON.stringify({ areas: [{ paths: 'lib' }], confirm: true }) }) });
    for (const id of [M.id, M2.id, TM.id]) {
      for (const [method, path] of [['POST', 'batch/x/start'], ['DELETE', 'batch/x']]) assert.equal((await batchAs(id, method, path)).status, 403, `${id} ${method} ${path}`);
    }
    for (const id of [M2.id, TM.id]) for (const method of ['GET', 'POST']) assert.equal((await batchAs(id, method, 'batch')).status, 403, `another thread ${id} ${method} batch`);
    const own = await batchAs(M.id, 'GET', 'batch');
    assert.equal(own.status, 200);
    assert.deepEqual((await own.json()).rows, []);
    const noGithub = await batchAs(M.id, 'POST', 'batch');
    assert.equal(noGithub.status, 409);
    assert.match((await noGithub.json()).error, /^Josh has no GitHub login linked .*never borrow someone else's/, "preps go out as the turn's person, never the server's login");
    const nobody = await batchAs(M2.id, 'POST', 'batch', M2.id);
    assert.equal(nobody.status, 403);
    assert.match((await nobody.json()).error, /No person to prep for/);
    const batch = await srv.call(`/api/tickets/${M.id}/ultrareview/batch`, { areas: [{ name: 'Lib', paths: 'lib' }, { paths: 'nope' }] });
    assert.equal(batch.status, 200, JSON.stringify(batch.data));
    assert.deepEqual(batch.data.rows, []);
    assert.match(batch.data.refused[0].error, /Lib: you haven't linked GitHub/, "no GitHub link of the person's own: nothing borrowed");
    assert.match(batch.data.refused[1].error, /Not in main: nope/);
    assert.equal((await srv.call(`/api/tickets/${M.id}/ultrareview/batch`)).data.github, false);

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

test("a minion's prep goes out as its turn's person: their GitHub login, their batch, never the minion's or anyone else's (#1399)", async () => {
  const r = repo();
  const preps: { uid: number; by: string; name: string }[] = [];
  const users: Record<number, { id: number; name: string }> = { 5: { id: 5, name: 'Josh' }, 6: { id: 6, name: 'Cara' } };
  const app: any = {
    store: { getTicket: () => ({ id: 9, person_id: 5 }), getUser: (id: number) => users[id], getProject: () => ({ repo_dir: r }) },
    github: { token: (p: { id: number }) => (p.id === 5 ? 'josh-token' : 'cara-token') },
    ultrareviews: { prep: async (_t: number, uid: number, by: string, a: { name: string }) => void preps.push({ uid, by, name: a.name }), rows: (_t: number, uid: number) => preps.filter((x) => x.uid === uid).map((x) => ({ ...x, repo: r })) },
  };
  const route = ticketRoutes.find((x) => x.method === 'POST' && x.path === '/api/tickets/:ticket/ultrareview/batch')!;
  const post = async (caller: any) => {
    const req: any = Readable.from([Buffer.from(JSON.stringify({ areas: [{ name: 'Lib', paths: ['lib'] }] }))]);
    req.headers = { 'content-type': 'application/json' };
    let status = 0, body = '';
    const res: any = { destroyed: false, headersSent: false, writeHead: (s: number) => void (status = s), end: (b: Buffer) => void (body = String(b)) };
    try {
      await route.handler({ req, res, app, session: { name: 'agent', agent: caller.id, exp: 0 }, caller, ticket: { id: 9, project_id: 1 }, params: { ticket: '9' } } as any);
    } catch (err: any) {
      return { status: err.status, body: { error: err.message } };
    }
    return { status, body: JSON.parse(body) };
  };
  const ok = await post({ id: 9, kind: 'ticket' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(preps, [{ uid: 5, by: 'Josh', name: 'Lib' }], "prepped in Josh's batch, as Josh");
  assert.equal(ok.body.for, 'Josh');
  assert.equal(ok.body.rows.length, 1);
  const tm = await post({ id: 9, kind: 'coordinator' });
  assert.equal(tm.status, 403, 'a Taskmaster on its own chat preps nothing');
  assert.match(tm.body.error, /not a Taskmaster/);
  assert.equal(preps.length, 1);
});

// #508: the review's CLI runs in a unit of its own, so a restart neither waits for it (interruptible 0) nor
// kills it, and the next server posts its findings. A fake systemd-run starts it in a session of its own.
test('a review outlives a restart: the next server follows it and posts its findings', async () => {
  const r = repo();
  const dir = mkdtempSync(join(root, 'restart-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const calls = join(dir, 'systemd-run.calls');
  writeFileSync(join(bin, 'systemd-run'), `#!/usr/bin/env bash\necho "$*" >> '${calls}'\nwhile [ "\${1#-}" != "$1" ]; do [ "$1" = -p ] && shift; shift; done\nsetsid "$@" </dev/null >/dev/null 2>&1 &\n`, { mode: 0o755 });
  const go = join(dir, 'go');
  const started = join(dir, 'started');
  // At most 30 s, so a failed test leaves nothing running.
  writeFileSync(join(bin, 'claude'), `#!/bin/sh\ntouch '${started}'\nfor i in $(seq 600); do [ -e '${go}' ] && break; sleep 0.05; done\n[ -e "$PWD/.git" ] || { echo 'the clone is gone'; exit 1; }\necho "1 bug found: survived the restart"\n`, { mode: 0o755 });
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
    assert.match(readFileSync(calls, 'utf8'), /--slice=citadel-turns\.slice -p UMask=0077 -p ManagedOOMPreference=avoid /, "oomd's last pick, as a minion turn is (#1338)");
    assert.equal((await srv.call('/api/health')).data.interruptible, 0, "a restart doesn't wait for the review");
    await srv.stop({ keepTurns: true });
    // Its clone looks as old as a long review's: the next server's sweep of turn folders leaves it be.
    const people = join(data, 'run', 'turns');
    const clones = readdirSync(people).flatMap((p) => readdirSync(join(people, p)).filter((n) => n.startsWith('ultrareview-')).map((n) => join(people, p, n)));
    assert.equal(clones.length, 1);
    utimesSync(clones[0], new Date(0), new Date(0));
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

// #1399: on a big repo the CLI refuses the scratch clone ("Repo is too large"), so the area goes up as a draft pull
// request instead: review/<slug> (the area put back, a green tree) into review/<slug>-base (made through the API at
// the commit without the area). A fake gh logs its calls; pushes go to a bare repo standing in for GitHub.

/** A repo whose origin is github.com/o/r, and a bare repo standing in for it. */
function githubRepo(): { dir: string; bare: string } {
  const dir = repo();
  git(dir, 'remote', 'add', 'origin', 'https://github.com/o/r');
  const bare = mkdtempSync(join(root, 'bare-'));
  git(bare, 'init', '-q', '--bare');
  return { dir, bare };
}

/** A stand-in gh: logs each call with the token it saw; `pr create` prints PR 42's URL, or fails with a `fail-pr` file. */
function fakeGh(): { bin: string; log: string; calls: () => string[] } {
  const dir = mkdtempSync(join(root, 'gh-'));
  const bin = join(dir, 'gh');
  const log = join(dir, 'log');
  writeFileSync(bin, `#!/bin/sh
{ echo "[$GH_TOKEN] $*" | tr '\\n' ' '; echo; } >> '${log}'
if [ "$1 $2" = "pr create" ]; then
  [ -e '${dir}/fail-pr' ] && { echo 'pull request create failed: GraphQL: Resource not accessible by integration' >&2; exit 1; }
  echo "https://github.com/o/r/pull/42"
fi
exit 0
`);
  chmodSync(bin, 0o755);
  return { bin, log, calls: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []) };
}

/** A claude that refuses any local review as too large, and reviews a PR number. */
function bigRepoClaude(): { bin: string; log: string } {
  const dir = mkdtempSync(join(root, 'bin-'));
  const bin = join(dir, 'claude');
  const log = join(dir, 'log');
  writeFileSync(bin, `#!/bin/sh
echo "args: $*" >> '${log}'
case "$2" in
  [0-9]*) echo "remote: $(git remote get-url origin)" >> '${log}'; echo "2 bugs found in PR $2";;
  *) echo 'Ultrareview could not launch: Repo is too large. Push a PR and use \`claude ultrareview <PR#>\` instead.' >&2; exit 1;;
esac
`);
  chmodSync(bin, 0o755);
  return { bin, log };
}

const linked = (uid: number) => (uid === 1 ? { token: 'tok-cara', login: 'cara' } : null);

test('area mode falls back to a draft PR when the CLI says the repo is too large, then closes it', async () => {
  const { dir, bare } = githubRepo();
  const { bin, log } = bigRepoClaude();
  const gh = fakeGh();
  const { ur, events, scratch, result } = reviews(bin, { host: true }, { github: linked, gh: gh.bin, remoteUrl: () => bare });
  const shared = mkdtempSync(join(root, 'shared-'));
  await ur.start(7, 1, 'Cara', { mode: 'area', repo: dir, base: 'main', paths: ['src/a.ts', 'lib'] }, { files: 3, lines: 6 }, shared);
  const r = await result();
  assert.equal(r.ok, true, r.text);
  assert.equal(r.text, '2 bugs found in PR 42');
  assert.deepEqual(r.pr, { number: 42, url: 'https://github.com/o/r/pull/42' });
  const seen = readFileSync(log, 'utf8');
  assert.match(seen, /^args: ultrareview ultrareview-base /m, 'the scratch clone first');
  assert.match(seen, /^args: ultrareview 42 --trust-workspace --timeout 45$/m, 'then the PR');
  assert.match(seen, /^remote: https:\/\/github.com\/o\/r$/m, 'from a folder whose remote is the scheme repo');
  // What went up: review/<slug> is main's tree; its parent is main without the area, which the API made the base.
  const heads = git(bare, 'for-each-ref', '--format=%(refname)', 'refs/heads/');
  const head = heads.split('\n').find((h) => h.startsWith('refs/heads/review/'))!;
  assert.ok(head && heads.split('\n').length === 1, `only one review branch pushed: ${heads}`);
  assert.equal(git(bare, 'rev-parse', `${head}^{tree}`), git(dir, 'rev-parse', 'main^{tree}'));
  assert.match(git(bare, 'log', '-2', '--format=%s', head), /\[skip ci\][\s\S]*\[skip ci\]/, 'neither commit runs CI');
  const parent = git(bare, 'rev-parse', `${head}^`);
  const name = head.replace('refs/heads/', '');
  const calls = gh.calls();
  assert.ok(calls.every((c) => c.startsWith('[tok-cara] ')), "every gh call runs on the clicker's own GitHub token");
  assert.ok(calls.some((c) => c.includes(`api repos/o/r/git/refs -f ref=refs/heads/${name}-base -f sha=${parent}`)), calls.join('\n'));
  assert.ok(calls.some((c) => /pr create --repo o\/r --draft/.test(c) && c.includes(`--head ${name} --base ${name}-base`)), calls.join('\n'));
  // Once the findings are in, the PR is closed and both branches deleted.
  await until('the clean-up', () => gh.calls().some((c) => c.includes(`git/refs/heads/${name}-base`) && c.includes('DELETE')));
  const after = gh.calls();
  assert.ok(after.some((c) => c.includes('pr close 42 --repo o/r')));
  assert.ok(after.some((c) => c.trimEnd().endsWith(`api -X DELETE repos/o/r/git/refs/heads/${name}`)));
  assert.equal(events.filter((e) => e.kind === 'note').length, 0, 'a clean-up that worked says nothing');
  await until('no scratch left', () => !readdirSync(scratch).some((n) => n.startsWith('ultrareview')));
});

test('without a GitHub login of their own, the too-large fallback says so and opens nothing', async () => {
  const { dir, bare } = githubRepo();
  const { bin } = bigRepoClaude();
  const gh = fakeGh();
  const { ur, result } = reviews(bin, { host: true }, { github: () => null, gh: gh.bin, remoteUrl: () => bare });
  await ur.start(7, 2, 'Josh', { mode: 'area', repo: dir, base: 'main', paths: ['lib'] }, { files: 2, lines: 3 });
  const r = await result();
  assert.equal(r.ok, false);
  assert.match(r.text, /Repo is too large/);
  assert.match(r.text, /haven't linked GitHub/);
  assert.deepEqual(gh.calls(), []);
  assert.equal(git(bare, 'for-each-ref'), '');
});

test('a batch preps one draft PR per area, refuses one over the caps, and survives a restart', async () => {
  const { dir, bare } = githubRepo();
  const { bin } = bigRepoClaude();
  const gh = fakeGh();
  const extra = { github: linked, gh: gh.bin, remoteUrl: () => bare };
  const { ur, settings } = reviews(bin, { host: true }, extra);
  await assert.rejects(ur.prep(7, 1, 'Cara', { repo: dir, base: 'main', name: 'Huge', paths: ['src'], size: { files: 3, lines: 9001 } }), /9,001 lines/);
  await assert.rejects(ur.prep(7, 2, 'Josh', { repo: dir, base: 'main', name: 'Lib', paths: ['lib'], size: { files: 2, lines: 3 } }), /haven't linked GitHub/);
  const a = await ur.prep(7, 1, 'Cara', { repo: dir, base: 'main', name: 'The A file', paths: ['src/a.ts'], question: 'Is the off-by-one real?', size: { files: 1, lines: 3 } });
  assert.equal(a.state, 'prepping');
  assert.match(a.pr!.head, /^review\/the-a-file-[a-z0-9]+$/);
  const ready = await until('prepped', () => ur.rows(7, 1).find((x) => x.id === a.id && x.state === 'ready'));
  assert.deepEqual([ready.pr!.number, ready.pr!.url], [42, 'https://github.com/o/r/pull/42']);
  assert.ok(gh.calls().some((c) => c.includes('Is the off-by-one real?')), 'the question goes in the PR description');
  assert.deepEqual(ur.rows(7, 2), [], "a person sees only their own rows");
  // A row still prepping when the server stops can't be finished: the next server marks it failed and deletes its branches.
  const half = { ...ready, id: 'half', state: 'prepping', pr: { slug: 'o/r', head: 'review/half-x', base: 'review/half-x-base' } };
  settings.set('ultrareview_batch', [...(settings.get('ultrareview_batch') as any[]), half]);
  const next = reviews(bin, { host: true }, extra);
  for (const [k, v] of settings) next.settings.set(k, v);
  next.ur.recover();
  const rows = next.ur.rows(7, 1);
  assert.deepEqual(rows.find((x) => x.id === a.id), ready, 'the ready row is back as it was');
  assert.equal(rows.find((x) => x.id === 'half')!.state, 'failed');
  await until('the half-made branches go', () => gh.calls().some((c) => c.includes('DELETE repos/o/r/git/refs/heads/review/half-x-base')));
});

test("a batch row's Start reviews its PR, posts the findings and cleans up; discard and expiry clean up too", async () => {
  const { dir, bare } = githubRepo();
  const { bin, log } = bigRepoClaude();
  const gh = fakeGh();
  const { ur, events, result } = reviews(bin, { host: true }, { github: linked, gh: gh.bin, remoteUrl: () => bare });
  const shared = mkdtempSync(join(root, 'shared-'));
  const area = { repo: dir, base: 'main', paths: ['lib'], size: { files: 2, lines: 3 } };
  const one = await ur.prep(7, 1, 'Cara', { ...area, name: 'One' });
  const two = await ur.prep(7, 1, 'Cara', { ...area, name: 'Two' });
  const three = await ur.prep(7, 1, 'Cara', { ...area, name: 'Three' });
  await until('prepped', () => ur.rows(7, 1).every((x) => x.state === 'ready') || undefined);
  const heads = Object.fromEntries(ur.rows(7, 1).map((x) => [x.name, x.pr!.head]));

  assert.throws(() => ur.startRow(one.id, 2, 'Josh', shared), /not yours|no such/i, "nobody starts someone else's row");
  await ur.startRow(one.id, 1, 'Cara', shared);
  assert.equal(ur.rows(7, 1).find((x) => x.id === one.id)!.state, 'running');
  await assert.rejects(Promise.resolve().then(() => ur.startRow(one.id, 1, 'Cara', shared)), /already/, 'a second click never pays twice');
  const r = await result();
  assert.equal(r.ok, true, r.text);
  assert.match(readFileSync(log, 'utf8'), /^args: ultrareview 42 --trust-workspace --timeout 45$/m);
  assert.doesNotMatch(readFileSync(log, 'utf8'), /ultrareview-base/, 'a prepped row goes straight to its PR');
  assert.ok(readdirSync(shared).length === 1, 'findings saved to the chat');
  await until('its branches go', () => gh.calls().some((c) => c.includes(`DELETE repos/o/r/git/refs/heads/${heads.One}-base`)));
  assert.equal(ur.rows(7, 1).some((x) => x.id === one.id), false, 'its row is gone once its findings are posted');

  ur.discard(two.id, 1);
  assert.equal(ur.rows(7, 1).some((x) => x.id === two.id), false, 'discard drops the row at once');
  await until('discarded branches go', () => gh.calls().some((c) => c.includes(`DELETE repos/o/r/git/refs/heads/${heads.Two}-base`)));

  // Nobody starts the third within 7 days: it's cleaned up the same way, and the chat hears it in one line.
  ur.sweep(Date.now() + 8 * 86_400_000);
  assert.deepEqual(ur.rows(7, 1), []);
  await until('expired branches go', () => gh.calls().some((c) => c.includes(`DELETE repos/o/r/git/refs/heads/${heads.Three}-base`)));
  const notes = events.filter((e) => e.kind === 'note');
  assert.equal(notes.length, 1);
  assert.equal(notes[0].ticketId, 7);
  assert.match(notes[0].data.text, /^Discarded 1 prepped ultra review nobody started in 7 days \(Three\) and closed its draft PR\.$/);
  assert.ok(gh.calls().filter((c) => c.includes('pr close 42')).length >= 3);
  void three;
});

test('a failed prep shows GitHub\'s words on its row and deletes what it pushed', async () => {
  const { dir, bare } = githubRepo();
  const gh = fakeGh();
  writeFileSync(join(gh.bin, '..', 'fail-pr'), '');
  const { ur } = reviews(bigRepoClaude().bin, { host: true }, { github: linked, gh: gh.bin, remoteUrl: () => bare });
  const row = await ur.prep(7, 1, 'Cara', { repo: dir, base: 'main', name: 'Lib', paths: ['lib'], size: { files: 2, lines: 3 } });
  const head = row.pr!.head;
  const failed = await until('failed', () => ur.rows(7, 1).find((x) => x.id === row.id && x.state === 'failed'));
  assert.match(failed.error!, /Resource not accessible by integration/);
  await until('its branches go', () => gh.calls().some((c) => c.includes(`DELETE repos/o/r/git/refs/heads/${head}-base`)));
});
