// An Android APK built and published after each deploy (#837; TWIReader's ask, Cara 2026-11-16: "Work with citadel to make
// this citadel wide"). Every land on main deploys its scheme's contraptions (#712), so once a Capacitor app's deploy goes
// live, Citadel checks whether what goes into its APK (android/, capacitor.config.*, the Capacitor webDir) changed since the
// published one. When it did, it builds a release APK from a checkout of its own beside the live one (its Gradle step on a
// machine with the Builds role when one has room, src/apk-machine.ts, else on perigee), numbers it by
// the commit count (versionCode only goes up while main isn't rewritten), signs it with the app's release key in
// ~/.config/citadel-android (the citadel:android-app skill), and publishes it and latest.json into the app's DATA_DIR/android/,
// where its open route serves them to the update banner. An app whose APKs a release workflow signs on CI (Mandate) keeps that
// path (src/apk-release.ts): this skips it. Nothing here touches the live slot, so a failed build changes nothing that runs.
import { execResult, runLogged } from './exec.ts';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { access, copyFile, cp, lstat, mkdir, readdir, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { constants } from 'node:os';
import { androidEnvLater } from './claude-link.ts';
import type { ApkMachine } from './apk-machine.ts';
import { apksigner, install, OldApk, OtherKey, signers } from './apk-release.ts';
import type { ContraptionRow } from './db.ts';
import { hasKey, keyFiles, makeReleaseKey, type Keytool } from './release-key.ts';
import { gradleVersion } from './release-readers.ts';
import { CGROUP_ROOT, hostText, SELF_CGROUP } from './host-signals.ts';
import { thrown } from './thrown.ts';

/** The whole build, the wait for a heavy slot included: past it the build is stopped and told. */
const BUILD_MS = 90 * 60_000;
/** Published APKs kept beside the newest, so a phone that read latest.json a moment ago still finds its file. */
const KEEP_APKS = 3;
/** Sets every variant's versionCode from -Pcitadel.versionCode (AGP ignores android.injected.version.code outside the IDE). */
const VERSION_INIT = join(import.meta.dirname, 'apk-version.init.gradle');

/** Where a contraption's Capacitor project sits, from citadel-app.json's `capacitor`: its root (the config's folder) and its Android project, both relative to the checkout. */
async function capacitorDirs(dir: string): Promise<{ root: string; android: string }> {
  const c = JSON.parse((await readFile(join(dir, 'citadel-app.json'), 'utf8').catch(() => '{}')) || '{}')?.capacitor;
  // Inside the checkout only: the build copies and diffs these paths.
  const ok = (v: unknown): v is string => typeof v === 'string' && !v.startsWith('/') && !v.split('/').includes('..');
  const root = ok(c?.root) ? c.root.replace(/\/+$/, '').replace(/^\.$/, '') : '';
  return { root, android: ok(c?.android) ? c.android.replace(/\/+$/, '') : join(root, 'android') };
}

/** A Capacitor app: its Android project and config at the checkout's root, or where citadel-app.json's `capacitor` puts them. webDir is relative to the root (null when the config doesn't say). */
export async function capacitorApp(dir: string): Promise<{ webDir: string | null; root: string; android: string } | null> {
  const { root, android } = await capacitorDirs(dir).catch(() => ({ root: '', android: 'android' }));
  if (!existsSync(join(dir, android, 'app/build.gradle')) && !existsSync(join(dir, android, 'app/build.gradle.kts'))) return null;
  const at = (f: string) => join(dir, root, f);
  if (existsSync(at('capacitor.config.json'))) {
    try {
      const c = JSON.parse(await readFile(at('capacitor.config.json'), 'utf8'));
      return { webDir: typeof c?.webDir === 'string' ? c.webDir : null, root, android };
    } catch {
      return { webDir: null, root, android };
    }
  }
  if (existsSync(at('capacitor.config.ts'))) {
    const m = /webDir\s*:\s*['"]([^'"]+)['"]/.exec(await readFile(at('capacitor.config.ts'), 'utf8'));
    return { webDir: m?.[1] ?? null, root, android };
  }
  return null;
}

/** The paths (relative to the checkout) whose changes go into the APK: a change anywhere else (the server, the web app it loads) needs none. */
export function apkPaths(webDir: string | null, root = '', android = join(root, 'android')): string[] {
  const own = webDir && !webDir.startsWith('/') && !webDir.split('/').includes('..') ? [join(root, webDir.replace(/\/+$/, ''))] : [];
  return [android, join(root, 'capacitor.config.json'), join(root, 'capacitor.config.ts'), ...own, ...(root && !android.startsWith(`${root}/`) ? [root] : [])].filter((x, i, l) => l.indexOf(x) === i);
}

/** The packages whose native code the Android project builds (named in its capacitor.settings.gradle), as the lockfiles `show` reads resolve them. */
export async function nativePackages(show: (path: string) => Promise<string>, root: string, android: string): Promise<string> {
  const names = [...(await show(join(android, 'capacitor.settings.gradle'))).matchAll(/node_modules\/((?:@[^/'"]+\/)?[^/'"]+)/g)].map((m) => m[1]);
  const out: unknown[] = [];
  for (const lock of new Set([join(root, 'package-lock.json'), 'package-lock.json'])) {
    const packages = (JSON.parse((await show(lock)) || '{}') as { packages?: Record<string, { version?: string; integrity?: string }> }).packages ?? {};
    for (const n of names) out.push([lock, n, packages[`node_modules/${n}`]?.version, packages[`node_modules/${n}`]?.integrity]);
  }
  return JSON.stringify(out);
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
  /** Whether a release workflow signs this app's APKs on CI (src/apk-release.ts): then this leaves it alone. null: not known yet. */
  ciRelease: (row: ContraptionRow) => boolean | null | Promise<boolean | null>;
  /** Build `code` of `row` from `commit` went out, started by `by`. */
  published: (row: ContraptionRow, code: number, commit: string, by: string) => void;
  /** Tell the app's home Taskmaster something it has to act on. */
  tell: (row: ContraptionRow, text: string) => void;
  /** Builds the unsigned APK on a lent machine's Builds role first (H3, src/apk-machine.ts); left out, or false, perigee builds it. */
  elsewhere?: Pick<ApkMachine, 'build'>;
  run?: Runner;
  /** How many processes the OOM killer has killed in Citadel's cgroup so far: a rise over a step that died of SIGKILL is out of memory. */
  oomKills?: () => Promise<number>;
  certs?: (apk: string) => Promise<string[]>;
  keytool?: Keytool;
}

/** OOM kills in this process's cgroup (cgroup v2's memory.events, which counts its children's): 0 when it can't be read. */
async function cgroupOomKills(): Promise<number> {
  try {
    const path = (await hostText(SELF_CGROUP)).match(/^0::(.*)$/m)?.[1];
    const events = path ? await hostText(join(CGROUP_ROOT, path, 'memory.events')) : '';
    return Number(/^oom_kill (\d+)$/m.exec(events)?.[1] ?? 0);
  } catch {
    return 0;
  }
}

/** A step a signal killed from outside (a Citadel restart stops every build it runs): not the commit's fault, so it isn't marked failed. */
class Killed extends Error {}

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

  /** keyless() as last read, by app; and the apps being read now. */
  private keylessSeen = new Map<string, boolean>();
  private keylessReads = new Map<string, Promise<boolean>>();

  /**
   * Whether `name` is a Capacitor app whose last check found no release key: the Releases page offers to make it. Its
   * read every 2 s answers from the last look and starts the next one off the server's thread, so the button shows a
   * poll later; a check and makeKey set it from what they found before they return.
   */
  keyless(name: string): boolean {
    void this.readKeyless(name);
    return this.keylessSeen.get(name) ?? false;
  }

  /** What a check or makeKey just found: a read already under way, begun before, doesn't put its older answer over it. */
  private knowKeyless(name: string, now: boolean) {
    this.keylessSeen.set(name, now);
    this.keylessReads.delete(name);
  }

  /** keyless(), read now: for an action that acts on it (the Make release key button). */
  readKeyless(name: string): Promise<boolean> {
    const reading = this.keylessReads.get(name);
    if (reading) return reading;
    const read: Promise<boolean> = this.keylessNow(name)
      .then((now) => {
        if (this.keylessReads.get(name) === read) this.keylessSeen.set(name, now);
        return now;
      })
      .finally(() => {
        if (this.keylessReads.get(name) === read) this.keylessReads.delete(name);
      });
    this.keylessReads.set(name, read);
    return read;
  }

  private async keylessNow(name: string): Promise<boolean> {
    const told = await access(join(this.d.cacheDir, name, 'key-missing-told')).then(
      () => true,
      () => false,
    );
    return told && !(await hasKey(this.d.keyDir, name));
  }

  /**
   * Make `row`'s release key (src/release-key.ts; throws when it has one) and build its APK at once: the commit the
   * missing key failed at is forgotten. The make_release_key card's Approve and the Releases page's button both come here.
   * Resolves once the key is made, to the build it started.
   */
  async makeKey(row: ContraptionRow, by: string): Promise<{ building: Promise<void> }> {
    await makeReleaseKey(this.d.keyDir, row.name, { home: this.d.home, keytool: this.d.keytool });
    await Promise.all(['key-missing-told', 'failed-at'].map((f) => rm(join(this.d.cacheDir, row.name, f), { force: true })));
    this.knowKeyless(row.name, false);
    return { building: this.schedule(row, by) };
  }

  /** Whether `row`'s APK is behind its live commit, and if so build and publish it. */
  async check(row: ContraptionRow, by: string): Promise<Outcome> {
    const ci = await this.d.ciRelease(row);
    // Not known: building or telling could both be wrong for an app CI signs, so it waits for a later check.
    if (ci === null) return { skipped: "its scheme's release targets aren't known yet" };
    if (ci) return { skipped: 'a release workflow signs its APKs' };
    const live = await realpath(this.d.folder(row)).catch(() => null);
    if (!live) return { skipped: 'not deployed' };
    const cap = await capacitorApp(live);
    if (!cap) {
      // A keyed contraption whose Capacitor project isn't where it's looked for would never get an APK, unheard: told once.
      const told = join(this.d.cacheDir, row.name, 'not-capacitor-told');
      if ((await hasKey(this.d.keyDir, row.name)) && !existsSync(told)) {
        mkdirSync(dirname(told), { recursive: true });
        writeFileSync(told, '');
        this.d.tell(
          row,
          `${row.title} has a release key but no Android build: its Capacitor project isn't at the checkout's root (android/app/build.gradle and capacitor.config.json there). If it sits in a subfolder, name it in citadel-app.json: "capacitor": {"root": "<folder holding capacitor.config.json>", "android": "<folder holding app/build.gradle>"}, e.g. {"root": "android", "android": "android/native"}. Told once; the next deploy builds it.`,
        );
      }
      return { skipped: 'not a Capacitor app' };
    }
    const git = (cwd: string, ...args: string[]) => execResult('git', args, { cwd, timeout: 120_000 }).then((r) => ({ code: r.code, out: r.out.trim() }));
    const commit = (await git(live, 'rev-parse', 'HEAD')).out;
    if (!/^[0-9a-f]{40}$/.test(commit)) return { failed: `couldn't read ${live}'s commit` };
    const feedFile = join(this.d.dataDir(row), 'android', 'latest.json');
    const feed = JSON.parse(await readFile(feedFile, 'utf8').catch(() => 'null')) as { versionCode?: unknown; commit?: unknown } | null;
    const current = Number.isInteger(feed?.versionCode) ? (feed!.versionCode as number) : 0;
    if (feed?.commit === commit) return { skipped: 'published at this commit' };
    // A webDir the deploy builds (gitignored dist/) isn't in git: any commit may change it, and the build copies the live one.
    const web = cap.webDir && apkPaths(cap.webDir, cap.root, cap.android).find((x) => x === join(cap.root, cap.webDir!.replace(/\/+$/, ''))); // the webDir, when it's a path inside the repo
    const built = web && !(await git(live, 'ls-files', '--', web)).out ? web : null;
    if (typeof feed?.commit === 'string' && /^[0-9a-f]{40}$/.test(feed.commit)) {
      // 0: nothing that goes into the APK changed; 1: something did; anything else (a commit it doesn't have): build.
      const same = (await git(live, 'diff', '--quiet', feed.commit, commit, '--', ...(built ? [] : apkPaths(cap.webDir, cap.root, cap.android)))).code === 0;
      // A bump of a native package may change only the lockfile (2RE6), where most changes are the server's: only those packages count.
      const native = (at: unknown) => nativePackages(async (path) => (await execResult('git', ['show', `${at}:${path}`], { cwd: live, timeout: 120_000, maxBuffer: 64 * 1024 ** 2 })).out, cap.root, cap.android).catch(() => '');
      if (same && (await native(feed.commit)) === (await native(commit))) return { skipped: 'nothing in its APK changed' };
    }
    const dir = join(this.d.cacheDir, row.name);
    // The commit its build last failed or was refused at, kept on disk so a restart doesn't tell it again.
    const failedAt = join(dir, 'failed-at');
    if (
      (() => {
        try {
          return readFileSync(failedAt, 'utf8').trim();
        } catch {
          return '';
        }
      })() === commit
    )
      return { skipped: 'already failed at this commit' };
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
    if (there.length === 2) {
      rmSync(keyTold, { force: true });
      this.knowKeyless(row.name, false);
    } else {
      if (existsSync(keyTold)) {
        this.knowKeyless(row.name, !there.length);
        return { skipped: 'no release key yet, already told' };
      }
      // Half a pair is a key that was lost, not one never made: restore it, never make a new one (phones would have to uninstall).
      const out = fail(
        there.length
          ? `half of its release key is missing: ${there[0]} is there but ${there[0] === key ? pass : key} isn't. Restore it from the desktop's CitadelBackups\\keys (deploy/desktop/README.md, "Restoring"); a new key is never made over half of one. Until then no APK is built after its deploys.`
          : `it has no release key yet (${key} and its .pass). A member makes it with Make release key on its Releases card, or approves the card make_release_key posts; until then no APK is built after its deploys.`,
      );
      writeFileSync(keyTold, commit);
      this.knowKeyless(row.name, !there.length);
      return out;
    }
    const count = Number((await git(live, 'rev-list', '--count', commit)).out);
    if (!Number.isInteger(count) || count < 1) return fail(`couldn't count ${commit.slice(0, 9)}'s commits`);
    // A feed this builder wrote (it has a commit) at or past the count is an older commit going live, a roll back to last
    // green (docs/adr/0012): phones only take a higher versionCode, so it goes out one past the published build.
    const ours = typeof feed?.commit === 'string';
    if (count <= current && !ours) return fail(`its versionCode is its commit count, ${count}, and the published APK is build ${current} already. Phones only update to a higher one: publish one from a release workflow instead, or bump past it.`);
    const code = Math.max(count, current + 1);

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
    // Its packages are the live slot's, which the deploy's build steps installed (npm ci): Capacitor's Android code is in them,
    // at the checkout's root and, for a project in a subfolder, in that folder's own node_modules (cap sync and the Gradle files look there).
    const folders = cap.root ? ['', cap.root] : [''];
    const have = folders.filter((f) => existsSync(join(live, f, 'node_modules')));
    if (!have.length) return fail(`${live} has no node_modules${cap.root ? ` (nor ${cap.root}/node_modules)` : ''}: its citadel-app.json build steps must install its packages (npm ci${cap.root ? ` --prefix ${cap.root}` : ''}) for Capacitor's Android project`);
    for (const f of have) {
      const modules = join(live, f, 'node_modules');
      const link = join(src, f, 'node_modules');
      if ((await readlink(link).catch(() => null)) !== modules) {
        if (await lstat(link).catch(() => null)) await rm(link, { recursive: true, force: true });
        await symlink(modules, link);
      }
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
    const env: NodeJS.ProcessEnv = { ...base, PATH: path, ...(await androidEnvLater(this.d.home, path)), GIT_TERMINAL_PROMPT: '0', MISE_TRUSTED_CONFIG_PATHS: src, CITADEL_HEAVY_WHO: `${row.title} APK build`, CITADEL_HEAVY_HERE: '1', CITADEL_HEAVY_PRIORITY: '1', CI: '1' };
    if (!env.ANDROID_HOME) return fail(`the Android toolchain isn't installed on perigee (tools/android/install-sdk.sh)`);
    const run = this.d.run ?? runLogged;
    let deadline = Date.now() + BUILD_MS;
    const ooms = this.d.oomKills ?? cgroupOomKills;
    const step = async (what: string, argv: string[], cwd: string) => {
      await writeFile(log, `== ${argv.join(' ')}\n`, { flag: 'a' });
      const before = await ooms();
      const c = await run(argv, cwd, env, log, deadline - Date.now());
      if (c === 124) throw new Error(`the build ran past ${BUILD_MS / 60_000} minutes at: ${what}`);
      const signal = c > 128 ? Object.entries(constants.signals).find(([, n]) => n === c - 128)?.[0] : undefined;
      // Any exit, not only a signal: an OOM kill of Gradle's own daemon leaves its client exiting 1.
      if (c && (await ooms()) > before) {
        await writeFile(log, `== out of memory: the kernel's OOM killer killed part of it (exit ${c})\n`, { flag: 'a' });
        throw new Error(`${what} ran out of memory: the kernel killed it (${signal ?? `exit ${c}`})`);
      }
      if (signal) throw new Killed(`${what} was killed by ${signal} (a Citadel restart stops its builds): the next check builds it again`);
      if (c) throw new Error(`${what} failed (exit ${c})`);
    };
    const gradle = gradleVersion(
      await readFile(join(src, cap.android, 'app/build.gradle'), 'utf8')
        .catch(() => readFile(join(src, cap.android, 'app/build.gradle.kts'), 'utf8'))
        .catch(() => ''),
    );
    const unsigned = join(src, cap.android, 'app/build/outputs/apk/release/app-release-unsigned.apk');
    const signed = join(dir, `${row.name}-${code}.apk`);
    try {
      await rm(unsigned, { force: true });
      await step('cap sync android', ['npx', '--no-install', 'cap', 'sync', 'android'], join(src, cap.root));
      // The versionCode goes in through an init script, so the app's build.gradle needs no change and keeps its own number for hand builds.
      const gradlew = (init: string) => ['./gradlew', '--no-daemon', '--init-script', init, `-Pcitadel.versionCode=${code}`, 'assembleRelease'];
      const built = await this.elsewhere(row, src, cap.android, gradlew, log, dir);
      // The time a machine took isn't taken from what perigee still does: its own build, or the signing.
      deadline = Date.now() + BUILD_MS;
      if (!built) await step('gradlew assembleRelease', ['nice', '-n', '10', this.d.heavy, ...gradlew(VERSION_INIT)], join(src, cap.android));
      if (!existsSync(unsigned)) throw new Error(`no ${unsigned.slice(src.length + 1)} after the build: its release build type must leave signing to Citadel`);
      await rm(signed, { force: true });
      await step('apksigner sign', [apksigner(this.d.home, env.ANDROID_HOME), 'sign', '--ks', key, '--ks-pass', `file:${pass}`, '--out', signed, unsigned], dir);
      await step('apksigner verify', [apksigner(this.d.home, env.ANDROID_HOME), 'verify', signed], dir);
    } catch (err) {
      if (err instanceof Killed) return { failed: err.message };
      return fail(thrown(err).message ?? String(err), await tail());
    }
    const manifest = join(src, cap.android, 'app/build/intermediates/merged_manifests/release');
    const xml = (await readdir(manifest, { recursive: true }).catch(() => [] as string[])).find((f) => f.endsWith('AndroidManifest.xml'));
    const warnings = xml ? manifestWarnings(await readFile(join(manifest, xml), 'utf8').catch(() => '')) : [];
    try {
      await install({ apk: signed, feedFile, current, versionName: () => gradle?.name ?? null, extra: { commit }, certs: this.d.certs ?? signers });
    } catch (err) {
      if (err instanceof OtherKey || err instanceof OldApk) return fail(err.message);
      return fail(`publishing it failed: ${thrown(err).message}`);
    } finally {
      await rm(signed, { force: true });
    }
    await this.prune(join(this.d.dataDir(row), 'android'), row.name, code);
    await rm(failedAt, { force: true });
    this.d.published(row, code, commit, by);
    if (warnings.length) this.d.tell(row, `${row.title}'s Android build ${code} is published, but ${warnings.join(' and ')}. The citadel:android-app skill says none may be true in a release: fix it in the app's AndroidManifest.xml.`);
    return { built: code };
  }

  /** The Gradle step on a lent machine (H3): true once the unsigned APK is in the checkout. No signing key goes along. */
  private async elsewhere(row: ContraptionRow, src: string, android: string, gradlew: (init: string) => string[], log: string, dir: string): Promise<boolean> {
    if (!this.d.elsewhere) return false;
    // The init script goes with the snapshot: perigee's path to it means nothing there.
    const init = join(src, '.citadel-apk-version.gradle');
    await copyFile(VERSION_INIT, init);
    try {
      return await this.d.elsewhere.build({
        row,
        top: src,
        dir: android,
        argv: gradlew(relative(join(src, android), init)),
        apk: join(android, 'app/build/outputs/apk/release/app-release-unsigned.apk'),
        manifest: join(android, 'app/build/intermediates/merged_manifests/release'),
        log,
        scratch: join(dir, 'machine'),
        minutes: BUILD_MS / 60_000,
      });
    } finally {
      await rm(init, { force: true });
    }
  }

  /** Remove published APKs older than the newest KEEP_APKS, never the one latest.json names. */
  private async prune(dir: string, name: string, keep: number) {
    const re = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d+)\\.apk$`);
    const old = (await readdir(dir).catch(() => [] as string[]))
      .flatMap((f) => {
        const m = re.exec(f);
        return m && Number(m[1]) !== keep ? [{ f, n: Number(m[1]) }] : [];
      })
      .sort((a, b) => b.n - a.n)
      .slice(KEEP_APKS - 1);
    for (const { f } of old) await rm(join(dir, f), { force: true });
  }
}
