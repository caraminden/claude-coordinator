// An Android APK built and published after each deploy (#837; TWIReader's ask, Cara 2026-11-16: "Work with citadel to make
// this citadel wide"). Every land on main deploys its scheme's contraptions (#712), so once a Capacitor app's deploy goes
// live, Citadel checks whether what goes into its APK (android/, capacitor.config.*, the Capacitor webDir) changed since the
// published one. When it did, it builds a release APK on perigee in a checkout of its own beside the live one, numbers it by
// the commit count (versionCode only goes up while main isn't rewritten), signs it with the app's release key in
// ~/.config/citadel-android (the citadel:android-app skill), and publishes it and latest.json into the app's DATA_DIR/android/,
// where its open route serves them to the update banner. An app whose APKs a release workflow signs on CI (Mandate) keeps that
// path (src/apk-release.ts): this skips it. Nothing here touches the live slot, so a failed build changes nothing that runs.
import { execResult, runLogged } from './exec.ts';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cp, lstat, mkdir, readdir, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { androidEnv } from './claude-link.ts';
import { apksigner, install, OldApk, OtherKey, signers } from './apk-release.ts';
import type { ContraptionRow } from './db.ts';
import { hasKey, keyFiles, makeReleaseKey, type Keytool } from './release-key.ts';
import { gradleVersion } from './release-readers.ts';

/** The whole build, the wait for a heavy slot included: past it the build is stopped and told. */
const BUILD_MS = 90 * 60_000;
/** Published APKs kept beside the newest, so a phone that read latest.json a moment ago still finds its file. */
const KEEP_APKS = 3;
/** Sets every variant's versionCode from -Pcitadel.versionCode (AGP ignores android.injected.version.code outside the IDE). */
const VERSION_INIT = join(import.meta.dirname, 'apk-version.init.gradle');

/** A Capacitor app at the checkout's root: its Android project and its Capacitor webDir (null when the config doesn't say). */
export async function capacitorApp(dir: string): Promise<{ webDir: string | null } | null> {
  if (!existsSync(join(dir, 'android/app/build.gradle')) && !existsSync(join(dir, 'android/app/build.gradle.kts'))) return null;
  if (existsSync(join(dir, 'capacitor.config.json'))) {
    try {
      const c = JSON.parse(await readFile(join(dir, 'capacitor.config.json'), 'utf8'));
      return { webDir: typeof c?.webDir === 'string' ? c.webDir : null };
    } catch {
      return { webDir: null };
    }
  }
  if (existsSync(join(dir, 'capacitor.config.ts'))) {
    const m = /webDir\s*:\s*['"]([^'"]+)['"]/.exec(await readFile(join(dir, 'capacitor.config.ts'), 'utf8'));
    return { webDir: m?.[1] ?? null };
  }
  return null;
}

/** The paths whose changes go into the APK: a change anywhere else (the server, the web app it loads) needs none. */
export function apkPaths(webDir: string | null): string[] {
  const own = webDir && !webDir.startsWith('/') && !webDir.split('/').includes('..') ? [webDir.replace(/\/+$/, '')] : [];
  return ['android', 'capacitor.config.json', 'capacitor.config.ts', ...own];
}

/** Lines naming a release manifest's risky flags (citadel:android-app, "Before signing a Capacitor shell"): told, not refused. */
export function manifestWarnings(xml: string): string[] {
  return ['allowBackup', 'usesCleartextTraffic', 'debuggable'].filter((a) => new RegExp(`android:${a}="true"`).test(xml)).map((a) => `its release manifest sets android:${a}="true"`);
}

/** Runs a command, its output into `log`: its exit code, 124 when it ran out of time. */
export type Runner = (argv: string[], cwd: string, env: NodeJS.ProcessEnv, log: string, ms: number) => Promise<number>;

export interface ApkBuildDeps {
  home: string;
  /** The app's folder, a link to its live slot (src/app-services.ts). */
  folder: (row: ContraptionRow) => string;
  /** Its DATA_DIR: the feed goes in android/ there. */
  dataDir: (row: ContraptionRow) => string;
  /** Where each app's build checkout and log live (~/.cache/citadel-apk). */
  cacheDir: string;
  /** Where release keys live: <app>-release.jks and <app>-release.pass. */
  keyDir: string;
  /** tools/citadel-heavy: the Gradle build takes a host-wide slot, as a minion's does. */
  heavy: string;
  /** Whether a release workflow signs this app's APKs on CI (src/apk-release.ts): then this leaves it alone. */
  ciRelease: (row: ContraptionRow) => boolean;
  /** Build `code` of `row` from `commit` went out, started by `by`. */
  published: (row: ContraptionRow, code: number, commit: string, by: string) => void;
  /** Tell the app's home Taskmaster something it has to act on. */
  tell: (row: ContraptionRow, text: string) => void;
  run?: Runner;
  certs?: (apk: string) => Promise<string[]>;
  keytool?: Keytool;
}

