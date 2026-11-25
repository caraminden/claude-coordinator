// The server moves a plan whose steps have kinds (#1923): public/progress.js replays the calls, so the bar follows the work.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyEvent, createProgress, planEstimate, planTrack, progressLine, runningFor, stepInfo, stepName, workKind } from '../public/progress.js';

const T0 = 1_700_000_000_000;

/** A chat with a plan: its steps as [kind, title, minutes]. `do` makes calls; `bar` is a letter per step. */
function chat(steps, { kinds = true } = {}) {
  const p = { ...createProgress(), finished: [] };
  let id = 0;
  let now = T0;
  const ev = (data) => applyEvent(p, 'claude', data, now);
  const call = (name, input = {}, extra = {}) => ev({ type: 'assistant', ...extra, message: { content: [{ type: 'tool_use', id: `c${++id}`, name, input }] } });
  const c = {
    p,
    call,
    plan: (list) => call('mcp__thread__plan', { steps: list }),
    at: (min) => void (now = T0 + min * 60_000),
    now: () => now,
    edit: (extra) => call('Edit', { file_path: '/repo/src/a.ts' }, extra),
    test: (extra) => call('Bash', { command: 'citadel-test test/a.test.ts' }, extra),
    review: () => call('Agent', { subagent_type: 'citadel:reviewer', description: 'Review' }),
    read: () => call('Read', { file_path: '/repo/src/a.ts' }),
    ship: () => call('mcp__thread__hand_off_land', { summary: 'x' }),
    over: () => ev({ type: 'result', subtype: 'success', is_error: false }),
    turn: () => {
      c.over();
      ev({ type: 'system', subtype: 'init' });
    },
    end: (turn_state) => ev({ type: 'assistant', ...(turn_state ? { turn_state } : {}), message: { content: [{ type: 'text', text: 'Done.' }] } }),
    bar: () => p.tasks.map((t) => ({ completed: 'c', in_progress: 'i', pending: 'p' })[t.status]).join(''),
  };
  ev({ type: 'system', subtype: 'init' });
  c.plan(steps.map(([kind, step, minutes], i) => ({ n: i + 1, step: step ?? kind, ...(kinds ? { kind } : {}), ...(minutes ? { minutes } : {}) })));
  return c;
}
const usual = () => chat([['read'], ['build'], ['test'], ['review'], ['ship']]);

test('the bar follows the work with no tick from the minion: edits, tests, a review, a ship', () => {
  const c = usual();
  const seen = [c.bar()];
  for (const step of ['read', 'edit', 'test', 'review', 'ship']) {
    c[step]();
    seen.push(c.bar());
  }
  assert.deepEqual(seen, ['ipppp', 'ipppp', 'cippp', 'ciipp', 'cccip', 'cccci']);
  c.end('pending-deploy');
  assert.equal(c.bar(), 'ccccc', "the reply's status line ends the plan");
});

test('a failed test then an edit puts the bar back on build, with no tick taken back', () => {
  const c = usual();
  c.edit();
  c.test();
  assert.equal(c.bar(), 'ciipp', 'the build stays open under its tests');
  assert.deepEqual(
    planTrack(c.p).map(([, st]) => st),
    ['c', 'h', 'i', 'p', 'p'],
  );
  assert.equal(stepName(c.p, true), 'test');
  c.edit();
  assert.equal(c.bar(), 'cippp');
  c.test();
  c.review();
  assert.equal(c.bar(), 'cccip');
  c.edit();
  c.test();
  assert.equal(c.bar(), 'cccip', 'fixing what a review found is still the review');
});

test('steps of one kind show as one shared stage, its guesses summed and its time split by them', () => {
  const c = chat([
    ['read', 'Read'],
    ['build', 'Parser', 10],
    ['build', 'Page', 20],
    ['ship', 'Ship'],
  ]);
  c.edit();
  assert.equal(c.bar(), 'ciip');
  assert.equal(progressLine(c.p, true), 'Building, 2 steps… · 1 of 4 done');
  assert.equal(planEstimate(c.p, true, c.now()).usual, 30 * 60);
  c.at(15);
  c.ship();
  assert.equal(c.bar(), 'ccci');
  assert.deepEqual(
    c.p.tasks.slice(1, 3).map((t) => Math.round(t.work / 60_000)),
    [5, 10],
  );
});

test('build, test, build in one round is one stage; a card or ship between starts another', () => {
  const round = chat([['build'], ['test'], ['build'], ['ship']]);
  round.edit();
  assert.equal(round.bar(), 'iiip', 'which build an edit is for cannot be told');
  const cards = chat([['build'], ['ask'], ['build'], ['ship']]);
  cards.edit();
  cards.call('mcp__thread__ask_question', { questions: [] });
  assert.equal(cards.bar(), 'cipp');
  cards.edit();
  assert.equal(cards.bar(), 'ippp', 'the card is still out, so the edit is to what it asks about');
  cards.call('mcp__thread__ask_question', { questions: [] });
  cards.turn();
  cards.edit();
  assert.equal(cards.bar(), 'ccip', 'answered: the next build');
});

