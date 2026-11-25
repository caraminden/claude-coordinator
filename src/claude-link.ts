// Each person's own Claude plan (#213): a rootless podman container per linked person, whose volume
// is their home and holds their Claude sign-in. Citadel never reads, stores or relays the token:
// the sign-in runs inside the container, and only the one-time code people paste passes through.
// Their turns run in it (src/runner.ts, placeFor) at the same paths as on the host. The server
// login's owner keeps running on the host. The credential row (kind claude_runner) holds only
// Citadel's bookkeeping: container, volume path, email and plan.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, join, relative } from 'node:path';
import { execResult } from './exec.ts';
import { appFolder, slotsOf } from './app-services.ts';
import { Containers, specHash, type CmdResult, type ContainerSpec, type Mount } from './containers.ts';
import type { Credentials } from './credentials.ts';
import type { Store } from './db.ts';
import { accountReady, accountUsageKey, pickAccount, WARM_MS, type Meter, type Pick } from './account-pick.ts';
import { claudeConfigDir, projectSlug } from './sessions.ts';
import { ensureGradleInit } from './build-cache.ts';
import { thrown } from './thrown.ts';
import { TASKMASTER_SLICE } from './turn-launch.ts';

const IMAGE_REPO = 'localhost/citadel-claude';
/** The checkout this server runs from (prompts.ts CHECKOUT). */
const LIVE_CHECKOUT = join(import.meta.dirname, '..');
/** More ignored files than this in the live checkout (an installed node_modules) and it isn't mounted at all. */
const MAX_MASKED = 50;
/**
 * Each person's container's memory (#1214, sizes in deploy/citadel.slice): everyday peaks were 1.6G and 3.4G, one ran to
 * 22.3G with 21.6G of it in swap. Throttled past 10G, OOM-killed (one process, OOMPolicy=continue) past 12G, 4G of zram swap.
 * Raised from 6G/8G (#1258; Josh, 2026-11-20, "Raise to 10 GB": his container hit 6G with ~10 minions and a Rust build).
 */
export const CONTAINER_MEMORY = { high: '10G', max: '12G', swap: '4G' };
/**
 * Each person's Taskmaster container (#1882; Josh, 2026-11-25, "Its own small container"): their Taskmasters' turns alone, on the
 * same login volume and files, so minions filling the container above can't slow or kill them. Host Taskmaster turns measured 0.4G
 * (median) to 0.57G at most, and a person had 5 or more at once in 5 of 822 starts in 14 days (8 at most): that many together are throttled.
 */
export const TASKMASTER_MEMORY = { high: '3G', max: '4G', swap: '2G' };

/**
 * The live checkout's read-only mount, with each file git ignores there (`.env`, `env`, a stray `.db`, the test box's
 * password file) covered by /dev/null, since they can hold secrets (#621 floor). Null, so nothing is mounted, when git
 * can't list them or there are too many to cover.
 */
export function checkoutMounts(dir: string): Mount[] | null {
  let ignored: string[];
  try {
    ignored = execFileSync('git', IGNORED_ARGS(dir), { encoding: 'utf8', timeout: 10_000 }).split('\0').filter(Boolean);
  } catch {
    return null;
  }
  return maskedMounts(dir, ignored);
}
const IGNORED_ARGS = (dir: string) => ['-C', dir, 'ls-files', '-z', '--others', '--ignored', '--exclude-standard'];
function maskedMounts(dir: string, ignored: string[]): Mount[] | null {
  if (ignored.length > MAX_MASKED) return null;
  return [{ src: dir, dst: dir, ro: true }, ...ignored.map((f) => ({ src: '/dev/null', dst: join(dir, f), ro: true }))];
}
/** checkoutMounts without blocking the event loop: the same list, read fresh on every call (nothing is cached, so a new .env is covered at once). */
export async function checkoutMountsAsync(dir: string): Promise<Mount[] | null> {
  const r = await execResult('git', IGNORED_ARGS(dir), { timeout: 10_000 });
  if (r.code !== 0 || r.fail) return null;
  return maskedMounts(dir, r.out.split('\0').filter(Boolean));
}
const CONTAINERFILE_DIR = join(import.meta.dirname, '..', 'deploy', 'claude-container');
/**
 * Host tool folders a turn may need, mounted read-only where they exist: Delve's dotnet and Godot, mise and its
 * toolchains (its rust is rustup's, in ~/.cargo/bin and ~/.rustup; the rest of ~/.cargo, the crate cache, stays
 * the person's own), the Chromium Playwright downloads (Mandate's tools/shot.mjs), and Godot's export templates
 * (Delve's tools/windows-build.sh, #290; the rest of ~/.local/share/godot is editor state, the person's own),
 * and the Android SDK (#379).
 */
// .config/mise: mise's global config, which says which version of an approved host tool (#1147) its shims run.
export const TOOL_DIRS = ['.dotnet', '.local/bin', '.local/share/mise', '.config/mise', '.local/godot', '.local/share/godot/export_templates', '.cargo/bin', '.rustup', '.cache/ms-playwright', '.local/share/android-sdk'];
/** The shared Android toolchain tools/android/install-sdk.sh puts on the host (#379): the SDK, mise's JDK 21 and Gradle's defaults. */
export const ANDROID_SDK = '.local/share/android-sdk';
export const ANDROID_JDK = '.local/share/mise/installs/java/temurin-21';
export const GRADLE_PROPS = '.gradle/gradle.properties';

/** What a turn needs to build an Android app, once the host has it: the same paths in a container, mounted read-only. */
export function androidEnv(home: string, path = ''): Record<string, string> {
  const sdk = join(home, ANDROID_SDK);
  const jdk = join(home, ANDROID_JDK);
  if (!existsSync(sdk) || !existsSync(jdk)) return {};
  return { ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk, JAVA_HOME: jdk, PATH: [path, join(jdk, 'bin')].filter(Boolean).join(delimiter) };
}
/**
 * The image's bin folders, first on a container turn's PATH: a tool the image installs wins over a host
 * wrapper in ~/.local/bin that can't run in a container (dot and xvfb-run there start a podman image, #247).
 */
