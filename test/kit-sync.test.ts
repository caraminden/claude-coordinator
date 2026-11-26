// The kit sync's git side (#1100): which kit version a scheme's copy came from, and the 3-way merge that keeps the
// scheme's own edits while the kit's change comes in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { until } from './wait.ts';
import { spawnSync } from 'node:child_process';
import { type KitSyncDeps, type KitSyncState, byHandNote, CHECK_SCRIPT, dupCaseLabels, git, KIT_FILES, lineDistance, merge3, pickBase, planScheme, schemeRepos, templateHistory, TRAILER } from '../src/kit-sync.ts';

const ID = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false'];
const LAND = KIT_FILES[0];
const GUARD = KIT_FILES[1];

function repo(root: string, name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  return dir;
}
function commit(dir: string, files: Record<string, string>, msg: string): string {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), text);
  }
  git(dir, ['add', '-A']);
  git(dir, [...ID, 'commit', '-q', '-m', msg]);
  return git(dir, ['rev-parse', 'HEAD']).trim();
}
const lines = (n: number, tag = '') => Array.from({ length: n }, (_, i) => `line ${i}${tag}`).join('\n') + '\n';
const edit = (text: string, i: number, to: string) =>
  text
    .split('\n')
    .map((l, j) => (j === i ? to : l))
    .join('\n');

/**
 * A round's temp root holds the schemes' worktrees and the jobs' folders, and a check or ship job writes there until its
 * process exits (its output.log and exit code land last), so teardown waits for the jobs: deleting the tree under a live
 * one made this file fail with ENOTEMPTY in loaded runs (#1687).
 */
async function tidy(jobs: { running(): number }, root: string) {
  await until('the sync jobs to end', () => jobs.running() === 0);
  rmSync(root, { recursive: true, force: true });
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'kit-sync-test-'));
  const kit = repo(root, 'kit');
  const v1 = lines(40);
  const g1 = lines(30, ' guard');
  const c1 = commit(kit, { [LAND.template]: v1, [GUARD.template]: g1 }, 'v1');
  const v2 = edit(v1, 5, 'line 5 kit fix');
  const c2 = commit(kit, { [LAND.template]: v2 }, 'v2');
  return { root, kit, v1, v2, g1, c1, c2, done: () => rmSync(root, { recursive: true, force: true }) };
}

test('a copy that is a past version byte for byte takes that version as its base', () => {
  const f = fixture();
  try {
    const s = repo(f.root, 'scheme');
    commit(s, { [LAND.path]: f.v1 }, 'setup');
    const base = pickBase(f.kit, templateHistory(f.kit, 'HEAD', LAND.template), s, 'HEAD', LAND);
    assert.deepEqual(base && { commit: base.commit, how: base.how }, { commit: f.c1, how: 'exact' });
  } finally {
    f.done();
  }
});

test("an adapted copy's base is the closest past version, and the merge keeps the scheme's edit", () => {
  const f = fixture();
  try {
    const s = repo(f.root, 'scheme');
    // Adapted at setup from v1: its own line 30, which the kit never changes.
    const ours = edit(f.v1, 30, 'line 30 this scheme only');
    commit(s, { [LAND.path]: ours, [GUARD.path]: f.g1 }, 'setup');
    const [land, guard] = planScheme(f.kit, 'HEAD', { [LAND.template]: templateHistory(f.kit, 'HEAD', LAND.template) }, s);
    assert.equal(land.base, 'closest');
    assert.equal(land.status, 'merged');
    assert.equal(land.text, edit(f.v2, 30, 'line 30 this scheme only'));
    assert.equal(guard.status, 'same', 'a copy equal to the template is nothing to do');
  } finally {
    f.done();
  }
});

