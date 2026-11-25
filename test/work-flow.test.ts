// The Flow tab's numbers (#1989; Josh, 2026-11-25, "Flow A: A river with the leaks drawn in"): on a seeded scheme that isn't
// Citadel, each minion's kind, way to main and ending are the ones its chat, releases, pull requests and commits say.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { layout, rows } from '../public/flowmath.js';
import { Store } from '../src/db.ts';
import { dayStart, namedBy, rangeOf, readApart, settle, WorkFlow, type FlowAsk, type FlowMinion } from '../src/work-flow.ts';

const root = mkdtempSync(join(tmpdir(), 'work-flow-'));
const db = join(root, 'x.db');
const store = new Store(db);
after(() => {
  store.db.close();
  rmSync(root, { recursive: true, force: true });
});
store.props.seed();

const repo = join(root, 'repo');
mkdirSync(repo);
const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, stdio: 'pipe' });
git('init', '-q', '-b', 'main');

const scheme = store.createProject('Peek Auras', null);
store.setProjectRepoDir(scheme.id, repo);
const other = store.createProject('Nest Feathers', null);
const FROM = Date.now() - 86_400_000;
const TO = Date.now() + 86_400_000;

type FlowNode = { key: string; v: number; at: number; size: number };
type Seed = { type?: string; closed?: boolean; cost?: number; notes?: string[]; refused?: number; pr?: boolean; build?: number; project?: number };
async function minion(title: string, s: Seed = {}) {
  const t = store.createTicket({ project_id: s.project ?? scheme.id, title, permission_mode: 'default', created_by: 'Cara' });
  if (s.type) store.props.set('minion', t.id, s.project ?? scheme.id, { type: s.type }, 'Cara');
  for (let i = 0; i < (s.refused ?? 0); i++) store.addEvent(t.id, 'user_message', { author: 'Citadel', text: "[System]: Your handed-off land didn't go through: tests failed" });
  for (const text of s.notes ?? []) store.addEvent(t.id, 'note', { text });
  if (s.cost) await store.recordTurn(t.id, { ended_at: Date.now(), session_cost_usd: s.cost });
  if (s.pr) store.db.prepare("INSERT INTO github_seen (ticket_id, key, delivered, created_at) VALUES (?, 'pr7:state:MERGED:1', 1, 1)").run(t.id);
  if (s.build) store.updateTicket(t.id, { build: s.build });
  if (s.closed !== false) store.db.prepare("UPDATE tickets SET status = 'closed', updated_at = updated_at + 1 WHERE id = ?").run(t.id);
  return t;
}
const SHIP = 'Shipped 0123abc4d "the thing": a thing. Risk low: small. Live now.';

