// citadel-codex-review (#330): one read-only review by Codex, a second opinion from another model
// family for the self-review skill. It runs in the turn's own container on the person's own ChatGPT
// login (~/.codex, which they sign in to themselves; nothing here reads it), drives `codex app-server`
// over stdio, and prints Codex's final message.
//
//   citadel-codex-review --check            exit 0 when a review can run here, else 3 and why
//   citadel-codex-review [--timeout s] < brief.md
//
// Exits 0 with the review on stdout, 3 when it can't run here, 4 when it's skipped to save the
// person's Codex usage (overPace), 1 when the turn fails, 124 on timeout.
// It refuses to start without the managed tripwire hook (deploy/claude-container/codex), so Codex
// never runs unguarded: on the host, or in a container built before it. A host turn (the server login's,
// #398) has no hook, so when the runner names the login's Codex container (#341) in the turn's Codex
// config, the review runs there instead (inContainer), and that copy checks the hook for itself.
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REQUIREMENTS = '/etc/codex/requirements.toml';
const HOOK = '/etc/codex/citadel-hook.mjs';

/** Whether Codex's managed tripwire hook is installed here, so Codex can't run without it. */
export function hooked(requirements = REQUIREMENTS): boolean {
  let req = '';
  try {
    req = readFileSync(requirements, 'utf8');
  } catch {}
  return req.includes(HOOK) && /^allow_managed_hooks_only\s*=\s*true/m.test(req);
}

/** Why a review can't run here, or null. Only checks that files exist: the login is never read. */
export function notReady(env: Record<string, string | undefined> = process.env, requirements = REQUIREMENTS): string | null {
  if (!hooked(requirements)) return `Codex's managed tripwire hook isn't installed here (${requirements}): Codex runs only in a person's container, built from deploy/claude-container (for the server login's host turns, in its Codex container once it has signed in to Codex in Settings → Your account).`;
  const cfg = env.CITADEL_CODEX_TRIPWIRE;
  if (!cfg || !existsSync(cfg)) return 'This turn has no Codex tripwire config (CITADEL_CODEX_TRIPWIRE): it started before Codex reviews existed.';
  const home = env.CODEX_HOME || join(env.HOME || homedir(), '.codex');
  if (!existsSync(join(home, 'auth.json'))) return 'This person hasn\'t signed in to Codex in their container yet (they run `codex login --device-auth` there themselves).';
  return null;
}

export const DEVELOPER_INSTRUCTIONS = 'You are a read-only code reviewer for Citadel. Read the code with shell commands (git, rg, sed, cat); never edit, create or delete a file, and never run tests, builds, installs or network commands. A Citadel tripwire blocks some commands and says why: take that as final and carry on without it. Reply with the review only, in the format the brief asks for.';

export interface RateWindow {
  usedPercent: number;
  resetsAt?: number | null;
  windowDurationMins?: number | null;
}
export interface RateLimits {
  primary?: RateWindow | null;
  secondary?: RateWindow | null;
}

/** Past this much of a window, reviews leave the rest for the person's own Codex work. */
const FULL_PERCENT = 80;
/** How far ahead of an even pace a window may run before reviews stop (the start of a window is lumpy). */
const PACE_SLACK = 10;

function windowName(w: RateWindow): string {
  const mins = w.windowDurationMins ?? 0;
  return mins >= 1440 ? (mins === 10080 ? 'weekly' : `${Math.round(mins / 1440)}-day`) : mins ? `${Math.round(mins / 60)}-hour` : 'usage';
}

/**
 * Why a review should be skipped to save the person's Codex plan, or null. Josh (2026-11-05): "maybe
 * the codex reviewers only run if your codex usage is on track to not be maxed". A window (5-hour,
 * weekly) is over when it's FULL_PERCENT used, or used faster than an even pace to its reset.
 */
export function overPace(limits: RateLimits | null | undefined, now = Date.now()): string | null {
  for (const w of [limits?.primary, limits?.secondary]) {
    if (!w || typeof w.usedPercent !== 'number') continue;
    const name = windowName(w);
    if (w.usedPercent >= FULL_PERCENT) return `the ${name} Codex limit is ${w.usedPercent}% used`;
    if (!w.resetsAt || !w.windowDurationMins) continue;
    const gone = Math.min(1, Math.max(0, 1 - (w.resetsAt * 1000 - now) / (w.windowDurationMins * 60_000)));
    if (w.usedPercent > gone * 100 + PACE_SLACK) return `the ${name} Codex limit is ${w.usedPercent}% used with ${Math.round(gone * 100)}% of the window gone, on track to run out before it resets`;
  }
  return null;
}