test('the Kit-Sync trailer names the base, so a kit change the scheme undid on purpose after a sync stays undone', () => {
  const f = fixture();
  try {
    const s = repo(f.root, 'scheme');
    commit(s, { [LAND.path]: f.v2 }, `sync\n\n${TRAILER}: ${f.c2}`);
    // Undone by hand after the sync: the file is v1 again, byte for byte, which an exact match would take as its base.
    commit(s, { [LAND.path]: f.v1 }, 'we do not want the line 5 fix');
    const history = templateHistory(f.kit, 'HEAD', LAND.template);
    const base = pickBase(f.kit, history, s, 'HEAD', LAND);
    assert.deepEqual(base && { commit: base.commit, how: base.how }, { commit: f.c2, how: 'trailer' });
    const v3 = edit(f.v2, 20, 'line 20 newer kit fix');
    commit(f.kit, { [LAND.template]: v3 }, 'v3');
    const [land] = planScheme(f.kit, 'HEAD', { [LAND.template]: templateHistory(f.kit, 'HEAD', LAND.template) }, s);
    assert.equal(land.text, edit(f.v1, 20, 'line 20 newer kit fix'));
  } finally {
    f.done();
  }
});

test('a trailer base keeps an edit to the very lines the kit changed, since that change is already in', () => {
  const f = fixture();
  try {
    const s = repo(f.root, 'scheme');
    const ours = edit(f.v2, 5, 'line 5 our own take on the kit fix');
    commit(s, { [LAND.path]: ours }, `sync\n\n${TRAILER}: ${f.c2}`);
    const v3 = edit(f.v2, 20, 'line 20 newer kit fix');
    commit(f.kit, { [LAND.template]: v3 }, 'v3');
    const [land] = planScheme(f.kit, 'HEAD', { [LAND.template]: templateHistory(f.kit, 'HEAD', LAND.template) }, s);
    assert.equal(land.base, 'trailer');
    assert.equal(land.text, edit(v3, 5, 'line 5 our own take on the kit fix'));
  } finally {
    f.done();
  }
});

test('the scheme and the kit changing the same lines is a conflict, with no text to commit', () => {
  const f = fixture();
  try {
    const s = repo(f.root, 'scheme');
    commit(s, { [LAND.path]: edit(f.v1, 5, 'line 5 the scheme went its own way') }, 'setup');
    const [land] = planScheme(f.kit, 'HEAD', { [LAND.template]: templateHistory(f.kit, 'HEAD', LAND.template) }, s);
    assert.equal(land.status, 'conflict');
    assert.equal(land.text, undefined);
  } finally {
    f.done();
  }
});

test('a file the scheme does not have is left alone, and the repo holding the templates is no scheme', () => {
  const f = fixture();
  try {
    const projects = join(f.root, 'projects');
    const s = repo(projects, '3/repo');
    commit(s, { [LAND.path]: f.v1 }, 'setup');
    const own = repo(projects, '2/repo');
    commit(own, { [LAND.template]: f.v2, [LAND.path]: 'its own\n' }, 'citadel');
    mkdirSync(join(projects, '4'), { recursive: true });
    assert.deepEqual(
      schemeRepos(projects, [2, 3, 4]).map((r) => r.project),
      [3],
    );
    const plan = planScheme(f.kit, 'HEAD', { [LAND.template]: templateHistory(f.kit, 'HEAD', LAND.template) }, s);
    assert.deepEqual(
      plan.map((p) => p.status),
      ['merged', 'missing', 'missing', 'missing'],
    );
  } finally {
    f.done();
  }
});

test('merge3 and lineDistance on their own', () => {
  assert.deepEqual(merge3('a\nB\nc\nd\ne\n', 'a\nb\nc\nd\ne\n', 'a\nb\nc\nd\nE\n'), { text: 'a\nB\nc\nd\nE\n', conflict: false });
  assert.equal(merge3('a\nX\nc\n', 'a\nb\nc\n', 'a\nY\nc\n').conflict, true);
  assert.equal(lineDistance('a\nb\n', 'a\nb\n'), 0);
  assert.equal(lineDistance('a\nb\n', 'a\nc\n'), 2);
});

