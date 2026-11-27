#!/usr/bin/env node
// Flaky tests' repeat runs in a Claude Code cloud session (#2187, src/cloud-flakes.ts), off perigee's CPU. Run it from a
// minion's turn: the session starts on that turn's own login (sender pays) and draws on that person's plan, about $0.50 for
// each 20 minutes it runs. It takes minutes: run it as a background command in your turn and wait with `citadel-wait pid`.
// Not under `citadel-job`, which leaves out your Claude login and your turn's token: there it refuses.
//
//   tools/cloud-flake.ts proof <test file>... [--copies 10] [--batches 1] [--seconds <one run alone, s>]
//       Your flake proof: each file's batches of <copies> at once under load (tools/flake-proof.sh's shape), all in ONE session,
//       on your branch's committed tip (pushed to a scratch branch for it, deleted after). Exits 0 when every batch was clean.
//       It runs at home instead (tools/burn-in.sh, a heavy slot, at most 4 copies) when you have no cloud setup (no `claude`,
//       a repo not on GitHub, CITADEL_CLOUD=0, Citadel's cloud helpers switch off (an admin's, off by default), or a session
//       that won't start: your claude.ai account needs GitHub connected),
//       for a file whose batch won't fit a 25-minute step (by --seconds: one run alone × copies / 2), and for a file the cloud
//       stopped at its step limit or skipped a test on (a tool the VM lacks: it proves nothing there).
//       A clean cloud proof is your own evidence; the fix's held proof is still flake-proof.yml (the Test health tab's count).
//   tools/cloud-flake.ts sweep [--files 10] [--copies 10] [--no-post]
//       The nightly sweep (a schedule's minion runs it): the scheme's flakiest files of 14 days, one batch each, on main's tip
//       on GitHub; the night (results, sessions × minutes, its cost) goes to the Test health tab, and each flaky file there
//       becomes a cloud sighting, marked cloud-only, which never refuses a ship or starts a fix minion. Exits 1 when a
//       picked file came back with no result (the night says which). While the cloud helpers switch is off it runs nothing.
//
// The session runs tools/cloud-flake-vm.sh's steps, each under 25 minutes, and pushes its results to a cloud/ branch, which
// src/cloud-turn.mjs (the same driver a cloud turn uses) reads back and deletes. Citadel's repo only: the VM script runs node tests.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLOUD, cloudBranch } from '../src/cloud-pool.ts';
import { cloudCostUsd, HELPERS_OFF, readNight, SWEEP, type SweepFile } from '../src/cloud-flakes.ts';
import { githubRepo } from '../src/github.ts';
import { jsonLines } from '../src/json-lines.ts';

const tools = dirname(fileURLToPath(import.meta.url));
const repo = join(tools, '..');
/** The longest a batch may run on the VM: the 30-minute default on one background command, less a margin. Not CLOUD.stepMinutes'
 * 2 hours: a foreground command moved to the background at 10 minutes is never given a longer timeout. */
const STEP_MIN = 25;
const STEP_S = STEP_MIN * 60;

export interface Plan {
  ref: string;
  steps: string[];
  branch: string;
}

/** What the session is told to run: fetch the ref, set up, one batch a step, push. */
export function sessionText(p: Plan, nodeMajor: string): string {
  const cmds = [`git fetch -q --depth=1 origin ${p.ref} && git checkout -q --detach FETCH_HEAD`, `bash tools/cloud-flake-vm.sh setup ${nodeMajor}`, ...p.steps, `bash tools/cloud-flake-vm.sh finish ${p.branch}`];
  return [
    "You are a test runner for Citadel, a web app that runs Claude Code sessions. Run these shell commands from the repo's root, one at a time, in order, and nothing else. Don't read, fix or investigate code or a failure: a failing test run is the result being measured, so go on to the next command.",
    `Run each in the foreground with a 10-minute timeout; one still running then, wait for in the background (none takes over ${STEP_MIN} minutes).`,
    cmds.map((c, i) => `${i + 1}. \`${c}\``).join('\n'),
    'After the last one, stop. If it printed a CITADEL-RESULT-BEGIN line, repeat everything from that line to CITADEL-RESULT-END as your last message.',
  ].join('\n\n');
}

/** A batch's step for the VM. Paths are checked first: they go into a shell command. */
export function batchStep(file: string, copies: number): string {
  if (!/^[A-Za-z0-9_./-]+\.test\.[cm]?[jt]s$/.test(file) || file.split('/').includes('..')) throw new Error(`not a test file path: ${file}`);
  return `bash tools/cloud-flake-vm.sh run ${file} ${copies}`;
}

