// Judges (#1503): every registered judge's pinned code matches its last recorded replay, and every place a judge can act
// from (a Taskmaster alert, a kill, a refusal, a hook, a standing check) is either a registered judge or named here as not one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { JUDGES, judged, wouldLine } from '../src/judges.ts';
import { judgeHash, pinHashes, symbolHash, symbolLines } from '../tools/judge-replays/pins.ts';
import { Store, type Ticket } from '../src/db.ts';
import { readRecords } from '../tools/judge-replay.ts';
import { minionsAsOf, replayStore } from '../tools/judge-replays/store.ts';

const ROOT = join(import.meta.dirname, '..');

/** The calls a judge acts through: a Taskmaster's wake or mail, a Mandate alert, a refusal, a kill. */
const ACT = /\b(leaveMail|tellTaskmaster|tellHome|mandateAlert)\(|\brunner\.send\(|\.refuse\(|process\.kill\(/g;

/**
 * Files with act calls that aren't judges, each with why and its count of act calls. A new act call in one of them is red:
 * if it decides on real inputs, register its judge in src/judges.ts (callers), new judges log-only; if not, bump the count.
 */
// Two ships that change an entry merge by rule (count, MERGES in tools/land.local.sh, #1917).
// biome-ignore format: one line per entry is what the merge rule reads
const NOT_JUDGES: Record<string, { why: string; calls: number }> = {
  'server.ts': { why: "wiring: it hands each judge its acts (judged() wraps the registered ones' acts)", calls: 43 },
  'kit/skills/test-quality/scripts/test-overlap.ts': { why: 'an audit script: kills only the test process it started when that file runs past its time limit; judges nothing', calls: 1 },
  'src/exit-with-parent.ts': { why: "kills only its own test server's processes when the parent test exits; judges nothing", calls: 2 },
  'src/worktree-deps.ts': { why: 'stops its own npm install past its time limit; judges nothing', calls: 1 },
  'src/ci-armed.ts': { why: "tellTaskmaster itself and the minion's own message tool", calls: 3 },
  'src/routes/tickets.ts': { why: "messages a minion or person sends on purpose, and tracking notes, and a person's Split first on a start card (#1674)", calls: 11 },
  'src/routes/projects.ts': { why: "tells the Taskmaster a person started a minion; a new scheme's kickoff, a tune-up and a brief a person sent", calls: 4 },
  'src/outbox.ts': { why: "the delivery queue's own interface, and a dropped-delivery note", calls: 4 },
  'src/live-probe.ts': { why: "runs the minion's own check of its ship and wakes that minion on its fail; the minion picked the check, and the trial's stop rule (docs/adr/0030-live-probe-trial.md) counts its wrong fails", calls: 1 },
  'src/land.ts': { why: "tells a minion how its hand_off_land went; land.sh's own verdicts are the land-verdicts judge", calls: 7 },
  'src/backup.ts': { why: "a person's typed message from the backup chat", calls: 1 },
  'src/held-starts.ts': { why: 'delivers a brief held for the box', calls: 1 },
  'src/wake.ts': { why: 'delivers a chained start once its leader is done, and the held brief of a minion taken off its chain (#1823)', calls: 3 },
  'src/schedules.ts': { why: "a schedule's run brief, on the clock a person set", calls: 1 },
  'src/host-tool-ship.ts': { why: 'tells the asking minion a person approved its host tool', calls: 1 },
  'src/make-app.ts': { why: "a new app minion's brief, from a person's make-app", calls: 1 },
  'src/relay.ts': { why: 'relays a Mandate event a person made', calls: 1 },
  'src/routes/contraptions.ts': { why: "an app's deploy notes and a person's ask from an app", calls: 4 },
  'src/routes/files.ts': { why: "a person's comment on a file", calls: 1 },
  'src/routes/machines.ts': { why: 'a minion or message a person started from a machine tile', calls: 2 },
  'src/minion-relay.ts': { why: 'leaveMail itself', calls: 1 },
  'src/rule-parks.ts': { why: "held mail (no wake) after a person's Settings save, listing parks for the Taskmaster to check; it refuses, wakes and stops nothing", calls: 1 },
  'src/exec.ts': { why: 'stops its own child on its own timeout', calls: 2 },
  'src/contraption-turns.ts': { why: "stops its own turn's process", calls: 1 },
  'src/codex-lock.ts': { why: 'signal 0: is a pid alive', calls: 1 },
  'src/tmp-sweep.ts': { why: 'signal 0: is a pid alive', calls: 1 },
  'src/turn-launch.ts': { why: 'signal 0: is a pid alive', calls: 1 },
  'src/fault-points.ts': { why: 'test-only fault injection kills its own process', calls: 1 },
  'tools/dev-copy.ts': { why: 'stops the dev copy it started', calls: 3 },
  'tools/ui-shot.ts': { why: 'stops the dev copy it started', calls: 1 },
  'tools/review-escapes/run.ts': { why: 'stops processes a verifier case left running in its own folder (#1740)', calls: 1 },
  'kit/skills/run-on-windows/scripts/wco/rig.ts': { why: 'stops and pings the rig processes it started', calls: 3 },
  'kit/hooks/run.ts': { why: 'runs the hook scripts', calls: 0 },
  'kit/hooks/hook-input.ts': { why: 'types only: the hook input and transcript lines the hooks read (#1799)', calls: 0 },
  'kit/hooks/heavy-nudge.ts': { why: 'says the citadel-heavy rule when a heavy build runs (the line moved out of the prompt, #1577); judges no work and never blocks', calls: 0 },
  'kit/hooks/retro-log.ts': { why: 'writes the retro log; decides nothing', calls: 0 },
  'kit/hooks/after-compact.sh': { why: 'prints the branch after a compaction; decides nothing', calls: 0 },
  'kit/hooks/hooks.json': { why: 'the hook list itself: each script it runs is checked on its own', calls: 0 },
};

/** The judges as they were at #1503: any other id starts log-only, until a recorded replay says it judges well. */
const AT_1503 = ['deploy-watch', 'flake-counter', 'ci-red', 'ci-runners', 'ci-land-gate', 'ci-numbers', 'land-verdicts', 'tripwire', 'standing-checks', 'stall-signals', 'repeat-bugs', 'decision-copies', 'turn-placement', 'reaper', 'link-check', 'job-check', 'flail-brake', 'grunt-model', 'test-first', 'big-read'];

function codeFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = join(dir, name);
    if (['node_modules', '.git', 'test', 'judge-replays'].includes(name)) continue;
    if (statSync(join(ROOT, rel)).isDirectory()) codeFiles(rel, out);
    else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) out.push(rel);
  }
  return out;
}

const registered = new Set(JUDGES.flatMap((j) => j.callers ?? []));

test('every pinned symbol is found, and every judge with a replay matches its last recorded one', () => {
  const records = readRecords();
  for (const j of JUDGES) {
    for (const [pin, hash] of Object.entries(pinHashes(j, ROOT))) assert.ok(hash, `${j.id}: pin ${pin} isn't found: fix its path or symbol in src/judges.ts`);
    if (j.replay !== true) continue;
    const rec = records[j.id];
    assert.ok(rec, `${j.id} has a replay but none is recorded: run node tools/judge-replay.ts ${j.id} --record`);
    assert.equal(rec.hash, judgeHash(j, ROOT), `${j.name}'s code changed since its last replay (${rec.at}; pinned code: ${j.pins.map((p) => p.path).join(' ')}). Run node tools/judge-replay.ts ${j.id}, read what it would do now beside what it did, then add --record and commit test/judge-replays.json`);
  }
});

test('a new judge starts log-only until it has a recorded replay', () => {
  const records = readRecords();
  for (const j of JUDGES.filter((j) => !AT_1503.includes(j.id))) {
    if (j.mode === 'log-only') continue;
    assert.ok(j.replay === true && records[j.id]?.hash === judgeHash(j, ROOT), `${j.id} is new: start it mode 'log-only', or replay and record it before it acts`);
  }
  assert.equal(new Set(JUDGES.map((j) => j.id)).size, JUDGES.length, 'judge ids are unique');
});

test('every place that acts is a registered judge or named as not one', () => {
  const counts = new Map<string, number>();
  for (const f of ['server.ts', ...codeFiles('src'), ...codeFiles('tools'), ...codeFiles('kit')]) {
    const n = readFileSync(join(ROOT, f), 'utf8').match(ACT)?.length ?? 0;
    if (n) counts.set(f, n);
  }
  for (const [f, n] of counts) {
    if (registered.has(f)) continue;
    assert.ok(NOT_JUDGES[f], `${f} acts (${n} call${n === 1 ? '' : 's'} like leaveMail, runner.send, tellTaskmaster, .refuse or process.kill) and isn't a judge in src/judges.ts: register it (new judges start log-only), or add it to NOT_JUDGES in this test with why it isn't one`);
    assert.equal(n, NOT_JUDGES[f].calls, `${f}'s act calls went from ${NOT_JUDGES[f].calls} to ${n}: a new one that decides on real inputs is a judge, so register it in src/judges.ts; else set the count here`);
  }
  for (const [f, { calls }] of Object.entries(NOT_JUDGES)) {
    if (calls) assert.ok(counts.has(f), `${f} no longer acts: drop it from NOT_JUDGES`);
    assert.ok(!registered.has(f), `${f} is both a judge's caller and in NOT_JUDGES`);
  }
});

test('every hook is a registered judge or named as not one', () => {
  for (const name of readdirSync(join(ROOT, 'kit/hooks'))) {
    const f = `kit/hooks/${name}`;
    assert.ok(registered.has(f) || NOT_JUDGES[f], `${f} is a hook that isn't in src/judges.ts: a hook that blocks or nudges is a judge (register it, log-only), else add it to NOT_JUDGES here`);
  }
  const hooks = readFileSync(join(ROOT, 'kit/hooks/hooks.json'), 'utf8');
  for (const script of new Set(hooks.match(/hooks\/[\w.-]+\.(?:ts|sh)/g) ?? [])) {
    assert.ok(registered.has(`kit/${script}`) || NOT_JUDGES[`kit/${script}`], `hooks.json runs kit/${script}, which isn't in src/judges.ts`);
  }
});

test('every standing check is registered', () => {
  const src = readFileSync(join(ROOT, 'src/standing-checks.ts'), 'utf8');
  const checks = symbolLines(src, 'CHECKS')!
    .join('\n')
    .match(/^ {4}name: '([\w-]+)'/gm)!
    .map((l) => l.split("'")[1]);
  assert.ok(checks.length >= 8, 'found the CHECKS names');
  for (const c of checks) assert.ok(registered.has(`standing-check:${c}`), `standing check ${c} isn't in src/judges.ts: add standing-check:${c} to the standing-checks judge's callers`);
  for (const c of registered) if (c.startsWith('standing-check:')) assert.ok(checks.includes(c.slice(15)), `${c} is registered but no such check exists`);
});

test('every registered caller is a real file', () => {
  for (const c of registered) if (!c.startsWith('standing-check:')) assert.ok(statSync(join(ROOT, c), { throwIfNoEntry: false }), `${c} is a judge's caller but doesn't exist`);
});

test('a symbol pin covers its body and ignores comments and indent', () => {
  const src = `export const A = 3;\n// a\nexport class C {\n  private x = 1;\n  async go(n: number) {\n    // why\n    return n + A;\n  }\n}\nfunction f() {\n  return 1;\n}\n`;
  assert.deepEqual(symbolLines(src, 'C.go'), ['  async go(n: number) {', '    // why', '    return n + A;', '  }']);
  assert.deepEqual(symbolLines(src, 'f'), ['function f() {', '  return 1;', '}']);
  assert.equal(symbolLines(src, 'C.nope'), null);
  assert.equal(symbolHash(src, 'C.go'), symbolHash(src.replace('// why', '// another why').replace('    return', '      return'), 'C.go'));
  assert.notEqual(symbolHash(src, 'C.go'), symbolHash(src.replace('n + A', 'n - A'), 'C.go'));
  assert.equal(symbolHash(src, 'f'), symbolHash(src.replace('n + A', 'n - A'), 'f'), 'a change elsewhere leaves the pin alone');
});

test('judged(): log-only notes what it would do and acts not; act passes the act through', () => {
  const done: string[] = [];
  const notes: [string, string][] = [];
  const act = (who: string, text: string) => (done.push(`${who}:${text}`), true);
  const quiet = judged(
    'deploy-watch',
    'mail',
    act,
    () => false,
    (line, who) => notes.push([line, who]),
    'log-only',
  );
  assert.equal(quiet('tm', 'deploy got worse'), false);
  assert.deepEqual(done, []);
  assert.equal(notes.length, 1);
  assert.equal(notes[0][1], 'tm', "the note gets the act's arguments, to find its scheme");
  assert.match(notes[0][0], /^- \d\d:\d\d:\d\dZ · would · deploy-watch · mail · tm · deploy got worse$/);
  assert.equal(
    judged(
      'deploy-watch',
      'mail',
      act,
      () => false,
      () => {},
      'act',
    ),
    act,
  );
  assert.throws(() => judged('no-such-judge', 'x', act, act, () => {}), /no judge no-such-judge/);
  assert.match(wouldLine('a', 'b', 'two\n lines', 0), /· two lines$/);
});

test('a replay store reads the real database, keeps its own writes, and shows minions as they were', () => {
  const dir = mkdtempSync(join(tmpdir(), 'judges-'));
  try {
    const path = join(dir, 'coordinator.db');
    const real = new Store(path);
    const p = real.createProject('Replayed', null);
    const who = real.createUser({ name: 'Cara', login: 'cara' });
    const t = (title: string) => real.createTicket({ project_id: p.id, title, permission_mode: 'default', created_by: who.id });
    const early = t('made at 100, closed at 300');
    const late = t('made at 500');
    real.db.prepare("UPDATE tickets SET created_at = 100, closed_at = 300, status = 'closed' WHERE id = ?").run(early.id);
    real.db.prepare('UPDATE tickets SET created_at = 500 WHERE id = ?').run(late.id);
    real.setSetting('kept', 1);
    real.db.close();

    const store = replayStore(path, ['settings'], { settings: '' });
    let now = 200;
    const fake = { id: -1, project_id: p.id, title: 'replay started it', status: 'new' } as Ticket;
    minionsAsOf(store, () => now, [fake]);
    assert.deepEqual(
      store.listTickets(p.id).map((x) => [x.id, x.status]),
      [
        [-1, 'new'],
        [early.id, 'working'],
      ],
      'at 200: the early one still open, the late one not made',
    );
    now = 400;
    assert.deepEqual(
      store.listTickets(p.id).map((x) => x.id),
      [-1, early.id],
    );
    assert.equal(store.getTicket(early.id)?.status, 'closed');
    assert.equal(store.getTicket(late.id), undefined);
    now = 600;
    assert.ok(store.listTickets(p.id).some((x) => x.id === late.id));

    assert.equal(store.getSetting('kept'), 1, 'seeded from the real table');
    store.setSetting('replayed', 2);
    assert.equal(store.getSetting('replayed'), 2);
    assert.throws(() => store.db.exec("UPDATE tickets SET title = 'x'"), /readonly/i, 'a table it does not shadow cannot be written');
    store.db.close();
    const after = new Store(path);
    assert.equal(after.getSetting('replayed'), null, 'nothing reached the real file');
    after.db.close();
  } finally {
    // timing-ok: own temp dir
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recorded replays are only for registered judges with replays', () => {
  for (const id of Object.keys(readRecords())) assert.equal(JUDGES.find((j) => j.id === id)?.replay, true, `test/judge-replays.json has ${id}, which has no replay`);
  assert.ok(relative(ROOT, join(ROOT, 'test/judge-replays.json')));
});
