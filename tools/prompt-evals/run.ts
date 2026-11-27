#!/usr/bin/env node
// Prompt evals (#1117): rerun frozen corrections against a prompt version or a tier, scored by code checks, a Sonnet
// judge advising. README.md has the case format, the decisions and how to run it; --help has the flags.
import { spawn, execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ClaudeEvent, ContentBlock } from '../../src/claude-events.ts';
import { thrown } from '../../src/thrown.ts';
import { nameMatches, type Fact } from './stub.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');

export type Check = { call?: string; noCall?: string; input?: string; before?: string; reply?: string; noText?: string; said?: string; why: string };
export type Case = {
  id: string;
  kind: 'strike' | 'correction' | 'rule';
  source: string;
  role: 'minion' | 'taskmaster';
  ticket: { number: number; title: string; type: string | null };
  commit: string;
  work?: string;
  from: string;
  history: string;
  message: string;
  facts: Fact[];
  right: string;
  wrong: string;
  checks: Check[];
};
export type Brief = { id: string; source: string; ticket: { number: number; title: string; type: string | null }; from: string; message: string; before: string; fix: string; tests: string[]; right: string };
export type Event = { call?: string; input?: string; text?: string };

// ---- Scoring: pure, tested in test/prompt-evals.test.ts ----

/** The top-level turn's tool calls and text, in order, from a stream-json transcript (a Grunt's own calls are left out). */
export function events(stream: string): Event[] {
  const out: Event[] = [];
  for (const line of stream.split('\n')) {
    let m: ClaudeEvent;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (m?.type !== 'assistant' || m.parent_tool_use_id) continue;
    for (const b of (m.message?.content ?? []) as ContentBlock[]) {
      if (b.type === 'text' && b.text?.trim()) out.push({ text: b.text });
      else if (b.type === 'tool_use') out.push({ call: String(b.name), input: JSON.stringify(b.input ?? {}) });
    }
  }
  return out;
}

const re = (s: string) => new RegExp(s, 'i');

/** Whether one check holds on a rerun's events (README.md, "Checks"). */
export function holds(c: Check, ev: Event[]): boolean {
  const calls = (tools: string) => ev.flatMap((e, i) => (e.call && nameMatches(tools, e.call) && (!c.input || re(c.input).test(e.input!)) ? [i] : []));
  if (c.call !== undefined) {
    const hits = calls(c.call);
    if (!hits.length) return false;
    if (!c.before) return true;
    const said = ev.findIndex((e) => e.text !== undefined && re(c.before!).test(e.text));
    return said < 0 || hits[0] < said;
  }
  if (c.noCall !== undefined) return !calls(c.noCall).length;
  if (c.reply !== undefined) {
    const last = ev.findLast((e) => e.text !== undefined);
    return !!last && re(c.reply).test(last.text!);
  }
  if (c.noText !== undefined) return !ev.some((e) => e.text !== undefined && re(c.noText!).test(e.text));
  // Anywhere in the turn: its text or any call's input (a rule met in a plan, a card or a file as well as in a reply).
  if (c.said !== undefined) return ev.some((e) => re(c.said!).test(e.text ?? e.input ?? ''));
  throw new Error('a check needs call, noCall, reply, noText or said');
}

/** The whys of the checks a rerun failed; empty means it passed. */
export const failures = (c: Case, ev: Event[]) => c.checks.filter((k) => !holds(k, ev)).map((k) => k.why);
/** A case passes when most of its runs do. */
export const passes = (passed: number, runs: number) => passed * 2 > runs;
/** A case fell when its passing runs dropped by 2 or more against the base: one run's swing is noise (README.md, "Scoring"). */
export const fell = (now: number, base: number) => base - now >= 2;

/** A case file as it is meant to read; it is untyped JSON until `problems` has checked it, so every field may be anything. */
interface RawCase {
  [k: string]: unknown;
  ticket?: { number?: unknown; title?: unknown };
  facts?: { tool?: unknown; result?: unknown; match?: unknown }[];
  checks?: { [k: string]: unknown; why?: unknown; call?: unknown }[];
}

/** A brief file as it is meant to read, untyped JSON until `briefProblems` has checked it. */
interface RawBrief {
  [k: string]: unknown;
  ticket?: { number?: unknown; title?: unknown };
  tests?: unknown[];
}

