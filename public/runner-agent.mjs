#!/usr/bin/env node
// Citadel's CI runner agent (#328; Josh, 2026-11-05: "Citadel installs it itself"). It runs elevated, as SYSTEM, on
// the PC that hosts every scheme's self-hosted GitHub Actions runners (Cara's desktop), and does exactly three
// things when Citadel asks: add a scheme's runners, list the runner services, remove a scheme's runners. Each is a
// PowerShell script installed next to this file (add-runner.ps1, list-runners.ps1, remove-runner.ps1); it runs only
// those, with arguments it checks itself, one job at a time, and never downloads code. It also reports the PC's load
// every 30 seconds (#534, the samples below): read-only, through sample-load.ps1 on Windows and /proc on Linux. The scripts fetch their own
// GitHub tokens from Citadel and never keep them; this file never sees one. It serves no MCP server, no workspace,
// no shell, and never restarts the PC.
//
//   node runner-agent.mjs <machines url> --token-file <file> [--log <file>]
//
// The same file runs as root inside a WSL distro on that PC (#510), where it adds Linux runners with bash scripts of the same
// names (add-runner.sh, ...), installed by tools/ci-runner/install-runner-agent.sh.
//
// It dials out to Citadel like the machine agent (public/machine-agent.mjs) and holds an event stream open, so the
// PC needs no open port. tools/ci-runner/install-runner-agent.ps1 installs it; tools/ci-runner/README.md says how.
import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync, readdirSync, readlinkSync, realpathSync, statfsSync } from 'node:fs';
import { cpus, freemem, hostname, totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_RUNNERS = 4;
const JOB_LIMIT_MS = 15 * 60_000;
const TAIL_LINES = 200;
const SCRIPTS = { add: 'add-runner.ps1', list: 'list-runners.ps1', remove: 'remove-runner.ps1' };
// The Linux agent (#510) runs as root inside a WSL distro on the same PC, with bash scripts of the same names.
const LINUX_SCRIPTS = { add: 'add-runner.sh', list: 'list-runners.sh', remove: 'remove-runner.sh' };

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

/** Which runners this agent adds: Linux ones where it runs on Linux (in WSL), Windows services everywhere else. */
export const defaultOs = () => (process.platform === 'linux' ? 'linux' : 'windows');

/** What runs for a checked job: the script from this agent's own folder, in Windows PowerShell, or in bash on Linux (#510); never a shell line. */
export function jobCommand(job, dir, appUrl, systemRoot = process.env.SystemRoot ?? 'C:\\Windows', os = defaultOs()) {
  if (os === 'linux') {
    const args = [join(dir, LINUX_SCRIPTS[job.op])];
    if (job.op !== 'list') args.push(String(job.scheme), appUrl);
    if (job.op === 'add') args.push(String(job.count));
    return { command: '/bin/bash', args };
  }
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
      // Its own process group off Windows (#510), so the time limit ends config.sh and the rest with it.
      child = spawn(command, args, { env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      return resolve({ code: -1, output: `could not start ${command}: ${err.message}` });
    }
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => {
      keep(`\nStopped after ${Math.round(limitMs / 60_000)} minutes.`);
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      else try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill(); }
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
  constructor({ dir, appUrl, token, run = runCommand, log = () => {}, os = defaultOs() }) {
    Object.assign(this, { dir, appUrl, token, run, log, os, busy: null });
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
      const { code, output } = await this.run(jobCommand(job, this.dir, this.appUrl, undefined, this.os), env);
      this.log(`Job ${what} ended: exit ${code}`);
      return { id: job.id, ok: code === 0, output: redact(output) };
    } finally {
      this.busy = null;
    }
  }
}

// ---- Load samples (#534; Josh, 2026-11-11: "can we also monitor the performance impact on my desktop?") ----
// Every 30 seconds the agent posts what the PC is doing to Citadel: whole-PC CPU, memory and disk, each runner's
// share, and on Windows whether a person is there, the Hyper-V guests' share and hard restarts. It only reads.
export const SAMPLE_MS = 30_000;
const SAMPLE_LIMIT_MS = 20_000;
// Asked again this often: the event is written early in a boot, but the agent may start earlier still.
const RESTARTS_EVERY = 60;

/** Idle and total CPU time over every core, in ms: two of these give the CPU % between them. */
export function cpuTimes(list = cpus()) {
  let idle = 0;
  let total = 0;
  for (const c of list) {
    idle += c.times.idle;
    for (const t of Object.values(c.times)) total += t;
  }
  return { idle, total };
}

/**
 * Seconds since the last keyboard or mouse input of whoever is at the PC, from quser's lines: the least idle
 * Active session. 1e6 with nobody logged on or every session disconnected; null when the lines don't read
 * (Citadel then assumes someone is there).
 */
export function personIdle(lines) {
  if (!Array.isArray(lines)) return null;
  let best = null;
  let read = 0;
  for (const line of lines) {
    const m = /\s\d+\s+(\S+)\s+(none|\.|\d+\+\d+:\d+|\d+:\d+|\d+)\s/.exec(` ${line}`);
    if (!m) continue;
    read++;
    if (!/^active$/i.test(m[1])) continue;
    const [, days, hours, mins] = /^(?:(\d+)\+)?(?:(\d+):)?(\d+)$/.exec(m[2]) ?? [];
    const idle = mins === undefined ? 0 : (Number(days ?? 0) * 1440 + Number(hours ?? 0) * 60 + Number(mins)) * 60;
    best = best === null ? idle : Math.min(best, idle);
  }
  // A header alone (or nothing) is nobody logged on; lines that are there but don't parse are a Windows in another language.
  if (best !== null) return best;
  return read || lines.filter((l) => String(l).trim()).length <= 1 ? 1e6 : null;
}

/**
 * Each runner's CPU seconds since the last look and its memory now, from a process list: a runner is a
 * Runner.Listener and everything under it. `procs` are { pid, ppid, path, cpu, mem }; `prev` is the last look's
 * pid → CPU seconds (null on the first, when CPU can't be told yet).
 * shortcut: a process that ended between two looks takes its last seconds with it, so a build made of many short
 * compiler runs reads a little low; exact needs a Windows job object or a cgroup per runner.
 */
export function runnerUse(procs, prev) {
  const kids = new Map();
  for (const p of procs) (kids.get(p.ppid) ?? kids.set(p.ppid, []).get(p.ppid)).push(p);
  const seen = new Map(procs.map((p) => [p.pid, p.cpu]));
  const runners = [];
  for (const root of procs) {
    const m = /^(.*)[\\/]bin[\\/]Runner\.Listener(?:\.exe)?$/i.exec(root.path ?? '');
    if (!m) continue;
    let cpu = 0;
    let mem = 0;
    const done = new Set();
    const walk = [root];
    while (walk.length) {
      const p = walk.pop();
      // A pid used again can point a parent at its own child.
      if (done.has(p.pid)) continue;
      done.add(p.pid);
      const before = prev?.get(p.pid);
      cpu += before === undefined || p.cpu < before ? p.cpu : p.cpu - before;
      mem += p.mem;
      walk.push(...(kids.get(p.pid) ?? []));
    }
    runners.push({ dir: m[1], cpu: prev ? cpu : null, mem });
  }
  return { runners, seen };
}

/** Linux's process list from /proc, as runnerUse reads it. A process that ends mid-read is skipped. */
export function linuxProcs(proc = '/proc') {
  const out = [];
  for (const name of readdirSync(proc)) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(join(proc, name, 'stat'), 'utf8');
      // The command sits in brackets and may hold spaces and brackets: the fields start after its last one.
      const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      let path = '';
      try { path = readlinkSync(join(proc, name, 'exe')); } catch {}
      // utime and stime in ticks of 1/100 s, rss in 4 KB pages: what every Linux the runners use has.
      out.push({ pid: Number(name), ppid: Number(f[1]), path, cpu: (Number(f[11]) + Number(f[12])) / 100, mem: Number(f[21]) * 4096 });
    } catch {}
  }
  return out;
}

