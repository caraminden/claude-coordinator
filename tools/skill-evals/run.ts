// Skill trigger evals (#1110): does each kit skill fire on the asks it is for, and stay quiet on the rest?
// Each case in cases.json runs as one Sonnet turn with the kit loaded, only the Skill tool on and no
// Citadel system prompt, so the skill descriptions are the only thing that varies. The first skill it
// reaches for is scored against the case's label. Run it through tools/skill-trigger-eval (--help).
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export type Case = { id: string; source: string; from: string; expect: string; also?: string[]; edited?: string; text: string };
// fired: the first Skill call's name, `citadel:` stripped; Claude Code's own skills keep a `cc:` prefix; 'none' if none.
export type Result = { id: string; fired: string[] };

const HERE = dirname(new URL(import.meta.url).pathname);
const REPO = resolve(HERE, '../..');
export const CASES_FILE = join(HERE, 'cases.json');

export function loadCases(file = CASES_FILE): Case[] {
  return JSON.parse(readFileSync(file, 'utf8')).cases;
}

// The first Skill tool call in a stream-json transcript, or 'none'.
export function firstSkill(stream: string): string {
  for (const line of stream.split('\n')) {
    if (!line.startsWith('{')) continue;
    let ev: any;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type !== 'assistant') continue;
    for (const part of ev.message?.content ?? []) {
      if (part.type === 'tool_use' && part.name === 'Skill' && typeof part.input?.skill === 'string') {
        const s = part.input.skill.trim();
        return s.startsWith('citadel:') ? s.slice(8) : `cc:${s}`;
      }
    }
  }
  return 'none';
}

const ok = (c: Case, fired: string) => fired === c.expect || (c.also ?? []).includes(fired);

export type SkillRow = { skill: string; cases: number; hits: number; runs: number; falseFires: number };

// Per skill: of the runs on cases that expect it, how many fired it (hits), and how many runs on any other
// case fired it where it isn't acceptable (false fires). 'none' is scored like a skill.
export function score(cases: Case[], results: Result[]): { rows: SkillRow[]; hits: number; total: number } {
  const byId = new Map(results.map((r) => [r.id, r.fired]));
  const rows = new Map<string, SkillRow>();
  const row = (skill: string) => rows.get(skill) ?? rows.set(skill, { skill, cases: 0, hits: 0, runs: 0, falseFires: 0 }).get(skill)!;
  let hits = 0, total = 0;
  for (const c of cases) {
    const fired = byId.get(c.id) ?? [];
    const r = row(c.expect);
    r.cases++;
    for (const f of fired) {
      total++; r.runs++;
      if (ok(c, f)) { hits++; r.hits++; } else row(f).falseFires++;
    }
  }
  return { rows: [...rows.values()].sort((a, b) => a.skill.localeCompare(b.skill)), hits, total };
}

const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : '–');

export function table(cases: Case[], results: Result[], skills: string[]): string {
  const { rows, hits, total } = score(cases, results);
  const byName = new Map(rows.map((r) => [r.skill, r]));
  const names = [...new Set([...skills, ...rows.map((r) => r.skill)])].sort();
  const out = [`Overall: ${hits}/${total} runs fired an acceptable first skill (${pct(hits, total)}).`, '',
    '| Skill | Cases | Hit rate | False fires |', '|---|---:|---:|---:|'];
  for (const n of names) {
    const r = byName.get(n) ?? { cases: 0, hits: 0, runs: 0, falseFires: 0 };
    out.push(`| ${n} | ${r.cases} | ${r.cases ? `${pct(r.hits, r.runs)} (${r.hits}/${r.runs})` : 'no case'} | ${r.falseFires} |`);
  }
  out.push('', '| Case | Expect | Fired |', '|---|---|---|');
  const byId = new Map(results.map((r) => [r.id, r.fired]));
  for (const c of cases) {
    const fired = byId.get(c.id) ?? [];
    const mark = fired.every((f) => ok(c, f)) ? '' : ' ✗';
    out.push(`| ${c.id} | ${[c.expect, ...(c.also ?? [])].join(' / ')} | ${fired.join(', ')}${mark} |`);
  }
  return out.join('\n');
}

// The cases whose share of acceptable runs changed between two result sets.
export function flips(cases: Case[], before: Result[], after: Result[]): string {
  const b = new Map(before.map((r) => [r.id, r.fired])), a = new Map(after.map((r) => [r.id, r.fired]));
  const share = (c: Case, f: string[]) => f.filter((x) => ok(c, x)).length / (f.length || 1);
  const lines = cases.filter((c) => share(c, b.get(c.id) ?? []) !== share(c, a.get(c.id) ?? []))
    .map((c) => `| ${c.id} | ${[c.expect, ...(c.also ?? [])].join(' / ')} | ${(b.get(c.id) ?? []).join(', ')} | ${(a.get(c.id) ?? []).join(', ')} |`);
  return lines.length ? ['| Case | Expect | Before | After |', '|---|---|---|---|', ...lines].join('\n') : 'No case changed.';
}