/** What is wrong with a case file, or an empty list. */
export function problems(raw: unknown, file?: string): string[] {
  const c = raw as RawCase | null | undefined;
  const out: string[] = [];
  const str = (k: string) => typeof c?.[k] === 'string' && c[k].trim() !== '';
  for (const k of ['id', 'source', 'commit', 'from', 'message', 'right', 'wrong']) if (!str(k)) out.push(`${k} is missing`);
  if (typeof c?.history !== 'string') out.push('history must be a string (empty for a first turn)');
  if (file && c?.id !== file.replace(/\.json$/, '')) out.push(`id ${c?.id} doesn't match its file name`);
  if (!['strike', 'correction', 'rule'].includes(c?.kind as string)) out.push('kind is strike, correction or rule');
  if (!['minion', 'taskmaster'].includes(c?.role as string)) out.push('role is minion or taskmaster');
  if (!Number.isInteger(c?.ticket?.number) || typeof c?.ticket?.title !== 'string') out.push('ticket needs number and title');
  if (!/^[0-9a-f]{7,40}$/.test((c?.commit ?? '') as string)) out.push('commit is a sha');
  if (c?.work !== undefined && !/^[0-9a-f]{7,40}$/.test(c.work as string)) out.push('work is a sha (a child of commit)');
  const compiles = (what: string, s: unknown) => {
    if (s === undefined) return;
    try {
      if (typeof s !== 'string') throw new Error('not a string');
      new RegExp(s, 'i');
    } catch (e) {
      out.push(`${what}: ${thrown(e).message}`);
    }
  };
  if (!Array.isArray(c?.facts)) out.push('facts is a list');
  for (const [i, f] of (c?.facts ?? []).entries()) {
    if (typeof f?.tool !== 'string' || typeof f?.result !== 'string') out.push(`facts[${i}] needs tool and result`);
    compiles(`facts[${i}].tool`, f?.tool);
    compiles(`facts[${i}].match`, f?.match);
  }
  if (!Array.isArray(c?.checks) || !c.checks.length) out.push('checks needs at least one check');
  for (const [i, k] of (c?.checks ?? []).entries()) {
    const kinds = ['call', 'noCall', 'reply', 'noText', 'said'].filter((x) => k?.[x] !== undefined);
    if (kinds.length !== 1) out.push(`checks[${i}] needs exactly one of call, noCall, reply, noText, said`);
    if (typeof k?.why !== 'string' || !k.why) out.push(`checks[${i}] needs a why`);
    if (k?.before !== undefined && k?.call === undefined) out.push(`checks[${i}]: before goes with call`);
    for (const x of ['call', 'noCall', 'reply', 'noText', 'said', 'input', 'before']) compiles(`checks[${i}].${x}`, k?.[x]);
  }
  return out;
}

/** What is wrong with a brief file, or an empty list. */
export function briefProblems(raw: unknown, file?: string): string[] {
  const b = raw as RawBrief | null | undefined;
  const out: string[] = [];
  for (const k of ['id', 'source', 'from', 'message', 'right']) if (typeof b?.[k] !== 'string' || !b[k].trim()) out.push(`${k} is missing`);
  if (file && b?.id !== file.replace(/\.json$/, '')) out.push(`id ${b?.id} doesn't match its file name`);
  for (const k of ['before', 'fix']) if (!/^[0-9a-f]{7,40}$/.test((b?.[k] ?? '') as string)) out.push(`${k} is a sha`);
  if (!Number.isInteger(b?.ticket?.number) || typeof b?.ticket?.title !== 'string') out.push('ticket needs number and title');
  if (!Array.isArray(b?.tests) || !b.tests.length || !b.tests.every((t: unknown) => typeof t === 'string' && /^test\/[\w./-]+\.ts$/.test(t))) out.push('tests lists test/<name>.ts files');
  return out;
}

export function load<T>(dir: string, check: (x: unknown, file: string) => string[]): T[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => {
      const x = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      const bad = check(x, f);
      if (bad.length) throw new Error(`${join(dir, f)}: ${bad.join('; ')}`);
      return x as T;
    });
}

// ---- Running ----

type Side = { label: string; name: string; dir: string; model: string; effort: string; app: string; scheme: string; drop?: object };
type Run = { ok: boolean; error?: string; failed: string[]; cost: number; judge?: string; file: string };

