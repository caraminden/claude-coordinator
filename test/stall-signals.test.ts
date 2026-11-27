import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { emptyState, failingTests, observe, shipFailed, StallWatch, stallKey, SUGGESTIONS_KEY, refusalKind, type StallState } from '../src/stall-signals.ts';
import { NO_CODE } from '../src/land.ts';
import { nextStep, TIERS } from '../public/model-table.js';
import { editedFiles, testCommand } from '../src/stall-signals.ts';

// The server notices a stall (#1139, G5; Josh, 2026-11-19): the same test red three times, the same file edited after four
// failed checks in a row, two failed ships; one suggestion to the Taskmaster per tier, changing nothing.
const root = mkdtempSync(join(tmpdir(), 'stall-signals-'));
after(() => rmSync(root, { recursive: true, force: true }));

let ids = 0;
const run = (command: string) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: `t${++ids}`, name: 'Bash', input: { command } }] } });
const result = (content: string, is_error = false) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${ids}`, content, is_error }] } });
const edit = (file_path: string) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: `t${++ids}`, name: 'Edit', input: { file_path, old_string: 'a', new_string: 'b' } }] } });
const RED = 'Exit code 1\n✖ 24 passed, 1 failed in 3 s\n\n✖ test/land.test.ts:91 › keeps the queue\n  expected 1';
const GREEN = '✔ 25 passed in 3 s';

function feed(s: StallState, events: Parameters<typeof observe>[1][]) {
  return events.flatMap((e) => observe(s, e).signals);
}

test('failingTests reads each runner it knows', () => {
  assert.deepEqual(failingTests(RED), ['test/land.test.ts › keeps the queue']);
  assert.deepEqual(failingTests('✖ test/a.test.ts:3 › one\n✖ test/a.test.ts:9 › two\n✖ test/b.test.ts'), ['test/a.test.ts › one', 'test/a.test.ts › two', 'test/b.test.ts']);
  assert.deepEqual(failingTests('TAP version 13\nnot ok 3 - parses the header # time=2ms\nok 4 - other'), ['parses the header']);
  assert.deepEqual(failingTests('test snaps::crop_keeps_field ... FAILED\ntest a::b ... ok'), ['snaps::crop_keeps_field']);
  assert.deepEqual(failingTests('FAILED tests/test_api.py::test_login - AssertionError'), ['tests/test_api.py::test_login']);
  assert.deepEqual(failingTests('--- FAIL: TestParse (0.00s)'), ['TestParse']);
  assert.deepEqual(failingTests(' FAIL src/app.test.ts > adds'), ['src/app.test.ts']);
  assert.deepEqual(failingTests(GREEN), []);
});

test('the same test red three times fires once, on the third', () => {
  const s = emptyState();
  const got = feed(s, [run('citadel-test test/land.test.ts'), result(RED, true), run('citadel-test test/land.test.ts'), result(RED, true)]);
  assert.deepEqual(got, []);
  const third = feed(s, [run('citadel-test test/land.test.ts'), result(RED, true)]);
  assert.equal(third.length, 1);
  assert.equal(third[0].kind, 'red-test');
  assert.match(third[0].what, /test\/land\.test\.ts › keeps the queue red 3 times/);
  assert.deepEqual(feed(s, [run('citadel-test test/land.test.ts'), result(RED, true)]), [], 'a fourth red does not fire again');
});

test('a red run with no names it can read counts by its command; output from other commands is not a test run', () => {
  const s = emptyState();
  const got = feed(
    s,
    [1, 2, 3].flatMap(() => [run('cargo test -p harness'), result('error[E0425]: cannot find value', true)]),
  );
  assert.equal(got.length, 1);
  assert.match(got[0].what, /exit: cargo test -p harness/);
  // Reading a log full of failures (cat, grep) is no test run.
  assert.deepEqual(
    feed(
      emptyState(),
      [1, 2, 3].flatMap(() => [run('cat $TMPDIR/citadel-test.log'), result(RED)]),
    ),
    [],
  );
});

test('a test command counts only as the command a segment runs', () => {
  for (const yes of [
    'citadel-test test/a.test.ts',
    'cd /w && npx tsc --noEmit',
    'citadel-heavy cargo test --workspace',
    'citadel-job --minutes 30 npm test',
    'citadel-job cargo test',
    'citadel-heavy --here ./gradlew :app:testDebug',
    'FOO=1 npm test',
    'timeout 300 node --test test/',
    'make x; pytest -q',
    './gradlew :app:testDebug',
  ])
    assert.ok(testCommand(yes) || /tsc/.test(yes), yes);
  for (const no of ['cat $TMPDIR/citadel-test.log', 'grep -rn pytest pyproject.toml', 'rg jest package.json', 'echo "npm test"', 'git log --grep cargo test']) assert.ok(!testCommand(no), no);
});

test('Codex edits count too: apply_patch lists its files', () => {
  assert.deepEqual(editedFiles({ type: 'tool_use', name: 'apply_patch', input: { files: ['update /w/src/a.ts', 'add /w/src/b.ts'] } }), ['/w/src/a.ts', '/w/src/b.ts']);
  assert.deepEqual(editedFiles({ type: 'tool_use', name: 'Edit', input: { file_path: '/w/a.ts' } }), ['/w/a.ts']);
  assert.deepEqual(editedFiles({ type: 'tool_use', name: 'Read', input: { file_path: '/w/a.ts' } }), []);
});

test('file churn: the same file edited after four failed checks, with no green run between, fires once', () => {
  const s = emptyState();
  // Edits before any failure are building, not churn.
  assert.deepEqual(feed(s, [edit('/w/src/a.ts'), edit('/w/src/a.ts'), edit('/w/src/a.ts'), edit('/w/src/a.ts'), edit('/w/src/a.ts')]), []);
  const rounds = (n: number) => Array.from({ length: n }, () => [run('npx tsc --noEmit'), result('src/a.ts(3,1): error TS2304', true), edit('/w/src/a.ts'), edit('/w/src/a.ts')]).flat();
  assert.deepEqual(feed(s, rounds(3)), [], 'three rounds, and two edits in one round count once');
  const got = feed(s, rounds(1));
  assert.equal(got.length, 1);
  assert.equal(got[0].kind, 'file-churn');
  assert.match(got[0].what, /src\/a\.ts edited after 4 failed checks/);
  assert.deepEqual(feed(s, rounds(2)), []);
});

test('a green test run ends the stretch', () => {
  const s = emptyState();
  const rounds = (n: number) => Array.from({ length: n }, () => [run('npm test'), result('not ok 1 - x', true), edit('/w/b.ts')]).flat();
  feed(s, rounds(3));
  feed(s, [run('npm test'), result('ok 1 - x')]);
  assert.deepEqual(
    feed(s, rounds(1)).filter((g) => g.kind === 'file-churn'),
    [],
    'the count started over after green',
  );
});

test("a Grunt's tool calls are its own, not the minion's", () => {
  const s = emptyState();
  const grunt = <E extends object>(e: E) => ({ ...e, parent_tool_use_id: 'toolu_x' });
  assert.deepEqual(
    feed(
      s,
      [1, 2, 3].flatMap(() => [grunt(run('citadel-test test/land.test.ts')), grunt(result(RED, true))]),
    ),
    [],
  );
});

test('two failed ships fire, naming their kinds', () => {
  const s = emptyState();
  assert.deepEqual(shipFailed(s, 'own-test'), []);
  const got = shipFailed(s, 'parse');
  assert.equal(got.length, 1);
  assert.match(got[0].evidence[0], /own-test, parse/);
  assert.deepEqual(shipFailed(s, 'own-test'), []);
});

// #2047 (Josh, 2026-11-25): a refusal the minion couldn't help says nothing about its model.
test("refusals that are not the model's fault never count: conflict, passed alone, boot-check copy, cut off, CI", () => {
  const s = emptyState();
  for (const kind of ['conflict', 'conflict', 'passed-alone', 'boot-copy', 'cut-off', 'ci', 'no-answer']) assert.deepEqual(shipFailed(s, kind), [], kind);
  assert.deepEqual(s.ships, []);
  assert.deepEqual(shipFailed(s, 'own-test'), []);
  assert.deepEqual(shipFailed(s, 'conflict'), [], 'one real failure and a conflict are not two');
  assert.match(shipFailed(s, 'own-test')[0].evidence[0], /kinds: own-test, own-test/);
});

// How server.ts reads a handed-off run before counting it.
test('a handed-off run that gave no exit code or no CI verdict is read as one that does not count', () => {
  const red = 'land: smoke: ✖ test/a.test.ts › b';
  assert.equal(refusalKind(red, 1), 'own-test');
  assert.equal(refusalKind(`${red}${NO_CODE}`, 1), 'cut-off', 'a red printed before the cut still counts as cut off');
  assert.equal(refusalKind(red, 75), 'no-answer');
  assert.equal(refusalKind('something else', 1), null);
  // Run by the minion, the exit code is only in the text.
  for (const head of ['tools/land.sh exited 75 (read its output).', 'Exit code 75']) assert.equal(refusalKind(`${head}\n${red}`), 'no-answer', head);
  // A conflict the recorded fix resolved did not refuse the ship: what came after it did.
  const resolved = "CONFLICT (content): Merge conflict in a.ts\nland: the fix recorded ahead of time (git rerere, conflict prep) resolved the rebase's conflicts";
  assert.equal(refusalKind(`${resolved}\n${red}`, 1), 'own-test');
});

test('a count saved before these kinds stopped counting does not fire on one real failure', () => {
  const s = { ...emptyState(), ships: ['conflict'] };
  assert.deepEqual(shipFailed(s, 'own-test'), []);
  assert.deepEqual(s.ships, ['own-test']);
});

test('a land.sh the minion runs itself that hits a merge conflict or is cut off does not count either', () => {
  const s = emptyState();
  const out = 'tools/land.sh exited 1 (read its output: main only moved if it says so).\nCONFLICT (content): Merge conflict in src/a.ts';
  const cut = `tools/land.sh exited 1 (read its output: main only moved if it says so).\n\n✖ test/a.test.ts › b${NO_CODE}`;
  for (const o of [out, out, cut, cut]) assert.deepEqual(feed(s, [run('tools/land.sh'), result(o, true)]), []);
  assert.deepEqual(s.ships, []);
});

test('a land.sh the minion runs itself counts as a ship; a clean one does not', () => {
  const s = emptyState();
  const land = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: `t${++ids}`, name: 'mcp__thread__land', input: {} }] } };
  assert.deepEqual(feed(s, [land, result('tools/land.sh exited 0.\n\nmain is now at abc1234')]), []);
  assert.deepEqual(feed(s, [run('tools/land.sh --into build/3 --full'), result('Exit code 1\nconflict', true)]), []);
  const got = feed(s, [{ ...land, message: { ...land.message, content: [{ ...land.message.content[0], id: `t${++ids}` }] } }, result('tools/land.sh exited 1 (read its output: main only moved if it says so).')]);
  assert.equal(got.length, 1);
  assert.equal(got[0].kind, 'failed-ships');
});

test('nextStep follows the tiers: Sonnet up to Opus medium, then high, then Fable; Fable off stops at Opus high', () => {
  const after = '2026-12-15';
  assert.deepEqual(nextStep('claude-sonnet-5-5', 'medium', true, after), { model: 'claude-opus-5-5', effort: 'medium' });
  assert.deepEqual(nextStep('claude-sonnet-5-5', 'medium', true, '2026-11-20'), { model: 'claude-sonnet-5-5+opus-advisor', effort: 'medium' }, 'the advisor trial comes first while it runs');
  assert.deepEqual(nextStep('claude-opus-5-5', 'medium'), { model: 'claude-opus-5-5', effort: 'high' });
  assert.deepEqual(nextStep('claude-opus-5-5', 'high'), { model: 'claude-fable-5-2', effort: 'medium' });
  assert.equal(nextStep('claude-opus-5-5', 'high', false), null);
  assert.deepEqual(nextStep('claude-fable-5-2', 'medium'), { model: 'claude-fable-5-2', effort: 'xhigh' });
  assert.equal(nextStep('claude-fable-5-2', 'xhigh'), null);
  assert.equal(nextStep(null, null), null);
  assert.equal(nextStep('gpt-6-astra', 'high'), null);
  // Every step it names is a model the table uses, so renaming one in TIERS fails here.
  const models = new Set(TIERS.map((t) => t.model));
  for (const [m, e] of TIERS.map((t) => [t.model, t.effort]).concat([
    ['claude-haiku-5-5', 'low'],
    ['claude-opus-5-5', 'high'],
    ['claude-fable-5-2', 'medium'],
  ]))
    for (const day of ['2026-11-20', '2026-12-01']) {
      const next = nextStep(m, e, true, day);
      if (next) assert.ok(models.has(next.model), `${m} ${e} → ${next.model}`);
    }
});

function world(fable: 'on' | 'off' = 'on', taskmaster = true) {
  const store = new Store(join(root, `db-${++ids}.db`));
  const josh = store.createUser({ name: 'Josh', login: 'josh' });
  const p = store.createProject('Peek Auras', null);
  if (fable === 'off') store.db.prepare('UPDATE projects SET fable_ok = ? WHERE id = ?').run('off', p.id);
  const t = store.createTicket({ project_id: p.id, title: 'Crop keeps its field', permission_mode: 'default', created_by: String(josh.id) });
  store.updateTicket(t.id, { model: 'claude-opus-5-5', effort: 'medium' });
  const told: string[] = [];
  const notes: string[] = [];
  const watch = new StallWatch({ store, tell: (_t, text) => taskmaster && (told.push(text), true), note: (_id, text) => notes.push(text) });
  return { store, t, told, notes, watch };
}

test('a stalled minion gets exactly one suggestion to its Taskmaster, with the evidence and the next tier', () => {
  const w = world();
  // Red three times on one test, then the same file churned, then two failed ships: all one stall at one tier.
  for (let i = 0; i < 4; i++) for (const e of [run('citadel-test test/land.test.ts'), result(RED, true), edit('/w/src/land.ts')]) w.watch.observe(w.t.id, e);
  w.watch.shipFailed(w.t.id, 'own-test');
  w.watch.shipFailed(w.t.id, 'parse');
  assert.equal(w.told.length, 1);
  assert.match(w.told[0], /Stall signal on #\d+ Crop keeps its field/);
  assert.match(w.told[0], /test\/land\.test\.ts › keeps the queue red 3 times/);
  assert.match(w.told[0], /Opus 5\.5 medium is Opus 5\.5 high: update_ticket with model claude-opus-5-5, effort high/);
  assert.match(w.told[0], /nothing was changed/);
  assert.equal(w.notes.length, 1);
  assert.match(w.notes[0], /Suggested Opus 5\.5 high/);
  assert.equal(w.store.getSetting<unknown[]>(SUGGESTIONS_KEY)?.length, 1);
  // Stepped up, it can stall again: one more suggestion, from the new tier.
  w.store.updateTicket(w.t.id, { effort: 'high' });
  for (let i = 0; i < 3; i++) for (const e of [run('citadel-test test/other.test.ts'), result(RED.replace('land', 'other'), true)]) w.watch.observe(w.t.id, e);
  assert.equal(w.told.length, 2);
  assert.match(w.told[1], /Opus 5\.5 high is Fable 5\.2 medium/);
  assert.equal(w.store.getSetting<StallState>(stallKey(w.t.id))?.sent.length, 2);
});

test('the same stall going on after a step-up signals again at the new tier: the same test red, or ships failing (2R2)', () => {
  const red = (w: ReturnType<typeof world>) => {
    for (let i = 0; i < 3; i++) for (const e of [run('citadel-test test/land.test.ts'), result(RED, true)]) w.watch.observe(w.t.id, e);
  };
  const w = world();
  red(w);
  assert.equal(w.told.length, 1);
  w.store.updateTicket(w.t.id, { effort: 'high' });
  red(w);
  assert.equal(w.told.length, 2, 'the same test red three more times at Opus high');
  assert.match(w.told[1], /test\/land\.test\.ts › keeps the queue red 3 times/);
  assert.match(w.told[1], /Opus 5\.5 high is Fable 5\.2 medium/);
  red(w);
  assert.equal(w.told.length, 2, 'still one suggestion per tier');
  // Red three more times at a tier already told, then stepped up: the new tier still hears after its own three.
  const u = world();
  red(u);
  red(u);
  assert.equal(u.told.length, 1);
  u.store.updateTicket(u.t.id, { effort: 'high' });
  red(u);
  assert.equal(u.told.length, 2, 'reds at a told tier are not carried past the step-up');
  const v = world();
  v.watch.shipFailed(v.t.id, 'parse');
  v.watch.shipFailed(v.t.id, 'burn-in');
  assert.equal(v.told.length, 1);
  v.store.updateTicket(v.t.id, { effort: 'high' });
  v.watch.shipFailed(v.t.id, 'own-test');
  assert.equal(v.told.length, 1);
  v.watch.shipFailed(v.t.id, 'own-test');
  assert.equal(v.told.length, 2, 'two more failed ships at Opus high');
  assert.match(v.told[1], /kinds: own-test, own-test/);
});

test('at the top with Fable off it names no step-up; Taskmasters and closed minions get none', () => {
  const w = world('off');
  const by = w.t.created_by;
  w.store.updateTicket(w.t.id, { effort: 'high' });
  w.watch.shipFailed(w.t.id, null);
  w.watch.shipFailed(w.t.id, null);
  assert.match(w.told[0], /top of the model table with Fable off/);
  const tm = w.store.createTicket({ project_id: w.t.project_id, title: 'Taskmaster', permission_mode: 'default', created_by: by, kind: 'coordinator' });
  w.watch.shipFailed(tm.id, null);
  w.watch.shipFailed(tm.id, null);
  const closed = w.store.createTicket({ project_id: w.t.project_id, title: 'Done', permission_mode: 'default', created_by: by });
  w.store.updateTicket(closed.id, { status: 'closed' });
  w.watch.shipFailed(closed.id, null);
  w.watch.shipFailed(closed.id, null);
  assert.equal(w.told.length, 1);
});

test('no Taskmaster to tell: nothing is recorded and the tier is not spent; an unknown model gets no false "top of the table"', () => {
  const w = world('on', false);
  w.watch.shipFailed(w.t.id, null);
  w.watch.shipFailed(w.t.id, null);
  assert.deepEqual(w.notes, []);
  assert.equal(w.store.getSetting<unknown[]>(SUGGESTIONS_KEY) ?? null, null);
  assert.deepEqual(w.store.getSetting<StallState>(stallKey(w.t.id))?.sent, []);
  const v = world();
  v.store.updateTicket(v.t.id, { model: 'gpt-6-astra' });
  v.watch.shipFailed(v.t.id, null);
  v.watch.shipFailed(v.t.id, null);
  assert.match(v.told[0], /The model table names no step from gpt-6-astra/);
});
