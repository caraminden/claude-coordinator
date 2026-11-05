#!/usr/bin/env node
// Citadel's CI runner agent (#328; Josh, 2026-11-05: "Citadel installs it itself"). It runs elevated, as SYSTEM, on
// the PC that hosts every scheme's self-hosted GitHub Actions runners (Cara's desktop), and does exactly three
// things when Citadel asks: add a scheme's runners, list the runner services, remove a scheme's runners. Each is a
// PowerShell script installed next to this file (add-runner.ps1, list-runners.ps1, remove-runner.ps1); it runs only
// those, with arguments it checks itself, one job at a time, and never downloads code. The scripts fetch their own
// GitHub tokens from Citadel and never keep them; this file never sees one. It serves no MCP server, no workspace,
// no shell, and never restarts the PC.
//
//   node runner-agent.mjs <machines url> --token-file <file> [--log <file>]
//
// It dials out to Citadel like the machine agent (public/machine-agent.mjs) and holds an event stream open, so the
// PC needs no open port. tools/ci-runner/install-runner-agent.ps1 installs it; tools/ci-runner/README.md says how.
import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_RUNNERS = 4;
const JOB_LIMIT_MS = 15 * 60_000;
const TAIL_LINES = 200;
const SCRIPTS = { add: 'add-runner.ps1', list: 'list-runners.ps1', remove: 'remove-runner.ps1' };

/** The job Citadel sent, checked field by field: anything else is refused, so the scripts only ever get a number or two. */
export function checkJob(job) {
  const keys = Object.keys(job ?? {}).sort().join(',');
  if (typeof job?.id !== 'string' || !/^[0-9a-f]{24}$/.test(job.id)) throw new Error('a job needs its id');
  const scheme = (v) => {
    if (!Number.isInteger(v) || v < 1 || v > 1e9) throw new Error('scheme must be a scheme id');
    return v;
  };
  if (job.op === 'list' && keys === 'id,op') return { id: job.id, op: 'list' };
  if (job.op === 'remove' && keys === 'id,op,scheme') return { id: job.id, op: 'remove', scheme: scheme(job.scheme) };
  if (job.op === 'add' && keys === 'count,id,op,scheme') {
    if (!Number.isInteger(job.count) || job.count < 1 || job.count > MAX_RUNNERS) throw new Error(`count must be 1 to ${MAX_RUNNERS}`);
    return { id: job.id, op: 'add', scheme: scheme(job.scheme), count: job.count };
  }
  throw new Error(`refused: this agent only adds, lists and removes runners (got op ${JSON.stringify(job?.op)} with ${keys || 'nothing'})`);
}

/** What runs for a checked job: Windows PowerShell with the script from this agent's own folder, never a shell. */
export function jobCommand(job, dir, appUrl, systemRoot = process.env.SystemRoot ?? 'C:\\Windows') {
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(dir, SCRIPTS[job.op])];
  if (job.op !== 'list') args.push('-Scheme', String(job.scheme), '-CitadelUrl', appUrl);
  if (job.op === 'add') args.push('-Count', String(job.count));
  return { command: join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), args };
}

/** Output with anything token-shaped blanked: a machine token, a runner registration or removal token, a --token argument. */
export function redact(text) {
  return text
    .replace(/ccm_\d+_[\w-]{20,}/g, 'ccm_…')
    .replace(/(--token\s+)\S+/gi, '$1…')
    .replace(/\bA[A-Z0-9]{28}\b/g, '…')
    .replace(/\bgh[opsu]_\w{20,}/g, '…');
}

/** Run a command, collecting the end of its output; it is killed (with its children) after `limitMs`. */
export function runCommand({ command, args }, env, limitMs = JOB_LIMIT_MS) {
  return new Promise((resolve) => {
    const lines = [];
    const keep = (chunk) => {
      lines.push(...String(chunk).split(/\r?\n/));
      if (lines.length > TAIL_LINES * 2) lines.splice(0, lines.length - TAIL_LINES);
    };
    let child;
    try {
      child = spawn(command, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      return resolve({ code: -1, output: `could not start ${command}: ${err.message}` });
    }
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => {
      keep(`\nStopped after ${Math.round(limitMs / 60_000)} minutes.`);
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      else child.kill();
    }, limitMs);
    child.on('error', (err) => keep(`could not start ${command}: ${err.message}`));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, output: lines.join('\n').trim().split('\n').slice(-TAIL_LINES).join('\n') });
    });
  });
}