const git = (...a: string[]) => execFileSync('git', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const pst = () => new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles', dateStyle: 'medium', timeStyle: 'short' }) + ' PT';
// A run's environment: the asker's Claude login and nothing of the turn's (no Citadel or GitHub tokens).
const KEEP = /^(PATH|HOME|USER|LOGNAME|LANG|LC_\w+|TERM|SHELL|TZ|CLAUDE_CONFIG_DIR|ANTHROPIC_\w+)$/;
const cleanEnv = (tmp: string) => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => KEEP.test(k))), TMPDIR: tmp, CLAUDE_CODE_TMPDIR: tmp, GIT_AUTHOR_NAME: 'Replay', GIT_AUTHOR_EMAIL: 'replay@localhost', GIT_COMMITTER_NAME: 'Replay', GIT_COMMITTER_EMAIL: 'replay@localhost' });
// As a real turn's (src/runner.ts): tools Citadel turns never get.
const DISALLOWED = ['AskUserQuestion', 'Workflow', 'ScheduleWakeup', 'CronCreate', 'CronDelete', 'CronList', 'RemoteTrigger', 'ListAgents', 'ReportFindings'];

/** The prompt files (src, kit, CLAUDE.md, .claude, and public, which src imports) at a ref, or the working tree when there is none. */
function version(ref: string | undefined, work: string): { dir: string; name: string } {
  if (!ref) return { dir: REPO, name: 'working tree' };
  const sha = git('-C', REPO, 'rev-parse', '--verify', `${ref}^{commit}`).trim();
  const dir = join(work, `v-${sha.slice(0, 10)}`);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    const paths = ['src', 'kit', 'public', 'CLAUDE.md', '.claude'].filter((p) => {
      try {
        git('-C', REPO, 'cat-file', '-e', `${sha}:${p}`);
        return true;
      } catch {
        return false;
      }
    });
    execFileSync('bash', ['-c', 'git -C "$1" archive "$2" "${@:4}" | tar -x -C "$3"', '_', REPO, sha, dir, ...paths]);
  }
  return { dir, name: `${ref} (${sha.slice(0, 8)})` };
}

/** A clone of the repo at a commit, with no remote (nothing in it can push) and only a `main` there: the clone's own
 *  branches and tags would show later work. */
function clone(commit: string, dir: string): string {
  if (existsSync(dir)) return dir;
  git('clone', '-q', '--shared', '--no-checkout', REPO, dir);
  git('-C', dir, 'checkout', '-q', '--detach', commit);
  git('-C', dir, 'remote', 'remove', 'origin');
  for (const r of git('-C', dir, 'for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/tags').split('\n').filter(Boolean)) git('-C', dir, 'update-ref', '-d', r);
  git('-C', dir, 'branch', '-q', 'main', commit);
  return dir;
}

/** Put a minion's checkout on its own branch off `main`, as a real turn's worktree is. */
const onTicketBranch = (dir: string, n: number) => git('-C', dir, 'checkout', '-q', '-b', `ticket/${n}-replay`);

/** The case's repo at its commit, with the side's CLAUDE.md and .claude, since those are part of the prompt under test. */
function workspace(c: Case, side: Side, work: string): string {
  const dir = join(work, 'ws', `${c.id}-${side.label}`);
  if (existsSync(dir)) return dir;
  const base = clone(c.commit, join(work, 'commits', c.commit));
  mkdirSync(dirname(dir), { recursive: true });
  execFileSync('cp', ['-al', base, dir]); // hard links: cheap, and every run in it is read-only
  for (const p of ['CLAUDE.md', '.claude']) {
    rmSync(join(dir, p), { recursive: true, force: true });
    if (existsSync(join(side.dir, p))) cpSync(join(side.dir, p), join(dir, p), { recursive: true });
  }
  // Commit the side's prompt files onto main, so `git status` is clean and the branch starts at main's tip.
  git('-C', dir, 'add', '-A', '--', 'CLAUDE.md', '.claude');
  git('-C', dir, '-c', 'user.name=replay', '-c', 'user.email=replay@localhost', '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '--allow-empty', '--no-verify', '-m', 'Prompt files under test');
  git('-C', dir, 'branch', '-q', '-f', 'main', 'HEAD');
  if (c.role === 'taskmaster')
    git('-C', dir, 'checkout', '-q', 'main'); // the Taskmaster works in the repo on main
  else {
    onTicketBranch(dir, c.ticket.number);
    // The minion's own finished work, for a moment that hinges on it (a ship): a child of `commit`, on the ticket branch.
    if (c.work) git('-C', dir, '-c', 'user.name=replay', '-c', 'user.email=replay@localhost', '-c', 'core.hooksPath=/dev/null', 'cherry-pick', c.work);
  }
  return dir;
}

function render(side: Side, role: Case['role'], ticket: Case['ticket'], dirs: object): { system: string; turn: string; tools: object[] } {
  const spec = { role, number: ticket.number, title: ticket.title, type: ticket.type, appText: side.app, schemeText: side.scheme, dirs, drop: side.drop };
  return JSON.parse(execFileSync(process.execPath, [join(HERE, 'render.ts'), side.dir, JSON.stringify(spec)], { encoding: 'utf8', maxBuffer: 64 << 20 }));
}

/** What every claude -p run of this process cost, failed ones too: main books it once when the command ends. */
let spent = 0;

/** Books an eval's cost on the minion whose turn ran it (report_spend's route, #839); outside a turn (no COORDINATOR_* env) it books nothing. */
export async function bookSpend(usd: number, env: Record<string, string | undefined> = process.env, post: typeof fetch = fetch): Promise<boolean> {
  const { COORDINATOR_API: url, COORDINATOR_TOKEN: token, COORDINATOR_TICKET: ticket } = env;
  if (!(usd > 0)) return false;
  if (!url || !token || !ticket) {
    console.error(`Not booked: the eval cost $${usd.toFixed(2)}, but there is no COORDINATOR_* env (outside a turn, or run through citadel-job).`);
    return false;
  }
  try {
    const res = await post(`${url.replace(/\/$/, '')}/api/tickets/${ticket}/spend`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ service: 'claude-prompt-eval', usd: Math.round(usd * 10_000) / 10_000, note: "tools/prompt-eval's claude -p runs, which no turn counts" }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) console.error(`Could not book the eval's $${usd.toFixed(2)}: the server said ${res.status}`);
    return res.ok;
  } catch (e) {
    console.error(`Could not book the eval's $${usd.toFixed(2)}: ${String((e as Error)?.message ?? e)}`);
    return false;
  }
}

