#!/usr/bin/env node
// Citadel's CI runner agent (#328; Josh, 2026-11-05: "Citadel installs it itself"). It runs elevated, as SYSTEM, on
// the PC that hosts every scheme's self-hosted GitHub Actions runners (first Cara's desktop; any PC with the agent), and does exactly three
// things when Citadel asks: add a scheme's runners, list the runner services, remove a scheme's runners. Each is a
// PowerShell script installed next to this file (add-runner.ps1, list-runners.ps1, remove-runner.ps1); it runs only
// those, with arguments it checks itself, one job at a time, and never downloads code. It also reports the PC's load
// every 30 seconds (#534, the samples below): read-only, through sample-load.ps1 on Windows and /proc on Linux. The scripts fetch their own
// GitHub tokens from Citadel and never keep them; this file never sees one. It serves no MCP server, no workspace,
// no shell, and never restarts the PC. On Windows it also keeps keep-runners.ps1 running (#552, below), which holds every
// runner on the PC at below-normal priority and all CI under a CPU cap.
//
//   node runner-agent.mjs <machines url> --token-file <file> [--log <file>]
//
// The same file runs as root inside a WSL distro on that PC (#510), where it adds Linux runners with bash scripts of the same
// names (add-runner.sh, ...), installed by tools/ci-runner/install-runner-agent.sh.
//
// It dials out to Citadel like the machine agent (public/machine-agent.mjs) and holds an event stream open, so the
// PC needs no open port. tools/ci-runner/install-runner-agent.ps1 installs it; tools/ci-runner/README.md says how.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, statfsSync, writeFileSync } from 'node:fs';
import { cpus, freemem, hostname, totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export const MAX_RUNNERS = 4;
const JOB_LIMIT_MS = 15 * 60_000;
const TAIL_LINES = 200;
const SCRIPTS = { add: 'add-runner.ps1', list: 'list-runners.ps1', remove: 'remove-runner.ps1' };
// The Linux agent (#510) runs as root inside a WSL distro on the same PC, with bash scripts of the same names.
const LINUX_SCRIPTS = { add: 'add-runner.sh', list: 'list-runners.sh', remove: 'remove-runner.sh' };

/** The job Citadel sent, checked field by field: anything else is refused, so the scripts only ever get a number or two. */
export function checkJob(job) {
  const keys = Object.keys(job ?? {})
    .sort()
    .join(',');
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
    // A chunk ends wherever the pipe cut it, not at a line's end: its first piece carries on the last line (#534: a
    // long line of JSON came back in pieces).
    const keep = (chunk) => {
      const parts = String(chunk).split(/\r?\n/);
      if (lines.length) lines[lines.length - 1] += parts.shift();
      lines.push(...parts);
      if (lines.length > TAIL_LINES * 2) lines.splice(0, lines.length - TAIL_LINES);
    };
    let child;
    try {
      // Its own process group off Windows (#510), so the time limit ends config.sh and the rest with it.
      child = spawn(command, args, { env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      return resolve({ code: -1, output: `could not start ${command}: ${err.message}` });
    }
    // As text, so a character cut by a chunk's end isn't broken.
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => {
      keep(`\nStopped after ${Math.round(limitMs / 60_000)} minutes.`);
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      else
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill();
        }
    }, limitMs);
    child.on('error', (err) => keep(`\ncould not start ${command}: ${err.message}`));
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
 * Runner.Listener and everything under it. `procs` are { pid, ppid, path, cpu, mem, reaped? }; `reaped` is the CPU
 * seconds of children that already ended and were collected (Linux's cutime + cstime). `prev` is the last look's
 * result's `seen` (null on the first, when CPU can't be told yet).
 * A tree's running total is each live process's own seconds plus its reaped children's: when a child ends its seconds
 * move from its own to its parent's reaped, so the total never drops, and a compile that began and ended between two
 * looks still counts. Windows has no reaped time (its runners still read low on short-lived processes).
 */
export function runnerUse(procs, prev) {
  const kids = new Map();
  for (const p of procs) (kids.get(p.ppid) ?? kids.set(p.ppid, []).get(p.ppid)).push(p);
  const seen = new Map(procs.map((p) => [p.pid, p.cpu]));
  const totals = new Map();
  seen.totals = totals;
  const runners = [];
  for (const root of procs) {
    // A Linux runner that updated itself runs from bin.<version>: bin is a symlink there, and /proc resolves it.
    const m = /^(.*)[\\/]bin(?:\.[\d.]+)?[\\/]Runner\.Listener(?:\.exe)?$/i.exec(root.path ?? '');
    if (!m) continue;
    let total = 0;
    let mem = 0;
    const done = new Set();
    const walk = [root];
    while (walk.length) {
      const p = walk.pop();
      // A pid used again can point a parent at its own child.
      if (done.has(p.pid)) continue;
      done.add(p.pid);
      total += p.cpu + (p.reaped ?? 0);
      mem += p.mem;
      walk.push(...(kids.get(p.pid) ?? []));
    }
    totals.set(m[1], total);
    const before = prev?.totals?.get(m[1]);
    // No earlier total for this runner (it just started) counts all it has used.
    runners.push({ dir: m[1], cpu: prev ? (before === undefined ? total : Math.max(0, total - before)) : null, mem });
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
      try {
        path = readlinkSync(join(proc, name, 'exe'));
      } catch {}
      // utime and stime in ticks of 1/100 s, rss in 4 KB pages: what every Linux the runners use has.
      out.push({ pid: Number(name), ppid: Number(f[1]), path, cpu: (Number(f[11]) + Number(f[12])) / 100, mem: Number(f[21]) * 4096, reaped: (Number(f[13]) + Number(f[14])) / 100 });
    } catch {}
  }
  return out;
}

/** A runner folder's name and repo on GitHub, from the .runner file its setup wrote; just the folder if it doesn't read. */
function runnerIdentity(dir, read = readFileSync) {
  try {
    const conf = JSON.parse(String(read(join(dir, '.runner'), 'utf8')).replace(/^\uFEFF/, ''));
    return {
      name: String(conf.agentName ?? ''),
      repo: String(conf.gitHubUrl ?? '')
        .replace(/^https:\/\/github\.com\//i, '')
        .toLowerCase(),
    };
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
      try {
        pressure = Number(/some avg10=\S+ avg60=([\d.]+)/.exec(readFileSync('/proc/pressure/cpu', 'utf8'))?.[1] ?? NaN);
      } catch {}
      return { procs: this.procs(), pressure: Number.isFinite(pressure) ? pressure : null };
    }
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(this.dir, 'sample-load.ps1')];
    // From the second look on: the first gives no sample to carry them (take), and a PC just back from a crash should say so at once.
    if (this.count % RESTARTS_EVERY === 1) args.push('-Restarts');
    const { code, output } = await this.run({ command: join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), args }, process.env, SAMPLE_LIMIT_MS);
    if (code !== 0) throw new Error(`sample-load.ps1 ended with exit ${code}: ${output.split('\n').at(-1)}`);
    const raw = JSON.parse(output.split('\n').at(-1));
    return {
      procs: (raw.procs ?? []).map(([pid, ppid, path, cpu, mem]) => ({ pid, ppid, path, cpu, mem })),
      queue: raw.queue ?? null,
      idle_sec: personIdle(raw.quser),
      hv: raw.hv ?? null,
      temp: raw.temp ?? null,
      ...(Array.isArray(raw.restarts) ? { restarts: raw.restarts } : {}),
    };
  }

  /** One sample, or null on the first look of the CPU clock (there is nothing to compare with yet). */
  async take() {
    const { procs, ...rest } = await this.platform();
    // Which runners are up and which run a job, for RunnerWake on Windows (where only a sample can say).
    this.lastProcs = procs;
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
      at,
      host: hostname(),
      os: this.os,
      cores,
      cpu: total > 0 ? Math.round((1 - (times.idle - last.times.idle) / total) * 1000) / 10 : 0,
      mem_total: totalmem(),
      mem_free: freemem(),
      ...disk,
      ...rest,
      runners: runners.map((r) => {
        if (!this.names.has(r.dir)) this.names.set(r.dir, this.identity(r.dir));
        // Its share of the whole PC: CPU seconds used, over the seconds every core had.
        return { ...this.names.get(r.dir), dir: r.dir, cpu: Math.round((r.cpu / (((at - last.at) / 1000) * cores)) * 1000) / 10, mem: r.mem };
      }),
    };
  }
}

