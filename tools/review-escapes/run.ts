// The escape set (#1505): replay the pre-ship reviewer on past changes whose defect a later minion fixed, and on
// same-size changes nobody had to fix, then have a blind judge say whether each review named the defect.
// README.md beside this file; `node tools/review-escapes/run.ts --help`.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');

type Defect = { fix: number; title: string; why: string; cause: string; foundBy: string; fixCommits: string[] };
type Plant = { file: string; from: string; to: string };
// An escape or a planted case has defects to name; a clean one or a control has none. A planted case is a real small commit
// (`head`, on `base` its parent) with `plant` applied to it: one diff-visible bug a reviewer reading the diff should name (#1738).
type Case = { id: string; kind: 'escape' | 'clean' | 'planted' | 'control'; origin: number; title: string; lines: number; base: string; head?: string; picks?: string[]; defects?: Defect[]; taught?: string; plant?: Plant[]; plantKind?: string; set?: string };
const hasDefects = (c: Case) => c.kind === 'escape' || c.kind === 'planted';
type Arm = { name: string; model: string; effort: string; lens?: string };
type Meta = { cost: number; ms: number; turns: number; models: string[]; error?: string };
type Verdict = { fix: number; verdict: 'named' | 'near' | 'no'; finding: number | null; why: string };

/** `--set escapes|planted|all` (default all), or the path of a set file (its group is its file name). */
function loadSet(which: string): Case[] {
  const files = which === 'all' ? ['set.json', 'planted.json'] : which === 'escapes' ? ['set.json'] : which === 'planted' ? ['planted.json'] : [resolve(which)];
  return files.flatMap((f) => (JSON.parse(readFileSync(resolve(HERE, f), 'utf8')).cases as Case[]).map((c) => ({ ...c, set: f === 'set.json' ? 'escapes' : 'planted' })));
}
const ARMS: Arm[] = JSON.parse(readFileSync(join(HERE, 'arms.json'), 'utf8')).arms;
const GRUNT_LINE = 'Citadel, Scheme, Taskmaster, Minion and Grunt are playful names for how the work is organised, not a comment on ability. Work as a careful, senior engineer: think things through, check your work, and push back when something looks wrong.';

const argv = process.argv.slice(2);
const arg = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const SET = loadSet(arg('--set') ?? 'all');
const git = (...a: string[]) => execFileSync('git', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 << 20 });
const KEEP = /^(PATH|HOME|USER|LOGNAME|LANG|LC_\w+|TERM|SHELL|TZ|CLAUDE_CONFIG_DIR|ANTHROPIC_\w+)$/;
const cleanEnv = (tmp: string) => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => KEEP.test(k))), TMPDIR: tmp, CLAUDE_CODE_TMPDIR: tmp });

/** The case's shipped branch, rebuilt in a clone: `main` at the commit it branched from, `ticket/<n>-replay` at what
 *  shipped. Only those two refs and no remote, so nothing later (the fix above all) shows in its log. */