/** What one check came to, for the log and the tests. */
export type Outcome = { built: number } | { skipped: string } | { failed: string };

export class ApkBuilds {
  private d: ApkBuildDeps;
  /** Apps building now, and what to check again once that ends (a deploy that went live meanwhile). */
  private busy = new Map<string, { again: ContraptionRow | null; by: string }>();
  constructor(d: ApkBuildDeps) {
    this.d = d;
  }

  /** Check `row` once its deploy is live (or at startup), building if its APK is behind. One build per app at a time. */
  schedule(row: ContraptionRow, by: string): Promise<void> {
    const b = this.busy.get(row.name);
    if (b) {
      b.again = row;
      b.by = by;
      return Promise.resolve();
    }
    const state = { again: null as ContraptionRow | null, by };
    this.busy.set(row.name, state);
    return (async () => {
      try {
        let next: ContraptionRow | null = row;
        while (next) {
          const r = next;
          next = null;
          state.again = null;
          const out = await this.check(r, state.by).catch((err): Outcome => ({ failed: err?.message ?? String(err) }));
          if ('failed' in out) console.error(`${r.name}'s APK build failed: ${out.failed}`);
          next = state.again;
        }
      } finally {
        this.busy.delete(row.name);
      }
    })();
  }

  get keyDir() {
    return this.d.keyDir;
  }

  /** Whether `name` is a Capacitor app whose last check found no release key: the Releases page offers to make it. */
  keyless(name: string): boolean {
    return existsSync(join(this.d.cacheDir, name, 'key-missing-told')) && !hasKey(this.d.keyDir, name);
  }

  /**
   * Make `row`'s release key (src/release-key.ts; throws when it has one) and build its APK at once: the commit the
   * missing key failed at is forgotten. The make_release_key card's Approve and the Releases page's button both come here.
   * Resolves once the key is made, to the build it started.
   */
  async makeKey(row: ContraptionRow, by: string): Promise<{ building: Promise<void> }> {
    await makeReleaseKey(this.d.keyDir, row.name, { home: this.d.home, keytool: this.d.keytool });
    for (const f of ['key-missing-told', 'failed-at']) rmSync(join(this.d.cacheDir, row.name, f), { force: true });
    return { building: this.schedule(row, by) };
  }