// ---- Cap and yield (#552; Josh, 2026-11-11: "ok, CI is using my whole desktop, can we limit it a bit?") ----
// On Windows, keep-runners.ps1 holds every runner on the PC (Citadel's or not) and all it starts at below-normal
// priority, all of them together under CI_CPU_PERCENT of the PC, in one job object it keeps open; and it starts runner
// services a reboot left stopped. It runs as long as the agent does, so the cap comes back with every boot and install.
export const CI_CPU_PERCENT = 75;
const KEEPER_AGAIN_MS = 60_000;
/** The Linux runners' slice (systemd), which install-runner-agent.sh makes on plain Linux; in WSL, .wslconfig caps the VM. */
export const SLICE = 'citadel-runners.slice';

/**
 * The PC's owner's caps (#1933), from caps.json beside this file, which only they (as admin or root) can write:
 * { "cpu_percent": 75, "squeeze_percent": 30 }, each optional. Read once, at the agent's start. A wrong value is logged
 * and keeps its default. The squeezes never exceed the cap they sit in.
 * @param {string} dir
 * @param {(line: string) => void} [log]
 */
export function ownerCaps(dir, log = () => {}) {
  const caps = { cpu_percent: CI_CPU_PERCENT, squeeze_percent: SQUEEZE_PERCENT };
  let set = {};
  try {
    const text = readFileSync(join(dir, 'caps.json'), 'utf8').replace(/^\ufeff/, '');
    set = JSON.parse(text);
    if (!set || typeof set !== 'object' || Array.isArray(set)) throw new Error('it must be { "cpu_percent": …, "squeeze_percent": … }');
  } catch (err) {
    if (err.code !== 'ENOENT') log(`caps.json is ignored: ${err.message}`);
    set = {};
  }
  for (const [k, v] of Object.entries(set)) {
    if (!(k in caps)) log(`caps.json: ${k} is not a cap (cpu_percent, squeeze_percent)`);
    else if (!Number.isInteger(v) || v < 1 || v > 100) log(`caps.json: ${k} must be a whole number from 1 to 100, so ${caps[k]} stays`);
    else caps[k] = v;
  }
  const squeeze = Math.min(caps.squeeze_percent, caps.cpu_percent);
  return { cpu: caps.cpu_percent, squeeze, citadel: Math.min(WINDOWS_CITADEL_SQUEEZE_PERCENT, squeeze) };
}

