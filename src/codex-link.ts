// Signing in to Codex from Settings (#330), like linking Claude: `codex login --device-auth` runs in
// the person's own Claude container, Settings shows OpenAI's link and one-time code, and the person
// signs in with ChatGPT in their browser. The login stays in ~/.codex/auth.json in their volume:
// Citadel only checks that the file exists, and never reads, stores or relays it.
import { spawn, type ChildProcess } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { stripAnsi, type ClaudeLink } from './claude-link.ts';
import { Containers } from './containers.ts';
import { jsonLines } from './json-lines.ts';
import { thrown } from './thrown.ts';

export type CodexState = 'no container' | 'not linked' | 'starting' | 'waiting' | 'linked';

export interface CodexStatus {
  state: CodexState;
  url?: string;
  code?: string;
  error?: string;
}

interface Login {
  child: ChildProcess | null;
  out: string;
  url?: string;
  code?: string;
  error?: string;
  /** The sign-in process has ended (signed in, failed or cancelled). */
  done?: boolean;
}

/** codex keeps its login in a file: a container has no keyring. */
const FILE_STORE = 'cli_auth_credentials_store="file"';
/** OpenAI's device code lasts 15 minutes; past that the sign-in can't finish. */
const DEVICE_CODE_MS = 16 * 60_000;
/** Settings reads a person's Codex usage windows at most this often (#342): their turns report them too. */
const LIMITS_EVERY_MS = 5 * 60_000;

export class CodexLink {
  private logins = new Map<number, Login>();
  private limitsAt = new Map<number, number>();
  /** Whether each volume home has ~/.codex/auth.json, as last looked (off the thread: status() is read on every turn start). */
  private authed = new Map<string, boolean>();
  private looking = new Map<string, Promise<void>>();
  private claude: ClaudeLink;
  private containers: Containers;

  constructor(claude: ClaudeLink, containers = new Containers()) {
    this.claude = claude;
    this.containers = containers;
  }

  status(uid: number): CodexStatus {
    // Codex runs only in a person's container, where its managed tripwire hook is (deploy/claude-container/codex):
    // their Claude one, or for the server login one of its own that its sign-in makes (#341).
    const home = this.claude.volumeHome(uid);
    if (!home && !this.claude.serverLogin(uid)) return { state: 'no container' };
    const login = this.logins.get(uid);
    if (home && this.signedIn(home)) {
      if (login?.done) this.logins.delete(uid);
      return { state: 'linked' };
    }
    const error = login?.error ? { error: login.error } : {};
    // From the click on: the container can take minutes to start before codex even runs.
    if (login && !login.done && !login.error) return login.code ? { state: 'waiting', url: login.url, code: login.code } : { state: 'starting' };
    return { state: 'not linked', ...error };
  }

  /** The last look at a home's Codex login, and a new look started for the next call. */
  private signedIn(home: string): boolean {
    void this.look(home);
    return this.authed.get(home) ?? false;
  }

  private look(home: string): Promise<void> {
    let now = this.looking.get(home);
    if (!now) {
      now = access(join(home, '.codex', 'auth.json'))
        .then(
          () => true,
          () => false,
        )
        .then((yes) => void this.authed.set(home, yes))
        .finally(() => this.looking.delete(home));
      this.looking.set(home, now);
    }
    return now;
  }

  /** Look at a person's Codex login now, for an answer that must be current (Settings, the end of a sign-in or sign-out, the server's start). */
  async refresh(uid: number): Promise<void> {
    const home = this.claude.volumeHome(uid);
    if (!home) return;
    await this.looking.get(home); // a look started before the file changed can't land after this one
    await this.look(home);
  }