export const IMAGE_PATH = ['/usr/local/bin', '/usr/bin', '/bin'];

/** A container turn's PATH: the image's folders, then the host's others (dotnet, ~/.local/bin) in their order. */
export function containerPath(hostPath = ''): string {
  return [...IMAGE_PATH, ...hostPath.split(delimiter).filter((d) => d && !IMAGE_PATH.includes(d))].join(delimiter);
}

/** imageHash without blocking the event loop: the same hash. */
export async function imageHashAsync(dir: string): Promise<string> {
  const h = createHash('sha256');
  for (const f of ((await readdir(dir, { recursive: true })) as string[]).sort()) {
    const p = join(dir, f);
    if ((await stat(p)).isFile()) h.update(`${f}\0`).update(await readFile(p));
  }
  return h.digest('hex').slice(0, 12);
}

/** A short hash of every file in an image's build folder, by path and contents, so a change to any of them rebuilds it. */
export function imageHash(dir: string): string {
  const h = createHash('sha256');
  for (const f of (readdirSync(dir, { recursive: true }) as string[]).sort()) {
    const p = join(dir, f);
    if (statSync(p).isFile()) h.update(`${f}\0`).update(readFileSync(p));
  }
  return h.digest('hex').slice(0, 12);
}

/** Variables that would win over the container's own sign-in (Claude Code's auth precedence), so a container turn never gets the server's. */
export const AUTH_VARS = ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'];

/** Turn errors that mean the sign-in itself was refused, not a limit or an outage. */
export function isAuthFailure(text: string): boolean {
  return /\b401\b|authentication_error|invalid (x-)?api[ -]key|invalid bearer token|oauth token (has )?(expired|revoked)|token (has )?expired|please run \/login/i.test(text);
}

/** Most Claude accounts one person may link (#779): each is its own config folder, so its own sign-in. */
export const MAX_ACCOUNTS = 3;

/** One of a person's Claude accounts (#779). Account 1 is the one linked before there were several. */
export interface ClaudeAccount {
  n: number;
  email?: string;
  plan?: string;
  linkedAt: number;
  /** Its sign-in failed (a 401 mid-turn): it needs linking again. */
  expired?: number;
  /** It hit a usage limit that resets then; it isn't ready until that passes or a turn on it gets through. */
  limitedUntil?: number;
}

/** A person's accounts in their order, where new work goes (src/account-pick.ts, #793) and the one they pinned. */
export interface AccountSet {
  accounts: ClaudeAccount[];
  /** Next-up: the account new and cold turns went to last, which keeps them until another is clearly better. */
  inUse: number;
  /** Pinned in Settings: new and cold turns run on it while it's ready. */
  pinned?: number;
}

export interface ClaudeMeta {
  container: string;
  /** The volume's folder on the host: the container's home, so the server can restore and save sessions in it. */
  home: string;
  /** Account 1's, kept for rows from before #779. */
  email?: string;
  plan?: string;
  linkedAt: number;
  /** Absent on rows from before #779: then account 1 alone, from the fields above. */
  accounts?: ClaudeAccount[];
  inUse?: number;
  pinned?: number;
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
  /** Their accounts, in order; the server login's account 1 is the host's own login. */
  accounts: (ClaudeAccount & { ready: boolean })[];
  /** The account a new or cold turn runs on now. */
  inUse: number | null;
  /** Why that one (src/account-pick.ts, PickWhy). */
  why?: Pick['why'];
  pinned?: number;
  /** The account a sign-in in progress is for. */
  linking?: number;
}

/** An account's config folder, relative to its home: account 1 keeps the plain one. */
export const accountDir = (n: number) => (n === 1 ? '.claude' : `.claude-${n}`);

export { accountReady };

/**
 * Where a turn runs: the host, or a person's container (with its config folder as the host sees it, and
 * the folder its turns' files go in, the only part of run/turns that container mounts). `account` is which of
 * the person's Claude accounts (#779); a host turn on the server login's extra account has its folder in `env`.
 */
export type TurnPlace = { host: true; account?: number; configDir?: string; env?: Record<string, string> } | { host: false; container: string; configDir: string; home: string; turnsDir: string; env: Record<string, string>; ensure: () => Promise<void>; account?: number };

/** Where the server login's container volume is on the host (#341): it has no Claude link to record it in. */
const containerHomeKey = (uid: number) => `container_home:${uid}`;
/** The server login's accounts (#779): account 1 is the host's own login, the others signed in under the data folder. */
const hostAccountsKey = (uid: number) => `claude_accounts:${uid}`;
/** Where each of a person's sessions last ran and when its last turn ended (#793): `ticket:<id>` or `app:<contraption>:<name>`. */
const warmKey = (uid: number) => `claude_warm:${uid}`;
type WarmRecord = Record<string, { n: number; at: number }>;
/** What a host account folder shares with the host's own: instructions, settings, memory and transcripts. */
const SHARED_CONFIG = ['CLAUDE.md', 'settings.json', 'projects', 'plugins', 'agents', 'skills', 'commands'];

interface Login {
  /** The account it signs in. */
  n: number;
  child: ChildProcess | null;
  out: string;
  url?: string;
  error?: string;
  exited?: Promise<number>;
  /** The person's code went in (code()), which then reads how the sign-in ended. */
  sent?: boolean;
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
  /** How many turns run in a container now. */
  busy: (container: string) => number = () => 0;
  /** Set once the server is shutting down: it has let go of its turns, so busy() reads 0 while they still run. */
  private closing = false;
  /** Starts in flight, per container: two turns starting at once share one. */
  private starting = new Map<string, Promise<void>>();

  private store: Store;
  private credentials: Credentials;
  private dataDir: string;
  private claudeBin: string;
  private containers: Containers;
  /** Names its containers: "citadel-claude-" for the live server, with a tag for a dev copy so the two never share one. */
  readonly prefix: string;
  /** Whether a turn is running in this config folder now (Runner.turnIn): unlinking its account would end it on a 401. */
  turnOn?: (configDir: string) => boolean;

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

