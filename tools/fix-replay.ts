// Replay past fixes backwards (#1291, R8 of the code-reviews lens, #1265): for each fix commit, undo only its
// source changes on today's tree (its tests stay as they are now), run the tests that guard it, and record whether
// they notice the bug coming back.
//
//   node tools/fix-replay.ts plan [--since 2026-11-01] [--batch 25] [--out dir]   cheap git only; writes batch-NN.json
//   citadel-heavy node tools/fix-replay.ts run <batch.json>                         the undo and the tests: CI only
//   node tools/fix-replay.ts tally <results.jsonl...>                               counts per outcome
//
// Never run `run` on perigee: it runs test files, which is what citadel-heavy sends to the scheme's CI.
//
// Which commits: FIX_RE on the subject, merges left out.
// Which tests: the runnable test files the commit itself touched that still exist ("own"); when it touched none,
// those its minion's other commits touched (same first #N in the subject, "sibling"), since minions often write the
// failing test first in a commit of its own. Test files are anything under a test/ folder or named *.test.*; docs
// (*.md, docs/) are left as they are too, so an undo never fails on prose.
//
// How the undo works: `git revert --no-commit` in a scratch worktree (a three-way merge, so code that moved but
// kept its shape still takes the undo), then every test and doc file the commit touched goes back to today's
// version. A conflict left in a source file means the code has moved on (no-apply); an undo that changes no
// source file means it was already undone or rewritten (no-op).
//
// Outcomes, one JSON line each after "FIXREPLAY ":
//   red       tests failed with the fix undone and pass on today's tree: the fix is guarded
//   green     tests still pass with the fix undone: they prove nothing about this fix
//   no-apply  the undo conflicts in source files: no evidence either way
//   no-op     the undo changes no source file
//   no-test   no runnable test file, own or sibling
//   no-source the commit changed only tests or docs (a failing-test-first commit and the like)
//   red-both  tests fail on today's tree too: no evidence
//   partial-* the whole undo conflicted, so the clashing hunks kept today's code (-X ours); share says how much of
//             the fix's source change was undone. Weaker evidence: the kept hunk may be the fix itself, and a red
//             may come from a half-undone change that no longer loads (read its failing test names).
//   skipped   every test in them was skipped (none ran)
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// The review heat map's fix regex, with word edges (its bare "hang" took every "change") and review commits added.
export const FIX_RE = /\b(fix(es)?|bug|regress\w*|broke|broken|flak\w*|revert\w*|crash\w*|leak\w*|race|stuck|hangs?|wrong)\b|self-review|fresh-eyes/i;
export const isTest = (p: string) => /(^|\/)test\//.test(p) || /\.test\.[cm]?[jt]s$/.test(p);
export const isRunnableTest = (p: string) => /\.test\.[cm]?[jt]s$/.test(p) && !p.includes('/fixtures/') && !p.includes('/template/');
export const isDoc = (p: string) => /\.md$/i.test(p) || p.startsWith('docs/');
export const ticketOf = (subject: string) => /#(\d+)/.exec(subject)?.[1] ?? null;

// The review heat map's areas (shared specs/review-heat-map.md, #1265), in order; first match wins.
const AREAS: [string, number, RegExp][] = [];
export function loadAreas(specPath: string) {
  const text = readFileSync(specPath, 'utf8');
  const block = /## Areas[^\n]*\n\n```\n([\s\S]*?)\n```/.exec(text)?.[1] ?? '';
  for (const line of block.split('\n')) {
    const [name, blast, pat] = line.split(' | ');
    if (name && blast && pat) AREAS.push([name.trim(), Number(blast), new RegExp(pat.trim())]);
  }
  return AREAS.length;
}
export function areaOf(path: string): [string, number] {
  for (const [name, blast, re] of AREAS) if (re.test(path)) return [name, blast];
  return ['(no area)', 2];
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 }).trim();
const gitTry = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 << 20 });

type Plan = {
  sha: string; date: string; subject: string; ticket: string | null;
  src: string[]; ownTests: string[]; siblingTests: string[]; tests: string[]; testsFrom: 'own' | 'sibling' | 'none';
  testOrDoc: string[]; area: string; blast: number;
};