/** "5-hour 12%, weekly 30%": the person's Codex usage, for the self-review report line. */
export function usageLine(limits: RateLimits | null | undefined): string {
  return [limits?.primary, limits?.secondary].filter((w): w is RateWindow => !!w && typeof w.usedPercent === 'number').map((w) => `${windowName(w)} ${w.usedPercent}%`).join(', ');
}

/**
 * Run one review: start a read-only, ephemeral thread in `cwd`, send `brief`, and resolve with Codex's
 * last message. Approval requests are declined (the sandbox already refuses writes). It first reads the
 * person's Codex usage and skips (code 4) when overPace says so; `usage` is the latest usage line.
 */
export function review(brief: string, opts: { cwd: string; timeoutMs: number; bin?: string; env?: Record<string, string | undefined>; now?: () => number }): Promise<{ code: number; text: string; usage: string }> {
  const bin = opts.bin ?? 'codex';
  // file: the login stays in ~/.codex/auth.json (there's no keyring in a container); no history: CODEX_HOME grows fast otherwise.
  const child = spawn(bin, ['app-server', '-c', 'cli_auth_credentials_store="file"', '-c', 'history.persistence="none"'], { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  let nextId = 1;
  const waiting = new Map<number, (msg: any) => void>();
  const send = (msg: object) => child.stdin.write(JSON.stringify(msg) + '\n');
  const call = (method: string, params: object) =>
    new Promise<any>((resolve, reject) => {
      const id = nextId++;
      waiting.set(id, (msg) => (msg.error ? reject(new Error(`${method}: ${msg.error.message ?? JSON.stringify(msg.error)}`)) : resolve(msg.result)));
      send({ id, method, params });
    });
  let stderr = '';
  child.stderr.on('data', (b) => (stderr = (stderr + b).slice(-4000)));
  return new Promise((resolve) => {
    let last = '';
    let limits: RateLimits | null = null;
    const errors: string[] = [];
    let done = false;
    const finish = (code: number, text: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.stdin.end();
      child.kill('SIGTERM');
      const hard = setTimeout(() => child.kill('SIGKILL'), 3000);
      child.once('exit', () => clearTimeout(hard));
      resolve({ code, text, usage: usageLine(limits) });
    };
    const timer = setTimeout(() => finish(124, `Codex didn't finish the review within ${Math.round(opts.timeoutMs / 1000)} s.${last ? `\nIts last message:\n${last}` : ''}`), opts.timeoutMs);
    child.on('error', (err) => finish(3, `Couldn't start ${bin}: ${err.message}`));
    child.on('exit', (code) => finish(1, `codex app-server exited (${code}) before the review finished.${tail(stderr)}`));
    let buf = '';
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id !== undefined && msg.method === undefined) {
          waiting.get(msg.id)?.(msg);
          waiting.delete(msg.id);
        } else if (msg.id !== undefined) {
          // A request from Codex: decline approvals, refuse the rest (no one is there to answer).
          if (/requestApproval$|^(applyPatch|execCommand)Approval$/.test(msg.method)) send({ id: msg.id, result: { decision: 'decline' } });
          else send({ id: msg.id, error: { code: -32601, message: `${msg.method} isn't available in a read-only review` } });
        } else if (msg.method === 'account/rateLimits/updated') {
          limits = msg.params?.rateLimits ?? limits;
        } else if (msg.method === 'item/completed' && msg.params?.item?.type === 'agentMessage') {
          last = String(msg.params.item.text ?? '');
        } else if (msg.method === 'error' && !msg.params?.willRetry) {
          errors.push(String(msg.params?.error?.message ?? 'unknown error'));
        } else if (msg.method === 'turn/completed') {
          const turn = msg.params?.turn ?? {};
          if (turn.status === 'completed' && last) finish(0, last);
          else finish(1, `The Codex turn ended ${turn.status ?? 'without a status'}: ${turn.error?.message ?? errors.join('; ')}${last ? `\nIts last message:\n${last}` : ''}`.trim());
        }
      }
    });
    (async () => {
      await call('initialize', { clientInfo: { name: 'citadel-codex-review', version: '1' }, capabilities: { experimentalApi: false, requestAttestation: false } });
      send({ method: 'initialized' });
      // An account without ChatGPT limits (or an older backend) can't answer: review anyway.
      const read = await Promise.race([call('account/rateLimits/read', { excludeResetCreditDetails: true }), new Promise((r) => setTimeout(r, 15_000).unref())]).catch(() => null) as any;
      limits = read?.rateLimitsByLimitId?.codex ?? read?.rateLimits ?? null;
      const why = overPace(limits, opts.now?.());
      if (why) return finish(4, `Skipped to save your Codex plan: ${why}.`);
      const { thread } = await call('thread/start', { cwd: opts.cwd, sandbox: 'read-only', approvalPolicy: 'never', ephemeral: true, developerInstructions: DEVELOPER_INSTRUCTIONS });
      await call('turn/start', { threadId: thread.id, input: [{ type: 'text', text: brief, text_elements: [] }] });
    })().catch((err) => finish(1, `${err.message}${tail(stderr)}`));
  });
}

