import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { Changed, Frames, Machine, frame, inside, reconcile, restore, snapshot, take } from '../public/machine-sync.mjs';
import { HttpError, json } from '../src/http.ts';
import { dropMachineRefs, readsDisk, stateCall, type StateDeps } from '../src/machine-sync.ts';
import type { Project } from '../src/db.ts';
import type { Placed } from '../src/machine-turn.ts';
import { projectSlug } from '../src/sessions.ts';
import { tempRoot } from './helpers.ts';

const tmp = tempRoot('machine-sync-');
const root = tmp.dir;
after(() => tmp.teardown());

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@b', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@b', GIT_CONFIG_GLOBAL: '/dev/null' } }).trim();
const put = (file: string, text: string | Buffer) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};

/** Every file of a worktree but git's own: its bytes, whether it runs, where a link goes. */
function all(dir: string) {
  const files: Record<string, string> = {};
  for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    const path = join(e.parentPath, e.name);
    const rel = path.slice(dir.length + 1);
    if (rel === '.git' || rel.startsWith('.git/') || e.isDirectory()) continue;
    const st = lstatSync(path);
    files[rel] = e.isSymbolicLink() ? `-> ${readlinkSync(path)}` : `${st.mode & 0o100 ? 'x' : '-'} ${readFileSync(path).toString('base64')}`;
  }
  return files;
}
/** What git says of it: branch, commit, staged and not, and what is under way. */
const gitView = (dir: string) => ({ status: sh(dir, 'status', '--porcelain=v2', '--branch', '--untracked-files=all'), staged: sh(dir, 'diff', '--cached', '--raw', '--no-abbrev'), stages: sh(dir, 'ls-files', '-s') });