  /** Whether `row`'s APK is behind its live commit, and if so build and publish it. */
  async check(row: ContraptionRow, by: string): Promise<Outcome> {
    if (this.d.ciRelease(row)) return { skipped: 'a release workflow signs its APKs' };
    const live = await realpath(this.d.folder(row)).catch(() => null);
    if (!live) return { skipped: 'not deployed' };
    const cap = await capacitorApp(live);
    if (!cap) return { skipped: 'not a Capacitor app' };
    const git = (cwd: string, ...args: string[]) => execResult('git', args, { cwd, timeout: 120_000 }).then((r) => ({ code: r.code, out: r.out.trim() }));
    const commit = (await git(live, 'rev-parse', 'HEAD')).out;
    if (!/^[0-9a-f]{40}$/.test(commit)) return { failed: `couldn't read ${live}'s commit` };
    const feedFile = join(this.d.dataDir(row), 'android', 'latest.json');
    const feed = JSON.parse(await readFile(feedFile, 'utf8').catch(() => 'null')) as { versionCode?: unknown; commit?: unknown } | null;
    const current = Number.isInteger(feed?.versionCode) ? (feed!.versionCode as number) : 0;
    if (feed?.commit === commit) return { skipped: 'published at this commit' };
    // A webDir the deploy builds (gitignored dist/) isn't in git: any commit may change it, and the build copies the live one.
    const web: string | undefined = apkPaths(cap.webDir)[3]; // the webDir, when it's a path inside the repo
    const built = web && !(await git(live, 'ls-files', '--', web)).out ? web : null;
    if (typeof feed?.commit === 'string' && /^[0-9a-f]{40}$/.test(feed.commit)) {
      // 0: nothing that goes into the APK changed; 1: something did; anything else (a commit it doesn't have): build.
      if ((await git(live, 'diff', '--quiet', feed.commit, commit, '--', ...(built ? [] : apkPaths(cap.webDir)))).code === 0) return { skipped: 'nothing in its APK changed' };
    }
    const dir = join(this.d.cacheDir, row.name);
    // The commit its build last failed or was refused at, kept on disk so a restart doesn't tell it again.
    const failedAt = join(dir, 'failed-at');
    if ((() => { try { return readFileSync(failedAt, 'utf8').trim(); } catch { return ''; } })() === commit) return { skipped: 'already failed at this commit' };
    const fail = (why: string, end?: string): Outcome => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(failedAt, commit);
      this.d.tell(row, `${row.title}'s Android build at ${commit.slice(0, 9)} wasn't published: ${why}${end ? `\n\nThe end of its build log (${join(this.d.cacheDir, row.name, 'build.log')}):\n${end}` : ''}\n\nIt's tried again once a deploy carries a newer commit.`);
      return { failed: why };
    };
    const { jks: key, pass } = keyFiles(this.d.keyDir, row.name);
    // A missing key is told once, not per commit (a night of deploys woke the Taskmaster ten times): the marker stays until a check finds the key.
    const keyTold = join(dir, 'key-missing-told');
    const there = [key, pass].filter((f) => existsSync(f));
    if (there.length === 2) rmSync(keyTold, { force: true });
    else {
      if (existsSync(keyTold)) return { skipped: 'no release key yet, already told' };
      // Half a pair is a key that was lost, not one never made: restore it, never make a new one (phones would have to uninstall).
      const out = fail(there.length
        ? `half of its release key is missing: ${there[0]} is there but ${there[0] === key ? pass : key} isn't. Restore it from the desktop's CitadelBackups\\keys (deploy/desktop/README.md, "Restoring"); a new key is never made over half of one. Until then no APK is built after its deploys.`
        : `it has no release key yet (${key} and its .pass). A member makes it with Make release key on its Releases card, or approves the card make_release_key posts; until then no APK is built after its deploys.`);
      writeFileSync(keyTold, commit);
      return out;
    }
    const code = Number((await git(live, 'rev-list', '--count', commit)).out);
    if (!Number.isInteger(code) || code < 1) return fail(`couldn't count ${commit.slice(0, 9)}'s commits`);
    if (code <= current) return fail(`its versionCode is its commit count, ${code}, and the published APK is build ${current} already. Phones only update to a higher one: publish one from a release workflow instead, or bump past it.`);

    const src = join(dir, 'src');
    const log = join(dir, 'build.log');
    await mkdir(dir, { recursive: true });
    await writeFile(log, `== ${row.name} build ${code} at ${commit} (${new Date().toISOString()})\n`);
    const tail = async () => (await readFile(log, 'utf8').catch(() => '')).trimEnd().split('\n').slice(-30).join('\n');
    // A checkout of its own at the live commit: the live slot never sees the build's files or cap sync's rewrites.
    if ((await git(src, 'checkout', '--force', '--quiet', '--detach', commit)).code !== 0) {
      await rm(src, { recursive: true, force: true });
      await git(live, 'worktree', 'prune');
      const added = await git(live, 'worktree', 'add', '--force', '--detach', src, commit);
      if (added.code !== 0) return fail(`couldn't make a build checkout at ${src}`);
    }
    // Its packages are the live slot's, which the deploy's build steps installed (npm ci): Capacitor's Android code is in them.
    const modules = join(live, 'node_modules');
    if (!existsSync(modules)) return fail(`${live} has no node_modules: its citadel-app.json build steps must install its packages (npm ci) for Capacitor's Android project`);
    const link = join(src, 'node_modules');
    if ((await readlink(link).catch(() => null)) !== modules) {
      if (await lstat(link).catch(() => null)) await rm(link, { recursive: true, force: true });
      await symlink(modules, link);
    }
    if (built) {
      // Copied, not linked: cap sync copies a link into the APK's assets as a link.
      if (!existsSync(join(live, built))) return fail(`its Capacitor webDir ${built} isn't in git and ${live} has none: its citadel-app.json build steps must build it`);
      await rm(join(src, built), { recursive: true, force: true });
      await mkdir(dirname(join(src, built)), { recursive: true });
      await cp(join(live, built), join(src, built), { recursive: true });
    }