await minion('live first time', { type: 'feature', cost: 3, notes: [SHIP] });
await minion('live after one refusal', { type: 'feature', cost: 4, notes: [SHIP], refused: 1 });
await minion('got there late', { type: 'bug', cost: 9, notes: [SHIP], refused: 2 });
await minion('refused by hand ships', { type: 'bug', cost: 5, notes: ['Stall signal: 2 failed ships in a row', 'Merged into build/3: a piece. Risk low: small.'] });
await minion('two refusals, gave up', { type: 'chore', cost: 20, refused: 3, notes: ['Claude dismissed this minion: replaced by #9'] });
await minion('live before refusals were kept', { type: 'chore', cost: 2 });
await minion('shipped, no release names it', { type: 'chore', cost: 1, notes: [SHIP] });
await minion('named by a commit', { type: 'feature', cost: 6, notes: ['Cara dismissed this minion.'] });
await minion('its pull request merged', { type: 'feature', cost: 7, pr: true });
await minion('merged into a build', { type: 'feature', cost: 8, notes: ['Merged into build/3: a piece. Risk low: small.'] });
await minion('stopped', { type: 'feature', cost: 272, notes: ['Cara dismissed this minion.'] });
await minion('an answer', { type: 'research', cost: 11, notes: ['Claude dismissed this minion: report read'] });
await minion('an idea', { type: 'ideation', cost: 1, notes: ['Shipped and live, so the server dismissed this minion.'] });
await minion('still going', { type: 'feature', closed: false });
await minion('no type', {});
await minion('its pull request merged into a build', { type: 'feature', pr: true, build: 3 });
// The words a merge into a build left until Nov 19, and a ship whose commit's subject wasn't known.
await minion('merged, in the old words', { type: 'feature', notes: ['Shipped 0123abc4d "a piece": a piece. Risk low: small. Merged into build/3, not live until the build ships.'] });
await minion('shipped, no subject', { type: 'bug', notes: ['Shipped 0123abc4d: a thing. Risk low: small. Shipped.'] });
await minion('not this scheme', { type: 'feature', cost: 99, project: other.id });
await minion('in the other scheme only', { type: 'feature', project: other.id });
store.addRelease({ project_id: scheme.id, target: 'app', version: '1', changes: JSON.stringify([1, 2, 3, 6].map((number) => ({ number, title: 'x' }))), started_at: null, live_at: Date.now(), outcome: 'live', stages: '[]' });
// A release that never went live says nothing.
store.addRelease({ project_id: scheme.id, target: 'app', version: '2', changes: JSON.stringify([{ number: 11, title: 'x' }]), started_at: null, live_at: Date.now(), outcome: 'failed', stages: '[]' });
git('commit', '-q', '--allow-empty', '-m', '#8: named by a commit, after #14');

const want: Record<number, [FlowMinion['kind'], FlowMinion['path'], FlowMinion['end'], number]> = {
  1: ['feature', 'shipped', 'live', 3],
  2: ['feature', 'shipped', 'live', 4],
  3: ['bug', 'refused', 'late', 9],
  4: ['bug', 'refused', 'build', 5],
  5: ['chore', 'refused', 'nothing', 20],
  6: ['chore', 'untold', 'live', 2],
  7: ['chore', 'shipped', 'main', 1],
  8: ['feature', 'other', 'main', 6],
  9: ['feature', 'other', 'main', 7],
  10: ['feature', 'never', 'build', 8],
  11: ['feature', 'never', 'nothing', 272],
  12: ['research', 'never', 'answer', 11],
  13: ['other', 'never', 'answer', 1],
  14: ['feature', 'never', 'open', 0],
  15: ['other', 'never', 'answer', 0],
  16: ['feature', 'never', 'build', 0],
  17: ['feature', 'never', 'build', 0],
  18: ['bug', 'shipped', 'main', 0],
};

test('every minion of the scheme, by kind, way to main and ending; another scheme’s are not in it', async () => {
  const flow = new WorkFlow(store, { dir: join(root, 'kept'), read: readApart, db, waitMs: 60_000 });
  const v = await flow.view(scheme.id, FROM, TO);
  assert.deepEqual(Object.fromEntries(v.minions.map((m) => [m.number, [m.kind, m.path, m.end, m.cost]])), want);
  assert.deepEqual([v.unread, v.git, v.releases], [0, true, true]);
  const said = Object.fromEntries(v.minions.map((m) => [m.number, m.said]));
  // The note a close left; a close with none says who, and the server's own close leaves nothing.
  assert.deepEqual([said[5], said[11], said[12], said[13], said[14]], ['replaced by #9', 'Closed by Cara, no note', 'report read', '', '']);
  assert.equal(v.minions.find((m) => m.number === 5)?.refused, 3);

  const apart = await flow.view(other.id, FROM, TO);
  assert.deepEqual(
    apart.minions.map((m) => [m.number, m.path, m.end]),
    [
      [2, 'never', 'norepo'],
      [1, 'never', 'norepo'],
    ],
  );
  assert.deepEqual([apart.git, apart.releases], [true, false]);
});

