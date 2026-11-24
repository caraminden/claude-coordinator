// A Taskmaster orders its scheme's ship line, a person's drag wins (#1358; src/ship-line.ts), in a scheme that is not Citadel's.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { HttpError } from '../src/http.ts';
import { LandsInFlight } from '../src/release-readers.ts';
import { Releases, type TargetView } from '../src/releases.ts';
import { moveShip, seqsFor, shipFirst } from '../src/ship-line.ts';
import { git, gitAt } from './git.ts';

const root = mkdtempSync(join(tmpdir(), 'ship-line-'));
after(() => rmSync(root, { recursive: true, force: true }));

const TM = { name: 'Peek Auras Taskmaster', taskmaster: true };
const CARA = { name: 'Cara', taskmaster: false };

/** A scheme whose kit land.sh knows .order, with #1 holding the lock and #2 to #5 waiting, in that order. */
let seq = 0;
function scheme(name: string) {
  const tag = `${name.replace(/ /g, '-')}-${++seq}`;
  const store = new Store(join(root, `${tag}.db`));
  const repo = join(root, `${tag}-repo`);
  mkdirSync(join(repo, 'tools'), { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), 'x\n');
  writeFileSync(join(repo, 'tools', 'land.sh'), '#!/usr/bin/env bash\nqueue_order() {\n  :\n}\n');
  git(repo, 'add', '-A');
  gitAt(Date.now(), repo, 'commit', '-q', '-m', 'init');
  const p = store.createProject(name, 'https://github.com/o/x');
  store.setProjectRepoDir(p.id, repo);
  const q = join(repo, '.git', 'land-queue');
  mkdirSync(q);
  const stat = readFileSync(`/proc/${process.pid}/stat`, 'utf8');
  const me = `${process.pid} ${stat.slice(stat.lastIndexOf(') ') + 2).split(' ')[19]}`;
  const ids: number[] = [];
  for (const i of ['1', '2', '3', '4', '5']) {
    const t = store.createTicket({ project_id: p.id, title: `Change ${i}`, permission_mode: 'default', created_by: 'Cara' });
    store.setTicketDir(t.id, root, `ticket/${i}-c`);
    ids.push(t.id);
    const got = i === '1' ? '1795067420' : '0';
    writeFileSync(join(q, i.padStart(10, '0')), [me, got, `ticket/${i}-c`, got === '0' ? 'waiting' : 'waiting for CI', '-', '-', '-', 'order'].join('\n') + '\n');
  }
  const found = { id: 'ci:windows:release', projectId: p.id, name: 'Windows', kind: 'ci', link: null, branch: 'main', numbering: { name: 'Build {n}', number: 'run' } };
  const lands = new LandsInFlight({ store, finder: { list: () => [found] } as never, landings: { handoffs: () => ids, get: () => ({ output: 'queue: next in line\n', code: null }) }, now: () => 1000 });
  const reader = {
    read: () => {
      const vs = [{ target: { id: found.id, projectId: p.id, name: 'Windows', kind: 'ci', link: null }, current: null, next: null, line: [], recent: [] }] as unknown as TargetView[];
      lands.attach(vs);
      return vs;
    },
  };
  const releases = new Releases({ store, readers: [reader as never], testCopies: () => new Map(), broadcast: () => {} });
  releases.poll();
  const app = { store, releases, waits: undefined };
  const order = () =>
    readFileSync(join(q, '.order'), 'utf8')
      .split('\n')
      .filter((l) => /^\d{10}$/.test(l))
      .map(Number);
  const line = () => releases.view(() => true)[0].targets.flatMap((t) => t.line);
  return { app, p, order, line, q, ids };
}

const refused = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof HttpError);
    return e.message;
  }
  assert.fail('should have been refused');
};

