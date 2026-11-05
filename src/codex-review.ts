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
// never runs unguarded: on the host, or in a container built before it.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REQUIREMENTS = '/etc/codex/requirements.toml';
const HOOK = '/etc/codex/citadel-hook.mjs';

/** Why a review can't run here, or null. Only checks that files exist: the login is never read. */
export function notReady(env: Record<string, string | undefined> = process.env, requirements = REQUIREMENTS): string | null {
  let req = '';
  try {
    req = readFileSync(requirements, 'utf8');
  } catch {}
  if (!req.includes(HOOK) || !/^allow_managed_hooks_only\s*=\s*true/m.test(req)) return `Codex's managed tripwire hook isn't installed here (${requirements}): Codex runs only in a person's container, built from deploy/claude-container.`;
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
person's Codex usage and skips (code 4) when overPace says so; `usage` is the latest usage line.
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

function tail(s: string): string {
  const t = s.trim().split('\n').slice(-5).join('\n');
  return t ? `\n${t}` : '';
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
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