  /** The container a person's Taskmasters' turns run in (#1882), on the same volume. */
  taskmasterName(uid: number): string {
    return `${this.name(uid)}-tm`;
  }

  meta(uid: number): ClaudeMeta | null {
    return this.credentials.get<ClaudeMeta>(uid, 'claude_runner')?.meta ?? null;
  }

  serverLogin(uid: number): boolean {
    return !!this.store.getUser(uid)?.server_login;
  }

  /** A person's container home (its volume) as the host sees it: their Claude link's, or the server login's Codex-only one (#341). */
  volumeHome(uid: number): string | null {
    return this.meta(uid)?.home ?? (this.serverLogin(uid) ? (this.store.getSetting<string>(containerHomeKey(uid)) ?? null) : null);
  }

  /** Turns for this person may start: on the host (server login) or in a container that's signed in. */
  linked(uid: number): 'linked' | 'expired' | null {
    const c = this.credentials.get<ClaudeMeta>(uid, 'claude_runner');
    return !c ? null : c.failed ? 'expired' : 'linked';
  }

  /** A person's accounts and the one in use: the server login's from a setting, anyone else's from their link. */
  accounts(uid: number): AccountSet | null {
    if (this.serverLogin(uid)) return this.store.getSetting<AccountSet>(hostAccountsKey(uid)) ?? { accounts: [{ n: 1, linkedAt: 0 }], inUse: 1 };
    const c = this.credentials.get<ClaudeMeta>(uid, 'claude_runner');
    if (!c) return null;
    // A row from before #779 is account 1 alone, expired with the row.
    const accounts = c.meta.accounts ?? [{ n: 1, email: c.meta.email, plan: c.meta.plan, linkedAt: c.meta.linkedAt }];
    return { accounts: c.failed && !c.meta.accounts ? accounts.map((a) => ({ ...a, expired: c.updated_at })) : accounts, inUse: c.meta.inUse ?? accounts[0]?.n ?? 1, ...(c.meta.pinned ? { pinned: c.meta.pinned } : {}) };
  }

  /** Write a person's accounts back. A container person's whose every sign-in failed reads as expired, as one account did. */
  private saveAccounts(uid: number, set: AccountSet) {
    if (this.serverLogin(uid)) return this.store.setSetting(hostAccountsKey(uid), set);
    const meta = this.meta(uid);
    if (!meta) return;
    const first = set.accounts[0];
    // The secret is only the container's name: there is nothing secret here, and never a Claude token.
    this.credentials.put(uid, 'claude_runner', this.name(uid), { ...meta, email: first?.email, plan: first?.plan, accounts: set.accounts, inUse: set.inUse, pinned: set.pinned } satisfies ClaudeMeta);
    if (set.accounts.every((a) => a.expired)) this.credentials.fail(uid, 'claude_runner');
  }

  /** Change a person's accounts in place; returns what the change returned. */
  private withAccounts<T>(uid: number, change: (set: AccountSet) => T): T | null {
    const set = this.accounts(uid);
    if (!set) return null;
    const out = change(set);
    this.saveAccounts(uid, set);
    return out;
  }

  status(uid: number): ClaudeStatus {
    const user = this.store.getUser(uid);
    const host = !!user?.server_login;
    const login = this.logins.get(uid);
    const c = this.credentials.get<ClaudeMeta>(uid, 'claude_runner');
    const set = this.accounts(uid);
    const now = Date.now();
    const pick = set && this.pick(uid, set, undefined, now);
    const base = {
      host,
      ...(c?.meta.email ? { email: c.meta.email } : {}),
      ...(c?.meta.plan ? { plan: c.meta.plan } : {}),
      ...(login?.error ? { error: login.error } : {}),
      accounts: (set?.accounts ?? []).map((a) => ({ ...a, ready: accountReady(a, now) })),
      inUse: pick?.n ?? null,
      ...(pick ? { why: pick.why } : {}),
      ...(set?.pinned ? { pinned: set.pinned } : {}),
      ...(login ? { linking: login.n } : {}),
    };
    if (login && !login.error) return { ...base, state: login.url ? 'waiting for code' : 'starting', ...(login.url ? { url: login.url } : {}) };
    return { ...base, state: host ? 'linked' : !c ? 'not linked' : c.failed ? 'expired' : 'linked' };
  }

  /**
   * The pick for one of `uid`'s turns (src/account-pick.ts): `warm` names its session (`ticket:<id>`, `app:<id>:<name>`)
   * when it has one to resume, so a session whose cache is still warm stays on its account.
   */
  private pick(uid: number, set: AccountSet, warm?: string, now = Date.now()): Pick | null {
    const payer = this.serverLogin(uid) ? null : uid;
    const at = warm ? this.store.getSetting<WarmRecord>(warmKey(uid))?.[warm] : undefined;
    return pickAccount({
      accounts: set.accounts,
      meter: (n) => this.store.getSetting<Meter>(accountUsageKey(payer, n)) ?? null,
      nextUp: set.inUse,
      pinned: set.pinned,
      warm: at && now - at.at < WARM_MS ? at.n : null,
      now,
    });
  }

  /** The account place() would pick for such a turn, moving nothing: 1 for a server login with no accounts of its own, null for none. */
  accountFor(uid: number, warm?: string): number | null {
    const set = this.accounts(uid);
    return (set && this.pick(uid, set, warm)?.n) ?? (this.serverLogin(uid) ? 1 : null);
  }

  /** A turn of session `key` (as place() takes it) ended on account `n`: its cache is warm there for the next WARM_MS. */
  ran(uid: number, key: string, n: number) {
    const now = Date.now();
    const all = Object.entries(this.store.getSetting<WarmRecord>(warmKey(uid)) ?? {}).filter(([k, w]) => k !== key && now - w.at < WARM_MS);
    this.store.setSetting(warmKey(uid), Object.fromEntries([...all, [key, { n, at: now }]]));
  }

