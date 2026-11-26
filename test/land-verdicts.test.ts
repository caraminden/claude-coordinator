// The ship verdicts' test bench (#1484, from the Nov 20 to 21 retro, takeaway 1): every rule in tools/land.sh that
// decides whose ship a CI red belongs to, run on the real reds of those two nights. It loads the very functions land.sh
// runs, cut from tools/land.sh at test time, so a change to one runs here (tools/affected-map.txt maps land.sh to this
// file), and the guard at the end fails when a new function reads CI's log ($failed) without being benched.
//
// Each case is one real run: its log, trimmed (test/fixtures/land-verdicts/README.md), the real ships' commits on main
// for what each changed, and the incident report that says who was really at fault. Only what reaches outside is faked:
// scratch worktrees are folders, and a fake citadel-node fails a test file at the commits the case says it failed at
// (FAILS_AT); everything else (git history, imports, test text, tools/known-flakes.ts) is real. The reports are in the
// shared folder's reports/: incident-2026-11-20-1840-cause.md (1840), incident-2026-11-20-2106-cause.md (2106),
// incident-2026-11-21-0019-cause.md (0019).
//
// New rules run in shadow first (LAND_RULES in land.sh, ADR 0020): each case checks the verdict with the rules as
// shipped, and the rule's own verdict with it switched live.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { tempRoot } from './helpers.ts';
import { landText } from './land-files.ts';

const root = resolve(import.meta.dirname, '..');
const land = landText();
const fixtures = join(root, 'test/fixtures/land-verdicts');
const tmp = tempRoot('land-verdicts-');
after(() => tmp.teardown());

// The functions that judge a red, and the helpers they call. A missing one fails here: rename it here too.
const BENCHED = [
  'cut_off',
  'flake_only',
  'skipped_tests',
  'burn_lines',
  'train_labels',
  'train_real',
  'train_failing',
  'train_main_red',
  'train_suspects_of',
  'rule_on',
  'rule_would',
  'train_guess',
  'train_imports',
  'train_hub',
  'train_label',
  'train_at',
  'known_flakes',
  'train_pin',
  'train_alone',
  'burn_new',
  'has_case',
];
// Functions that read $failed but decide nobody's fault themselves: each says why.
const NOT_VERDICTS: Record<string, string> = {
  train_tail: "cuts a red's log for the rider it refuses",
  ci_failed: 'fetches the log and writes its flake and skipped-test lines',
  ci_gate: 'waits for the run and fetches its log',
  gate: 'calls cut_off, flake_only and known_flakes, benched here',
  smoke: 'the smoke check before the line: one ship alone, its own red',
  train_build: 'builds the train; keeps the last log for a rider it drops',
  train_bisect: 'splits with CI runs: each run decides',
  train_suspects: 'calls train_real, train_pin and train_suspects_of, benched here, then holds or refuses what they name',
  flake_keep: 'calls flake_free and train_suspects_of, benched here',
  flake_free: 'calls flake_only, benched here, and drops a red with leftover processes',
};

function fn(name: string): string {
  const lines = land.split('\n');
  const i = lines.findIndex((l) => l.startsWith(`${name}() {`) || l.startsWith(`${name}() (`));
  assert.ok(i >= 0, `tools/land.sh has no ${name}(): rename it in test/land-verdicts.test.ts's BENCHED too`);
  if (/\}\s*(#.*)?$/.test(lines[i])) return lines[i];
  const end = lines.findIndex((l, j) => j > i && /^[})]$/.test(l));
  return lines.slice(i, end + 1).join('\n');
}
// The rules as shipped: land.sh's own LAND_RULES default.
const shipped = /^: "\$\{LAND_RULES:=([^}]*)\}"$/m.exec(land)?.[1];

const tools = tmp.path('tools');
mkdirSync(tools);
for (const f of ['known-flakes.ts', 'test-alone.sh', 'test-deps.sh']) symlinkSync(join(root, 'tools', f), join(tools, f));
// The fake citadel-node: a test file run alone fails at the commits in FAILS_AT (the scratch worktree's .at says which).
writeFileSync(
  join(tools, 'citadel-node'),
  `#!/usr/bin/env bash
case " $* " in *known-flakes.ts*) exec "$NODE_BIN" "$@" ;; esac
at=$(cat .at)
for c in $FAILS_AT; do [ "$c" != "$at" ] || { echo "✖ fails at $at"; exit 1; }; done
echo "✔ passes at $at"
`,
);
chmodSync(join(tools, 'citadel-node'), 0o755);

