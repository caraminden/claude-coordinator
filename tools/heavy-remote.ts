// citadel-heavy --on <machine> (#1160): run a build or a test run on a lent machine (Cara's desktop) instead of in one of
// perigee's heavy slots, and bring its output and exit status back.
//   node heavy-remote.ts <machine> <command> [args...]
// It speaks to the machine's workspace tools (public/machine-agent.mjs) through the same session route a turn's
// mcp__<machine>-ws__ tools use (src/machine-mcp.ts), with the turn's token: workspaces, git_sync to this checkout's
// HEAD, run_task (the workspace's `heavy` task, else `build`), then job until it ends. The machine builds commits, not
// this folder, so the branch must be pushed and clean. "desktop" means the machine named in CITADEL_HEAVY_DESKTOP,
// else cara-desktop-heavy. The workspace is the one named after the repo (CITADEL_HEAVY_WORKSPACE overrides), or a
// free twin named <repo>-2, <repo>-3…: each holds one job, so a machine takes as many builds at once as it has twins.
// Exits with the command's status. When nothing ran there (no such machine, offline, busy, not pushed, dirty, no
// workspace) it writes the reason to the file CITADEL_HEAVY_FALLBACK_FILE names and exits FALLBACK: citadel-heavy then
// runs it on perigee as usual. Once a job has started there it never falls back: a lost job stops it and exits 1.
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { basename } from 'node:path';

export const FALLBACK = 120;
const API = process.env.COORDINATOR_API ?? 'http://127.0.0.1:8573';
const TOKEN = process.env.COORDINATOR_TOKEN ?? '';
const say = (text: string) => process.stderr.write(`citadel-heavy: ${text}\n`);

class Fallback extends Error {}

/** A workspace from the workspaces tool's text: whether a job holds it, and its tasks that take arguments. */
export interface Workspace { name: string; busy: boolean; tasks: Map<string, { powershell: boolean }> }
export function parseWorkspaces(text: string): Workspace[] {
  return text.split(/^## /m).slice(1).map((block) => {
    const name = block.slice(0, block.indexOf('\n')).trim();
    const busy = !/^Busy: no$/m.test(block);
    const tasks = new Map<string, { powershell: boolean }>();
    for (const m of block.matchAll(/^- ([\w.-]+): (.*)$/gm)) if (m[2].includes('…takes arguments')) tasks.set(m[1], { powershell: /powershell|pwsh/i.test(m[2]) });
    return { name, busy, tasks };
  });
}