/** Whether a file's batch fits one step, from one run alone: copies at once on 4 vCPU beside 2 load burners run about two at a time. */
export const fits = (seconds: number | null, copies: number) => seconds == null || (seconds * copies) / 2 <= STEP_S;

/** The batches a session sent back (its flake.jsonl), each line checked as the server checks a night's. */
export function readBatches(text: string): SweepFile[] {
  const rows = text
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as unknown;
      } catch {
        return null;
      }
    });
  const night = readNight({ sessions: 1, minutes: 0, files: rows.filter(Boolean) }, null, 0);
  if (typeof night === 'string') throw new Error(`the session's results don't read: ${night}`);
  return night.files;
}

interface Ran {
  batches: SweepFile[] | null;
  started: boolean;
  minutes: number;
  error: string | null;
  sha: string | null;
}

/** Run one session to its result through src/cloud-turn.mjs. */
async function session(p: Plan): Promise<Ran> {
  const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'cloud-flake-'));
  const job = {
    claude: 'claude',
    cwd: repo,
    branch: p.branch,
    session: null,
    sha: null,
    text: sessionText(p, process.versions.node.split('.')[0]),
    files: join(dir, 'files'),
    model: 'sonnet',
    effort: 'low',
    cost: CLOUD.costUsd.start,
    limitMs: (15 + p.steps.length * STEP_MIN) * 60_000,
    pollMs: CLOUD.pollMs,
    startMs: CLOUD.startMs,
  };
  writeFileSync(join(dir, 'job.json'), JSON.stringify(job));
  const began = Date.now();
  let started = false;
  let result: { is_error?: boolean; result?: string } | null = null;
  const child = spawn(process.execPath, [join(repo, 'src', 'cloud-turn.mjs'), join(dir, 'job.json')], { cwd: repo, stdio: ['ignore', 'pipe', 'inherit'] });
  jsonLines<{ type?: string; subtype?: string; session?: string; url?: string; is_error?: boolean; result?: string; message?: { content?: { text?: string }[] } }>(child.stdout, (ev) => {
    if (ev.type === 'system' && ev.subtype === 'cloud' && ev.session && !started) {
      started = true;
      console.log(`cloud-flake: session ${ev.url ?? ev.session}, results on ${p.branch}`);
    } else if (ev.type === 'assistant') {
      for (const c of ev.message?.content ?? []) if (c.text) console.log(`cloud-flake: ${c.text.split('\n')[0].slice(0, 300)}`);
    } else if (ev.type === 'result') result = ev;
  });
  const stop = () => child.kill('SIGTERM');
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  await new Promise((r) => child.once('exit', r));
  const minutes = (Date.now() - began) / 60_000;
  const file = join(dir, 'files', 'flake.jsonl');
  try {
    const r = result as { is_error?: boolean; result?: string } | null;
    const batches = existsSync(file) ? readBatches(readFileSync(file, 'utf8')) : null;
    const sha = /Cloud flake run at ([0-9a-f]{40})/.exec(r?.result ?? '')?.[1] ?? null;
    return { batches, started: started || !!batches, minutes, sha, error: batches ? null : (r?.result ?? 'the session ended with no result').slice(0, 600) };
  } finally {
    rmSync(dir, { recursive: true, force: true }); // timing-ok: own temp dir
  }
}

const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** Why this turn can't use the cloud at all, or null. */
function noCloud(): string | null {
  if (process.env.CITADEL_CLOUD === '0') return 'CITADEL_CLOUD=0';
  if (process.env.CITADEL_JOB) throw new Error("run it as a background command in your turn, not under citadel-job, which leaves out your Claude login (a session there would run on someone else's) and your turn's token");
  if (spawnSync('sh', ['-c', 'command -v claude'], { stdio: 'ignore' }).status !== 0) return 'no claude CLI here';
  if (!githubRepo(git('remote', 'get-url', 'origin'))) return "this repo's origin isn't on GitHub, where a session clones it";
  return null;
}

/**
 * Why Citadel's cloud helpers switch keeps this run at home (HELPERS_SWITCH, src/cloud-flakes.ts: off unless an admin set it on;
 * Cara, 2026-11-27, "Ship dark, switch off"), or null when it's on. A minion's turn asks the server; outside one (a person by
 * hand) there's no switch to read, so it's off. `failed`: the switch couldn't be read, so it counts as off.
 */
export async function helpersOff(read = () => api('cloud-helpers/switch')): Promise<{ why: string; failed: boolean } | null> {
  if (!process.env.COORDINATOR_API || !process.env.COORDINATOR_TICKET) return { why: "outside a minion's turn there's no cloud helpers switch to read", failed: false };
  try {
    return ((await read()) as { on?: unknown }).on === true ? null : { why: HELPERS_OFF, failed: false };
  } catch (err) {
    return { why: `couldn't read the cloud helpers switch: ${(err as Error).message}`, failed: true };
  }
}