/** One claude -p turn: its transcript to `file`, and its cost or the reason it failed. */
function claude(args: string[], input: string, cwd: string, file: string, tmp: string, timeoutMs: number): Promise<{ stream: string; cost: number; error?: string }> {
  return new Promise((done) => {
    const p = spawn('claude', args, { cwd, env: cleanEnv(tmp), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '',
      err = '';
    const t = setTimeout(() => p.kill('SIGTERM'), timeoutMs);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => {
      clearTimeout(t);
      writeFileSync(file, out);
      const result = out
        .split('\n')
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .findLast((m) => m?.type === 'result');
      const cost = Number(result?.total_cost_usd ?? 0);
      spent += cost;
      // A run that hit its turn or budget cap still made its moves: score it. Only no result at all is an error.
      if (!result) return done({ stream: out, cost, error: `claude exited ${code} with no result: ${err.trim().slice(-300)}` });
      done({ stream: out, cost });
    });
    p.stdin.end(input);
  });
}

/** The message a turn gets: the turn note and the history as System lines, then the person's words (as promptMessage frames them). */
const opening = (turn: string, history: string, from: string, message: string) => [turn && `[System]: ${turn}`, history && `[System]: Earlier in this chat (a summary of what you knew; the replay starts at the next message): ${history}`, `[${from}]: ${message}`].filter(Boolean).join('\n\n');

function transcriptText(ev: Event[]): string {
  return ev
    .map((e) => (e.call ? `CALL ${e.call} ${e.input!.slice(0, 400)}` : `SAID ${e.text!.slice(0, 1500)}`))
    .join('\n')
    .slice(0, 12_000);
}

/** The Sonnet judge's one-line read of a rerun. It advises; the checks decide. */
async function judge(c: Case, ev: Event[], dir: string, tmp: string): Promise<string> {
  const ask = [
    `A ${c.role} in Citadel (a web app that runs Claude Code sessions for a small team) got this message from ${c.from}:`,
    c.message.slice(0, 3000),
    `The right move: ${c.right}`,
    `What the original turn did wrong: ${c.wrong}`,
    'What the rerun did (its tool calls and what it said):',
    transcriptText(ev),
    'Did the rerun make the right move, and avoid the wrong one? Answer with PASS or FAIL, then a dash and one short sentence why.',
  ].join('\n\n');
  const r = await claude(['-p', '--model', 'sonnet', '--effort', 'low', '--tools', '', '--max-turns', '1', '--output-format', 'stream-json', '--verbose', '--setting-sources', '', '--strict-mcp-config', '--no-session-persistence'], ask, tmp, join(dir, 'judge.jsonl'), tmp, 120_000);
  const text = events(r.stream)
    .map((e) => e.text ?? '')
    .join(' ')
    .trim();
  return r.error ? 'judge failed' : text.split('\n')[0].slice(0, 200);
}

/** The kit's big-read guard, which a real turn runs inside src/hook-run.ts and a side's kit no longer lists in its hooks.json (#1296); none when the side's kit still lists it itself. */
function bigRead(sideDir: string): object[] {
  const hooks = join(sideDir, 'kit', 'hooks');
  if (!existsSync(join(hooks, 'big-read.ts')) || readFileSync(join(hooks, 'hooks.json'), 'utf8').includes('big-read.ts')) return [];
  return [{ matcher: '^(Read|Bash)$', hooks: [{ type: 'command', command: `'${process.execPath}' '${join(hooks, 'big-read.ts')}'`, timeout: 10 }] }];
}

async function runCase(c: Case, side: Side, i: number, work: string, budget: number, withJudge: boolean): Promise<Run> {
  const dir = join(work, 'runs', c.id, `${side.label}-${i}`);
  const tmp = join(dir, 'tmp');
  mkdirSync(tmp, { recursive: true });
  const cwd = workspace(c, side, work);
  const p = render(side, c.role, c.ticket, { files: join(dir, 'files'), shared: join(work, 'shared'), tickets: join(work, 'tickets'), cwd });
  const server = c.role === 'taskmaster' ? 'coordinator' : 'thread';
  writeFileSync(join(dir, 'system.md'), p.system);
  writeFileSync(join(dir, 'tools.json'), JSON.stringify(p.tools));
  writeFileSync(join(dir, 'facts.json'), JSON.stringify(c.facts));
  writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ mcpServers: { [server]: { command: process.execPath, args: [join(HERE, 'stub.ts')], env: { STUB_TOOLS: join(dir, 'tools.json'), STUB_FACTS: join(dir, 'facts.json'), STUB_ROLE: server } } } }));
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: `'${process.execPath}' '${join(HERE, 'guard.ts')}'`, timeout: 10 }] }, ...bigRead(side.dir)] } }));
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    'bypassPermissions',
    '--append-system-prompt-file',
    join(dir, 'system.md'),
    '--settings',
    join(dir, 'settings.json'),
    '--setting-sources',
    'project',
    '--plugin-dir',
    join(side.dir, 'kit'),
    '--model',
    side.model,
    '--effort',
    side.effort,
    '--mcp-config',
    join(dir, 'mcp.json'),
    '--strict-mcp-config',
    '--max-turns',
    '25',
    '--max-budget-usd',
    String(budget),
    '--no-session-persistence',
    '--disallowedTools',
    ...DISALLOWED,
  ];
  const r = await claude(args, opening(p.turn, c.history, c.from, c.message), cwd, join(dir, 'transcript.jsonl'), tmp, 15 * 60_000);
  if (r.error) return { ok: false, error: r.error, failed: [], cost: r.cost, file: join(dir, 'transcript.jsonl') };
  const ev = events(r.stream);
  const failed = failures(c, ev);
  return { ok: !failed.length, failed, cost: r.cost, judge: withJudge ? await judge(c, ev, dir, tmp) : undefined, file: join(dir, 'transcript.jsonl') };
}