test('with no build before a card, work goes on beside it', () => {
  const c = chat([['read'], ['ask'], ['build'], ['test']]);
  c.call('mcp__thread__ask_question', { doc: '/x.html' });
  assert.equal(c.bar(), 'cipp');
  c.edit();
  assert.equal(c.bar(), 'ccip');
});

test('a step passed with no sign of work stays open, and a test never jumps a build or review it has not seen', () => {
  const skip = chat([['read'], ['build'], ['test'], ['review'], ['ship']]);
  skip.edit();
  skip.review();
  assert.equal(skip.bar(), 'ccpip', 'the tests were never seen');
  const early = usual();
  early.test();
  assert.equal(early.bar(), 'ipppp', 'a baseline run while reading');
  const c = chat([['build'], ['review'], ['test'], ['ship']]);
  c.edit();
  c.test();
  assert.equal(c.bar(), 'ippp');
});

test('opening the self-review skill is a loose review: nothing is ticked until the reviewer starts, and an edit goes back to build', () => {
  const c = usual();
  c.call('Skill', { skill: 'citadel:self-review' });
  assert.equal(c.bar(), 'ipppp', 'read ahead of time');
  c.edit();
  c.test();
  c.call('Skill', { skill: 'citadel:self-review' });
  assert.equal(c.bar(), 'ciiip');
  c.edit();
  assert.equal(c.bar(), 'cippp');
  c.call('Skill', { skill: 'citadel:self-review' });
  c.review();
  assert.equal(c.bar(), 'cccip');
});

test('a plan with no review step reviews under its tests; a ship card stands for its ask step, else the ship', () => {
  const c = chat([['build'], ['test'], ['ship']]);
  c.edit();
  c.review();
  assert.equal(c.bar(), 'iip');
  c.call('mcp__thread__ask_question', { kind: 'ship', questions: [] });
  assert.equal(c.bar(), 'cci');
  const asks = chat([['build'], ['ask'], ['ship']]);
  asks.edit();
  asks.call('mcp__thread__ask_question', { kind: 'ship', questions: [] });
  assert.equal(asks.bar(), 'cip');
  asks.call('mcp__thread__ask_question', { notice: 'fyi' });
  asks.ship();
  assert.equal(asks.bar(), 'cci');
});

test('a ship sent back by an edit leaves the review ticked', () => {
  const c = usual();
  for (const s of ['edit', 'test', 'review', 'ship', 'turn', 'edit']) c[s]();
  assert.equal(c.bar(), 'cipcp');
  c.ship();
  assert.equal(c.bar()[4], 'i');
});

test("the minion's own status wins for its step", () => {
  const c = chat([['read'], ['build', 'A'], ['build', 'B'], ['test'], ['ship']]);
  c.plan([{ n: 2, status: 'done', outcome: 'A is in' }]);
  c.edit();
  assert.equal(c.bar(), 'ccipp', 'its done step stays done, and the shared stage goes on with the other');
  c.plan([{ n: 4, status: 'doing' }]);
  assert.equal(c.bar()[3], 'i');
  c.plan([{ n: 2, status: 'todo' }]);
  assert.notEqual(c.p.tasks[1].status, 'completed');
  const off = usual();
  off.plan([{ n: 4, status: 'dropped' }]);
  off.edit();
  off.test();
  off.ship();
  assert.equal(off.bar(), 'ccci');
});

test('a new plan in a later turn replaces a tagged one the ship left open; a fixed-up title in the same turn does not', () => {
  const c = usual();
  c.plan([{ n: 1, step: 'Read more' }]);
  assert.equal(c.p.tasks.length, 5);
  c.edit();
  c.ship();
  c.turn();
  c.plan([{ n: 1, step: 'Read it all' }]);
  assert.equal(c.p.tasks.length, 5, 'one title alone is a fix-up in any turn');
  c.turn();
  c.plan([
    { n: 1, step: 'Read all of it' },
    { n: 2, step: 'build' },
  ]);
  assert.equal(c.p.tasks.length, 5, 'and so is one beside a title the plan has');
  c.turn();
  c.plan([
    { n: 1, step: 'Fix what CI found', kind: 'build' },
    { n: 2, step: 'Ship again', kind: 'ship' },
  ]);
  assert.deepEqual(
    c.p.tasks.map((t) => t.subject),
    ['Fix what CI found', 'Ship again'],
  );
  assert.equal(c.bar(), 'ip');
});