/** What starts or touches a cloud run, swapped out by tests (test/cloud-flakes.test.ts: none of it may run while the switch is off). */
export const io = {
  noCloud: () => noCloud(),
  helpersOff: () => helpersOff(),
  home: (files: string[], copies: number, why: string) => home(files, copies, why),
  push: (src: string) => git('push', '-q', 'origin', `HEAD:refs/heads/${src}`),
  drop: (src: string) => git('push', '-q', 'origin', '--delete', src),
  start: (p: Plan) => session(p),
};

function home(files: string[], copies: number, why: string): boolean {
  let ok = true;
  for (const f of files) {
    const n = Math.min(copies, 4);
    console.log(`cloud-flake: ${f} runs at home (${why}): tools/burn-in.sh ${f} ${n}`);
    ok = spawnSync(join(tools, 'burn-in.sh'), [f, String(n)], { cwd: repo, stdio: 'inherit' }).status === 0 && ok;
  }
  return ok;
}

const line = (b: SweepFile) => `cloud-flake: ${b.file}: ${b.verdict}, ${b.failed} of ${b.copies} copies failed, ${b.seconds} s${b.verdict !== 'clean' && b.detail ? `\n${b.detail}` : ''}`;
const costLine = (minutes: number) => `cloud-flake: 1 session × ${minutes.toFixed(1)} min ≈ $${cloudCostUsd(minutes).toFixed(2)} of your plan's usage (an estimate: a session's start at least, else about $0.50 per 20 minutes)`;

/**
 * A proof's cloud batches judged: `again`, the files to run at home because the cloud proved nothing about them (a batch
 * stopped, skipped or missing, and none failed), and `clean`, whether every other batch passed. A failure seen stands.
 */
export function judge(files: string[], batches: number, ran: SweepFile[]): { again: string[]; clean: boolean } {
  const of = (f: string) => ran.filter((b) => b.file === f);
  const unproven = (b: SweepFile) => b.verdict === 'stopped' || b.verdict === 'skipped';
  const again = files.filter((f) => of(f).every((b) => b.verdict === 'clean' || unproven(b)) && (of(f).length < batches || of(f).some(unproven)));
  return { again, clean: ran.every((b) => b.verdict === 'clean' || (unproven(b) && again.includes(b.file))) };
}

export async function proof(files: string[], copies: number, batches: number, seconds: number | null): Promise<number> {
  for (const f of files) if (!existsSync(join(repo, f))) throw new Error(`no such file: ${f}`);
  const off = (await io.helpersOff())?.why ?? io.noCloud();
  if (off) return io.home(files, copies, off) ? 0 : 1;
  const tooBig = files.filter((f) => !fits(seconds, copies));
  const cloud = files.filter((f) => !tooBig.includes(f));
  let ok = !tooBig.length || io.home(tooBig, copies, `a batch of ${copies} would run over a ${STEP_MIN}-minute step`);
  if (!cloud.length) return ok ? 0 : 1;
  if (git('status', '--porcelain', '--untracked-files=no')) console.log('cloud-flake: uncommitted changes stay here: the session runs your last commit');
  const id = Number(process.env.COORDINATOR_TICKET) || 0;
  const src = `cloud/src-t${id}-${Date.now().toString(36)}`;
  io.push(src);
  try {
    const ran = await io.start({ ref: src, branch: cloudBranch(id, Date.now()), steps: cloud.flatMap((f) => Array.from({ length: batches }, () => batchStep(f, copies))) });
    if (!ran.batches) {
      console.log(`cloud-flake: no results from the cloud: ${ran.error}`);
      if (ran.started) console.log(costLine(ran.minutes));
      return io.home(cloud, copies, 'the cloud session gave no results') && ok ? 0 : 1;
    }
    for (const b of ran.batches) console.log(line(b));
    console.log(costLine(ran.minutes));
    const { again, clean } = judge(cloud, batches, ran.batches);
    ok = clean && ok;
    if (again.length) ok = io.home(again, copies, 'the cloud stopped it, skipped a test or ran fewer batches') && ok;
    console.log(`cloud-flake: ${ok ? 'every batch clean' : 'not clean'}`);
    return ok ? 0 : 1;
  } finally {
    try {
      io.drop(src);
    } catch (err) {
      console.log(`cloud-flake: couldn't delete ${src}: ${(err as Error).message}`);
    }
  }
}