let n = 0;
/** A scheme's repo and a minion's worktree on this server, the calls a machine makes, and a machine with nothing on it. */
async function scheme(o: { landing?: () => boolean } = {}) {
  const home = join(root, `s${++n}`);
  const server = join(home, 'server');
  const repo = join(server, 'repo');
  const cwd = join(server, 'tickets', '7');
  const config = join(server, 'config');
  mkdirSync(repo, { recursive: true });
  sh(repo, 'init', '-q', '-b', 'main');
  put(join(repo, 'a.txt'), 'one\n');
  put(join(repo, 'b.txt'), 'two\n');
  put(join(repo, 'dir', 'gone.txt'), 'x\n');
  put(join(repo, '.gitignore'), 'ignored/\n');
  put(join(repo, '.githooks', 'post-checkout'), '#!/bin/sh\nexit 1\n');
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-qm', 'first');
  sh(repo, 'config', 'remote.origin.url', 'https://me:secret@example.com/x.git');
  sh(repo, 'config', 'core.hooksPath', join(repo, '.githooks'));
  sh(repo, '-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '-q', '-b', 'ticket/7', cwd);
  const session = '11111111-2222-3333-4444-555555555555';
  const ticket = { id: 7, cwd, project_id: 2, session_id: session as string | null };
  const notes: string[] = [];
  const told: string[] = [];
  /** The machine's calls are about a copy it holds (src/machine-away.ts), not a running turn. */
  const mode = { copy: false };
  const deps = {
    tell: (_id: number, text: string) => told.push(text),
    store: { getTicket: () => ticket, getProject: () => ({ id: 2, repo_dir: repo }) },
    files: () => join(server, 'shared', '7'),
    uploads: () => join(server, 'uploads', '7'),
    shared: () => join(server, 'shared', 'project'),
    landing: async () => o.landing?.() ?? false,
    note: (_id: number, text: string) => notes.push(text),
  } as unknown as StateDeps;
  const dir = join(server, 'turns', 'turn-1');
  mkdirSync(dir, { recursive: true });
  const at = { id: 1, name: 'Desk', wrapper: [], cwd, home: '/h', roots: [], state: { ticket: 7, config: { here: config, there: '/h/.claude' } } } as Placed;
  const calls: string[] = [];
  const bytes: number[] = [];
  /** Calls whose answer is lost. */
  const lose = new Set<string>();
  const http = createServer((req, res) => {
    const op = new URL(req.url!, 'http://x').pathname.slice('/_state/'.length);
    calls.push(op);
    if (lose.has(op)) res.writeHead = () => res.destroy() as never;
    const { bytesRead, bytesWritten } = req.socket;
    res.on('close', () => bytes.push(req.socket.bytesRead - bytesRead + req.socket.bytesWritten - bytesWritten));
    stateCall(deps, op, dir, at, req, res, mode.copy).catch((err) => (res.headersSent ? res.destroy() : json(res, err instanceof HttpError ? err.status : 500, { error: String(err.message) })));
  });
  const port = await tmp.serve(http);
  const prefix = join(home, 'machine');
  const machine = new Machine({ app: `http://127.0.0.1:${port}`, dir, state: join(server, 'turns', '.sync'), prefix });
  return { server, repo, cwd, config, session, ticket, notes, told, mode, calls, bytes, lose, dir, machine, there: prefix + cwd, prefix, slug: projectSlug(cwd) };
}

/** A worktree in every state a turn leaves one in. */
function mess(cwd: string) {
  put(join(cwd, 'a.txt'), 'staged\n');
  sh(cwd, 'add', 'a.txt');
  put(join(cwd, 'a.txt'), 'staged, then changed\n');
  put(join(cwd, 'committed.bin'), Buffer.from([0, 255, 1, 254]));
  sh(cwd, 'add', 'committed.bin');
  unlinkSync(join(cwd, 'dir', 'gone.txt'));
  put(join(cwd, 'new', 'untracked ünï.txt'), 'u\n');
  put(join(cwd, 'run.sh'), '#!/bin/sh\n');
  chmodSync(join(cwd, 'run.sh'), 0o755);
  symlinkSync('a.txt', join(cwd, 'link'));
  put(join(cwd, 'empty'), '');
}

test('a worktree goes to a machine and comes back with every file, its index and its branch the same', async () => {
  const s = await scheme();
  mess(s.cwd);
  put(join(s.cwd, 'ignored', 'big'), 'stays');
  put(join(s.cwd, '.env'), 'KEY=1');
  const before = gitView(s.cwd);
  const files = all(s.cwd);
  await s.machine.sync({ start: true });
  const { '.env': _, 'ignored/big': __, ...sent } = files;
  assert.deepEqual(all(s.there), sent, 'all but ignored files and keys');
  const { '.env': _a, ...noEnv } = all(s.there);
  assert.equal(gitView(s.there).staged, before.staged);
  assert.equal(gitView(s.there).stages, before.stages);
  assert.deepEqual(noEnv, all(s.there));
  assert.deepEqual(all(s.cwd), files, 'the copy here is as it was');
  assert.deepEqual(gitView(s.cwd), before);
  assert.equal(sh(s.there, 'symbolic-ref', 'HEAD'), 'refs/heads/ticket/7');
  assert.ok(existsSync(join(s.prefix + s.repo, '.githooks', 'post-checkout')), "the scheme's own checkout is there for what reads it by path");
  assert.equal(sh(s.there, 'config', 'remote.origin.url'), 'https://example.com/x.git', 'no login goes along');

  // The turn works: commits, stages, deletes, leaves things about.
  sh(s.there, '-c', 'core.hooksPath=/dev/null', 'commit', '-qam', 'on the machine');
  put(join(s.there, 'a.txt'), 'after\n');
  put(join(s.there, 'more.txt'), 'm\n');
  sh(s.there, 'add', 'more.txt');
  unlinkSync(join(s.there, 'link'));
  unlinkSync(join(s.there, 'new', 'untracked ünï.txt'));
  put(join(s.there, 'id_rsa'), 'key');
  sh(s.there, 'branch', 'side');
  await s.machine.sync({});
  const { id_rsa: _k, ...came } = all(s.there);
  assert.deepEqual(all(s.cwd), { ...came, '.env': files['.env'], 'ignored/big': files['ignored/big'] });
  assert.equal(gitView(s.cwd).staged, gitView(s.there).staged);
  assert.equal(sh(s.cwd, 'rev-parse', 'ticket/7'), sh(s.there, 'rev-parse', 'HEAD'));
  assert.equal(sh(s.cwd, 'symbolic-ref', 'HEAD'), 'refs/heads/ticket/7');
  assert.equal(sh(s.repo, 'rev-parse', 'side'), sh(s.there, 'rev-parse', 'side'));
  assert.deepEqual(s.notes, []);

  // Nothing new: nothing moves.
  const was = s.calls.length;
  await s.machine.sync({});
  assert.deepEqual(s.calls.slice(was), ['look', 'done']);

  // The next turn here, then one there again: only what is new goes.
  sh(s.cwd, '-c', 'core.hooksPath=/dev/null', 'commit', '-qam', 'home again');
  put(join(s.cwd, 'home.txt'), 'h');
  await s.machine.sync({ start: true });
  const { '.env': _e, 'ignored/big': _i, ...now } = all(s.cwd);
  const { id_rsa: _k2, ...far } = all(s.there);
  assert.deepEqual(far, now);
  assert.equal(sh(s.there, 'rev-parse', 'HEAD'), sh(s.cwd, 'rev-parse', 'HEAD'));
});

test('a checkpoint sends only what changed: an untracked file already there does not go again', async () => {
  const s = await scheme();
  await s.machine.sync({ start: true });
  put(join(s.there, 'big.bin'), randomBytes(300_000));
  await s.machine.sync({});
  put(join(s.there, 'small.txt'), 'x');
  s.bytes.length = 0;
  await s.machine.sync({});
  assert.ok(existsSync(join(s.cwd, 'small.txt')));
  assert.ok(s.bytes.reduce((a, b) => a + b, 0) < 50_000, `sent ${s.bytes}`);
  s.bytes.length = 0;
  put(join(s.cwd, 'home.txt'), 'x');
  await s.machine.sync({});
  assert.ok(existsSync(join(s.there, 'home.txt')));
});

test('a checkpoint with a new commit sends that commit, not the repo, and once', async () => {
  const s = await scheme();
  put(join(s.cwd, 'hist.bin'), randomBytes(1_000_000));
  sh(s.cwd, 'add', '-A');
  sh(s.cwd, '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'big');
  await s.machine.sync({ start: true });
  for (const lost of [false, true]) {
    put(join(s.there, 'a.txt'), `commit ${lost}\n`);
    sh(s.there, 'commit', '-qam', `commit ${lost}`);
    if (lost) {
      s.lose.add('unpack');
      await assert.rejects(s.machine.sync({}));
      s.lose.clear();
    }
    s.calls.length = 0;
    s.bytes.length = 0;
    await s.machine.sync({});
    assert.deepEqual(s.calls, ['look', 'unpack', 'commit', 'done']);
    assert.ok(s.bytes.reduce((a, b) => a + b, 0) < 50_000, `sent ${s.bytes}`);
    assert.equal(sh(s.cwd, 'log', '-1', '--format=%s'), `commit ${lost}`);
  }
});

test('a merge under way, its conflict and its message survive the trip both ways', async () => {
  const s = await scheme();
  const c = (cwd: string, ...a: string[]) => sh(cwd, '-c', 'core.hooksPath=/dev/null', ...a);
  c(s.cwd, 'checkout', '-qb', 'other');
  put(join(s.cwd, 'a.txt'), 'theirs\n');
  c(s.cwd, 'commit', '-qam', 'theirs');
  c(s.cwd, 'checkout', '-q', 'ticket/7');
  put(join(s.cwd, 'a.txt'), 'ours\n');
  c(s.cwd, 'commit', '-qam', 'ours');
  assert.throws(() => c(s.cwd, 'merge', 'other'));
  const before = gitView(s.cwd);
  await s.machine.sync({ start: true });
  assert.deepEqual(gitView(s.there), before);
  put(join(s.there, 'a.txt'), 'both\n');
  c(s.there, 'add', 'a.txt');
  c(s.there, 'commit', '-qm', 'merged there');
  await s.machine.sync({});
  assert.equal(sh(s.cwd, 'rev-list', '--parents', '-1', 'HEAD').split(' ').length, 3);
  assert.equal(sh(s.cwd, 'status', '--porcelain'), '');
  assert.equal(existsSync(join(s.repo, '.git', 'worktrees', '7', 'MERGE_HEAD')), false);
});

test('a rebase stopped half way goes along and can be finished on the machine', async () => {
  const s = await scheme();
  const c = (cwd: string, ...a: string[]) => sh(cwd, '-c', 'core.hooksPath=/dev/null', '-c', 'core.editor=true', ...a);
  put(join(s.cwd, 'a.txt'), 'ours\n');
  c(s.cwd, 'commit', '-qam', 'ours');
  put(join(s.repo, 'a.txt'), 'main\n');
  c(s.repo, 'commit', '-qam', 'main moved');
  assert.throws(() => c(s.cwd, 'rebase', 'main'));
  await s.machine.sync({ start: true });
  assert.equal(gitView(s.there).stages, gitView(s.cwd).stages);
  put(join(s.there, 'a.txt'), 'fixed\n');
  c(s.there, 'add', 'a.txt');
  c(s.there, 'rebase', '--continue');
  await s.machine.sync({});
  assert.equal(sh(s.cwd, 'symbolic-ref', 'HEAD'), 'refs/heads/ticket/7');
  assert.equal(sh(s.cwd, 'log', '--format=%s', '-2'), 'ours\nmain moved');
  assert.equal(readFileSync(join(s.cwd, 'a.txt'), 'utf8'), 'fixed\n');
});

test('a repo inside the worktree is left out, and the rest still goes', async () => {
  const s = await scheme();
  for (const [dir, commit] of [
    ['nested', true],
    ['bare', false],
  ] as const) {
    mkdirSync(join(s.cwd, dir));
    sh(join(s.cwd, dir), 'init', '-q');
    put(join(s.cwd, dir, 'f'), 'f');
    if (commit) sh(join(s.cwd, dir), 'add', '-A');
    if (commit) sh(join(s.cwd, dir), 'commit', '-qm', 'x');
  }
  put(join(s.cwd, 'kept.txt'), 'k');
  await s.machine.sync({ start: true });
  assert.ok(existsSync(join(s.there, 'kept.txt')));
  assert.ok(!existsSync(join(s.there, 'nested')));
  put(join(s.there, 'back.txt'), 'b');
  await s.machine.sync({});
  assert.ok(existsSync(join(s.cwd, 'back.txt')));
  assert.equal(readFileSync(join(s.cwd, 'nested', 'f'), 'utf8'), 'f');
  assert.equal(readFileSync(join(s.cwd, 'bare', 'f'), 'utf8'), 'f');
});

test('files that changed here meanwhile are kept, and the machine’s copy is put in place', async () => {
  const s = await scheme();
  await s.machine.sync({ start: true });
  put(join(s.cwd, 'b.txt'), 'changed at home\n');
  put(join(s.there, 'a.txt'), 'changed there\n');
  await s.machine.sync({});
  assert.equal(readFileSync(join(s.cwd, 'a.txt'), 'utf8'), 'changed there\n');
  const ref = /refs\/citadel\/kept\S+/.exec(s.notes.join())![0];
  assert.equal(sh(s.repo, 'show', `${ref}:work/b.txt`), 'changed at home');
});

test('a worktree whose commit moved here, or that is being shipped, is not written over: the copy is kept and said', async () => {
  let landing = false;
  const s = await scheme({ landing: () => landing });
  await s.machine.sync({ start: true });
  landing = true;
  put(join(s.there, 'a.txt'), 'while shipping\n');
  await s.machine.sync({});
  await s.machine.sync({});
  assert.equal(readFileSync(join(s.cwd, 'a.txt'), 'utf8'), 'one\n');
  assert.equal(s.notes.length, 1, 'said once');
  assert.match(s.notes[0], /is being shipped/);
  assert.equal(sh(s.repo, 'show', 'refs/citadel/kept/7/turn-1/work:work/a.txt'), 'while shipping');
  landing = false;
  sh(s.cwd, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '--allow-empty', '-m', 'rebased by the ship');
  await s.machine.sync({});
  assert.equal(readFileSync(join(s.cwd, 'a.txt'), 'utf8'), 'one\n');
  assert.match(s.notes[1], /moved while the turn worked on Desk/);
});

test('a worktree that moved here while the turn changed nothing there goes to the machine', async () => {
  const s = await scheme();
  await s.machine.sync({ start: true });
  put(join(s.cwd, 'made-by-a-tool.txt'), 't\n');
  sh(s.cwd, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '--allow-empty', '-m', 'ship');
  await s.machine.sync({});
  assert.equal(readFileSync(join(s.there, 'made-by-a-tool.txt'), 'utf8'), 't\n');
  assert.equal(sh(s.there, 'rev-parse', 'HEAD'), sh(s.cwd, 'rev-parse', 'HEAD'));
  put(join(s.there, 'then.txt'), 'x');
  await s.machine.sync({});
  assert.ok(existsSync(join(s.cwd, 'then.txt')));
  assert.deepEqual(s.notes, []);
});

test('a restore cut off by a restart is finished before anything else is read', async () => {
  const s = await scheme();
  await s.machine.sync({ start: true });
  put(join(s.there, 'a.txt'), 'new\n');
  put(join(s.there, 'b.txt'), 'new\n');
  const snap = await snapshot(s.there);
  sh(s.repo, 'update-ref', 'refs/citadel/machine/7-from', (await snapshot(s.cwd)).sha);
  sh(s.repo, 'fetch', '-q', join(s.prefix + s.repo, '.git'), `${snap.sha}:refs/citadel/machine/7-next`);
  put(join(s.cwd, 'a.txt'), 'new\n'); // half done
  await s.machine.sync({});
  assert.equal(readFileSync(join(s.cwd, 'b.txt'), 'utf8'), 'new\n');
  assert.deepEqual(s.notes, []);
  assert.equal(sh(s.repo, 'for-each-ref', 'refs/citadel/machine/7-next', 'refs/citadel/machine/7-from'), '');
});

test('a branch another worktree here is on, main among them, is never moved by a machine', async () => {
  const s = await scheme();
  await s.machine.sync({ start: true });
  const main = sh(s.repo, 'rev-parse', 'main');
  const other = join(s.server, 'tickets', '8');
  sh(s.repo, '-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '-q', '-b', 'ticket/8', other);
  sh(s.there, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '--allow-empty', '-m', 'x');
  sh(s.there, 'update-ref', 'refs/heads/main', 'HEAD');
  sh(s.there, 'update-ref', 'refs/heads/ticket/8', 'HEAD');
  await s.machine.sync({});
  assert.equal(sh(s.repo, 'rev-parse', 'main'), main);
  assert.equal(sh(s.repo, 'rev-parse', 'ticket/8'), main);
  assert.equal(sh(s.cwd, 'log', '-1', '--format=%s'), 'x');
});

test('work a lost turn left on the machine is kept aside when the next one starts, and comes home beside the worktree', async () => {
  const s = await scheme();
  await s.machine.sync({ start: true });
  put(join(s.there, 'a.txt'), 'never sent\n');
  await s.machine.sync({ start: true });
  assert.equal(readFileSync(join(s.there, 'a.txt'), 'utf8'), 'one\n');
  assert.equal(readFileSync(join(s.cwd, 'a.txt'), 'utf8'), 'one\n', 'nothing merges by itself');
  assert.equal(sh(s.there, 'for-each-ref', 'refs/citadel/left'), '', 'brought home, so gone there');
  const refs = sh(s.repo, 'for-each-ref', '--format=%(refname)', 'refs/citadel/away/7').split('\n');
  assert.equal(refs.length, 1);
  assert.match(refs[0], /^refs\/citadel\/away\/7\/\d{8}-\d{6}$/);
  assert.equal(sh(s.repo, 'show', `${refs[0]}:work/a.txt`), 'never sent');
  assert.match(s.told.join('\n'), /never came home.*refs\/citadel\/away\/7\//);
  await s.machine.sync({ start: true });
  assert.equal(sh(s.repo, 'for-each-ref', 'refs/citadel/away/7').split('\n').length, 1, 'once');
});

test('two snapshots kept aside in the same second are both kept; a folder sent again after a failed try is taken again', async () => {
  const s = await scheme();
  await s.machine.sync({ start: true });
  const real = Date.now;
  const second = Math.floor(real() / 1000) * 1000 + 400;
  Date.now = () => second; // the machine's clock and this one, in the same second for both
  try {
    put(join(s.there, 'a.txt'), 'first\n');
    await s.machine.sync({ start: true });
    put(join(s.there, 'a.txt'), 'second\n');
    await s.machine.sync({ start: true });
  } finally {
    Date.now = real;
  }
  const refs = sh(s.repo, 'for-each-ref', '--format=%(refname)', 'refs/citadel/away/7').split('\n');
  assert.equal(refs.length, 2, refs.join());
  assert.deepEqual(refs.map((r) => sh(s.repo, 'show', `${r}:work/a.txt`)).sort(), ['first', 'second'], 'neither written over');

  // A folder sent aside under its own time, whose first try stopped after this file arrived: the retry takes it again.
  const left = join(tmp.dir, 'left-again');
  put(join(left, 'x.txt'), 'sent twice\n');
  const aside = real();
  assert.equal((await s.machine.put(left, 'files', ['x.txt'], aside)).length, 1);
  assert.equal((await s.machine.put(left, 'files', ['x.txt'], aside)).length, 1, 'taken again, not refused as changed');
  put(join(left, 'x.txt'), 'changed there\n');
  await assert.rejects(s.machine.put(left, 'files', ['x.txt'], aside), /could not be written there/, 'a different file at that place is never written over');
});

test('a machine whose minion went on without it sends everything it holds home aside, then its copy can go', async () => {
  const s = await scheme();
  const log = join('projects', s.slug, `${s.session}.jsonl`);
  put(join(s.config, log), '{"n":1}\n');
  await s.machine.sync({ start: true });
  // The turn on the machine works on, and never sends it.
  put(join(s.there, 'a.txt'), 'only there\n');
  sh(s.there, 'tag', 'v-there');
  sh(s.there, 'stash', 'push', '-q', '-m', 'kept');
  put(join(s.there, 'a.txt'), 'only there\n');
  put(join(s.prefix, '/h/.claude', log), '{"n":1}\n{"n":"there"}\n');
  put(join(s.prefix + s.server, 'shared', '7', 'report.md'), 'made there');
  // Meanwhile the minion carried on here.
  put(join(s.cwd, 'b.txt'), 'here\n');
  put(join(s.server, 'shared', '7', 'report.md'), 'made here');
  s.mode.copy = true;
  await assert.rejects(s.machine.sync({}), /has ended/, 'a copy is not a turn: it may only send aside');
  await s.machine.rescue();
  assert.equal(readFileSync(join(s.cwd, 'b.txt'), 'utf8'), 'here\n');
  assert.equal(readFileSync(join(s.server, 'shared', '7', 'report.md'), 'utf8'), 'made here', 'what is here stays');
  const refs = sh(s.repo, 'for-each-ref', '--format=%(refname)', 'refs/citadel/away/7').split('\n');
  const work = refs.find((r) => /\d{6}$/.test(r))!;
  assert.equal(sh(s.repo, 'show', `${work}:work/a.txt`), 'only there');
  assert.ok(
    refs.some((r) => r.endsWith('-tags/v-there')),
    'a tag made there',
  );
  assert.ok(
    refs.some((r) => /-stash\/[0-9a-f]{40}$/.test(r)),
    refs.join(),
  );
  const away = join(s.server, 'shared', '7', 'away');
  const [time] = readdirSync(away);
  assert.equal(readFileSync(join(away, time, 'files', 'report.md'), 'utf8'), 'made there');
  assert.match(readFileSync(join(away, time, 'session', `${s.session}.jsonl`), 'utf8'), /there/);
  assert.equal(s.told.length, 1);
  await s.machine.rescue();
  assert.equal(s.told.length, 1, 'sent once');
  assert.deepEqual(await s.machine.clear(false), {});
  assert.ok(!existsSync(s.there), 'its worktree there is gone');
  assert.ok(!existsSync(join(s.prefix, '/h/.claude', 'projects', s.slug)), 'and its session');
  assert.ok(!existsSync(join(s.prefix + s.server, 'shared', '7')), 'and its files folder');
  assert.ok(existsSync(join(s.prefix + s.server, 'shared', 'project')) || true);
  assert.equal(sh(s.prefix + s.repo, 'for-each-ref', 'refs/citadel/machine'), '');
  assert.ok(existsSync(join(s.prefix + s.repo, '.git')), "the scheme's copy stays for its other minions");
});

test('a copy holding a repo of its own or a key the server never gets is not deleted', async () => {
  const s = await scheme();
  await s.machine.sync({ start: true });
  put(join(s.there, 'deploy.pem'), 'key');
  s.mode.copy = true;
  assert.match((await s.machine.clear(false)).stays ?? '', /deploy\.pem/);
  assert.ok(existsSync(join(s.there, 'deploy.pem')));
  unlinkSync(join(s.there, 'deploy.pem'));
  assert.deepEqual(await s.machine.clear(true), {});
  assert.ok(!existsSync(s.prefix + s.repo), 'removing the machine takes the scheme copy too, once no other minion is on it');
});

test('what the server has cleaned up since is sent again whole', async () => {
  const s = await scheme();
  put(join(s.cwd, 'big.txt'), 'line\n'.repeat(5000) + Math.random());
  put(join(s.cwd, 'unchanged.txt'), 'only in the snapshot');
  await s.machine.sync({ start: true });
  for (const r of ['7', '7-home']) sh(s.repo, 'update-ref', '-d', `refs/citadel/machine/${r}`);
  sh(s.repo, 'reflog', 'expire', '--expire=now', '--all');
  sh(s.repo, 'gc', '-q', '--prune=now');
  unlinkSync(join(s.cwd, 'big.txt')); // or its next snapshot would make the objects anew
  unlinkSync(join(s.cwd, 'unchanged.txt'));
  put(join(s.there, 'big.txt'), `${readFileSync(join(s.there, 'big.txt'), 'utf8')}more\n`);
  await s.machine.sync({});
  assert.equal(s.calls.filter((c) => c === 'unpack').length, 2);
  assert.match(readFileSync(join(s.cwd, 'big.txt'), 'utf8'), /more/);
  assert.equal(readFileSync(join(s.cwd, 'unchanged.txt'), 'utf8'), 'only in the snapshot');
});

test('a lost answer: what it applied here is no change of here’s, and the next checkpoint goes over it', async () => {
  const s = await scheme();
  await s.machine.sync({ start: true });
  const mark = sh(s.there, 'rev-parse', 'refs/citadel/machine/7').trim();
  put(join(s.there, 'a.txt'), 'first\n');
  sh(s.there, 'commit', '-qam', 'first on the machine');
  await s.machine.sync({});
  // As if the answer had not come: the machine thinks nothing went.
  sh(s.there, 'update-ref', 'refs/citadel/machine/7', mark);
  put(join(s.there, 'a.txt'), 'second\n');
  sh(s.there, 'commit', '-qam', 'second on the machine');
  assert.deepEqual(await s.machine.sync({}), { kept: null });
  assert.equal(sh(s.cwd, 'log', '-1', '--format=%s').trim(), 'second on the machine');
  assert.deepEqual(s.notes, []);
  // And undone there after a lost answer, it is undone here.
  put(join(s.there, 'a.txt'), 'third\n');
  const before = sh(s.there, 'rev-parse', 'refs/citadel/machine/7').trim();
  await s.machine.sync({});
  sh(s.there, 'update-ref', 'refs/citadel/machine/7', before);
  sh(s.there, 'checkout', '-q', 'a.txt');
  await s.machine.sync({});
  assert.equal(readFileSync(join(s.cwd, 'a.txt'), 'utf8'), 'second\n');
  assert.equal(readFileSync(join(s.there, 'a.txt'), 'utf8'), 'second\n');
});

test('a branch another worktree here holds: the copy here is detached, and later work still comes home', async () => {
  const s = await scheme();
  sh(s.repo, '-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '-q', '-b', 'other', join(s.server, 'tickets', '8'));
  await s.machine.sync({ start: true });
  sh(s.there, 'symbolic-ref', 'HEAD', 'refs/heads/other');
  put(join(s.there, 'a.txt'), 'there\n');
  await s.machine.sync({});
  await s.machine.sync({});
  assert.equal(sh(s.there, 'symbolic-ref', 'HEAD').trim(), 'refs/heads/other', 'an idle checkpoint moves nothing under the turn');
  put(join(s.there, 'a.txt'), 'later\n');
  await s.machine.sync({});
  assert.equal(readFileSync(join(s.cwd, 'a.txt'), 'utf8'), 'later\n');
});

test('a worktree edited, committed to or locked while a copy is on its way is not written over', async () => {
  const s = await scheme();
  put(join(s.cwd, 'new.txt'), 'kept\n');
  const from = await snapshot(s.cwd);
  put(join(s.cwd, 'a.txt'), 'target\n');
  const target = await snapshot(s.cwd);
  put(join(s.cwd, 'a.txt'), 'one\n');
  put(join(s.cwd, 'b.txt'), 'edited just now\n');
  await assert.rejects(restore(s.cwd, target.sha, { from: from.sha }), Changed);
  assert.equal(readFileSync(join(s.cwd, 'b.txt'), 'utf8'), 'edited just now\n');
  put(join(s.cwd, 'b.txt'), 'two\n');
  // Between the look and the write: the very file it would replace.
  await assert.rejects(restore(s.cwd, target.sha, { from: from.sha, before: async () => put(join(s.cwd, 'a.txt'), 'in the last moment\n') }));
  assert.equal(readFileSync(join(s.cwd, 'a.txt'), 'utf8'), 'in the last moment\n');
  put(join(s.cwd, 'a.txt'), 'one\n');
  // A branch that moved: nothing is changed.
  await assert.rejects(restore(s.cwd, target.sha, { from: from.sha, refs: [`update refs/heads/ticket/7 ${from.sha} ${from.sha}`] }), Changed);
  assert.equal(readFileSync(join(s.cwd, 'a.txt'), 'utf8'), 'one\n');
  const gitDir = sh(s.cwd, 'rev-parse', '--absolute-git-dir').trim();
  // A lock a killed restore left is known as its own; anyone else's is waited for.
  writeFileSync(join(gitDir, 'citadel-index'), '');
  linkSync(join(gitDir, 'citadel-index'), join(gitDir, 'index.lock'));
  await restore(s.cwd, target.sha, { from: from.sha });
  assert.equal(readFileSync(join(s.cwd, 'a.txt'), 'utf8'), 'target\n');
  assert.ok(!existsSync(join(gitDir, 'index.lock')) && !existsSync(join(gitDir, 'citadel-index')));
  put(join(gitDir, 'index.lock'), '');
  await assert.rejects(restore(s.cwd, from.sha, { from: target.sha }), Changed);
  assert.ok(existsSync(join(gitDir, 'index.lock')));
  assert.equal((await snapshot(s.cwd)).sha, target.sha);
});

test('a worktree that cannot be changed here keeps its own: the turn’s is kept beside it, and whoever waits is told', async () => {
  const s = await scheme();
  await s.machine.sync({ start: true });
  const gitDir = sh(s.cwd, 'rev-parse', '--absolute-git-dir').trim();
  put(join(gitDir, 'index.lock'), '');
  put(join(s.there, 'a.txt'), 'there\n');
  const { kept } = await s.machine.sync({});
  assert.match(kept!, /kept in refs\/citadel\/kept\/7\/turn-1\/work/);
  assert.equal(readFileSync(join(s.cwd, 'a.txt'), 'utf8'), 'one\n');
  unlinkSync(join(gitDir, 'index.lock'));
  assert.deepEqual(await s.machine.sync({}), { kept: null });
  assert.equal(readFileSync(join(s.cwd, 'a.txt'), 'utf8'), 'there\n');
});

test('an apply cut off here, and work done here since: the work stands', async () => {
  const s = await scheme();
  await s.machine.sync({ start: true });
  put(join(s.there, 'a.txt'), 'there\n');
  await s.machine.sync({});
  const snap = sh(s.repo, 'rev-parse', 'refs/citadel/machine/7').trim();
  put(join(s.cwd, 'a.txt'), 'work here\n');
  sh(s.cwd, '-c', 'core.hooksPath=/dev/null', 'commit', '-qam', 'work here');
  sh(s.repo, 'update-ref', 'refs/citadel/machine/7-from', snap);
  sh(s.repo, 'update-ref', 'refs/citadel/machine/7-next', snap);
  await s.machine.sync({ start: true });
  assert.equal(sh(s.cwd, 'log', '-1', '--format=%s').trim(), 'work here');
  assert.equal(readFileSync(join(s.there, 'a.txt'), 'utf8'), 'work here\n');
  assert.equal(sh(s.repo, 'for-each-ref', 'refs/citadel/machine/7-next', 'refs/citadel/machine/7-from'), '');
});

test('an untracked file here that the machine only stopped sending stays here: one it now ignores, a key, a repo of its own', async () => {
  const s = await scheme();
  put(join(s.cwd, 'out', 'report.txt'), 'a report\n');
  put(join(s.cwd, 'lib', 'x.txt'), 'lib\n');
  put(join(s.cwd, 'plain.txt'), 'plain\n');
  put(join(s.cwd, 'server.key'), 'tracked key\n');
  sh(s.cwd, 'add', '-f', 'server.key');
  await s.machine.sync({ start: true });
  put(join(s.there, '.gitignore'), 'ignored/\nout/\n');
  sh(s.there, 'rm', '-q', '--cached', 'server.key');
  sh(join(s.there, 'lib'), 'init', '-q');
  unlinkSync(join(s.there, 'plain.txt'));
  await s.machine.sync({});
  assert.equal(readFileSync(join(s.cwd, 'out', 'report.txt'), 'utf8'), 'a report\n');
  assert.equal(readFileSync(join(s.cwd, 'server.key'), 'utf8'), 'tracked key\n');
  assert.ok(!existsSync(join(s.cwd, 'plain.txt')), 'a file deleted there goes');
  assert.match(s.notes.join('\n'), /lib: git repos of their own/);
  const ref = /files of lib that were here are kept in (\S+)/.exec(s.notes.join('\n'))![1];
  assert.equal(sh(s.repo, 'show', `${ref}:work/lib/x.txt`), 'lib');
});

test('a stash and a tag made on the machine come home', async () => {
  const s = await scheme();
  await s.machine.sync({ start: true });
  put(join(s.there, 'a.txt'), 'stashed\n');
  sh(s.there, 'stash', '-q');
  const other = join(s.prefix + s.server, 'tickets', '8');
  sh(s.prefix + s.repo, 'worktree', 'add', '-q', '-b', 'ticket/8', other);
  put(join(other, 'a.txt'), 'another minion');
  sh(other, 'stash', '-q');
  sh(s.there, 'tag', 'v1');
  await s.machine.sync({});
  const ref = /git stash made on Desk is kept in (\S+)/.exec(s.notes.join('\n'))![1];
  assert.equal(sh(s.repo, 'show', `${ref}:a.txt`), 'stashed');
  assert.equal(s.notes.length, 1, 'its own, not another minion’s');
  assert.equal(sh(s.repo, 'rev-parse', 'v1'), sh(s.cwd, 'rev-parse', 'HEAD'));
  s.calls.length = 0;
  await s.machine.sync({});
  assert.deepEqual(s.calls, ['look', 'done'], 'once');
});

test('a stash made before the turn moved to another branch comes home too', async () => {
  const s = await scheme();
  await s.machine.sync({ start: true });
  put(join(s.there, 'a.txt'), 'stashed work\n');
  sh(s.there, 'stash', '-q');
  sh(s.there, '-c', 'core.hooksPath=/dev/null', 'checkout', '-q', '-b', 'spike');
  await s.machine.sync({});
  put(join(s.there, 'a.txt'), 'more\n');
  sh(s.there, 'stash', '-q');
  sh(s.there, '-c', 'core.hooksPath=/dev/null', 'checkout', '-q', '-b', 'spike2');
  await s.machine.sync({ final: true });
  assert.equal(s.notes.filter((n) => /git stash made on Desk/.test(n)).length, 2);
});

test('side branches on the machine: one that never got home stays, names that clash and a stale copy’s hold stop no turn', async () => {
  const s = await scheme();
  sh(s.repo, 'branch', 'build');
  sh(s.repo, 'branch', 'side');
  await s.machine.sync({ start: true });
  sh(s.there, 'update-ref', 'refs/heads/side', sh(s.there, 'commit-tree', '-m', 'unsent', 'HEAD^{tree}').trim());
  const unsent = sh(s.there, 'rev-parse', 'side');
  sh(s.repo, 'branch', '-D', 'build');
  sh(s.repo, 'branch', 'build/7');
  // A closed minion's copy there, still on a branch this one has taken since, and further along.
  sh(join(s.prefix + s.repo), 'worktree', 'add', '-q', '-b', 'taken', join(s.prefix + s.server, 'tickets', '9'));
  put(join(s.prefix + s.server, 'tickets', '9', 'z.txt'), 'z');
  sh(join(s.prefix + s.server, 'tickets', '9'), 'add', '-A');
  sh(join(s.prefix + s.server, 'tickets', '9'), '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'further');
  const further = sh(join(s.prefix + s.server, 'tickets', '9'), 'rev-parse', 'HEAD');
  sh(s.cwd, '-c', 'core.hooksPath=/dev/null', 'checkout', '-q', '-b', 'taken');
  await s.machine.sync({ start: true });
  assert.equal(sh(s.there, 'rev-parse', 'side'), unsent);
  assert.equal(sh(s.there, 'rev-parse', 'build/7'), sh(s.repo, 'rev-parse', 'build/7'));
  assert.equal(sh(s.there, 'symbolic-ref', 'HEAD').trim(), 'refs/heads/taken');
  assert.ok(sh(s.repo, 'for-each-ref', '--format=%(objectname)', 'refs/citadel/away/7').includes(further.trim()), 'its commits are kept aside, at home');
  await s.machine.sync({});
  assert.equal(sh(s.repo, 'rev-parse', 'side'), unsent, 'and goes home at the next checkpoint');
});

test('folders: a script stays runnable, many deletes go in parts, and what cannot go home at the end is said', async () => {
  const s = await scheme();
  const shared = join(s.server, 'shared', 'project');
  put(join(shared, 'render.sh'), '#!/bin/sh\n');
  chmodSync(join(shared, 'render.sh'), 0o755);
  for (let i = 0; i < 450; i++) put(join(shared, 'many', `${i}.txt`), 'x');
  await s.machine.sync({ start: true });
  assert.ok(lstatSync(join(s.prefix + shared, 'render.sh')).mode & 0o100);
  put(join(s.prefix + shared, 'render.sh'), '#!/bin/sh\necho\n');
  for (let i = 0; i < 450; i++) unlinkSync(join(s.prefix + shared, 'many', `${i}.txt`));
  await s.machine.sync({});
  assert.ok(lstatSync(join(shared, 'render.sh')).mode & 0o100);
  assert.equal(s.calls.filter((c) => c === 'drop').length, 3);
  // A folder is where the file should go.
  mkdirSync(join(shared, 'notes'));
  put(join(shared, 'notes', 'deep.txt'), 'x');
  put(join(s.prefix + shared, 'notes'), 'a file\n');
  await s.machine.sync({ final: true });
  assert.match(s.notes.join(), /notes could not be written here. They are still on Desk/);
});

test('a transcript’s end that never got home is kept when the server’s goes over it, and sent home aside', async () => {
  const s = await scheme();
  const log = join('projects', s.slug, `${s.session}.jsonl`);
  put(join(s.config, log), '{"n":1}\n');
  await s.machine.sync({ start: true });
  const there = join(s.prefix, '/h/.claude', log);
  put(there, '{"n":1}\n{"n":"unsent"}\n');
  await s.machine.sync({ start: true });
  assert.equal(readFileSync(there, 'utf8'), '{"n":1}\n');
  const away = join(s.server, 'shared', '7', 'away');
  assert.match(readFileSync(join(away, readdirSync(away)[0], 'session', `${s.session}.jsonl`), 'utf8'), /unsent/, 'home, beside the record');
  assert.deepEqual(readdirSync(join(s.prefix + s.server, 'turns', '.sync', 'left')), [], 'and no longer kept there');
});

test('an answer lost with all the machine knew of it: the branch still follows, side branches too', async () => {
  const s = await scheme();
  await s.machine.sync({ start: true });
  const state = join(s.prefix + s.server, 'turns', '.sync');
  const baseFile = join(state, readdirSync(state).find((f) => f.startsWith('refs-'))!);
  sh(s.there, 'branch', 'side');
  put(join(s.there, 'a.txt'), 'first\n');
  sh(s.there, 'commit', '-qam', 'first');
  s.lose.add('commit');
  await assert.rejects(s.machine.sync({}));
  s.lose.clear();
  assert.equal(sh(s.cwd, 'log', '-1', '--format=%s'), 'first', 'it was applied');
  assert.match(readFileSync(baseFile, 'utf8'), /sent refs\/heads\/ticket\/7/);
  put(join(s.there, 'a.txt'), 'second\n');
  sh(s.there, 'commit', '-qam', 'second');
  sh(s.there, 'branch', '-f', 'side', 'HEAD');
  assert.deepEqual(await s.machine.sync({}), { kept: null });
  assert.equal(sh(s.cwd, 'symbolic-ref', 'HEAD'), 'refs/heads/ticket/7');
  assert.equal(sh(s.cwd, 'log', '-1', '--format=%s'), 'second');
  assert.equal(sh(s.repo, 'rev-parse', 'side'), sh(s.there, 'rev-parse', 'side'));
  assert.deepEqual(s.notes, []);
});

test('putting a copy in place, cut off half way: finished, with what was worked on since', async () => {
  for (const edited of [false, true]) {
    const s = await scheme();
    await s.machine.sync({ start: true });
    const from = (await snapshot(s.there)).sha;
    put(join(s.cwd, 'a.txt'), 'home\n');
    put(join(s.cwd, 'b.txt'), 'home\n');
    sh(s.cwd, '-c', 'core.hooksPath=/dev/null', 'commit', '-qam', 'home');
    const snap = (await snapshot(s.cwd)).sha;
    sh(s.there, 'fetch', '-q', join(s.repo, '.git'), `${snap}:refs/citadel/machine/7-next`);
    sh(s.there, 'update-ref', 'refs/citadel/machine/7-from', from);
    sh(s.there, 'update-ref', 'refs/heads/ticket/7', sh(s.cwd, 'rev-parse', 'HEAD'));
    put(join(s.there, 'a.txt'), 'home\n');
    if (edited) put(join(s.there, 'b.txt'), 'the turn\n');
    await s.machine.sync({});
    assert.equal(sh(s.cwd, 'log', '-1', '--format=%s'), 'home');
    assert.equal(readFileSync(join(s.cwd, 'b.txt'), 'utf8'), edited ? 'the turn\n' : 'home\n');
    assert.equal(readFileSync(join(s.there, 'b.txt'), 'utf8'), edited ? 'the turn\n' : 'home\n');
    assert.equal(sh(s.there, 'for-each-ref', 'refs/citadel/machine/7-next'), '');
  }
  const s = await scheme();
  await s.machine.sync({ start: true });
  const from = (await snapshot(s.cwd)).sha;
  put(join(s.there, 'a.txt'), 'there\n');
  const snap = (await snapshot(s.there)).sha;
  sh(s.repo, 'fetch', '-q', join(s.prefix + s.repo, '.git'), `${snap}:refs/citadel/machine/7-next`);
  sh(s.repo, 'update-ref', 'refs/citadel/machine/7-from', from);
  put(join(s.cwd, 'a.txt'), 'a person\n');
  await s.machine.sync({ roots: [] });
  assert.match(s.notes.join(), /cut off by a restart \(work was done in it since\).*kept\/7\/turn-1\/work/);
  const before = /one from here is kept in (\S+)/.exec(s.notes.join('\n'))![1];
  assert.equal(sh(s.repo, 'show', `${before}:work/a.txt`), 'a person', 'and it is kept');
});

/** Run `f` with git failing at a step: the one that writes a worktree's files. */
async function cutShort(s: Awaited<ReturnType<typeof scheme>>, f: () => Promise<unknown>, step = 'read-tree -m -u') {
  const bin = join(s.server, 'bin');
  put(join(bin, 'git'), `#!/bin/bash\nif [[ " $* " == *" ${step} "* && " $* " != *" -n "* ]]; then exit 128; fi\nPATH=\${PATH#*:} exec git "$@"\n`);
  chmodSync(join(bin, 'git'), 0o755);
  const { PATH } = process.env;
  process.env.PATH = `${bin}:${PATH}`;
  try {
    await assert.rejects(f());
  } finally {
    process.env.PATH = PATH;
  }
}

test('a pull cut off on the machine, and the turn worked on: what came stays, what the turn did goes home, nothing is undone', async () => {
  const hooks = ['-c', 'core.hooksPath=/dev/null'];
  const setUp = async () => {
    const s = await scheme();
    await s.machine.sync({ start: true });
    put(join(s.cwd, 'a.txt'), 'home work\n');
    put(join(s.cwd, 'n.txt'), 'n\n');
    sh(s.cwd, 'add', '-A');
    sh(s.cwd, ...hooks, 'commit', '-qm', 'rebased at home');
    await cutShort(s, () => s.machine.sync({}));
    return s;
  };
  const whole = (s: Awaited<ReturnType<typeof scheme>>) => {
    for (const at of [s.cwd, s.there]) {
      assert.equal(readFileSync(join(at, 'a.txt'), 'utf8'), 'home work\n');
      assert.equal(readFileSync(join(at, 'n.txt'), 'utf8'), 'n\n');
    }
    assert.equal(sh(s.repo, 'for-each-ref', 'refs/citadel/kept'), '');
    assert.equal(sh(s.there, 'for-each-ref', 'refs/citadel/machine/7-next', 'refs/citadel/machine/7-from'), '');
  };

  // It wrote another file.
  const s = await setUp();
  put(join(s.there, 'unrelated.txt'), 'turn\n');
  assert.deepEqual(await s.machine.sync({ final: true }), { kept: null });
  whole(s);
  assert.equal(sh(s.cwd, 'status', '--porcelain'), '?? unrelated.txt');

  // Cut off again, then git's lock held for longer than it waits: the next one still knows.
  const t = await setUp();
  put(join(t.there, 'b.txt'), 'turn\n');
  await cutShort(t, () => t.machine.sync({}));
  const lock = join(sh(t.there, 'rev-parse', '--absolute-git-dir'), 'index.lock');
  put(lock, '');
  await assert.rejects(t.machine.sync({}), Changed);
  unlinkSync(lock);
  assert.deepEqual(await t.machine.sync({ final: true }), { kept: null });
  whole(t);
  assert.equal(sh(t.cwd, 'status', '--porcelain'), 'M b.txt');

  // It edited a file that came too: its edit stays.
  const u = await setUp();
  put(join(u.there, 'a.txt'), 'turn\n');
  assert.deepEqual(await u.machine.sync({ final: true }), { kept: null });
  assert.equal(readFileSync(join(u.cwd, 'a.txt'), 'utf8'), 'turn\n');
  assert.equal(readFileSync(join(u.there, 'n.txt'), 'utf8'), 'n\n');

  // It committed: on the commit from before, so it and the one here are two lines of work, and neither holds an undo of the other.
  const v = await setUp();
  put(join(v.there, 'mine.txt'), 'turn\n');
  sh(v.there, 'add', 'mine.txt');
  sh(v.there, ...hooks, 'commit', '-qm', 'turn');
  assert.match((await v.machine.sync({ final: true })).kept!, /moved while the turn worked/);
  const kept = /kept in (\S+) \(/.exec(v.notes.join('\n'))![1];
  assert.equal(sh(v.repo, 'show', '--name-only', '--format=%s', `${kept}^`), 'turn\n\nmine.txt');
  assert.equal(sh(v.there, 'status', '--porcelain'), '');
  assert.equal(readFileSync(join(v.there, 'a.txt'), 'utf8'), 'one\n');
  assert.equal(sh(v.cwd, 'log', '-1', '--format=%s'), 'rebased at home');

  // It staged a file, and commits once that pull is finished.
  const w = await setUp();
  put(join(w.there, 'mine.txt'), 'turn\n');
  sh(w.there, 'add', 'mine.txt');
  assert.deepEqual(await w.machine.sync({}), { kept: null });
  whole(w);
  assert.equal(sh(w.there, 'status', '--porcelain'), 'A  mine.txt');
  sh(w.there, ...hooks, 'commit', '-qm', 'turn');
  assert.deepEqual(await w.machine.sync({ final: true }), { kept: null });
  assert.equal(sh(w.cwd, 'show', '--name-only', '--format=%s'), 'turn\n\nmine.txt');
  assert.equal(sh(w.cwd, 'log', '-1', '--format=%s', 'HEAD^'), 'rebased at home');

  // Home was on another branch by then, a new one or one the machine has.
  for (const there of [false, true]) {
    const y = await scheme();
    if (there) sh(y.repo, 'branch', 'other');
    await y.machine.sync({ start: true });
    sh(y.cwd, ...hooks, 'checkout', '-q', ...(there ? [] : ['-b']), 'other');
    put(join(y.cwd, 'a.txt'), 'home work\n');
    sh(y.cwd, ...hooks, 'commit', '-qam', 'rebased at home');
    await cutShort(y, () => y.machine.sync({}));
    assert.deepEqual(await y.machine.sync({}), { kept: null });
    put(join(y.there, 'b.txt'), 'turn\n');
    sh(y.there, ...hooks, 'commit', '-qam', 'turn');
    assert.deepEqual(await y.machine.sync({ final: true }), { kept: null });
    for (const at of [y.cwd, y.there]) {
      assert.equal(sh(at, 'status', '--porcelain', '-b'), '## other');
      assert.equal(sh(at, 'log', '--format=%s').split('\n').slice(0, 3).join(), 'turn,rebased at home,first');
    }
  }

  // Cut off with the branch moved and the index not: nothing can be committed until it is finished.
  const z = await scheme();
  await z.machine.sync({ start: true });
  put(join(z.cwd, 'a.txt'), 'home work\n');
  sh(z.cwd, ...hooks, 'commit', '-qam', 'rebased at home');
  await cutShort(z, () => z.machine.sync({}), 'symbolic-ref -m citadel: state sync HEAD');
  put(join(z.there, 'mine.txt'), 'turn\n');
  assert.throws(() => sh(z.there, 'add', 'mine.txt'), /index\.lock/);
  // Nor when the turn writes just as it is being finished.
  const resumed = restore(z.there, (await snapshot(z.there)).sha, { from: 'x', hold: true });
  await assert.rejects(resumed, Changed);
  assert.throws(() => sh(z.there, 'add', 'mine.txt'), /index\.lock/);
  assert.deepEqual(await z.machine.sync({}), { kept: null });
  sh(z.there, 'add', 'mine.txt');
  sh(z.there, ...hooks, 'commit', '-qm', 'turn');
  assert.deepEqual(await z.machine.sync({ final: true }), { kept: null });
  assert.equal(sh(z.cwd, 'show', '--name-only', '--format=%s'), 'turn\n\nmine.txt');

  // It made a file where a folder was to come.
  const x = await scheme();
  await x.machine.sync({ start: true });
  put(join(x.cwd, 'notes', 'x.txt'), 'home\n');
  put(join(x.cwd, 'a.txt'), 'home\n');
  await cutShort(x, () => x.machine.sync({}));
  put(join(x.there, 'notes'), 'turn\n');
  assert.deepEqual(await x.machine.sync({ final: true }), { kept: null });
  for (const at of [x.cwd, x.there]) {
    assert.equal(readFileSync(join(at, 'notes'), 'utf8'), 'turn\n');
    assert.equal(readFileSync(join(at, 'a.txt'), 'utf8'), 'home\n');
  }
});

test('a folder git ignores, where the turn put a file or a link: moved aside, across disks too', async () => {
  const s = await scheme();
  put(join(s.cwd, 'ignored', 'big.txt'), 'only here\n');
  await s.machine.sync({ start: true });
  symlinkSync('a.txt', join(s.there, 'ignored'));
  assert.deepEqual(await s.machine.sync({}), { kept: null });
  assert.equal(readlinkSync(join(s.cwd, 'ignored')), 'a.txt');
  const dir = /ignored: files here that git ignores .* are in (\S+) now/.exec(s.notes.join('\n'))![1];
  assert.equal(readFileSync(join(dir, 'ignored', 'big.txt'), 'utf8'), 'only here\n');

  // A folder with files of both kinds.
  const t = await scheme();
  put(join(t.cwd, '.gitignore'), '*.log\n');
  put(join(t.cwd, 'dir', 'x.log'), 'only here\n');
  await t.machine.sync({ start: true });
  rmSync(join(t.there, 'dir'), { recursive: true }); // timing-ok: the test's own worktree
  put(join(t.there, 'dir'), 'a file\n');
  const aside = join(sh(t.cwd, 'rev-parse', '--absolute-git-dir'), 'citadel-aside');
  const shm = mkdtempSync('/dev/shm/citadel-aside-');
  try {
    symlinkSync(shm, aside);
    assert.deepEqual(await t.machine.sync({}), { kept: null });
    assert.equal(readFileSync(join(t.cwd, 'dir'), 'utf8'), 'a file\n');
    assert.equal(readFileSync(join(aside, readdirSync(aside)[0], 'dir', 'x.log'), 'utf8'), 'only here\n');
  } finally {
    rmSync(shm, { recursive: true }); // timing-ok: own temp dir
  }
});

test('a file of the worktree here that git ignores, or a key, is moved aside and said, never written over', async () => {
  const s = await scheme();
  put(join(s.cwd, 'ignored', 'data.txt'), 'only here\n');
  put(join(s.cwd, 'ignored', 'same.txt'), 'the same\n');
  put(join(s.cwd, '.env'), 'KEY=here\n');
  await s.machine.sync({ start: true });
  put(join(s.there, 'ignored', 'data.txt'), 'the turn\n');
  put(join(s.there, 'ignored', 'same.txt'), 'the same\n');
  put(join(s.there, '.env'), 'KEY=there\n');
  sh(s.there, 'add', '-f', 'ignored', '.env');
  assert.deepEqual(await s.machine.sync({}), { kept: null });
  assert.equal(readFileSync(join(s.cwd, 'ignored', 'data.txt'), 'utf8'), 'the turn\n');
  const [, names, dir] = /(.+): files here that git ignores were in the way of the turn's own, and are in (\S+) now/.exec(s.notes.join('\n'))!;
  assert.deepEqual(names.split(', ').sort(), ['.env', 'ignored/data.txt']);
  assert.equal(readFileSync(join(dir, 'ignored', 'data.txt'), 'utf8'), 'only here\n');
  assert.equal(readFileSync(join(dir, '.env'), 'utf8'), 'KEY=here\n');
  // A tracked key-named file dropped and put back.
  for (const op of [
    ['rm', '-q', '--cached', '.env'],
    ['add', '-f', '.env'],
  ]) {
    sh(s.there, ...op);
    assert.deepEqual(await s.machine.sync({}), { kept: null });
  }
  assert.equal(sh(s.cwd, 'ls-files', '.env'), '.env');
});

test('a side branch moved on both sides is said once, and stops nothing else', async () => {
  const s = await scheme();
  sh(s.repo, 'branch', 'side');
  await s.machine.sync({ start: true });
  for (const [at, m] of [
    [s.there, 'there'],
    [s.repo, 'here'],
  ])
    sh(at, 'update-ref', 'refs/heads/side', sh(at, 'commit-tree', '-m', m, 'HEAD^{tree}'));
  await s.machine.sync({});
  assert.match(s.notes.join(), /side moved here and on Desk both/);
  s.calls.length = 0;
  await s.machine.sync({});
  assert.deepEqual(s.calls, ['look', 'done']);
  put(join(s.cwd, 'a.txt'), 'home\n');
  await s.machine.sync({});
  assert.equal(readFileSync(join(s.there, 'a.txt'), 'utf8'), 'home\n', 'what moves at home still comes');
  assert.equal(s.notes.length, 1);
});

test('the server’s half being gone ends a sync as gone', async () => {
  const s = await scheme();
  await s.machine.sync({ start: true });
  writeFileSync(join(s.dir, 'exit.json'), '{}');
  await assert.rejects(s.machine.sync({}), /has ended/);
});

test('folders: uploads go down, the files folder, shared folder and memory come back, the newest write wins', async () => {
  const s = await scheme();
  const memory = join('projects', projectSlug(s.repo), 'memory');
  put(join(s.server, 'uploads', '7', 'pic.png'), Buffer.from([1, 2, 3]));
  put(join(s.server, 'shared', '7', 'report.md'), 'v1');
  put(join(s.server, 'shared', 'project', 'specs', 'x.md'), 'spec');
  put(join(s.server, 'shared', 'project', 'stays.md'), 's');
  put(join(s.config, memory, 'MEMORY.md'), '- one');
  put(join(s.server, 'shared', '7', '.env'), 'no');
  symlinkSync('/etc/passwd', join(s.server, 'shared', '7', 'passwd'));
  await s.machine.sync({ start: true });
  const far = (p: string) => s.prefix + join(s.server, p);
  assert.deepEqual(readFileSync(far('uploads/7/pic.png')), Buffer.from([1, 2, 3]));
  assert.equal(readFileSync(far('shared/project/specs/x.md'), 'utf8'), 'spec');
  assert.equal(readFileSync(join(s.prefix, '/h/.claude', memory, 'MEMORY.md'), 'utf8'), '- one');
  assert.deepEqual(readdirSync(far('shared/7')), ['report.md']);

  put(far('shared/7/report.md'), 'v2 there');
  put(far('shared/7/new/deep.txt'), 'd');
  put(join(s.prefix, '/h/.claude', memory, 'note.md'), 'learned');
  unlinkSync(far('shared/project/specs/x.md'));
  put(join(s.server, 'shared', 'project', 'by-another.md'), 'another minion');
  await s.machine.sync({});
  assert.equal(readFileSync(join(s.server, 'shared/7/report.md'), 'utf8'), 'v2 there');
  assert.equal(readFileSync(join(s.server, 'shared/7/new/deep.txt'), 'utf8'), 'd');
  assert.equal(readFileSync(join(s.config, memory, 'note.md'), 'utf8'), 'learned');
  assert.ok(!existsSync(join(s.server, 'shared/project/specs/x.md')));
  assert.equal(readFileSync(far('shared/project/by-another.md'), 'utf8'), 'another minion');

  // Both wrote it: the newest wins, whichever side it is on.
  const at = (f: string, ms: number) => utimesSync(f, new Date(ms), new Date(ms));
  for (const [f, home, there] of [
    ['home.md', 2000, 0],
    ['there.md', 0, 2000],
  ] as const) {
    put(join(s.server, 'shared/7', f), 'home');
    put(far(`shared/7/${f}`), 'there!');
    at(join(s.server, 'shared/7', f), Date.now() - 60_000 + home);
    at(far(`shared/7/${f}`), Date.now() - 60_000 + there);
  }
  await s.machine.sync({});
  for (const p of [s.server, s.prefix + s.server]) {
    assert.equal(readFileSync(join(p, 'shared/7/home.md'), 'utf8'), 'home');
    assert.equal(readFileSync(join(p, 'shared/7/there.md'), 'utf8'), 'there!');
  }
  assert.equal(readFileSync(join(s.server, 'shared/7/.env'), 'utf8'), 'no');
  // Settled: nothing more to send either way.
  const was = s.calls.length;
  await s.machine.sync({});
  assert.deepEqual(s.calls.slice(was), ['look', 'done']);
});

test('a session: only this conversation goes down, the server’s copy wins at the start, and its growth comes back', async () => {
  const s = await scheme();
  const at = join('projects', s.slug);
  const jsonl = `${s.session}.jsonl`;
  put(join(s.config, at, jsonl), '{"a":1}\n');
  put(join(s.config, at, s.session, 'tool', 'out.txt'), 'saved');
  put(join(s.config, at, '99999999-2222-3333-4444-555555555555.jsonl'), 'an old one');
  put(join(s.config, 'tasks', s.session, '1.json'), '{}');
  await s.machine.sync({ start: true });
  const there = join(s.prefix, '/h/.claude');
  assert.deepEqual(readdirSync(join(there, at)).sort(), [s.session, jsonl]);
  assert.equal(readFileSync(join(there, 'tasks', s.session, '1.json'), 'utf8'), '{}');

  writeFileSync(join(there, at, jsonl), '{"b":2}\n', { flag: 'a' });
  const before = lstatSync(join(s.config, at, jsonl)).mtimeMs;
  utimesSync(join(there, at, jsonl), new Date(1000), new Date(1000)); // a machine whose clock is far behind
  await s.machine.sync({});
  assert.equal(readFileSync(join(s.config, at, jsonl), 'utf8'), '{"a":1}\n{"b":2}\n');
  assert.ok(lstatSync(join(s.config, at, jsonl)).mtimeMs > before, 'newer here, so the database takes it');
  assert.deepEqual(readdirSync(join(there, at)).sort(), [s.session, jsonl], 'the old conversation stays home');

  // Rewritten, not grown: it goes whole.
  writeFileSync(join(there, at, jsonl), '{"c":3}\n{"d":4}\n{"e":5}\n');
  await s.machine.sync({});
  assert.equal(readFileSync(join(s.config, at, jsonl), 'utf8'), '{"c":3}\n{"d":4}\n{"e":5}\n');

  // Turns ran at home since; a stale copy there, even a newer file, gives way at the next start.
  writeFileSync(join(s.config, at, jsonl), 'home\n');
  writeFileSync(join(there, at, jsonl), 'stale there\n');
  await s.machine.sync({ start: true });
  assert.equal(readFileSync(join(there, at, jsonl), 'utf8'), 'home\n');
});

test('reconcile: a side that lost its whole folder deletes nothing on the other', () => {
  const base = { a: { l: [1, 1], r: [1, 1] } } as Record<string, { l: [number, number]; r: [number, number] }>;
  const one = new Map<string, [number, number]>([['a', [1, 1]]]);
  assert.deepEqual(reconcile(new Map(), one, { ...base }).pull, ['a']);
  assert.deepEqual(reconcile(one, new Map(), { ...base }).push, ['a']);
  // A write beats a delete.
  const two = new Map<string, [number, number]>([...one, ['b', [1, 1]]]);
  const b = { ...base, b: { l: [1, 1], r: [1, 1] } } as typeof base;
  assert.deepEqual(reconcile(two, new Map([['b', [2, 9]]]) as typeof two, b).dropHere, ['a']);
  assert.deepEqual(
    reconcile(
      new Map([
        ['b', [1, 1]],
        ['a', [5, 5]],
      ]) as typeof two,
      new Map([['b', [1, 1]]]) as typeof two,
      b,
    ).push,
    ['a'],
  );
});

test('paths from the other side stay inside their folder, and through no link', async () => {
  const dir = join(root, 'inside');
  mkdirSync(join(dir, 'real'), { recursive: true });
  symlinkSync('/tmp', join(dir, 'out'));
  assert.equal(await inside(dir, 'real/x'), join(dir, 'real/x'));
  assert.equal(await inside(dir, 'made/deep/x'), join(dir, 'made/deep/x'));
  for (const bad of ['../x', '/etc/x', 'a/../../x', 'out/x', '', '.', 'a\0b', 3, null]) assert.equal(await inside(dir, bad), null, String(bad));
});

test('a transfer cut short, or a file that changed while it was read, replaces nothing', async () => {
  const dir = join(root, 'frames');
  put(join(dir, 'src'), 'hello');
  put(join(dir, 'to', 'f'), 'old');
  const st = lstatSync(join(dir, 'to', 'f'));
  const head = (mtime: number) => ({ root: 'r', rel: 'f', size: 5, mtime, expect: [st.size, Math.round(st.mtimeMs)] as [number, number] });
  const run = async (chunks: Buffer[], h: ReturnType<typeof head>) => {
    const frames = new Frames(
      (async function* () {
        yield* chunks;
      })(),
    );
    await frames.json();
    return take(
      frames,
      [h],
      async () => ({ root: join(dir, 'to'), file: join(dir, 'to', 'f') }),
      (f) => f.mtime,
    );
  };
  const real = Math.round(lstatSync(join(dir, 'src')).mtimeMs);
  const made = async (mtime: number) => {
    const out: Buffer[] = [];
    for await (const c of frame({ files: [] }, [{ file: join(dir, 'src'), size: 5, mtime }])) out.push(c);
    return out;
  };
  const whole = await made(real);
  await assert.rejects(run([Buffer.concat(whole).subarray(0, 20)], head(real)), /cut short/);
  assert.deepEqual(await run(await made(real - 5000), head(real - 5000)), [{ left: 'changed' }]);
  assert.equal(readFileSync(join(dir, 'to', 'f'), 'utf8'), 'old');
  assert.ok('ok' in (await run(whole, head(real)))[0]);
  assert.equal(readFileSync(join(dir, 'to', 'f'), 'utf8'), 'hello');
  assert.deepEqual(readdirSync(join(dir, '.citadel-sync')), [], 'nothing left half written');
});

test('the tools that read the worktree here wait for it; the chatty ones do not', () => {
  for (const p of ['land', 'land/handoff', 'preview', 'mark-image']) assert.equal(readsDisk(`api/tickets/7/${p}`), 'must', p);
  for (const p of ['questions', 'openrouter', 'jobs']) assert.equal(readsDisk(`api/tickets/7/${p}`), 'may', p);
  assert.equal(readsDisk('api/contraptions/x/deploy'), 'may');
  for (const p of ['api/tickets/7/status', 'api/tickets/7/plan', 'api/tickets/7', 'api/tickets/7/minion-message']) assert.ok(!readsDisk(p), p);
});

test("a closed minion's machine marks go with its worktree; what was kept or sent aside goes only once its branch has it", async () => {
  const s = await scheme();
  await s.machine.sync({ start: true });
  put(join(s.there, 'a.txt'), 'there\n');
  await s.machine.sync({});
  const onBranch = sh(s.cwd, 'rev-parse', 'HEAD');
  sh(s.repo, 'update-ref', 'refs/citadel/kept/7/x/heads/side', onBranch);
  sh(s.repo, 'update-ref', 'refs/citadel/away/7/20261125-120000', sh(s.repo, 'commit-tree', '-m', 'aside', `${onBranch}^{tree}`));
  sh(s.repo, 'update-ref', 'refs/citadel/machine/70', onBranch);
  assert.match(sh(s.repo, 'for-each-ref', '--format=%(refname)', 'refs/citadel/machine/7'), /machine\/7$/m);
  assert.ok((await dropMachineRefs({ id: 2, repo_dir: s.repo } as Project, 7, 'ticket/7')) >= 2);
  assert.equal(sh(s.repo, 'for-each-ref', '--format=%(refname)', 'refs/citadel/kept/7', 'refs/citadel/machine/7', 'refs/citadel/machine/7-home'), '');
  assert.equal(sh(s.repo, 'for-each-ref', '--format=%(refname)', 'refs/citadel/away/7'), 'refs/citadel/away/7/20261125-120000', 'not on its branch: it stays');
  assert.equal(sh(s.repo, 'for-each-ref', '--format=%(refname)', 'refs/citadel/machine/70'), 'refs/citadel/machine/70', "another minion's");
});
