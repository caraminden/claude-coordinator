// Each person's own Claude plan (#213): a rootless podman container per linked person, whose volume
// is their home and holds their Claude sign-in. Citadel never reads, stores or relays the token:
// the sign-in runs inside the container, and only the one-time code people paste passes through.
// Their turns run in it (src/runner.ts, placeFor) at the same paths as on the host. The server
// login's owner keeps running on the host. The credential row (kind claude_runner) holds only
// Citadel's bookkeeping: container, volume path, email and plan.
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { Containers, specHash, type ContainerSpec, type Mount } from './containers.ts';
import type { Credentials } from './credentials.ts';
import type { Store } from './db.ts';
import { claudeConfigDir, projectSlug } from './sessions.ts';

const IMAGE_REPO = 'localhost/citadel-claude';
const CONTAINERFILE_DIR = join(import.meta.dirname, '..', 'deploy', 'claude-container');
/** Host tool folders a turn may need (Delve's dotnet and Godot, mise toolchains), mounted read-only where they exist. */
const TOOL_DIRS = ['.dotnet', '.local/bin', '.local/share/mise', '.local/godot'];

/** Variables that would win over the container's own sign-in (Claude Code's auth precedence), so a container turn never gets the server's. */
export const AUTH_VARS = ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'];

/** Turn errors that mean the sign-in itself was refused, not a limit or an outage. */
export function isAuthFailure(text: string): boolean {
  return /\b401\b|authentication_error|invalid (x-)?api[ -]key|invalid bearer token|oauth token (has )?(expired|revoked)|token (has )?expired|please run \/login/i.test(text);
}

export interface ClaudeMeta {
  container: string;
  /** The volume's folder on the host: the container's home, so the server can restore and save sessions in it. */
  home: string;
  email?: string;
  plan?: string;
  linkedAt: number;
}

export type ClaudeState = 'not linked' | 'starting' | 'waiting for code' | 'linked' | 'expired';

export interface ClaudeStatus {
  state: ClaudeState;
  /** This person's turns run on the server's own login (the Turns switch), so there's nothing to link. */
  host: boolean;
  url?: string;
  email?: string;
  plan?: string;
  error?: string;
}

/** Where a turn runs: the host, or a person's container (with its config folder as the host sees it). */
export type TurnPlace = { host: true } | { host: false; container: string; configDir: string; env: Record<string, string>; ensure: () => Promise<void> };

interface Login {
  child: ChildProcess | null;
  out: string;
  url?: string;
  error?: string;
  exited?: Promise<number>;
}

/** The `claude` executable's real file, so its folder (every installed version) can be mounted read-only. */
export function resolveClaude(bin: string, path = process.env.PATH ?? ''): string {
  if (bin.includes('/')) return realpathSync(bin);
  for (const d of path.split(delimiter)) if (d && existsSync(join(d, bin))) return realpathSync(join(d, bin));
  throw new Error(`${bin} is not on PATH`);
}

export class ClaudeLink {
  /** Sign-ins in progress, by user id. */
  private logins = new Map<number, Login>();
  private home = homedir();
  /** Whether turns are running in a container right now (it isn't restarted under them). */
  busy: (container: string) => boolean = () => false;

  private store: Store;
  private credentials: Credentials;
  private dataDir: string;
  private claudeBin: string;
  private containers: Containers;
  /** Names its containers: "citadel-claude-" for the live server, with a tag for a dev copy so the two never share one. */
  private prefix: string;

  constructor(store: Store, credentials: Credentials, dataDir: string, claudeBin: string, containers = new Containers(), prefix = 'citadel-claude-') {
    this.store = store;
    this.credentials = credentials;
    this.dataDir = dataDir;
    this.claudeBin = claudeBin;
    this.containers = containers;
    this.prefix = prefix;
  }

  /** Container and volume name for a person. */
  name(uid: number): string {
    return `${this.prefix}${uid}`;
  }

  meta(uid: number): ClaudeMeta | null {
    return this.credentials.get<ClaudeMeta>(uid, 'claude_runner')?.meta ?? null;
  }

  /** Turns for this person may start: on the host (server login) or in a container that's signed in. */
  linked(uid: number): 'linked' | 'expired' | null {
    const c = this.credentials.get<ClaudeMeta>(uid, 'claude_runner');
    return !c ? null : c.failed ? 'expired' : 'linked';
  }