/** Plain Linux: caps every runner together at the owner's share of the cores, on the slice the installer made. Elsewhere does nothing. */
export async function sliceCap(caps, { run = runCommand, units = '/etc/systemd/system', cores = cpus().length, log = () => {} } = {}) {
  if (!existsSync(join(units, SLICE))) return;
  const { code, output } = await run({ command: 'systemctl', args: ['set-property', '--runtime', SLICE, `CPUQuota=${Math.max(1, Math.round(cores * caps.cpu))}%`] }, process.env, 30_000);
  if (code === 0) log(`CI is capped at ${caps.cpu}% of this PC (caps.json changes it).`);
  else log(`Couldn't cap CI at ${caps.cpu}%: ${output.split('\n').at(-1)}`);
}

/** keep-runners.ps1 from the agent's folder, in Windows PowerShell, with the cap and this agent's pid (it ends with the agent). */
export function keeperCommand(dir, pid = process.pid, systemRoot = process.env.SystemRoot ?? 'C:\\Windows', caps = ownerCaps(dir)) {
  return {
    command: join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(dir, 'keep-runners.ps1'), '-CpuPercent', String(caps.cpu), '-AgentPid', String(pid), '-SqueezePercent', String(caps.squeeze), '-CitadelSqueezePercent', String(caps.citadel)],
  };
}