test('a plan with no kinds, and a Codex turn’s TodoWrite plan, move only as the minion ticks them', () => {
  const c = chat([['read'], ['build'], ['ship']], { kinds: false });
  c.edit();
  c.test();
  c.ship();
  c.end('complete');
  assert.equal(c.bar(), 'ppp');
  c.plan([
    { n: 1, status: 'done' },
    { n: 2, status: 'doing' },
  ]);
  c.edit();
  assert.equal(c.bar(), 'cip');
  assert.equal(progressLine(c.p, true), 'build… · 1 of 3 done');
  const codex = createProgress();
  applyEvent(codex, 'claude', {
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          id: 't',
          name: 'TodoWrite',
          input: {
            todos: [
              { content: 'Read', status: 'completed' },
              { content: 'Fix', status: 'in_progress' },
            ],
          },
        },
      ],
    },
  });
  applyEvent(codex, 'claude', { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'e', name: 'mcp__thread__hand_off_land', input: {} }] } });
  assert.equal(stepInfo(codex).done, 1);
});

test('a step with no kind among tagged ones is the minion’s to tick; the server moves the rest', () => {
  const c = usual();
  c.plan([{ n: 6, step: 'Tell Josh' }]);
  for (const s of ['edit', 'test', 'review', 'ship']) c[s]();
  assert.equal(c.bar(), 'ccccip');
  c.plan([{ n: 6, status: 'doing' }]);
  assert.equal(c.p.tasks[5].status, 'in_progress');
});

test('a Grunt’s work: its edits are the build, its tests and reviews are its own', () => {
  const c = usual();
  const grunt = { parent_tool_use_id: 'g1' };
  c.test(grunt);
  assert.equal(c.bar(), 'ipppp');
  c.edit(grunt);
  assert.equal(c.bar(), 'cippp');
  c.test(grunt);
  assert.equal(c.bar(), 'cippp');
});

test('close_self and a complete status end the plan; other states leave the step open', () => {
  const c = usual();
  c.edit();
  c.test();
  c.review();
  c.ship();
  c.end('ready');
  assert.equal(c.bar(), 'cccci');
  c.call('mcp__thread__close_self', {});
  assert.equal(c.bar(), 'cccci', 'asked for, not granted yet');
  c.over();
  assert.equal(c.bar(), 'ccccc');
  // A card still out refuses it, and work after it says it stays open.
  for (const after of [(x) => x.call('mcp__thread__ask_question', { questions: [] }), (x) => x.edit(), (x) => x.end('ready')]) {
    const d = chat([['read'], ['build'], ['test'], ['ask']]);
    d.edit();
    d.call('mcp__thread__close_self', {});
    after(d);
    d.over();
    assert.equal(d.bar(), 'cipp');
  }
});

test("a step taken back, or named inside a shared stage, reads as the minion's word says", () => {
  const c = usual();
  c.edit();
  c.test();
  c.plan([{ n: 3, status: 'todo' }]);
  assert.equal(c.bar(), 'cippp', 'back on the step before it');
  c.test();
  assert.equal(c.bar(), 'ciipp', 'and worked on again once its work shows');
  const d = chat([['read'], ['build', 'One'], ['build', 'Two'], ['build', 'Three'], ['test']]);
  d.edit();
  assert.equal(stepName(d.p, true), 'Building, 3 steps');
  d.plan([{ n: 3, status: 'doing' }]);
  d.edit();
  assert.deepEqual([d.bar(), stepName(d.p, true)], ['ciipp', 'Two']);
  d.test();
  assert.deepEqual([d.bar(), stepName(d.p, true)], ['ciiii', 'test']);
  d.edit();
  assert.equal(stepName(d.p, true), 'Building, 3 steps', 'newer work than its word');
});

test('a step with no kind set to doing is the one underway until the next stage shows', () => {
  const c = chat([['read'], ['build'], [undefined, 'Tidy up'], ['test'], ['ship']]);
  c.edit();
  c.plan([{ n: 3, status: 'doing' }]);
  assert.equal(stepName(c.p, true), 'Tidy up');
  c.edit();
  assert.equal(stepName(c.p, true), 'Tidy up', 'its edits are its own');
  c.test();
  assert.equal(stepName(c.p, true), 'test');
  c.ship();
  assert.equal(stepName(c.p, true), 'ship');
});

test('a question mid-work is not the plan’s ask; a card after what is before it is', () => {
  const ask = (c) => c.call('mcp__thread__ask_question', { questions: [] });
  const c = chat([['read'], ['build'], ['test'], ['ask'], ['ship']]);
  ask(c);
  c.edit();
  ask(c);
  assert.equal(c.bar(), 'cippp');
  c.test();
  ask(c);
  assert.equal(c.bar(), 'cccip');
});

