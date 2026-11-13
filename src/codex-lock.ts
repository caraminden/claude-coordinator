// A person's Codex runs share one ChatGPT login, whose refresh token is single-use: two app-servers that
// refresh the same token at once sign the person out (tools/codex-login-check.ts shows it; on codex 0.166.0, of eight started
// together on a stale login, seven were refused as reused). Codex refreshes only within 5 minutes of the
// access token's expiry or after a 401, and reloads the login from disk first. So a run holds the person's
// lock just long enough to check the token, refreshing it early while it holds the lock, and then runs
// beside the others; it keeps the lock for the whole run only when that can't be made safe (`serial`).
// Taken by a Codex turn (src/codex-turn.ts) and citadel-codex-review (src/codex-review.ts); no local
// imports, so it pins on its own.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** A run starts with at least this much life in the access token (seconds), far from Codex's own 5-minute refresh. */
export const MARGIN_S = 24 * 3600;
/** In CODEX_HOME (or CITADEL_CODEX_SERIAL=1): this person's Codex runs go one at a time again, as before #636. */
export const SERIAL_FILE = 'citadel-serial';

/** Set in a Codex turn's app-server, so its shell's commands, a review among them, know the lock is their own turn's: what the lock's pid file says. */
export const LOCK_ENV = 'CITADEL_CODEX_LOCK';

/** A process's start time in clock ticks since boot (/proc/<pid>/stat field 22), or null off Linux or once it is gone. */
export function startTime(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // Fields from the third on follow the command name, which may hold spaces and parentheses.
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null;
  } catch {
    return null;
  }
}

/**
 * The login's access token in `home`: seconds left and its whole lifetime. 'none' without ChatGPT tokens
 * (not signed in, or an API key: nothing refreshes), 'unknown' when they can't be read. Only the two
 * times leave this function.
 */
export function tokenLife(home: string, now = Date.now()): { left: number; life: number } | 'none' | 'unknown' {
  let auth: any;
  try {
    auth = JSON.parse(readFileSync(join(home, 'auth.json'), 'utf8'));
  } catch (err: any) {
    return err.code === 'ENOENT' ? 'none' : 'unknown';
  }
  const token = auth?.tokens?.access_token;
  if (!token) return 'none';
  try {
    const { exp, iat } = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString());
    if (typeof exp !== 'number') return 'unknown';
    return { left: exp - now / 1000, life: typeof iat === 'number' && exp > iat ? exp - iat : Infinity };
  } catch {
    return 'unknown';
  }
}

/** A refresh is over, or its codex killed, within this of its start (refresh's two limits and some slack). */
const REFRESH_MAX_MS = 70_000;

/**
 * Have a short `codex app-server` refresh the login now (account/read with refreshToken); resolves once it
 * is gone. codex finishes a refresh it began after its stdin closes, so one that didn't answer within
 * `timeoutMs` gets as long again to end before it is killed: killing it sooner could lose a new token the
 * server already gave out.
 */
function refresh(bin: string, env: Record<string, string | undefined>, timeoutMs = 30_000): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn(bin, ['app-server', '-c', 'cli_auth_credentials_store="file"', '-c', 'history.persistence="none"'], { env: env as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'ignore'] });
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.stdin.end();
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      // Wait for it to go: a refresh still on its way must not outlive the lock.
      const kill = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
      child.once('exit', () => (clearTimeout(kill), resolve()));
    };
    const timer = setTimeout(finish, timeoutMs);
    const send = (m: object) => child.stdin.write(JSON.stringify(m) + '\n');
    child.stdin.on('error', finish);
    child.on('error', () => ((done = true), clearTimeout(timer), resolve()));
    child.on('exit', finish);
    let buf = '';
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        let m: any;
        try {
          m = JSON.parse(buf.slice(0, nl));
        } catch {}
        buf = buf.slice(nl + 1);
        if (m?.id === 1) send({ method: 'initialized' }), send({ id: 2, method: 'account/read', params: { refreshToken: true } });
        else if (m?.id === 2) finish();
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'citadel-codex-login', version: '1' }, capabilities: { experimentalApi: false, requestAttestation: false } } });
  });
}