/** Starts keep-runners.ps1, logs what it says, and starts it again a minute after it ever ends. */
export function keepRunners(dir, log, again = KEEPER_AGAIN_MS, caps = ownerCaps(dir, log)) {
  if (!existsSync(join(dir, 'keep-runners.ps1'))) {
    log("keep-runners.ps1 is not in the agent's folder, so CI is not capped (#552): install the agent again.");
    return;
  }
  const { command, args } = keeperCommand(dir, process.pid, undefined, caps);
  const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) {
    createInterface({ input: stream }).on('line', (line) => line.trim() && log(`keep-runners: ${line.trim()}`));
  }
  child.on('error', (err) => log(`Couldn't start keep-runners.ps1: ${err.message}`));
  child.on('close', (code) => {
    log(`keep-runners.ps1 ended (exit ${code}); starting it again in ${Math.round(again / 1000)}s.`);
    setTimeout(() => keepRunners(dir, log, again, caps), again).unref();
  });
}

// ---- Ships go first (#1268; Cara, 2026-11-20, "Plan approved: build it this way") ----
// Citadel sends the runners on a ship run (any scheme's land/ branch) every 15 seconds. While a list names any, every
// other runner on the PC is held to SQUEEZE_PERCENT of it together, shared among those running a job; a list that
// stops coming lifts it after SHIP_HOLD_MS, so a Citadel that went away never leaves runners squeezed.
export const SQUEEZE_PERCENT = 30;
// Windows only (Josh, 2026-11-24, "Squeeze Peek's builds harder"): while a Citadel ship runs, the others share this much.
export const WINDOWS_CITADEL_SQUEEZE_PERCENT = 10;
export const SHIP_HOLD_MS = 2 * 60_000;

/** Citadel's list, kept to well-formed entries, names and repos lowercase. */
export function cleanShips(raw) {
  const text = (v) => (typeof v === 'string' && v.length <= 200 ? v.toLowerCase() : '');
  return (Array.isArray(raw) ? raw : [])
    .map((s) => ({ repo: text(s?.repo), runner: text(s?.runner), ...(s?.first === true ? { first: true } : {}) }))
    .filter((s) => s.repo && s.runner)
    .slice(0, 200);
}

/** Windows: the list for keep-runners.ps1, which reads ships.json beside it every 2 seconds, with its expiry. */
export function writeShips(dir, ships, now = Date.now()) {
  const file = join(dir, 'ships.json');
  writeFileSync(`${file}.new`, JSON.stringify({ until: now + SHIP_HOLD_MS, ships }));
  renameSync(`${file}.new`, file);
}

/**
 * Linux (WSL): each Citadel runner unit's CPUQuota, set at runtime (gone at the next boot): about SQUEEZE_PERCENT of
 * the cores shared among the units off the ship running a job, while a ship runs; none otherwise.
 */
export class LinuxSqueeze {
  constructor({ run = runCommand, units = '/etc/systemd/system', cores = cpus().length, procs = linuxProcs, identity = runnerIdentity, now = Date.now, log = () => {}, percent = SQUEEZE_PERCENT } = {}) {
    Object.assign(this, { run, units, cores, procs, identity, now, log, percent, ships: [], until: 0, set: new Map(), said: '', queue: Promise.resolve() });
  }

  /** Each Citadel runner unit with its runner's repo and name, from the unit add-runner.sh wrote and its .runner. */
  runners() {
    let names = [];
    try {
      names = readdirSync(this.units).filter((f) => /^citadel-runner-.+\.service$/.test(f));
    } catch {}
    return names.flatMap((unit) => {
      try {
        const dir = /^ExecStart=\/bin\/bash (.+)\/bin\/runsvc\.sh$/m.exec(readFileSync(join(this.units, unit), 'utf8'))?.[1];
        return dir ? [{ unit, dir, ...this.identity(dir) }] : [];
      } catch {
        return [];
      }
    });
  }