  status(uid: number): ClaudeStatus {
    const user = this.store.getUser(uid);
    const host = !!user?.server_login;
    const login = this.logins.get(uid);
    const c = this.credentials.get<ClaudeMeta>(uid, 'claude_runner');
    const base = { host, ...(c?.meta.email ? { email: c.meta.email } : {}), ...(c?.meta.plan ? { plan: c.meta.plan } : {}), ...(login?.error ? { error: login.error } : {}) };
    if (login && !login.error) return { ...base, state: login.url ? 'waiting for code' : 'starting', ...(login.url ? { url: login.url } : {}) };
    return { ...base, state: !c ? 'not linked' : c.failed ? 'expired' : 'linked' };
  }

  /** The image tag for the current Containerfile. */
  private image(): string {
    return `${IMAGE_REPO}:${createHash('sha256').update(readFileSync(join(CONTAINERFILE_DIR, 'Containerfile'))).digest('hex').slice(0, 12)}`;
  }

  /** What a person's container is made of. Every mount sits at its host path, so worktrees, session folders and prompts match. */
  spec(uid: number): ContainerSpec {
    const name = this.name(uid);
    const config = join(this.home, '.claude');
    const mounts: Mount[] = [
      { src: name, dst: this.home, volume: true },
      { src: join(this.dataDir, 'projects'), dst: join(this.dataDir, 'projects') },
      { src: join(this.dataDir, 'run', 'turns'), dst: join(this.dataDir, 'run', 'turns') },
      { src: dirname(resolveClaude(this.claudeBin)), dst: dirname(resolveClaude(this.claudeBin)), ro: true },
    ];
    for (const d of TOOL_DIRS) if (existsSync(join(this.home, d))) mounts.push({ src: join(this.home, d), dst: join(this.home, d), ro: true });
    // Each scheme's Claude Code memory, shared with the host's turns: the server's copy, at the path claude looks in.
    for (const p of this.store.listProjects()) {
      if (!p.repo_dir) continue;
      const slug = projectSlug(p.repo_dir);
      const src = join(claudeConfigDir(process.env), 'projects', slug, 'memory');
      mkdirSync(src, { recursive: true });
      mounts.push({ src, dst: join(config, 'projects', slug, 'memory') });
    }
    return { name, image: this.image(), mounts, env: { HOME: this.home }, memory: '6g', cpus: 4 };
  }

  /** Build the image if needed, make the volume and start the container (or keep it, if it runs from this spec or turns run in it). */
  async ensure(uid: number): Promise<void> {
    const spec = this.spec(uid);
    await this.containers.ensureImage(spec.image, CONTAINERFILE_DIR);
    await this.containers.createVolume(spec.name);
    const now = await this.containers.status(spec.name);
    // shortcut: a changed spec (new image, a new scheme's memory) waits until no turn runs in the container; a busy one keeps its old mounts meanwhile.
    if (now.state === 'running' && (now.spec === specHash(spec) || this.busy(spec.name))) return;
    await this.containers.start(spec);
    void this.containers.pruneImages(IMAGE_REPO, spec.image);
  }

  /** Where a turn for `uid` runs, or null when it can't run (not linked, signed out). */
  place(uid: number | null): TurnPlace | null {
    const user = uid ? this.store.getUser(uid) : undefined;
    if (!user || user.server_login) return user ? { host: true } : null;
    const c = this.credentials.get<ClaudeMeta>(user.id, 'claude_runner');
    if (!c || c.failed) return null;
    return {
      host: false, container: c.meta.container, configDir: join(c.meta.home, '.claude'),
      env: { HOME: this.home, CLAUDE_CONFIG_DIR: join(this.home, '.claude'), DISABLE_AUTOUPDATER: '1' },
      ensure: () => this.ensure(user.id),
    };
  }

  /** The sign-in went bad mid-turn: say so until they link again. */
  expire(uid: number) {
    this.credentials.fail(uid, 'claude_runner');
  }