    const base = Object.fromEntries(['HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'XDG_RUNTIME_DIR'].filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
    const path = `${join(this.d.home, '.local/share/mise/shims')}:${join(this.d.home, '.local/bin')}:/usr/local/bin:/usr/bin:/bin`;
    const env: NodeJS.ProcessEnv = { ...base, PATH: path, ...androidEnv(this.d.home, path), GIT_TERMINAL_PROMPT: '0', MISE_TRUSTED_CONFIG_PATHS: src, CITADEL_HEAVY_WHO: `${row.title} APK build`, CI: '1' };
    if (!env.ANDROID_HOME) return fail(`the Android toolchain isn't installed on perigee (tools/android/install-sdk.sh)`);
    const run = this.d.run ?? runLogged;
    const deadline = Date.now() + BUILD_MS;
    const step = async (what: string, argv: string[], cwd: string) => {
      await writeFile(log, `== ${argv.join(' ')}\n`, { flag: 'a' });
      const c = await run(argv, cwd, env, log, deadline - Date.now());
      if (c === 124) throw new Error(`the build ran past ${BUILD_MS / 60_000} minutes at: ${what}`);
      if (c) throw new Error(`${what} failed (exit ${c})`);
    };
    const gradle = gradleVersion(await readFile(join(src, 'android/app/build.gradle'), 'utf8').catch(() => readFile(join(src, 'android/app/build.gradle.kts'), 'utf8')).catch(() => ''));
    const unsigned = join(src, 'android/app/build/outputs/apk/release/app-release-unsigned.apk');
    const signed = join(dir, `${row.name}-${code}.apk`);
    try {
      await rm(unsigned, { force: true });
      await step('cap sync android', ['npx', '--no-install', 'cap', 'sync', 'android'], src);
      // The versionCode goes in through an init script, so the app's build.gradle needs no change and keeps its own number for hand builds.
      await step('gradlew assembleRelease', ['nice', '-n', '10', this.d.heavy, './gradlew', '--no-daemon', '--init-script', VERSION_INIT, `-Pcitadel.versionCode=${code}`, 'assembleRelease'], join(src, 'android'));
      if (!existsSync(unsigned)) throw new Error(`no ${unsigned.slice(src.length + 1)} after the build: its release build type must leave signing to Citadel`);
      await rm(signed, { force: true });
      await step('apksigner sign', [apksigner(this.d.home, env.ANDROID_HOME), 'sign', '--ks', key, '--ks-pass', `file:${pass}`, '--out', signed, unsigned], dir);
      await step('apksigner verify', [apksigner(this.d.home, env.ANDROID_HOME), 'verify', signed], dir);
    } catch (err: any) {
      return fail(err.message, await tail());
    }
    const manifest = join(src, 'android/app/build/intermediates/merged_manifests/release');
    const xml = (await readdir(manifest, { recursive: true }).catch(() => [] as string[])).find((f) => f.endsWith('AndroidManifest.xml'));
    const warnings = xml ? manifestWarnings(await readFile(join(manifest, xml), 'utf8').catch(() => '')) : [];
    try {
      await install({ apk: signed, feedFile, current, versionName: () => gradle?.name ?? null, extra: { commit }, certs: this.d.certs ?? signers });
    } catch (err: any) {
      if (err instanceof OtherKey || err instanceof OldApk) return fail(err.message);
      return fail(`publishing it failed: ${err.message}`);
    } finally {
      await rm(signed, { force: true });
    }
    await this.prune(join(this.d.dataDir(row), 'android'), row.name, code);
    await rm(failedAt, { force: true });
    this.d.published(row, code, commit, by);
    if (warnings.length) this.d.tell(row, `${row.title}'s Android build ${code} is published, but ${warnings.join(' and ')}. The citadel:android-app skill says none may be true in a release: fix it in the app's AndroidManifest.xml.`);
    return { built: code };
  }

  /** Remove published APKs older than the newest KEEP_APKS, never the one latest.json names. */
  private async prune(dir: string, name: string, keep: number) {
    const re = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d+)\\.apk$`);
    const old = (await readdir(dir).catch(() => [] as string[])).flatMap((f) => {
      const m = re.exec(f);
      return m && Number(m[1]) !== keep ? [{ f, n: Number(m[1]) }] : [];
    }).sort((a, b) => b.n - a.n).slice(KEEP_APKS - 1);
    for (const { f } of old) await rm(join(dir, f), { force: true });
  }
}