/** Jobs one at a time: a second that arrives while one runs is refused, not queued, so nothing runs that nobody waits on. */
export class JobRunner {
  constructor({ dir, appUrl, token, run = runCommand, log = () => {} }) {
    Object.assign(this, { dir, appUrl, token, run, log, busy: null });
  }

  /** The answer for Citadel: { id, ok, output }, output redacted. */
  async handle(raw) {
    let job;
    try {
      job = checkJob(raw);
    } catch (err) {
      this.log(`Refused a job: ${err.message}`);
      return { id: typeof raw?.id === 'string' ? raw.id : '', ok: false, output: `runner agent: ${err.message}` };
    }
    if (this.busy) return { id: job.id, ok: false, output: `runner agent: busy with ${this.busy}; try again when it ends` };
    const what = `${job.op}${job.scheme ? ` for scheme ${job.scheme}` : ''}${job.count ? `, ${job.count} runner(s)` : ''}`;
    this.busy = what;
    this.log(`Job ${what}`);
    try {
      // The scripts ask Citadel for tokens with this machine's token; it goes in their environment, never their arguments.
      const env = { ...process.env, CC_MACHINE_TOKEN: this.token };
      const { code, output } = await this.run(jobCommand(job, this.dir, this.appUrl), env);
      this.log(`Job ${what} ended: exit ${code}`);
      return { id: job.id, ok: code === 0, output: redact(output) };
    } finally {
      this.busy = null;
    }
  }
}

/** Server-sent events from a fetch body, one parsed JSON message per event. */
async function* events(body) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let end;
    while ((end = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, end);
      buf = buf.slice(end + 2);
      const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
      if (data) yield JSON.parse(data);
    }
  }
}

async function main() {
  const opts = process.argv.slice(2);
  const option = (name) => {
    const i = opts.indexOf(name);
    return i < 0 ? null : opts.splice(i, 2)[1];
  };
  const tokenFile = option('--token-file');
  const logFile = option('--log');
  const [appUrl] = opts;
  if (!appUrl || !tokenFile) {
    console.error('Usage: node runner-agent.mjs <machines url> --token-file <file> [--log <file>]');
    process.exit(2);
  }
  const token = readFileSync(tokenFile, 'utf8').trim();
  const log = (...a) => {
    const line = `${new Date().toISOString()} ${a.join(' ')}`;
    console.log(line);
    if (logFile) try { appendFileSync(logFile, `${line}\n`); } catch {}
  };
  const auth = { Authorization: `Bearer ${token}` };
  const jobs = new JobRunner({ dir: dirname(realpathSync(process.argv[1])), appUrl, token, log });

  async function answer(raw) {
    const reply = await jobs.handle(raw);
    try {
      const res = await fetch(new URL('/api/machines/runner-result', appUrl), { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(reply) });
      if (!res.ok) log(`Citadel didn't take the answer to job ${reply.id}: ${res.status}`);
    } catch (err) {
      log(`Couldn't send the answer to job ${reply.id}: ${err.message}`);
    }
  }

  let retry = 0;
  for (;;) {
    try {
      const url = new URL('/api/machines/connect', appUrl);
      url.searchParams.set('host', hostname());
      url.searchParams.set('command', 'citadel runner agent');
      url.searchParams.set('kind', 'runners');
      const res = await fetch(url, { headers: { ...auth, Accept: 'text/event-stream' } });
      if (res.status === 401 || res.status === 403) {
        log(`Citadel refused this agent (${res.status}): ${(await res.json().catch(() => ({}))).error ?? ''} Make a new token on the Machines page and install again.`);
        process.exit(1);
      }
      if (!res.ok) throw new Error(`Citadel answered ${res.status}`);
      for await (const msg of events(res.body)) {
        if (msg.hello) {
          log(`Connected to ${new URL(appUrl).host} as "${msg.hello}": adds, lists and removes CI runners when Citadel asks.`);
          retry = 0;
        } else if (msg.runners) {
          answer(msg.runners);
        }
      }
      throw new Error('the connection closed');
    } catch (err) {
      const wait = Math.min(60, 2 ** retry++);
      log(`Disconnected: ${err.message}. Retrying in ${wait}s.`);
      await new Promise((r) => setTimeout(r, wait * 1000));
    }
  }
}

// Run as a program, not when a test imports it.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
