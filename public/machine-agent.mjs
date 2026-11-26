#!/usr/bin/env node
// The app's machine agent: lends this computer's MCP server (a Godot editor, say) to the
// coordinator's threads. It dials out to the app and keeps that connection open, so the app never
// needs to reach this computer; each thread session gets its own copy of the MCP server.
//
//   node machine-agent.mjs <app url> <token> --config <file>
//   node machine-agent.mjs <app url> <token> --claude-mcp <name> [--config <file>]
//   node machine-agent.mjs <app url> <token> [--config <file>] -- <mcp server command> [args...]
//
// The first form is what the Machines page installs (#439): the agent tells the app what it found here,
// the names of the MCP servers set up for Claude Code on this computer (in ~/.claude.json; names only,
// never their commands, env or paths), the servers its owner lists in the config file, and that file's
// workspaces. A person ticks what to lend on the Machines page, and the agent serves only what is
// ticked and what it found itself: the app sends names, never a command.
// The other two are how agents were set up before: the MCP server is fixed on this computer's command
// line, and the Machines page shows it as "set on that computer".
// --claude-mcp runs a server already set up for Claude Code on this computer,
// such as godot-ai, whose entry holds a path only this computer knows. It is read afresh for each
// session, so an updated entry applies without restarting the agent.
// --config names the config file (machine-agent.json). When it lists workspaces, the agent also serves
// its own workspace tools (mcp__<name>-ws__…): git sync and the tasks listed there, in the folders
// listed there, nothing else. Only this computer's owner edits that file; minions can't write to it.
// It is re-read when it changes. A missing file just means no workspace tools.
// --log <file> copies everything it prints to that file too. --install <machine name>, on macOS or
// Linux, runs it with the same options in the background instead (a launchd agent or a systemd user
// unit, logging next to this file), starting at login and again if it stops.
// The token can come from CC_MACHINE_TOKEN instead, or from a join code: --join <code> (Connect a computer, Build 7 M2)
// swaps it for the token once, keeps that in machine-agent.join.json beside the config, and with --install names the
// service after the machine. Needs Node 18 or newer; no other installs.
import { execFile, spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, chmodSync, closeSync, createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, utimesSync, watchFile, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { homedir, hostname, release, totalmem } from 'node:os';
// availableParallelism and statfsSync came in Node 18.14 and 18.15: a named import of either would stop an older Node 18 loading the agent at all.
import * as nodeFs from 'node:fs';
import * as nodeOs from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

// ---------- workspace tools ----------

/** A refusal or failure the minion should read as is. */
class ToolError extends Error {}

const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
// An MCP server's name as the app takes it (src/machines.ts SERVER_NAME).
const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,59}$/;
// A branch name as git allows it, minus anything that could read as an option or a range.
const REF = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[A-Za-z0-9._/-]{1,200}(?<![./])$/;
const SHA = /^[0-9a-f]{7,40}$/;
const WAIT_MAX = 50; // seconds a tool call waits on a job before handing back its id
const TASK_LIMIT_MS = 30 * 60_000;
const TAIL_LINES = 400;
const READ_MAX = 5_000_000;
const FETCH_MAX = 20_000_000;
const KEEP_LOGS = 100;
const FOUND_EVERY_MS = 30_000;
const BEAT_MS = 20_000;
const SILENT_MS = 60_000;
// How long an agent another agent took over from waits before it connects again.
const REPLACED_WAIT_S = 600;

/** %NAME% from the environment, as Windows writes it; an unset one is an error, not an empty string. */
export function expand(text, env = process.env) {
  return text.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (_, name) => {
    const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
    if (key === undefined || env[key] === '') throw new ToolError(`${name} is not set on this computer`);
    return env[key];
  });
}

function realDir(p) {
  if (!isAbsolute(p)) throw new Error(`${p} must be a full path`);
  let real;
  try {
    real = realpathSync.native(p);
  } catch {
    throw new Error(`${p} does not exist`);
  }
  if (!statSync(real).isDirectory()) throw new Error(`${p} is not a folder`);
  return real;
}

/** Whether a real path is the root or inside it (path.relative ignores case on Windows). */
function within(root, target) {
  const rel = relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Reads machine-agent.json: { screen_lock?: <file>, screenshots?: true, servers?: { <name>: { run: [argv] } },
 * workspaces: { <name>: { path, read?: [folders], git_sync?: false,
 * tasks: { <name>: { run: [argv], about?, hints?, args?: true, screen?: false } } } } }.
 * servers are MCP servers this computer's owner offers besides Claude Code's (#439): a program and its arguments, no shell.
 * A bad workspace or task is left out with a problem saying why, so one typo doesn't take the rest down.
 * screen_lock and screenshots are for a test box (tools/win-test-box/): one lock file its CI desktop jobs take too.
 * programs (Build 7 T8): { <name>: { path, about?, args?: true } }, what minions marked for this PC may start (run_on_host).
 */
export function loadConfig(file, env = process.env) {
  const workspaces = new Map();
  const servers = new Map();
  const problems = [];
  const programs = new Map();
  const none = { workspaces, servers, problems, screenLock: null, screenshots: false, jobs: null, programs };
  if (!existsSync(file)) return none;
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    return { ...none, problems: [`${file}: ${err.message}`] };
  }
  let screenLock = null;
  if (raw?.screen_lock !== undefined) {
    try {
      const p = expand(String(raw.screen_lock), env);
      screenLock = join(realDir(dirname(p)), basename(p));
    } catch (err) {
      problems.push(`screen_lock: ${err.message}, so nothing takes the screen lock`);
    }
  }
  const screenshots = raw?.screenshots === true;
  if (raw?.screenshots !== undefined && typeof raw.screenshots !== 'boolean') problems.push('"screenshots" must be true or false, so it is off');
  for (const [name, v] of Object.entries(raw?.servers ?? {})) {
    if (!SERVER_NAME.test(name)) problems.push(`server "${name}": names use letters, digits, -, _ and .`);
    else if (!Array.isArray(v?.run) || !v.run.length || !v.run.every((a) => typeof a === 'string' && a)) problems.push(`server ${name}: "run" must be a list of the program and its arguments`);
    else servers.set(name, { run: v.run });
  }
  for (const [name, w] of Object.entries(raw?.workspaces ?? {})) {
    if (!NAME.test(name)) {
      problems.push(`workspace "${name}": names use letters, digits, - and _`);
      continue;
    }
    let path;
    try {
      path = realDir(expand(String(w?.path ?? ''), env));
    } catch (err) {
      problems.push(`workspace ${name}: ${err.message}`);
      continue;
    }
    const read = [];
    for (const r of Array.isArray(w.read) ? w.read : []) {
      try {
        read.push(realDir(expand(String(r), env)));
      } catch (err) {
        problems.push(`workspace ${name}, read folder ${r}: ${err.message}`);
      }
    }
    // Off for a folder its owner keeps on a branch (an Obsidian vault with Obsidian Git): a detached checkout breaks that.
    const gitSync = w.git_sync === undefined || w.git_sync === true;
    if (w.git_sync !== undefined && typeof w.git_sync !== 'boolean') problems.push(`workspace ${name}: "git_sync" must be true or false, so it is off`);
    const tasks = new Map();
    for (const [tname, t] of Object.entries(w.tasks ?? {})) {
      const bad = (why) => problems.push(`workspace ${name}, task ${tname}: ${why}`);
      if (!NAME.test(tname)) bad('names use letters, digits, - and _');
      else if (!Array.isArray(t?.run) || !t.run.length || !t.run.every((a) => typeof a === 'string' && a)) bad('"run" must be a list of the program and its arguments');
      else {
        try {
          const hints = (Array.isArray(t.hints) ? t.hints : []).map((h) => {
            if (typeof h?.say !== 'string' || (!Number.isInteger(h.exit) && typeof h.match !== 'string')) throw new Error('each hint needs "say" and an "exit" code or a "match" pattern');
            return { exit: h.exit, match: typeof h.match === 'string' ? new RegExp(h.match, 'i') : null, say: h.say };
          });
          if (t.args !== undefined && typeof t.args !== 'boolean') throw new Error('"args" must be true or false');
          if (t.screen !== undefined && typeof t.screen !== 'boolean') throw new Error('"screen" must be true or false');
          tasks.set(tname, { run: t.run, about: typeof t.about === 'string' ? t.about : '', hints, args: t.args === true, screen: t.screen !== false });
        } catch (err) {
          bad(err.message);
        }
      }
    }
    workspaces.set(name, { name, path, read, gitSync, tasks });
  }
  loadPrograms(raw?.programs, programs, problems, env);
  return { workspaces, servers, problems, screenLock, screenshots, jobs: raw?.jobs === undefined ? null : loadJobs(raw.jobs, problems, env), programs };
}

// ---------- host programs (Build 7 T8, src/host-reach.ts) ----------

const PROGRAM_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;

/** The owner's programs block into `into`; a bad one is left out with a problem. Only this file lists them: the app sends a name, never a path. */
function loadPrograms(raw, into, problems, env) {
  if (raw === undefined) return;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return void problems.push('"programs" must be { <name>: { path, about?, args? } }, so no program can be started');
  for (const [name, p] of Object.entries(raw)) {
    if (!PROGRAM_NAME.test(name)) problems.push(`program "${name}": names use letters, digits, -, _ and .`);
    else if (typeof p?.path !== 'string') problems.push(`program ${name}: "path" must be the program's full path`);
    else if (p.args !== undefined && typeof p.args !== 'boolean') problems.push(`program ${name}: "args" must be true or false`);
    else {
      try {
        const path = expand(p.path, env);
        if (!isAbsolute(path)) throw new Error('"path" must be a full path');
        into.set(name, { name, path, about: typeof p.about === 'string' ? p.about.slice(0, 300) : '', args: p.args === true });
      } catch (err) {
        problems.push(`program ${name}: ${err.message}`);
      }
    }
  }
}

/** A path as this PC resolves it, links and short names followed (as it is when it doesn't exist). @param {string} p */
function hostPath(p) {
  try {
    return realpathSync.native(p);
  } catch {
    return resolve(p);
  }
}

/**
 * Start one of the owner's programs for a marked minion (run_on_host): only one on the list, its arguments only where
 * the owner said args, never through a shell. Resolves with its pid, or throws a ToolError naming the list.
 * Nothing starts while a folder minions can write (`ask.writable`, the worker's read-write folders) holds this agent
 * or its list (`own`), or a program's own folder: a minion could change what runs.
 * @param {Map<string, { name: string, path: string, args: boolean }>} programs @param {{ program?: unknown, args?: unknown, writable?: unknown }} ask
 * @param {string[]} own the folders of this agent and its config file
 * @param {(path: string, args: string[], opts: import('node:child_process').SpawnOptions) => { pid?: number, once(event: string, on: (err: Error) => void): unknown, unref(): void }} [run]
 */
export function startProgram(programs, ask, own, run = spawn) {
  const name = String(ask.program ?? '');
  const p = programs.get(name);
  const list = [...programs.keys()];
  if (!Array.isArray(ask.writable)) throw new ToolError("The app didn't say which of this PC's folders minions can write to, so this agent starts nothing.");
  const writable = ask.writable.map((w) => hostPath(String(w)));
  for (const o of own.map(hostPath)) {
    const w = writable.find((w) => within(w, o) || within(o, w));
    if (w) throw new ToolError(`This agent and its list of programs are in ${o}, which minions marked for this PC can write to through the folder ${w}. It starts nothing until its owner moves one of them, or makes that folder read-only.`);
  }
  if (!p) throw new ToolError(`"${name}" isn't one of the programs this PC's owner lists for minions. ${list.length ? `They are: ${list.join(', ')}.` : 'They list none (programs in machine-agent.json).'}`);
  const args = Array.isArray(ask.args) ? ask.args.map(String) : [];
  if (args.length && !p.args) throw new ToolError(`${name} takes no arguments here: its owner didn't allow them.`);
  if (!existsSync(p.path)) throw new ToolError(`${name}'s program isn't there any more (${p.path}).`);
  const dir = hostPath(dirname(p.path));
  const w = writable.find((w) => within(w, dir));
  if (w) throw new ToolError(`${name} is in ${dir}, inside a folder minions marked for this PC can write to (${w}), so this agent won't start it.`);
  return new Promise((done, fail) => {
    const child = run(p.path, args, { cwd: dirname(p.path), detached: true, stdio: 'ignore', shell: false, windowsHide: false });
    child.once('error', (err) => fail(new ToolError(`${name} could not start: ${err.message}`)));
    child.once('spawn', () => {
      child.unref();
      done(child.pid ?? null);
    });
  });
}

/**
 * The owner's `jobs` block (#858): { dir, distro?, folders: { <name>: <path> }, max_limit_h?, max_disk_gb, gpu? }.
 * The outer wall for GPU jobs: whatever the app sends, a job reads only these folders, runs at most max_limit_h
 * and the jobs folder holds at most max_disk_gb. A broken dir or cap turns jobs off (null) with a problem.
 */
function loadJobs(raw, problems, env) {
  const bad = (why) => (problems.push(`jobs: ${why}, so jobs are off`), null);
  if (!raw || typeof raw !== 'object') return bad('must be { dir, folders, max_limit_h, max_disk_gb, gpu }');
  // A comma would end podman's --mount option early and start another.
  const real = (p) => {
    const r = realDir(expand(String(p ?? ''), env));
    if (r.includes(',')) throw new Error(`${r} has a comma, which podman's mounts can't take`);
    return r;
  };
  let dir;
  try {
    dir = real(raw.dir);
  } catch (err) {
    return bad(`dir: ${err.message}`);
  }
  const hours = raw.max_limit_h === undefined ? JOB_LIMIT_H : raw.max_limit_h;
  if (typeof hours !== 'number' || !(hours > 0) || hours > 48) return bad('"max_limit_h" must be a number of hours, at most 48');
  if (typeof raw.max_disk_gb !== 'number' || !(raw.max_disk_gb > 0)) return bad('"max_disk_gb" must be a number of GB');
  if (raw.gpu !== undefined && typeof raw.gpu !== 'boolean') return bad('"gpu" must be true or false');
  const folders = new Map();
  for (const [name, p] of Object.entries(raw.folders ?? {})) {
    if (!NAME.test(name)) problems.push(`jobs, folder "${name}": names use letters, digits, - and _`);
    else {
      try {
        folders.set(name, real(p));
      } catch (err) {
        problems.push(`jobs, folder ${name}: ${err.message}`);
      }
    }
  }
  return { dir, folders, max_limit_h: hours, max_disk_gb: raw.max_disk_gb, gpu: raw.gpu === true };
}

const claudeConfigFile = (env) => join(env.CLAUDE_CONFIG_DIR ?? homedir(), '.claude.json');

/**
 * The names of the stdio MCP servers set up for Claude Code on this computer (#439): user scope and every
 * project's. Names only: an entry's command, env and paths can hold secrets, and never leave this computer.
 */
export function claudeServerNames(env = process.env) {
  let config;
  try {
    config = JSON.parse(readFileSync(claudeConfigFile(env), 'utf8'));
  } catch {
    return [];
  }
  const scopes = [config?.mcpServers, ...Object.values(config?.projects ?? {}).map((p) => p?.mcpServers)];
  const names = scopes.flatMap((s) =>
    Object.entries(s ?? {})
      .filter(([name, e]) => SERVER_NAME.test(name) && typeof e?.command === 'string' && e.command)
      .map(([name]) => name),
  );
  return [...new Set(names)].sort();
}

const TOOLS = [
  { name: 'workspaces', description: 'The workspaces on this computer: folder, what is checked out, local changes, the tasks you can run, and whether a job holds it. Call this first.', inputSchema: { type: 'object', properties: {} } },
  {
    name: 'git_sync',
    description:
      "git fetch origin, then check out origin/<ref> (a pushed branch) or a commit, detached. Local changes that don't conflict carry over; if they would be overwritten it stops and changes nothing. Never resets, cleans, stashes or pushes. Refused in a workspace whose owner switched it off (the workspaces tool says so).",
    inputSchema: { type: 'object', properties: { workspace: { type: 'string' }, ref: { type: 'string', description: 'Branch name on origin, or a commit sha' } }, required: ['workspace', 'ref'] },
  },
  {
    name: 'run_task',
    description:
      'Run one of the workspace\'s tasks (listed by the workspaces tool) in its folder. Waits up to `wait` seconds (default and most 50), then returns the result, or a job id to pass to the job tool. One job per workspace at a time. A task marked "takes arguments" appends `args` to its command (no shell); others refuse them.',
    inputSchema: { type: 'object', properties: { workspace: { type: 'string' }, task: { type: 'string' }, wait: { type: 'number' }, args: { type: 'array', items: { type: 'string' }, description: 'Extra arguments, only for a task that takes them' } }, required: ['workspace', 'task'] },
  },
  {
    name: 'job',
    description: "A task job's state, exit code and last output lines; waits up to `wait` seconds (default and most 50) for it to finish.",
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, wait: { type: 'number' }, lines: { type: 'number', description: 'How many output lines to show, default 60' } }, required: ['id'] },
  },
  {
    name: 'stop_job',
    description: 'Stop a running task job (an app you launched, say) and everything it started, then show its last output.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'read_file',
    description: 'Read a text file in a workspace or its read folders, with line numbers. Paths are relative to the workspace, or full paths inside a read folder.',
    inputSchema: { type: 'object', properties: { workspace: { type: 'string' }, path: { type: 'string' }, offset: { type: 'number', description: 'First line, from 1' }, limit: { type: 'number', description: 'Lines, default 400' } }, required: ['workspace', 'path'] },
  },
  {
    name: 'list_files',
    description: 'List a folder in a workspace or its read folders (default: the workspace itself).',
    inputSchema: { type: 'object', properties: { workspace: { type: 'string' }, path: { type: 'string' } }, required: ['workspace'] },
  },
  {
    name: 'fetch_file',
    description: "Copy a file (up to 20 MB, any kind: a zip, a save, a log) from a workspace or its read folders to the app's server, into your files folder there, and return its path. The bytes don't pass through this conversation.",
    inputSchema: { type: 'object', properties: { workspace: { type: 'string' }, path: { type: 'string' } }, required: ['workspace', 'path'] },
  },
  {
    name: 'screenshot',
    description:
      "Take a PNG of this computer's screen, or of the first visible window whose title contains `window`, after `delay` seconds (most 30), and copy it to your files folder on the app's server; returns its path, which you can open to look at. Only on a computer whose owner turned screenshots on (a test box). While someone else has the screen it waits up to 50 s and keeps no place in line; take it while your own run_task job has the screen.",
    inputSchema: { type: 'object', properties: { window: { type: 'string', description: "Part of the window's title; leave out for the whole screen" }, delay: { type: 'number' } } },
  },
];