function workspace(c: Case, out: string): string {
  const dir = join(out, 'ws', c.id);
  // A workspace is reused while the case's own text is unchanged (a plant edited since needs a rebuild).
  const stamp = JSON.stringify([c.base, c.head, c.picks, c.plant]);
  if (existsSync(join(dir, '.ready')) && readFileSync(join(dir, '.ready'), 'utf8') === stamp) return dir;
  execFileSync('rm', ['-rf', dir]);
  git('clone', '-q', '--shared', '--no-checkout', REPO, dir);
  const g = (...a: string[]) => git('-C', dir, '-c', 'user.name=replay', '-c', 'user.email=replay@localhost', '-c', 'core.hooksPath=/dev/null', ...a);
  const branch = `ticket/${c.origin}-replay`;
  let base = c.base, how = 'as shipped';
  g('checkout', '-q', '--detach', c.base);
  g('checkout', '-q', '-b', branch, c.head ?? c.base);
  if (c.plant) {
    // The plant goes into the head commit itself, so the reviewer's `git diff main...HEAD` has only the planted version and
    // no commit says what was changed.
    for (const p of c.plant) {
      const file = join(dir, p.file), text = readFileSync(file, 'utf8');
      if (text.split(p.from).length !== 2) throw new Error(`${c.id}: the plant's "from" text is in ${p.file} ${text.split(p.from).length - 1} times, not once`);
      writeFileSync(file, text.replace(p.from, () => p.to));
    }
    g('commit', '-q', '-a', '--amend', '--no-edit');
  }
  if (c.picks) {
    // Other work landed between its commits: replay them onto where it started; when that conflicts, take the last
    // one's tree with them reverted out as main and the change as one commit carrying their messages; when that
    // conflicts too, the plain range from the first to the last (with the work in between in the diff).
    try { for (const sha of c.picks) g('cherry-pick', '--allow-empty', '--keep-redundant-commits', sha); how = 'cherry-pick'; } catch {
      try { g('cherry-pick', '--abort'); } catch { /* nothing to abort */ }
      const last = c.picks[c.picks.length - 1];
      g('checkout', '-q', '--detach', last);
      try {
        for (const sha of [...c.picks].reverse()) g('revert', '--no-edit', sha);
        base = g('rev-parse', 'HEAD').trim();
        const msg = c.picks.map((s) => g('show', '-s', '--format=%B', s).trim()).join('\n\n');
        const head = g('commit-tree', `${last}^{tree}`, '-p', base, '-m', msg).trim();
        g('checkout', '-q', '-B', branch, head); how = 'revert';
      } catch {
        try { g('revert', '--abort'); } catch { /* nothing to abort */ }
        g('checkout', '-q', '-B', branch, last); how = 'range';
      }
    }
  }
  g('remote', 'remove', 'origin');
  for (const r of g('for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/tags').split('\n').filter(Boolean))
    if (r !== `refs/heads/${branch}`) g('update-ref', '-d', r);
  g('branch', '-q', 'main', base);
  writeFileSync(join(dir, '.git', 'replay-how'), how);
  g('reflog', 'expire', '--expire=now', '--all');
  // Copy in what the two refs reach and drop the link to the repo's objects, so the fix can't be found by hash.
  g('repack', '-a', '-d', '-q');
  execFileSync('rm', ['-f', join(dir, '.git', 'objects', 'info', 'alternates')]);
  writeFileSync(join(dir, '.ready'), stamp);
  // Keep the marker out of the reviewer's `git status`.
  writeFileSync(join(dir, '.git', 'info', 'exclude'), '.ready\n', { flag: 'a' });
  return dir;
}

/** One `claude -p`: the stream to `file`, its final text and cost. */
function claude(args: string[], input: string, cwd: string, file: string, timeoutMs: number): Promise<Meta & { text: string }> {
  const tmp = join(dirname(file), 'tmp'); mkdirSync(tmp, { recursive: true });
  const t0 = Date.now();
  return new Promise((done) => {
    const p = spawn('claude', args, { cwd, env: cleanEnv(tmp), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => p.kill('SIGTERM'), timeoutMs);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => {
      clearTimeout(timer);
      writeFileSync(file, out);
      const msgs = out.split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const result = msgs.findLast((m) => m.type === 'result');
      const meta = { cost: Number(result?.total_cost_usd ?? 0), ms: Date.now() - t0, turns: Number(result?.num_turns ?? 0), models: Object.keys(result?.modelUsage ?? {}) };
      if (!result) return done({ ...meta, text: '', error: `claude exited ${code} with no result: ${err.trim().slice(-300)}` });
      done({ ...meta, text: String(result.result ?? '') });
    });
    p.stdin.end(input);
  });
}

