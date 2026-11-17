// Releasing an Android APK the way its scheme does by hand (#629; Mandate's android/README.md, "Publishing an APK"):
// start its release workflow on the default branch, and once a run has signed an APK, copy it into the contraption's
// android/ folder and point latest.json at it, so installed phones see the update banner. GitHub calls go through the
// gh CLI as the scheme owner's linked login, as CI health's reads do.
import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { ANDROID_SDK, androidEnv } from './claude-link.ts';
import { asEnv, type GithubEnv } from './scheme-repo.ts';

const run = promisify(execFile);

/** A signed APK no newer than the published one: the run was built before main's version bump. */
export class OldApk extends Error {}

/** A signed APK whose signing key isn't the published one's: installed phones won't take it as an update (#663). */
export class OtherKey extends Error {}

/** The SHA-256 digests in `apksigner verify --print-certs` output, sorted. */
export function certDigests(out: string): string[] {
  return [...out.matchAll(/^Signer #\d+ certificate SHA-256 digest: ([0-9a-f]+)$/gm)].map((m) => m[1]).sort();
}

/** apksigner from the newest build-tools installed (#379), so a toolchain upgrade doesn't break publishing; throws when there is none. */
export function apksigner(home = homedir(), sdk = androidEnv(home).ANDROID_HOME ?? join(home, ANDROID_SDK)): string {
  const tools = join(sdk, 'build-tools');
  const newest = (existsSync(tools) ? readdirSync(tools) : []).sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).at(-1);
  if (!newest) throw new Error(`apksigner isn't installed (no ${tools}): install the Android toolchain (tools/android/install-sdk.sh)`);
  return join(tools, newest, 'apksigner');
}

/** An APK's signing certificates (SHA-256), by apksigner from the shared Android toolchain (#379); throws when it doesn't verify. */
export async function signers(apk: string): Promise<string[]> {
  const env = { ...process.env, ...androidEnv(homedir(), process.env.PATH) };
  let tool: string;
  try {
    tool = apksigner(homedir(), env.ANDROID_HOME);
  } catch (err: any) {
    throw new Error(`${err.message}, so ${basename(apk)}'s signing key can't be checked`);
  }
  try {
    return certDigests((await run(tool, ['verify', '--print-certs', apk], { env, timeout: 2 * 60_000 })).stdout);
  } catch (err: any) {
    throw new Error(`apksigner couldn't read ${basename(apk)}'s signing certificate: ${(err?.stderr || err?.message || String(err)).trim().slice(0, 300)}`);
  }
}

/** Start a workflow_dispatch workflow (`file`, its name in .github/workflows) on `ref`. */
export async function dispatch(slug: string, file: string, ref: string, as: GithubEnv) {
  await run('gh', ['api', '-X', 'POST', `repos/${slug}/actions/workflows/${encodeURIComponent(file)}/dispatches`, '-f', `ref=${ref}`], { env: asEnv(as), timeout: 30_000 });
}

/** A signed APK's file name ("mandate-7.apk") as its versionCode, or null when it doesn't carry one. */
export function apkCode(name: string): number | null {
  const m = /^[\w.-]*?-(\d+)\.apk$/.exec(name);
  return m ? Number(m[1]) : null;
}

/** latest.json pointing at `apk`: what it held, with the new versionCode and file, a versionName only when known, and `extra` (a land build's commit, #837). */
export function nextFeed(was: Record<string, unknown>, code: number, apk: string, versionName: string | null, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const { versionName: _old, commit: _built, ...rest } = was;
  return { ...rest, versionCode: code, apk, ...(versionName ? { versionName } : {}), ...extra };
}

/**
 * Publish run `runId`'s signed APK beside `feedFile` (a contraption's android/latest.json): take `stored`, the APK the
 * run put in the CI store (#658), or else download its GitHub artifacts and take their one APK, refuse one no newer than `current`
 * or signed with another key than the published APK (OtherKey, #663), copy it in, then rewrite latest.json (the APK first, so
 * latest.json never names a file that isn't there). Returns the published versionCode. `certs` reads an APK's signing
 * certificates (signers; tests fake it).
 */
export async function publish(o: { slug: string; runId: number; feedFile: string; current: number; main: { code: number; name: string | null }; as: GithubEnv; stored?: string; certs?: (apk: string) => Promise<string[]> }): Promise<number> {
  const tmp = await mkdtemp(join(tmpdir(), 'apk-release-'));
  try {
    let apk = o.stored;
    if (!apk) {
      await run('gh', ['run', 'download', String(o.runId), '--repo', o.slug, '--dir', tmp], { env: asEnv(o.as), timeout: 10 * 60_000 });
      const apks = (await readdir(tmp, { recursive: true })).filter((f) => f.endsWith('.apk'));
      if (apks.length !== 1) throw new Error(`run ${o.runId}'s artifacts hold ${apks.length} APKs, not one`);
      apk = join(tmp, apks[0]);
    }
    return await install({ apk, feedFile: o.feedFile, current: o.current, versionName: (code) => (o.main.code === code ? o.main.name : null), certs: o.certs });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/**
 * Put signed APK `apk` (named <app>-<versionCode>.apk) beside `feedFile` and point latest.json at it: refuse one no newer
 * than `current` (OldApk) or signed with another key than the published APK (OtherKey, #663), copy it in, then rewrite
 * latest.json (the APK first, so latest.json never names a file that isn't there). Returns the published versionCode.
 * Both release paths end here: a release run's APK (publish) and one built on perigee after a deploy (src/apk-build.ts, #837).
 */
export async function install(o: { apk: string; feedFile: string; current: number; versionName: (code: number) => string | null; extra?: Record<string, unknown>; certs?: (apk: string) => Promise<string[]> }): Promise<number> {
  const name = basename(o.apk);
  const code = apkCode(name);
  if (code == null) throw new Error(`${name} doesn't name its versionCode (<app>-<versionCode>.apk)`);
  if (code <= o.current) throw new OldApk(`the newest signed APK, ${name}, is no newer than build ${o.current}, which is published: start a release run of the bumped version`);
  const dir = dirname(o.feedFile);
  const was = JSON.parse(await readFile(o.feedFile, 'utf8').catch(() => '{}'));
  // Phones update only to an APK signed with the key they installed: check against the published one, when it's there.
  const prev = typeof was?.apk === 'string' && was.apk ? join(dir, basename(was.apk)) : null;
  if (prev && existsSync(prev)) {
    const certs = o.certs ?? signers;
    const [old, now] = await Promise.all([certs(prev), certs(o.apk)]);
    if (!now.length || old.join() !== now.join()) {
      throw new OtherKey(`${name} is signed with another key (certificate SHA-256 ${now.join(', ') || 'none'}) than the published ${basename(prev)} (${old.join(', ')}), and phones won't update across keys, so it wasn't published. Sign it with the release key the published APK used.`);
    }
  }
  await mkdir(dir, { recursive: true });
  await copyFile(o.apk, join(dir, name));
  const feed = nextFeed(was && typeof was === 'object' ? was : {}, code, name, o.versionName(code), o.extra);
  await writeFile(`${o.feedFile}.tmp`, JSON.stringify(feed, null, 2) + '\n');
  await rename(`${o.feedFile}.tmp`, o.feedFile);
  return code;
}