  update(ships) {
    this.ships = ships;
    this.until = this.now() + SHIP_HOLD_MS;
    return this.next();
  }

  /** Lifts the squeeze once Citadel hasn't renewed it in time. */
  tick() {
    if (!this.until || this.now() < this.until) return Promise.resolve();
    this.ships = [];
    this.until = 0;
    return this.next();
  }

  /** One apply at a time: a list that comes while systemctl runs waits its turn. */
  next() {
    this.queue = this.queue.then(() => this.apply());
    return this.queue;
  }

  async apply() {
    const onShip = (r) => this.ships.some((s) => s.repo === r.repo.toLowerCase() && s.runner === r.name.toLowerCase());
    const runners = this.runners();
    const others = this.ships.length ? runners.filter((r) => !onShip(r)) : [];
    const working = new Set(
      this.procs()
        .map((p) => /^(.*)\/bin\/Runner\.Worker$/.exec(p.path)?.[1])
        .filter(Boolean),
    );
    const busy = Math.max(1, others.filter((r) => working.has(r.dir)).length);
    const quota = Math.max(10, Math.round((this.cores * this.percent) / busy));
    for (const r of runners) {
      const want = others.includes(r) ? `${quota}%` : '';
      // A unit not set yet is set even to no quota: an agent before this one (restarted mid-ship) may have left one.
      if (this.set.has(r.unit) && this.set.get(r.unit) === want) continue;
      const { code, output } = await this.run({ command: 'systemctl', args: ['set-property', '--runtime', r.unit, `CPUQuota=${want}`] }, process.env, 30_000);
      if (code === 0) this.set.set(r.unit, want);
      else this.log(`Couldn't set ${r.unit}'s CPUQuota to "${want}": ${output.split('\n').at(-1)}`);
    }
    const now = this.ships.length ? `A ship runs on ${this.ships.map((s) => `${s.repo} ${s.runner}`).join(', ')}: ${others.length} other Linux runner(s) held to CPUQuota=${quota}% each.` : 'No ship runs: every Linux runner has its normal share again.';
    if (now !== this.said && (this.ships.length || this.said)) this.log(now);
    this.said = now;
  }
}

// ---- Runners awake (Build 7 M6b; Josh, 2026-11-25: "if there is CI to run, we use less workers, or more workers") ----
// Citadel's balancer splits the PC's threads among its ship, CI, heavy jobs and minion turns, and sends the agent how
// many CI runners to keep awake, every 10 seconds: { plan: { runners, queued } }. The rest sleep (their service stopped),
// so GitHub hands a job to a PC with room. A ship's runners and a runner running a job are never stopped; a plan that
// stops coming wakes every runner it put to sleep after PLAN_HOLD_MS, so a Citadel that went away never leaves CI asleep.
// While a plan is held the ship squeeze above is off: the plan holds the ship's threads first. A Citadel from before
// sends no plan, and the squeeze works as it did.
export const PLAN_HOLD_MS = 2 * 60_000;

/** Citadel's plan, checked: the runners to keep awake (a whole number) and CI jobs waiting by repo; null if it isn't one. */
export function cleanPlan(raw) {
  const n = raw?.runners;
  if (!Number.isInteger(n) || n < 0 || n > 1000) return null;
  const queued = {};
  if (raw.queued && typeof raw.queued === 'object' && !Array.isArray(raw.queued)) for (const [repo, count] of Object.entries(raw.queued).slice(0, 200)) if (repo.length <= 200 && Number.isInteger(count) && count > 0) queued[repo.toLowerCase()] = Math.min(count, 1000);
  return { runners: n, queued };
}

/**
 * Which runners stay awake: { key, repo, name, busy, ship, awake } each, `awake` meaning up now. A ship's runners stay up
 * outside the count (the plan holds their threads apart); a busy one counts and is never stopped. The rest of the count
 * goes to idle runners, a repo's queued jobs first (one runner each), then one repo at a time in turn, each repo's
 * runners already up before ones asleep, so a steady plan moves nothing.
 */
