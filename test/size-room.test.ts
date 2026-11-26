// tools/size-room.ts (#2139): a branch's room in the size list after main and the ships ahead of it, added up from
// each ship's change to a file's lines and to its ALLOWED number, on a scratch repo with a small list like the real one.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const tool = join(import.meta.dirname, '..', 'tools', 'size-room.ts');
const lines = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `// ${tag} ${i}\n`).join('');
const list = (big: number) => `const ROOTS = ['src'];
const CODE = /\\.(ts|js)$/;
export const LIMIT = 1500;
export const SLACK = 50;
export const ALLOWED: Record<string, [number, string]> = {
  'src/big.ts': [
    ${big},
    'one file',
  ],
};
`;

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'size-room-'));
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  const commit = (files: Record<string, string>, msg: string) => {
    for (const [f, text] of Object.entries(files)) {
      mkdirSync(join(dir, f, '..'), { recursive: true });
      writeFileSync(join(dir, f), text);
    }
    git('add', '-A');
    git('commit', '-qm', msg);
  };
  commit({ 'test/size-budget.test.ts': list(1600), 'src/big.ts': lines(1600, 'main'), 'src/small.ts': lines(1490, 'main') }, 'base');
  /** A branch off <from> that adds <top> lines at src/big.ts's top (and raises its number by <raise>). */
  const branch = (name: string, top: number, raise = 0, from = 'main') => {
    git('checkout', '-q', '-b', name, from);
    const was = Number(/(\d+),\n {4}'one file'/.exec(git('show', 'HEAD:test/size-budget.test.ts'))![1]);
    commit({ 'src/big.ts': lines(top, name) + git('show', 'HEAD:src/big.ts') + '\n', ...(raise ? { 'test/size-budget.test.ts': list(was + raise) } : {}) }, name);
    git('checkout', '-q', 'main');
  };
  const room = (...args: string[]) => {
    const r = spawnSync(process.execPath, ['--no-warnings', tool, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, DEPLOY_LIVE: join(dir, 'none') } });
    return { status: r.status, out: r.stdout + r.stderr };
  };
  return { dir, git, commit, branch, room, done: () => rmSync(dir, { recursive: true, force: true }) }; // timing-ok: own temp dir
}

test('a ship that fits alone but not after the ships ahead is over, by how much, and names who used the room', () => {
  const r = repo();
  try {
    r.branch('ticket/1-a', 30);
    r.branch('ticket/2-b', 30);
    const alone = r.room('--self', 'ticket/2-b');
    assert.equal(alone.status, 0, alone.out);
    assert.match(alone.out, /src\/big\.ts: 1630 of 1650 lines \(its ALLOWED number 1600 \+ 50 slack\) with main 1600, no ships ahead and ticket\/2-b \+30: 20 left/);
    const after = r.room('--self', 'ticket/2-b', '--ahead', 'ticket/1-a');
    assert.equal(after.status, 1, after.out);
    assert.match(
      after.out,
      /src\/big\.ts would be 1660 lines, 10 over its limit 1650 \(its ALLOWED number 1600 \+ 50 slack\): main has 1600, the ships ahead: ticket\/1-a \+30, and ticket\/2-b adds 30\. Split it, or raise its number in test\/size-budget\.test\.ts by 10 or more with a reason \(30 of its room went to the ships ahead\)/,
    );
  } finally {
    r.done();
  }
});

test("raises add up as the count merge adds them, and a file only the ships ahead grow is not this one's", () => {
  const r = repo();
  try {
    r.branch('ticket/1-a', 40, 40);
    r.branch('ticket/2-b', 40, 40);
    const both = r.room('--self', 'ticket/2-b', '--ahead', 'ticket/1-a');
    assert.equal(both.status, 0, both.out);
    assert.match(both.out, /1680 of 1730 lines \(its ALLOWED number 1680 \+ 50 slack\)/);
    r.git('checkout', '-q', '-b', 'ticket/4-d', 'main');
    r.commit({ 'src/other.ts': '//\n' }, 'other');
    const other = r.room('--ahead', 'ticket/1-a', '--ahead', 'ticket/2-b');
    assert.equal(other.status, 0, other.out);
    assert.doesNotMatch(other.out, /big\.ts/, 'it grows no file of the list');
  } finally {
    r.done();
  }
});

test('a ship that sits on another ship ahead counts that one once, and an unlisted file has the exact limit', () => {
  const r = repo();
  try {
    r.branch('ticket/1-a', 30);
    r.branch('ticket/2-b', 15, 0, 'ticket/1-a');
    const chained = r.room('--self', 'ticket/2-b', '--ahead', 'ticket/1-a');
    assert.equal(chained.status, 0, chained.out);
    assert.match(chained.out, /1645 of 1650 lines .* the ships ahead: ticket\/1-a \+30 and ticket\/2-b \+15: 5 left/);
    r.git('checkout', '-q', '-b', 'ticket/3-c', 'main');
    r.commit({ 'src/small.ts': lines(11, 'c') + lines(1490, 'main') }, 'c');
    const small = r.room();
    assert.equal(small.status, 1, small.out);
    assert.match(small.out, /src\/small\.ts would be 1501 lines, 1 over its limit 1500 \(unlisted\)/);
  } finally {
    r.done();
  }
});

test('with no ships named, the ships in the line count, but not this one, a ticket whose process is gone, or a repo with no size list', () => {
  const r = repo();
  try {
    r.branch('ticket/1-a', 30);
    r.branch('ticket/9-gone', 30);
    r.branch('ticket/2-b', 30);
    const q = join(r.dir, 'queue');
    mkdirSync(q);
    writeFileSync(join(q, '0000000001'), `${process.pid} 1\n0\nticket/1-a\nwaiting\norder\ntrain\n`);
    writeFileSync(join(q, '0000000002'), `999999999 1\n0\nticket/9-gone\nwaiting\norder\ntrain\n`);
    writeFileSync(join(q, '0000000003'), `${process.pid} 1\n0\nticket/2-b\nwaiting\norder\ntrain\n`);
    r.git('checkout', '-q', 'ticket/2-b');
    const res = r.room('--queue', q);
    assert.equal(res.status, 1, res.out);
    assert.match(res.out, /10 over .* the ships ahead: ticket\/1-a \+30, and ticket\/2-b adds 30/);
    r.git('checkout', '-q', 'main');
    r.git('rm', '-q', 'test/size-budget.test.ts');
    r.git('commit', '-qm', 'no list');
    r.git('checkout', '-q', 'ticket/2-b');
    assert.equal(r.room('--queue', q).status, 0, 'no size list on main: nothing to check');
  } finally {
    r.done();
  }
});

test('a bad ref or a folder outside the repo is a usage error, never a quiet fit or an "over" that refuses a ship', () => {
  const r = repo();
  try {
    r.branch('ticket/1-a', 60);
    for (const args of [
      ['--self', 'ticket/1-a', '--main', 'nosuch'],
      ['--self', 'nosuch', '--ahead', 'ticket/1-a'],
    ]) {
      const res = r.room(...args);
      assert.equal(res.status, 2, res.out);
      assert.match(res.out, /nosuch is not a commit here/);
    }
    const outside = spawnSync(process.execPath, ['--no-warnings', tool, '--self', 'ticket/1-a'], { cwd: tmpdir(), encoding: 'utf8', env: { ...process.env, GIT_CEILING_DIRECTORIES: tmpdir(), DEPLOY_LIVE: join(r.dir, 'none') } });
    assert.equal(outside.status, 2, outside.stdout + outside.stderr);
  } finally {
    r.done();
  }
});