const preamble = `set -euo pipefail
say() { printf 'say: %s\\n' "$*" >>"$OUT/log"; }
retro_log() { printf 'retro: %s\\n' "$1" >>"$OUT/log"; }
train_drop() { echo 'drop: the riders go back in line' >>"$OUT/log"; }
train_tell() { :; }
# chg from the real ships: SHIPS[m] is member m's commits on main (0: the front).
train_chg() { local m c; chg=(); for ((m = 0; m <= \${#train_n[@]}; m++)); do chg[m]=$(for c in \${SHIPS[m]:-}; do command git show --name-only --format= "$c"; done | sort -u | grep . || true); done; }
# Scratch worktrees are folders holding the case's red files and the commit in .at, for the fake citadel-node.
seed() { local f; printf '%s\\n' "$2" >"$1/.at"; for f in $RED; do mkdir -p "$1/$(dirname "$f")"; : >"$1/$f"; done; }
git() {
  if [ "$1" = worktree ] && [ "$2" = add ]; then mkdir -p "\${@: -2:1}"; seed "\${@: -2:1}" "\${@: -1}"; return 0; fi
  if [ "$1" = worktree ] && [ "$2" = remove ]; then return 0; fi
  if [ "$1" = -C ] && [ "$3" = checkout ]; then seed "$2" "\${@: -1}"; return 0; fi
  command git "$@"
}
tools=$TOOLS state=$OUT burn_red='' branch=front label=front ci_url=https://example.invalid/run train_n=() train_br=() train_tip=() train_was=()
main_red='' main_red_other='' main_red_mine='' main_red_riders=0
declare -A through_by=() known_by=()
# The guess as land.sh's callers take it: in a process substitution, so a walk that stops early names nobody.
guess() { local hits; mapfile -t hits < <(train_suspects_of "$1"); echo "\${hits[*]}"; }
${BENCHED.map(fn).join('\n')}
`;

type Case = { script: string; red?: string; failsAt?: string; rules?: string; shared?: string };
let n = 0;
function run(c: Case): { out: string; log: string } {
  const out = tmp.path(`run${++n}`);
  mkdirSync(out);
  writeFileSync(join(out, 'log'), '');
  const r = spawnSync('bash', ['-c', `${preamble}\n${c.script}`], {
    cwd: root,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: out,
      OUT: out,
      TOOLS: tools,
      FIX: fixtures,
      NODE_BIN: process.execPath,
      RED: c.red ?? '',
      FAILS_AT: c.failsAt ?? '',
      LAND_RULES: c.rules ?? shipped ?? '',
      COORDINATOR_SHARED_DIR: c.shared ?? '',
      DEPLOY_DB: join(out, 'none.db'),
    },
  });
  assert.equal(r.status, 0, `the bench's bash failed:\n${r.stderr}\n${r.stdout}`);
  return { out: r.stdout, log: readFileSync(join(out, 'log'), 'utf8') };
}
const log = (run: string) => `failed=$(cat "$FIX/${run}.log")`;
// Each ship's commits on main, as each train had them.
const S = {
  1356: 'caa15be4',
  1384: 'b5ee0201',
  1358: 'd327b6ff 932efac3 d862b703',
  1394: '642e3fa9',
  1369: 'b063dd7a',
  1383: '48c03a82',
  1382: '0c3a233c',
  1355: '3e5aa0fd',
  1365: 'e3f0f41d',
  1385: 'ff09fd26 7db26285 96ad1f03',
  1415: 'cbf4d366 e6c5dbc3 982f0b50',
  1366: '13f0f719 143a160c e3bbb05b',
};
// <front> <riders...>: the train's globals, with each member's commits for train_chg.
function train(tip: string, old: string, ...ships: (keyof typeof S)[]): string {
  const [front, ...riders] = ships;
  return [
    `tip=${tip} old=${old} own=own${front} branch=ticket/${front}-x label=ticket/${front}-x`,
    `train_n=(${riders.map((_, i) => i + 2).join(' ')}) train_br=(${riders.map((r) => `ticket/${r}-x`).join(' ')})`,
    `train_tip=(${riders.map((r) => `tip${r}`).join(' ')}) train_was=(${riders.map((r) => `was${r}`).join(' ')})`,
    `SHIPS=(${ships.map((s) => `'${S[s]}'`).join(' ')})`,
  ].join('\n');
}