test('what a call shows: writes outside scratch folders build, named runners test, the rest says nothing', () => {
  const bash = (command) => workKind({ name: 'Bash', input: { command } });
  for (const cmd of ["cat > src/a.ts <<'E'\nx\nE", "sed -i 's/a/b/' src/a.ts", "python3 - <<'E'\np='src/a.ts'; open(p,'w').write(s)\nE", 'git apply fix.patch', 'echo x >> docs/a.md']) assert.equal(bash(cmd), 'build', cmd);
  for (const cmd of ['npm test', 'cd app && timeout 300 npx vitest run', 'citadel-test test/a.test.ts | tail -5', 'node tools/ui-shot.ts "#/p/1"', 'tools/burn-in.sh test/a.test.ts', 'dotnet test --filter X', 'node --test test/', 'tools/citadel-node --test test/a.test.ts']) assert.equal(bash(cmd), 'test', cmd);
  for (const cmd of ['tools/land.sh', 'gh pr create --fill', 'gh pr merge 5']) assert.equal(bash(cmd), 'ship', cmd);
  for (const cmd of ['gh workflow run flake-proof.yml', 'bash scripts/run_tests.sh', 'node x/screenshot.mjs', 'node tools/shake-check.ts', 'python3 selftest.py']) assert.equal(bash(cmd), 'test', cmd);
  for (const cmd of ['gh pr create --draft --fill', 'gh workflow run deploy.yml', 'bash scripts/checkout.sh', 'node tools/latest-release.ts']) assert.equal(bash(cmd), '', cmd);
  for (const cmd of [
    'rg -n foo src',
    'git commit -qm "npm test"',
    'cat package.json | head',
    "cat > $TMPDIR/a.mjs <<'E'\nx\nE",
    "python3 - <<'E'\nopen('/tmp/a','w').write('x')\nE",
    "python3 - <<'E'\nd=os.environ['TMPDIR']; open(d+'/a','w').write(x)\nE",
    'rg "npm test" > /dev/null',
    "cat >> $TMPDIR/n.md <<'E'\nnpm test\nE",
    'tools/land.sh --help',
  ])
    assert.equal(bash(cmd), '', cmd);
  assert.equal(workKind({ name: 'Write', input: { file_path: '/tmp/x.md' } }), '');
  assert.equal(workKind({ name: 'mcp__thread__propose_plan', input: {} }), 'ask');
  assert.equal(workKind({ name: 'mcp__citadel-test-box-ws__run_task', input: {} }), 'test');
  assert.equal(workKind({ name: 'Agent', input: { subagent_type: 'Explore' } }), '');
});

test("#1918's own calls: the bar is on testing at 00:06 and follows each edit and test run, with its stale ticks left out (#1923)", () => {
  const c = chat([['read'], ['build'], ['build'], ['build'], ['test'], ['ship']]);
  const E = 'edit';
  const T = 'test';
  const skill = 'prep';
  const bar = () => `${c.p.at ? c.p.tasks.find((t) => t.id === c.p.at).kind : ''}`;
  // [time PST, what the calls showed, where the plan is after it]
  const calls = [
    ['23:40', E, 'build'],
    ['23:44', T, 'test'],
    ['23:47', E, 'build'],
    ['23:49', T, 'test'],
    ['23:51', E, 'build'],
    ['23:53', T, 'test'],
    ['23:56', E, 'build'],
    ['00:00', T, 'test'],
    ['00:05', E, 'build'],
    ['00:05', skill, 'test'],
    ['00:13', 'review', 'test'],
    ['00:21', E, 'build'],
    ['00:23', T, 'test'],
    ['01:07', 'card', 'ship'],
  ];
  for (const [when, what, want] of calls) {
    if (what === 'prep') c.call('Skill', { skill: 'citadel:self-review' });
    else if (what === 'card') c.call('mcp__thread__ask_question', { kind: 'ship', questions: [] });
    else c[what]();
    assert.equal(bar(), want, when);
  }
});

test('a call running a minute or more says how long; a finished one does not', () => {
  const block = { type: 'tool_use', name: 'Bash', input: { command: 'npm test', description: 'Run the tests' } };
  assert.equal(runningFor([], T0), '');
  assert.equal(runningFor([{ block, result: null, startedAt: T0 }], T0 + 59_000), '');
  assert.equal(runningFor([{ block, result: null, startedAt: T0 }], T0 + 5.5 * 60_000), '5 min');
  assert.equal(runningFor([{ block, result: { content: 'ok' }, startedAt: T0, doneAt: T0 + 9e5 }], T0 + 1e6), '');
});
