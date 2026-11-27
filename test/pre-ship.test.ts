// Pre-ship runs (#2210; Cara, 2026-11-27: "Run any minion that is waiting for a "Ship it" through the full suite on github
// so its bugs can be found before we try to ship"): src/pre-ship.ts with real git repos and a stand-in GitHub, and
// land.sh's pre_yield, which gives a ship's run the slots first.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { EventRow, GhRunnersMode } from '../src/db-rows.ts';
import { git, type Minion, PreShip, type PreRun, type Scheme, waitsForGo, yieldingIn } from '../src/pre-ship.ts';

const root = mkdtempSync(join(tmpdir(), 'pre-ship-'));
after(() => rmSync(root, { recursive: true, force: true })); // timing-ok: own temp dir

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
let n = 0;

/** A scheme's clone with a GitHub stand-in (a bare origin), main holding a workflow on pre/**, and a minion branch one commit ahead. */
function repo(workflow = "on:\n  push:\n    branches: ['land/**', 'pre/**']\n") {
  const dir = join(root, `r${++n}`);
  const origin = `${dir}-origin.git`;
  sh(root, 'init', '-q', '--bare', '-b', 'main', origin);
  sh(root, 'init', '-q', '-b', 'main', dir);
  mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(dir, '.github', 'workflows', 'tests.yml'), workflow);
  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\n');
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', 'base');
  sh(dir, 'remote', 'add', 'origin', origin);
  sh(dir, 'push', '-q', 'origin', 'main');
  sh(dir, 'remote', 'set-head', 'origin', 'main');
  sh(dir, 'checkout', '-q', '-b', 'ticket/5-x');
  writeFileSync(join(dir, 'b.txt'), 'mine\n');
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', 'mine');
  sh(dir, 'checkout', '-q', 'main');
  // main moves on after the branch left it
  writeFileSync(join(dir, 'c.txt'), 'theirs\n');
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', 'theirs');
  return { dir, origin };
}

const SHIP_CARD: EventRow = { id: 1, ticket_id: 5, kind: 'question', data: JSON.stringify({ id: 'q1', kind: 'merge', questions: [{ question: 'Ship it?' }] }), created_at: 1 };

function world(r: { dir: string }, opts: { private?: boolean; gh_runners?: GhRunnersMode } = {}) {
  const ticket: Minion = { id: 5, status: 'idle', branch: 'ticket/5-x', replies: null };
  const project: Scheme = { id: 2, name: 'Other', repo_url: 'https://github.com/someone/other', repo_dir: r.dir, gh_runners: opts.gh_runners ?? 'ask' };
  let cards = [SHIP_CARD];
  const settings = new Map<string, unknown>();
  // The stand-in GitHub: runs by commit, as a test sets them; posts recorded.
  const runs = new Map<string, { id: number; name: string; head_branch: string; status: string; conclusion: string | null; html_url: string }[]>();
  const posts: string[] = [];
  const sent: { text: string; fyi: boolean }[] = [];
  let yielding = false;
  const pre = new PreShip({
    store: {
      getSetting: <T>(k: string) => (settings.get(k) as T) ?? null,
      setSetting: (k: string, v: unknown) => void settings.set(k, structuredClone(v)),
      listProjects: () => [project],
      listTickets: () => [ticket],
      getTicket: () => ticket,
      openCardsOf: () => cards,
    },
    as: () => undefined,
    get: async (path) => {
      if (path === 'repos/someone/other') return { status: 200, etag: null, body: { private: !!opts.private } };
      const sha = /head_sha=([0-9a-f]+)/.exec(path)?.[1];
      if (sha) return { status: 200, etag: null, body: { workflow_runs: runs.get(sha) ?? [] } };
      if (/\/jobs/.test(path))
        return {
          status: 200,
          etag: null,
          body: {
            jobs: [
              { name: 'shard (3)', conclusion: 'failure' },
              { name: 'shard (4)', conclusion: 'success' },
            ],
          },
        };
      return { status: 404, etag: null, body: null };
    },
    post: async (path) => {
      posts.push(path);
      return { status: 202 };
    },
    git,
    send: (_id, text, fyi) => void sent.push({ text, fyi }),
    yielding: async () => yielding,
  });
  const pushed = () => {
    const out = spawnSync('git', ['rev-parse', '-q', '--verify', 'refs/heads/pre/ticket/5-x'], { cwd: `${r.dir}-origin.git`, encoding: 'utf8' });
    return out.status === 0 ? out.stdout.trim() : null;
  };
  const record = () => (settings.get('pre-ship:runs') as Record<string, PreRun>)?.['5'];
  return {
    pre,
    ticket,
    project,
    runs,
    posts,
    sent,
    pushed,
    record,
    set: (o: { yielding?: boolean; cards?: EventRow[] }) => {
      if (o.yielding !== undefined) yielding = o.yielding;
      if (o.cards) cards = o.cards;
    },
    run: (sha: string, status: string, conclusion: string | null, id = 70) => runs.set(sha, [{ id, name: 'tests', head_branch: 'pre/ticket/5-x', status, conclusion, html_url: `https://ci/${id}` }]),
  };
}