async function review(c: Case, arm: Arm, out: string, kit: string): Promise<void> {
  const dir = join(out, arm.name, c.id);
  if (existsSync(join(dir, 'meta.json'))) return;
  mkdirSync(dir, { recursive: true });
  const ws = workspace(c, out);
  // The brief citadel:self-review §2 writes, with the arm's extra lens in place of "by the diff".
  const brief = `${GRUNT_LINE}\n\nFollow \`${kit}/agents/reviewer.md\`. Review branch \`ticket/${c.origin}-replay\` in \`${ws}\`; the change is \`git diff main...HEAD\`; the kit is \`${kit}\`. ${arm.lens ?? 'Lenses: by the diff.'}\n`;
  writeFileSync(join(dir, 'brief.md'), brief);
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: '.*',
    hooks: [{ type: 'command', command: `'${process.execPath}' '${join(REPO, 'tools/prompt-evals/guard.ts')}'`, timeout: 10 }] }] } }));
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions',
    '--plugin-dir', kit, '--agent', 'citadel:reviewer', '--model', arm.model, '--effort', arm.effort,
    '--settings', join(dir, 'settings.json'), '--setting-sources', 'project', '--strict-mcp-config',
    '--max-turns', '120', '--max-budget-usd', arg('--budget') ?? '6', '--no-session-persistence'];
  const r = await claude(args, brief, ws, join(dir, 'stream.jsonl'), 30 * 60_000);
  writeFileSync(join(dir, 'review.md'), r.text);
  const { text, ...meta } = r;
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 1));
  console.log(`${arm.name} ${c.id}: $${meta.cost.toFixed(2)} ${Math.round(meta.ms / 1000)}s ${countFindings(text)} findings${meta.error ? ' ERROR ' + meta.error : ''}`);
}

/** Numbered Must fix and Should fix findings in a review (Nice to have doesn't count as an alarm). */
const countFindings = (text: string) => (text.match(/^\s*\**\d+\.?\**[.)]?\s*\**\s*(Must fix|Should fix)/gim) ?? []).length;

/** What the fix changed: its commit messages and its non-test diff, capped. */
function fixShape(d: Defect, c: Case): string {
  if (c.plant) return `The bug was planted on purpose, in code this change added. What the change looked like before the plant, and after it:\n${c.plant.map((p) => `${p.file}\n--- original\n${p.from}\n--- planted\n${p.to}`).join('\n\n')}`;
  if (!d.fixCommits.length) return '(no commits found for the fix)';
  const log = git('-C', REPO, 'show', '-s', '--format=%s%n%b', ...d.fixCommits).trim();
  const diff = git('-C', REPO, 'show', '--format=', '--unified=2', ...d.fixCommits, '--', '.', ':!test/**', ':!**/*.test.*').split('\n');
  return `Commit messages:\n${log.slice(0, 3000)}\n\nCode diff (tests left out${diff.length > 260 ? ', first 260 lines' : ''}):\n${diff.slice(0, 260).join('\n')}`;
}

const JUDGE_RULES = `You judge whether a code review, written before a change shipped, named a defect that was found and fixed after it shipped (or, for a planted defect, put into the change on purpose). You don't know who wrote the review or how.

For each defect, answer one of:
- named: one finding describes this defect: the same wrong behaviour on the same code path, so that acting on that finding would have fixed it (or a fix very like the real one). Its wording, severity or suggested fix can differ.
- near: a finding points at the right code or a related failure but misses what actually went wrong, so acting on it would probably not have fixed this defect.
- no: nothing in the review is about this defect.

Be strict: the same file or area is not enough for named. Reply with JSON only, no fence: {"verdicts":[{"fix":<number>,"verdict":"named|near|no","finding":<the finding's number or null>,"why":"<one sentence>"}]}`;

async function judge(c: Case, arm: Arm, out: string, model: string): Promise<void> {
  const dir = join(out, arm.name, c.id);
  if (!hasDefects(c) || existsSync(join(dir, 'judge.json')) || !existsSync(join(dir, 'review.md'))) return;
  const reviewText = readFileSync(join(dir, 'review.md'), 'utf8').trim() || '(the review returned nothing)';
  const defects = c.defects!.map((d) => `### ${c.kind === 'planted' ? 'Planted defect' : `Defect fixed by #${d.fix}`}: ${d.title}\nWhat went wrong: ${d.why}\n\n${fixShape(d, c)}`).join('\n\n');
  const prompt = `${JUDGE_RULES}\n\n## The change reviewed\n#${c.origin}: ${c.title}\n\n## Defects found after it shipped\n\n${defects}\n\n## The review\n\n${reviewText}\n`;
  writeFileSync(join(dir, 'judge-prompt.md'), prompt);
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--model', model, '--effort', 'medium', '--tools', '', '--max-turns', '1',
    '--setting-sources', 'project', '--strict-mcp-config', '--no-session-persistence'];
  const r = await claude(args, prompt, tmpdir(), join(dir, 'judge-stream.jsonl'), 10 * 60_000);
  const m = r.text.match(/\{[\s\S]*\}/);
  let verdicts: Verdict[] = [];
  try { verdicts = JSON.parse(m?.[0] ?? '').verdicts; } catch { /* left empty: the report counts it as unjudged */ }
  writeFileSync(join(dir, 'judge.json'), JSON.stringify({ cost: r.cost, verdicts, raw: verdicts.length ? undefined : r.text }, null, 1));
}

