// Releasing an Android APK the way its scheme does by hand (#629; Mandate's android/README.md, "Publishing an APK"):
// start its release workflow on the default branch, and once a run has signed an APK, copy it into the contraption's
// android/ folder and point latest.json at it, so installed phones see the update banner. GitHub calls go through the
// gh CLI as the scheme owner's linked login, as CI health's reads do.
import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { asEnv, type GithubEnv } from './scheme-repo.ts';

const run = promisify(execFile);

/** A signed APK no newer than the published one: the run was built before main's version bump. */
export class OldApk extends Error {}

/** Start a workflow_dispatch workflow (`file`, its name in .github/workflows) on `ref`. */
export async function dispatch(slug: string, file: string, ref: string, as: GithubEnv) {
  await run('gh', ['api', '-X', 'POST', `repos/${slug}/actions/workflows/${encodeURIComponent(file)}/dispatches`, '-f', `ref=${ref}`], { env: asEnv(as), timeout: 30_000 });
}

/** A signed APK's file name ("mandate-7.apk") as its versionCode, or null when it doesn't carry one. */
export function apkCode(name: string): number | null {
  const m = /^[\w.-]*?-(\d+)\.apk$/.exec(name);
  return m ? Number(m[1]) : null;
}

/** latest.json pointing at `apk`: what it held, with the new versionCode and file, and a versionName only when known. */
export function nextFeed(was: Record<string, unknown>, code: number, apk: string, versionName: string | null): Record<string, unknown> {
  const { versionName: _old, ...rest } = was;
  return { ...rest, versionCode: code, apk, ...(versionName ? { versionName } : {}) };
}

/**
 * Publish run `runId`'s signed APK beside `feedFile` (a contraption's android/latest.json): take `stored`, the APK the
 * run put in the CI store (#658), or else download its GitHub artifacts and take their one APK, refuse one no newer than `current`, copy it in, then rewrite latest.json (the APK first, so latest.json
 * never names a file that isn't there). Returns the published versionCode.
 */
export async function publish(o: { slug: string; runId: number; feedFile: string; current: number; main: { code: number; name: string | null }; as: GithubEnv; stored?: string }): Promise<number> {
  const tmp = await mkdtemp(join(tmpdir(), 'apk-release-'));
  try {
    let apk = o.stored;
    if (!apk) {
      await run('gh', ['run', 'download', String(o.runId), '--repo', o.slug, '--dir', tmp], { env: asEnv(o.as), timeout: 10 * 60_000 });
      const apks = (await readdir(tmp, { recursive: true })).filter((f) => f.endsWith('.apk'));
      if (apks.length !== 1) throw new Error(`run ${o.runId}'s artifacts hold ${apks.length} APKs, not one`);
      apk = join(tmp, apks[0]);
    }
    const name = basename(apk);
    const code = apkCode(name);
    if (code == null) throw new Error(`${name} doesn't name its versionCode (<app>-<versionCode>.apk)`);
    if (code <= o.current) throw new OldApk(`the newest signed APK, ${name}, is no newer than build ${o.current}, which is published: start a release run of the bumped version`);
    const dir = dirname(o.feedFile);
    await copyFile(apk, join(dir, name));
    const was = JSON.parse(await readFile(o.feedFile, 'utf8').catch(() => '{}'));
    const feed = nextFeed(was && typeof was === 'object' ? was : {}, code, name, o.main.code === code ? o.main.name : null);
    await writeFile(`${o.feedFile}.tmp`, JSON.stringify(feed, null, 2) + '\n');
    await rename(`${o.feedFile}.tmp`, o.feedFile);
    return code;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
