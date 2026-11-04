#!/usr/bin/env node
// The app's machine agent: lends this computer's MCP server (a Godot editor, say) to the
// coordinator's threads. It dials out to the app and keeps that connection open, so the app never
// needs to reach this computer; each thread session gets its own copy of the MCP server.
//
//   node machine-agent.mjs <app url> <token> --claude-mcp <name> [--config <file>]
//   node machine-agent.mjs <app url> <token> [--config <file>] -- <mcp server command> [args...]
//   node machine-agent.mjs <app url> <token> --config <file>
//
// --claude-mcp runs a server already set up for Claude Code on this computer (in ~/.claude.json),
// such as godot-ai, whose entry holds a path only this computer knows. It is read afresh for each
// session, so an updated entry applies without restarting the agent.
// --config names a workspaces file (machine-agent.json). When it lists any, the agent also serves
// its own workspace tools (mcp__<name>-ws__…): git sync and the tasks listed there, in the folders
// listed there, nothing else. Only this computer's owner edits that file; minions can't write to it.
// It is re-read when it changes. A missing file just means no workspace tools.
// The token can come from CC_MACHINE_TOKEN instead. Needs Node 18 or newer; no other installs.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, watchFile } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

// ---------- workspace tools ----------

/** A refusal or failure the minion should read as is. */
class ToolError extends Error {}

const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
// A branch name as git allows it, minus anything that could read as an option or a range.
const REF = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[A-Za-z0-9._/-]{1,200}(?<![./])$/;
const SHA = /^[0-9a-f]{7,40}$/;
const WAIT_MAX = 50; // seconds a tool call waits on a job before handing back its id
const TASK_LIMIT_MS = 30 * 60_000;
const TAIL_LINES = 400;
const READ_MAX = 5_000_000;
const FETCH_MAX = 20_000_000;
const KEEP_LOGS = 100;

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
 * Reads machine-agent.json: { workspaces: { <name>: { path, read?: [folders], tasks: { <name>: { run: [argv], about?, hints? } } } } }.
 * A bad workspace or task is left out with a problem saying why, so one typo doesn't take the rest down.
 */
export function loadConfig(file, env = process.env) {
  const workspaces = new Map();
  const problems = [];
  if (!existsSync(file)) return { workspaces, problems };
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    return { workspaces, problems: [`${file}: ${err.message}`] };
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
          tasks.set(tname, { run: t.run, about: typeof t.about === 'string' ? t.about : '', hints });
        } catch (err) {
          bad(err.message);
        }
      }
    }
    workspaces.set(name, { name, path, read, tasks });
  }
  return { workspaces, problems };
}

const TOOLS = [
  { name: 'workspaces', description: 'The workspaces on this computer: folder, what is checked out, local changes, the tasks you can run, and whether a job holds it. Call this first.', inputSchema: { type: 'object', properties: {} } },
  {
    name: 'git_sync',
    description: 'git fetch origin, then check out origin/<ref> (a pushed branch) or a commit, detached. Local changes that don\'t conflict carry over; if they would be overwritten it stops and changes nothing. Never resets, cleans, stashes or pushes.',
    inputSchema: { type: 'object', properties: { workspace: { type: 'string' }, ref: { type: 'string', description: 'Branch name on origin, or a commit sha' } }, required: ['workspace', 'ref'] },
  },
  {
    name: 'run_task',
    description: 'Run one of the workspace\'s tasks (listed by the workspaces tool) in its folder. Waits up to `wait` seconds (default and most 50), then returns the result, or a job id to pass to the job tool. One job per workspace at a time.',
    inputSchema: { type: 'object', properties: { workspace: { type: 'string' }, task: { type: 'string' }, wait: { type: 'number' } }, required: ['workspace', 'task'] },
  },
  {
    name: 'job',
    description: 'A task job\'s state, exit code and last output lines; waits up to `wait` seconds (default and most 50) for it to finish.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, wait: { type: 'number' }, lines: { type: 'number', description: 'How many output lines to show, default 60' } }, required: ['id'] },
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
    description: 'Copy a file (up to 20 MB, any kind: a zip, a save, a log) from a workspace or its read folders to the app\'s server, into your files folder there, and return its path. The bytes don\'t pass through this conversation.',
    inputSchema: { type: 'object', properties: { workspace: { type: 'string' }, path: { type: 'string' } }, required: ['workspace', 'path'] },
  },
];