  /**
   * Start linking: the container, then `claude auth login` under a pty (script) inside it, over plain
   * pipes. Resolves once Anthropic's link is out (or it failed); the code comes later, in code().
   */
  async link(uid: number): Promise<ClaudeStatus> {
    const old = this.logins.get(uid);
    if (old?.child && !old.error) old.child.kill();
    const login: Login = { child: null, out: '' };
    this.logins.set(uid, login);
    try {
      await this.ensure(uid);
      const claude = resolveClaude(this.claudeBin);
      const child = spawn('podman', ['exec', '-i', '-e', `CLAUDE_CONFIG_DIR=${join(this.home, '.claude')}`, this.name(uid), 'script', '-qfec', `stty cols 4000; ${claude} auth login --claudeai`, '/dev/null'], { stdio: ['pipe', 'pipe', 'pipe'] });
      login.child = child;
      login.exited = new Promise((r) => child.on('exit', (code) => r(code ?? 1)));
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          login.error = 'The sign-in didn\'t show a link within 60 seconds.';
          child.kill();
          resolve();
        }, 60_000);
        const take = (buf: Buffer) => {
          login.out = (login.out + stripAnsi(buf.toString())).slice(-20_000);
          const url = signInUrl(login.out);
          if (url && !login.url) {
            login.url = url;
            clearTimeout(timer);
            resolve();
          }
        };
        child.stdout!.on('data', take);
        child.stderr!.on('data', take);
        void login.exited!.then((code) => {
          if (!login.url) login.error = `The sign-in ended (code ${code}) before showing a link: ${lastLines(login.out)}`;
          clearTimeout(timer);
          resolve();
        });
      });
    } catch (err: any) {
      login.error = err.message;
    }
    return this.status(uid);
  }

  /** Pass the pasted code to the waiting sign-in, wait for it to finish, and record who signed in. */
  async code(uid: number, code: string): Promise<ClaudeStatus> {
    const login = this.logins.get(uid);
    if (!login?.child || !login.url || !login.exited) throw new Error('No sign-in is waiting for a code: start linking again.');
    login.child.stdin!.write(`${code}\r`);
    const exit = await Promise.race([login.exited, new Promise<null>((r) => setTimeout(() => r(null), 60_000))]);
    if (exit === null) login.child.kill();
    const who = await this.whoami(uid);
    if (!who.loggedIn) {
      login.error = `The sign-in didn't take${exit === null ? ' (no answer within a minute)' : ''}: ${lastLines(login.out)}`;
      login.child = null;
      return this.status(uid);
    }
    const home = await this.containers.volumePath(this.name(uid));
    if (!home) throw new Error(`The volume ${this.name(uid)} is gone.`);
    // The secret is only the container's name: there is nothing secret here, and never a Claude token.
    this.credentials.put(uid, 'claude_runner', this.name(uid), { container: this.name(uid), home, email: who.email, plan: who.plan, linkedAt: Date.now() } satisfies ClaudeMeta);
    this.logins.delete(uid);
    return this.status(uid);
  }

  /** Stop a sign-in in progress without linking. */
  cancel(uid: number) {
    this.logins.get(uid)?.child?.kill();
    this.logins.delete(uid);
  }

  /** Sign out inside the container, stop it, and remove the volume with everything in it. */
  async unlink(uid: number): Promise<void> {
    this.cancel(uid);
    const name = this.name(uid);
    if ((await this.containers.status(name)).state === 'running') await this.containers.exec(name, [resolveClaude(this.claudeBin), 'auth', 'logout'], { env: { CLAUDE_CONFIG_DIR: join(this.home, '.claude') }, timeout: 30_000 });
    await this.containers.stop(name);
    await this.containers.removeVolume(name);
    this.credentials.remove(uid, 'claude_runner');
  }

  /** `claude auth status` in the container: signed in or not, and as whom. */
  private async whoami(uid: number): Promise<{ loggedIn: boolean; email?: string; plan?: string }> {
    const r = await this.containers.exec(this.name(uid), [resolveClaude(this.claudeBin), 'auth', 'status'], { env: { CLAUDE_CONFIG_DIR: join(this.home, '.claude') }, timeout: 30_000 });
    try {
      const s = JSON.parse(r.stdout);
      return { loggedIn: !!s.loggedIn, email: s.email ?? s.account?.email, plan: s.subscriptionType ?? s.plan };
    } catch {
      return { loggedIn: false };
    }
  }
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)|\r/g, '');
}

/** Anthropic's sign-in link in the sign-in's output (on one line: the pty is 4000 columns wide). */
export function signInUrl(out: string): string | null {
  return /https:\/\/\S*oauth\S*/.exec(out)?.[0] ?? null;
}

function lastLines(out: string): string {
  return out.trim().split('\n').slice(-3).join(' ').slice(0, 300) || '(no output)';
}