export function pickAwake(runners, plan) {
  const keep = new Set(runners.filter((r) => r.ship || r.busy).map((r) => r.key));
  let left = Math.max(0, plan.runners - runners.filter((r) => r.busy && !r.ship).length);
  const idle = new Map();
  const sorted = runners.filter((r) => !keep.has(r.key)).sort((a, b) => Number(b.awake) - Number(a.awake) || a.repo.localeCompare(b.repo) || a.name.localeCompare(b.name));
  for (const r of sorted) (idle.get(r.repo) ?? idle.set(r.repo, []).get(r.repo)).push(r);
  const take = (repo) => {
    const r = idle.get(repo)?.shift();
    if (!r) return false;
    keep.add(r.key);
    left--;
    return true;
  };
  const wanted = new Map(Object.entries(plan.queued).filter(([repo]) => idle.has(repo)));
  // Queued jobs: one runner for each, the repos taking turns from the one with most waiting.
  for (let more = true; left > 0 && more; ) {
    more = false;
    for (const [repo] of [...wanted].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
      if (left <= 0) break;
      if (wanted.get(repo) > 0 && take(repo)) {
        wanted.set(repo, wanted.get(repo) - 1);
        more = true;
      }
    }
  }
  // Then every repo in turn, so one with no job waiting has a runner up for the next.
  for (let more = true; left > 0 && more; ) {
    more = false;
    for (const repo of [...idle.keys()].sort()) if (left > 0 && take(repo)) more = true;
  }
  return keep;
}

/** The runners the agent (or on Windows keep-runners.ps1) put to sleep, in a file beside it. */
const SLEPT_FILE = 'slept.json';

/**
 * Applies the plan. Linux stops and starts the runner units itself; Windows writes asleep.json beside keep-runners.ps1,
 * which stops and starts the services (it runs as long as the agent does, and checks each is idle right before).
 * Either way the runners it put to sleep are kept in slept.json, so a restarted agent wakes them, and a runner someone
 * else stopped is never started.
 */
export class RunnerWake {
  constructor({ os = defaultOs(), dir = '.', run = runCommand, units = '/etc/systemd/system', procs = linuxProcs, windowsProcs = () => /** @type {{ path?: string }[]} */ ([]), identity = runnerIdentity, roots = windowsRoots, now = Date.now, log = () => {} } = {}) {
    Object.assign(this, { os, dir, run, units, procs, windowsProcs, identity, roots, now, log, plan: null, until: 0, ships: [], said: '', queue: Promise.resolve() });
  }

  /** A plan is held: the squeeze stays off. */
  held() {
    return !!this.plan && this.now() < this.until;
  }

  update(plan, ships = this.ships) {
    this.plan = plan;
    this.ships = ships;
    this.until = this.now() + PLAN_HOLD_MS;
    return this.next();
  }

  /** The ship list moved: its runners stay up. */
  shipsAre(ships) {
    this.ships = ships;
    return this.plan ? this.next() : Promise.resolve();
  }

  /** Wakes every runner it put to sleep once Citadel hasn't renewed the plan in time. */
  tick() {
    if (!this.plan || this.now() < this.until) return Promise.resolve();
    this.plan = null;
    this.log('No plan from Citadel for 2 minutes: every runner it put to sleep wakes.');
    return this.next();
  }

  next() {
    this.queue = this.queue.then(() => (this.os === 'linux' ? this.applyLinux() : this.applyWindows()));
    return this.queue;
  }

  slept() {
    try {
      const list = JSON.parse(readFileSync(join(this.dir, SLEPT_FILE), 'utf8'));
      return new Set(Array.isArray(list) ? list.filter((x) => typeof x === 'string') : []);
    } catch {
      return new Set();
    }
  }

  saveSlept(set) {
    const file = join(this.dir, SLEPT_FILE);
    writeFileSync(`${file}.new`, JSON.stringify([...set].sort()));
    renameSync(`${file}.new`, file);
  }