  /** Pin account `n` (null: unpin): new and cold turns run on it while it's ready; warm ones move at their next cold moment. */
  use(uid: number, n: number | null) {
    const ok = this.withAccounts(uid, (set) => {
      if (n === null) {
        delete set.pinned;
        return true;
      }
      const a = set.accounts.find((x) => x.n === n);
      if (!a || a.expired) return false;
      set.pinned = n;
      return true;
    });
    if (!ok) throw new Error(n === null ? 'No Claude accounts to unpin.' : `Account ${n} isn't linked, or needs linking again.`);
  }

  /**
   * A turn on account `n` hit its usage limit, which resets at `until`: mark it, and pick again. Returns the account
   * turns move on to, or null when none is ready (every account limited).
   */
  limited(uid: number, n: number, until: number): ClaudeAccount | null {
    return this.withAccounts(uid, (set) => {
      const a = set.accounts.find((x) => x.n === n);
      if (a) a.limitedUntil = until;
      const p = this.pick(uid, set);
      const next = p && set.accounts.find((x) => x.n === p.n);
      if (!p || !next || !accountReady(next)) return null;
      set.inUse = p.nextUp;
      return next;
    });
  }

  /** An account as the chat names it: its email, or the server login's own. */
  private label(uid: number, a: ClaudeAccount): string {
    return a.email ?? (this.serverLogin(uid) && a.n === 1 ? "the server's own login" : `account ${a.n}`);
  }

  /** A person's accounts in order with the one a new or cold turn runs on now, and why (Runner.claudeAccounts); null with none. */
  accountList(uid: number): { inUse: number | null; why?: Pick['why']; pinned?: number; accounts: { n: number; label: string; same?: string }[] } | null {
    const set = this.accounts(uid);
    if (!set) return null;
    const p = this.pick(uid, set);
    // Two folders signed in to one Claude organization share one allowance (#1461): `same` names the first by its label, so the meter says so.
    const orgs = set.accounts.map((a) => this.orgOf(uid, a.n));
    return {
      inUse: p?.n ?? null,
      ...(p ? { why: p.why } : {}),
      ...(set.pinned ? { pinned: set.pinned } : {}),
      accounts: set.accounts.map((a, i) => {
        const twin = orgs[i] ? set.accounts[orgs.indexOf(orgs[i])] : undefined;
        return { n: a.n, label: this.label(uid, a), ...(twin && twin.n !== a.n ? { same: this.label(uid, twin) } : {}) };
      }),
    };
  }

  /** Each folder's Claude organization as last read, by its .claude.json path (orgOf). */
  private orgs = new Map<string, string | null>();

  /**
   * The Claude organization account `n`'s folder is signed in to, from its .claude.json (never the credentials). The
   * organization, not the email: one email can sign in to two organizations, each with its own allowance.
   * The server has one thread (#1463), so it answers from the last read and rereads behind: the note shows a call late.
   */
  private orgOf(uid: number, n: number): string | null {
    // The server login's own account keeps .claude.json beside its folder, unless CLAUDE_CONFIG_DIR moved it in.
    const file = this.serverLogin(uid) && n === 1 && !process.env.CLAUDE_CONFIG_DIR ? join(this.home, '.claude.json') : join(this.configDir(uid, n) ?? '', '.claude.json');
    readFile(file, 'utf8')
      .then(
        (text) => JSON.parse(text).oauthAccount?.organizationUuid ?? null,
        () => null,
      )
      .then(
        (org) => this.orgs.set(file, org),
        () => this.orgs.set(file, null),
      );
    return this.orgs.get(file) ?? null;
  }

  /** limited() for the runner (Runner.onLimit): the account turns move on to, and the first of the accounts to reset. */
  limitedView(uid: number, n: number, until: number): { next: { n: number; label: string } | null; resetAt: number; limits: { n: number; label: string; until: number }[] } | null {
    if (!this.accounts(uid)) return null;
    const next = this.limited(uid, n, until);
    const resets = this.accounts(uid)!
      .accounts.filter((a) => !a.expired)
      .map((a) => a.limitedUntil ?? Date.now());
    const limits = this.accounts(uid)!
      .accounts.filter((a) => !a.expired && a.limitedUntil && a.limitedUntil > Date.now())
      .map((a) => ({ n: a.n, label: this.label(uid, a), until: a.limitedUntil! }));
    return { next: next && { n: next.n, label: this.label(uid, next) }, resetAt: resets.length ? Math.min(...resets) : until, limits };
  }

  /** A turn on account `n` got through: whatever limit it had is gone. */
  cleared(uid: number, n: number) {
    if (!this.accounts(uid)?.accounts.some((a) => a.n === n && a.limitedUntil)) return;
    this.withAccounts(uid, (set) => {
      for (const a of set.accounts) if (a.n === n) delete a.limitedUntil;
    });
  }

  /** An account's config folder as the host sees it; the server login's account 1 is the host's own. */
  configDir(uid: number, n: number): string | null {
    if (this.serverLogin(uid)) return n === 1 ? claudeConfigDir(process.env) : join(this.dataDir, 'claude-accounts', String(uid), String(n));
    const home = this.meta(uid)?.home ?? null;
    return home && join(home, accountDir(n));
  }

  /** Every linked account's config folder, as this server sees it (an app turn's session may sit in another account's after a switch, #785). */
  configDirs(uid: number): string[] {
    return (this.accounts(uid)?.accounts ?? []).flatMap((a) => this.configDir(uid, a.n) ?? []);
  }

  /** The image tag for the current Containerfile and the files it copies in (codex/). */
  private image(): string {
    return `${IMAGE_REPO}:${imageHash(CONTAINERFILE_DIR)}`;
  }

  /**
   * The folder a person's container turns keep their files in (prompt, settings, spec.json with the turn's
   * tokens): their own, inside run/turns, which holds the host's turns and so is never mounted whole (#241).
   */
  turnsDir(uid: number): string {
    return join(this.dataDir, 'run', 'turns', `person-${uid}`);
  }