/** The command as the one argument a task's shell takes: PowerShell's -Command line, or a POSIX shell's -c script. */
export function commandLine(argv: string[], powershell: boolean): string {
  const plain = /^[\w./:=+,@%-]+$/;
  const q = (a: string) => (plain.test(a) ? a : powershell ? `'${a.replace(/'/g, "''")}'` : `'${a.replace(/'/g, `'\\''`)}'`);
  if (!powershell) return argv.map(q).join(' ');
  const line = argv.map(q).join(' ');
  // -Command exits 0 or 1 by $?, so a native command's own status is passed on by hand.
  return `${plain.test(argv[0]) ? '' : '& '}${line}; if (-not $?) { if ($LASTEXITCODE) { exit $LASTEXITCODE } else { exit 1 } }`;
}

/** A run_task or job reply: still running (with its latest lines), or ended with a status and its last lines. */
export function parseJob(text: string): { id: string; running: boolean; code: number; head: string; lines: string[] } {
  const id = /\(job ([0-9a-f]+)\)|Job ([0-9a-f]+);/.exec(text);
  const marker = /^--- (?:latest output|last \d+ lines) ---$/m.exec(text);
  const lines = marker ? text.slice(marker.index + marker[0].length + 1).split('\n') : [];
  if (lines.length === 1 && lines[0] === '') lines.pop();
  const head = text.slice(0, text.indexOf('\n') < 0 ? text.length : text.indexOf('\n'));
  const end = / (?:succeeded|FAILED) \((.*?)\) after \d+ s\./.exec(head);
  const exit = end && /^exit (\d+)$/.exec(end[1]);
  return { id: id?.[1] ?? id?.[2] ?? '', running: !end, code: exit ? Number(exit[1]) : 1, head, lines };
}

/**
 * The lines of a window (the job's latest lines) not printed yet: past the longest run of printed's last lines it starts with.
 * shortcut: a run of identical lines (blank ones) can line up wrongly and drop or repeat a few; the full log is on the machine.
 */
export function freshLines(printed: string[], window: string[]): { lines: string[]; gap: boolean } {
  for (let k = Math.min(printed.length, window.length); k > 0; k--) {
    if (window.slice(0, k).every((l, i) => l === printed[printed.length - k + i])) return { lines: window.slice(k), gap: false };
  }
  return { lines: window, gap: printed.length > 0 && window.length > 0 };
}

/** One session with the machine's workspace tools; reopened (up to 2 min) if the app restarts under it. */
class Session {
  private id = '';
  private next = 1;
  private waiting = new Map<number, { ok: (m: any) => void; fail: (e: Error) => void }>();
  private open: Promise<void> | null = null;
  private machine: number;
  private name: string;
  constructor(machine: number, name: string) {
    this.machine = machine;
    this.name = name;
  }

  private async connect(first: boolean) {
    const started = Date.now();
    for (;;) {
      let why: string;
      try {
        const res = await fetch(`${API}/api/machines/${this.machine}/session?server=ws`, { headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'text/event-stream' } });
        if (res.ok && res.body) return this.read(res.body);
        why = `${this.name} is not available (${res.status}: ${(await res.text().catch(() => '')).trim()})`;
        if (first || res.status !== 503) throw new Fallback(why);
      } catch (err: any) {
        if (err instanceof Fallback) throw err;
        why = `could not reach Citadel (${err.message})`;
        if (first) throw new Fallback(why);
      }
      if (Date.now() - started > 120_000) throw new Fallback(why);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  private read(body: ReadableStream<Uint8Array>): Promise<void> {
    return new Promise((ready, broke) => {
      (async () => {
        const decoder = new TextDecoder();
        let buf = '';
        try {
          for await (const chunk of body as any) {
            buf += decoder.decode(chunk, { stream: true });
            let end;
            while ((end = buf.indexOf('\n\n')) >= 0) {
              const data = buf.slice(0, end).split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
              buf = buf.slice(end + 2);
              if (!data) continue;
              const msg = JSON.parse(data);
              if (msg.session) {
                this.id = msg.session;
                ready();
              } else if (msg.closed) throw new Error('closed');
              else if (msg.message?.id !== undefined && !msg.message.method) {
                const w = this.waiting.get(msg.message.id);
                this.waiting.delete(msg.message.id);
                w?.ok(msg.message);
              }
            }
          }
        } catch {
          // Cut off: the app restarted or the machine dropped.
        }
        this.open = null;
        broke(new Error('the session ended'));
        for (const w of this.waiting.values()) w.fail(new Error(`the connection to ${this.name} dropped`));
        this.waiting.clear();
      })();
    });
  }

  private async post(message: object) {
    const res = await fetch(`${API}/api/machines/${this.machine}/session/${this.id}`, {
      method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ message }),
    });
    if (!res.ok) throw new Error(`${this.name} went offline (${res.status})`);
  }

  private request(method: string, params: object): Promise<any> {
    const id = this.next++;
    return new Promise((ok, fail) => {
      this.waiting.set(id, { ok, fail });
      this.post({ jsonrpc: '2.0', id, method, params }).catch((err) => {
        this.waiting.delete(id);
        fail(err);
      });
    });
  }

  private ensure(first: boolean): Promise<void> {
    this.open ??= (async () => {
      await this.connect(first);
      await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'citadel-heavy', version: '1' } });
      await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    })();
    return this.open;
  }

  /** A tool's text and whether it is an error; after the first call, a dropped session is reopened and the call made again. */
  async call(name: string, args: object, first = false): Promise<{ text: string; error: boolean }> {
    for (let tries = 0; ; tries++) {
      try {
        await this.ensure(first);
        const reply = await this.request('tools/call', { name, arguments: args });
        if (reply.error) return { text: String(reply.error.message ?? 'error'), error: true };
        return { text: (reply.result?.content ?? []).map((c: any) => c.text ?? '').join('\n'), error: !!reply.result?.isError };
      } catch (err: any) {
        this.open = null;
        if (err instanceof Fallback || first || tries >= 3) throw err instanceof Fallback ? err : new Fallback(err.message);
        say(`${err.message}; reconnecting`);
      }
    }
  }
}

function git(...args: string[]): string {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Fallback(`git ${args[0]} failed here (${r.stderr.trim().split('\n')[0]})`);
  return r.stdout.trim();
}

/** The job once run_task has started it: from then on a failure stops it rather than running the command twice. */
let started: { s: Session; id: string; name: string } | null = null;

async function run(want: string, argv: string[]): Promise<number> {
  const name = want === 'desktop' ? process.env.CITADEL_HEAVY_DESKTOP || 'cara-desktop-heavy' : want;
  const ids = new Map((process.env.CITADEL_HEAVY_MACHINES ?? '').split(',').filter(Boolean).map((p) => [p.slice(0, p.lastIndexOf('=')), Number(p.slice(p.lastIndexOf('=') + 1))] as const));
  const machine = ids.get(name);
  if (!machine) throw new Fallback(`${name} isn't lent to this turn with workspace tools (lent: ${[...ids.keys()].join(', ') || 'none'})`);
  if (git('status', '--porcelain')) throw new Fallback(`this checkout has uncommitted changes, and ${name} builds commits: commit and push first`);
  const head = git('rev-parse', 'HEAD');
  let workspace = process.env.CITADEL_HEAVY_WORKSPACE || basename(git('remote', 'get-url', 'origin')).replace(/\.git$/, '');

  const s = new Session(machine, name);
  const list = await s.call('workspaces', {}, true);
  const ours = parseWorkspaces(list.text).filter((x) => x.name === workspace || (x.name.startsWith(`${workspace}-`) && /^\d+$/.test(x.name.slice(workspace.length + 1))));
  if (!ours.length) throw new Fallback(`${name} has no workspace ${workspace}`);
  const able = ours.filter((x) => ['heavy', 'build'].some((t) => x.tasks.has(t)));
  if (!able.length) throw new Fallback(`workspace ${workspace} on ${name} has no heavy or build task that takes a command`);
  const w = able.find((x) => !x.busy);
  if (!w) throw new Fallback(`${able.length === 1 ? `workspace ${workspace}` : `all ${able.length} ${workspace} workspaces`} on ${name} busy with other jobs`);
  workspace = w.name;
  const taskName = ['heavy', 'build'].find((t) => w.tasks.has(t))!;
  const sync = await s.call('git_sync', { workspace, ref: head });
  if (sync.error) throw new Fallback(`${name} could not check out ${head.slice(0, 8)} (pushed?): ${sync.text.split('\n')[0]}`);

  say(`running on ${name} (${workspace} at ${head.slice(0, 8)}, task ${taskName}): ${argv.join(' ')}`);
  let reply = await s.call('run_task', { workspace, task: taskName, args: [commandLine(argv, w.tasks.get(taskName)!.powershell)], wait: 50 });
  let job = parseJob(reply.text);
  if (!job.id) throw new Fallback(reply.text.split('\n')[0]);
  started = { s, id: job.id, name };
  let stopping = false;
  const stop = (signal: number) => {
    if (stopping) return;
    stopping = true;
    say(`stopping job ${job.id} on ${name}`);
    s.call('stop_job', { id: job.id }).finally(() => process.exit(128 + signal));
  };
  process.on('SIGINT', () => stop(2)).on('SIGTERM', () => stop(15));
  const printed: string[] = [];
  const print = (window: string[]) => {
    const f = freshLines(printed, window);
    if (f.gap) process.stdout.write('… (lines skipped: the full log is on the machine)\n');
    if (f.lines.length) process.stdout.write(`${f.lines.join('\n')}\n`);
    printed.push(...f.lines);
    printed.splice(0, Math.max(0, printed.length - 400));
  };
  while (job.running) {
    print(job.lines);
    reply = await s.call('job', { id: job.id, wait: 50, lines: 400 });
    if (!/still running|succeeded|FAILED/.test(reply.text.split('\n')[0])) throw new Error(`lost job ${job.id} on ${name}: ${reply.text.split('\n')[0]}`);
    job = { ...parseJob(reply.text), id: job.id };
  }
  print(job.lines);
  say(job.head);
  return job.code;
}

if (import.meta.main) {
  const [want, ...argv] = process.argv.slice(2);
  if (!want || !argv.length) {
    say('usage: heavy-remote.ts <machine> <command> [args...]');
    process.exit(2);
  }
  run(want, argv).then((code) => process.exit(code), async (err) => {
    if (started) {
      say(`error: ${err.message}; stopping job ${started.id} on ${started.name} (it may still be running there)`);
      await Promise.race([started.s.call('stop_job', { id: started.id }).catch(() => {}), new Promise((r) => setTimeout(r, 10_000))]);
      process.exit(1);
    }
    const why = `${err instanceof Fallback ? '' : 'error: '}${err.message}`;
    say(`${why}; running it here instead`);
    if (process.env.CITADEL_HEAVY_FALLBACK_FILE) writeFileSync(process.env.CITADEL_HEAVY_FALLBACK_FILE, `${why}\n`);
    process.exit(FALLBACK);
  });
}