export interface CodexLock {
  /** Let go of the lock, if this run still holds it (a serial run); safe to call twice. */
  unlock: () => void;
  /** How long it waited for the lock. */
  waitedMs: number;
  /** It refreshed the login while it held the lock. */
  refreshed: boolean;
  /** It keeps the lock for the whole run: the person's other Codex runs wait for `unlock`. */
  serial: boolean;
}

/**
 * Check the person's Codex login in `home` (CODEX_HOME) under their lock, waiting while another live
 * process holds it (`onWait` once, after `noteMs`), and refresh it with `bin` when the access token has
 * under MARGIN_S (or half its lifetime) left. The lock is then let go, unless the run must be serial: the
 * switch (SERIAL_FILE) is on, or the token can't be read or still has under MARGIN_S left (a short-lived
 * token, a refresh that failed), where a long run could refresh beside another. When `inTurn` and
 * `env[LOCK_ENV]` names the holder, the caller runs inside that holder's serial turn (a review from a
 * Codex turn's shell): it goes ahead, since waiting would wait on itself (#468 S04-6).
 */
export async function codexLock(home: string, onWait: () => void, opts: { env?: Record<string, string | undefined>; bin?: string; inTurn?: boolean; noteMs?: number } = {}): Promise<CodexLock> {
  const env = opts.env ?? process.env;
  const noteMs = opts.noteMs ?? (Number(env.CITADEL_CODEX_WAIT_NOTE_MS) || 3000);
  const began = Date.now();
  mkdirSync(home, { recursive: true });
  const dir = join(home, 'citadel-turn.lock');
  for (let said = false; ; ) {
    try {
      mkdirSync(dir);
      // With its start time: a pid alone can be reused by an unrelated process once the holder died without unlocking (#468 S04-7).
      writeFileSync(join(dir, 'pid'), `${process.pid} ${startTime(process.pid) ?? ''}`.trim());
      break;
    } catch (err: any) {
      if (err.code !== 'EEXIST') throw err;
      let held = '';
      try {
        held = readFileSync(join(dir, 'pid'), 'utf8').trim();
      } catch {}
      if (opts.inTurn && held && held === env[LOCK_ENV]) return { unlock: () => {}, waitedMs: 0, refreshed: false, serial: false };
      const [p, started] = held.split(/\s+/);
      const pid = Number(p) || 0;
      let alive = false;
      try {
        if (pid) process.kill(pid, 0), (alive = true);
      } catch (e: any) {
        alive = e.code === 'EPERM';
      }
      if (alive && started && startTime(pid) !== started) alive = false;
      let age = 0;
      try {
        age = Date.now() - statSync(dir).mtimeMs;
      } catch {
        continue; // its holder just unlocked: try again
      }
      // No pid yet: its holder is between mkdir and write, unless that was a while ago. A holder that died
      // refreshing (a stopped turn, a review's timeout) left its codex to finish: the lock waits that out,
      // or the next run would send the same refresh token.
      if (!alive && (existsSync(join(dir, 'refreshing')) ? age > REFRESH_MAX_MS : pid || age > 10_000)) rmSync(dir, { recursive: true, force: true });
      else {
        // A login check takes a second or so: only a longer wait is worth a line in the chat.
        if (!said && Date.now() - began >= noteMs) (said = true), onWait();
        await new Promise((r) => setTimeout(r, said ? 1000 : 200));
      }
    }
  }
  const unlock = () => rmSync(dir, { recursive: true, force: true });
  const waitedMs = Date.now() - began;
  try {
    let life = tokenLife(home);
    const before = life;
    if (life !== 'none' && life !== 'unknown' && life.left < Math.min(MARGIN_S, life.life / 2)) {
      writeFileSync(join(dir, 'refreshing'), ''); // also restarts the lock's age
      await refresh(opts.bin ?? 'codex', env);
      rmSync(join(dir, 'refreshing'), { force: true });
      life = tokenLife(home);
    }
    const refreshed = life !== 'none' && life !== 'unknown' && before !== 'none' && before !== 'unknown' && life.left > before.left + 60;
    const serial = env.CITADEL_CODEX_SERIAL === '1' || existsSync(join(home, SERIAL_FILE)) || life === 'unknown' || (life !== 'none' && life.left < MARGIN_S);
    if (!serial) unlock();
    return { unlock: serial ? unlock : () => {}, waitedMs, refreshed, serial };
  } catch (err) {
    unlock();
    throw err;
  }
}