  /** What a person's container is made of. An async caller passes `pre` (read with checkoutMountsAsync / imageHashAsync): without it the spec spawns git and walks the image folder on the main thread.  Every mount sits at its host path, so worktrees, session folders and prompts match. */
  spec(uid: number, pre?: { checkout?: Mount[] | null; image?: string }, taskmaster = false): ContainerSpec {
    const mounts: Mount[] = [
      { src: this.name(uid), dst: this.home, volume: true },
      { src: join(this.dataDir, 'projects'), dst: join(this.dataDir, 'projects') },
      { src: this.turnsDir(uid), dst: this.turnsDir(uid) },
      { src: dirname(resolveClaude(this.claudeBin)), dst: dirname(resolveClaude(this.claudeBin)), ro: true },
    ];
    // Codex's hook and requirements from the code this server runs, over the image's copy: a container that runs for days
    // (a busy one is never replaced) still gets the deployed hook, not the one it was built with (#748). A folder, not a file:
    // a deploy replaces the file's inode, which a file mount would keep showing the old one of.
    mounts.push({ src: join(CONTAINERFILE_DIR, 'codex'), dst: '/etc/codex', ro: true });
    for (const d of TOOL_DIRS) if (existsSync(join(this.home, d))) mounts.push({ src: join(this.home, d), dst: join(this.home, d), ro: true });
    // The code this server runs, read-only, so a member's turn checks the live checkout as a host turn does (#621). A dev
    // copy runs from a worktree, already mounted writable under projects/.
    if (!LIVE_CHECKOUT.startsWith(join(this.dataDir, 'projects') + '/')) mounts.push(...((pre && 'checkout' in pre ? pre.checkout : checkoutMounts(LIVE_CHECKOUT)) ?? []));
    // The contraptions' folders, read-only, for a Citadel member or admin: their Citadel Taskmaster turns read every scheme (#656).
    const user = this.store.getUser(uid);
    // Their parent folders: a folder is a link into its two slots beside it (#801), which a mount of the link would pin at
    // the slot live when the container started.
    if (this.store.isAdmin(user)) {
      // shortcut: a folder set right in home (none is) mounts its link pinned at start, not home with its keys; mount per slot if one is.
      const dirs = this.store.listContraptions().flatMap((c) => {
        const f = appFolder(c, this.home);
        return dirname(f) === this.home ? [f, slotsOf(f)] : [dirname(f)];
      });
      for (const dir of new Set(dirs)) {
        if (existsSync(dir)) mounts.push({ src: dir, dst: dir, ro: true });
      }
    }
    // Each scheme's Claude Code memory, shared with the host's turns: the server's copy, at the path claude looks in.
    for (const p of this.store.listProjects()) {
      if (!p.repo_dir) continue;
      const slug = projectSlug(p.repo_dir);
      const src = join(claudeConfigDir(process.env), 'projects', slug, 'memory');
      mkdirSync(src, { recursive: true });
      // In every account's folder (#779), linked or not, so linking another never changes the spec under running turns.
      for (let n = 1; n <= MAX_ACCOUNTS; n++) mounts.push({ src, dst: join(this.home, accountDir(n), 'projects', slug, 'memory') });
    }
    const home = this.meta(uid)?.home;
    // Only a sign-in's start chowns a volume (link()), and not while Taskmaster turns write in it: a file that goes mid-walk fails it.
    const made = { image: pre?.image ?? this.image(), mounts, env: { HOME: this.home }, chown: !taskmaster && (!home || (this.logins.has(uid) && !this.busy(this.taskmasterName(uid)))) };
    if (!taskmaster) return { ...made, name: this.name(uid), memory: CONTAINER_MEMORY };
    // Claude Code lists its running sessions by pid, and the two containers count pids apart: one list each.
    if (home) for (let n = 1; n <= MAX_ACCOUNTS; n++) mounts.push({ src: join(home, accountDir(n), 'sessions-taskmaster'), dst: join(this.home, accountDir(n), 'sessions') });
    return { ...made, name: this.taskmasterName(uid), memory: TASKMASTER_MEMORY, slice: TASKMASTER_SLICE, props: ['ManagedOOMPreference=omit'] };
  }

  /** Build the image if needed, make the volume and start the container (or keep it, if it runs from this spec or turns run in it). */
  ensure(uid: number, forTurn = false, taskmaster = false): Promise<void> {
    const name = taskmaster ? this.taskmasterName(uid) : this.name(uid);
    const now = this.starting.get(name);
    if (now) return now;
    // A sign-in's start chowns the volume: no Taskmaster turn starts writing in it meanwhile (spec()).
    const chowning = taskmaster && this.logins.has(uid) ? this.starting.get(this.name(uid)) : undefined;
    const run = (chowning ? chowning.catch(() => {}).then(() => this.start(uid, forTurn, taskmaster)) : this.start(uid, forTurn, taskmaster)).finally(() => this.starting.delete(name));
    this.starting.set(name, run);
    return run;
  }