function plan(args: string[]) {
  const opt = (name: string, dflt: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
  const since = opt('--since', '2026-11-01'), size = Number(opt('--batch', '25')), out = resolve(opt('--out', 'fix-replay'));
  const spec = opt('--spec', join(process.env.HOME ?? '', '.local/share/claude-coordinator/projects/2/shared/project/specs/review-heat-map.md'));
  if (!loadAreas(spec)) throw new Error(`no areas read from ${spec}`);
  const repo = git('.', 'rev-parse', '--show-toplevel');
  const exists = new Set(git(repo, 'ls-files').split('\n'));
  // Every commit's files since a week before, for the sibling lookup.
  const log = git(repo, 'log', '--no-merges', `--since=${since}`, '--format=%x00%H%x09%cI%x09%s', '--name-only', 'HEAD');
  const commits = log.split('\0').filter(Boolean).map((chunk) => {
    const [head, ...files] = chunk.split('\n').filter(Boolean);
    const [sha, date, subject] = head.split('\t');
    return { sha, date, subject, files };
  });
  const testsByTicket = new Map<string, Set<string>>();
  for (const c of commits) {
    const t = ticketOf(c.subject);
    if (!t) continue;
    const set = testsByTicket.get(t) ?? new Set();
    for (const f of c.files) if (isRunnableTest(f) && exists.has(f)) set.add(f);
    testsByTicket.set(t, set);
  }
  const plans: Plan[] = [];
  for (const c of commits.reverse()) {
    if (!FIX_RE.test(c.subject)) continue;
    const src = c.files.filter((f) => !isTest(f) && !isDoc(f));
    const testOrDoc = c.files.filter((f) => isTest(f) || isDoc(f));
    const ownTests = c.files.filter((f) => isRunnableTest(f) && exists.has(f));
    const ticket = ticketOf(c.subject);
    const siblingTests = ownTests.length || !ticket ? [] : [...(testsByTicket.get(ticket) ?? [])].slice(0, 8);
    const tests = ownTests.length ? ownTests : siblingTests;
    let area = '(none)', blast = 0;
    for (const f of src) { const [a, b] = areaOf(f); if (b > blast) [area, blast] = [a, b]; }
    plans.push({
      sha: c.sha, date: c.date, subject: c.subject, ticket, src, ownTests, siblingTests, tests,
      testsFrom: ownTests.length ? 'own' : siblingTests.length ? 'sibling' : 'none', testOrDoc, area, blast,
    });
  }
  mkdirSync(out, { recursive: true });
  const n = Math.ceil(plans.length / size);
  for (let i = 0; i < n; i++)
    writeFileSync(join(out, `batch-${String(i + 1).padStart(2, '0')}.json`), JSON.stringify(plans.slice(i * size, (i + 1) * size), null, 1));
  writeFileSync(join(out, 'all.json'), JSON.stringify(plans, null, 1));
  const by = (k: string) => plans.filter((p) => p.testsFrom === k).length;
  console.log(`${plans.length} fix commits since ${since} in ${n} batches of ${size} (${out}); tests: own ${by('own')}, sibling ${by('sibling')}, none ${by('none')}; no source: ${plans.filter((p) => !p.src.length).length}`);
}

type Run = { code: number | null; pass: number; fail: number; skipped: number; failed: string[]; secs: number; tail?: string };
function runTests(cwd: string, files: string[]): Run {
  const started = Date.now();
  const conc = String(Math.max(1, Math.floor(availableParallelism() / 2)));
  const r = spawnSync('timeout', ['900', join(cwd, 'tools/citadel-node'), '--test', '--test-reporter=tap', '--test-timeout=60000',
    `--test-concurrency=${conc}`, '--test-global-setup=test/leak-guard.ts', ...files],
  { cwd, encoding: 'utf8', maxBuffer: 256 << 20, env: { ...process.env, CITADEL_HEAVY_HELD: '1' } });
  const out = (r.stdout ?? '') + (r.stderr ?? '');
  const num = (k: string) => Number(new RegExp(`^# ${k} (\\d+)`, 'm').exec(out)?.[1] ?? 0);
  // Failing leaves: "not ok N - name" lines that aren't a file's own wrapper.
  const failed = [...out.matchAll(/^\s*not ok \d+ - (.+)$/gm)].map((m) => m[1].trim()).filter((n) => !/\.test\.[cm]?[jt]s$/.test(n)).slice(0, 8);
  return {
    code: r.status, pass: num('pass'), fail: num('fail'), skipped: num('skipped') + num('todo'), failed,
    secs: Math.round((Date.now() - started) / 1000), ...(r.status && !failed.length ? { tail: out.slice(-600) } : {}),
  };
}

function run(args: string[]) {
  // CI only: if citadel-heavy falls back to perigee (no runner took the job), this costs nothing there.
  if (!process.env.FIX_REPLAY_DRY && process.env.GITHUB_ACTIONS !== 'true') {
    console.error('fix-replay: run only on CI (GITHUB_ACTIONS=true), or FIX_REPLAY_DRY=1 for the undo alone');
    process.exit(3);
  }
  const plans: Plan[] = JSON.parse(readFileSync(args[0], 'utf8'));
  const repo = git('.', 'rev-parse', '--show-toplevel');
  const base = git(repo, 'rev-parse', 'HEAD');
  const scratch = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'fix-replay-'));
  const say = (o: object) => console.log(`FIXREPLAY ${JSON.stringify(o)}`);
  console.log(`fix-replay: ${plans.length} commits on ${base.slice(0, 10)}`);
  let k = 0;
  for (const p of plans) {
    const head = { sha: p.sha.slice(0, 10), subject: p.subject.slice(0, 160), ticket: p.ticket, area: p.area, blast: p.blast, testsFrom: p.testsFrom, tests: p.tests };
    const t0 = Date.now();
    if (!p.src.length) { say({ ...head, outcome: 'no-source' }); continue; }
    if (!p.tests.length) { say({ ...head, outcome: 'no-test', src: p.src }); continue; }
    const wt = join(scratch, `wt${k++}`);
    git(repo, 'worktree', 'add', '--detach', '--quiet', wt, base);
    try {
      // A whole undo first; when it conflicts, a partial one: -X ours keeps today's code in the clashing hunks only.
      let rev = gitTry(wt, 'revert', '--no-commit', '--no-edit', p.sha);
      const restoreTests = () => {
        // Tests and docs the commit touched go back to today's version (or away, if today has none).
        for (const f of p.testOrDoc) {
          if (gitTry(wt, 'cat-file', '-e', `${base}:${f}`).status === 0) git(wt, 'checkout', base, '--', f);
          else { gitTry(wt, 'rm', '-f', '--quiet', '--ignore-unmatch', '--', f); rmSync(join(wt, f), { force: true }); }
        }
        return git(wt, 'diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean);
      };
      let unmerged = restoreTests(), conflicts: string[] = [];
      if (unmerged.length) {
        conflicts = unmerged;
        gitTry(wt, 'revert', '--abort');
        git(wt, 'reset', '--hard', '--quiet', base);
        rev = gitTry(wt, 'revert', '--no-commit', '--no-edit', '-X', 'ours', p.sha);
        unmerged = restoreTests();
      }
      if (unmerged.length || (rev.status !== 0 && !/conflict/i.test(rev.stderr + rev.stdout))) {
        say({ ...head, outcome: 'no-apply', conflicts: unmerged.length ? unmerged : conflicts, err: unmerged.length ? undefined : (rev.stderr || '').slice(-300) });
        continue;
      }
      const changed = git(wt, 'diff', '--cached', '--name-only', base).split('\n').filter(Boolean);
      const changedSrc = changed.filter((f) => !isTest(f) && !isDoc(f));
      if (!changedSrc.length) { say({ ...head, outcome: conflicts.length ? 'no-apply' : 'no-op', conflicts }); continue; }
      // How much of the fix's source change the undo carries: 1 for a whole undo, less when hunks were kept.
      const lines = (out: string) => out.split('\n').reduce((n, l) => n + (Number(l.split('\t')[0]) || 0) + (Number(l.split('\t')[1]) || 0), 0);
      const share = conflicts.length
        ? Math.min(1, +(lines(git(wt, 'diff', '--cached', '--numstat', base, '--', ...changedSrc)) / Math.max(1, lines(git(repo, 'diff', '--numstat', `${p.sha}^`, p.sha, '--', ...p.src)))).toFixed(2))
        : 1;
      const pre = conflicts.length ? 'partial-' : '';
      const stat = git(wt, 'diff', '--cached', '--shortstat', base);
      // The tests that exist today; a test file the fix deleted again since is gone already.
      const tests = p.tests.filter((f) => existsSync(join(wt, f)));
      // FIX_REPLAY_DRY=1 stops before the tests: the undo alone is cheap git, fine on perigee, and sorts out no-apply.
      if (process.env.FIX_REPLAY_DRY) { say({ ...head, outcome: pre + 'applies', share, conflicts, undo: stat, changedSrc, tests }); continue; }
      const undone = runTests(wt, tests);
      let outcome: string, clean: Run | undefined;
      if (undone.pass + undone.fail === 0 && undone.code === 0) outcome = 'skipped';
      else if (undone.code === 0) outcome = 'green';
      else {
        // Red with the fix undone: is it green on today's tree? Only then does red mean the tests guard the fix.
        git(wt, 'reset', '--hard', '--quiet', base);
        clean = runTests(wt, tests);
        outcome = clean.code === 0 ? 'red' : 'red-both';
      }
      say({ ...head, outcome: pre + outcome, share, conflicts, undo: stat, changedSrc, undone, clean, secs: Math.round((Date.now() - t0) / 1000) });
    } catch (e: any) {
      say({ ...head, outcome: 'error', err: String(e.stderr || e.message).slice(-400) });
    } finally {
      gitTry(repo, 'worktree', 'remove', '--force', wt);
    }
  }
  rmSync(scratch, { recursive: true, force: true });
  gitTry(repo, 'worktree', 'prune');
}

function tally(files: string[]) {
  const rows = files.flatMap((f) => readFileSync(f, 'utf8').split('\n'))
    .map((l) => l.replace(/^.*?FIXREPLAY /, (m) => (m.endsWith('FIXREPLAY ') ? '' : m))).filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.outcome] = (counts[r.outcome] ?? 0) + 1;
  console.log(JSON.stringify({ total: rows.length, ...counts }));
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'plan') plan(rest);
else if (cmd === 'run') run(rest);
else if (cmd === 'tally') tally(rest);
else if (cmd) { console.error('usage: fix-replay.ts plan|run|tally ...'); process.exit(2); }