async function pool<T>(items: T[], jobs: number, fn: (t: T) => Promise<void>) {
  const q = [...items];
  await Promise.all(Array.from({ length: jobs }, async () => { for (let t = q.shift(); t !== undefined; t = q.shift()) await fn(t); }));
}

/** The numbers of one arm on one group of cases (escapes, planted); `summary.json` keeps them for tools/review-escapes/bench.ts. */
export type Tally = { reviews: number; defects: number; named: number; near: number; cases: number; casesNamed: number; findings: number; controls: number; controlsWith: number; controlFindings: number; cost: number; judgeCost: number; unjudged: number; medianSec: number };

function tally(out: string, arm: Arm, group: string): { t: Tally; per: string[] } {
  const read = (p: string) => existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : undefined;
  const t: Tally = { reviews: 0, defects: 0, named: 0, near: 0, cases: 0, casesNamed: 0, findings: 0, controls: 0, controlsWith: 0, controlFindings: 0, cost: 0, judgeCost: 0, unjudged: 0, medianSec: 0 };
  const per: string[] = [], times: number[] = [];
  for (const c of SET.filter((c) => c.set === group)) {
    const dir = join(out, arm.name, c.id);
    const meta: Meta | undefined = read(join(dir, 'meta.json'));
    if (!meta) continue;
    t.reviews++; t.cost += meta.cost; times.push(meta.ms);
    const f = countFindings(existsSync(join(dir, 'review.md')) ? readFileSync(join(dir, 'review.md'), 'utf8') : '');
    if (!hasDefects(c)) { t.controls++; t.controlFindings += f; if (f) t.controlsWith++; continue; }
    t.cases++; t.findings += f;
    const j = read(join(dir, 'judge.json'));
    if (!j?.verdicts?.length) { t.unjudged++; continue; }
    t.judgeCost += j.cost;
    let any = false;
    for (const d of c.defects!) {
      t.defects++;
      const v = j.verdicts.find((x: Verdict) => x.fix === d.fix)?.verdict ?? 'no';
      if (v === 'named') { t.named++; any = true; } else if (v === 'near') t.near++;
      per.push(`${arm.name}\t${c.id}\t#${d.fix}\t${v}${c.taught ? '\ttaught' : ''}`);
    }
    if (any) t.casesNamed++;
  }
  times.sort((a, b) => a - b);
  t.medianSec = times.length ? Math.round(times[times.length >> 1] / 1000) : 0;
  return { t, per };
}

function report(out: string, arms: Arm[]): string {
  const rows: string[] = ['| Arm | Set | Reviews | Defects named | Near | Changes with a defect named | Findings on those (per review) | Clean changes or controls with a finding | Findings on clean | Review cost | Judge cost | $ per defect named | Median time |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|'];
  const per: string[] = [], summary: Record<string, Record<string, Tally>> = {};
  for (const arm of arms) for (const group of [...new Set(SET.map((c) => c.set!))]) {
    const { t, per: p } = tally(out, arm, group);
    if (!t.reviews) continue;
    per.push(...p);
    (summary[arm.name] ??= {})[group] = t;
    rows.push(`| ${arm.name} | ${group} | ${t.reviews} | ${t.named} of ${t.defects} | ${t.near} | ${t.casesNamed} of ${t.cases - t.unjudged} | ${t.cases ? (t.findings / t.cases).toFixed(1) : '-'} | ${t.controlsWith} of ${t.controls} | ${t.controlFindings} | $${t.cost.toFixed(2)} | $${t.judgeCost.toFixed(2)} | ${t.named ? '$' + (t.cost / t.named).toFixed(2) : '-'} | ${t.medianSec} s |${t.unjudged ? ` (${t.unjudged} unjudged)` : ''}`);
  }
  writeFileSync(join(out, 'verdicts.tsv'), per.join('\n') + '\n');
  writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 1));
  return rows.join('\n');
}