test('the river: every column holds every minion, and a ribbon for each step taken', async () => {
  const { minions } = await new WorkFlow(store, { dir: join(root, 'kept'), read: readApart, db, waitMs: 60_000 }).view(scheme.id, FROM, TO);
  const { cols, links, total } = layout(minions, 'n', 400);
  assert.equal(total, 18);
  assert.deepEqual(
    cols.map((c: FlowNode[]) => c.map((n) => [n.key, n.v])),
    [
      [
        ['feature', 9],
        ['bug', 3],
        ['chore', 3],
        ['research', 1],
        ['other', 2],
      ],
      [
        ['shipped', 4],
        ['untold', 1],
        ['refused', 3],
        ['other', 2],
        ['never', 8],
      ],
      [
        ['live', 3],
        ['main', 4],
        ['late', 1],
        ['build', 4],
        ['nothing', 2],
        ['answer', 3],
        ['open', 1],
      ],
    ],
  );
  assert.deepEqual(
    links.filter((l: { to: FlowNode }) => l.to.key === 'nothing').map((l) => [l.from.key, l.v]),
    [
      ['refused', 1],
      ['never', 1],
    ],
  );
  for (const c of cols as FlowNode[][]) {
    const end = c.at(-1)!;
    assert.ok(end.at + end.size <= 400.01 && c.every((n, i) => !i || n.at >= c[i - 1].at + c[i - 1].size), 'nodes fit and never overlap');
  }
  const cost = layout(minions, 'cost', 400);
  assert.equal(cost.total, 349);
  assert.equal(cost.cols[2].find((n: FlowNode) => n.key === 'nothing')?.v, 292);
  assert.deepEqual(
    rows(minions, 'cost')
      .slice(0, 2)
      .map((r) => [r.kind, r.path, r.end, r.n, r.cost]),
    [
      ['feature', 'never', 'nothing', 1, 272],
      ['chore', 'refused', 'nothing', 1, 20],
    ],
  );
  assert.deepEqual(layout([], 'n', 400).links, []);
});

test('a chat is read once until its minion changes, and one not read in time is counted, not guessed', async () => {
  const asked: number[][] = [];
  let hold: Promise<void> | null = null;
  const read = async (a: FlowAsk) => {
    if (a.ids.length) asked.push(a.ids);
    if (a.ids.length) await hold;
    return readApart(a);
  };
  const dir = join(root, 'once');
  const first = new WorkFlow(store, { dir, read, db, waitMs: 60_000 });
  assert.equal((await first.view(scheme.id, FROM, TO)).unread, 0);
  assert.equal(asked.length, 1);
  // A restart keeps them: only the minion that changed is read again.
  const t = store.createTicket({ project_id: scheme.id, title: 'new', permission_mode: 'default', created_by: 'Cara' });
  let open = () => {};
  hold = new Promise((r) => (open = r));
  const second = new WorkFlow(store, { dir, read, db, waitMs: 20 });
  const part = await second.view(scheme.id, FROM, TO);
  assert.deepEqual([part.unread, part.minions.length, asked.at(-1)], [1, 18, [t.id]]);
  open();
  hold = null;
  let all = await second.view(scheme.id, FROM, TO);
  while (all.unread) all = await second.view(scheme.id, FROM, TO);
  assert.deepEqual([all.unread, all.minions.length], [0, 19]);
  // One read before that has changed since is as unread as a new one; a broken file is read again.
  store.db.prepare('UPDATE tickets SET updated_at = updated_at + 5 WHERE id = ?').run(t.id);
  hold = new Promise((r) => (open = r));
  const changed = await second.view(scheme.id, FROM, TO);
  assert.deepEqual([changed.unread, changed.minions.length], [1, 18]);
  open();
  hold = null;
  let settled = await second.view(scheme.id, FROM, TO);
  while (settled.unread) settled = await second.view(scheme.id, FROM, TO);
  writeFileSync(join(dir, `${scheme.id}.json`), '{"broken');
  assert.equal((await new WorkFlow(store, { dir, read, db, waitMs: 60_000 }).view(scheme.id, FROM, TO)).unread, 0);
  assert.ok(Object.keys(JSON.parse(readFileSync(join(dir, `${scheme.id}.json`), 'utf8'))).length >= 15);
});

