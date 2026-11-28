// A cabal's board (#2090, src/cabal-board.ts): every column read from facts (state, merged into build/<n> from git, claims
// from build-claims.md on the branch, start_after, spend, risk), the doubled-file flag of a goal cabal, and a read with
// Plot 7's shape staying under 6k tokens.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { cabalBoardFor } from '../src/access.ts';
import { boardText, doubledFiles, parseClaims, readBoard, timelineText } from '../src/cabal-board.ts';
import { Store } from '../src/db.ts';
import { git, makeRepo } from './git.ts';

const root = mkdtempSync(join(tmpdir(), 'cabal-board-'));
after(() => rmSync(root, { recursive: true, force: true })); // timing-ok: own temp dir
const repo = join(root, 'repo');
makeRepo(repo);
let n = 0;
const commit = (file = `f${++n}`, text = String(n)) => {
  writeFileSync(join(repo, file), text);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', `c${n}`);
};
commit();

const store = new Store(join(root, 'coordinator.db'));
const p = store.createProject('Scheme', null);
store.setProjectRepoDir(p.id, repo);
const sealed = new Set<number>();
const deps = { parked: (t: { id: number }) => sealed.has(t.id) };

function minion(title: string, build: number | null, from: string | null, commits: number) {
  const t = store.createTicket({ project_id: p.id, title, permission_mode: 'default', created_by: 'Cara' });
  const branch = `ticket/${t.id}`;
  if (from) {
    git(repo, 'checkout', '-q', '-b', branch, from);
    for (let i = 0; i < commits; i++) commit();
    git(repo, 'checkout', '-q', 'main');
    store.setTicketDir(t.id, join(root, branch), branch);
  }
  store.updateTicket(t.id, { build, status: 'idle' });
  return store.getTicket(t.id)!;
}
const cost = (id: number, usd: number) => store.db.prepare('INSERT INTO turns (ticket_id, ended_at, cost_usd, session_cost_usd) VALUES (?, 1, ?, 0)').run(id, usd);

