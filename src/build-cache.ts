/**
 * One Gradle build cache for every minion's worktree in every scheme (#1153), so a fresh worktree's first
 * Android build takes its compiled outputs from the cache instead of building them all again (TWIReader:
 * 94 s cold, 18 s with the cache). It sits in the projects folder, which every person's container mounts
 * at the same path, so host and container turns share it; Gradle locks its local cache per operation
 * (FileLockManager's OnDemand mode), so builds in different worktrees and containers use it at once.
 *
 * A turn's env names the folder (CITADEL_GRADLE_CACHE, src/runner.ts heavyEnv); an init script in each
 * Gradle home turns the cache on there only when that variable is set, so a person's own builds outside a
 * turn are untouched. The server writes the script into its own ~/.gradle at start and into each
 * container's volume (src/claude-link.ts). The daily sweep keeps the folder under GRADLE_CACHE_CAP, oldest
 * written first; Gradle's own cleanup also drops entries a Gradle home hasn't used in 7 days.
 * `citadel-build-cache clear gradle` empties it when an entry is bad.
 *
 * Rust has no Citadel-wide cache: Peek Auras, the only Rust scheme, shares one sccache across its worktrees
 * through its own tools/rustc-wrapper (its cap is SCCACHE_CACHE_SIZE there).
 */
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { exists } from './build-output.ts';

/** The shared Gradle build cache, under the projects folder. */
export const gradleCacheDir = (dataDir: string) => join(dataDir, 'projects', '.build-cache', 'gradle');
/** Its cap. TWIReader's whole build stores about 10 MiB, so this holds every Android scheme's for weeks. */
export const GRADLE_CACHE_CAP = 5 * 2 ** 30;
/** Where the init script goes, under a Gradle home's parent (a HOME). */
export const GRADLE_INIT = '.gradle/init.d/citadel-build-cache.gradle';

export const GRADLE_INIT_SCRIPT = `// Written by Citadel (src/build-cache.ts, #1153); it rewrites this file at start, so edit it there.
// In a Citadel turn, CITADEL_GRADLE_CACHE names one build cache every worktree shares; outside a turn
// this does nothing. A build that sets org.gradle.caching=false in its gradle.properties keeps it off.
def citadelCache = System.getenv('CITADEL_GRADLE_CACHE')
def props = new Properties()
def own = new File(gradle.startParameter.currentDir, 'gradle.properties')
if (own.isFile()) own.withInputStream { props.load(it) }
if (citadelCache && props.getProperty('org.gradle.caching')?.trim() != 'false') {
  gradle.startParameter.buildCacheEnabled = true
  beforeSettings { settings ->
    settings.buildCache { local { directory = new File(citadelCache) } }
  }
}
`;

/** Write the init script under `home` unless it is there already; returns whether it wrote. */
export async function ensureGradleInit(home: string): Promise<boolean> {
  const file = join(home, GRADLE_INIT);
  if ((await readFile(file, 'utf8').catch(() => null)) === GRADLE_INIT_SCRIPT) return false;
  await mkdir(dirname(file), { recursive: true });
  // A rename, so a build starting meanwhile never reads half a script.
  // Its own temporary name: a person's container and their Taskmaster's share the volume and start apart.
  const temp = `${file}.${randomBytes(4).toString('hex')}.new`;
  await writeFile(temp, GRADLE_INIT_SCRIPT);
  await rename(temp, file);
  return true;
}

/** Gradle's own files in a cache folder, which a trim leaves: its lock and its cleanup marker. */
const keep = (name: string) => name.endsWith('.lock') || name === 'gc.properties';

/** Entries written this recently are left alone: Gradle may still be writing or moving them. */
const SETTLING_MS = 60 * 60_000;

/**
 * Delete the oldest entries of a flat cache folder until it is under `cap` bytes. Returns what it removed
 * and the size left. A folder that isn't there is empty.
 * shortcut: oldest written, not least used (Gradle keeps reads in each Gradle home's own journal), so a
 * hot old entry can go and be stored again; read those journals if trims start costing rebuilds.
 */
export async function trimCache(dir: string, cap: number): Promise<{ removed: number; freed: number; left: number }> {
  const out = { removed: 0, freed: 0, left: 0 };
  if (!(await exists(dir))) return out;
  const entries: { path: string; size: number; used: number }[] = [];
  for (const name of await readdir(dir)) {
    if (keep(name)) continue;
    // lstat: a symlink in here is never followed out of the cache.
    const s = await lstat(join(dir, name)).catch(() => null);
    if (!s?.isFile()) continue;
    out.left += s.size;
    if (s.mtimeMs > Date.now() - SETTLING_MS) continue;
    entries.push({ path: join(dir, name), size: s.size, used: s.mtimeMs });
  }
  entries.sort((a, b) => a.used - b.used);
  for (const e of entries) {
    if (out.left <= cap) break;
    const err = await unlink(e.path).then(
      () => null,
      (x: NodeJS.ErrnoException) => x,
    );
    if (err && err.code !== 'ENOENT') continue; // still there, so it still counts
    if (!err) {
      out.removed++;
      out.freed += e.size;
    }
    out.left -= e.size;
  }
  return out;
}