  onShip(r) {
    return this.ships.some((s) => s.repo === r.repo.toLowerCase() && s.runner === r.name.toLowerCase());
  }

  say(text) {
    if (text !== this.said) this.log(text);
    this.said = text;
  }

  async applyLinux() {
    const units = new LinuxSqueeze({ units: this.units, identity: this.identity }).runners();
    if (!units.length) return;
    const slept = this.slept();
    const { code, output } = await this.run({ command: 'systemctl', args: ['is-active', ...units.map((u) => u.unit)] }, process.env, 30_000);
    const states = output.trim().split('\n');
    // is-active exits 3 when any unit is down; its lines still say which.
    if (code !== 0 && states.length !== units.length) return this.log(`Couldn't read the runner units' state: ${states.at(-1)}`);
    const working = new Set(
      this.procs()
        .map((p) => /^(.*)\/bin(?:\.[\d.]+)?\/Runner\.Worker$/.exec(p.path)?.[1])
        .filter(Boolean),
    );
    const list = units.map((u, i) => ({ ...u, key: u.unit, awake: states[i] === 'active', busy: working.has(u.dir), ship: this.onShip(u) }));
    // One someone else stopped is theirs: left down and out of the count.
    const ours = list.filter((r) => r.awake || slept.has(r.key));
    const keep = this.plan ? pickAwake(ours, this.plan) : new Set(ours.map((r) => r.key));
    for (const r of ours) {
      const want = keep.has(r.key);
      if (want === r.awake) continue;
      // The plan moved since the runner took a job: it finishes, and sleeps at the next look.
      if (!want && (r.busy || r.ship)) continue;
      const { code: c, output: out } = await this.run({ command: 'systemctl', args: [want ? 'start' : 'stop', r.unit] }, process.env, 60_000);
      if (c !== 0) {
        this.log(`Couldn't ${want ? 'wake' : 'put to sleep'} ${r.unit}: ${out.split('\n').at(-1)}`);
        continue;
      }
      if (want) slept.delete(r.key);
      else slept.add(r.key);
    }
    for (const key of [...slept]) if (!list.some((r) => r.key === key)) slept.delete(key);
    this.saveSlept(slept);
    this.say(this.plan ? `Citadel's plan: ${this.plan.runners} runner(s) awake besides a ship's; ${ours.filter((r) => keep.has(r.key)).length} of ${ours.length} up.` : 'No plan from Citadel: every runner is up.');
  }

  /** Windows: the runner folders to keep asleep, for keep-runners.ps1 (which keeps its own slept.json). */
  async applyWindows() {
    const slept = this.slept();
    const procs = this.windowsProcs() ?? [];
    const up = new Set();
    const working = new Set();
    for (const p of procs) {
      const m = /^(.*)\\bin\\(Runner\.Listener|Runner\.Worker)\.exe$/i.exec(p.path ?? '');
      if (m) (m[2].toLowerCase() === 'runner.worker' ? working : up).add(m[1].toLowerCase());
    }
    const list = this.roots().flatMap((dir) => {
      const { name, repo } = this.identity(dir);
      if (!name || !repo) return [];
      const key = dir.toLowerCase();
      return [{ key, dir, name, repo, awake: up.has(key), busy: working.has(key), ship: false }];
    });
    for (const r of list) r.ship = this.onShip(r);
    const ours = list.filter((r) => r.awake || slept.has(r.key));
    const keep = this.plan ? pickAwake(ours, this.plan) : new Set(ours.map((r) => r.key));
    const asleep = this.plan ? ours.filter((r) => !keep.has(r.key)).map((r) => r.dir) : [];
    const file = join(this.dir, 'asleep.json');
    writeFileSync(`${file}.new`, JSON.stringify({ until: this.plan ? this.until : 0, dirs: asleep }));
    renameSync(`${file}.new`, file);
    this.say(this.plan ? `Citadel's plan: ${this.plan.runners} runner(s) awake besides a ship's; ${asleep.length} of ${ours.length} to sleep.` : 'No plan from Citadel: every runner is up.');
  }
}