test('a minion waits for its go on an open ship card or a Ship it reply, not on a build merge card or another question', () => {
  const t = { status: 'idle', branch: 'ticket/5-x', replies: null } as const;
  assert.equal(waitsForGo(t, [SHIP_CARD]), true);
  assert.equal(waitsForGo({ ...t, replies: JSON.stringify(['Ship it']) }, []), true);
  assert.equal(waitsForGo({ ...t, replies: JSON.stringify(['Try it']) }, []), false);
  assert.equal(waitsForGo(t, [{ ...SHIP_CARD, data: JSON.stringify({ id: 'q', kind: 'merge', into: 'build/3' }) }]), false, "a feeder's merge into a build");
  assert.equal(waitsForGo(t, [{ ...SHIP_CARD, data: JSON.stringify({ id: 'q', questions: [] }) }]), false);
  assert.equal(waitsForGo({ ...t, status: 'closed' }, [SHIP_CARD]), false);
});

test("a waiting minion's branch goes to pre/<branch> squashed onto main, main beside it; its red wakes it once, with where it failed", async () => {
  const r = repo();
  const w = world(r);
  await w.pre.tick();
  const commit = w.pushed();
  assert.ok(commit, 'pushed to pre/<branch>');
  assert.equal(sh(r.origin, 'rev-parse', `${commit}^`), sh(r.dir, 'rev-parse', 'main'), "its parent is main's tip");
  assert.equal(sh(r.origin, 'rev-parse', 'refs/heads/pre-base/ticket/5-x'), sh(r.dir, 'rev-parse', 'main'));
  assert.deepEqual(sh(r.origin, 'ls-tree', '--name-only', commit!).split('\n').sort(), ['.github', 'a.txt', 'b.txt', 'c.txt']);
  w.run(commit!, 'in_progress', null);
  await w.pre.tick();
  assert.equal(w.sent.length, 0);
  w.run(commit!, 'completed', 'failure');
  await w.pre.tick();
  assert.equal(w.sent.length, 1);
  assert.equal(w.sent[0]!.fyi, false, 'a red wakes the minion');
  assert.match(w.sent[0]!.text, /Pre-ship check failed: .* in shard \(3\): https:\/\/ci\/70 \(`ci-failures 70 -R someone\/other`/s);
  await w.pre.tick();
  assert.equal(w.sent.length, 1, 'told once');
});

test('a green is held mail; a new commit cancels the older run and pushes again', async () => {
  const r = repo();
  const w = world(r);
  await w.pre.tick();
  const first = w.pushed()!;
  w.run(first, 'in_progress', null);
  sh(r.dir, 'checkout', '-q', 'ticket/5-x');
  writeFileSync(join(r.dir, 'b.txt'), 'mine, fixed\n');
  sh(r.dir, 'commit', '-q', '-am', 'fix');
  sh(r.dir, 'checkout', '-q', 'main');
  await w.pre.tick();
  assert.deepEqual(w.posts, ['repos/someone/other/actions/runs/70/cancel']);
  const second = w.pushed()!;
  assert.notEqual(second, first);
  w.run(second, 'completed', 'success', 71);
  await w.pre.tick();
  assert.deepEqual(
    w.sent.map((s) => s.fyi),
    [true],
  );
  assert.match(w.sent[0]!.text, /^Pre-ship check passed: .* https:\/\/ci\/71$/);
});

test("a ship's run comes first: nothing starts while it goes, a running one is cancelled, and runs again after", async () => {
  const r = repo();
  const w = world(r);
  w.set({ yielding: true });
  await w.pre.tick();
  assert.equal(w.pushed(), null, 'nothing starts while a ship runs');
  w.set({ yielding: false });
  await w.pre.tick();
  const commit = w.pushed()!;
  w.run(commit, 'in_progress', null);
  w.set({ yielding: true });
  await w.pre.tick();
  assert.deepEqual(w.posts, ['repos/someone/other/actions/runs/70/cancel']);
  w.run(commit, 'completed', 'cancelled');
  w.set({ yielding: false });
  await w.pre.tick();
  assert.deepEqual(w.posts.slice(1), ['repos/someone/other/actions/runs/70/rerun']);
  assert.equal(w.sent.length, 0, 'a cancel for a ship tells nobody');
  w.run(commit, 'completed', 'success');
  await w.pre.tick();
  assert.equal(w.sent.length, 1);
});

test('the go answered stops the run; it goes again when the go comes back on the same commit; a closed minion loses its branches', async () => {
  const r = repo();
  const w = world(r);
  await w.pre.tick();
  const commit = w.pushed()!;
  w.run(commit, 'in_progress', null);
  w.set({ cards: [] });
  await w.pre.tick();
  assert.deepEqual(w.posts, ['repos/someone/other/actions/runs/70/cancel']);
  w.run(commit, 'completed', 'cancelled');
  w.set({ cards: [SHIP_CARD] });
  await w.pre.tick();
  await w.pre.tick();
  assert.deepEqual(w.posts.slice(1), ['repos/someone/other/actions/runs/70/rerun']);
  assert.equal(w.pushed(), commit, 'the same commit, not pushed again');
  w.ticket.status = 'closed';
  await w.pre.tick();
  assert.equal(w.pushed(), null);
  assert.equal(w.record(), undefined);
});

test('a private repo, a scheme that never uses GitHub runners, or one with no workflow on pre/** gets nothing pushed', async () => {
  for (const [r, opts] of [
    [repo(), { private: true }],
    [repo(), { gh_runners: 'never' }],
    [repo("on:\n  push:\n    branches: ['land/**']\n"), {}],
  ] as const) {
    const w = world(r, opts);
    await w.pre.tick();
    assert.equal(w.pushed(), null);
    assert.equal(w.sent.length, 0);
  }
});

test("a branch that won't go onto main wakes the minion with the files, and nothing runs", async () => {
  const r = repo();
  sh(r.dir, 'checkout', '-q', 'ticket/5-x');
  writeFileSync(join(r.dir, 'a.txt'), 'one\nMINE\nthree\n');
  sh(r.dir, 'commit', '-q', '-am', 'mine too');
  sh(r.dir, 'checkout', '-q', 'main');
  writeFileSync(join(r.dir, 'a.txt'), 'one\nTHEIRS\nthree\n');
  sh(r.dir, 'commit', '-q', '-am', 'theirs too');
  const w = world(r);
  await w.pre.tick();
  assert.equal(w.pushed(), null);
  assert.equal(w.sent.length, 1);
  assert.equal(w.sent[0]!.fyi, false);
  assert.match(w.sent[0]!.text, /doesn't go onto main .* Conflicts in: a\.txt\./);
  await w.pre.tick();
  assert.equal(w.sent.length, 1, 'told once for that commit');
});

test("a landing's pre-yield mark counts only while its process runs", async () => {
  const dir = join(root, 'state');
  mkdirSync(dir);
  assert.equal(await yieldingIn(dir), false);
  writeFileSync(join(dir, 'pre-yield.999999999'), '1\n');
  assert.equal(await yieldingIn(dir), false, 'a dead landing');
  assert.deepEqual(readdirSync(dir), [], "an ended landing's mark goes");
  writeFileSync(join(dir, `pre-yield.${process.pid}`), '1\n');
  assert.equal(await yieldingIn(dir), true);
});