// A whole round on fixture repos (#1100's done-when): one green scheme, one red, one green the go's login can't push to.
test('a round: one Citadel card, a failure note in the red scheme, a ship as the clicker, and a card of its own where it cannot push', async () => {
  const { HostJobs } = await import('../src/host-job.ts');
  const { KitSync, SHIP } = await import('../src/kit-sync.ts');
  const root = mkdtempSync(join(tmpdir(), 'kit-sync-round-'));
  const jobs = new HostJobs(() => false);
  try {
    const kit = repo(root, 'kit');
    // The fake land.sh records what it was asked to ship, as whom.
    const land1 = '#!/usr/bin/env bash\n# v1\necho "$(git rev-parse HEAD) $KIT_TEST_WHO" >>"$KIT_TEST_LOG"\n';
    commit(kit, { [LAND.template]: land1 }, 'v1');
    const projectsDir = join(root, 'projects');
    for (const [n, smoke] of [
      [3, 'true'],
      [4, 'echo the check broke; exit 3'],
      [5, 'true'],
    ] as const) {
      const s = repo(projectsDir, `${n}/repo`);
      commit(s, { [LAND.path]: land1, 'tools/land.local.sh': `SMOKE_CMD='${smoke}'\n` }, 'setup');
      git(s, ['update-index', '--chmod=+x', LAND.path]);
      git(s, [...ID, 'commit', '-q', '-m', 'exec']);
    }
    const kitHead = commit(kit, { [LAND.template]: land1.replace('# v1', '# v2: a kit fix') }, 'v2');
    const log = join(root, 'shipped.log');
    writeFileSync(log, '');
    let saved: KitSyncState | undefined;
    const cards: { ticket: number; card: Parameters<KitSyncDeps['postCard']>[1] }[] = [];
    const mails: [number, string][] = [];
    const notes: [number, string][] = [];
    const ks = new KitSync({
      kitDir: kit,
      projectsDir,
      runDir: join(root, 'run'),
      jobs,
      load: () => saved && JSON.parse(JSON.stringify(saved)),
      save: (s) => (saved = s),
      projects: () => [
        { id: 2, name: 'Citadel' },
        { id: 3, name: 'Green' },
        { id: 4, name: 'Red' },
        { id: 5, name: 'Elsewhere' },
      ],
      home: () => 2,
      chat: async (p) => 100 + p,
      env: (person) => ({ PATH: process.env.PATH!, HOME: process.env.HOME!, KIT_TEST_LOG: log, KIT_TEST_WHO: String(person) }),
      canPush: async (dir) => !dir.includes('/5/'),
      postCard: (ticket, card) => (cards.push({ ticket, card }), `q${cards.length}`),
      settle: () => {},
      note: (t, text) => notes.push([t, text]),
      mail: (t, text) => mails.push([t, text]),
    });
    const polled = (what: string, ok: () => boolean) => until(what, async () => (await ks.poll(), ok()), 10_000);
    await polled('the checks end and the card is posted', () => cards.length > 0);
    const states = () => Object.fromEntries(saved!.round!.schemes.map((x) => [x.name, x.state]));
    assert.deepEqual(states(), { Green: 'green', Red: 'red', Elsewhere: 'green' });
    assert.equal(saved!.round!.kit, kitHead);
    assert.deepEqual(
      cards.map((c) => [c.ticket, c.card.kind, c.card.kitSync]),
      [[102, 'merge', kitHead]],
    );
    assert.match(cards[0].card.questions[0].question, /Check failed \(its Taskmaster has the output\): Red\./);
    assert.deepEqual(
      mails.map(([t]) => t),
      [104],
    );
    assert.match(mails[0][1], /fails this scheme's check \(exit 3\)[\s\S]*the check broke/);

    await ks.poll();
    assert.equal(cards.length, 1, 'polling again posts no second card');
    await ks.decide({ ticket: 102, question: 'q1' }, SHIP, { id: 7, name: 'josh' });
    await polled('the green scheme ships', () => states().Green === 'shipped');
    const synced = saved!.round!.schemes.find((x) => x.name === 'Green')!.commit!;
    assert.equal(git(join(projectsDir, '3/repo'), ['branch', '--list', 'kit-sync/*']).trim(), '', 'a shipped sync leaves no branch behind');
    assert.equal(git(join(projectsDir, '3/repo'), ['log', '-1', '--format=%(trailers:key=Kit-Sync,valueonly)', synced]).trim(), kitHead);
    assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), [`${synced} 7`], 'land.sh ran once, on the sync commit, as the clicker');
    assert.equal(states().Elsewhere, 'elsewhere');
    assert.deepEqual(
      cards.map((c) => c.ticket),
      [102, 105],
      'the scheme it cannot push to gets its own card',
    );
    assert.ok(mails.some(([t, text]) => t === 105 && /couldn't push to this repo/.test(text)));
    assert.ok(notes.some(([t, text]) => t === 102 && /Green shipped/.test(text)));
    await assert.rejects(ks.decide({ ticket: 102, question: 'q1' }, SHIP, { id: 7, name: 'josh' }), /no longer waiting/);
  } finally {
    await tidy(jobs, root);
  }
});

test("a round waits out a deploy's unchecked window, a running check keeps its round, and land.sh's own CHECK runs where land.local.sh is missing", async () => {
  const { HostJobs } = await import('../src/host-job.ts');
  const { KitSync } = await import('../src/kit-sync.ts');
  const root = mkdtempSync(join(tmpdir(), 'kit-sync-wait-'));
  const jobs = new HostJobs(() => false);
  try {
    const kit = repo(root, 'kit');
    const land1 = "#!/usr/bin/env bash\n# v1\nCHECK='echo the default check ran; exit 4'\n";
    commit(kit, { [LAND.template]: land1 }, 'v1');
    const projectsDir = join(root, 'projects');
    const gate = join(root, 'gate');
    const gated = repo(projectsDir, '3/repo');
    commit(gated, { [LAND.path]: land1, 'tools/land.local.sh': `SMOKE_CMD='until [ -e ${gate} ]; do sleep 0.05; done'\n` }, 'setup');
    commit(repo(projectsDir, '4/repo'), { [LAND.path]: land1 }, 'setup, with no land.local.sh');
    const v2 = commit(kit, { [LAND.template]: land1.replace('# v1', '# v2') }, 'v2');
    let saved: KitSyncState | undefined;
    const cards: { ticket: number; card: Parameters<KitSyncDeps['postCard']>[1] }[] = [];
    const mails: [number, string][] = [];
    const ks = new KitSync({
      kitDir: kit,
      projectsDir,
      runDir: join(root, 'run'),
      jobs,
      load: () => saved && JSON.parse(JSON.stringify(saved)),
      save: (s) => (saved = s),
      projects: () => [
        { id: 3, name: 'Gated' },
        { id: 4, name: 'Bare' },
      ],
      home: () => 2,
      chat: async (p) => 100 + p,
      env: () => ({ PATH: process.env.PATH!, HOME: process.env.HOME! }),
      canPush: async () => true,
      postCard: (ticket, card) => (cards.push({ ticket, card }), `q${cards.length}`),
      settle: () => {},
      note: () => {},
      mail: (t, text) => mails.push([t, text]),
    });
    const states = () => Object.fromEntries(saved!.round!.schemes.map((x) => [x.name, x.state]));
    const polled = (what: string, ok: () => boolean) => until(what, async () => (await ks.poll(), ok()));

    mkdirSync(join(kit, '.git', 'cc-deploy'));
    writeFileSync(join(kit, '.git', 'cc-deploy', 'unchecked'), 'prev\n');
    await ks.poll();
    assert.equal(saved, undefined, 'no round while deploy.sh has not finished checking the checkout');
    rmSync(join(kit, '.git', 'cc-deploy', 'unchecked'));

    await ks.poll();
    assert.equal(saved!.round!.kit, v2);
    await polled("the bare scheme's check to end", () => states().Bare !== 'checking');
    assert.equal(states().Bare, 'red');
    assert.match(mails.find(([t]) => t === 104)![1], /exit 4[\s\S]*the default check ran/);

    const v3 = commit(kit, { [LAND.template]: land1.replace('# v1', '# v3') }, 'v3');
    await ks.poll();
    assert.equal(saved!.round!.kit, v2, 'a newer kit change waits for the running check');
    assert.equal(states().Gated, 'checking');

    writeFileSync(gate, '');
    await polled("the gated scheme's check to end", () => saved!.round!.kit !== v2);
    assert.equal(saved!.round!.kit, v3, 'once the check ended, the newer change starts its own round');
  } finally {
    await tidy(jobs, root);
  }
});

// The pre-card check's guard step: when the self-test fails, it also runs main's guard, so a failure that main has too
// points at the scheme's own guard section, not the kit (#1547: Mandate's `..` through a slot link).
const FAILING = '#!/bin/bash\necho "FAIL: wanted 2, got 0: ls ~/apps/x/../mandate"\nexit 1\n';
const PASSING = '#!/bin/bash\nexit 0\n';
function checkGuard(mainGuard: string, syncGuard: string) {
  const root = mkdtempSync(join(tmpdir(), 'kit-sync-check-'));
  try {
    const dir = repo(root, 'scheme');
    commit(dir, { 'tools/land.sh': '#!/bin/bash\nCHECK=true\n', 'tools/guard.sh': mainGuard }, 'main');
    commit(dir, { 'tools/guard.sh': syncGuard + '# sync\n' }, 'sync');
    git(dir, ['update-index', '--chmod=+x', 'tools/guard.sh']);
    spawnSync('chmod', ['+x', join(dir, 'tools/guard.sh')]);
    const r = spawnSync('bash', ['-c', CHECK_SCRIPT], { cwd: dir, env: { ...process.env, KIT_SYNC_GUARD: '1' }, encoding: 'utf8' });
    return { code: r.status, out: r.stdout + r.stderr };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
test('a guard self-test that fails on main too says so and names the failing case', () => {
  const r = checkGuard(FAILING, FAILING);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /main fails it too/);
  assert.match(r.out, /FAIL: wanted 2, got 0: ls ~\/apps\/x\/\.\.\/mandate/);
});
test('a guard self-test that fails only on the sync does not say main fails it', () => {
  const r = checkGuard(PASSING, FAILING);
  assert.notEqual(r.code, 0);
  assert.doesNotMatch(r.out, /main fails it too/);
});

test('a byte copy of the newest kit version is its own base, though only an older trailer is in the log (#1730)', () => {
  const f = fixture();
  try {
    const s = repo(f.root, 'scheme');
    commit(s, { [LAND.path]: f.v1 }, `old machine sync\n\n${TRAILER}: ${f.c1}`);
    // A hand sync: byte-equal to v2, with the trailer in a paragraph of its own, so git reads no trailer from it.
    commit(s, { [LAND.path]: f.v2 }, `hand sync\n\n${TRAILER}: ${f.c2}\n\nCo-Authored-By: X <x@example.com>`);
    const base = pickBase(f.kit, templateHistory(f.kit, 'HEAD', LAND.template), s, 'HEAD', LAND);
    assert.deepEqual(base && { commit: base.commit, how: base.how }, { commit: f.c2, how: 'exact' });
  } finally {
    f.done();
  }
});

test('a Kit-Sync line outside the last paragraph is found by a body grep when the copy is not an exact version (#1730)', () => {
  const f = fixture();
  try {
    const s = repo(f.root, 'scheme');
    commit(s, { [LAND.path]: edit(f.v2, 30, 'ours') }, `hand sync\n\n${TRAILER}: ${f.c2}\n\nCo-Authored-By: X <x@example.com>`);
    const base = pickBase(f.kit, templateHistory(f.kit, 'HEAD', LAND.template), s, 'HEAD', LAND);
    assert.deepEqual(base && { commit: base.commit, how: base.how }, { commit: f.c2, how: 'trailer' });
  } finally {
    f.done();
  }
});

// ---- #1769: a clean merge that leaves two arms of one case, and the note a clash sends ----------------------------

const CASE_BASE = ['#!/usr/bin/env bash', 'case "$1" in', '  a) echo a ;;', ...Array.from({ length: 12 }, (_, i) => `  # filler ${i}`), '  *) echo other ;;', 'esac', ''].join('\n');
const withArm = (text: string, after: string, arm: string) => text.replace(after, `${after}\n${arm}`);

test('a clean merge that leaves two arms with one label in a case is a conflict naming the label', () => {
  const f = fixture();
  try {
    const base = CASE_BASE;
    const ours = withArm(base, '  a) echo a ;;', '  files) echo scheme block ;;');
    const theirs = withArm(base, '  # filler 11', '  files) echo kit block ;;');
    assert.equal(merge3(ours, base, theirs).conflict, false, 'git merge-file takes both');
    commit(f.kit, { [GUARD.template]: base }, 'guard base');
    const s = repo(f.root, 'scheme');
    commit(s, { [GUARD.path]: ours }, `sync\n\n${TRAILER}: ${git(f.kit, ['rev-parse', 'HEAD']).trim()}`);
    commit(f.kit, { [GUARD.template]: theirs }, 'guard v2');
    const g = planScheme(f.kit, 'HEAD', { [GUARD.template]: templateHistory(f.kit, 'HEAD', GUARD.template) }, s).find((p) => p.path === GUARD.path)!;
    assert.equal(g.status, 'conflict');
    assert.deepEqual(g.dupes, ['files']);
    assert.equal(g.text, undefined);
  } finally {
    f.done();
  }
});

test('a label the scheme already had twice does not turn a clean merge into a conflict', () => {
  const f = fixture();
  try {
    const base = withArm(CASE_BASE, '  a) echo a ;;', '  a) echo dead arm ;;');
    const ours = base.replace('# filler 0', '# scheme filler');
    const theirs = base.replace('# filler 11', '# filler eleven');
    commit(f.kit, { [GUARD.template]: base }, 'guard base');
    const s = repo(f.root, 'scheme');
    commit(s, { [GUARD.path]: ours }, `sync\n\n${TRAILER}: ${git(f.kit, ['rev-parse', 'HEAD']).trim()}`);
    commit(f.kit, { [GUARD.template]: theirs }, 'guard v2');
    const g = planScheme(f.kit, 'HEAD', { [GUARD.template]: templateHistory(f.kit, 'HEAD', GUARD.template) }, s).find((p) => p.path === GUARD.path)!;
    assert.equal(g.status, 'merged');
  } finally {
    f.done();
  }
});

test('the by-hand note gives the template diff between the last sync and the kit, the 2-minute self-test, npm ci and the labels', () => {
  const note = byHandNote('/kit/repo', 'f'.repeat(40), [
    { path: GUARD.path, status: 'conflict', base: 'trailer', baseCommit: 'a'.repeat(40), dupes: ['files'] },
    { path: LAND.path, status: 'conflict' },
  ]);
  assert.ok(note.includes(`git -C /kit/repo diff ${'a'.repeat(7)} ${'f'.repeat(7)} -- ${GUARD.template}`), note);
  assert.match(note, /last "Kit-Sync" trailer[\s\S]*land\.sh/);
  assert.match(note, /case label[\s\S]*files/);
  assert.match(note, /--self-test[\s\S]*2 minutes[\s\S]*background/);
  assert.match(note, /npm ci/);
  assert.match(note, new RegExp(`${TRAILER}: ${'f'.repeat(40)}`));
});

test('a case line with a trailing comment still opens a case', () => {
  assert.deepEqual(dupCaseLabels('case "$1" in # kinds\n  a) : ;;\n  a) : ;;\nesac\n'), ['a']);
  assert.deepEqual(dupCaseLabels('case "$1" in # outer\n  a) case "$2" in # inner\n  *) : ;;\nesac ;;\n  *) : ;;\nesac\n'), []);
});

test("a round is saved as each scheme's check starts, so a restart mid-round finds the checks that run (ME2)", async () => {
  const { HostJobs } = await import('../src/host-job.ts');
  const { KitSync } = await import('../src/kit-sync.ts');
  const root = mkdtempSync(join(tmpdir(), 'kit-sync-save-'));
  const jobs = new HostJobs(() => false);
  try {
    const kit = repo(root, 'kit');
    const land1 = "#!/usr/bin/env bash\n# v1\nCHECK='true'\n";
    commit(kit, { [LAND.template]: land1 }, 'v1');
    const projectsDir = join(root, 'projects');
    commit(repo(projectsDir, '3/repo'), { [LAND.path]: land1 }, 'setup');
    commit(repo(projectsDir, '4/repo'), { [LAND.path]: land1 }, 'setup');
    commit(kit, { [LAND.template]: land1.replace('# v1', '# v2') }, 'v2');
    type Saved = { round?: { schemes: { name: string; state: string }[] } };
    let saved: Saved | undefined;
    const seen: string[][] = [];
    const watching = { start: (o: Parameters<typeof jobs.start>[0]) => (seen.push((saved?.round?.schemes ?? []).map((x) => `${x.name}:${x.state}`)), jobs.start(o)), state: jobs.state.bind(jobs) };
    const ks = new KitSync({
      kitDir: kit,
      projectsDir,
      runDir: join(root, 'run'),
      jobs: watching,
      load: () => saved && JSON.parse(JSON.stringify(saved)),
      save: (s) => (saved = JSON.parse(JSON.stringify(s))),
      projects: () => [
        { id: 3, name: 'One' },
        { id: 4, name: 'Two' },
      ],
      home: () => 2,
      chat: async (p) => 100 + p,
      env: () => ({ PATH: process.env.PATH!, HOME: process.env.HOME! }),
      canPush: async () => true,
      postCard: () => 'q',
      settle: () => {},
      note: () => {},
      mail: () => {},
    });
    await ks.poll();
    assert.deepEqual(seen[0], [], 'nothing is saved before the first check starts');
    assert.deepEqual(seen[1], ['One:checking'], "the second check starts with the first one's already saved");
  } finally {
    await tidy(jobs, root);
  }
});

test("a scheme's check runs in a citadel-heavy slot, so a round with several schemes behind can't start them all at once (#2112)", async () => {
  const { HostJobs } = await import('../src/host-job.ts');
  const { KitSync } = await import('../src/kit-sync.ts');
  const root = mkdtempSync(join(tmpdir(), 'kit-sync-heavy-'));
  const jobs = new HostJobs(() => false);
  try {
    const kit = repo(root, 'kit');
    const land1 = "#!/usr/bin/env bash\n# v1\nCHECK='true'\n";
    commit(kit, { [LAND.template]: land1 }, 'v1');
    const projectsDir = join(root, 'projects');
    commit(repo(projectsDir, '3/repo'), { [LAND.path]: land1 }, 'setup');
    commit(kit, { [LAND.template]: land1.replace('# v1', '# v2') }, 'v2');
    const argvs: string[][] = [];
    const watching = { start: (o: Parameters<typeof jobs.start>[0]) => (argvs.push(o.argv), jobs.start(o)), state: jobs.state.bind(jobs) };
    let saved: unknown;
    const ks = new KitSync({
      kitDir: kit,
      projectsDir,
      runDir: join(root, 'run'),
      jobs: watching,
      load: () => saved && JSON.parse(JSON.stringify(saved)),
      save: (s) => (saved = JSON.parse(JSON.stringify(s))),
      projects: () => [{ id: 3, name: 'One' }],
      home: () => 2,
      chat: async (p) => 100 + p,
      env: () => ({ PATH: process.env.PATH!, HOME: process.env.HOME! }),
      canPush: async () => true,
      postCard: () => 'q',
      settle: () => {},
      note: () => {},
      mail: () => {},
    } as never);
    await ks.poll();
    assert.equal(argvs.length, 1);
    assert.match(argvs[0][0], /tools\/citadel-heavy$/, 'the check is wrapped in citadel-heavy');
    assert.ok(argvs[0].includes('--here'), 'and stays on perigee, in the scheme worktree');
    assert.deepEqual(argvs[0].slice(-2), ['-c', CHECK_SCRIPT]);
  } finally {
    await tidy(jobs, root);
  }
});