test("a Taskmaster moves a waiting ship with its reason, by the drag's own write, and the reason shows on the line", () => {
  const { app, p, order, line, q } = scheme('Peek Auras');
  const seqs = seqsFor(line(), 4);
  assert.deepEqual(seqs, [4, 2, 3, 5]);
  moveShip(app, p.id, 4, seqs, TM, 'fixes the land script');
  assert.deepEqual(order(), [4, 2, 3, 5]);
  assert.match(readFileSync(join(q, '.order'), 'utf8'), /^# Peek Auras Taskmaster moved #4 to ship next: fixes the land script\n/);
  const e = line().find((x) => x.name === '#4')!;
  assert.deepEqual([e.placed?.by, e.placed?.reason, e.placed?.taskmaster], ['Peek Auras Taskmaster', 'fixes the land script', true]);
  assert.equal(line().find((x) => x.name === '#2')?.placed, undefined);
  // Going ahead of a given ship.
  moveShip(app, p.id, 5, seqsFor(line(), 5, 2), TM, 'unblocks #2');
  assert.deepEqual(order(), [4, 5, 2, 3]);
});

test("a person's move pins its ship: a Taskmaster can't move it or pass it, and the refusal names who and when; the pin ends when it ships", () => {
  const { app, p, order, line, q, ids } = scheme('Peek Auras');
  moveShip(app, p.id, 3, [3, 2, 4, 5], CARA);
  assert.deepEqual(order(), [3, 2, 4, 5]);
  assert.equal(line().find((x) => x.name === '#3')?.placed?.taskmaster, false);
  assert.match(
    refused(() => moveShip(app, p.id, 3, seqsFor(line(), 3, 5), TM, 'x')),
    /#3 was placed by Cara on .* until it ships/,
  );
  assert.match(
    refused(() => moveShip(app, p.id, 4, seqsFor(line(), 4), TM, 'x')),
    /move #4 past #3, which Cara placed on/,
  );
  assert.deepEqual(order(), [3, 2, 4, 5], 'nothing moved');
  // Moves that stay on one side of the pin are fine.
  moveShip(app, p.id, 5, seqsFor(line(), 5, 2), TM, 'smaller');
  assert.deepEqual(order(), [3, 5, 2, 4]);
  // A person may move any ship, a pinned one included, and a Taskmaster's moved ship doesn't pin.
  moveShip(app, p.id, 2, [2, 3, 5, 4], CARA);
  assert.deepEqual(order(), [2, 3, 5, 4]);
  // #3 ships: its line ticket goes, and a new ship with that ticket's number would start unpinned (pins are by minion).
  rmSync(join(q, '0000000003'));
  app.releases.poll();
  app.releases.read();
  assert.ok(!Object.keys(app.store.getSetting<{ placed: Record<string, unknown> }>(`ship-line:${p.id}`)!.placed).includes(`t${ids[2]}`), 'released on read, with no move in between');
  moveShip(app, p.id, 4, seqsFor(line(), 4, 2), CARA);
  const kept = app.store.getSetting<{ placed: Record<string, unknown> }>(`ship-line:${p.id}`)!.placed;
  assert.equal(Object.keys(kept).length, 3, 'the shipped one let go of its pin: #5, #2 and #4 are left');
  assert.ok(!Object.keys(kept).includes(`t${ids[2]}`));
});

test("a ship whose land script is too old to move still can't be moved by a Taskmaster, and says why", () => {
  const { app, p, q, line } = scheme('Peek Auras');
  writeFileSync(
    join(q, '0000000002'),
    readFileSync(join(q, '0000000002'), 'utf8')
      .replace('\norder\n', '\n')
      .replace(/\norder$/, ''),
  );
  app.releases.poll();
  const two = line().find((x) => x.name === '#2')!;
  assert.equal(two.movable, false);
  assert.match(
    refused(() => moveShip(app, p.id, 2, [2, 3], TM, 'x')),
    /#2: Can't move/,
  );
});

test("a ship that holds the line (a Regenerate ship, #1827) can't be moved, and says why", () => {
  const { app, p, q, line } = scheme('Peek Auras');
  writeFileSync(join(q, '0000000003'), readFileSync(join(q, '0000000003'), 'utf8') + 'hold\n');
  app.releases.poll();
  const three = line().find((x) => x.name === '#3')!;
  assert.equal(three.movable, false);
  assert.match(three.why ?? '', /holds the line/);
  assert.equal(line().find((x) => x.name === '#2')!.movable, true, 'the others still move');
});

// Whose line a call may reach is the router's (src/http.ts checkScope; test/access-matrix: another scheme's Taskmaster gets a 403,
// a minion a 403); here, a scheme with no line to order, and each scheme's pins kept apart.
test("a scheme with no ship line can't be ordered, and a pin lives in its own scheme's setting", () => {
  const a = scheme('Peek Auras');
  const none = a.app.store.createProject('Other Scheme', 'https://github.com/o/y');
  assert.match(
    refused(() => moveShip(a.app, none.id, 3, [3], TM, 'x')),
    /no ship line/,
  );
  moveShip(a.app, a.p.id, 3, [3, 2, 4, 5], CARA);
  assert.ok(a.app.store.getSetting(`ship-line:${a.p.id}`));
  assert.equal(a.app.store.getSetting(`ship-line:${none.id}`), null);
});

test("order_ship_line is on the Taskmaster tool list and not on a minion's", () => {
  const tools = (role: string) => {
    const input = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n';
    const r = spawnSync(process.execPath, ['src/mcp.ts'], { input, encoding: 'utf8', env: { ...process.env, COORDINATOR_ROLE: role, COORDINATOR_PROJECT: '1', COORDINATOR_TICKET: '1', COORDINATOR_APP_INSTRUCTIONS: '' } });
    return JSON.parse(r.stdout.split('\n')[0]).result.tools.map((t: { name: string }) => t.name);
  };
  assert.ok(tools('coordinator').includes('order_ship_line'));
  assert.ok(!tools('thread').includes('order_ship_line'));
});

test("#1487: a broken test's fix goes to the front as a Taskmaster's move, once; a person's pin ahead of it stays put", () => {
  const { app, p, order, line, q, ids } = scheme('Peek Auras');
  const by = { name: 'The broken-test rule', taskmaster: true };
  assert.equal(shipFirst(app, p.id, ids[3], by, 'test/x.test.ts is a broken test'), 'moved');
  assert.deepEqual(order(), [4, 2, 3, 5]);
  assert.match(readFileSync(join(q, '.order'), 'utf8'), /^# The broken-test rule moved #4 to ship next: test\/x\.test\.ts is a broken test\n/);
  assert.equal(shipFirst(app, p.id, ids[3], by, 'again'), 'first', 'already first: no second move, no history line');
  assert.equal(shipFirst(app, p.id, ids[0], by, 'x'), null, 'the ship holding the lock is not waiting');
  moveShip(app, p.id, 2, [2, 4, 3, 5], CARA);
  assert.equal(shipFirst(app, p.id, ids[4], by, 'x'), 'refused', "it doesn't pass Cara's pin");
  assert.deepEqual(order(), [2, 4, 3, 5]);
  assert.equal(line().find((x) => x.name === '#5')?.placed, undefined);
});
