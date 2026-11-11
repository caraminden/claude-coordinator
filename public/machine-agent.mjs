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
// The token can come from CC_MACHINE_TOKEN instead. Needs Node 18 or newer; no other installs.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, chmodSync, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, watchFile, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
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
 */
export function loadConfig(file, env = process.env) {
  const workspaces = new Map();
  const servers = new Map();
  const problems = [];
  const none = { workspaces, servers, problems, screenLock: null, screenshots: false };
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
  return { workspaces, servers, problems, screenLock, screenshots };
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
  const names = scopes.flatMap((s) => Object.entries(s ?? {}).filter(([name, e]) => SERVER_NAME.test(name) && typeof e?.command === 'string' && e.command).map(([name]) => name));
  return [...new Set(names)].sort();
}

const TOOLS = [
  { name: 'workspaces', description: 'The workspaces on this computer: folder, what is checked out, local changes, the tasks you can run, and whether a job holds it. Call this first.', inputSchema: { type: 'object', properties: {} } },
  {
    name: 'git_sync',
    description: 'git fetch origin, then check out origin/<ref> (a pushed branch) or a commit, detached. Local changes that don\'t conflict carry over; if they would be overwritten it stops and changes nothing. Never resets, cleans, stashes or pushes. Refused in a workspace whose owner switched it off (the workspaces tool says so).',
    inputSchema: { type: 'object', properties: { workspace: { type: 'string' }, ref: { type: 'string', description: 'Branch name on origin, or a commit sha' } }, required: ['workspace', 'ref'] },
  },
  {
    name: 'run_task',
    description: 'Run one of the workspace\'s tasks (listed by the workspaces tool) in its folder. Waits up to `wait` seconds (default and most 50), then returns the result, or a job id to pass to the job tool. One job per workspace at a time. A task marked "takes arguments" appends `args` to its command (no shell); others refuse them.',
    inputSchema: { type: 'object', properties: { workspace: { type: 'string' }, task: { type: 'string' }, wait: { type: 'number' }, args: { type: 'array', items: { type: 'string' }, description: 'Extra arguments, only for a task that takes them' } }, required: ['workspace', 'task'] },
  },
  {
    name: 'job',
    description: 'A task job\'s state, exit code and last output lines; waits up to `wait` seconds (default and most 50) for it to finish.',
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
    description: 'Copy a file (up to 20 MB, any kind: a zip, a save, a log) from a workspace or its read folders to the app\'s server, into your files folder there, and return its path. The bytes don\'t pass through this conversation.',
    inputSchema: { type: 'object', properties: { workspace: { type: 'string' }, path: { type: 'string' } }, required: ['workspace', 'path'] },
  },
  {
    name: 'screenshot',
    description: 'Take a PNG of this computer\'s screen, or of the first visible window whose title contains `window`, after `delay` seconds (most 30), and copy it to your files folder on the app\'s server; returns its path, which you can open to look at. Only on a computer whose owner turned screenshots on (a test box).',
    inputSchema: { type: 'object', properties: { window: { type: 'string', description: 'Part of the window\'s title; leave out for the whole screen' }, delay: { type: 'number' } } },
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
  return new Promise((done) => spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('close', done).on('error', done));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms).unref?.());