function run(command, args, opts) {
  return new Promise((done) => {
    let out = '';
    const p = spawn(command, args, { ...opts, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('error', (err) => done({ code: -1, out: err.message }));
    p.on('close', (code) => done({ code, out: out.trim() }));
  });
}

/** Ends a job's process and whatever it started (Godot under cmd.exe, say). */
function killTree(child) {
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  else child.kill();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms).unref?.());
const secondsSince = (t) => Math.round((Date.now() - t) / 1000);
const waitFor = (v) => Math.min(WAIT_MAX, Math.max(0, Number.isFinite(v) ? v : WAIT_MAX));
const size = (n) => (n < 1024 * 1024 ? `${Math.ceil(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** The workspaces this computer offers, shared by every thread session: one lock and one job list. */
export class WorkspaceHost {
  constructor({ configFile, env = process.env, jobsDir }) {
    this.configFile = configFile;
    this.env = env;
    this.jobsDir = jobsDir;
    this.busy = new Map(); // workspace name -> { what, who, since, job? }
    this.jobs = new Map();
    this.reload();
  }

  reload() {
    ({ workspaces: this.workspaces, problems: this.problems } = loadConfig(this.configFile, this.env));
  }

  /** What the app shows on the Machines page. */
  summary() {
    return {
      workspaces: [...this.workspaces.values()].map((w) => ({ name: w.name, path: w.path, read: w.read, tasks: [...w.tasks].map(([name, t]) => ({ name, run: t.run, about: t.about })) })),
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
    const [head, branch, status] = await Promise.all([
      this.git(w, ['log', '-1', '--format=%h %s']),
      this.git(w, ['symbolic-ref', '--short', '-q', 'HEAD']),
      this.git(w, ['status', '--porcelain']),
    ]);
    const changes = status.out ? status.out.split('\n') : [];
    return {
      at: `${branch.code ? 'detached' : `branch ${branch.out}`} at ${head.out}`,
      changes: changes.length ? `${changes.slice(0, 20).join('\n')}${changes.length > 20 ? `\n…and ${changes.length - 20} more` : ''}` : 'none',
    };
  }

  async call(tool, args = {}, who = 'a minion', upload) {
    switch (tool) {
      case 'workspaces': return this.list();
      case 'git_sync': return this.sync(this.workspace(args.workspace), String(args.ref ?? '').replace(/^origin\//, ''), who);
      case 'run_task': return this.runTask(this.workspace(args.workspace), String(args.task ?? ''), who, waitFor(args.wait));
      case 'job': {
        const job = this.jobs.get(String(args.id ?? ''));
        if (!job) throw new ToolError(`No job ${args.id} here. Jobs are forgotten when the agent restarts; their logs stay in ${this.jobsDir}.`);
        return this.report(job, waitFor(args.wait), Number(args.lines) || 60);
      }
      case 'read_file': return this.read(this.workspace(args.workspace), args.path, Number(args.offset) || 1, Number(args.limit) || 400);
      case 'list_files': return this.listFiles(this.workspace(args.workspace), args.path);
      case 'fetch_file': return this.fetch(this.workspace(args.workspace), args.path, upload);
      default: throw new ToolError(`No tool ${tool}`);
    }
  }

  async list() {
    if (!this.workspaces.size) return { text: `No workspaces are set up on this computer.${this.problems.length ? `\nProblems in its config:\n${this.problems.join('\n')}` : ''}` };
    const parts = [];
    for (const w of this.workspaces.values()) {
      const c = await this.checkout(w);
      const b = this.busy.get(w.name);
      parts.push([
        `## ${w.name}`,
        `Folder: ${w.path}`,
        w.read.length ? `Read folders: ${w.read.join(', ')}` : '',
        `Checked out: ${c.at}`,
        `Local changes:\n${c.changes}`,
        `Busy: ${b ? `${b.what} for ${b.who}, ${secondsSince(b.since)} s${b.job ? ` (job ${b.job.id})` : ''}` : 'no'}`,
        'Tasks:',
        ...[...w.tasks].map(([name, t]) => `- ${name}: ${t.run.join(' ')}${t.about ? ` (${t.about})` : ''}`),
      ].filter(Boolean).join('\n'));
    }
    if (this.problems.length) parts.push(`Problems in this computer's config (left out above):\n${this.problems.join('\n')}`);
    return { text: parts.join('\n\n') };
  }

  async sync(w, ref, who) {
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
        const files = (out.out.match(/would be overwritten by checkout:\n((?:\s+.+\n?)+)/)?.[1] ?? '').trim().split(/\s*\n\s*/).filter(Boolean);
        throw new ToolError(files.length
          ? `Stopped: checking out ${ref} would overwrite local changes on this computer in:\n${files.join('\n')}\nNothing was changed. Those changes belong to the computer's owner: don't discard, stash or commit them; tell them and let them decide.`
          : `git checkout failed; nothing was changed.\n${out.out}`);
      }
      const after = await this.checkout(w);
      return { text: `Checked out ${ref} in ${w.name}: ${after.at}.\nBefore: ${before.at}.\nLocal changes now:\n${after.changes}` };
    } finally {
      this.release(w, lock);
    }
  }

  async runTask(w, name, who, wait) {
    const task = w.tasks.get(name);
    if (!task) throw new ToolError(`Workspace ${w.name} has no task "${name}". Its tasks: ${[...w.tasks.keys()].join(', ') || 'none'}. Only this computer's owner can add one.`);
    const argv = task.run.map((a) => expand(a, this.env));
    const lock = this.take(w, `task ${name}`, who);
    const id = randomBytes(4).toString('hex');
    mkdirSync(this.jobsDir, { recursive: true });
    this.prune();
    const job = { id, workspace: w.name, task, name, who, started: Date.now(), ended: null, code: null, error: null, tail: [], partial: '', log: join(this.jobsDir, `${id}.log`) };
    lock.job = job;
    this.jobs.set(id, job);
    const file = createWriteStream(job.log).on('error', () => {});
    file.write(`${argv.join(' ')}\n(in ${w.path}, for ${who})\n\n`);
    job.done = new Promise((resolveDone) => {
      let child;
      const finish = (code, error) => {
        if (job.ended) return;
        clearTimeout(limit);
        job.ended = Date.now();
        job.code = code;
        job.error = error;
        if (job.partial) job.tail.push(job.partial);
        file.end(error ? `\n${error}\n` : `\nexit ${code}\n`);
        this.release(w, lock);
        resolveDone();
      };
      const limit = setTimeout(() => {
        if (child) killTree(child);
        finish(null, `Stopped after ${TASK_LIMIT_MS / 60_000} minutes`);
      }, TASK_LIMIT_MS);
      try {
        child = spawn(argv[0], argv.slice(1), { cwd: w.path, env: this.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
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
    });
    return this.report(job, wait, 60);
  }

  async report(job, wait, lines) {
    if (!job.ended) await Promise.race([job.done, sleep(wait * 1000)]);
    const tail = job.tail.slice(-Math.min(Math.max(1, lines), TAIL_LINES)).join('\n');
    if (!job.ended) return { text: `${job.name} in ${job.workspace} is still running after ${secondsSince(job.started)} s (job ${job.id}). Call job with id "${job.id}" to wait for it.\n--- latest output ---\n${job.tail.slice(-20).join('\n')}` };
    const ok = job.code === 0;
    const all = job.tail.join('\n');
    const hints = job.task.hints.filter((h) => (h.exit !== undefined ? h.exit === job.code : false) || (h.match && !ok && h.match.test(all))).map((h) => h.say);
    const head = `${job.name} in ${job.workspace} ${ok ? 'succeeded' : 'FAILED'} (${job.error ?? `exit ${job.code}`}) after ${Math.round((job.ended - job.started) / 1000)} s. Job ${job.id}; full log on that computer: ${job.log}`;
    return { text: [head, ...hints, `--- last ${Math.min(lines, job.tail.length)} lines ---`, tail].join('\n'), isError: !ok };
  }

  prune() {
    for (const [id, j] of this.jobs) if (this.jobs.size > 50 && j.ended) this.jobs.delete(id);
    try {
      const logs = readdirSync(this.jobsDir).filter((f) => f.endsWith('.log')).map((f) => ({ f, t: statSync(join(this.jobsDir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
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
      return reply({ tools: TOOLS });
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
  const [appUrl, argToken] = opts;
  const token = argToken ?? process.env.CC_MACHINE_TOKEN;
  if (!appUrl || !token || (!command.length && !claudeMcp && !configArg)) {
    console.error('Usage: node machine-agent.mjs <app url> <token> --claude-mcp <name> [--config machine-agent.json]');
    console.error('   or: node machine-agent.mjs <app url> <token> [--config machine-agent.json] -- <mcp server command> [args...]');
    console.error('   or: node machine-agent.mjs <app url> <token> --config machine-agent.json');
    console.error('Example: node machine-agent.mjs https://example.net ccm_1_… --claude-mcp godot-ai');
    process.exit(2);
  }
  const lends = !!(command.length || claudeMcp);

  /** A stdio server from Claude Code's config: user scope first, then any project's. */
  function claudeServer(name) {
    const file = join(process.env.CLAUDE_CONFIG_DIR ?? homedir(), '.claude.json');
    let config;
    try {
      config = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      throw new Error(`could not read ${file}: ${err.message}`);
    }
    const entry = config.mcpServers?.[name] ?? Object.values(config.projects ?? {}).map((p) => p?.mcpServers?.[name]).find(Boolean);
    if (!entry?.command) throw new Error(`${file} has no stdio MCP server named "${name}"`);
    return { command: entry.command, args: entry.args ?? [], env: entry.env ?? {} };
  }

  /** What a session runs: the program, its arguments, extra environment, and whether it needs a shell. */
  function serverCommand() {
    if (claudeMcp) {
      const s = claudeServer(claudeMcp);
      // An absolute path may hold spaces, which a shell would split; only batch files need one.
      return { ...s, shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(s.command) };
    }
    // npx and friends are .cmd files on Windows, which only start through a shell.
    return { command: command[0], args: command.slice(1), env: {}, shell: process.platform === 'win32' };
  }
  const describe = claudeMcp ? `${claudeMcp} (from Claude Code's config)` : command.length ? command.join(' ') : 'workspace tools only';
  if (lends) {
    try {
      serverCommand();
    } catch (err) {
      console.error(err.message);
      process.exit(2);
    }
  }
  const auth = { Authorization: `Bearer ${token}` };
  const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);

  const configFile = configArg && resolve(configArg);
  const host = configFile && new WorkspaceHost({ configFile, jobsDir: join(dirname(configFile), 'citadel-jobs') });
  const offered = () => [...(lends ? ['mcp'] : []), ...(host?.workspaces.size ? ['ws'] : [])];
  const describeWorkspaces = () => {
    if (!host) return;
    for (const p of host.problems) log(`Config problem: ${p}`);
    log(host.workspaces.size ? `Workspaces from ${configFile}: ${[...host.workspaces.keys()].join(', ')}` : `No workspaces in ${configFile}${existsSync(configFile) ? '' : ' (no such file yet)'}`);
  };
  describeWorkspaces();

  /** Tells the app which servers and workspaces this agent offers; sent on connect and when the config changes. */
  async function sendInfo() {
    await fetch(new URL('/api/machines/info', appUrl), {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ servers: offered(), ...(host ? host.summary() : {}) }),
    }).then(async (res) => {
      // fetch doesn't throw on a refusal; a silent one hid #301's 404.
      if (!res.ok) log(`The app refused this computer's workspaces: ${res.status} ${(await res.json().catch(() => ({}))).error ?? ''}`);
    }).catch((err) => log(`Could not tell the app about workspaces: ${err.message}`));
  }
  if (host) {
    watchFile(configFile, { interval: 3000 }, () => {
      host.reload();
      log('The config changed.');
      describeWorkspaces();
      sendInfo();
    });
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
    const proc = spawn(spec.command, spec.args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...spec.env }, shell: spec.shell });
    const s = { proc, chain: Promise.resolve() };
    sessions.set(id, s);
    log(`Session ${id.slice(0, 6)} started ${describe}`);
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
    s.chain = s.chain.then(async () => {
      const res = await fetch(new URL('/api/machines/send', appUrl), {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: id, ...body }),
      });
      // The thread's turn ended: nobody is listening to this server any more.
      if (res.status === 410) stopServer(id);
    }).catch((err) => log(`Could not send to the app: ${err.message}`));
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

  let retry = 0;
  async function connect() {
    const url = new URL('/api/machines/connect', appUrl);
    url.searchParams.set('host', hostname());
    url.searchParams.set('command', describe);
    const res = await fetch(url, { headers: { ...auth, Accept: 'text/event-stream' } });
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
    for await (const msg of events(res.body)) {
      if (msg.hello) {
        log(`Connected to ${new URL(appUrl).host} as "${msg.hello}". Minions can use ${describe}${host?.workspaces.size ? ` and workspaces ${[...host.workspaces.keys()].join(', ')}` : ''} while this runs.`);
        retry = 0;
        sendInfo();
      } else if (msg.close) {
        stopServer(msg.session);
      } else if (msg.session && msg.server === 'ws') {
        if (!host) continue;
        const s = sessions.get(msg.session) ?? startWorkspace(msg.session, String(msg.who ?? 'a minion'));
        onWorkspaceMessage(msg.session, s, msg.message);
      } else if (msg.session && lends) {
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
      const wait = Math.min(30, 2 ** retry++);
      log(`Disconnected: ${err.message}. Retrying in ${wait}s.`);
      await new Promise((r) => setTimeout(r, wait * 1000));
    }
  }
}

// Run as a program, not when a test imports the workspace parts.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