  /** Start the device sign-in in their container; resolves once OpenAI's link and code are out (or it failed). */
  async link(uid: number): Promise<CodexStatus> {
    this.cancel(uid);
    const login: Login = { child: null, out: '' };
    this.logins.set(uid, login);
    try {
      await this.claude.ensure(uid);
      // Cancelled (or started again) while the container was starting.
      if (this.logins.get(uid) !== login) return this.status(uid);
      const child = spawn('podman', ['exec', '-i', this.claude.name(uid), 'codex', 'login', '--device-auth', '-c', FILE_STORE], { stdio: ['pipe', 'pipe', 'pipe'] });
      login.child = child;
      const expire = setTimeout(() => child.kill(), DEVICE_CODE_MS);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          login.error ??= "Codex's sign-in didn't show a code within 60 seconds.";
          child.kill();
          resolve();
        }, 60_000);
        const take = (buf: Buffer) => {
          login.out = (login.out + stripAnsi(buf.toString())).slice(-20_000);
          const found = deviceCode(login.out);
          if (found && !login.code) {
            Object.assign(login, found);
            clearTimeout(timer);
            resolve();
          }
        };
        child.stdout!.on('data', take);
        child.stderr!.on('data', take);
        child.on('error', (err) => {
          clearTimeout(timer);
          clearTimeout(expire);
          login.error = `Couldn't start Codex's sign-in: ${err.message}`;
          login.child = null;
          login.done = true;
          resolve();
        });
        child.on('exit', (code) => {
          clearTimeout(timer);
          clearTimeout(expire);
          if (code !== 0 && !login.error && this.logins.get(uid) === login) login.error = signInError(code, login.out);
          login.child = null;
          login.done = true;
          resolve();
        });
      });
    } catch (err) {
      login.error = thrown(err).message;
      login.done = true;
    }
    await this.refresh(uid);
    return this.status(uid);
  }

  /** Stop a sign-in in progress. */
  cancel(uid: number) {
    const login = this.logins.get(uid);
    this.logins.delete(uid);
    login?.child?.kill();
  }

  /**
   * A linked person's Codex usage windows (account/rateLimits), from a short `codex app-server` in their
   * container if it's already running (never started for this); null if not, or if read in the last LIMITS_EVERY_MS.
   */
  async readLimits(uid: number): Promise<unknown> {
    if (this.status(uid).state !== 'linked' || Date.now() - (this.limitsAt.get(uid) ?? 0) < LIMITS_EVERY_MS) return null;
    this.limitsAt.set(uid, Date.now());
    if ((await this.containers.status(this.claude.name(uid))).state !== 'running') return null;
    return appServerLimits(['podman', 'exec', '-i', this.claude.name(uid), 'codex', 'app-server', '-c', FILE_STORE, '-c', 'history.persistence="none"']);
  }

  /** Sign out of Codex in their container (codex revokes the login and deletes the file). */
  async unlink(uid: number): Promise<void> {
    this.cancel(uid);
    await this.refresh(uid);
    if (this.status(uid).state !== 'linked') return;
    await this.claude.ensure(uid);
    const r = await this.containers.exec(this.claude.name(uid), ['codex', 'logout', '-c', FILE_STORE], { timeout: 60_000 });
    await this.refresh(uid);
    if (r.code !== 0) throw new Error(`Codex didn't sign out: ${lastLines(`${r.stdout}\n${r.stderr}`)}`);
  }
}

/** Ask a `codex app-server` (argv) for its account's usage windows; null if it can't say within timeoutMs. */
export function appServerLimits(argv: string[], timeoutMs = 20_000): Promise<unknown> {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'ignore'] });
    let done = false;
    const finish = (limits?: unknown) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // app-server ends with its stdin; the kill is for one that doesn't.
      child.stdin.end();
      const kill = setTimeout(() => child.kill(), 3000);
      child.once('exit', () => clearTimeout(kill));
      if (child.exitCode !== null || child.signalCode !== null) clearTimeout(kill);
      resolve(limits ?? null);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    const send = (m: object) => child.stdin.write(JSON.stringify(m) + '\n');
    child.stdin.on('error', () => finish(null));
    child.on('error', () => finish(null));
    child.on('exit', () => finish(null));
    jsonLines<{ id?: number; result?: { rateLimitsByLimitId?: { codex?: unknown }; rateLimits?: unknown } }>(child.stdout, (m) => {
      if (m.id === 1) {
        send({ method: 'initialized' });
        send({ id: 2, method: 'account/rateLimits/read', params: { excludeResetCreditDetails: true } });
      } else if (m.id === 2) finish(m.result?.rateLimitsByLimitId?.codex ?? m.result?.rateLimits);
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'citadel-codex-usage', version: '1' }, capabilities: { experimentalApi: false, requestAttestation: false } } });
  });
}

/** OpenAI's device link and one-time code in `codex login --device-auth`'s output, or null until both are out. */
export function deviceCode(out: string): { url: string; code: string } | null {
  const url = /https:\/\/auth\.openai\.com\/\S+/.exec(out)?.[0];
  const code = /one-time code[^\n]*\n\s*([A-Z0-9]{3,}(?:-[A-Z0-9]{3,})+)\s*$/m.exec(out)?.[1];
  return url && code ? { url, code } : null;
}

function signInError(code: number | null, out: string): string {
  if (code === 127 || /executable file .*not found|codex: not found/i.test(out)) return 'Your container is from before Codex was added: it updates once no turns run in it. Try again then.';
  return `Codex's sign-in ended (${code === null ? 'stopped' : `exit ${code}`}) without signing in: ${lastLines(
    out
      .split('\n')
      .filter((l) => !/https:\/\/|one-time code|^\s*[A-Z0-9]{3,}-[A-Z0-9-]{3,}\s*$/.test(l))
      .join('\n'),
  )}`;
}

function lastLines(out: string): string {
  return (
    out
      .trim()
      .split('\n')
      .filter((l) => l.trim())
      .slice(-3)
      .join(' ')
      .slice(-300) || '(no output)'
  );
}