test('commits that cannot be read say so', async () => {
  const bare = store.createProject('No Git', null);
  store.setProjectRepoDir(bare.id, join(root, 'nowhere'));
  const v = await new WorkFlow(store, { dir: join(root, 'k2'), read: readApart, db, waitMs: 60_000 }).view(bare.id, FROM, TO);
  assert.deepEqual([v.git, v.minions], [false, []]);
});

test('a range is whole Pacific days, two weeks by default, through a clock change', () => {
  const at = (s: string) => Date.parse(s);
  assert.deepEqual(rangeOf('2026-11-01', '2026-11-01'), { from: at('2026-11-01T00:00:00-07:00'), to: at('2026-11-02T00:00:00-08:00') });
  assert.deepEqual(rangeOf(null, null, at('2026-11-25T12:00:00-08:00')), { from: at('2026-11-12T00:00:00-08:00'), to: at('2026-11-26T00:00:00-08:00') });
  for (const [from, to] of [
    ['2026-11-02', '2026-11-01'],
    ['nope', null],
    ['2026-02-30', '2026-03-02'],
    ['2024-01-01', '2026-01-01'],
  ] as const)
    assert.equal(rangeOf(from, to), null, `${from}..${to}`);
  assert.equal(dayStart('2026-03-08'), at('2026-03-08T00:00:00-08:00'));
});

test('which minion a commit names: the number its subject starts or ends with; GitHub’s own merges end with a pull request’s', () => {
  const log = ['t\t#12: after #9', 't\tFix a thing (#13)', 'GitHub\tA merge (#400)', 'GitHub\t#14 merged (#401)', 't\tnone', 't\tsee #15 and #16'].join('\n');
  assert.deepEqual(namedBy(log), [12, 13, 14, 15]);
});

test('a ship with no refusals on record and no note of its own is never a first try', () => {
  const none = { refused: 0, stalled: false, shipped: false, merged: false };
  const m = { type: 'feature', status: 'closed', live: 0, merged_pr: 0, build: null, created_at: Date.parse('2026-11-20T12:00:00-08:00') };
  const early = { ...m, created_at: Date.parse('2026-11-13T12:00:00-08:00') };
  assert.deepEqual(settle({ ...m, live: 1 }, none, true), { path: 'untold', end: 'live' });
  assert.deepEqual(settle({ ...m, live: 1 }, { ...none, shipped: true }, true), { path: 'shipped', end: 'live' });
  // On main by a commit alone: from before refusals were kept it says so.
  assert.deepEqual(settle(early, none, true), { path: 'untold', end: 'main' });
  assert.deepEqual(settle(m, none, true), { path: 'other', end: 'main' });
  assert.deepEqual(settle(m, none, false, false), { path: 'never', end: 'norepo' });
});

test('nodes that cost nothing: their ribbons stay inside them in dollars', () => {
  const free = (end: string) => ({ number: 1, title: 'x', kind: 'feature', path: 'never', end, cost: 0, refused: 0, said: '' });
  for (const ms of [
    [free('open'), free('nothing')],
    [free('open'), free('nothing'), { ...free('live'), kind: 'bug', path: 'shipped', cost: 5 }],
  ]) {
    const { links } = layout(ms, 'cost', 300);
    for (const l of links) assert.ok(l.a1 <= l.from.at + l.from.size + 1e-6 && l.b1 <= l.to.at + l.to.size + 1e-6, `${l.from.key} > ${l.to.key}`);
  }
});