async function api(path: string, body?: unknown): Promise<unknown> {
  const base = process.env.COORDINATOR_API;
  if (!base || !process.env.COORDINATOR_TICKET) throw new Error("the sweep runs in a minion's turn (no COORDINATOR_API here)");
  const res = await fetch(`${base}/api/tickets/${process.env.COORDINATOR_TICKET}/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${process.env.COORDINATOR_TOKEN ?? ''}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/** `post` false: print the night instead of posting it. CLOUD_FLAKE_REF: sweep another branch on origin (a try of a change to the VM script before it reaches main). */
export async function sweep(n: number, copies: number, post: boolean): Promise<number> {
  const switched = await io.helpersOff();
  if (switched) {
    console.log(`cloud-flake: no sweep tonight: ${switched.why}; nothing ran`);
    return switched.failed ? 1 : 0;
  }
  const off = io.noCloud();
  if (off) throw new Error(`the sweep runs only in the cloud: ${off}`);
  if (post && !process.env.COORDINATOR_TOKEN) throw new Error("no turn token here to post the night with: run it in a minion's turn, or with --no-post");
  git('fetch', '-q', 'origin', process.env.CLOUD_FLAKE_REF || 'main');
  const onMain = new Set(git('ls-tree', '-r', '--name-only', 'FETCH_HEAD', 'test').split('\n'));
  // CLOUD_FLAKE_PICKS (comma-separated): sweep these instead of the scheme's flakiest, for a try of the sweep itself.
  const listed = process.env.CLOUD_FLAKE_PICKS?.split(',').filter(Boolean);
  const picks = (listed ?? ((await api(`cloud-sweep/picks?n=${n}`)) as { files: string[] }).files).filter((f) => onMain.has(f));
  if (!picks.length) {
    console.log('cloud-flake: no flaky file in 14 days to sweep; nothing ran');
    return 0;
  }
  const id = Number(process.env.COORDINATOR_TICKET) || 0;
  console.log(`cloud-flake: sweeping ${picks.length} files × ${copies} copies on ${process.env.CLOUD_FLAKE_REF || 'main'}: ${picks.join(', ')}`);
  const ref = process.env.CLOUD_FLAKE_REF || 'main';
  const ran = await io.start({ ref, branch: cloudBranch(id, Date.now()), steps: picks.map((f) => batchStep(f, copies)) });
  for (const b of ran.batches ?? []) console.log(line(b));
  console.log(costLine(ran.minutes));
  const missing = ran.batches ? picks.filter((f) => !ran.batches!.some((b) => b.file === f)) : [];
  const error = ran.batches ? (missing.length ? `${missing.length} of ${picks.length} files came back with no result: ${missing.join(', ')}` : null) : ran.error;
  if (missing.length) console.log(`cloud-flake: ${error}`);
  const night = { sha: ran.sha, sessions: ran.started ? 1 : 0, minutes: ran.started ? ran.minutes : 0, files: ran.batches ?? [], error };
  if (!post) {
    console.log(`cloud-flake: not posted (--no-post): ${JSON.stringify(night)}`);
    return error ? 1 : 0;
  }
  const saved = (await api('cloud-sweep', night)) as { sightings: number };
  console.log(`cloud-flake: the night is on the Test health tab; ${saved.sightings} cloud sighting(s) recorded${error ? `; ${error}` : ''}`);
  return error ? 1 : 0;
}

/** A count flag (`whole`, the default) or a measure; either must be positive. */
export function flag(args: string[], name: string, fallback: number | null, whole = true): number | null {
  const at = args.indexOf(name);
  if (at < 0) return fallback;
  const v = Number(args.splice(at, 2)[1]);
  if (!(whole ? Number.isInteger(v) : Number.isFinite(v)) || v <= 0) throw new Error(`${name} takes a positive ${whole ? 'whole ' : ''}number`);
  return v;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [mode, ...args] = process.argv.slice(2);
  const run = async () => {
    if (mode === 'proof') {
      const copies = flag(args, '--copies', SWEEP.copies)!;
      const batches = flag(args, '--batches', 1)!;
      const seconds = flag(args, '--seconds', null, false);
      if (!args.length) throw new Error('proof needs a test file');
      return proof(args, Math.min(copies, 20), Math.min(batches, 10), seconds);
    }
    if (mode === 'sweep') return sweep(Math.min(flag(args, '--files', SWEEP.files)!, 50), Math.min(flag(args, '--copies', SWEEP.copies)!, 20), !args.includes('--no-post'));
    console.log(
      readFileSync(fileURLToPath(import.meta.url), 'utf8')
        .split('\n')
        .slice(1, 23)
        .join('\n')
        .replace(/^\/\/ ?/gm, ''),
    );
    return mode === '--help' || mode === '-h' ? 0 : 2;
  };
  run().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`cloud-flake: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    },
  );
}