/** A runner folder's name and repo on GitHub, from the .runner file its setup wrote; just the folder if it doesn't read. */
function runnerIdentity(dir, read = readFileSync) {
  try {
    const conf = JSON.parse(String(read(join(dir, '.runner'), 'utf8')).replace(/^\uFEFF/, ''));
    return { name: String(conf.agentName ?? ''), repo: String(conf.gitHubUrl ?? '').replace(/^https:\/\/github\.com\//i, '').toLowerCase() };
  } catch {
    return { name: '', repo: '' };
  }
}

/** Takes samples: it remembers the last look, so each sample's percentages cover the time since the one before. */
export class Sampler {
  constructor({ os = defaultOs(), dir, run = runCommand, identity = runnerIdentity, now = Date.now, times = cpuTimes, procs = linuxProcs } = {}) {
    Object.assign(this, { os, dir, run, identity, now, times, procs, last: null, count: 0, names: new Map() });
  }

  /** What only the platform can say: the process list, and on Windows the rest of sample-load.ps1's line. */
  async platform() {
    if (this.os === 'linux') {
      let pressure = null;
      try { pressure = Number(/some avg10=\S+ avg60=([\d.]+)/.exec(readFileSync('/proc/pressure/cpu', 'utf8'))?.[1] ?? NaN); } catch {}
      return { procs: this.procs(), pressure: Number.isFinite(pressure) ? pressure : null };
    }
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(this.dir, 'sample-load.ps1')];
    if (this.count % RESTARTS_EVERY === 0) args.push('-Restarts');
    const { code, output } = await this.run({ command: join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), args }, process.env, SAMPLE_LIMIT_MS);
    if (code !== 0) throw new Error(`sample-load.ps1 ended with exit ${code}: ${output.split('\n').at(-1)}`);
    const raw = JSON.parse(output.split('\n').at(-1));
    return {
      procs: (raw.procs ?? []).map(([pid, ppid, path, cpu, mem]) => ({ pid, ppid, path, cpu, mem })),
      queue: raw.queue ?? null, idle_sec: personIdle(raw.quser), hv: raw.hv ?? null, temp: raw.temp ?? null,
      ...(Array.isArray(raw.restarts) ? { restarts: raw.restarts } : {}),
    };
  }

  /** One sample, or null on the first look of the CPU clock (there is nothing to compare with yet). */
  async take() {
    const { procs, ...rest } = await this.platform();
    this.count++;
    const at = this.now();
    const times = this.times();
    const cores = cpus().length || 1;
    const { runners, seen } = runnerUse(procs, this.last?.seen ?? null);
    const last = this.last;
    this.last = { at, times, seen };
    if (!last || at <= last.at) return null;
    const total = times.total - last.times.total;
    let disk = {};
    try {
      const fs = statfsSync(this.dir);
      disk = { disk_total: fs.blocks * fs.bsize, disk_free: fs.bavail * fs.bsize };
    } catch {}
    return {
      at, host: hostname(), os: this.os, cores,
      cpu: total > 0 ? Math.round((1 - (times.idle - last.times.idle) / total) * 1000) / 10 : 0,
      mem_total: totalmem(), mem_free: freemem(), ...disk, ...rest,
      runners: runners.map((r) => {
        if (!this.names.has(r.dir)) this.names.set(r.dir, this.identity(r.dir));
        // Its share of the whole PC: CPU seconds used, over the seconds every core had.
        return { ...this.names.get(r.dir), dir: r.dir, cpu: Math.round((r.cpu / ((at - last.at) / 1000 * cores)) * 1000) / 10, mem: r.mem };
      }),
    };
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
  // Tests run a Windows agent on Linux; nothing else passes it.
  const os = option('--os') ?? defaultOs();
  if (os !== 'linux' && os !== 'windows') {
    console.error('--os is linux or windows');
    process.exit(2);
  }
  const [appUrl] = opts;
  if (!appUrl || !tokenFile) {
    console.error('Usage: node runner-agent.mjs <machines url> --token-file <file> [--log <file>] [--os linux|windows]');
    process.exit(2);
  }
  const token = readFileSync(tokenFile, 'utf8').trim();
  const log = (...a) => {
    const line = `${new Date().toISOString()} ${a.join(' ')}`;
    console.log(line);
    if (logFile) try { appendFileSync(logFile, `${line}\n`); } catch {}
  };
  const auth = { Authorization: `Bearer ${token}` };
  const jobs = new JobRunner({ dir: dirname(realpathSync(process.argv[1])), appUrl, token, log, os });

  async function answer(raw) {
    const reply = await jobs.handle(raw);
    try {
      const res = await fetch(new URL('/api/machines/runner-result', appUrl), { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(reply) });
      if (!res.ok) log(`Citadel didn't take the answer to job ${reply.id}: ${res.status}`);
    } catch (err) {
      log(`Couldn't send the answer to job ${reply.id}: ${err.message}`);
    }
  }

  // Load samples (#534) go out on their own clock, whatever the stream to Citadel is doing; a failure is said once
  // until one gets through, and never touches a job.
  const sampler = new Sampler({ os, dir: jobs.dir });
  let sampleError = '';
  const sample = async () => {
    try {
      const body = await sampler.take();
      if (body) {
        const res = await fetch(new URL('/api/machines/runner-load', appUrl), { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (!res.ok) throw new Error(`Citadel answered ${res.status}`);
      }
      if (sampleError) log('Load samples are getting through again.');
      sampleError = '';
    } catch (err) {
      if (err.message !== sampleError) log(`Couldn't send a load sample (said once): ${err.message}`);
      sampleError = err.message;
    }
    setTimeout(sample, SAMPLE_MS).unref();
  };
  sample();

  let retry = 0;
  for (;;) {
    try {
      const url = new URL('/api/machines/connect', appUrl);
      url.searchParams.set('host', hostname());
      url.searchParams.set('command', 'citadel runner agent');
      url.searchParams.set('kind', 'runners');
      // Which runners it adds (#510): Citadel sends Linux asks only to a Linux agent.
      url.searchParams.set('os', os);
      const res = await fetch(url, { headers: { ...auth, Accept: 'text/event-stream' } });
      if (res.status === 401 || res.status === 403) {
        log(`Citadel refused this agent (${res.status}): ${(await res.json().catch(() => ({}))).error ?? ''} Make a new token on the Machines page and install again.`);
        process.exit(1);
      }
      if (!res.ok) throw new Error(`Citadel answered ${res.status}`);
      for await (const msg of events(res.body)) {
        if (msg.hello) {
          log(`Connected to ${new URL(appUrl).host} as "${msg.hello}": adds, lists and removes ${os === 'linux' ? 'Linux ' : ''}CI runners when Citadel asks.`);
          retry = 0;
        } else if (msg.replaced) {
          // Another agent took over with this token: trying again at once would drop it, and it this one, forever.
          throw Object.assign(new Error(`another agent connected with this machine's token, from ${msg.by || 'another computer'}; run only one`), { replaced: true });
        } else if (msg.runners) {
          answer(msg.runners);
        }
      }
      throw new Error('the connection closed');
    } catch (err) {
      const wait = err.replaced ? 600 : Math.min(60, 2 ** retry++);
      log(`Disconnected: ${err.message}. Retrying in ${wait}s.`);
      await new Promise((r) => setTimeout(r, wait * 1000));
    }
  }
}

// Run as a program, not when a test imports it.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