function run(command, args, opts) {
  return new Promise((done) => {
    let out = '';
    let stdout = '';
    const p = spawn(command, args, { ...opts, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    p.stdout.on('data', (d) => ((out += d), (stdout += d)));
    p.stderr.on('data', (d) => (out += d));
    p.on('error', (err) => done({ code: -1, out: err.message, stdout: '' }));
    p.on('close', (code) => done({ code, out: out.trim(), stdout: stdout.trim() }));
  });
}

// cmd.exe's special characters, escaped with ^ (the rules are cross-spawn's, MIT).
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/**
 * One line for cmd.exe /d /s /c to run a program with its arguments, each argument quoted for the program's own
 * parser and cmd's special characters escaped, so spaces, quotes and & | ; stay literal. Node's shell option
 * joins a program and its arguments with bare spaces. An npm shim under node_modules\.bin hands its arguments
 * to cmd again, so they are escaped twice.
 */
export function cmdLine(command, args) {
  const shim = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(command);
  const quote = (arg) => {
    const quoted = `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`.replace(CMD_META, '^$1');
    return shim ? quoted.replace(CMD_META, '^$1') : quoted;
  };
  return [command.replace(CMD_META, '^$1'), ...args.map(quote)].join(' ');
}

// Off Windows a task runs in a process group of its own, so stopping it reaches what it started too.
const OWN_GROUP = process.platform !== 'win32';
/** Task process groups still running: ended with the agent, which a Ctrl-C would no longer reach. */
const liveGroups = new Set();
let pruning = null;

/** Track a task's group until none of it is left, which may be long after its first process ended (`sleep 600 &`). */
function trackGroup(pid) {
  liveGroups.add(pid);
  // Dropped within seconds of emptying, before its id can name some other group the agent's exit would signal.
  pruning ??= setInterval(() => {
    for (const g of liveGroups) if (!signalGroup(g, 0)) liveGroups.delete(g);
    if (liveGroups.size) return;
    clearInterval(pruning);
    pruning = null;
  }, 5000).unref();
}

/** Signals a process group; false once none of it is left. */
function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

/** Ends a job's process and whatever it started (Godot under cmd.exe, say); resolves once that's done. */
async function killTree(child) {
  if (OWN_GROUP) {
    // Its group: SIGTERM, then SIGKILL for whatever is left after 3 s.
    if (!signalGroup(child.pid, 'SIGTERM')) return void child.kill();
    for (let i = 0; i < 30 && signalGroup(child.pid, 0); i++) await sleep(100);
    signalGroup(child.pid, 'SIGKILL');
    return;
  }
  return new Promise((done) =>
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      .on('close', done)
      .on('error', done),
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms).unref?.());
const secondsSince = (t) => Math.round((Date.now() - t) / 1000);
const waitFor = (v) => Math.min(WAIT_MAX, Math.max(0, Number.isFinite(v) ? v : WAIT_MAX));
const size = (n) => (n < 1024 * 1024 ? `${Math.ceil(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const ARGS_MAX = 64;
const ARG_LENGTH_MAX = 4000;
const SHOT_DELAY_MAX = 30;
/**
 * A reply to the app, tried again on a dropped line or a 5xx (MA6): otherwise the minion's tool call waits out Claude
 * Code's 30 minutes for an answer already made. About a minute in all; a 4xx is the app's answer and is not retried.
 */
export async function sendRetrying(post, onRetry = () => {}, waits = [1000, 2000, 4000, 8000, 16000, 30000]) {
  for (let i = 0; ; i++) {
    let res;
    try {
      res = await post();
      if (res.status < 500 || i >= waits.length) return res;
      onRetry(new Error(`the app answered ${res.status}`));
    } catch (err) {
      if (i >= waits.length) throw err;
      onRetry(err);
    }
    await new Promise((r) => setTimeout(r, waits[i]));
  }
}

const LOCK_STALE_MS = 2 * 60 * 60_000; // past any job's 30 minutes or a desktop CI job's timeout

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

const LINE_STALE_MS = 60_000; // a waiter that hasn't touched its place in a minute is gone
const LINE_POLL_MS = 2_000;
const LINE_ABSENT_MS = 3 * 60_000; // a queued task nobody has asked about this long leaves the line at its turn

/**
 * The test box's screen lock (#369): one file naming who has the screen, taken by the agent for a
 * task or a screenshot and by the box's CI job hooks (tools/win-test-box/screen-lock.ps1), so no
 * two of them put windows on the one screen at once. A holder whose process is gone, a lock older
 * than LOCK_STALE_MS, or an unreadable one over a minute old is broken and taken over.
 * Takes it for `mine` if it is free (or stale) and returns true; false while someone else has it.
 */
export function tryScreenLock(file, mine) {
  for (let tries = 0; tries < 3; tries++) {
    try {
      writeFileSync(file, JSON.stringify(mine), { flag: 'wx' });
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') throw new ToolError(`Could not take the screen lock ${file}: ${err.message}`);
    }
    let raw;
    let mtime;
    try {
      mtime = statSync(file).mtimeMs;
      raw = readFileSync(file, 'utf8');
    } catch {
      continue; // let go of between our try and now
    }
    let held = null;
    try {
      held = JSON.parse(raw);
    } catch {}
    const valid = Number.isInteger(held?.pid) && Number.isFinite(held?.since);
    const stale = valid ? !pidAlive(held.pid) || Date.now() - held.since > LOCK_STALE_MS : Date.now() - mtime > 60_000;
    if (!stale) return false;
    // Only the lock we judged: another taker may have broken it and taken it since.
    try {
      if (readFileSync(file, 'utf8') === raw) rmSync(file, { force: true });
    } catch {}
  }
  throw new ToolError(`Could not take the screen lock ${file}: it keeps coming back`);
}

/**
 * The screen's one waiting line (#1422), shared with the CI job hooks: a folder beside the lock with a file per
 * waiter, named by when it arrived, and every reader serves the first name in an ordinal sort. CI jobs go first
 * (Cara, 2026-11-22: "CI goes first"): theirs is `<ms, 15 digits>-<token>`, a minion's `t-<ms, 15 digits>-<token>`,
 * and "t" sorts after every digit, so any version of the agent or the hook agrees without comparing notes. Each
 * waiter touches its file while it waits; one whose pid is gone or whose file is a minute old is dropped by
 * whoever reads the line next. A waiting task is never pre-empted: a running holder keeps the lock.
 */
export const screenLineDir = (file) => join(dirname(file), 'screen-line');

/** Joins the line; the ticket is also the lock to write once it is this waiter's turn. */
export function joinScreenLine(file, what, who) {
  const dir = screenLineDir(file);
  mkdirSync(dir, { recursive: true });
  const mine = { pid: process.pid, what, who, since: Date.now(), token: randomBytes(6).toString('hex') };
  const place = join(dir, `t-${String(mine.since).padStart(15, '0')}-${mine.token}.json`);
  writeFileSync(place, JSON.stringify(mine));
  return { mine, place };
}

export function leaveScreenLine(ticket) {
  const leave = () => rmSync(ticket.place, { force: true });
  try {
    leave();
  } catch {
    // Windows refuses to delete a file another process is reading this moment; once more shortly.
    setTimeout(() => {
      try {
        leave();
      } catch {}
    }, 1000).unref?.();
  }
}

/** The live waiters, CI jobs first and then by arrival, dropping dead ones. */
export function screenLine(file) {
  const dir = screenLineDir(file);
  let names;
  try {
    names = readdirSync(dir)
      .filter((n) => n.endsWith('.json'))
      .sort();
  } catch {
    return [];
  }
  const line = [];
  for (const name of names) {
    const p = join(dir, name);
    let mtime;
    let w = null;
    try {
      mtime = statSync(p).mtimeMs;
      w = JSON.parse(readFileSync(p, 'utf8'));
    } catch {}
    if (mtime === undefined) continue; // left since the listing
    const fresh = Date.now() - mtime <= LINE_STALE_MS;
    // An unreadable one may be mid-write: skipped, and dropped only once it is stale.
    if (Number.isInteger(w?.pid) && pidAlive(w.pid) && fresh) line.push({ ...w, place: p });
    else if (w || !fresh) {
      try {
        rmSync(p, { force: true });
      } catch {}
    }
  }
  return line;
}

/**
 * One look at the line for a ticket: touches its place, and takes the screen when it is first and the lock is free.
 * Returns { lock } once taken (it has left the line), else { holder, ahead, waiting }. `take` false only looks.
 */
export function screenTurn(file, ticket, take = true) {
  try {
    utimesSync(ticket.place, new Date(), new Date());
  } catch {
    writeFileSync(ticket.place, JSON.stringify(ticket.mine)); // dropped while it was slow: back in its place
  }
  const line = screenLine(file);
  const at = line.findIndex((w) => w.token === ticket.mine.token);
  const ahead = at < 0 ? line.length : at;
  // The lock's since is when it took the screen, so a long wait in line doesn't count toward LOCK_STALE_MS.
  const lock = { ...ticket.mine, since: Date.now() };
  if (take && ahead === 0 && tryScreenLock(file, lock)) {
    leaveScreenLine(ticket);
    return { lock };
  }
  return { holder: screenHolder(file), ahead, waiting: line.length };
}

/** "task run in peek for Peek Auras #777, started 40 s ago", or what a free screen with others ahead looks like. */
function holderText(held) {
  if (!held) return 'nobody has the screen this moment';
  return `${held.what ?? 'something'} for ${held.who ?? 'someone'} has the screen${Number.isFinite(held.since) ? `, started ${secondsSince(held.since)} s ago` : ''}`;
}

/** Who holds the screen and who waits, for the workspaces tool and the Machines page. */
export function screenState(file) {
  const line = screenLine(file);
  const held = screenHolder(file);
  const brief = (w) => ({ what: String(w.what ?? '').slice(0, 200), who: String(w.who ?? '').slice(0, 200), since: Number.isFinite(w.since) ? w.since : null });
  return { holder: held ? brief(held) : null, line: line.map(brief) };
}

/** Lets go of the screen lock if it is still ours. */
export function releaseScreenLock(file, mine) {
  try {
    if (JSON.parse(readFileSync(file, 'utf8')).token === mine.token) rmSync(file, { force: true });
  } catch {}
}

/** Who holds the screen lock now, or null. */
function screenHolder(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// Reads the screen the way desktop tests do (GDI BitBlt with CAPTUREBLT, as Peek Auras'
// screen-check.ps1), per-monitor DPI aware so 125% gives real pixels. C# 5: Windows PowerShell's compiler.
// Progress off: Add-Type's "Preparing modules for first use" otherwise reaches stderr as CLIXML.
const SCREENSHOT_PS = String.raw`$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;

public static class CitadelShot {
    [DllImport("user32.dll")] static extern IntPtr SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr GetDC(IntPtr hwnd);
    [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr hwnd, IntPtr dc);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
    [DllImport("gdi32.dll", SetLastError = true)] static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll", SetLastError = true)] static extern IntPtr CreateCompatibleBitmap(IntPtr dc, int w, int h);
    [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr obj);
    [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
    [DllImport("gdi32.dll", SetLastError = true)]
    static extern bool BitBlt(IntPtr dest, int x, int y, int w, int h, IntPtr src, int sx, int sy, uint rop);
    delegate bool EnumProc(IntPtr hwnd, IntPtr param);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc proc, IntPtr param);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out RECT rect, int size);

    const uint SRCCOPY_CAPTUREBLT = 0x00CC0020 | 0x40000000;

    static Exception Why(string call) {
        int e = Marshal.GetLastWin32Error();
        return new Exception(call + ": " + new Win32Exception(e).Message + " (0x" + e.ToString("X8") + ")");
    }

    public static string Take(string file, string title) {
        SetProcessDpiAwarenessContext(new IntPtr(-4));
        int x = GetSystemMetrics(76), y = GetSystemMetrics(77), w = GetSystemMetrics(78), h = GetSystemMetrics(79);
        string what = "the whole screen";
        if (!String.IsNullOrEmpty(title)) {
            IntPtr found = IntPtr.Zero;
            string name = null;
            EnumWindows(delegate (IntPtr hwnd, IntPtr param) {
                if (!IsWindowVisible(hwnd) || IsIconic(hwnd)) return true;
                StringBuilder text = new StringBuilder(512);
                GetWindowText(hwnd, text, 512);
                if (text.ToString().IndexOf(title, StringComparison.OrdinalIgnoreCase) < 0) return true;
                found = hwnd;
                name = text.ToString();
                return false;
            }, IntPtr.Zero);
            if (found == IntPtr.Zero) throw new Exception("No visible window has '" + title + "' in its title");
            RECT r;
            if (DwmGetWindowAttribute(found, 9, out r, Marshal.SizeOf(typeof(RECT))) != 0) throw new Exception("Could not read where that window is");
            x = r.Left; y = r.Top; w = r.Right - r.Left; h = r.Bottom - r.Top;
            what = "window '" + name + "'";
        }
        if (w <= 0 || h <= 0) throw new Exception("Nothing to capture: " + what + " is " + w + "x" + h);
        IntPtr screen = GetDC(IntPtr.Zero);
        if (screen == IntPtr.Zero) throw Why("GetDC");
        IntPtr memory = IntPtr.Zero, bitmap = IntPtr.Zero, old = IntPtr.Zero;
        try {
            memory = CreateCompatibleDC(screen);
            if (memory == IntPtr.Zero) throw Why("CreateCompatibleDC");
            bitmap = CreateCompatibleBitmap(screen, w, h);
            if (bitmap == IntPtr.Zero) throw Why("CreateCompatibleBitmap");
            old = SelectObject(memory, bitmap);
            if (!BitBlt(memory, 0, 0, w, h, screen, x, y, SRCCOPY_CAPTUREBLT)) throw Why("BitBlt (a locked or disconnected screen refuses this)");
            SelectObject(memory, old);
            old = IntPtr.Zero;
            using (Image image = Image.FromHbitmap(bitmap)) image.Save(file, ImageFormat.Png);
            return what + ", " + w + "x" + h;
        } finally {
            if (old != IntPtr.Zero) SelectObject(memory, old);
            if (bitmap != IntPtr.Zero) DeleteObject(bitmap);
            if (memory != IntPtr.Zero) DeleteDC(memory);
            ReleaseDC(IntPtr.Zero, screen);
        }
    }
}
'@
[CitadelShot]::Take($env:CITADEL_SHOT_FILE, $env:CITADEL_SHOT_WINDOW)
} catch {
  $e = $_.Exception
  while ($e.InnerException) { $e = $e.InnerException }
  [Console]::Error.WriteLine($e.Message)
  exit 1
}`;

/** Saves a PNG of the screen, or of one window, to file; says what it took. Windows only. */
async function captureScreen(file, window) {
  if (process.platform !== 'win32') throw new ToolError('screenshot works only on a Windows computer');
  const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(SCREENSHOT_PS, 'utf16le').toString('base64')], {
    env: { ...process.env, CITADEL_SHOT_FILE: file, CITADEL_SHOT_WINDOW: window },
  });
  if (r.code) throw new ToolError(`The screenshot failed: ${r.out}`);
  return r.stdout;
}

/** The workspaces this computer offers, shared by every thread session: one lock and one job list. */
export class WorkspaceHost {
  constructor({ configFile, env = process.env, jobsDir, capture = captureScreen, screenWaitS = WAIT_MAX, linePollMs = LINE_POLL_MS, room = /** @type {((op: string, key: string, label?: string) => Promise<string | undefined>) | null} */ (null), roomPollMs = 30_000 }) {
    this.configFile = configFile;
    // A Windows test run asks Citadel for its size on this PC first (Build 7 M6c, #2120): room(op, key, label) → 'start',
    // 'late' or 'wait', and room('done', key) after. Null: tasks start as they always did (not Windows, or an old setup).
    /** @type {((op: string, key: string, label?: string) => Promise<string | undefined>) | null} */
    this.room = room;
    this.roomPollMs = roomPollMs;
    this.env = env;
    this.jobsDir = jobsDir;
    this.capture = capture;
    // How long a screenshot waits in the screen's line, and how often a waiter looks (shorter in tests).
    this.screenWaitS = screenWaitS;
    this.linePollMs = linePollMs;
    this.busy = new Map(); // workspace name -> { what, who, since, job? }
    this.jobs = new Map();
    // The workspace names minions get (#439), as ticked on the Machines page; null lends them all (an agent set up the old way).
    this.lent = null;
    this.reload();
  }

  reload() {
    ({ workspaces: this.all, servers: this.servers, problems: this.problems, screenLock: this.screenLock, screenshots: this.screenshots, jobs: this.jobsBlock, programs: this.programs } = loadConfig(this.configFile, this.env));
  }

  /** The workspaces minions get: every tool reads these, so one that isn't lent is not there for them. */
  /** A job in a folder that was unticked since it started is out of reach, like the folder (#439). */
  lentJob(job) {
    if (this.lent && !this.lent.has(job.workspace)) throw new ToolError(`Job ${job.id} ran in workspace ${job.workspace}, which this machine no longer lends.`);
  }

  get workspaces() {
    return this.lent ? new Map([...this.all].filter(([name]) => this.lent.has(name))) : this.all;
  }

  /** What the app shows on the Machines page. */
  summary() {
    return {
      workspaces: [...this.all.values()].map((w) => ({ name: w.name, path: w.path, read: w.read, git_sync: w.gitSync, tasks: [...w.tasks].map(([name, t]) => ({ name, run: t.run, about: t.about, args: t.args })) })),
      programs: [...this.programs.values()].map((p) => ({ name: p.name, path: p.path, about: p.about, args: p.args })),
      config_file: this.configFile,
      problems: this.problems,
    };
  }

  workspace(name) {
    const w = this.workspaces.get(name);
    if (!w) throw new ToolError(`No workspace "${name}" on this computer. There ${this.workspaces.size === 1 ? 'is' : 'are'}: ${[...this.workspaces.keys()].join(', ') || 'none'}.`);
    return w;
  }

  /** A file or folder the workspace may show: inside it (not its .git) or a read folder, after following links. */
  resolve(w, p) {
    const abs = isAbsolute(p ?? '') ? p : resolve(w.path, p || '.');
    let real;
    try {
      real = realpathSync.native(abs);
    } catch {
      throw new ToolError(`No such file or folder: ${p}`);
    }
    const inWorkspace = within(w.path, real);
    if (!inWorkspace && !w.read.some((r) => within(r, real))) throw new ToolError(`${p} is outside workspace ${w.name} and its read folders`);
    if (inWorkspace && relative(w.path, real).split(sep)[0].toLowerCase() === '.git') throw new ToolError('The .git folder is off limits');
    return real;
  }

  take(w, what, who) {
    const b = this.busy.get(w.name);
    if (b) throw new ToolError(`Workspace ${w.name} is busy: ${b.what} for ${b.who}, started ${secondsSince(b.since)} s ago${b.job ? ` (job ${b.job.id})` : ''}. Try again once it finishes.`);
    const lock = { what, who, since: Date.now() };
    this.busy.set(w.name, lock);
    return lock;
  }

  release(w, lock) {
    if (this.busy.get(w.name) === lock) this.busy.delete(w.name);
  }

  git(w, args) {
    // A missing sign-in fails fast instead of waiting on a prompt nobody sees.
    return run('git', ['-c', 'color.ui=never', ...args], { cwd: w.path, env: { ...this.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' } });
  }

  async checkout(w) {
    const [head, branch, status] = await Promise.all([this.git(w, ['log', '-1', '--format=%h %s']), this.git(w, ['symbolic-ref', '--short', '-q', 'HEAD']), this.git(w, ['status', '--porcelain'])]);
    const changes = status.out ? status.out.split('\n') : [];
    return {
      at: `${branch.code ? 'detached' : `branch ${branch.out}`} at ${head.out}`,
      changes: changes.length ? `${changes.slice(0, 20).join('\n')}${changes.length > 20 ? `\n…and ${changes.length - 20} more` : ''}` : 'none',
    };
  }

  async call(tool, args = {}, who = 'a minion', upload) {
    switch (tool) {
      case 'workspaces':
        return this.list();
      case 'git_sync':
        return this.sync(this.workspace(args.workspace), String(args.ref ?? '').replace(/^origin\//, ''), who);
      case 'run_task':
        return this.runTask(this.workspace(args.workspace), String(args.task ?? ''), who, waitFor(args.wait), args.args);
      case 'job': {
        const job = this.jobs.get(String(args.id ?? ''));
        if (!job) throw new ToolError(`No job ${args.id} here. Jobs are forgotten when the agent restarts; their logs stay in ${this.jobsDir}.`);
        this.lentJob(job);
        return this.report(job, waitFor(args.wait), Number(args.lines) || 60);
      }
      case 'stop_job': {
        const job = this.jobs.get(String(args.id ?? ''));
        if (!job) throw new ToolError(`No job ${args.id} here. Jobs are forgotten when the agent restarts.`);
        this.lentJob(job);
        if (!job.ended) await job.stop(`Stopped by ${who}`);
        return this.report(job, 0, 60);
      }
      case 'screenshot':
        return this.screenshot(String(args.window ?? ''), Number(args.delay) || 0, who, upload);
      case 'read_file':
        return this.read(this.workspace(args.workspace), args.path, Number(args.offset) || 1, Number(args.limit) || 400);
      case 'list_files':
        return this.listFiles(this.workspace(args.workspace), args.path);
      case 'fetch_file':
        return this.fetch(this.workspace(args.workspace), args.path, upload);
      default:
        throw new ToolError(`No tool ${tool}`);
    }
  }

  async list() {
    if (!this.workspaces.size) return { text: `No workspaces are set up on this computer.${this.problems.length ? `\nProblems in its config:\n${this.problems.join('\n')}` : ''}` };
    const parts = [];
    for (const w of this.workspaces.values()) {
      const c = await this.checkout(w);
      const b = this.busy.get(w.name);
      parts.push(
        [
          `## ${w.name}`,
          `Folder: ${w.path}`,
          w.read.length ? `Read folders: ${w.read.join(', ')}` : '',
          `Checked out: ${c.at}`,
          w.gitSync ? '' : 'git_sync: off (its owner keeps it on a branch)',
          `Local changes:\n${c.changes}`,
          `Busy: ${b ? `${b.what} for ${b.who}, ${secondsSince(b.since)} s${b.job ? ` (job ${b.job.id})` : ''}` : 'no'}`,
          'Tasks:',
          ...[...w.tasks].map(([name, t]) => `- ${name}: ${t.run.join(' ')}${t.args ? ' …takes arguments' : ''}${t.about ? ` (${t.about})` : ''}`),
        ]
          .filter(Boolean)
          .join('\n'),
      );
    }
    if (this.screenLock) {
      const { holder, line } = screenState(this.screenLock);
      parts.push(
        [
          `Screen: ${holder ? `busy, ${holder.what} for ${holder.who}` : 'free'}; ${line.length ? `${line.length} in line` : 'nobody in line'}.`,
          ...line.map((x, i) => `${i + 1}. ${x.what} for ${x.who}`),
          "Tasks that use it and screenshots join one line with this computer's CI desktop jobs, served in arrival order.",
        ].join('\n'),
      );
    }
    if (this.screenshots) parts.push('Screenshots: on (the screenshot tool).');
    if (this.problems.length) parts.push(`Problems in this computer's config (left out above):\n${this.problems.join('\n')}`);
    return { text: parts.join('\n\n') };
  }

  async sync(w, ref, who) {
    if (!w.gitSync) throw new ToolError(`git_sync is off for workspace ${w.name}: its owner keeps it on a branch. Use its tasks instead.`);
    if (!REF.test(ref)) throw new ToolError(`"${ref}" isn't a branch name or commit sha`);
    const lock = this.take(w, `git_sync ${ref}`, who);
    try {
      const before = await this.checkout(w);
      const fetched = await this.git(w, ['fetch', '--prune', 'origin']);
      if (fetched.code) {
        const auth = /terminal prompts disabled|could not read Username|Authentication failed|denied/i.test(fetched.out);
        throw new ToolError(`git fetch origin failed; nothing was changed.${auth ? ' Git has no working sign-in for this repo here: the owner needs to sign in to GitHub once in this account (for example by running git fetch in a terminal).' : ''}\n${fetched.out}`);
      }
      let target = await this.git(w, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${ref}^{commit}`]);
      if (target.code && SHA.test(ref)) target = await this.git(w, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
      if (target.code) throw new ToolError(`origin has no branch ${ref}${SHA.test(ref) ? ' and this clone has no such commit' : ''}. Push it first. Nothing was changed.`);
      const out = await this.git(w, ['checkout', '--detach', target.out]);
      if (out.code) {
        const files = (out.out.match(/would be overwritten by checkout:\n((?:\s+.+\n?)+)/)?.[1] ?? '')
          .trim()
          .split(/\s*\n\s*/)
          .filter(Boolean);
        throw new ToolError(
          files.length
            ? `Stopped: checking out ${ref} would overwrite local changes on this computer in:\n${files.join('\n')}\nNothing was changed. Those changes belong to the computer's owner: don't discard, stash or commit them; tell them and let them decide.`
            : `git checkout failed; nothing was changed.\n${out.out}`,
        );
      }
      const after = await this.checkout(w);
      // Whose sync left which commit: run_task refuses a caller whose own sync another one has since moved (MA5).
      (w.syncs ??= new Map()).set(who, { sha: target.out, at: Date.now() });
      return { text: `Checked out ${ref} in ${w.name}: ${after.at}.\nBefore: ${before.at}.\nLocal changes now:\n${after.changes}` };
    } finally {
      this.release(w, lock);
    }
  }

  async runTask(w, name, who, wait, extra) {
    const task = w.tasks.get(name);
    if (!task) throw new ToolError(`Workspace ${w.name} has no task "${name}". Its tasks: ${[...w.tasks.keys()].join(', ') || 'none'}. Only this computer's owner can add one.`);
    if (extra !== undefined && !(Array.isArray(extra) && extra.length === 0)) {
      if (!task.args) throw new ToolError(`Task ${name} takes no arguments; run it without args. Only this computer's owner can change that.`);
      if (!Array.isArray(extra) || extra.length > ARGS_MAX || !extra.every((a) => typeof a === 'string' && a.length <= ARG_LENGTH_MAX && !a.includes('\0'))) {
        throw new ToolError(`args must be a list of at most ${ARGS_MAX} strings`);
      }
    }
    const argv = [...task.run.map((a) => expand(a, this.env)), ...(task.args && Array.isArray(extra) ? extra : [])];
    // Before the locks: a jobs folder that can't be made must not leave them taken.
    mkdirSync(this.jobsDir, { recursive: true });
    this.prune();
    const lock = this.take(w, `task ${name}`, who);
    // The commit it runs, and a refusal when the caller synced and the workspace has moved since (MA5).
    const head = await this.git(w, ['rev-parse', 'HEAD']).catch(() => ({ code: 1, out: '' }));
    const commit = head.code ? null : head.out;
    const mine = w.syncs?.get(who);
    if (mine && commit && commit !== mine.sha) {
      this.release(w, lock);
      const by = [...w.syncs]
        .filter(([k, v]) => k !== who && v.sha === commit && v.at > mine.at)
        .map(([k]) => k)
        .at(-1);
      throw new ToolError(`Not run: ${w.name} has moved since your git_sync. You checked out ${mine.sha.slice(0, 10)}; it is now at ${commit.slice(0, 10)}${by ? `, synced since by ${by}` : ', changed on that computer'}. Run git_sync again, then run_task.`);
    }
    let ticket = null;
    // A run that waits for room on this PC joins the screen's line only once it has room, so it never holds the screen meanwhile.
    const roomed = !!this.room;
    try {
      // Every screen task joins the line, even with the screen free: it is the line that keeps arrival order.
      if (this.screenLock && task.screen && !roomed) ticket = joinScreenLine(this.screenLock, `task ${name} in ${w.name}`, who);
    } catch (err) {
      this.release(w, lock);
      throw new ToolError(`Could not join the screen's line: ${err.message}`);
    }
    const id = randomBytes(4).toString('hex');
    const job = { id, workspace: w.name, task, name, who, commit, started: Date.now(), ended: null, code: null, error: null, tail: [], partial: '', log: join(this.jobsDir, `${id}.log`), line: null, seen: Date.now(), watching: 0 };
    lock.job = job;
    this.jobs.set(id, job);
    const file = createWriteStream(job.log).on('error', () => {});
    file.write(`${argv.join(' ')}\n(in ${w.path}${commit ? ` at ${commit}` : ''}, for ${who})\n\n`);
    job.done = new Promise((resolveDone) => {
      let child;
      let screen = null;
      let limit = null;
      let poll = null;
      let renew = null;
      // Why it is being stopped: it may exit while that is under way.
      let stopping = null;
      const finish = (code, error) => {
        if (job.ended) return;
        error ??= stopping;
        clearTimeout(limit);
        clearTimeout(poll);
        clearInterval(renew);
        if (roomed) this.room('done', job.id).catch(() => {});
        job.room = null;
        job.ended = Date.now();
        job.code = code;
        job.error = error;
        if (job.partial) job.tail.push(job.partial);
        file.end(error ? `\n${error}\n` : `\nexit ${code}\n`);
        this.release(w, lock);
        if (ticket && job.line) leaveScreenLine(ticket);
        job.line = null;
        if (screen) releaseScreenLock(this.screenLock, screen);
        resolveDone();
      };
      job.stop = async (why) => {
        stopping = why;
        if (child) await killTree(child);
        finish(null, why);
      };
      const start = () => {
        job.started = Date.now();
        // The 30 minutes count from when it has the screen, not from when it joined the line.
        limit = setTimeout(() => {
          stopping = `Stopped after ${TASK_LIMIT_MS / 60_000} minutes`;
          if (child) killTree(child);
          finish(null, stopping);
        }, TASK_LIMIT_MS);
        try {
          child = spawn(argv[0], argv.slice(1), { cwd: w.path, env: this.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: OWN_GROUP });
          if (OWN_GROUP && child.pid) trackGroup(child.pid);
          // Started late (its 30 min waited with no room): it runs below the turns on this PC (the spec's rule 3).
          if (job.late && child.pid) {
            try {
              nodeOs.setPriority(child.pid, nodeOs.constants.priority.PRIORITY_BELOW_NORMAL);
            } catch {
              /* it runs at normal priority, that's all */
            }
          }
        } catch (err) {
          return finish(null, `Could not start ${argv[0]}: ${err.message}`);
        }
        const take = (d) => {
          if (job.ended) return;
          file.write(d);
          const lines = (job.partial + d.toString()).split(/\r?\n/);
          job.partial = lines.pop();
          job.tail.push(...lines);
          if (job.tail.length > TAIL_LINES) job.tail.splice(0, job.tail.length - TAIL_LINES);
        };
        child.stdout.on('data', take);
        child.stderr.on('data', take);
        child.on('error', (err) => finish(null, err.code === 'ENOENT' ? `${argv[0]} is not on this computer's PATH` : `Could not start ${argv[0]}: ${err.message}`));
        child.on('close', (code) => finish(code, null));
        // A program it started (the game, say) can hold the output open after it exits; don't wait on that.
        child.on('exit', (code) => setTimeout(() => finish(code, null), 1000));
      };
      const queue = () => {
        if (roomed && task.screen && this.screenLock) {
          try {
            ticket = joinScreenLine(this.screenLock, `task ${name} in ${w.name}`, who);
          } catch (err) {
            return finish(null, `Could not join the screen's line: ${err.message}`);
          }
        }
        if (!ticket) return start();
        job.line = { holder: null, ahead: 0, waiting: 1 };
        look();
      };
      const look = () => {
        if (job.ended) return;
        let turn;
        try {
          // Its turn came with nobody asking after it (its minion's turn ended, say): it leaves rather than run unwatched.
          const absent = !job.watching && Date.now() - job.seen > LINE_ABSENT_MS;
          turn = screenTurn(this.screenLock, ticket, !absent);
          if (absent && turn.ahead === 0) {
            return finish(null, `Left the screen's line: its turn came and nobody had called job for it in ${LINE_ABSENT_MS / 60_000} minutes. Nothing was started.`);
          }
        } catch (err) {
          return finish(null, err.message);
        }
        if (turn.lock) {
          screen = turn.lock;
          job.line = null;
          return start();
        }
        job.line = turn;
        poll = setTimeout(look, this.linePollMs);
        poll.unref?.();
      };
      if (!roomed) return queue();
      // Asked again every roomPollMs while it waits and while it runs: that keeps its room on Citadel's lease.
      const ask = () => {
        if (job.ended) return;
        this.room('ask', job.id, `${name} in ${w.name}`).then(
          (go) => {
            if (job.ended) return;
            if (go === 'wait') {
              job.room = { since: job.room?.since ?? Date.now() };
              poll = setTimeout(ask, this.roomPollMs);
              poll.unref?.();
              return;
            }
            job.room = null;
            job.late = go === 'late';
            renew = setInterval(() => this.room('ask', job.id, `${name} in ${w.name}`).catch(() => {}), this.roomPollMs);
            renew.unref?.();
            queue();
          },
          // No answer (Citadel away, an older server): it goes ahead, as before.
          () => {
            if (job.ended) return;
            job.room = null;
            queue();
          },
        );
      };
      job.room = { since: Date.now() };
      ask();
    });
    return this.report(job, wait, 60);
  }

  async report(job, wait, lines) {
    if (!job.ended) {
      // A queued job keeps its place while someone keeps asking after it (LINE_ABSENT_MS).
      job.seen = Date.now();
      job.watching = (job.watching ?? 0) + 1;
      try {
        await Promise.race([job.done, sleep(wait * 1000)]);
      } finally {
        job.watching--;
        job.seen = Date.now();
      }
    }
    if (job.room) {
      return {
        text: `${job.name} in ${job.workspace} is waiting for room on this computer (job ${job.id}), ${secondsSince(job.room.since)} s so far: Citadel is holding it until this computer has room for it beside the minion turns running here (no new turn starts here meanwhile), and after 30 minutes of waiting it starts anyway, at lower priority. Nothing has started yet. It keeps waiting without you: call job with id "${job.id}" to wait for it (each call waits up to ${WAIT_MAX} s), or stop_job with id "${job.id}" to give up on it.`,
      };
    }
    if (job.line) {
      const { holder, ahead, waiting } = job.line;
      return {
        text: `${job.name} in ${job.workspace} is waiting in line for the screen (job ${job.id}), ${secondsSince(job.started)} s so far: ${holderText(holder)}; ${ahead ? `${ahead} ahead of it` : 'it is next'}, ${waiting} in line. Nothing has started yet. It keeps its place while you wait: call job with id "${job.id}" (each call waits up to ${WAIT_MAX} s). If nobody calls job for it for ${LINE_ABSENT_MS / 60_000} minutes when its turn comes, it leaves the line; stop_job leaves it now.`,
      };
    }
    const tail = job.tail.slice(-Math.min(Math.max(1, lines), TAIL_LINES)).join('\n');
    if (!job.ended) return { text: `${job.name} in ${job.workspace} is still running after ${secondsSince(job.started)} s (job ${job.id}). Call job with id "${job.id}" to wait for it.\n--- latest output ---\n${job.tail.slice(-20).join('\n')}` };
    const ok = job.code === 0;
    const all = job.tail.join('\n');
    const hints = job.task.hints.filter((h) => (h.exit !== undefined ? h.exit === job.code : false) || (h.match && !ok && h.match.test(all))).map((h) => h.say);
    const head = `${job.name} in ${job.workspace} ${ok ? 'succeeded' : 'FAILED'} (${job.error ?? `exit ${job.code}`}) after ${Math.round((job.ended - job.started) / 1000)} s${job.commit ? ` at commit ${job.commit.slice(0, 10)}` : ''}. Job ${job.id}; full log on that computer: ${job.log}`;
    return { text: [head, ...hints, `--- last ${Math.min(lines, job.tail.length)} lines ---`, tail].join('\n'), isError: !ok };
  }

  prune() {
    for (const [id, j] of this.jobs) if (this.jobs.size > 50 && j.ended) this.jobs.delete(id);
    try {
      const logs = readdirSync(this.jobsDir)
        .filter((f) => f.endsWith('.log'))
        .map((f) => ({ f, t: statSync(join(this.jobsDir, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t);
      for (const { f } of logs.slice(KEEP_LOGS)) rmSync(join(this.jobsDir, f), { force: true });
    } catch {}
  }

  read(w, p, offset, limit) {
    const real = this.resolve(w, p);
    const st = statSync(real);
    if (st.isDirectory()) throw new ToolError(`${p} is a folder; use list_files`);
    if (st.size > READ_MAX) throw new ToolError(`${p} is ${size(st.size)}, too big to read here; use fetch_file`);
    const buf = readFileSync(real);
    if (buf.subarray(0, 8000).includes(0)) throw new ToolError(`${p} isn't text; use fetch_file to copy it over`);
    const all = buf.toString('utf8').split(/\r?\n/);
    const first = Math.max(1, offset);
    const shown = all.slice(first - 1, first - 1 + Math.min(Math.max(1, limit), 2000));
    let text = shown.map((l, i) => `${String(first + i).padStart(6)}\t${l}`).join('\n');
    if (text.length > 200_000) text = `${text.slice(0, 200_000)}\n…cut at 200,000 characters; read on with a later offset`;
    return { text: `${real} (${all.length} lines)\n${text}` };
  }

  listFiles(w, p) {
    const real = this.resolve(w, p);
    if (!statSync(real).isDirectory()) throw new ToolError(`${p} is a file; use read_file or fetch_file`);
    const entries = readdirSync(real, { withFileTypes: true }).filter((e) => real !== w.path || e.name !== '.git');
    const rows = entries.slice(0, 500).map((e) => {
      try {
        const st = statSync(join(real, e.name));
        return st.isDirectory() ? `${e.name}/` : `${e.name}\t${size(st.size)}\t${st.mtime.toISOString().slice(0, 16).replace('T', ' ')}`;
      } catch {
        return `${e.name}\t(unreadable)`;
      }
    });
    return { text: `${real}\n${rows.join('\n') || '(empty)'}${entries.length > 500 ? `\n…and ${entries.length - 500} more` : ''}` };
  }

  async screenshot(window, delay, who, upload) {
    if (!this.screenshots) throw new ToolError('Screenshots are off on this computer. Its owner turns them on with "screenshots": true in machine-agent.json (a test box has it).');
    if (window.length > 200) throw new ToolError('window is part of a title: at most 200 characters');
    if (!upload) throw new ToolError('This session has no way to send files to the app');
    // A minion looking at the app its own job launched already has the screen.
    const held = this.screenLock ? screenHolder(this.screenLock) : null;
    const own = held && held.pid === process.pid && held.who === who;
    const screen = this.screenLock && !own ? await this.waitForScreen('a screenshot', who) : null;
    try {
      await sleep(Math.min(SHOT_DELAY_MAX, Math.max(0, delay)) * 1000);
      mkdirSync(this.jobsDir, { recursive: true });
      const file = join(this.jobsDir, `screenshot-${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
      const what = await this.capture(file, window);
      const bytes = readFileSync(file);
      rmSync(file, { force: true });
      const dest = await upload(basename(file), bytes);
      return { text: `Took ${what} (${size(bytes.length)}) and copied it to ${dest} on the app's server. Open that file to look at it.` };
    } finally {
      if (screen) releaseScreenLock(this.screenLock, screen);
    }
  }

  /** A screenshot's place in the line: it waits inside the call, at most WAIT_MAX seconds, then leaves it. */
  async waitForScreen(what, who) {
    const ticket = joinScreenLine(this.screenLock, what, who);
    const until = Date.now() + this.screenWaitS * 1000;
    try {
      for (;;) {
        const turn = screenTurn(this.screenLock, ticket);
        if (turn.lock) return turn.lock;
        if (Date.now() >= until) {
          const others = turn.waiting - 1;
          throw new ToolError(
            `The screen is busy: ${holderText(turn.holder)}${others > 0 ? `, and ${others} other${others === 1 ? ' is' : 's are'} in line (${turn.ahead} ahead of this)` : ''}. Waited ${this.screenWaitS} s; nothing was taken. A screenshot waits only inside its own call. To see your app, start it with run_task: a screen task keeps its place in line and starts on its own, and Citadel messages you when it has the screen. Take the screenshot while it runs.`,
          );
        }
        await sleep(Math.max(0, Math.min(this.linePollMs, until - Date.now())));
      }
    } finally {
      leaveScreenLine(ticket);
    }
  }

  async fetch(w, p, upload) {
    const real = this.resolve(w, p);
    const st = statSync(real);
    if (!st.isFile()) throw new ToolError(`${p} isn't a file`);
    if (st.size > FETCH_MAX) throw new ToolError(`${p} is ${size(st.size)}; fetch_file copies at most ${size(FETCH_MAX)}`);
    if (!upload) throw new ToolError('This session has no way to send files to the app');
    const dest = await upload(basename(real), readFileSync(real));
    return { text: `Copied ${real} (${size(st.size)}) to ${dest} on the app's server.` };
  }
}

/** One MCP message for the workspace server; the reply to send back, or null for a notification. */
export async function workspaceReply(host, message, who, upload) {
  if (message?.id === undefined || !message.method) return null;
  const reply = (result) => ({ jsonrpc: '2.0', id: message.id, result });
  switch (message.method) {
    case 'initialize':
      return reply({ protocolVersion: message.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'citadel-workspace', version: '1' } });
    case 'ping':
      return reply({});
    case 'tools/list':
      // No workspace takes git_sync, or screenshots are off: don't offer them.
      const sync = [...host.workspaces.values()].some((w) => w.gitSync) || !host.workspaces.size;
      return reply({ tools: TOOLS.filter((t) => (t.name !== 'git_sync' || sync) && (t.name !== 'screenshot' || host.screenshots)) });
    case 'tools/call':
      try {
        const { text, isError } = await host.call(message.params?.name, message.params?.arguments ?? {}, who, upload);
        return reply({ content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) });
      } catch (err) {
        return reply({ content: [{ type: 'text', text: err instanceof ToolError ? err.message : `Error: ${err.message}` }], isError: true });
      }
    default:
      return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Unknown method ${message.method}` } };
  }
}

// ---------- GPU jobs (#858) ----------
// A job is a container the app queues on this computer (specs/desktop-gpu-jobs.md in Citadel's shared folder).
// The app is trusted but this side is the wall: a job runs only from an image pinned by digest, sees only its own
// /in (read-only), /out, /state, its kind's /cache and the owner's named folders (read-only), and only /out and
// its log ever leave. Each job's state lives in its folder, so a job outlives the agent and is picked up again.

const JOB_LIMIT_H = 12;
// The app's job ids are positive integers; one becomes a folder and a container name.
const JOB_ID = /^[1-9][0-9]{0,15}$/;
const JOB_IMAGE = /^[a-z0-9][a-z0-9._/:-]{0,250}@sha256:[a-f0-9]{64}$/;
const JOB_FILE = /^[A-Za-z0-9_][A-Za-z0-9_ .-]{0,199}$/;
// An /out path segment the app takes (src/machine-jobs.ts safeRelPath).
const OUT_SEGMENT = /^[\w][\w .-]{0,199}$/;
const JOB_ENDED = ['done', 'failed', 'stopped'];
const JOB_INPUTS_MAX = 2 * 1024 ** 3;
const JOB_LOG_TAIL = 4096;
const JOB_LOG_MAX = 20 * 1024 ** 2;
const JOB_OUTPUTS_MAX = 500;
const GPU_BUSY_PCT = 5;
const DISK_CHECK_TICKS = 6;
// podman's k8s-file log prefixes every line with a time, the stream and F (full) or P (partial).
const K8S_LOG_PREFIX = /^\S+ (?:stdout|stderr) [FP] ?/gm;

/** The size of everything under a folder, symlinks counted as themselves. */
function du(path) {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return 0;
  }
  if (!st.isDirectory()) return st.size;
  let total = 0;
  for (const e of readdirSync(path)) total += du(join(path, e));
  return total;
}

/** A job's log as people read it: podman's per-line prefixes gone. */
const cleanLog = (text) => text.replace(K8S_LOG_PREFIX, '');

/** The last bytes of a file, or '' when there is none. */
function fileTail(file, bytes) {
  try {
    const size = statSync(file).size;
    const fd = openSync(file, 'r');
    try {
      const buf = Buffer.alloc(Math.min(bytes, size));
      readSync(fd, buf, 0, buf.length, size - buf.length);
      return buf.toString('utf8');
    } finally {
      closeSync(fd);
    }
  } catch {
    return '';
  }
}

/** One call to the app with this machine's key; resolves with the response (a stream), rejects on a network failure. */
function appCall(appUrl, token, method, path, { headers = {}, body } = {}) {
  const url = new URL(path, appUrl);
  const mod = url.protocol === 'https:' ? https : http;
  return new Promise((done, fail) => {
    const req = mod.request(url, { method, headers: { Authorization: `Bearer ${token}`, ...headers } }, done);
    req.on('error', fail);
    req.setTimeout(120_000, () => req.destroy(new Error('the app stopped answering')));
    if (body instanceof Readable) body.on('error', (err) => req.destroy(err)).pipe(req);
    else req.end(body);
  });
}

async function readBody(res) {
  let text = '';
  for await (const chunk of res) text += chunk;
  try {
    return JSON.parse(text);
  } catch {
    return { error: text.slice(0, 300) };
  }
}

/**
 * Every file under a job's /out (its real path) that may leave this computer, and every one that may not, with why.
 * A symlink is followed only to a regular file inside /out; a folder link, a device or a fifo is never read.
 */
export function outFiles(out) {
  const files = [];
  const walk = (dir, rel) => {
    for (const e of readdirSync(dir).sort()) {
      if (files.length >= JOB_OUTPUTS_MAX) return;
      const abs = join(dir, e);
      const path = rel ? `${rel}/${e}` : e;
      const st = lstatSync(abs);
      if (st.isDirectory()) {
        walk(abs, path);
        continue;
      }
      const segs = path.split('/');
      const named = segs.length <= 20 && segs.every((x) => OUT_SEGMENT.test(x) && !x.endsWith('.part'));
      let real = abs;
      let why = named ? null : 'a name the app does not take';
      if (!why && st.isSymbolicLink()) {
        try {
          real = realpathSync.native(abs);
          if (!within(out, real)) why = 'a link to outside /out';
          else if (!statSync(real).isFile()) why = 'a link to something that is not a file';
        } catch {
          why = 'a broken link';
        }
      } else if (!why && !st.isFile()) why = 'not a file';
      files.push({ path, real, size: why ? 0 : statSync(real).size, why });
    }
  };
  walk(out, '');
  return files;
}

/** The podman arguments that run a job: the whole wall in one list. */
export function podmanRunArgs(job, block, resume) {
  const dir = join(block.dir, job.id);
  const mount = (src, dst, ro) => ['--mount', `type=bind,src=${src},dst=${dst}${ro ? ',ro' : ''}`];
  return [
    'run',
    '-d',
    '--name',
    `citadel-job-${job.id}`,
    '--label',
    `citadel.job=${job.id}`,
    '--cap-drop',
    'all',
    '--security-opt',
    'no-new-privileges',
    '--security-opt',
    'label=disable',
    // The owner's own uid inside, never root; rootless podman maps it to the owner outside too.
    '--userns',
    'keep-id',
    '-e',
    'HOME=/tmp',
    '-e',
    'XDG_CACHE_HOME=/cache',
    ...(job.kind.network ? [] : ['--network', 'none']),
    ...(job.kind.gpu && block.gpu ? ['--device', 'nvidia.com/gpu=all'] : []),
    ...(resume ? ['-e', 'CITADEL_JOB_RESUME=1'] : []),
    // podman writes the log itself, so it keeps growing while the agent is down.
    '--log-driver',
    'k8s-file',
    '--log-opt',
    `path=${join(dir, 'job.log')}`,
    ...mount(join(dir, 'in'), '/in', true),
    ...mount(join(dir, 'out'), '/out'),
    ...mount(join(dir, 'state'), '/state'),
    // Model downloads, kept between jobs of the same kind so only the first run needs the network.
    ...mount(join(block.dir, 'cache', cacheName(job.kind.name)), '/cache'),
    ...job.kind.reads.flatMap((name) => mount(block.folders.get(name), `/private/${name}`, true)),
    job.kind.image,
    ...job.kind.command,
  ];
}

const cacheName = (kind) => kind.replace(/[^A-Za-z0-9_-]/g, '_');

/** Why a job.start must be refused, or null. Only what the owner's block allows gets past. */
export function refuseStart(msg, block) {
  if (!block) return 'this machine has no jobs block in machine-agent.json';
  const k = msg.kind;
  if (!k || typeof k !== 'object' || typeof k.name !== 'string' || !k.name) return 'the job has no kind';
  if (typeof k.image !== 'string' || !JOB_IMAGE.test(k.image)) return `the image must be pinned by digest (name@sha256:…), not ${String(k.image).slice(0, 100)}`;
  if (!Array.isArray(k.command) || !k.command.length || k.command.length > 64 || !k.command.every((a) => typeof a === 'string' && !a.includes('\0'))) return 'the command must be a list of arguments';
  if (!Array.isArray(k.reads) || !k.reads.every((r) => typeof r === 'string')) return 'reads must be a list of folder names';
  const unknown = k.reads.filter((r) => !block.folders.has(r));
  if (unknown.length) return `this machine's owner doesn't offer the folder${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')}`;
  if (k.gpu === true && !block.gpu) return "this machine's owner hasn't given jobs the GPU";
  if (!Number.isInteger(msg.limit_s) || msg.limit_s <= 0) return 'the time limit must be a whole number of seconds';
  if (msg.limit_s > block.max_limit_h * 3600) return `the time limit is over this machine's ${block.max_limit_h} h`;
  if (!Array.isArray(msg.inputs) || msg.inputs.length > 500) return 'inputs must be a list';
  const names = new Set();
  let total = 0;
  for (const f of msg.inputs) {
    if (typeof f?.name !== 'string' || !JOB_FILE.test(f.name) || names.has(f.name)) return `the input name ${String(f?.name).slice(0, 60)} isn't a plain file name`;
    if (!Number.isInteger(f.size) || f.size < 0 || typeof f.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(f.sha256)) return `input ${f.name} needs a size and a sha256`;
    names.add(f.name);
    total += f.size;
  }
  if (total > JOB_INPUTS_MAX) return 'the inputs are over 2 GB';
  if (typeof msg.input_token !== 'string' || !msg.input_token) return 'the job has no input token';
  return null;
}

/**
 * The jobs on this computer, run with podman, at most one at a time. `block` is the owner's jobs block (loadJobs), or
 * null; `podman` and `nvidiaSmi` are commands as lists (tests hand it fakes). Reports go to the app as they happen.
 */
export class JobRunner {
  constructor({ block, appUrl, token, log = () => {}, podman = ['podman'], nvidiaSmi = ['nvidia-smi'], tickMs = 10_000, graceS = 60, smiTimeoutMs = 30_000 }) {
    Object.assign(this, { appUrl, token, log, podman, nvidiaSmi, tickMs, graceS, smiTimeoutMs });
    this.jobs = new Map();
    this.children = new Set();
    this.ticks = 0;
    this.lastSample = Date.now();
    // One tick at a time (#1550): a tick that outlasts the interval (a slow nvidia-smi) was joined by the next, each
    // starting its own nvidia-smi and reports, which under load slowed every later one.
    this.timer = setInterval(() => {
      if (this.ticking) return;
      this.ticking = true;
      this.tick()
        .catch((err) => this.log(`Jobs: ${err.message}`))
        .finally(() => (this.ticking = false));
    }, tickMs);
    this.timer.unref();
    this.block = null;
    this.closed = false;
    // Until it has looked in its jobs folder (a block broken since the start) it can't say what it holds: nothing is lost on that (2MA5).
    this.restored = false;
    this.ready = this.setBlock(block).catch((err) => this.log(`Jobs: could not read the jobs folder: ${err.message}`));
  }

  /** The owner changed the jobs block. With none, new jobs are refused; jobs already here keep their limits. */
  async setBlock(block) {
    const fresh = block && block.dir !== this.block?.dir;
    this.block = block;
    if (!fresh) return;
    await this.restore();
    this.restored = true;
  }

  /** What the app's info gets: folder names only, never their paths. */
  offer() {
    const b = this.block;
    return b && { folders: [...b.folders.keys()], max_limit_h: b.max_limit_h, max_disk_gb: b.max_disk_gb, gpu: b.gpu };
  }

  /** The jobs this agent holds and hasn't finished telling the app about, for the app's reconcile on connect. */
  known() {
    return [...this.jobs.values()]
      .filter((j) => !j.final_sent)
      .slice(0, 100)
      .map((j) => ({ id: Number(j.id), state: j.state }));
  }

  /** For the owner's Machines page: job folders holding results the app never took, which nothing here deletes (MA3). */
  leftover() {
    const dir = this.block?.dir;
    if (!dir) return [];
    const left = [];
    try {
      for (const e of readdirSync(dir)) {
        if (!JOB_ID.test(e)) continue;
        try {
          const j = JSON.parse(readFileSync(join(dir, e, 'job.json'), 'utf8'));
          if (j.final_sent && (j.outputs ?? []).some((o) => o && o.uploaded === false)) left.push({ id: e, bytes: du(join(dir, e)) });
        } catch {}
      }
    } catch {
      return [];
    }
    if (!left.length) return [];
    const mb = Math.ceil(left.reduce((n, l) => n + l.bytes, 0) / 1024 ** 2);
    const ids = left.map((l) => l.id).sort((a, b) => Number(a) - Number(b));
    return [
      `jobs: ${left.length} job folder${left.length === 1 ? '' : 's'} (${mb} MB) in the jobs folder hold results Citadel never took: ${ids.slice(0, 8).join(', ')}${ids.length > 8 ? ` and ${ids.length - 8} more` : ''}. They count against max_disk_gb and are never deleted for you: copy what you need from each one's out folder, then delete it.`,
    ];
  }

  close() {
    this.closed = true;
    clearInterval(this.timer);
    for (const c of this.children) c.kill();
  }

  /** A podman (or nvidia-smi) call; resolves with its exit code and output, never rejects. Killed after `timeout` ms, if given. */
  exec(cmd, args, timeout, onStart) {
    return new Promise((done) => {
      let stdout = '';
      let out = '';
      const p = spawn(cmd[0], [...cmd.slice(1), ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout });
      this.children.add(p);
      onStart?.(p);
      p.stdout.on('data', (d) => ((stdout += d), (out += d)));
      p.stderr.on('data', (d) => (out += d));
      p.on('error', (err) => (this.children.delete(p), done({ code: -1, stdout: '', out: err.message })));
      p.on('close', (code) => (this.children.delete(p), done({ code, stdout: stdout.trim(), out: out.trim() })));
    });
  }

  call(method, path, opts) {
    return appCall(this.appUrl, this.token, method, path, opts);
  }

  name(job) {
    return `citadel-job-${job.id}`;
  }

  dir(job, ...rest) {
    return join(job.home, job.id, ...rest);
  }

  save(job) {
    const file = this.dir(job, 'job.json');
    writeFileSync(
      `${file}.new`,
      JSON.stringify(job, (k, v) => (k.startsWith('_') || k === 'home' ? undefined : v)),
    );
    renameSync(`${file}.new`, file);
  }

  runS(job) {
    return Math.floor((job.run_ms + (job.since ? Date.now() - job.since : 0)) / 1000);
  }

  /** Paused, stopped or ended: the time limit stops counting. */
  closeSegment(job) {
    if (!job.since) return;
    job.run_ms += Date.now() - job.since;
    job.since = null;
  }

  /** Tells the app where a job stands. True once the app has heard it, refusal included; false if it couldn't be reached or took none of it. */
  async report(job) {
    const g = job._gpu;
    const body = {
      id: Number(job.id),
      state: job.state,
      run_s: this.runS(job),
      gpu_busy_s: Math.round(job.gpu_busy_s),
      gpu_pct: g?.pct ?? null,
      vram_mb: g?.vram ?? null,
      log_tail: cleanLog(fileTail(this.dir(job, 'job.log'), JOB_LOG_TAIL * 2)).slice(-JOB_LOG_TAIL),
      ...(job.state === 'paused' && job.paused === 'frozen' && g ? { held_vram_mb: g.vram } : {}),
      ...(job.outputs.length ? { outputs: job.outputs.map(({ path, size, uploaded, why }) => ({ path, size, uploaded, ...(why && !uploaded ? { why } : {}) })) } : {}),
      ...(JOB_ENDED.includes(job.state) ? { exit_code: job.final.exit_code, ...(job.final.error ? { error: job.final.error } : {}) } : {}),
      // Sent on every report until the app has heard it, so a lost one can't leave it showing paused (MA2).
      ...(job.pause_failed && job.state === 'running' ? { pause_failed: job.pause_failed } : {}),
    };
    let res;
    try {
      const post = (b) => this.call('POST', '/api/machines/job-state', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
      res = await post(body);
      // Too big for the route (MA7): the state matters, the log tail and a long output list don't.
      if (res.statusCode === 413) {
        res.resume();
        res = await post({ ...body, log_tail: '', ...(body.outputs ? { outputs: body.outputs.slice(0, 100).map((o) => ({ ...o, path: o.path.slice(0, 200), why: o.why?.slice(0, 100) })) } : {}) });
      }
    } catch (err) {
      this.log(`Job ${job.id}: could not report ${job.state}: ${err.message}`);
      return false;
    }
    res.resume();
    // The app ended it, never started it, or doesn't know it: it must not keep running here.
    if ((res.statusCode === 409 || res.statusCode === 404) && !job.final) this.stop(job, 'stopped', 'the app ended it');
    if (res.statusCode === 413) this.log(`Job ${job.id}: the app refused its ${job.state} report as too big`);
    const heard = res.statusCode < 500 && res.statusCode !== 413;
    if (heard && body.pause_failed) this.save(Object.assign(job, { pause_failed: null }));
    return heard;
  }

  /** A job.start this agent won't run: the app hears why, and nothing is made on disk. */
  async refuse(msg, why) {
    this.log(`Job ${msg.id}: refused: ${why}`);
    const body = { id: Number(msg.id), state: 'failed', run_s: 0, gpu_busy_s: 0, error: `Refused by the machine: ${why}` };
    try {
      (await this.call('POST', '/api/machines/job-state', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).resume();
    } catch (err) {
      this.log(`Job ${msg.id}: could not report the refusal: ${err.message}`);
    }
  }

  /** One message from the app's stream: { type, id, ... }. */
  async handle(msg) {
    await this.ready;
    const id = String(msg?.id ?? '');
    if (!JOB_ID.test(id)) return this.log(`Ignored a job message with id ${id.slice(0, 20)}`);
    const job = this.jobs.get(id);
    if (msg.type === 'job.start') return job ? this.log(`Job ${id}: already here, start ignored`) : this.start({ ...msg, id });
    if (!job) return this.log(`Job ${id}: ${msg.type} for a job not on this machine`);
    if (msg.type === 'job.pause') return this.pause(job);
    if (msg.type === 'job.resume') return this.resume(job);
    if (msg.type === 'job.stop') return this.stop(job, 'stopped', null);
    if (msg.type === 'job.fetch') return this.fetchLeft(job, msg.path);
    this.log(`Job ${id}: unknown message ${String(msg.type).slice(0, 40)}`);
  }

  async start(msg) {
    const block = this.block;
    let why = refuseStart(msg, block);
    const holders = [...this.jobs.values()].filter((j) => ['starting', 'running', 'paused'].includes(j.state));
    // One on its way out (the app stopped it and moved on) is waited for; any other is a refusal (2MA2).
    const busy = holders.find((j) => !j.stopping);
    if (!why && busy) why = `job ${busy.id} holds this machine's GPU slot (${busy.state})`;
    const need = why ? 0 : msg.inputs.reduce((n, f) => n + f.size, 0);
    if (!why && !this.makeRoom(need)) why = `the jobs folder would go over its ${block.max_disk_gb} GB`;
    if (why) return this.refuse(msg, why);
    const { name, image, command, gpu, network, reads, resumable } = msg.kind;
    const job = {
      id: msg.id,
      home: block.dir,
      kind: { name, image, command, gpu: gpu === true, network: network === true, reads, resumable: resumable === true },
      limit_s: msg.limit_s,
      inputs: msg.inputs.map(({ name: n, size, sha256 }) => ({ name: n, size, sha256 })),
      state: 'starting',
      run_ms: 0,
      since: null,
      gpu_busy_s: 0,
      started_at: Date.now(),
      paused: null,
      outputs: [],
      final: null,
      final_sent: false,
    };
    this.jobs.set(job.id, job);
    for (const d of ['in', 'out', 'state']) mkdirSync(this.dir(job, d), { recursive: true });
    mkdirSync(join(block.dir, 'cache', cacheName(name)), { recursive: true });
    this.save(job);
    this.log(`Job ${job.id}: ${name}, ${image}, up to ${Math.round(job.limit_s / 60)} min`);
    await this.report(job);
    for (const other of holders) {
      while (other.stopping && ['starting', 'running', 'paused'].includes(other.state) && !job.stopping && !this.closed) await sleep(100);
      if (this.closed) return;
      if (job.stopping) return this.finish(job, job.stopping.state, job.stopping.error);
      if (['starting', 'running', 'paused'].includes(other.state)) return this.finish(job, 'failed', `Refused by the machine: job ${other.id} holds this machine's GPU slot (${other.state}) and wouldn't stop`);
    }
    job._abort = new AbortController();
    try {
      for (const f of job.inputs) await this.fetchInput(job, f, msg.input_token);
    } catch (err) {
      if (job.stopping) return this.finish(job, job.stopping.state, job.stopping.error);
      return this.finish(job, 'failed', `input ${err.message}`);
    }
    await this.launch(job, msg.resume === true);
  }

  /** One input file, streamed into /in and checked against its size and sha256; a dropped line or a 5xx is tried again. */
  async fetchInput(job, f, inputToken, tries = 3) {
    for (let i = 1; ; i++) {
      try {
        return await this.fetchInputOnce(job, f, inputToken);
      } catch (err) {
        if (err.final || i >= tries || job.stopping) throw err;
        this.log(`Job ${job.id}: input ${err.message}, trying again`);
        await sleep(2000 * i);
      }
    }
  }

  async fetchInputOnce(job, f, inputToken) {
    if (job.stopping) return;
    const url = `/api/machines/job-input?job=${job.id}&name=${encodeURIComponent(f.name)}`;
    // A stop cuts it short before its answer too (2MA11); an answer after that is dropped.
    const call = this.call('GET', url, { headers: { 'X-Job-Token': inputToken } });
    const { signal } = job._abort;
    const res = await new Promise((ok, fail) => {
      signal.addEventListener('abort', () => fail(new Error(`${f.name}: stopped`)), { once: true });
      call.then((r) => (signal.aborted ? r.destroy() : ok(r)), fail);
    });
    if (res.statusCode !== 200) {
      const err = new Error(`${f.name}: the app answered ${res.statusCode} ${(await readBody(res)).error ?? ''}`.trim());
      err.final = res.statusCode < 500;
      throw err;
    }
    const hash = createHash('sha256');
    let size = 0;
    const file = this.dir(job, 'in', f.name);
    try {
      await pipeline(
        res,
        async function* (source) {
          for await (const chunk of source) {
            size += chunk.length;
            if (size > f.size) throw Object.assign(new Error(`${f.name} is bigger than the ${f.size} bytes it should be`), { final: true });
            hash.update(chunk);
            yield chunk;
          }
        },
        createWriteStream(file, { flags: 'wx' }),
        { signal: job._abort.signal },
      );
      if (size !== f.size) throw new Error(`${f.name} came to ${size} bytes, not ${f.size}`);
      if (hash.digest('hex') !== f.sha256) throw Object.assign(new Error(`${f.name} doesn't match its sha256`), { final: true });
    } catch (err) {
      rmSync(file, { force: true });
      throw err;
    }
  }

  /** Runs the job's container (again, on resume); the job's own folders are already there. */
  async launch(job, resume) {
    if (job.stopping) return this.finish(job, job.stopping.state, job.stopping.error);
    // A resume runs under the owner's block as it is now: a folder taken away since is not mounted.
    const block = this.block;
    if (!block) return this.finish(job, 'failed', "this machine's owner turned jobs off");
    const gone = job.kind.reads.filter((r) => !block.folders.has(r));
    if (gone.length) return this.finish(job, 'failed', `this machine's owner no longer offers ${gone.join(', ')}`);
    const r = await this.exec(this.podman, podmanRunArgs(job, { ...block, dir: job.home }, resume), undefined, (p) => (job._run = p));
    job._run = null;
    // Stopped during the pull (2MA11): that run was killed, which is no failure of its own.
    if (r.code !== 0 && job.stopping) return this.finish(job, job.stopping.state, job.stopping.error);
    if (r.code !== 0) return this.finish(job, 'failed', `podman run failed: ${r.out.slice(-500)}`);
    job.state = 'running';
    job.paused = null;
    job.since = Date.now();
    this.save(job);
    this.watch(job);
    if (job.stopping) return void this.exec(this.podman, ['rm', '-f', this.name(job)]);
    await this.report(job);
    // A pause asked while it was starting (MA2) happens now it runs.
    if (job.want === 'paused') await this.pause(job);
  }

  /** Waits on the job's container in the background; its end finishes the job, or completes a pause. */
  watch(job) {
    this.exec(this.podman, ['wait', this.name(job)])
      .then(async ({ code, stdout }) => {
        if (this.jobs.get(job.id) !== job || job.final || this.closed) return;
        if (code !== 0) {
          // podman wait itself failed: only a container that is really gone ends the job.
          const r = await this.exec(this.podman, ['inspect', '--format', '{{.State.Status}}', this.name(job)]);
          if (['running', 'paused', 'stopping'].includes(r.stdout)) return void setTimeout(() => this.watch(job), this.tickMs).unref();
        }
        const exit = code === 0 ? Number.parseInt(stdout.split('\n').pop(), 10) : NaN;
        if (job.stopping) return this.finish(job, job.stopping.state, job.stopping.error, Number.isInteger(exit) ? exit : null);
        if (job.pausing) return this.paused(job);
        return this.finish(job, exit === 0 ? 'done' : 'failed', exit === 0 ? null : `it exited with ${Number.isInteger(exit) ? `code ${exit}` : 'no exit code'}`, Number.isInteger(exit) ? exit : null);
      })
      .catch((err) => this.log(`Job ${job.id}: ${err.message}`));
  }

  /** A resumable job's container has stopped for a pause: all its VRAM is free; its folders stay. */
  async paused(job) {
    job.pausing = false;
    await this.exec(this.podman, ['rm', '-f', this.name(job)]);
    job.state = 'paused';
    job.paused = 'stopped';
    this.save(job);
    // A resume asked during the pause's grace (MA9) happens now the pause is done, which the app needn't hear of (2MA3).
    if (job.want !== 'running') await this.report(job);
    if (job.want === 'running') await this.resume(job);
  }

  async pause(job) {
    // What the person asked for last wins, even while it starts or a pause is still under way (MA2, MA9).
    job.want = 'paused';
    if (job.state !== 'running' || job.pausing || job.stopping) return;
    this.closeSegment(job);
    if (job.kind.resumable) {
      // SIGTERM, then the grace, then KILL; watch() sees it end and finishes the pause.
      job.pausing = true;
      this.save(job);
      this.log(`Job ${job.id}: pausing (stopping it, ${this.graceS} s grace)`);
      return void this.exec(this.podman, ['stop', '-t', String(this.graceS), this.name(job)]).then((r) => {
        if (r.code === 0 || !job.pausing) return;
        // Still running: the limit counts again and a later pause can try again.
        job.pausing = false;
        job.want = null;
        job.since = Date.now();
        this.save(job);
        this.log(`Job ${job.id}: podman stop failed, still running: ${r.out.slice(-300)}`);
        job.pause_failed = `podman stop failed: ${r.out.slice(-300)}`;
        return this.report(job);
      });
    }
    const r = await this.exec(this.podman, ['pause', this.name(job)]);
    if (r.code !== 0) {
      job.since = Date.now();
      job.want = null;
      this.log(`Job ${job.id}: podman pause failed: ${r.out.slice(-300)}`);
      job.pause_failed = `podman pause failed: ${r.out.slice(-300)}`;
      return this.report(job);
    }
    job.state = 'paused';
    job.paused = 'frozen';
    job._gpu = await this.sampleGpu();
    this.save(job);
    // As for a resumable kind: a resume asked meanwhile happens now (2MA3).
    if (job.want !== 'running') await this.report(job);
    if (job.want === 'running') await this.resume(job);
  }

  async resume(job) {
    job.want = 'running';
    if (job.state !== 'paused' || job.stopping || job._unpausing) return;
    job.want = null;
    if (job.paused === 'stopped') {
      job.state = 'starting';
      this.save(job);
      await this.report(job);
      return this.launch(job, true);
    }
    job._unpausing = true;
    const r = await this.exec(this.podman, ['unpause', this.name(job)]);
    job._unpausing = false;
    if (r.code !== 0) {
      this.log(`Job ${job.id}: podman unpause failed: ${r.out.slice(-300)}`);
      return this.report(job);
    }
    job.state = 'running';
    job.paused = null;
    job.since = Date.now();
    this.save(job);
    await this.report(job);
    // A pause asked during the unpause happens now.
    if (job.want === 'paused') await this.pause(job);
  }

  /** Ends a job: its container is killed and removed, then what /out holds goes up as for any end. */
  stop(job, state, error) {
    if (job.final || job.stopping) return;
    job.stopping = { state, error };
    this.save(job);
    this.log(`Job ${job.id}: stopping${error ? ` (${error})` : ''}`);
    // Still fetching inputs or pulling its image: cut short, and start() and launch() look before they go on (2MA11).
    if (job.state === 'starting') {
      job._abort?.abort();
      job._run?.kill();
      return;
    }
    if (job.state === 'paused' && job.paused === 'stopped') return void this.finish(job, state, error).catch((err) => this.log(`Job ${job.id}: ${err.message}`));
    this.closeSegment(job);
    this.kill(job);
  }

  /** Removes a stopping job's container; watch() sees it end. One that won't go is no longer stopping. */
  kill(job) {
    this.exec(this.podman, ['rm', '-f', this.name(job)]).then((r) => {
      if (r.code === 0 || job.final || job._finishing) return;
      job.stopping = null;
      if (job.state === 'running') job.since ??= Date.now();
      this.save(job);
      this.log(`Job ${job.id}: podman rm failed, still there: ${r.out.slice(-300)}`);
    });
  }

  /**
   * The job is over: its container goes, then each file in /out uploads, then its log, then its last state.
   * Picked up again on the next connect if the app couldn't be reached part way.
   */
  async finish(job, state, error = null, exitCode = null) {
    if (job._finishing || job.final_sent) return;
    job._finishing = true;
    this.closeSegment(job);
    job.final ??= { state, error, exit_code: exitCode };
    job.ended_at ??= Date.now();
    job.state = 'uploading';
    this.save(job);
    this.log(`Job ${job.id}: ended (${job.final.state}${job.final.error ? `: ${job.final.error}` : ''}), uploading /out`);
    try {
      // Gone before /out is read, so nothing in the container can swap a file after it is checked.
      const rm = await this.exec(this.podman, ['rm', '-f', this.name(job)]);
      if (rm.code !== 0 && (await this.exec(this.podman, ['inspect', '--format', '{{.State.Status}}', this.name(job)])).code === 0) {
        return this.log(`Job ${job.id}: its container won't go, /out waits: ${rm.out.slice(-300)}`);
      }
      await this.report(job);
      if (!(await this.uploadOutputs(job))) return;
      await this.uploadLog(job);
      job.state = job.final.state;
      this.save(job);
      if (await this.report(job)) {
        job.final_sent = true;
        this.save(job);
        this.log(`Job ${job.id}: ${job.state}`);
        // Results the app didn't take stay here: the owner's Machines page lists them (MA3).
        if (job.outputs.some((o) => !o.uploaded)) this.onLeftover?.();
      }
    } finally {
      job._finishing = false;
    }
  }

  /** Uploads what /out holds and isn't up yet. False when the app couldn't be reached (tried again on connect). */
  async uploadOutputs(job) {
    const files = outFiles(realpathSync.native(this.dir(job, 'out')));
    const before = new Map(job.outputs.map((o) => [o.path, o]));
    job.outputs = files.map((f) => ({ path: f.path, size: f.size, uploaded: before.get(f.path)?.uploaded === true && before.get(f.path)?.size === f.size, why: f.why }));
    let ended = false;
    for (const [i, f] of files.entries()) {
      const o = job.outputs[i];
      if (o.uploaded || f.why || ended) continue;
      let res;
      try {
        const url = `/api/machines/job-upload?job=${job.id}&path=${encodeURIComponent(f.path)}`;
        res = await this.call('POST', url, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(f.size) }, body: createReadStream(f.real) });
      } catch (err) {
        this.log(`Job ${job.id}: could not upload ${f.path}: ${err.message}`);
        this.save(job);
        return false;
      }
      const body = await readBody(res);
      if (res.statusCode >= 500) {
        this.log(`Job ${job.id}: ${f.path}: the app answered ${res.statusCode}, trying again later`);
        this.save(job);
        return false;
      }
      if (res.statusCode === 201) o.uploaded = true;
      else {
        // Over the cap (413) it stays here for job.fetch; once the app ended the job (409, 404) nothing more goes.
        o.why = body.error ?? `the app answered ${res.statusCode}`;
        ended = res.statusCode === 409 || res.statusCode === 404;
        this.log(`Job ${job.id}: ${f.path} not uploaded: ${o.why}`);
      }
      this.save(job);
    }
    for (const o of job.outputs) if (o.why && !o.uploaded) this.log(`Job ${job.id}: ${o.path} stays here: ${o.why}`);
    return true;
  }

  async uploadLog(job) {
    const log = Buffer.from(cleanLog(fileTail(this.dir(job, 'job.log'), JOB_LOG_MAX * 2)));
    const body = log.subarray(Math.max(0, log.length - JOB_LOG_MAX));
    try {
      const res = await this.call('POST', `/api/machines/job-upload?job=${job.id}&log=1`, { headers: { 'Content-Type': 'text/plain', 'Content-Length': String(body.length) }, body });
      res.resume();
    } catch (err) {
      this.log(`Job ${job.id}: could not upload its log: ${err.message}`);
    }
  }

  /** A result left over the cap, sent again when the app asks; the same checks as the first time. */
  async fetchLeft(job, path) {
    const o = job.final_sent && job.outputs.find((x) => x.path === path && !x.uploaded);
    const f = o && outFiles(realpathSync.native(this.dir(job, 'out'))).find((x) => x.path === path && !x.why);
    if (!f) return this.log(`Job ${job.id}: fetch of ${String(path).slice(0, 100)} refused: not a result left here`);
    try {
      const res = await this.call('POST', `/api/machines/job-upload?job=${job.id}&path=${encodeURIComponent(f.path)}`, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(f.size) }, body: createReadStream(f.real) });
      const body = await readBody(res);
      if (res.statusCode === 201) o.uploaded = true;
      this.log(`Job ${job.id}: fetch of ${f.path}: ${res.statusCode === 201 ? 'sent' : (body.error ?? res.statusCode)}`);
      this.save(job);
    } catch (err) {
      this.log(`Job ${job.id}: fetch of ${f.path} failed: ${err.message}`);
    }
  }

  /** Whole-GPU use now (nvidia-smi sees Windows' own too), or null without one. */
  async sampleGpu() {
    // A hung nvidia-smi is killed: the one tick waits for it, and the time limits with it.
    const r = await this.exec(this.nvidiaSmi, ['--query-gpu=utilization.gpu,memory.used', '--format=csv,noheader,nounits'], this.smiTimeoutMs);
    const [pct, vram] = (r.code === 0 ? r.stdout.split('\n')[0] : '').split(',').map((v) => Number(v.trim()));
    return Number.isFinite(pct) && Number.isFinite(vram) ? { pct, vram } : null;
  }

  /** Every tick: GPU use, the time limit, the disk cap now and then, and a report for each live job (a starting one too, so the app knows it isn't lost: MA8). */
  async tick() {
    const live = [...this.jobs.values()].filter((j) => ['starting', 'running', 'paused'].includes(j.state) && !j.final);
    const now = Date.now();
    // shortcut: a tick longer than two intervals (a slow nvidia-smi) leaves gpu_busy_s short by the rest of it; count from the tick's end if that number is ever more than a display.
    const dt = Math.min(now - this.lastSample, 2 * this.tickMs) / 1000;
    this.lastSample = now;
    const slow = ++this.ticks % DISK_CHECK_TICKS === 0;
    // An end the app didn't hear (a dropped line, a 5xx) is tried again without waiting for a reconnect.
    if (slow) this.finishUnsent();
    if (!live.length) return;
    const gpu = await this.sampleGpu();
    // Without a block now, a running job keeps its time limit; the disk cap needs the block's number.
    const cap = slow && this.block ? this.block.max_disk_gb * 1024 ** 3 : 0;
    for (const j of live) {
      if (j.final) continue; // ended while the sample was out (#1964): finish() reports it now, and this tick's report, on its own connection, could reach the app last
      j._gpu = gpu;
      if (j.state === 'running' && !j.pausing) {
        if (j.kind.gpu && gpu && gpu.pct >= GPU_BUSY_PCT) j.gpu_busy_s += dt;
        if (this.runS(j) >= j.limit_s) {
          this.stop(j, 'failed', `it hit its time limit of ${Math.round(j.limit_s / 60)} min`);
          continue;
        }
        if (cap && du(j.home) > cap) {
          this.stop(j, 'failed', `the jobs folder went over its ${cap / 1024 ** 3} GB`);
          continue;
        }
      }
      this.save(j);
      // Not waited for: a report the app leaves unanswered must not hold the next tick's limits. One per job at a time.
      if (j._reporting) continue;
      j._reporting = true;
      this.report(j)
        .catch((err) => this.log(`Jobs: ${err.message}`))
        .finally(() => (j._reporting = false));
    }
  }

  /** Room for `need` more bytes under the disk cap, deleting the oldest finished job folders if it must. */
  makeRoom(need) {
    const cap = this.block.max_disk_gb * 1024 ** 3;
    const used = du(this.block.dir);
    if (used + need <= cap) return true;
    const done = [];
    for (const e of readdirSync(this.block.dir)) {
      if (!JOB_ID.test(e) || this.jobs.get(e)?.final_sent === false) continue;
      try {
        const j = JSON.parse(readFileSync(join(this.block.dir, e, 'job.json'), 'utf8'));
        // Results the server never took (over its cap, or an upload that failed) exist only here: the owner clears those.
        if (j.final_sent && !(j.outputs ?? []).some((o) => o && o.uploaded === false)) done.push({ id: e, ended: j.ended_at ?? 0 });
      } catch {}
    }
    // Oldest first, and only as many as it takes; none at all when even every one wouldn't make room.
    let free = used;
    const go = [];
    for (const d of done.sort((a, b) => a.ended - b.ended)) {
      if (free + need <= cap) break;
      d.size = du(join(this.block.dir, d.id));
      free -= d.size;
      go.push(d);
    }
    if (free + need > cap) return false;
    for (const { id } of go) {
      rmSync(join(this.block.dir, id), { recursive: true, force: true });
      this.jobs.delete(id);
      this.log(`Job ${id}: its folder deleted to make room`);
    }
    return true;
  }

  /** At start: every job folder, the unfinished ones picked up again where their containers are. */
  async restore() {
    const home = this.block.dir;
    for (const e of readdirSync(home)) {
      if (!JOB_ID.test(e) || this.jobs.has(e)) continue;
      let job;
      try {
        job = JSON.parse(readFileSync(join(home, e, 'job.json'), 'utf8'));
      } catch {
        continue;
      }
      if (job.id !== e) continue;
      job.home = home;
      // Finished ones too, for job.fetch and the disk cap.
      this.jobs.set(e, job);
      if (job.final_sent || job.final) continue; // connected() finishes telling the app
      const r = await this.exec(this.podman, ['inspect', '--format', '{{.State.Status}} {{.State.ExitCode}}', this.name(job)]);
      const [status, code] = r.code === 0 ? r.stdout.split(/\s+/) : [];
      const exit = Number.parseInt(code, 10);
      this.log(`Job ${e}: found ${job.state}, its container ${status ?? 'gone'}`);
      if (status === 'running' || status === 'paused') {
        job.state = status;
        job.paused = status === 'paused' ? 'frozen' : null;
        if (status === 'running') job.since ??= Date.now();
        else this.closeSegment(job);
        this.save(job);
        this.watch(job);
        // What the agent was doing when it went down, done again.
        if (job.stopping) this.kill(job);
        else if (job.pausing) this.exec(this.podman, ['stop', '-t', String(this.graceS), this.name(job)]);
      } else if (job.stopping) {
        job._end = [job.stopping.state, job.stopping.error, Number.isInteger(exit) ? exit : null];
      } else if (job.pausing && status) {
        await this.paused(job);
      } else if (status === 'exited' || status === 'stopped') {
        job._end = exit === 0 ? ['done', null, 0] : ['failed', `it exited with ${Number.isInteger(exit) ? `code ${exit}` : 'no exit code'} while the agent was down`, Number.isInteger(exit) ? exit : null];
      } else if (!(job.state === 'paused' && job.paused === 'stopped')) {
        job._end = ['failed', 'the machine restarted and its container is gone'];
      }
    }
  }

  /** After each connect (and the info with known()): finish what ended while the app couldn't hear. */
  async connected() {
    await this.ready;
    this.finishUnsent();
  }

  finishUnsent() {
    for (const job of this.jobs.values()) {
      if (job.final_sent || job._finishing || !(job.final || job._end)) continue;
      this.finish(job, ...(job.final ? [] : job._end)).catch((err) => this.log(`Job ${job.id}: ${err.message}`));
    }
  }
}

// ---------- running in the background ----------

/** Copies everything the agent prints to a file as well, so a background agent's errors can be read. */
function logTo(file) {
  try {
    if (statSync(file).size > 1_000_000) renameSync(file, `${file}.old`);
  } catch {}
  const add = (chunk) => {
    try {
      appendFileSync(file, chunk);
    } catch {}
  };
  add(`--- started ${new Date().toISOString()} ---\n`);
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream);
    stream.write = (chunk, ...rest) => (add(chunk), write(chunk, ...rest));
  }
  // Node prints a crash straight to the console, past the copy above.
  process.on('uncaughtException', (err) => {
    console.error(err);
    process.exit(1);
  });
}

const xml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// systemd reads quotes and backslashes, and expands % everywhere; ExecStart also expands $.
const unitQuote = (s) => `"${s.replace(/[\\"]/g, '\\$&').replace(/%/g, '%%')}"`;
const unitWord = (s) => unitQuote(s).replace(/\$/g, '$$$$');

/**
 * What runs the agent in the background on macOS (a launchd agent) or Linux (a systemd user unit):
 * the file to write and what to say about it. It starts at login, restarts if it stops, and keeps the
 * PATH of the shell that installed it, so `claude`'s MCP servers, git and npx are found as in a terminal.
 */
export function backgroundService({ platform, home, uid, name, argv, env }) {
  const dir = dirname(argv[1]);
  const log = join(dir, `machine-agent-${name}.log`);
  // Before any "--", where the agent reads its own options.
  const dash = argv.indexOf('--');
  const args = dash < 0 ? [...argv, '--log', log] : [...argv.slice(0, dash), '--log', log, ...argv.slice(dash)];
  const vars = Object.fromEntries(['PATH', 'CLAUDE_CONFIG_DIR'].filter((k) => env[k]).map((k) => [k, env[k]]));
  if (platform === 'darwin') {
    const label = `coordinator-agent.${name}`;
    const file = join(home, 'Library', 'LaunchAgents', `${label}.plist`);
    const strings = (list) => list.map((a) => `    <string>${xml(a)}</string>`).join('\n');
    const text = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${strings(args)}
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(dir)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(vars)
  .map(([k, v]) => `    <key>${k}</key>\n    <string>${xml(v)}</string>`)
  .join('\n')}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
</dict>
</plist>
`;
    const target = `gui/${uid}`;
    return {
      file,
      log,
      text,
      // bootout first so a new token takes; it fails when the agent wasn't loaded, which is fine.
      before: [['launchctl', 'bootout', `${target}/${label}`]],
      start: [['launchctl', 'bootstrap', target, file]],
      stop: `launchctl bootout ${target}/${label}`,
      remove: `launchctl bootout ${target}/${label}; rm ${file}`,
      startAgain: `launchctl bootstrap ${target} ${file}`,
    };
  }
  const unit = `coordinator-agent-${name}.service`;
  const file = join(env.XDG_CONFIG_HOME || join(home, '.config'), 'systemd', 'user', unit);
  const text = `[Unit]
Description=Citadel machine agent (${name})
After=network-online.target

[Service]
WorkingDirectory=${dir.replace(/%/g, '%%')}
${Object.entries(vars)
  .map(([k, v]) => `Environment=${unitQuote(`${k}=${v}`)}`)
  .join('\n')}
ExecStart=${args.map(unitWord).join(' ')}
Restart=always
RestartSec=30

[Install]
WantedBy=default.target
`;
  return {
    file,
    log,
    text,
    before: [],
    start: [
      ['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', 'enable', unit],
      ['systemctl', '--user', 'restart', unit],
    ],
    stop: `systemctl --user stop ${unit}`,
    remove: `systemctl --user disable --now ${unit}; rm ${file}`,
    startAgain: `systemctl --user start ${unit}`,
    linger: 'It runs while you are logged in. To keep it running after you log out, and start it at boot, run: loginctl enable-linger',
  };
}

/** Writes the background service, (re)starts it, and waits to see it connect, printing what it logged. */
async function installService(name, argv) {
  if (!/^[a-z0-9][a-z0-9-]{0,29}$/.test(name ?? '')) throw new Error("--install needs the machine's name, as the Machines page shows it");
  if (process.platform !== 'darwin' && process.platform !== 'linux') throw new Error('--install sets up macOS and Linux; on Windows, use the PowerShell lines from the Machines page');
  const s = backgroundService({ platform: process.platform, home: homedir(), uid: process.getuid(), name, argv, env: process.env });
  mkdirSync(dirname(s.file), { recursive: true });
  // It holds the token.
  writeFileSync(s.file, s.text, { mode: 0o600 });
  chmodSync(s.file, 0o600);
  const from = existsSync(s.log) ? statSync(s.log).size : 0;
  for (const [cmd, ...args] of s.before) spawnSync(cmd, args, { stdio: 'ignore' });
  for (const [cmd, ...args] of s.start) {
    const run = spawnSync(cmd, args, { encoding: 'utf8' });
    if (run.status !== 0) {
      throw new Error(
        `${cmd} ${args.join(' ')} failed${run.error ? `: ${run.error.message}` : `:\n${run.stderr.trim()}`}\n` +
          (cmd === 'systemctl'
            ? 'This computer has no systemd user session: run the same line without --install and the name, in a terminal you leave open, instead.'
            : "launchd needs this Mac's own login (not SSH): run this in Terminal on the Mac, or run the same line without --install and the name in a terminal you leave open."),
      );
    }
  }
  console.log(`Installed ${s.file}. Waiting for the agent to connect…`);
  let said = '';
  for (const end = Date.now() + 20_000; Date.now() < end && !/Connected to |rejected|refused/.test(said); await new Promise((r) => setTimeout(r, 500))) {
    try {
      const text = readFileSync(s.log, 'utf8');
      said = text.slice(text.length < from ? 0 : from);
    } catch {}
  }
  if (said.trim()) console.log(said.trimEnd());
  const ok = /Connected to /.test(said);
  console.log(
    [
      '',
      ok ? 'It runs in the background now, also after you close this window, and starts again at every login.' : 'It has not connected yet: the lines above say why (nothing above means it did not start).',
      s.linger,
      `Its output: tail -f ${s.log}`,
      `Stop it: ${s.stop}   (start it again: ${s.startAgain})`,
      `Remove it: ${s.remove}`,
    ]
      .filter(Boolean)
      .join('\n'),
  );
  process.exit(ok ? 0 : 1);
}

// ---------- connect with a join code (Build 7 M2) ----------

/** This agent's version, in its report. A row whose agent reports nothing is from before and offers Update. */
export const AGENT_VERSION = 4;

/** A program's output, or null when it isn't there, fails or takes too long. Windows' wsl.exe writes UTF-16. */
function probe(command, args, timeout = 8000) {
  return new Promise((done) => {
    execFile(command, args, { timeout, windowsHide: true, encoding: 'buffer', maxBuffer: 1_000_000 }, (err, out) => {
      if (err || !out) return done(null);
      const utf16 = out.length > 1 && out.subarray(0, 64).filter((b) => b === 0).length > 8;
      done((utf16 ? out.toString('utf16le') : out.toString('utf8')).replace(/^﻿/, '').trim());
    });
  });
}

const firstLine = (text) =>
  (text ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean) ?? null;

/**
 * What this PC can do (specs/machine-connections.md section 2): platform, WSL and its version, threads, memory, free
 * disk, GPU, a signed-in screen and whether its person can become an administrator. Sent when it joins and with its
 * info, so its row and the role cards know what to offer. Each probe that can't tell says null rather than guessing.
 */
export async function machineReport({ platform = process.platform, env = process.env, home = homedir(), run = probe, read = (f) => readFileSync(f, 'utf8'), exists = existsSync } = {}) {
  const os = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'macos' : 'linux';
  const tryRead = (f) => {
    try {
      return read(f);
    } catch {
      return '';
    }
  };
  const inWsl = os === 'linux' && /microsoft/i.test(tryRead('/proc/version'));
  let disk = null;
  try {
    const fs = nodeFs.statfsSync(home);
    disk = Math.round(((fs.bavail * fs.bsize) / 1024 ** 3) * 10) / 10;
  } catch {}
  const [osName, wsl, gpu, screen, admin] = await Promise.all([
    // Windows 11 is still 10.0 to the kernel; its builds start at 22000.
    os === 'windows' ? `Windows ${Number(release().split('.')[2]) >= 22000 ? '11' : '10'}` : os === 'macos' ? run('sw_vers', ['-productVersion']).then((v) => `macOS ${v ?? release()}`) : (/PRETTY_NAME="?([^"\n]+)/.exec(tryRead('/etc/os-release'))?.[1] ?? `Linux ${release()}`),
    os === 'windows'
      ? run('wsl.exe', ['--version']).then(async (v) => {
          const version = /WSL[^:\n]*:\s*([\d.]+)/.exec(v ?? '')?.[1] ?? null;
          // An inbox WSL (Windows 10's) has no --version but lists its distros.
          return version ? { present: true, version } : { present: (await run('wsl.exe', ['--list', '--quiet'])) !== null, version: null };
        })
      : null,
    run('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader']).then(async (v) => {
      if (firstLine(v)) return firstLine(v);
      if (os === 'linux') {
        // No NVIDIA: the kernel still names the card's maker (a name would need lspci, which many boxes lack).
        const makers = { '0x1002': 'AMD GPU', '0x8086': 'Intel GPU', '0x10de': 'NVIDIA GPU' };
        const found = [0, 1, 2, 3].map((n) => makers[tryRead(`/sys/class/drm/card${n}/device/vendor`).trim()]).filter(Boolean);
        return found.find((g) => g !== 'Intel GPU') ?? found[0] ?? null;
      }
      if (os !== 'windows') return null;
      const names = await run('powershell.exe', ['-NoProfile', '-Command', '(Get-CimInstance Win32_VideoController).Name']);
      return (
        (names ?? '')
          .split(/\r?\n/)
          .map((l) => l.trim())
          .find((l) => l && !/basic|remote|virtual|hyper-v|parsec/i.test(l)) ?? null
      );
    }),
    os === 'windows'
      ? run('tasklist.exe', ['/FI', 'IMAGENAME eq explorer.exe', '/FI', `USERNAME eq ${env.USERNAME ?? ''}`, '/NH']).then((v) => (v === null ? null : /explorer\.exe/i.test(v)))
      : os === 'macos'
        ? true
        : inWsl
          ? false
          : !!(env.DISPLAY || env.WAYLAND_DISPLAY || exists('/tmp/.X11-unix/X0') || (env.XDG_RUNTIME_DIR && exists(join(env.XDG_RUNTIME_DIR, 'wayland-0')))),
    os === 'windows' ? run('whoami.exe', ['/groups']).then((v) => (v === null ? null : /S-1-5-32-544/.test(v))) : process.getuid?.() === 0 ? true : run('id', ['-Gn']).then((v) => (v === null ? null : /\b(sudo|wheel|admin)\b/.test(v))),
  ]);
  return {
    host: hostname(),
    os,
    os_name: osName,
    wsl,
    in_wsl: inWsl,
    threads: nodeOs.availableParallelism?.() ?? nodeOs.cpus().length,
    memory_gb: Math.round((totalmem() / 1024 ** 3) * 10) / 10,
    disk_free_gb: disk,
    gpu,
    screen,
    admin,
    agent: AGENT_VERSION,
  };
}

/**
 * Swap a join code for this machine's token (POST /api/machines/join), once: what came back is kept in `file` (only
 * this person can read it), so the same command pasted again, after a failed service install say, uses it rather
 * than a code that has been used. Returns { name, token }.
 */
export async function joinWithCode({ appUrl, code, file, report, post = fetch }) {
  const codeHash = createHash('sha256').update(code).digest('hex');
  try {
    const kept = JSON.parse(readFileSync(file, 'utf8'));
    if (kept.url === new URL(appUrl).origin && kept.code === codeHash && kept.token && kept.name) return { name: kept.name, token: kept.token };
  } catch {}
  const res = await post(new URL('/api/machines/join', appUrl), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, host: hostname(), report }) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`The app refused the join code (${res.status}): ${body.error ?? 'no reason given'}`);
  if (!/^ccm_\d+_[\w-]{43}$/.test(body.token ?? '') || !/^[a-z0-9][a-z0-9-]{0,29}$/.test(body.name ?? '')) throw new Error('The app sent back something that is not a machine token');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ url: new URL(appUrl).origin, code: codeHash, name: body.name, token: body.token }), { mode: 0o600 });
  return { name: body.name, token: body.token };
}

// ---------- the agent ----------

async function main() {
  const argv = process.argv.slice(2);
  const dash = argv.indexOf('--');
  const command = dash < 0 ? [] : argv.slice(dash + 1);
  const opts = dash < 0 ? argv : argv.slice(0, dash);
  const option = (name) => {
    const i = opts.indexOf(name);
    return i < 0 ? null : opts.splice(i, 2)[1];
  };
  const claudeMcp = option('--claude-mcp');
  const configArg = option('--config');
  const installName = opts.includes('--install') ? (option('--install') ?? '') : null;
  const logFile = option('--log');
  // Connect a computer (Build 7 M2): a join code instead of a token, swapped for the token once; --json prints what came
  // back for the Windows command, which registers the task itself.
  const joinCode = option('--join');
  const printJson = opts.includes('--json') && !!opts.splice(opts.indexOf('--json'), 1);
  const [appUrl, argToken] = opts;
  let token = argToken ?? process.env.CC_MACHINE_TOKEN;
  let joinedName = null;
  if (joinCode && appUrl) {
    try {
      const joined = await joinWithCode({ appUrl, code: joinCode, file: join(configArg ? dirname(resolve(configArg)) : process.cwd(), 'machine-agent.join.json'), report: await machineReport() });
      ({ token, name: joinedName } = joined);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
    if (printJson) {
      console.log(JSON.stringify({ name: joinedName, token }));
      process.exit(0);
    }
    console.log(`Joined: this computer is ${joinedName} on the Machines page.`);
  }
  if (!appUrl || !token || (!command.length && !claudeMcp && !configArg)) {
    console.error('Usage: node machine-agent.mjs <app url> <token> --config machine-agent.json');
    console.error('   or: node machine-agent.mjs <app url> <token> --claude-mcp <name> [--config machine-agent.json]');
    console.error('   or: node machine-agent.mjs <app url> <token> [--config machine-agent.json] -- <mcp server command> [args...]');
    console.error('   or: node machine-agent.mjs <app url> --join <code from Connect a computer> --config machine-agent.json [--install]');
    console.error('Add --log <file> to copy its output to a file, or --install <machine name> to run it in the background (macOS, Linux).');
    console.error('Example: node machine-agent.mjs https://example.net ccm_1_… --config machine-agent.json');
    process.exit(2);
  }
  // A task runs in a process group of its own, which a Ctrl-C or a service stop doesn't reach: end those with the agent.
  if (OWN_GROUP) {
    const endTasks = () => {
      for (const pid of liveGroups) signalGroup(pid, 'SIGTERM');
    };
    process.on('exit', endTasks);
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      process.once(sig, () => {
        endTasks();
        process.kill(process.pid, sig);
      });
    }
  }
  // Set up the old way, its MCP server is fixed on this command line; otherwise the Machines page's ticks decide (#439).
  const lends = !!(command.length || claudeMcp);
  const managed = !lends;
  /** What the app says is ticked: one MCP server's name, or null. The ticked workspaces are host.lent. */
  let lentServer = null;

  /** A stdio server from Claude Code's config: user scope first, then any project's. */
  function claudeServer(name) {
    const file = claudeConfigFile(process.env);
    let config;
    try {
      config = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      throw new Error(`could not read ${file}: ${err.message}`);
    }
    const entry =
      config.mcpServers?.[name] ??
      Object.values(config.projects ?? {})
        .map((p) => p?.mcpServers?.[name])
        .find(Boolean);
    if (!entry?.command) throw new Error(`${file} has no stdio MCP server named "${name}"`);
    return { command: entry.command, args: entry.args ?? [], env: entry.env ?? {} };
  }

  /** What a session runs: the program, its arguments, extra environment, and whether it needs a shell. */
  function serverCommand() {
    if (managed) {
      // Only a name this agent found itself, looked up afresh: the app never names a command.
      if (!lentServer || !found().some((f) => f.name === lentServer)) throw new Error('no MCP server found on this computer is ticked for this machine on the Machines page');
      const own = host.servers.get(lentServer);
      if (own) return { command: own.run[0], args: own.run.slice(1), env: {}, shell: process.platform === 'win32' };
    }
    if (claudeMcp || managed) {
      const s = claudeServer(claudeMcp ?? lentServer);
      // Only batch files need a shell (cmdLine quotes for it).
      return { ...s, shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(s.command) };
    }
    // npx and friends are .cmd files on Windows, which only start through a shell.
    return { command: command[0], args: command.slice(1), env: {}, shell: process.platform === 'win32' };
  }
  const describe = claudeMcp ? `${claudeMcp} (from Claude Code's config)` : command.length ? command.join(' ') : 'what is ticked on the Machines page';
  if (lends) {
    try {
      serverCommand();
    } catch (err) {
      console.error(err.message);
      process.exit(2);
    }
  }
  if (installName !== null) {
    const agent = realpathSync(process.argv[1]);
    const args = [appUrl, token, ...(configArg ? ['--config', resolve(configArg)] : []), ...(claudeMcp ? ['--claude-mcp', claudeMcp] : []), ...(command.length ? ['--', ...command] : [])];
    return installService(installName || joinedName, [process.execPath, agent, ...args]).catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
  }
  if (logFile) logTo(resolve(logFile));
  const auth = { Authorization: `Bearer ${token}` };
  const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);

  const configFile = configArg && resolve(configArg);
  // A Windows test run asks for its size on this PC (#2120); a non-200 answer (an older server) throws, and the run goes ahead.
  const room =
    process.platform === 'win32'
      ? async (op, key, label) => {
          const res = await appCall(appUrl, token, 'POST', '/api/machines/heavy', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op, key, label }) });
          const body = await readBody(res);
          if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode}`);
          return body?.go ?? 'start';
        }
      : null;
  const host = configFile && new WorkspaceHost({ configFile, jobsDir: join(dirname(configFile), 'citadel-jobs'), room });
  // Nothing is lent until the app says what is ticked.
  if (managed) host.lent = new Set();
  const offered = () => [...(lends ? ['mcp'] : []), ...(host?.workspaces.size ? ['ws'] : [])];
  /** The MCP servers found here, by name: the config file's own first, then Claude Code's. */
  function found() {
    const own = [...host.servers.keys()];
    return [
      ...own.map((name) => ({ name, from: 'file' })),
      ...claudeServerNames()
        .filter((n) => !own.includes(n))
        .map((name) => ({ name, from: 'claude' })),
    ];
  }
  const describeWorkspaces = () => {
    if (!host) return;
    for (const p of host.problems) log(`Config problem: ${p}`);
    log(host.all.size ? `Workspaces from ${configFile}: ${[...host.all.keys()].join(', ')}` : `No workspaces in ${configFile}${existsSync(configFile) ? '' : ' (no such file yet)'}`);
    if (managed)
      log(
        `MCP servers found here: ${
          found()
            .map((f) => f.name)
            .join(', ') || 'none'
        }`,
      );
  };
  describeWorkspaces();
  // GPU jobs (#858): made even without a jobs block, so a job sent here is refused out loud.
  const runner = new JobRunner({ block: host?.jobsBlock ?? null, appUrl, token, log });
  runner.onLeftover = () => sendInfo();
  // Minion turns (Build 7): only with a "worker" block in the config file, and only then is machine-worker.mjs loaded, from beside this file.
  let worker = null;
  try {
    const block = configFile && existsSync(configFile) ? JSON.parse(readFileSync(configFile, 'utf8'))?.worker : null;
    if (block) {
      // A computer set up by the one-line install has only this file: the worker's comes from the same app.
      const file = join(dirname(fileURLToPath(import.meta.url)), 'machine-worker.mjs');
      // Taken again at each start, so it never falls behind the app's side of the sync; the copy here serves when the app can't be reached.
      const res = await fetch(new URL('/machine-worker.mjs', appUrl)).catch(() => null);
      const text = res?.ok ? await res.text() : null;
      if (text === null && !existsSync(file)) throw new Error(`could not download machine-worker.mjs (${res?.status ?? 'no answer'})`);
      if (text !== null && !(existsSync(file) && readFileSync(file, 'utf8') === text)) writeFileSync(file, text);
      worker = new (await import('./machine-worker.mjs')).Worker({ config: block, appUrl, token, log });
      await worker.start();
      log(`Minion turns: up to ${worker.cfg.max} at once, in ${worker.cfg.root}`);
    }
  } catch (err) {
    worker = null;
    log(`Config problem: worker: ${err.message}, so this computer runs no minion turns`);
  }

  /** Tells the app which servers and workspaces this agent offers; sent on connect and when the config changes. */
  async function sendInfo() {
    await runner.ready;
    const jobs = runner.offer();
    await fetch(new URL('/api/machines/info', appUrl), {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      // v says which agent this is: the app shows one without it as set up the old way.
      body: JSON.stringify({
        ...(managed ? { v: 2, found: (reported = found()) } : { servers: offered() }),
        report: await machineReport(),
        ...(host ? host.summary() : {}),
        problems: [...(host?.summary().problems ?? []), ...runner.leftover()],
        ...(jobs ? { jobs } : {}),
        ...(runner.restored ? { known_jobs: runner.known() } : {}),
      }),
    })
      .then(async (res) => {
        // fetch doesn't throw on a refusal; a silent one hid #301's 404.
        if (!res.ok) log(`The app refused this computer's workspaces: ${res.status} ${(await res.json().catch(() => ({}))).error ?? ''}`);
      })
      .catch((err) => log(`Could not tell the app about workspaces: ${err.message}`));
  }
  if (host) {
    watchFile(configFile, { interval: 3000 }, () => {
      const folders = JSON.stringify([...(host.jobsBlock?.folders ?? [])]);
      host.reload();
      log('The config changed.');
      // sendInfo waits for it: a jobs folder found again is listed from what it holds (2MA5).
      const before = runner.ready;
      const block = host.jobsBlock;
      runner.ready = before.then(() => runner.setBlock(block)).catch((err) => log(`Jobs: ${err.message}`));
      if (JSON.stringify([...(host.jobsBlock?.folders ?? [])]) !== folders) log('The jobs folders changed: if they are Windows folders, add them to /etc/fstab and restart this distro (wsl --terminate).');
      describeWorkspaces();
      sendInfo().then(() => runner.connected());
    });
  }
  // Claude Code rewrites its config all the time, so look now and then and say so only when the names changed.
  let reported = [];
  if (managed) setInterval(() => JSON.stringify(found()) !== JSON.stringify(reported) && sendInfo(), FOUND_EVERY_MS).unref();

  /** A role's Set up or Test (Build 7 M4): its steps are role-setup-agent.mjs's, taken from the app at each press as the worker's are. */
  async function runRoleSetup(ask) {
    const res = await fetch(new URL('/role-setup-agent.mjs', appUrl));
    if (!res.ok) throw new Error(`could not download role-setup-agent.mjs (${res.status})`);
    writeFileSync(join(dirname(fileURLToPath(import.meta.url)), 'role-setup-agent.mjs'), await res.text());
    const { runSetup, exec } = await import(`./role-setup-agent.mjs?at=${Date.now()}`);
    const send = (path, body, type) => fetch(new URL(path, appUrl), { method: 'POST', headers: { ...auth, 'Content-Type': type }, body }).catch((err) => log(`Set up ${ask.role}: ${err.message}`));
    log(`${ask.kind === 'test' ? 'Testing' : 'Setting up'} the ${ask.role} role, as its owner asked on the Machines page.`);
    await runSetup({
      ask,
      platform: process.platform,
      configFile,
      appUrl,
      token,
      exec,
      capture: captureScreen,
      start: (command) => spawn(command, [], { detached: true, stdio: 'ignore' }).unref(),
      screenBusy: () => !!(host?.screenLock && screenHolder(host.screenLock)),
      tmp: nodeOs.tmpdir(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      post: (body) => send('/api/machines/role-setup', JSON.stringify(body), 'application/json'),
      upload: (bytes) => send(`/api/machines/role-setup/shot?id=${encodeURIComponent(ask.id)}`, bytes, 'image/png'),
    });
  }

  /** The app says what is ticked for this machine: on connect, and whenever a person changes a tick. */
  function setLend(lend) {
    if (!managed) return;
    const server = typeof lend?.server === 'string' ? lend.server : null;
    host.lent = new Set((Array.isArray(lend?.workspaces) ? lend.workspaces : []).filter((w) => typeof w === 'string'));
    // Sessions on a server that is no longer the ticked one stop; the app ends them on its side too.
    if (server !== lentServer) for (const [id, s] of sessions) if (s.proc) stopServer(id);
    lentServer = server;
    log(`Lent from the Machines page: ${[server ? `MCP server ${server}` : '', host.lent.size ? `workspaces ${[...host.lent].join(', ')}` : ''].filter(Boolean).join(' and ') || 'nothing yet'}`);
  }

  /** session id -> its running MCP server (or workspace session), and the chain that sends its output in order */
  const sessions = new Map();

  function startServer(id) {
    let spec;
    try {
      spec = serverCommand();
    } catch (err) {
      log(`Session ${id.slice(0, 6)} could not start: ${err.message}`);
      spec = { command: process.execPath, args: ['-e', 'process.exit(1)'], env: {}, shell: false };
    }
    const opts = { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...spec.env }, shell: spec.shell };
    const proc = spec.shell ? spawn(cmdLine(spec.command, spec.args), [], opts) : spawn(spec.command, spec.args, opts);
    const s = { proc, chain: Promise.resolve() };
    sessions.set(id, s);
    log(`Session ${id.slice(0, 6)} started ${managed ? lentServer : describe}`);
    createInterface({ input: proc.stdout }).on('line', (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return log(`[${id.slice(0, 6)}] ${line}`); // stray non-protocol output
      }
      send(s, id, { message });
    });
    createInterface({ input: proc.stderr }).on('line', (line) => log(`[${id.slice(0, 6)}] ${line}`));
    const ended = (why) => {
      if (sessions.get(id) !== s) return;
      sessions.delete(id);
      log(`Session ${id.slice(0, 6)} ended (${why})`);
      send(s, id, { closed: true });
    };
    proc.on('exit', (code, signal) => ended(signal ?? `exit ${code}`));
    proc.on('error', (err) => ended(err.message));
    proc.stdin.on('error', () => {});
    return s;
  }

  /** A workspace session: its messages are answered here, by the shared host. */
  function startWorkspace(id, who) {
    const s = { chain: Promise.resolve(), who };
    sessions.set(id, s);
    log(`Session ${id.slice(0, 6)} started workspace tools for ${who}`);
    return s;
  }

  async function upload(id, name, bytes) {
    const url = new URL('/api/machines/upload', appUrl);
    url.searchParams.set('session', id);
    url.searchParams.set('name', name);
    const res = await fetch(url, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/octet-stream' }, body: bytes });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new ToolError(`The app refused the file: ${body.error ?? res.status}`);
    return body.path;
  }

  function onWorkspaceMessage(id, s, message) {
    if (message?.method === 'tools/call') log(`[${id.slice(0, 6)}] ${s.who}: ${message.params?.name} ${JSON.stringify(message.params?.arguments ?? {})}`);
    workspaceReply(host, message, s.who, (name, bytes) => upload(id, name, bytes)).then((reply) => {
      if (reply && sessions.get(id) === s) send(s, id, { message: reply });
    });
  }

  function stopServer(id) {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id);
    if (s.proc) {
      s.proc.stdin.end();
      // Give it a moment to exit by itself, as MCP servers do when stdin closes.
      setTimeout(() => s.proc.exitCode === null && s.proc.kill(), 3000).unref();
    }
    log(`Session ${id.slice(0, 6)} closed by the app`);
  }

  function send(s, id, body) {
    s.chain = s.chain
      .then(async () => {
        const res = await sendRetrying(
          () =>
            fetch(new URL('/api/machines/send', appUrl), {
              method: 'POST',
              headers: { ...auth, 'Content-Type': 'application/json' },
              body: JSON.stringify({ session: id, ...body }),
            }),
          (err) => log(`Send to the app failed, trying again: ${err.message}`),
        );
        // The thread's turn ended: nobody is listening to this server any more.
        if (res.status === 410) stopServer(id);
      })
      .catch((err) => log(`Could not send to the app: ${err.message}`));
  }

  /** Server-sent events from a fetch body, one parsed JSON message per event; heard() on every chunk, pings too. */
  async function* events(body, heard) {
    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of body) {
      heard();
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

  let retry = 0;
  async function connect() {
    const url = new URL('/api/machines/connect', appUrl);
    url.searchParams.set('host', hostname());
    url.searchParams.set('command', describe);
    // It lends nothing until it has said what it found and heard what is ticked.
    if (managed) url.searchParams.set('v', '2');
    // The app pings every 25 s. Silence for a minute (after a sleep, say) means the connection is dead though
    // nothing said so: drop it and connect again. A beat every 20 s tells the app this computer is awake, and on a test box who has its screen (#1422).
    const quiet = new AbortController();
    let lastHeard = Date.now();
    const watch = setInterval(() => {
      if (Date.now() - lastHeard > SILENT_MS) return quiet.abort(new Error(`nothing from the app for ${SILENT_MS / 1000} s`));
      fetch(new URL('/api/machines/send', appUrl), { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ beat: true, ...(host?.screenLock ? { screen: screenState(host.screenLock) } : {}) }), signal: AbortSignal.timeout(15_000) }).catch(() => {});
    }, BEAT_MS);
    try {
      return await listen(url, quiet.signal, () => (lastHeard = Date.now()));
    } finally {
      clearInterval(watch);
    }
  }

  async function listen(url, signal, heard) {
    const res = await fetch(url, { headers: { ...auth, Accept: 'text/event-stream' }, signal });
    if (res.status === 401) {
      console.error('The app rejected this token. Make a new one in the Machines panel.');
      process.exit(1);
    }
    if (res.status === 403) {
      // This address takes no machines; the app says where they connect instead.
      console.error((await res.json().catch(() => ({}))).error ?? 'The app refused this connection.');
      process.exit(1);
    }
    if (!res.ok) throw new Error(`the app answered ${res.status}`);
    for await (const msg of events(res.body, heard)) {
      if (msg.hello) {
        log(`Connected to ${new URL(appUrl).host} as "${msg.hello}". Minions can use ${describe}${!managed && host?.workspaces.size ? ` and workspaces ${[...host.workspaces.keys()].join(', ')}` : ''} while this runs.`);
        retry = 0;
        // After the info that lists what this agent holds: then whatever ended while it was away is reported.
        sendInfo().then(() => runner.connected());
      } else if (msg.replaced) {
        throw Object.assign(new Error(`another agent connected with this machine's token, from ${msg.by || 'another computer'}; run only one`), { replaced: true });
      } else if (msg.lend) {
        setLend(msg.lend);
      } else if (msg.worker) {
        worker?.poke();
      } else if (msg.setup) {
        const ask = msg.setup;
        runRoleSetup(ask).catch((err) => {
          log(`Set up ${ask.role}: ${err.message}`);
          fetch(new URL('/api/machines/role-setup', appUrl), { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: ask.id, done: { ok: false, why: `The agent couldn't run it: ${err.message}` } }) }).catch(() => {});
        });
      } else if (msg.job) {
        runner.handle(msg.job).catch((err) => log(`Job ${msg.job.id}: ${err.message}`));
      } else if (msg.host_start) {
        // run_on_host (T8): checked against this file's own list, whatever the app asks.
        const ask = msg.host_start;
        const answer = (body) => fetch(new URL('/api/machines/host-started', appUrl), { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: ask.id, ...body }) }).catch((err) => log(`Could not tell the app about ${ask.program}: ${err.message}`));
        Promise.resolve()
          .then(() => startProgram(host?.programs ?? new Map(), ask, [dirname(fileURLToPath(import.meta.url)), ...(configFile ? [dirname(configFile)] : [])]))
          .then((pid) => {
            log(`Started ${ask.program} for a minion (process ${pid}).`);
            return answer({ ok: true, pid });
          })
          .catch((err) => {
            log(`Refused to start ${ask.program}: ${err.message}`);
            return answer({ ok: false, error: err.message });
          });
      } else if (msg.close) {
        stopServer(msg.session);
      } else if (msg.session && msg.server === 'ws') {
        if (!host) continue;
        const s = sessions.get(msg.session) ?? startWorkspace(msg.session, String(msg.who ?? 'a minion'));
        onWorkspaceMessage(msg.session, s, msg.message);
      } else if (msg.session && (lends || managed)) {
        const s = sessions.get(msg.session) ?? startServer(msg.session);
        s.proc.stdin.write(`${JSON.stringify(msg.message)}\n`);
      }
    }
    throw new Error('the connection closed');
  }

  for (;;) {
    try {
      await connect();
    } catch (err) {
      // The app ends every session when this connection drops; stop their servers too.
      for (const id of [...sessions.keys()]) stopServer(id);
      const wait = err.replaced ? REPLACED_WAIT_S : Math.min(30, 2 ** retry++);
      log(`Disconnected: ${err.message}. Retrying in ${wait}s.`);
      await new Promise((r) => setTimeout(r, wait * 1000));
    }
  }
}

// Run as a program, not when a test imports the workspace parts.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