const secondsSince = (t) => Math.round((Date.now() - t) / 1000);
const waitFor = (v) => Math.min(WAIT_MAX, Math.max(0, Number.isFinite(v) ? v : WAIT_MAX));
const size = (n) => (n < 1024 * 1024 ? `${Math.ceil(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const ARGS_MAX = 64;
const ARG_LENGTH_MAX = 4000;
const SHOT_DELAY_MAX = 30;
const LOCK_STALE_MS = 2 * 60 * 60_000; // past any job's 30 minutes or a desktop CI job's timeout

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/**
 * The test box's screen lock (#369): one file naming who has the screen, taken by the agent for a
 * task or a screenshot and by the box's CI job hooks (tools/win-test-box/screen-lock.ps1), so no
 * two of them put windows on the one screen at once. A holder whose process is gone, a lock older
 * than LOCK_STALE_MS, or an unreadable one over a minute old is broken and taken over.
 */
export function takeScreenLock(file, what, who) {
  const mine = { pid: process.pid, what, who, since: Date.now(), token: randomBytes(6).toString('hex') };
  for (let tries = 0; tries < 3; tries++) {
    try {
      writeFileSync(file, JSON.stringify(mine), { flag: 'wx' });
      return mine;
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
    if (!stale) {
      const since = valid ? held.since : mtime;
      throw new ToolError(`The screen is busy: ${held?.what ?? 'something'} for ${held?.who ?? 'someone'}, started ${secondsSince(since)} s ago. Nothing was started. Try again in a few minutes.`);
    }
    // Only the lock we judged: another taker may have broken it and taken it since.
    try {
      if (readFileSync(file, 'utf8') === raw) rmSync(file, { force: true });
    } catch {}
  }
  throw new ToolError(`Could not take the screen lock ${file}: it keeps coming back`);
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
  constructor({ configFile, env = process.env, jobsDir, capture = captureScreen }) {
    this.configFile = configFile;
    this.env = env;
    this.jobsDir = jobsDir;
    this.capture = capture;
    this.busy = new Map(); // workspace name -> { what, who, since, job? }
    this.jobs = new Map();
    // The workspace names minions get (#439), as ticked on the Machines page; null lends them all (an agent set up the old way).
    this.lent = null;
    this.reload();
  }

  reload() {
    ({ workspaces: this.all, servers: this.servers, problems: this.problems, screenLock: this.screenLock, screenshots: this.screenshots } = loadConfig(this.configFile, this.env));
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
      case 'run_task': return this.runTask(this.workspace(args.workspace), String(args.task ?? ''), who, waitFor(args.wait), args.args);
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
      case 'screenshot': return this.screenshot(String(args.window ?? ''), Number(args.delay) || 0, who, upload);
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
        w.gitSync ? '' : 'git_sync: off (its owner keeps it on a branch)',
        `Local changes:\n${c.changes}`,
        `Busy: ${b ? `${b.what} for ${b.who}, ${secondsSince(b.since)} s${b.job ? ` (job ${b.job.id})` : ''}` : 'no'}`,
        'Tasks:',
        ...[...w.tasks].map(([name, t]) => `- ${name}: ${t.run.join(' ')}${t.args ? ' …takes arguments' : ''}${t.about ? ` (${t.about})` : ''}`),
      ].filter(Boolean).join('\n'));
    }
    if (this.screenLock) {
      const held = screenHolder(this.screenLock);
      parts.push(`Screen: ${held ? `busy, ${held.what} for ${held.who}` : 'free'}. Tasks that use it and screenshots wait their turn with this computer's CI desktop jobs.`);
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
    const lock = this.take(w, `task ${name}`, who);
    let screen = null;
    try {
      if (this.screenLock && task.screen) screen = takeScreenLock(this.screenLock, `task ${name} in ${w.name}`, who);
    } catch (err) {
      this.release(w, lock);
      throw err;
    }
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
      // Why it is being stopped: it may exit while that is under way.
      let stopping = null;
      const finish = (code, error) => {
        if (job.ended) return;
        error ??= stopping;
        clearTimeout(limit);
        job.ended = Date.now();
        job.code = code;
        job.error = error;
        if (job.partial) job.tail.push(job.partial);
        file.end(error ? `\n${error}\n` : `\nexit ${code}\n`);
        if (child && OWN_GROUP) liveGroups.delete(child.pid);
        this.release(w, lock);
        if (screen) releaseScreenLock(this.screenLock, screen);
        resolveDone();
      };
      job.stop = async (why) => {
        stopping = why;
        if (child) await killTree(child);
        finish(null, why);
      };
      const limit = setTimeout(() => {
        stopping = `Stopped after ${TASK_LIMIT_MS / 60_000} minutes`;
        if (child) killTree(child);
        finish(null, stopping);
      }, TASK_LIMIT_MS);
      try {
        child = spawn(argv[0], argv.slice(1), { cwd: w.path, env: this.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: OWN_GROUP });
        if (OWN_GROUP && child.pid) liveGroups.add(child.pid);
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

  async screenshot(window, delay, who, upload) {
    if (!this.screenshots) throw new ToolError('Screenshots are off on this computer. Its owner turns them on with "screenshots": true in machine-agent.json (a test box has it).');
    if (window.length > 200) throw new ToolError('window is part of a title: at most 200 characters');
    if (!upload) throw new ToolError('This session has no way to send files to the app');
    // A minion looking at the app its own job launched already has the screen.
    const held = this.screenLock ? screenHolder(this.screenLock) : null;
    const own = held && held.pid === process.pid && held.who === who;
    const screen = this.screenLock && !own ? takeScreenLock(this.screenLock, 'a screenshot', who) : null;
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
${Object.entries(vars).map(([k, v]) => `    <key>${k}</key>\n    <string>${xml(v)}</string>`).join('\n')}
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
      file, log, text,
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
${Object.entries(vars).map(([k, v]) => `Environment=${unitQuote(`${k}=${v}`)}`).join('\n')}
ExecStart=${args.map(unitWord).join(' ')}
Restart=always
RestartSec=30

[Install]
WantedBy=default.target
`;
  return {
    file, log, text,
    before: [],
    start: [['systemctl', '--user', 'daemon-reload'], ['systemctl', '--user', 'enable', unit], ['systemctl', '--user', 'restart', unit]],
    stop: `systemctl --user stop ${unit}`,
    remove: `systemctl --user disable --now ${unit}; rm ${file}`,
    startAgain: `systemctl --user start ${unit}`,
    linger: 'It runs while you are logged in. To keep it running after you log out, and start it at boot, run: loginctl enable-linger',
  };
}

/** Writes the background service, (re)starts it, and waits to see it connect, printing what it logged. */
async function installService(name, argv) {
  if (!/^[a-z0-9][a-z0-9-]{0,29}$/.test(name ?? '')) throw new Error('--install needs the machine\'s name, as the Machines page shows it');
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
      throw new Error(`${cmd} ${args.join(' ')} failed${run.error ? `: ${run.error.message}` : `:\n${run.stderr.trim()}`}\n` +
        (cmd === 'systemctl'
          ? 'This computer has no systemd user session: run the same line without --install and the name, in a terminal you leave open, instead.'
          : 'launchd needs this Mac\'s own login (not SSH): run this in Terminal on the Mac, or run the same line without --install and the name in a terminal you leave open.'));
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
  console.log([
    '',
    ok ? 'It runs in the background now, also after you close this window, and starts again at every login.' : 'It has not connected yet: the lines above say why (nothing above means it did not start).',
    s.linger,
    `Its output: tail -f ${s.log}`,
    `Stop it: ${s.stop}   (start it again: ${s.startAgain})`,
    `Remove it: ${s.remove}`,
  ].filter(Boolean).join('\n'));
  process.exit(ok ? 0 : 1);
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
  const installName = opts.includes('--install') ? option('--install') ?? '' : null;
  const logFile = option('--log');
  const [appUrl, argToken] = opts;
  const token = argToken ?? process.env.CC_MACHINE_TOKEN;
  if (!appUrl || !token || (!command.length && !claudeMcp && !configArg)) {
    console.error('Usage: node machine-agent.mjs <app url> <token> --config machine-agent.json');
    console.error('   or: node machine-agent.mjs <app url> <token> --claude-mcp <name> [--config machine-agent.json]');
    console.error('   or: node machine-agent.mjs <app url> <token> [--config machine-agent.json] -- <mcp server command> [args...]');
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
    const entry = config.mcpServers?.[name] ?? Object.values(config.projects ?? {}).map((p) => p?.mcpServers?.[name]).find(Boolean);
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
    return installService(installName, [process.execPath, agent, ...args]).catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
  }
  if (logFile) logTo(resolve(logFile));
  const auth = { Authorization: `Bearer ${token}` };
  const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);

  const configFile = configArg && resolve(configArg);
  const host = configFile && new WorkspaceHost({ configFile, jobsDir: join(dirname(configFile), 'citadel-jobs') });
  // Nothing is lent until the app says what is ticked.
  if (managed) host.lent = new Set();
  const offered = () => [...(lends ? ['mcp'] : []), ...(host?.workspaces.size ? ['ws'] : [])];
  /** The MCP servers found here, by name: the config file's own first, then Claude Code's. */
  function found() {
    const own = [...host.servers.keys()];
    return [...own.map((name) => ({ name, from: 'file' })), ...claudeServerNames().filter((n) => !own.includes(n)).map((name) => ({ name, from: 'claude' }))];
  }
  const describeWorkspaces = () => {
    if (!host) return;
    for (const p of host.problems) log(`Config problem: ${p}`);
    log(host.all.size ? `Workspaces from ${configFile}: ${[...host.all.keys()].join(', ')}` : `No workspaces in ${configFile}${existsSync(configFile) ? '' : ' (no such file yet)'}`);
    if (managed) log(`MCP servers found here: ${found().map((f) => f.name).join(', ') || 'none'}`);
  };
  describeWorkspaces();

  /** Tells the app which servers and workspaces this agent offers; sent on connect and when the config changes. */
  async function sendInfo() {
    await fetch(new URL('/api/machines/info', appUrl), {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      // v says which agent this is: the app shows one without it as set up the old way.
      body: JSON.stringify({ ...(managed ? { v: 2, found: (reported = found()) } : { servers: offered() }), ...(host ? host.summary() : {}) }),
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
  // Claude Code rewrites its config all the time, so look now and then and say so only when the names changed.
  let reported = [];
  if (managed) setInterval(() => JSON.stringify(found()) !== JSON.stringify(reported) && sendInfo(), FOUND_EVERY_MS).unref();

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
    // It lends nothing until it has said what it found and heard what is ticked.
    if (managed) url.searchParams.set('v', '2');
    // The app pings every 25 s. Silence for a minute (after a sleep, say) means the connection is dead though
    // nothing said so: drop it and connect again. A beat every 20 s tells the app this computer is awake.
    const quiet = new AbortController();
    let lastHeard = Date.now();
    const watch = setInterval(() => {
      if (Date.now() - lastHeard > SILENT_MS) return quiet.abort(new Error(`nothing from the app for ${SILENT_MS / 1000} s`));
      fetch(new URL('/api/machines/send', appUrl), { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{"beat":true}', signal: AbortSignal.timeout(15_000) }).catch(() => {});
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
        sendInfo();
      } else if (msg.lend) {
        setLend(msg.lend);
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
      const wait = Math.min(30, 2 ** retry++);
      log(`Disconnected: ${err.message}. Retrying in ${wait}s.`);
      await new Promise((r) => setTimeout(r, wait * 1000));
    }
  }
}

// Run as a program, not when a test imports the workspace parts.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