/** Where a host turn's review runs instead (#398): the server login's Codex container, as the runner wrote it in the turn's Codex config. */
export interface ReviewContainer {
  /** The container's name (citadel-claude-<id>). */
  name: string;
  /** The person's turns folder, mounted in the container at the same path: the review's files go there. */
  turnsDir: string;
  /** The container turns' environment (HOME, PATH, ...), never the host turn's own. */
  env: Record<string, string>;
}
export interface CodexConfig {
  script: string;
  config: unknown;
  container?: ReviewContainer;
}

/** The turn's Codex config (CITADEL_CODEX_TRIPWIRE, written read-only by the runner), or null. */
export function turnConfig(env: Record<string, string | undefined> = process.env): CodexConfig | null {
  try {
    const cfg = JSON.parse(readFileSync(env.CITADEL_CODEX_TRIPWIRE!, 'utf8'));
    return typeof cfg?.script === 'string' ? cfg : null;
  } catch {
    return null;
  }
}

/**
 * The Codex config the runner wrote for this turn, or null: only the file in the turn's own folder (this
 * driver is pinned at <turn>/pin), never one CITADEL_CODEX_TRIPWIRE points elsewhere, since the turn sets
 * its own environment and the config names the container a review runs in.
 */
export function runnerConfig(env: Record<string, string | undefined> = process.env, driver = fileURLToPath(import.meta.url)): CodexConfig | null {
  try {
    const own = join(dirname(dirname(realpathSync(driver))), 'codex-tripwire.json');
    if (!env.CITADEL_CODEX_TRIPWIRE || realpathSync(env.CITADEL_CODEX_TRIPWIRE) !== own) return null;
  } catch {
    return null;
  }
  return turnConfig(env);
}

/** Copy a pinned file and the ./ files it imports into `to`, as src/runner.ts pins them. */
function copyPinned(file: string, to: string) {
  const dest = join(to, basename(file));
  if (existsSync(dest)) return;
  const source = readFileSync(file, 'utf8');
  writeFileSync(dest, source);
  for (const [, dep] of source.matchAll(/from '\.\/([^']+)'/g)) copyPinned(join(dirname(file), dep), to);
}

/** podman exec's own failures: 125 podman (no such container), 126 and 127 the command or its folder. */
const PODMAN_FAILED = new Set([125, 126, 127]);

/**
 * Run this review in the container `cfg.container` names (#398), for a host turn: its turn folder isn't
 * mounted there, so this driver and the turn's pinned tripwire are copied into the person's turns folder
 * with a review-mode Codex config (the container turns' one: Bash only, read-only), and `podman exec` runs
 * the copy in `cwd` (the worktree, mounted at the same path) with the same arguments and brief. The turn's
 * pinned kit is copied too, and the brief's paths into it point at the copy: its `Follow <kit>/agents/reviewer.md`
 * line would otherwise name a folder the container can't see. That copy checks the hook, the config and the sign-in itself, so the exit codes and the `Codex usage:` line are
 * the container's own; a container that isn't there is exit 3. The copy is removed once it ends.
 */