test('the bench has every commit its cases name (CI checks out with fetch-depth 0)', () => {
  const all = [...Object.values(S).join(' ').split(' '), '4730e151', '3147c858', '3db73c29'];
  const missing = all.filter((c) => spawnSync('git', ['cat-file', '-e', `${c}^{commit}`], { cwd: root }).status !== 0);
  assert.deepEqual(missing, [], 'these commits are missing here: a shallow clone? fetch the history');
});

// A: run 44859457680 (Nov 20 19:07 PST, report 1840): killed at 55 s from outside, "Interrupted while running:", no test
// failed. Before #1377 the bisect counted it red and refused #1290's train. Verdict: none, one fresh run.
test('A: a run killed with no failing test is no verdict', () => {
  const r = run({ script: `${log('44859457680')}\ncut_off && echo cut-off\ntrain_real || echo 'no real failure'` });
  assert.equal(r.out, 'cut-off\nno real failure\n');
  // And a real red is no cut-off: run 44869832060 (report 2106), db-writer failed again alone.
  assert.equal(run({ script: `${log('44869832060')}\ncut_off || echo red` }).out, 'red\n');
});

// B: runs 44884401354 and 44884849606 (Nov 21 00:25 and 00:32 PST, report 0019): status-page red on main's own clock
// (3147c858), and #1414's train of 6 behind it. Before #1430 the suspects refused #1356 and #1378 for it. Verdict: main
// red, nobody refused. Since #1478 (Cara, "Ship through"), the first, whose only failure is main's, ships through main's
// red; the second also has wake-when-live "not rerun", which may be the train's own, so the riders go back in line.
for (const [ci, through] of [
  ['44884401354', true],
  ['44884849606', false],
] as const) {
  test(`B: a red main's tip also fails refuses nobody (run ${ci})`, () => {
    const t = `${log(ci)}\ntip=3147c858 old=3147c858 own=own1414 branch=ticket/1414-x label=ticket/1414-x train_n=(2 3 4 5 6 7) SHIPS=()\ntrain_real`;
    assert.equal(run({ script: t }).out, 'test/status-page.test.ts\n', 'wake-when-live, "not rerun", is no real failure');
    const r = run({ script: `${t} >/dev/null\ntrain_main_red && echo "main red: $main_red, mine: \${main_red_mine:-none}"`, red: 'test/status-page.test.ts', failsAt: '3147c858' });
    assert.equal(r.out, 'main red: test/status-page.test.ts, mine: none\n');
    assert.match(r.log, through ? /ships as green, all 7 ships/ : /none is refused: the 6 riders go back in line/);
    if (through) {
      assert.match(r.log, /SHIPPING THROUGH MAIN'S RED: test\/status-page\.test\.ts/);
      assert.match(r.log, /retro: shipped through main's red/);
    } else {
      assert.match(r.log, /drop: the riders go back in line/);
      assert.match(r.log, /retro: red on main too: not this train's .* also red: test\/wake-when-live\.test\.ts/);
    }
    if (through) {
      // A test skipped too (#1914): not main's red alone, so no ship through it, and still nobody is refused.
      const skip = `failed+=$'\\ntest\\tthe full suite\\t2026-11-21T08:25:00.1Z ℹ skipped 1'`;
      const s = run({ script: `${t} >/dev/null\n${skip}\ntrain_main_red && echo "also: $main_red_other"`, red: 'test/status-page.test.ts', failsAt: '3147c858' });
      assert.equal(s.out, 'also: a skipped test\n');
      assert.doesNotMatch(s.log, /SHIPPING THROUGH/);
    }
    // Green on main: not main's red, so the suspects judge it.
    const g = run({ script: `${t} >/dev/null\ntrain_main_red || echo 'not main'`, red: 'test/status-page.test.ts' });
    assert.equal(g.out, 'not main\n');
  });
}

// C: run 44886957865 (Nov 21 00:53 PST, report 0019): #1385's train with #1415; one-pacific failed again alone, and its
// message names src/standing-checks.ts:314, the file #1415 added; auto-resume passed alone (load). It was #1415's.
// Today's guess misses it: one-pacific imports nothing by a relative path, and the walk stops there before it reads the
// test's text, which names server.ts, which #1415 changed (and #1385 didn't). So no suspects: the bisect. walk fixes it.
const C = `${log('44886957865')}\n${train('96ad1f03', '3db73c29', 1385, 1415)}\ntrain_chg\nrules_say=1`;
test('C: a red only on files a rider changed: that rider', () => {
  assert.equal(run({ script: `${C}\ntrain_real` }).out, 'test/one-pacific.test.ts\n');
  const r = run({ script: `${C}\nguess test/one-pacific.test.ts` });
  assert.equal(r.out, '\n', "today's rules name nobody: the walk stops at a test with no relative imports");
  assert.match(r.log, /retro: would refuse #1415 \(walk\) · test\/one-pacific\.test\.ts/);
  assert.doesNotMatch(r.log, /\(hub\)/, 'one-pacific imports no hub');
  assert.equal(run({ script: `${C}\nguess test/one-pacific.test.ts`, rules: 'walk=live' }).out, '1\n');
});

// D: run 44869832060 (Nov 20 21:13 PST, report 2106): front #1356, riders #1384, #1358, #1394, #1369, #1383, #1382;
// db-writer failed again alone on 'props.propose', which #1356's O2 removed. db-writer imports src/db.ts (a hub: 210
// test files), src/db-writer.ts and src/http.ts; #1369 changed all three, #1356 only src/properties.ts, which src/db.ts
// imports (level 2). The guess held #1369: wrong. Verdict: no suspects from the files, the bisect.
const D = `${log('44869832060')}\n${train('4730e151', '4730e151', 1356, 1384, 1358, 1394, 1369, 1383, 1382)}\ntrain_chg\nrules_say=1`;
test('D: a red reached through a hub file names no suspects: the bisect', () => {
  assert.equal(run({ script: `${D}\ntrain_real` }).out, 'test/db-writer.test.ts\n');
  const r = run({ script: `${D}\nguess test/db-writer.test.ts` });
  assert.equal(r.out, '4\n', "today's rules guess #1369 (member 4), the wrong ship");
  assert.match(r.log, /retro: would spare #1369 \(hub\): no suspects, so the bisect · test\/db-writer\.test\.ts/);
  assert.equal(run({ script: `${D}\nguess test/db-writer.test.ts`, rules: 'hub=live' }).out, '\n');
  // It reproduces alone, so before any guess the pin finds the front, #1356 (#1403): from 21:01 every train had it.
  const pin = run({ script: `${D}\ntip=tip1382\nwt=$(mktemp -d)\ngit worktree add -q --detach "$wt" "$tip"\ntrain_pin test/db-writer.test.ts "$wt"`, red: 'test/db-writer.test.ts', failsAt: 'own1356 tip1384 tip1358 tip1394 tip1369 tip1383 tip1382' });
  assert.equal(pin.out, '0\n');
});
// D2: run 44869305694 (Nov 20 21:06 PST, report 2106): front #1355, riders #1356, #1384, #1365, #1358, #1394; db-writer
// real (#1356's), codex-lock a load flake. Today's guess names #1355 and #1365, both innocent: both are
// pulled (#1918). With hub: no suspects, the bisect.
test('D2: the same red with two wrong guesses: hub would spare both', () => {
  const t = `${log('44869305694')}\n${train('4730e151', '4730e151', 1355, 1356, 1384, 1365, 1358, 1394)}\ntrain_chg\nrules_say=1`;
  assert.equal(run({ script: `${t}\ntrain_real` }).out, 'test/db-writer.test.ts\n', 'codex-lock passed alone');
  // A held round red like this one puts back any held ship with either test (#1403): both count as red.
  assert.equal(run({ script: `${t}\ntrain_failing` }).out, 'test/codex-lock.test.ts\ntest/db-writer.test.ts\n');
  const r = run({ script: `${t}\nguess test/db-writer.test.ts` });
  assert.equal(r.out, '0 3\n');
  assert.match(r.log, /would spare #1355, #1365 \(hub\): no suspects, so the bisect · test\/db-writer\.test\.ts/);
  assert.equal(run({ script: `${t}\nguess test/db-writer.test.ts`, rules: 'hub=live' }).out, '\n');
});

// E: #1366 alone, runs 44882481868 (Nov 21 00:01 PST, citadel-android) and 44888201563 (01:17 PST, auto-resume), report
// 0019; and 44858022381 (Nov 20 18:50 PST, citadel-heavy, #1367's known flake), report 1840. Each failed file passed
// alone, and each had flaked on other ships. Verdict: ship (known flakes, #1419), unless only its own branch saw it.
for (const [ci, file] of [
  ['44882481868', 'test/citadel-android.test.ts'],
  ['44888201563', 'test/auto-resume.test.ts'],
  ['44858022381', 'test/citadel-heavy.test.ts'],
]) {
  test(`E: a flake-only red on known flakes ships (run ${ci})`, () => {
    const shared = tmp.path(`shared-${ci}`);
    const day = new Date().toISOString().slice(0, 10);
    mkdirSync(join(shared, 'retro-log', day), { recursive: true });
    const sighting = (branch: string) => writeFileSync(join(shared, 'retro-log', day, 'land.md'), `# Retro log: land.sh\n\n- 01:00:00Z · flake · ${file} · load 12.0 · ${branch} · in CI\n`);
    const t = `${log(ci)}\ntip=3147c858 old=3147c858 own=3147c858 branch=ticket/1366-x label=ticket/1366-x SHIPS=('${S[1366]}')`;
    assert.equal(run({ script: `${t}\nflake_only` }).out, `${file}\n`);
    sighting('ticket/1300-elsewhere');
    const r = run({ script: `${t}\nknown_flakes "$(flake_only)" && echo "ship: $known_why"`, shared });
    assert.match(r.out, new RegExp(`^ship: ${file.replace(/\./g, '\\.')} \\(`));
    // Seen only on its own branch: not known, so the one fresh run.
    sighting('ticket/1366-x');
    assert.equal(run({ script: `${t}\nknown_flakes "$(flake_only)" || echo 'fresh run'`, shared }).out, 'fresh run\n');
  });
}

// F: run 45549200030 (Nov 24 20:51 PST, #1873): one file passed alone and one test was skipped, and it was read as flakes
// only. tests.yml asked about skips only on a green run. Verdict: red (#1914). Without the skip, the flake it was.
test('F: a red of flakes only that skipped a test is no flake (run 45549200030)', () => {
  const t = log('45549200030');
  assert.equal(run({ script: `${t}\nskipped_tests` }).out, '1\nevery .ts, .js and .mjs file this branch changed is formatted\n');
  assert.equal(run({ script: `${t}\nflake_only || echo red` }).out, 'red\n');
  const none = `${t}\nfailed=$(sed 's/ℹ skipped 1$/ℹ skipped 0/' <<<"$failed")`;
  assert.equal(run({ script: `${none}\nskipped_tests || flake_only` }).out, 'test/machine-lend-cards.test.ts\n');
  // Perigee's own log has no CI prefix: its suite always skips the Biome tests, and that is not CI's skip.
  assert.equal(run({ script: `failed='ℹ skipped 2'\nskipped_tests || echo none` }).out, 'none\n');
});

// G: runs 45714335003 and 45711395598 (Nov 25 14:34 and 14:13 PST, #2019), the stuck train led by #2003. The first was
// red on a case #2003's follow-up added: it is #2003's. The second was red on a case main had since #1563, in a file
// rider #1991 had edited: nobody adds it, so nobody is refused for adding it.
test('G: a burn-in red names the ship that adds the failing case (run 45714335003), and nobody for a case on main (run 45711395598)', () => {
  const t = (run: string) => `${log(run)}\nburn_red=1 old=5cc2a7667 own=4ed8f4fef train_n=(2) train_tip=(4ed8f4fef)`;
  // The follow-up was not on main yet, so which commits have its case is told here.
  const added = `has_case() { [ "$1" != "$old" ] && [ "$2" = test/reader-stall.test.ts ]; }`;
  assert.equal(run({ script: `${t('45714335003')}\n${added}\nburn_new` }).out, '0 test/reader-stall.test.ts\n');
  // Real git: main's front.test.ts already has the case.
  assert.equal(run({ script: `${t('45711395598')}\nburn_new` }).out, '');
  // The log's case was read: had main not had it, the front would be named.
  assert.equal(run({ script: `${t('45711395598')}\nhas_case() { [ "$1" != "$old" ]; }\nburn_new` }).out, '0 test/front.test.ts\n');
});

// A repo of its own: main, ship A adding a case at the top of a large test file, then ship B editing that file.
test("G2: a case is found in a large test file, and one a later ship edits is nobody's for certain (#2019)", () => {
  const t = `cd "$OUT" && command git init -q r && cd r && export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
save() { command git add -A && command git commit -qm "$1" && command git rev-parse HEAD; }
echo main >x && old=$(save main)
{ echo "test('a racy case', f);"; awk 'BEGIN { for (i = 0; i < 20000; i++) print "// padding padding padding" }'; } >big.test.ts && own=$(save A)
echo '// B' >>big.test.ts && b=$(save B)
burn_red=1 failed=$(printf 'test at big.test.ts:1:1\\n✖ a racy case (1ms)\\nburn-in: big.test.ts: failed in 1 of 10 copies at once')`;
  assert.equal(run({ script: `${t}\nhas_case "$own" big.test.ts 'a racy case' && echo found\nhas_case "$old" big.test.ts 'a racy case' || echo absent` }).out, 'found\nabsent\n');
  assert.equal(run({ script: `${t}\ntrain_n=() train_tip=()\nburn_new` }).out, '0 big.test.ts\n');
  assert.equal(run({ script: `${t}\ntrain_n=(2) train_tip=("$b")\nburn_new` }).out, '');
  // A bisect step tested no further than this ship, so the later edit is not in what went red.
  assert.equal(run({ script: `${t}\ntrain_n=(2) train_tip=("$b")\nburn_new 0` }).out, '0 big.test.ts\n');
});

// The guard: a function that reads CI's log decides something about the red, so it is benched or says why not.
test('every function that reads $failed is benched here or says why it decides nobody', () => {
  const names: string[] = [];
  let cur = '';
  for (const l of land.split('\n')) {
    const m = /^([a-z_]+)\(\) [{(]/.exec(l);
    if (m) cur = m[1];
    if (cur && !/^\s*#/.test(l) && /\$failed\b|\$\{failed/.test(l) && !names.includes(cur)) names.push(cur);
  }
  const loose = names.filter((f) => !BENCHED.includes(f) && !(f in NOT_VERDICTS));
  assert.deepEqual(loose, [], 'bench these in test/land-verdicts.test.ts with a real run, or list them in NOT_VERDICTS with why');
  // Listed is not enough: each benched reader runs in a case, called by its script or by a function that is.
  const src = readFileSync(import.meta.filename, 'utf8');
  const cases = src.slice(src.indexOf('// A: run'), src.indexOf('// The guard:'));
  const calls = (text: string, f: string) => new RegExp(`(\\\\n|[^\\w])${f}\\b`).test(text);
  const ran = new Set(BENCHED.filter((f) => calls(cases, f) || (f === 'train_suspects_of' && calls(cases, 'guess'))));
  for (const f of ran) for (const g of BENCHED) if (calls(fn(f), g)) ran.add(g); // a Set's loop visits what it adds
  const idle = names.filter((f) => BENCHED.includes(f) && !ran.has(f));
  assert.deepEqual(idle, [], 'no case calls these: give each a case from a real run');
  assert.ok(shipped, "land.sh's LAND_RULES default line is gone: the bench reads the shipped modes from it");
});