/** Windows: the service runners' folders (add-runner.ps1's C:\actions-runner-<repo>[-n]; a -desktop one has no service). */
export function windowsRoots(root = `${process.env.SystemDrive ?? 'C:'}\\`) {
  try {
    return readdirSync(root)
      .filter((f) => /^actions-runner-/i.test(f) && !/-desktop$/i.test(f))
      .map((f) => join(root, f));
  } catch {
    return [];
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
      const data = block
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n');
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
  // Tests sample faster than every 30 seconds; nothing else passes it.
  const sampleMs = Number(option('--sample-ms')) || SAMPLE_MS;
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
    if (logFile)
      try {
        appendFileSync(logFile, `${line}\n`);
      } catch {}
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
    setTimeout(sample, sampleMs).unref();
  };
  sample();
  const caps = ownerCaps(jobs.dir, log);
  if (os === 'windows') keepRunners(jobs.dir, log, undefined, caps);
  else sliceCap(caps, { log }).catch((err) => log(`Couldn't cap CI: ${err.message}`));
  const squeeze = os === 'linux' ? new LinuxSqueeze({ log, percent: caps.squeeze }) : null;
  squeeze?.next().catch((err) => log(`Couldn't clear the ship squeeze: ${err.message}`));
  if (squeeze) setInterval(() => squeeze.tick().catch((err) => log(`Couldn't lift the ship squeeze: ${err.message}`)), 10_000).unref();
  // Runners awake (M6b): while Citadel's plan is held the squeeze is off, and the plan's runners stay up.
  const wake = new RunnerWake({ os, dir: jobs.dir, log, windowsProcs: () => sampler.lastProcs });
  let lastShips = [];
  let squeezed = true;
  let shipError = '';
  const squeezeShips = async () => {
    squeezed = !wake.held();
    const list = squeezed ? lastShips : [];
    if (squeeze) await squeeze.update(list);
    else writeShips(jobs.dir, list);
  };
  const ships = async (raw) => {
    try {
      lastShips = cleanShips(raw);
      await squeezeShips();
      await wake.shipsAre(lastShips);
      shipError = '';
    } catch (err) {
      if (err.message !== shipError) log(`Couldn't pass on the ships (said once): ${err.message}`);
      shipError = err.message;
    }
  };
  let planError = '';
  const plan = async (raw) => {
    const p = cleanPlan(raw);
    if (!p) return log(`Citadel sent a plan this agent can't read: ${JSON.stringify(raw).slice(0, 200)}`);
    try {
      await wake.update(p, lastShips);
      if (squeezed) await squeezeShips();
      planError = '';
    } catch (err) {
      if (err.message !== planError) log(`Couldn't apply Citadel's plan (said once): ${err.message}`);
      planError = err.message;
    }
  };
  setInterval(
    () =>
      wake
        .tick()
        .then(() => (!wake.held() && !squeezed ? squeezeShips() : null))
        .catch((err) => log(`Couldn't wake the runners: ${err.message}`)),
    10_000,
  ).unref();
  // Runners a restarted agent put to sleep before stay so only until Citadel's first plan or PLAN_HOLD_MS.
  setTimeout(() => wake.next().catch((err) => log(`Couldn't wake the runners: ${err.message}`)), PLAN_HOLD_MS).unref();

  let retry = 0;
  for (;;) {
    try {
      const url = new URL('/api/machines/connect', appUrl);
      url.searchParams.set('host', hostname());
      url.searchParams.set('command', 'citadel runner agent');
      url.searchParams.set('kind', 'runners');
      // Which runners it adds (#510): Citadel sends Linux asks only to a Linux agent.
      url.searchParams.set('os', os);
      // It applies the balancer's plan (M6b): a Citadel that sees no plans=1 shows its row's Update CI agent line.
      url.searchParams.set('plans', '1');
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
        } else if (msg.ships) {
          ships(msg.ships);
        } else if (msg.plan) {
          plan(msg.plan);
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