async function pool<T>(jobs: number, tasks: (() => Promise<T>)[]): Promise<T[]> {
  const out: T[] = new Array(tasks.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(jobs, tasks.length) }, async () => {
      while (next < tasks.length) {
        const i = next++;
        out[i] = await tasks[i]();
      }
    }),
  );
  return out;
}

function report(cases: Case[], sides: Side[], runs: Map<string, Run[]>, n: number): { text: string; fallen: string[] } {
  const [now, base] = sides;
  const count = (id: string, s: Side) => (runs.get(`${id}|${s.label}`) ?? []).filter((r) => r.ok).length;
  const cost = [...runs.values()].flat().reduce((a, r) => a + r.cost, 0);
  const rate = (s: Side) => {
    const p = cases.filter((c) => passes(count(c.id, s), n)).length;
    return `${p}/${cases.length} (${Math.round((100 * p) / cases.length)}%)`;
  };
  const fallen = base ? cases.filter((c) => fell(count(c.id, now), count(c.id, base))).map((c) => c.id) : [];
  const lines = [
    `# Prompt eval, ${pst()}`,
    '',
    ...sides.map((s) => `- **${s.label}:** ${s.name}, ${s.model} at ${s.effort}: ${rate(s)} of cases pass (most of ${n} runs).`),
    ...(base ? [`- **Fell** (passing runs down by 2 or more): ${fallen.length ? fallen.join(', ') : 'none'}.${fallen.length >= 2 ? " **2 or more fell: high risk, ships only on a member's go.**" : ''}`] : []),
    `- Cost: $${cost.toFixed(2)}. Errors: ${[...runs.values()].flat().filter((r) => r.error).length}.`,
    '',
    `| Case | Kind | ${sides.map((s) => s.label).join(' | ')} | Judge (${now.label}) | Failed checks (${now.label}) |`,
    `|---|---|${sides.map(() => '---|').join('')}---|---|`,
  ];
  for (const c of cases) {
    const mine = runs.get(`${c.id}|${now.label}`) ?? [];
    const judged = mine.filter((r) => r.judge);
    const whys = [...new Set(mine.flatMap((r) => (r.error ? ['(error) ' + r.error.slice(0, 80)] : r.failed)))].join('; ');
    const cell = (s: Side) => `${count(c.id, s)}/${n}${fallen.includes(c.id) && s === now ? ' ⬇' : ''}`;
    lines.push(`| ${c.id} | ${c.kind} | ${sides.map(cell).join(' | ')} | ${judged.length ? `${judged.filter((r) => /^\W*PASS/i.test(r.judge!)).length}/${judged.length} pass` : ''} | ${whys.replace(/\|/g, '/')} |`);
  }
  return { text: lines.join('\n') + '\n', fallen };
}