/** What is wrong with a planted case: a plant that isn't in lines the change added, one that doesn't change the diff, or a file that no longer parses. */
function plantProblems(c: Case, ws: string): string[] {
  const bad: string[] = [];
  const added = (git('-C', REPO, 'show', '--format=', '-U0', c.head!).split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1))).join('\n');
  for (const p of c.plant!) {
    if (p.from === p.to) bad.push(`${p.file}: from and to are the same`);
    if (!added.includes(p.from)) bad.push(`${p.file}: "${p.from.slice(0, 50)}" is not in the lines this change added (whole consecutive added lines' text, indent included)`);
    if (/\.(ts|js)$/.test(p.file)) {
      try { execFileSync(process.execPath, ['--check', join(ws, p.file)], { stdio: 'pipe' }); } catch (e: any) { bad.push(`${p.file} no longer parses: ${String(e.stderr).split('\n').find((l: string) => /Error/.test(l)) ?? ''}`); }
    }
  }
  if (!c.defects?.length || !c.defects[0].why) bad.push('no defect text');
  return bad;
}

const HELP = `tools/review-escapes: the pre-ship reviewer against defects that really escaped (#1505)

  node tools/review-escapes/run.ts run [--arms sonnet,opus,lens] [--set escapes|planted|all|<file>] [--case <regex>] [--jobs 3] [--out <dir>] [--kit <dir>] [--judge-model opus] [--budget 6]
      reviews each case with each arm (skipping ones already in --out), judges the escapes blind, prints the table
  node tools/review-escapes/run.ts report [--arms ...] [--out <dir>]     the table again, and <out>/verdicts.tsv and summary.json
  node tools/review-escapes/run.ts check [--case <regex>] [--out <dir>]  builds every case's workspace, no model calls

  --out defaults to $TMPDIR/review-escapes. --kit defaults to this checkout's kit/, the reviewer under test.
  Arms are in arms.json; a new arm is a new entry there. Runs on the asker's Claude login: start it in the
  background, not through citadel-heavy (it waits on Claude, not the CPU).`;

async function main() {
  const cmd = argv[0];
  if (!cmd || argv.includes('--help')) return console.log(HELP);
  const out = resolve(arg('--out') ?? join(process.env.TMPDIR ?? tmpdir(), 'review-escapes'));
  const kit = resolve(arg('--kit') ?? join(REPO, 'kit'));
  const re = new RegExp(arg('--case') ?? '.');
  const cases = SET.filter((c) => re.test(c.id));
  const names = arg('--arms')?.split(',');
  const arms = names ? names.map((n) => ARMS.find((a) => a.name === n) ?? (() => { throw new Error(`no arm ${n} in arms.json`); })()) : ARMS;
  mkdirSync(out, { recursive: true });
  if (cmd === 'check') {
    for (const c of cases) {
      const ws = workspace(c, out);
      const stat = git('-C', ws, 'diff', '--shortstat', 'main...HEAD').trim();
      const leak = c.plant ? [] : git('-C', ws, 'log', '--all', '--format=%s').split('\n').filter((s) => c.defects?.some((d) => new RegExp(`#${d.fix}(?!\\d)`).test(s)));
      const bad = c.plant ? plantProblems(c, ws) : [];
      console.log(`${c.id} (${readFileSync(join(ws, ".git", "replay-how"), "utf8")}): ${stat}${leak.length ? '  LEAK: ' + leak[0] : ''}${bad.length ? '  PROBLEM: ' + bad.join('; ') : ''}`);
    }
    return;
  }
  if (cmd === 'run') {
    for (const c of cases) workspace(c, out); // serially: clones and cherry-picks share the repo's lock
    const jobs = Number(arg('--jobs') ?? 3);
    await pool(arms.flatMap((a) => cases.map((c) => [a, c] as const)), jobs, ([a, c]) => review(c, a, out, kit));
    await pool(arms.flatMap((a) => cases.map((c) => [a, c] as const)), jobs, ([a, c]) => judge(c, a, out, arg('--judge-model') ?? 'opus'));
  } else if (cmd !== 'report') return console.log(HELP);
  console.log(report(out, arms));
  console.log(`\nPer defect: ${join(out, 'verdicts.tsv')}`);
}

await main();