test('a build cabal: each column comes from facts', async () => {
  git(repo, 'branch', 'build/7', 'main');
  const lead = minion('Plot 7 lead', 7, 'build/7', 0);
  const merged = minion('Running turn: one interface', 7, 'build/7', 2);
  const blocked = minion('Machine roles in the data', 7, 'build/7', 1);
  const chained = minion('Connect a machine', 7, null, 0);
  const building = minion('Host folders', 7, 'build/7', 1);
  const dismissed = minion('Dropped one', 7, 'build/7', 1);
  // The claims file on build/7, as the lead commits it (land.sh's format: a list mark, backticks and commas allowed).
  git(repo, 'checkout', '-q', 'build/7');
  commit('build-claims.md', `build: #${lead.number}\n- #${merged.number}: \`src/running-turn.ts\`, src/turns/\n#${blocked.number}: src/machine-roles.ts\nshared: src/machines.ts\n`);
  git(repo, 'checkout', '-q', 'main');
  // merged: its branch folded into build/7 (a merge commit, as --into makes).
  git(repo, 'checkout', '-q', 'build/7');
  git(repo, 'merge', '-q', '--no-ff', '-m', 'merge', `ticket/${merged.id}`);
  git(repo, 'checkout', '-q', 'main');
  store.addEvent(merged.id, 'note', { text: `Merged into Plot 7: one interface. Risk low: small.` });
  cost(merged.id, 4.62);
  cost(lead.id, 30);
  for (const t of [merged, blocked, chained, building, dismissed]) store.joinCabal(t.id, lead.id, p.id, t.title);
  store.updateCabalRow(store.cabalRowOf(blocked.id)!.id, { label: 'M1', note: 'Go given.' });
  store.addCabalAsk(lead.id, blocked.id, 'Lend src/machines.ts for one merge', true);
  store.addCabalAsk(lead.id, building.id, 'Which test helper?', false);
  store.addDelivery({ project_id: p.id, kind: 'chain', to_kind: 'minion', to_id: chained.id, when_kind: 'merged', when_arg: { after: blocked.id, base: null }, payload: { message: 'brief', from: 'Cara', reason: '' }, set_by: 'Cara', dedupe_key: String(chained.id) });
  sealed.add(chained.id);
  store.updateTicket(building.id, { status: 'running' });
  store.updateTicket(dismissed.id, { status: 'closed' });
  store.addCabalRow(lead.id, { label: 'T7', title: 'Pilot', after: 'everything' });

  const b = (await readBoard(store, lead.id, deps))!;
  assert.equal(b.name, 'Plot 7');
  assert.equal(b.kind, 'build');
  const row = (title: string) => b.members.find((m) => m.title === title)!;
  assert.deepEqual(
    b.members.map((m) => [m.title, m.state]),
    [
      ['Machine roles in the data', 'blocked'],
      ['Host folders', 'running'],
      ['Connect a machine', 'sealed'],
      ['Pilot', 'roster'],
      ['Running turn: one interface', 'merged'],
      ['Dropped one', 'closed'],
    ],
    'open first, the blocked on top',
  );
  assert.equal(row('Running turn: one interface').risk, 'low');
  assert.equal(row('Running turn: one interface').spend, 4.62);
  assert.deepEqual(row('Running turn: one interface').claims, ['src/running-turn.ts', 'src/turns/']);
  assert.deepEqual(row('Machine roles in the data').claims, ['src/machine-roles.ts']);
  assert.equal(row('Machine roles in the data').label, 'M1');
  assert.equal(row('Connect a machine').after, `#${blocked.number}`, 'start_after');
  assert.equal(row('Pilot').after, 'everything', "a roster row's own after");
  assert.equal(row('Pilot').number, null);
  assert.equal(row('Dropped one').word, 'dismissed');
  assert.deepEqual(
    b.asks.map((a) => [a.from, a.blocking]),
    [
      ['M1', true],
      ['Host folders', false],
    ],
  );
  assert.deepEqual(b.counts, { members: 6, started: 5, merged: 1, open: 4, working: 2, running: 1, spend: 34.62 }, 'at work: the blocked and the building; the sealed, merged and dismissed hold no place');
  const text = boardText(b, blocked);
  assert.match(text, /^Plot 7 \(build\/7\) · Plot 7's Overseer #\d+/);
  assert.match(text, /ask \d+ BLOCKING from M1 #\d+ .*Lend src\/machines\.ts/);
  assert.match(text, /M1 #\d+ Machine roles in the data \(you\) \| blocked \| Go given\. \| claims src\/machine-roles\.ts/);
  assert.match(text, /\| merged \| \$4\.62 \| risk low \| claims src\/running-turn\.ts src\/turns\//);
});

test('an answered ask stays on the board with its answer, the newest ten, and counts nowhere as open (#2289)', async () => {
  const lead = minion('Answers lead', null, null, 0);
  const asker = minion('Asker', null, null, 0);
  store.joinCabal(asker.id, lead.id, p.id, asker.title);
  const ids = Array.from({ length: 12 }, (_, i) => store.addCabalAsk(lead.id, asker.id, `Ask ${i}`, false, 1000 + i));
  const open = store.addCabalAsk(lead.id, asker.id, 'Still open', true, 2000);
  // Answered in reverse, so the oldest ask has the newest answer: the board orders by when each was answered.
  for (const [i, id] of ids.entries()) store.answerCabalAsk(id, `Answer ${i}`, '#1 lead', 4000 - i);
  const b = (await readBoard(store, lead.id, deps))!;
  assert.deepEqual(
    b.asks.map((a) => [a.text, a.answer]),
    [['Still open', null], ...Array.from({ length: 10 }, (_, i) => [`Ask ${i}`, `Answer ${i}`])],
    'the open ones, then the ten answered most lately, newest first',
  );
  assert.equal(b.asks[0].id, open);
  assert.equal(b.members[0].state, 'blocked', 'the open blocking ask still blocks');
  const text = boardText(b);
  assert.match(text, /Open asks \(1\):\n- ask \d+ BLOCKING from Asker #\d+ .*Still open/);
  assert.doesNotMatch(text, /Ask 0/, "the agents' read lists open asks only");
});

test('a goal cabal (no branch): shipped from its ship note, and a file two members list is flagged', async () => {
  const lead = minion('Docs sweep lead', null, null, 0);
  store.props.set('minion', lead.id, p.id, { effortName: 'Docs sweep' }, 'Cara');
  const a = minion('Sweep A', null, null, 0);
  const c = minion('Sweep B', null, null, 0);
  for (const t of [a, c]) store.joinCabal(t.id, lead.id, p.id, t.title);
  store.updateCabalRow(store.cabalRowOf(a.id)!.id, { files: 'test/helpers.ts\nsrc/a.ts' });
  store.updateCabalRow(store.cabalRowOf(c.id)!.id, { files: 'test/\nsrc/b.ts' });
  store.addEvent(a.id, 'note', { text: 'Shipped #3: docs. Risk medium: wide. Live after restart.' });
  const b = (await readBoard(store, lead.id, deps))!;
  assert.equal(b.kind, 'goal');
  assert.equal(b.name, 'Docs sweep');
  const row = (t: string) => b.members.find((m) => m.title === t)!;
  assert.equal(row('Sweep A').state, 'shipped');
  assert.equal(row('Sweep A').risk, 'medium');
  assert.deepEqual(row('Sweep A').doubled, ['test/helpers.ts']);
  assert.deepEqual(row('Sweep B').doubled, ['test/']);
  assert.match(boardText(b), /DOUBLED: test\/helpers\.ts/);
  assert.match(boardText(b), /goal, no branch/);
});

test("parseClaims reads land.sh's lines and doubledFiles matches folders", () => {
  assert.deepEqual([...parseClaims('build: #1\n* #4: `a.ts`, b/\nshared: x.ts\n#4: c.ts\nnot a claim')], [[4, ['a.ts', 'b/', 'c.ts']]]);
  assert.deepEqual(doubledFiles([['a.ts', 'src/x.ts'], ['src/'], ['b.ts']]), [['src/x.ts'], ['src/'], []]);
});

test("Plot 7's shape (18 rows, 1 ask) reads under 6k tokens", async () => {
  const lead = minion('Big lead', null, null, 0);
  const files = ['src/machine-roles.ts', 'src/machine-lend.ts', 'src/routes/machines.ts', 'public/settings-machines.js'];
  for (let i = 0; i < 18; i++) {
    const t = minion(`Piece ${i}: a machine roles thing with a longish title`, null, null, 0);
    store.joinCabal(t.id, lead.id, p.id, t.title);
    store.updateCabalRow(store.cabalRowOf(t.id)!.id, { label: `M${i}`, lane: 'Roles', note: 'Go given. Needs a lend of src/machines.ts to merge into the build.', files: files.join('\n') });
    cost(t.id, 20 + i);
    store.addEvent(t.id, 'note', { text: 'Shipped #1: x. Risk high: wide.' });
    if (i === 3) store.addCabalAsk(lead.id, t.id, 'Lend src/machines.ts and src/routes/machines.ts for one merge, please: my line needs them', true);
  }
  for (let i = 0; i < 20; i++) store.addCabalLog(lead.id, '#1935 Plot 7', `Josh, 21:${i}: "Lend it for one merge" — gave M1 the lend of src/machines.ts`);
  const text = boardText((await readBoard(store, lead.id, deps))!);
  const tokens = Math.ceil(text.length / 4); // about 4 characters a token for this English and paths
  assert.ok(tokens < 6000, `${tokens} tokens`);
  assert.equal(text.split('\n').filter((l) => /^\d+ · M\d+ /.test(l)).length, 18);
});

test("the timeline shows a reader outside the lead's scheme no log, no other asks and no ship words (#2096)", async () => {
  const store = new Store(':memory:');
  const home = store.createProject('Home', null);
  const away = store.createProject('Away', null);
  const mk = (project_id: number, title: string) => store.createTicket({ project_id, title, permission_mode: 'default', created_by: 'Cara' });
  const lead = mk(home.id, 'Lead');
  const [mine, theirs] = [mk(away.id, 'Away part'), mk(home.id, 'Home part')];
  store.ensureCabal(lead.id, home.id);
  store.addCabalRow(lead.id, { ticket_id: mine.id, project_id: away.id });
  store.addCabalRow(lead.id, { ticket_id: theirs.id });
  store.addCabalLog(lead.id, '#1', 'SECRET-LOG');
  store.addCabalAsk(lead.id, theirs.id, 'SECRET-ASK', false);
  store.addCabalAsk(lead.id, mine.id, 'AWAY-ASK', false);
  store.addEvent(theirs.id, 'note', { text: 'Shipped abc1234 SECRET-SHIP' });
  const whole = (await readBoard(store, lead.id, { parked: () => false }))!;

  const outside = timelineText(
    store,
    cabalBoardFor(whole, (p) => p === away.id),
  );
  assert.match(outside, /AWAY-ASK/);
  assert.doesNotMatch(outside, /SECRET/);
  // The lead's own scheme sees every ask, other schemes' named, and the log.
  const inside = timelineText(
    store,
    cabalBoardFor(whole, (p) => p === home.id),
  );
  assert.match(inside, /SECRET-LOG/);
  assert.match(inside, /Away #\d+: AWAY-ASK/);
  assert.match(inside, /SECRET-SHIP/);
});

test('a member with a merged commit reads merged only once its work is finished (#2302)', async () => {
  git(repo, 'branch', 'build/8', 'main');
  const lead = minion('Plot 8 lead', 8, 'build/8', 0);
  const mk = (title: string) => minion(title, 8, 'build/8', 1);
  const working = mk('Fixer');
  const away = mk('Sealed fix');
  const waiting = mk('Done and waiting');
  git(repo, 'checkout', '-q', 'build/8');
  for (const t of [working, away, waiting]) git(repo, 'merge', '-q', '--no-ff', '-m', 'merge', `ticket/${t.id}`);
  git(repo, 'checkout', '-q', 'main');
  for (const t of [working, away, waiting]) store.joinCabal(t.id, lead.id, p.id, t.title);
  store.updateTicket(working.id, { status: 'running' });
  sealed.add(away.id);
  const b = (await readBoard(store, lead.id, deps))!;
  const state = (title: string) => b.members.find((m) => m.title === title)!.state;
  assert.equal(state('Fixer'), 'running', 'working, though a commit merged');
  assert.equal(state('Sealed fix'), 'sealed');
  assert.equal(state('Done and waiting'), 'merged', 'open and idle with its branch merged is finished');
  assert.equal(b.counts.merged, 1);
});

test("a Plot whose branch has shipped and is gone reads a member's own Merged note as shipped, unless it is still at work", async () => {
  const lead = minion('Plot 8 lead', 8, null, 0); // build/8 never exists: it shipped to main and was deleted
  const done = minion('Merged then dismissed', 8, null, 0);
  const dropped = minion('Dismissed without merging', 8, null, 0);
  const working = minion('Merged but running', 8, null, 0);
  store.addEvent(done.id, 'note', { text: 'Merged into Plot 8: it. Risk low: small.' });
  store.addEvent(working.id, 'note', { text: 'Merged into Plot 8: it. Risk low: small.' });
  for (const t of [done, dropped, working]) store.joinCabal(t.id, lead.id, p.id, t.title);
  store.updateTicket(done.id, { status: 'closed' });
  store.updateTicket(dropped.id, { status: 'closed' });
  store.updateTicket(working.id, { status: 'running' });
  const b = (await readBoard(store, lead.id, deps))!;
  assert.deepEqual(Object.fromEntries(b.members.map((m) => [m.title, m.state])), { 'Merged then dismissed': 'shipped', 'Dismissed without merging': 'closed', 'Merged but running': 'running' });
  assert.equal(b.counts.merged, 1);
});