// ---- Whole reruns of closed bug fixes (briefs/) ----

function testsPass(dir: string, b: Brief, tmp: string): boolean {
  for (const t of b.tests) {
    mkdirSync(dirname(join(dir, t)), { recursive: true });
    writeFileSync(join(dir, t), git('-C', REPO, 'show', `${b.fix}:${t}`));
  }
  try {
    execFileSync(process.execPath, ['--test', ...b.tests], { cwd: dir, env: cleanEnv(tmp), stdio: 'ignore', timeout: 300_000 });
    return true;
  } catch {
    return false;
  }
}

async function runBrief(b: Brief, side: Side, i: number, work: string, budget: number): Promise<{ ok: boolean; cost: number; error?: string }> {
  const dir = join(work, 'briefs', `${b.id}-${i}`);
  const tmp = join(dir, 'tmp');
  mkdirSync(tmp, { recursive: true });
  const cwd = clone(b.before, join(dir, 'repo'));
  onTicketBranch(cwd, b.ticket.number);
  const p = render(side, 'minion', b.ticket, { files: join(dir, 'files'), shared: join(dir, 'shared'), tickets: join(work, 'tickets'), cwd });
  writeFileSync(join(dir, 'system.md'), p.system);
  writeFileSync(join(dir, 'tools.json'), JSON.stringify(p.tools));
  writeFileSync(join(dir, 'facts.json'), '[]');
  writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ mcpServers: { thread: { command: process.execPath, args: [join(HERE, 'stub.ts')], env: { STUB_TOOLS: join(dir, 'tools.json'), STUB_FACTS: join(dir, 'facts.json'), STUB_ROLE: 'thread' } } } }));
  // The tripwire every real turn gets (src/turn-launch.ts), so a rerun that writes can't reach the live app or data.
  const trip = { home: homedir(), data: join(homedir(), '.local/share/claude-coordinator'), checkout: join(homedir(), 'claude-coordinator'), project: 2, claudeConfig: process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), ask: false };
  writeFileSync(
    join(dir, 'settings.json'),
    JSON.stringify({ hooks: { PreToolUse: [{ matcher: '^(Bash|Read|Write|Edit|MultiEdit|NotebookEdit|Grep|Glob|Skill)$', hooks: [{ type: 'command', command: [process.execPath, join(REPO, 'src/tripwire.ts'), JSON.stringify(trip)].map((s) => `'${s}'`).join(' '), timeout: 10 }] }, ...bigRead(side.dir)] } }),
  );
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    'bypassPermissions',
    '--append-system-prompt-file',
    join(dir, 'system.md'),
    '--settings',
    join(dir, 'settings.json'),
    '--setting-sources',
    'project',
    '--plugin-dir',
    join(side.dir, 'kit'),
    '--model',
    side.model,
    '--effort',
    side.effort,
    '--mcp-config',
    join(dir, 'mcp.json'),
    '--strict-mcp-config',
    '--max-turns',
    '200',
    '--max-budget-usd',
    String(budget),
    '--no-session-persistence',
    '--disallowedTools',
    ...DISALLOWED,
  ];
  const r = await claude(args, opening(p.turn, '', b.from, b.message), cwd, join(dir, 'transcript.jsonl'), tmp, 60 * 60_000);
  if (r.error) return { ok: false, cost: r.cost, error: r.error };
  return { ok: testsPass(cwd, b, tmp), cost: r.cost };
}