export function kitSkills(kitDir: string): string[] {
  return execFileSync('ls', [join(kitDir, 'skills')], { encoding: 'utf8' }).split('\n').filter((s) => s && !s.includes('.'));
}

// Without a frame the model sits in an empty folder and treats "why didn't I get a notification" as small talk.
// The frame is the same for every case and names no skill, so the descriptions stay the only variable.
export const frame = (c: Case) => `You are a coding agent working in the git repository of the project "${c.source.replace(/ ?(#\d+|\(.*\))$/g, '')}", `
  + 'one of several apps and tools a small group of friends builds with Claude Code. The next message comes from one of its people '
  + 'or from the coordinating agent that briefs you. Start on it.';

function runCase(kitDir: string, c: Case, model: string): Promise<string> {
  return new Promise((done) => {
    const p = spawn('claude', ['-p', '--model', model, '--plugin-dir', kitDir, '--tools', 'Skill', '--max-turns', '1',
      '--output-format', 'stream-json', '--verbose', '--setting-sources', '', '--no-session-persistence',
      '--append-system-prompt', frame(c), c.text],
    { cwd: tmpdir(), stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    const t = setTimeout(() => p.kill(), 120_000);
    p.on('close', () => { clearTimeout(t); done(firstSkill(out)); });
  });
}

async function runAll(kitDir: string, cases: Case[], runs: number, jobs: number, model: string, label: string): Promise<Result[]> {
  const fired = new Map(cases.map((c) => [c.id, [] as string[]]));
  const queue = cases.flatMap((c) => Array.from({ length: runs }, () => c));
  let done = 0;
  await Promise.all(Array.from({ length: jobs }, async () => {
    for (let c = queue.shift(); c; c = queue.shift()) {
      fired.get(c.id)!.push(await runCase(kitDir, c, model));
      if (++done % 10 === 0 || done === cases.length * runs) process.stderr.write(`${label}: ${done}/${cases.length * runs}\n`);
    }
  }));
  return cases.map((c) => ({ id: c.id, fired: fired.get(c.id)! }));
}

// The kit as it was at a git ref, in a temp folder.
function kitAt(ref: string): { dir: string; cleanup: () => void } {
  const tmp = mkdtempSync(join(tmpdir(), 'skill-evals-'));
  execFileSync('bash', ['-c', 'git -C "$1" archive "$2" kit | tar -x -C "$3"', '_', REPO, ref, tmp]);
  return { dir: join(tmp, 'kit'), cleanup: () => rmSync(tmp, { recursive: true, force: true }) };
}

const HELP = `tools/skill-trigger-eval [options]
Runs each case in tools/skill-evals/cases.json as one Sonnet turn with the kit loaded and scores which skill fires first.
  --base <ref>    also run the kit as it is at <ref> (e.g. main) and show before, after and the cases that flipped
  --ref <ref>     score the kit at <ref> instead of the working tree
  --skill <name>  only the cases that expect or accept <name> (quick check after editing one description)
  --case <id,...> only these cases
  --runs <n>      runs per case (default 1; 3 evens out Sonnet's noise for a before/after)
  --jobs <n>      cases at once (default 4)
  --model <m>     default sonnet
  --out <file>    also write the report there`;

async function main(argv: string[]) {
  const arg = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  if (argv.includes('--help') || argv.includes('-h')) return console.log(HELP);
  let cases = loadCases();
  const skill = arg('--skill'), only = arg('--case');
  if (skill) cases = cases.filter((c) => c.expect === skill || (c.also ?? []).includes(skill));
  if (only) cases = cases.filter((c) => only.split(',').includes(c.id));
  if (!cases.length) throw new Error('no case matches');
  const runs = Number(arg('--runs') ?? 1), jobs = Number(arg('--jobs') ?? 4), model = arg('--model') ?? 'sonnet';
  const ref = arg('--ref'), base = arg('--base');
  const after = ref ? kitAt(ref) : { dir: join(REPO, 'kit'), cleanup: () => {} };
  const label = ref ?? 'working tree';
  const parts: string[] = [`# Skill trigger evals: ${cases.length} cases × ${runs} run(s), ${model}`, ''];
  try {
    const skills = kitSkills(after.dir);
    const now = await runAll(after.dir, cases, runs, jobs, model, label);
    if (base) {
      const before = kitAt(base);
      try {
        const then = await runAll(before.dir, cases, runs, jobs, model, base);
        parts.push(`## Before (${base})`, '', table(cases, then, kitSkills(before.dir)), '');
        parts.push(`## After (${label})`, '', table(cases, now, skills), '', '## Cases that changed', '', flips(cases, then, now));
      } finally { before.cleanup(); }
    } else parts.push(`## ${label}`, '', table(cases, now, skills));
  } finally { after.cleanup(); }
  const report = parts.join('\n') + '\n';
  process.stdout.write(report);
  const out = arg('--out');
  if (out) writeFileSync(out, report);
}

if (import.meta.main) main(process.argv.slice(2)).catch((e) => { console.error(String(e?.message ?? e)); process.exit(1); });
