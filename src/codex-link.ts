// Signing in to Codex from Settings (#330), like linking Claude: `codex login --device-auth` runs in
// the person's own Claude container, Settings shows OpenAI's link and one-time code, and the person
// signs in with ChatGPT in their browser. The login stays in ~/.codex/auth.json in their volume:
// Citadel only checks that the file exists, and never reads, stores or relays it.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ClaudeLink } from './claude-link.ts';
import { Containers } from './containers.ts';

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

export class CodexLink {
  private logins = new Map<number, Login>();
  private claude: ClaudeLink;
  private containers: Containers;

  constructor(claude: ClaudeLink, containers = new Containers()) {
    this.claude = claude;
    this.containers = containers;
  }

  status(uid: number): CodexStatus {
    const meta = this.claude.meta(uid);
    // Codex runs only in a person's container, where its managed tripwire hook is (deploy/claude-container/codex).
    if (!meta) return { state: 'no container' };
    const login = this.logins.get(uid);
    if (existsSync(join(meta.home, '.codex', 'auth.json'))) {
      if (login?.done) this.logins.delete(uid);
      return { state: 'linked' };
    }
    const error = login?.error ? { error: login.error } : {};
    // From the click on: the container can take minutes to start before codex even runs.
    if (login && !login.done && !login.error) return login.code ? { state: 'waiting', url: login.url, code: login.code } : { state: 'starting' };
    return { state: 'not linked', ...error };
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
          login.error ??= 'Codex\'s sign-in didn\'t show a code within 60 seconds.';
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
    } catch (err: any) {
      login.error = err.message;
      login.done = true;
    }
    return this.status(uid);
  }

  /** Stop a sign-in in progress. */
  cancel(uid: number) {
    const login = this.logins.get(uid);
    this.logins.delete(uid);
    login?.child?.kill();
  }

  /** Sign out of Codex in their container (codex revokes the login and deletes the file). */
  async unlink(uid: number): Promise<void> {
    this.cancel(uid);
    if (this.status(uid).state !== 'linked') return;
    await this.claude.ensure(uid);
    const r = await this.containers.exec(this.claude.name(uid), ['codex', 'logout', '-c', FILE_STORE], { timeout: 60_000 });
    if (r.code !== 0) throw new Error(`Codex didn't sign out: ${lastLines(`${r.stdout}\n${r.stderr}`)}`);
  }
}

/** OpenAI's device link and one-time code in `codex login --device-auth`'s output, or null until both are out. */
export function deviceCode(out: string): { url: string; code: string } | null {
  const url = /https:\/\/auth\.openai\.com\/\S+/.exec(out)?.[0];
  const code = /one-time code[^\n]*\n\s*([A-Z0-9]{3,}(?:-[A-Z0-9]{3,})+)\s*$/m.exec(out)?.[1];
  return url && code ? { url, code } : null;
}

function signInError(code: number | null, out: string): string {
  if (code === 127 || /executable file .*not found|codex: not found/i.test(out)) return 'Your container is from before Codex was added: it updates once no turns run in it. Try again then.';
  return `Codex's sign-in ended (${code === null ? 'stopped' : `exit ${code}`}) without signing in: ${lastLines(out.split('\n').filter((l) => !/https:\/\/|one-time code|^\s*[A-Z0-9]{3,}-[A-Z0-9-]{3,}\s*$/.test(l)).join('\n'))}`;
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)|\r/g, '');
}

function lastLines(out: string): string {
  return out.trim().split('\n').filter((l) => l.trim()).slice(-3).join(' ').slice(-300) || '(no output)';
}