// ---- Snapshot: today's instructions, from a turn's system-prompt.md ----

export function snapshot(text: string): { app: string; scheme: string } {
  const lines = text.split('\n');
  const at = (h: RegExp) => lines.findIndex((l) => h.test(l));
  const app = at(/^# Citadel-wide instructions$/),
    scheme = at(/^# Scheme instructions for /);
  if (app < 0 || scheme < 0) throw new Error('no "# Citadel-wide instructions" or "# Scheme instructions for" heading');
  // Each section: its heading, one line on precedence, a blank, then the text. The scheme settings' own lines
  // (Fable, grilling, GitHub runners) sit after the Citadel-wide text; render.ts adds them back from the settings.
  let end = scheme;
  while (end > app && !/^## /.test(lines[end - 1] ?? '') && /\(set in its Minion rules|^$/.test(lines[end - 1])) end--;
  const appText = lines
    .slice(app + 3, end)
    .join('\n')
    .trim();
  let schemeEnd = lines.length;
  const next = lines.findIndex((l, i) => i > scheme && /^# /.test(l));
  if (next > 0) schemeEnd = next;
  return {
    app: appText + '\n',
    scheme:
      lines
        .slice(scheme + 3, schemeEnd)
        .join('\n')
        .trim() + '\n',
  };
}

const HELP = `Prompt evals (#1117): rerun frozen corrections against a prompt version or a tier. tools/prompt-evals/README.md.

  tools/prompt-eval run [flags]          opening moves on cases/ (each case --runs times)
    --ref <ref>          the prompt version to test (default: the working tree)
    --base <ref>         also run this version and list the cases that fell
    --model, --effort    the tier to test (default opus, high)
    --base-model, --base-effort   the base's tier (a tier question: same prompt, two tiers)
    --app <file>, --scheme <file>  the Citadel-wide / scheme instructions (default fixture/; the base keeps fixture/)
    --drop <file>        take text out of the tested side only: {"parts":[...],"lines":[...],"tools":[...]} (README, Ablation)
    --case <re>          only cases whose id matches
    --runs <n> (3)  --jobs <n> (3)  --budget <usd per run> (2)  --no-judge  --out <file>  --keep
  tools/prompt-eval briefs [--brief <re>] [--model m] [--effort e] [--ref r] [--runs 1] [--jobs 2] [--budget 10]
                                         whole reruns of closed bug fixes; pass = the fix's shipped tests go green
  tools/prompt-eval check-briefs         each brief's tests fail at before and pass at fix
  tools/prompt-eval check                every case and brief file parses and its regexes compile
  tools/prompt-eval snapshot <system-prompt.md>   refresh fixture/ from a turn's system prompt

Each run is a real Claude turn on your login: run it in the background, not through citadel-heavy (it waits on Claude, not the CPU).`;

async function main(argv: string[]) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '--help' || cmd === '-h' || rest.includes('--help')) return console.log(HELP);
  const arg = (k: string) => {
    const i = rest.indexOf(k);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const num = (k: string, d: number) => {
    const v = Number(arg(k) ?? d);
    if (!(v > 0)) throw new Error(`${k} takes a number above 0`);
    return v;
  };
  const cases = () => load<Case>(join(HERE, 'cases'), problems);
  const briefs = () => load<Brief>(join(HERE, 'briefs'), briefProblems);

  if (cmd === 'check') return console.log(`${cases().length} cases and ${briefs().length} briefs parse.`);
  if (cmd === 'snapshot') {
    const s = snapshot(readFileSync(rest[0], 'utf8'));
    mkdirSync(join(HERE, 'fixture'), { recursive: true });
    writeFileSync(join(HERE, 'fixture/citadel-wide.md'), s.app);
    writeFileSync(join(HERE, 'fixture/scheme.md'), s.scheme);
    return console.log(`fixture/: Citadel-wide ${s.app.length} characters, scheme ${s.scheme.length}.`);
  }

  const work = join(process.env.TMPDIR ?? '/tmp', `prompt-eval-${Date.now()}`);
  mkdirSync(join(work, 'shared'), { recursive: true });
  const fixture = (f: string) => readFileSync(join(HERE, 'fixture', f), 'utf8');
  const side = (label: string, ref: string | undefined, model: string, effort: string, app = fixture('citadel-wide.md'), scheme = fixture('scheme.md')): Side => ({ label, ...version(ref, work), model, effort, app, scheme });
  const model = arg('--model') ?? 'opus',
    effort = arg('--effort') ?? 'high';
  const only = arg('--case') ?? arg('--brief');
  try {
    if (cmd === 'check-briefs') {
      let bad = 0;
      for (const b of briefs().filter((x) => !only || re(only).test(x.id))) {
        const dir = clone(b.before, join(work, 'cb', b.id));
        const before = testsPass(dir, b, work);
        git('-C', dir, 'checkout', '-q', '-f', '--detach', b.fix);
        const after = testsPass(dir, b, work);
        if (before || !after) bad++;
        console.log(`${b.id}: before ${before ? 'PASSES (no test)' : 'fails'}, fix ${after ? 'passes' : 'FAILS'}`);
      }
      process.exitCode = bad ? 1 : 0;
      return;
    }
    if (cmd === 'briefs') {
      const s = side('now', arg('--ref'), model, effort);
      const n = num('--runs', 1),
        budget = num('--budget', 10);
      const list = briefs().filter((x) => !only || re(only).test(x.id));
      const tasks = list.flatMap((b) => Array.from({ length: n }, (_, i) => () => runBrief(b, s, i, work, budget)));
      const res = await pool(num('--jobs', 2), tasks);
      const lines = [`# Brief reruns, ${pst()}: ${s.name}, ${model} at ${effort}`, '', '| Brief | Passed | Cost | Fix |', '|---|---|---|---|'];
      list.forEach((b, k) => {
        const mine = res.slice(k * n, k * n + n);
        lines.push(`| ${b.id} | ${mine.filter((r) => r.ok).length}/${n}${mine.some((r) => r.error) ? ' (error)' : ''} | $${mine.reduce((a, r) => a + r.cost, 0).toFixed(2)} | ${b.right} |`);
      });
      const total = res.reduce((a, r) => a + r.cost, 0);
      lines.push('', `${res.filter((r) => r.ok).length}/${res.length} runs green; $${total.toFixed(2)}.`);
      const text = lines.join('\n') + '\n';
      if (arg('--out')) writeFileSync(arg('--out')!, text);
      console.log(text);
      process.exitCode = res.some((r) => r.error) ? 1 : 0;
      return;
    }
    if (cmd !== 'run') throw new Error(`unknown command ${cmd}; --help`);
    const n = num('--runs', 3),
      budget = num('--budget', 2);
    const now = side('now', arg('--ref'), model, effort, arg('--app') && readFileSync(arg('--app')!, 'utf8'), arg('--scheme') && readFileSync(arg('--scheme')!, 'utf8'));
    if (arg('--drop')) {
      now.drop = JSON.parse(readFileSync(arg('--drop')!, 'utf8'));
      now.name += `, minus ${JSON.stringify(now.drop)}`;
    }
    const tier = arg('--base-model') || arg('--base-effort');
    const sides = arg('--base') || tier ? [now, side('base', arg('--base') ?? arg('--ref'), arg('--base-model') ?? model, arg('--base-effort') ?? effort)] : [now];
    const list = cases().filter((c) => !only || re(only).test(c.id));
    if (!list.length) throw new Error('no cases match');
    const tasks = list.flatMap((c) =>
      sides.flatMap((s) =>
        Array.from({ length: n }, (_, i) => async () => {
          const r = await runCase(c, s, i, work, budget, s === now && !rest.includes('--no-judge'));
          process.stderr.write(`${c.id} ${s.label}-${i}: ${r.error ? 'error' : r.ok ? 'pass' : 'fail'}\n`);
          return [`${c.id}|${s.label}`, r] as const;
        }),
      ),
    );
    const runs = new Map<string, Run[]>();
    for (const [k, r] of await pool(num('--jobs', 3), tasks)) runs.set(k, [...(runs.get(k) ?? []), r]);
    const { text } = report(list, sides, runs, n);
    const out = arg('--out') ?? join(process.env.TMPDIR ?? '/tmp', 'prompt-eval-report.md');
    writeFileSync(out, text);
    console.log(text + `\nReport: ${out}${rest.includes('--keep') ? `\nTranscripts: ${work}/runs` : ''}`);
    process.exitCode = [...runs.values()].flat().some((r) => r.error) ? 1 : 0;
  } finally {
    if (!rest.includes('--keep')) rmSync(work, { recursive: true, force: true });
    await bookSpend(spent);
  }
}

if (import.meta.main)
  main(process.argv.slice(2)).catch((e) => {
    console.error(String(e?.message ?? e));
    process.exit(1);
  });