export function inContainer(args: string[], cfg: CodexConfig & { container: ReviewContainer }, cwd: string, podman = 'podman'): Promise<number> {
  const c = cfg.container;
  const check = args.includes('--check');
  let dir = '';
  const file = () => join(dir, 'codex-tripwire.json');
  const kit = join(dirname(fileURLToPath(import.meta.url)), 'kit');
  let brief = check ? null : readFileSync(0, 'utf8');
  try {
    mkdirSync(c.turnsDir, { recursive: true });
    dir = mkdtempSync(join(c.turnsDir, 'review-'));
    copyPinned(fileURLToPath(import.meta.url), dir);
    copyPinned(cfg.script, dir);
    writeFileSync(file(), JSON.stringify({ script: join(dir, basename(cfg.script)), config: cfg.config }), { mode: 0o444 });
    if (brief !== null && existsSync(kit)) {
      cpSync(kit, join(dir, 'kit'), { recursive: true });
      brief = brief.replaceAll(kit, join(dir, 'kit'));
    }
  } catch (err: any) {
    if (dir) rmSync(dir, { recursive: true, force: true });
    return Promise.resolve(fail(check, `Couldn't set up the review for Codex's container (${c.name}): ${err.message}`));
  }
  const driver = join(dir, basename(fileURLToPath(import.meta.url)));
  const env = { ...c.env, CITADEL_CODEX_TRIPWIRE: file() };
  const argv = ['exec', '-i', '-w', cwd, ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), c.name, 'node', driver, ...args];
  return new Promise((resolve) => {
    let stderr = '';
    let done = false;
    const end = (code: number) => {
      if (done) return;
      done = true;
      for (const s of SIGNALS) process.off(s, stop);
      rmSync(dir, { recursive: true, force: true });
      resolve(code);
    };
    // The Bash call was stopped: stop the copy too, so it doesn't go on spending the person's Codex plan.
    const stop = () => {
      spawnSync(podman, ['exec', c.name, 'pkill', '-f', '--', driver], { stdio: 'ignore', timeout: 10_000 });
      child.kill('SIGTERM');
      end(143);
    };
    const child = spawn(podman, argv, { stdio: [brief === null ? 'inherit' : 'pipe', 'inherit', 'pipe'] });
    if (brief !== null) {
      child.stdin!.on('error', () => {});
      child.stdin!.end(brief);
    }
    for (const s of SIGNALS) process.on(s, stop);
    child.stderr.on('data', (b) => {
      if (!check) process.stderr.write(b);
      stderr = (stderr + b).slice(-4000);
    });
    child.on('error', (err) => end(fail(check, `Couldn't run podman for Codex's container (${c.name}): ${err.message}`)));
    child.on('close', (code) => {
      if (code !== null && !PODMAN_FAILED.has(code)) return end(code);
      end(fail(check, `Couldn't run the review in Codex's container (${c.name}): it isn't running (a host turn starts it again), can't see this folder, or has no node.${check ? tail(stderr) : ''}`));
    });
  });
}

const SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const;

/** Exit 3 with why: on stdout for --check, as the plain run prints it, else on stderr. */
function fail(check: boolean, why: string): number {
  (check ? process.stdout : process.stderr).write(`${check ? '' : 'citadel-codex-review: '}${why}\n`);
  return 3;
}

function tail(s: string): string {
  const t = s.trim().split('\n').slice(-5).join('\n');
  return t ? `\n${t}` : '';
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  // A host turn (#398): no hook here, so the review goes to the Codex container the runner named, never runs here.
  const cfg = hooked() ? null : runnerConfig();
  if (cfg?.container) process.exit(await inContainer(args, cfg as CodexConfig & { container: ReviewContainer }, process.cwd()));
  const why = notReady();
  if (args.includes('--check')) {
    process.stdout.write(why ? `${why}\n` : 'ready\n');
    process.exit(why ? 3 : 0);
  }
  if (why) {
    process.stderr.write(`citadel-codex-review: ${why}\n`);
    process.exit(3);
  }
  const t = args.indexOf('--timeout');
  const timeoutMs = (t >= 0 ? Number(args[t + 1]) : 900) * 1000;
  const brief = readFileSync(0, 'utf8').trim();
  if (!brief || !(timeoutMs > 0)) {
    process.stderr.write('usage: citadel-codex-review [--timeout seconds] < brief.md   (or --check)\n');
    process.exit(2);
  }
  const r = await review(brief, { cwd: process.cwd(), timeoutMs, bin: process.env.CITADEL_CODEX_BIN });
  (r.code ? process.stderr : process.stdout).write(r.text + '\n');
  if (r.usage) process.stderr.write(`Codex usage: ${r.usage}\n`);
  process.exit(r.code);
}