  private async start(uid: number, forTurn: boolean, taskmaster: boolean): Promise<void> {
    // The two slow reads of a spec (git's ignored list, the image folder walk) run off the main thread, fresh every start.
    const [checkout, image] = await Promise.all([LIVE_CHECKOUT.startsWith(join(this.dataDir, 'projects') + '/') ? Promise.resolve(null) : checkoutMountsAsync(LIVE_CHECKOUT), imageHashAsync(CONTAINERFILE_DIR).then((h) => `${IMAGE_REPO}:${h}`)]);
    const spec = this.spec(uid, { checkout, image }, taskmaster);
    const volume = this.name(uid);
    await this.containers.ensureImage(spec.image, CONTAINERFILE_DIR);
    await this.containers.createVolume(volume);
    // A bind mount's folder must exist: a fresh server has no run/turns until its first turn.
    for (const m of spec.mounts) if (!m.volume && !m.ro) mkdirSync(m.src, { recursive: true });
    // Mounts inside HOME need their folders made in the volume first, as the person: podman makes missing
    // ones as root, and a root-owned ~/.claude left Claude unable to save the sign-in.
    const vol = await this.containers.volumePath(volume);
    if (vol && this.serverLogin(uid)) this.store.setSetting(containerHomeKey(uid), vol);
    for (const m of spec.mounts) if (vol && !m.volume && m.dst.startsWith(this.home + '/')) mkdirSync(join(vol, relative(this.home, m.dst)), { recursive: true });
    // Gradle's defaults (no daemon idling on 1 GB): the person's ~/.gradle is their own, so it gets the host's copy.
    if (vol && existsSync(join(this.home, GRADLE_PROPS))) {
      mkdirSync(join(vol, dirname(GRADLE_PROPS)), { recursive: true });
      copyFileSync(join(this.home, GRADLE_PROPS), join(vol, GRADLE_PROPS));
    }
    // The shared Gradle build cache's init script (#1153): on only in a turn, which names the cache.
    if (vol) {
      try {
        ensureGradleInit(vol);
      } catch (e) {
        console.warn(`gradle init script for ${vol}: ${(e as Error).message}`);
      }
    }
    const now = await this.containers.status(spec.name);
    // shortcut: a changed spec (new image, a new scheme's memory) waits until no other turn runs in the container; a busy one keeps its old mounts meanwhile.
    // A starting turn already counts as one of the container's turns.
    // A server shutting down never replaces one: its busy() no longer sees the turns it let go of (2026-11-05: a
    // turn starting during a deploy's restart replaced a stale-spec container and killed the ~20 turns in it).
    if (now.state === 'running' && (this.closing || now.spec === specHash(spec) || this.busy(spec.name) > (forTurn ? 1 : 0))) return;
    await this.containers.start(spec);
    void this.containers.pruneImages(IMAGE_REPO, spec.image);
  }

  /** The server is shutting down: from now on, running containers are left as they are. */
  close() {
    this.closing = true;
  }

  /**
   * Where a turn for `uid` runs, or null when it can't run (not linked, signed out). `warm` names the session it resumes,
   * if any (pick()): a fresh one, or one with no session yet, goes where new work goes. A Taskmaster's goes in a container apart.
   */
  place(uid: number | null, warm?: string, taskmaster = false): TurnPlace | null {
    const user = uid ? this.store.getUser(uid) : undefined;
    if (!user) return null;
    const set = this.accounts(user.id);
    const p = set && this.pick(user.id, set, warm);
    if (set && p && p.nextUp !== set.inUse) this.withAccounts(user.id, (s) => void (s.inUse = p.nextUp));
    const n = p?.n;
    if (user.server_login) {
      if (!n || n === 1) return { host: true };
      const configDir = this.configDir(user.id, n)!;
      return { host: true, account: n, configDir, env: { CLAUDE_CONFIG_DIR: configDir } };
    }
    const c = this.credentials.get<ClaudeMeta>(user.id, 'claude_runner');
    if (!c || c.failed || !n) return null;
    return {
      host: false,
      container: taskmaster ? this.taskmasterName(user.id) : c.meta.container,
      configDir: join(c.meta.home, accountDir(n)),
      home: c.meta.home,
      turnsDir: this.turnsDir(user.id),
      env: this.containerEnv(n),
      ensure: () => this.ensure(user.id, true, taskmaster),
      account: n,
    };
  }

  /**
   * Where the server login's Codex turns run (#341): its own container, though its Claude turns stay on the
   * host. Its configDir is the host's, where its Claude sessions are (the hand-over and the session save read
   * it). Null for anyone else, or before the container exists (its Codex sign-in makes it).
   */
  codexPlace(uid: number): Extract<TurnPlace, { host: false }> | null {
    const home = this.serverLogin(uid) ? this.volumeHome(uid) : null;
    if (!home) return null;
    return { host: false, container: this.name(uid), configDir: claudeConfigDir(process.env), home, turnsDir: this.turnsDir(uid), env: this.containerEnv(), ensure: () => this.ensure(uid, true) };
  }

  /**
   * Start the server login's Codex container if it isn't running (#398): its host turns' Codex reviews run
   * there. Never replaces a running one, stale or not, since a review may be running in it that busy() can't see.
   */
  async wakeCodex(uid: number): Promise<void> {
    if (!this.codexPlace(uid) || this.starting.has(this.name(uid))) return;
    if ((await this.containers.status(this.name(uid))).state !== 'running') await this.ensure(uid);
  }

  private containerEnv(n = 1): Record<string, string> {
    return { HOME: this.home, PATH: containerPath(process.env.PATH), CLAUDE_CONFIG_DIR: join(this.home, accountDir(n)), DISABLE_AUTOUPDATER: '1' };
  }

  /**
   * Account `n`'s sign-in went bad mid-turn: say so until they link it again, and move turns on to another.
   * The person reads as expired (their messages wait) only once every account has.
   */
  expire(uid: number, n = 1) {
    this.withAccounts(uid, (set) => {
      for (const a of set.accounts) if (a.n === n) a.expired = Date.now();
    });
  }

  /** The lowest account number free for a new link, or null at MAX_ACCOUNTS. */
  private freeAccount(uid: number): number | null {
    const taken = new Set(this.accounts(uid)?.accounts.map((a) => a.n) ?? []);
    for (let n = 1; n <= MAX_ACCOUNTS; n++) if (!taken.has(n)) return n;
    return null;
  }

  /**
   * A server login's extra account folder, made the first time, with the host folder's instructions, settings,
   * memory and transcripts linked in, so its turns read what account 1's do. The sign-in itself stays its own.
   */
  private hostFolder(uid: number, n: number): string {
    const dir = this.configDir(uid, n)!;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const main = claudeConfigDir(process.env);
    for (const f of SHARED_CONFIG) if (existsSync(join(main, f)) && !existsSync(join(dir, f))) symlinkSync(join(main, f), join(dir, f));
    return dir;
  }

  /** The environment a command for account `n` runs with: the server's, minus any login that would win over the folder's own. */
  private hostEnv(dir: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CONFIG_DIR: dir };
    for (const v of AUTH_VARS) delete env[v];
    return env;
  }

  /** Run claude's `args` for account `n`: in the person's container, or on the host for the server login's extras. */
  private claudeCmd(uid: number, n: number, args: string[]): Promise<CmdResult> {
    if (this.serverLogin(uid)) {
      const env = this.hostEnv(this.hostFolder(uid, n));
      return execResult(resolveClaude(this.claudeBin), args, { env, timeout: 30_000 }).then((r) => ({ code: r.code, stdout: r.out, stderr: r.err || r.fail }));
    }
    return this.containers.exec(this.name(uid), [resolveClaude(this.claudeBin), ...args], { env: { CLAUDE_CONFIG_DIR: join(this.home, accountDir(n)) }, timeout: 30_000 });
  }

  /**
   * The account a sign-in is for: `account` to sign one in again (expired, say), or with none, the lowest free number
   * for another. Throws what's wrong, before link() starts anything.
   */
  linkSlot(uid: number, account?: number): number {
    const n = account ?? this.freeAccount(uid);
    if (account !== undefined && !(Number.isInteger(account) && account >= 1 && account <= MAX_ACCOUNTS)) throw new Error(`Accounts are numbered 1 to ${MAX_ACCOUNTS}.`);
    if (!n) throw new Error(`${MAX_ACCOUNTS} Claude accounts at most: unlink one first.`);
    if (this.serverLogin(uid) && n === 1) throw new Error("Account 1 is the server's own login: sign it in on the server itself.");
    return n;
  }

  /**
   * Start linking account `account` (linkSlot's): the container, then `claude auth login` under a pty (script)
   * inside it, or for the server login on the host in the account's own folder, over plain pipes. Resolves once
   * Anthropic's link is out (or it failed); the code comes later, in code().
   */
  async link(uid: number, account?: number): Promise<ClaudeStatus> {
    const host = this.serverLogin(uid);
    const n = this.linkSlot(uid, account);
    const old = this.logins.get(uid);
    if (old?.child && !old.error) old.child.kill();
    const login: Login = { n, child: null, out: '' };
    this.logins.set(uid, login);
    try {
      if (!host) {
        // A sign-in starts in a fresh container: the restart's :U chown also mends a volume an older start left root-owned folders in.
        if (!this.busy(this.name(uid))) await this.containers.stop(this.name(uid));
        await this.ensure(uid);
      }
      // Started again (or unlinked) while the container was starting: that call owns the sign-in now.
      if (this.logins.get(uid) !== login) return this.status(uid);
      const claude = resolveClaude(this.claudeBin);
      const script = ['script', '-qfec', `stty cols 4000; ${claude} auth login --claudeai`, '/dev/null'];
      const child = host ? spawn(script[0], script.slice(1), { stdio: ['pipe', 'pipe', 'pipe'], env: this.hostEnv(this.hostFolder(uid, n)) }) : spawn('podman', ['exec', '-i', '-e', `CLAUDE_CONFIG_DIR=${join(this.home, accountDir(n))}`, this.name(uid), ...script], { stdio: ['pipe', 'pipe', 'pipe'] });
      login.child = child;
      login.exited = new Promise((r) => child.on('exit', (code) => r(code ?? 1)));
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          login.error = "The sign-in didn't show a link within 60 seconds.";
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
          // The 60-second error stays: the kill after it is what ended the sign-in.
          if (!login.url && !login.error) login.error = `The sign-in ended (code ${code}) before showing a link: ${lastLines(login.out)}`;
          // Ended while waiting for the code: the link is dead, so don't keep offering it.
          else if (login.url && !login.sent && !login.error) login.error = `The sign-in ended (code ${code}) before the code was pasted: start linking again. ${lastLines(login.out)}`;
          clearTimeout(timer);
          resolve();
        });
      });
    } catch (err) {
      login.error = thrown(err).message;
    }
    return this.status(uid);
  }

  /** Pass the pasted code to the waiting sign-in, wait for it to finish, and record who signed in. */
  async code(uid: number, code: string): Promise<ClaudeStatus> {
    const login = this.logins.get(uid);
    if (!login?.child || !login.url || !login.exited) throw new Error('No sign-in is waiting for a code: start linking again.');
    login.child.stdin!.on('error', () => {}); // the sign-in may already have ended
    login.sent = true;
    login.child.stdin!.write(`${code}\r`);
    const exit = await Promise.race([login.exited, new Promise<null>((r) => setTimeout(() => r(null), 60_000))]);
    if (exit === null) login.child.kill();
    const who = await this.whoami(uid, login.n);
    if (!who.loggedIn) {
      const said = signInOutcome(login.out, code);
      login.error = `The sign-in didn't take (${exit === null ? 'no answer within a minute' : `exit ${exit}`}): ${said}${exit === 0 ? ` Then \`claude auth status\` said: ${who.said}` : ''}`;
      // File names and owners only: what the sign-in left in the Claude folder, for the server log.
      const files = this.serverLogin(uid) ? { stdout: '', stderr: '' } : await this.containers.exec(this.name(uid), ['sh', '-c', 'id; ls -la "$CLAUDE_CONFIG_DIR"'], { env: { CLAUDE_CONFIG_DIR: join(this.home, accountDir(login.n)) }, timeout: 30_000 });
      console.warn(`claude-link: sign-in for user ${uid} didn't take (exit ${exit}): ${said} | auth status: ${who.raw} | ${files.stdout}${files.stderr}`);
      login.child = null;
      return this.status(uid);
    }
    const account: ClaudeAccount = { n: login.n, email: who.email, plan: who.plan, linkedAt: Date.now() };
    const set = this.accounts(uid);
    if (set) {
      // Another account, or one signing in again: in its place in the order, the rest kept.
      const at = set.accounts.findIndex((a) => a.n === login.n);
      if (at >= 0) set.accounts[at] = account;
      else set.accounts.push(account);
      set.accounts.sort((a, b) => a.n - b.n);
      this.saveAccounts(uid, set);
    } else {
      const home = await this.containers.volumePath(this.name(uid));
      if (!home) throw new Error(`The volume ${this.name(uid)} is gone.`);
      // The secret is only the container's name: there is nothing secret here, and never a Claude token.
      this.credentials.put(uid, 'claude_runner', this.name(uid), { container: this.name(uid), home, email: who.email, plan: who.plan, linkedAt: account.linkedAt, accounts: [account], inUse: login.n } satisfies ClaudeMeta);
    }
    this.logins.delete(uid);
    return this.status(uid);
  }

  /** Stop a sign-in in progress without linking. */
  cancel(uid: number) {
    this.logins.get(uid)?.child?.kill();
    this.logins.delete(uid);
  }

  /**
   * Cancel on account `n`'s sign-in. With none in memory (lost in a restart, or finished on another device) nothing is
   * removed, nor is an account already linked; a first account's sign-in still clears the container and volume it started.
   */
  async cancelSignIn(uid: number, n?: number): Promise<void> {
    const login = this.logins.get(uid);
    if (!login || (n !== undefined && login.n !== n)) return;
    if (this.accounts(uid)) return this.cancel(uid);
    await this.unlink(uid);
  }

  /**
   * Unlink account `n`: sign it out and remove its folder. With no `n`, or the last account, sign out inside the
   * container, stop it, and remove the volume with everything in it.
   */
  async unlink(uid: number, n?: number): Promise<void> {
    const set = this.accounts(uid);
    // A sign-in again ("Link again") is in progress: only that stops; the account it was for stays linked.
    if (n !== undefined && this.logins.get(uid)?.n === n && set?.accounts.some((a) => a.n === n)) return this.cancel(uid);
    // The server login has no container of Claude's to remove: its Codex one lives in that volume.
    if (this.serverLogin(uid) && n === undefined) return this.cancel(uid);
    if (n !== undefined && (this.serverLogin(uid) || (set && set.accounts.some((a) => a.n !== n)))) return this.unlinkOne(uid, n);
    // shortcut: a sign-in abandoned across a restart leaves its small volume behind until they link and unlink again.
    const started = this.logins.has(uid) || !!this.meta(uid);
    const name = this.name(uid);
    if (this.busy(name) || this.busy(this.taskmasterName(uid))) throw new Error('Turns are running on your Claude now: stop them first, then unlink.');
    this.cancel(uid);
    if (!started) return;
    if ((await this.containers.status(name)).state === 'running') {
      for (const a of set?.accounts ?? [{ n: 1 }]) await this.claudeCmd(uid, a.n, ['auth', 'logout']);
    }
    await this.containers.stop(this.taskmasterName(uid));
    await this.containers.stop(name);
    await this.containers.removeVolume(name);
    this.credentials.remove(uid, 'claude_runner');
    // Every account's meter goes too, or the next account linked would show the old one's limit (#1270 C4).
    for (let n = 1; n <= MAX_ACCOUNTS; n++) this.store.deleteSetting(accountUsageKey(uid, n));
  }

  /** Sign out one of several accounts and remove its folder; the others, and the container, stay. */
  private async unlinkOne(uid: number, n: number): Promise<void> {
    if (this.serverLogin(uid) && n === 1) throw new Error("Account 1 is the server's own login: it can't be unlinked here.");
    const set = this.accounts(uid);
    if (!set?.accounts.some((a) => a.n === n)) {
      if (this.logins.get(uid)?.n === n) this.cancel(uid);
      return;
    }
    const dir = this.configDir(uid, n);
    // Its turns would lose their sign-in mid-turn; the other accounts' carry on.
    // shortcut: an app's (contraption's) turn on it isn't seen here; it would end on a 401, which expires nothing more.
    if (dir && this.turnOn?.(dir)) throw new Error('A turn is running on this account now: stop it or let it end, then unlink.');
    const running = this.serverLogin(uid) || (await this.containers.status(this.name(uid))).state === 'running';
    if (running) await this.claudeCmd(uid, n, ['auth', 'logout']);
    // The sign-in goes from the host side too, whether or not logout ran: account 1's folder also holds the container's
    // other Claude files, so only its login goes; another account's whole folder does.
    if (dir) rmSync(n === 1 ? join(dir, '.credentials.json') : dir, { recursive: true, force: true });
    // Its meters would show on the next account linked in its place.
    this.store.deleteSetting(accountUsageKey(this.serverLogin(uid) ? null : uid, n));
    this.withAccounts(uid, (s) => {
      s.accounts = s.accounts.filter((a) => a.n !== n);
      if (s.inUse === n) s.inUse = s.accounts[0]?.n ?? 1;
      if (s.pinned === n) delete s.pinned;
    });
  }

  /** `claude auth status` in the container: signed in or not, and as whom. */
  private async whoami(uid: number, n: number): Promise<{ loggedIn: boolean; email?: string; plan?: string; said: string; raw: string }> {
    const r = await this.claudeCmd(uid, n, ['auth', 'status']);
    const raw = `${r.stdout}\n${r.stderr}`;
    const said = lastLines(raw);
    try {
      // The JSON may follow a warning line.
      const s = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
      return { loggedIn: !!s.loggedIn, email: s.email ?? s.account?.email, plan: s.subscriptionType ?? s.plan, said, raw };
    } catch {
      return { loggedIn: false, said, raw };
    }
  }
}

export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)|\r/g, '');
}

/** Anthropic's sign-in link in the sign-in's output (on one line: the pty is 4000 columns wide). */
export function signInUrl(out: string): string | null {
  return /https:\/\/\S*oauth\S*/.exec(out)?.[0] ?? null;
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

/** What the sign-in said after the link: its last lines, without the long link and with the pasted code masked. */
export function signInOutcome(out: string, code: string): string {
  return lastLines(
    out
      .split(code)
      .join('[code]')
      .split('\n')
      .filter((l) => !/https:\/\/|Opening browser/.test(l))
      .join('\n'),
  );
}
