// The land tool (#213): a minion whose turn runs in its person's container can't run tools/land.sh
// there (no deploy lock, user bus or GitHub login), so the server runs it on the host, in the minion's
// worktree, as a host turn would. Its tests and boot check run as the server's user: landing is as
// trusted as it was before containers. That holds for every scheme's minions (#574): a container turn
// that lands runs its worktree's land.sh on the host, with the box's GitHub login.
//
// It runs as a host job (src/host-job.ts, #508), in a unit of its own: a restart of
// the server neither kills it nor waits for it, and its output and exit code go to files under
// run/landings/<minion>/, so the next server reports them to the tool still polling. Without units
// (tests, a dev copy) or when systemd-run fails, it runs as the server's child, which a restart would
// cut off: only those count toward the runner's interruptible().
import { createHash } from 'node:crypto';
import { readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { HostJobs } from './host-job.ts';

export interface Landing {
  /** The tail of what land.sh printed so far. */
  output: string;
  /** Its exit code once it ended, null while it runs. */
  code: number | null;
}

const MAX_OUTPUT = 64 * 1024;
/** Finished landings' folders older than this go when a server starts. */
const KEEP_MS = 14 * 24 * 3600_000;
/** Said when the wrapper ended without writing a code: its unit was stopped, or a restart cut off a child. */
export const NO_CODE = '\n[land.sh ended without an exit code: it was stopped, or a restart cut it off. Check `git log main`.]';

/** At most this many test files in one call: a feeder names the few its change touched. */
const MAX_FILES = 200;

/**
 * The land tool's arguments, turned into land.sh's (#597), or an Error saying what was wrong. Only the shapes
 * land.sh accepts come out: nothing, `--build`, `--into build/<n> --full`, or `--into build/<n> <files>` with
 * each file an existing file inside the worktree, passed as a path relative to it. No free-form text reaches it.
 */
export function landArgs(body: { into?: unknown; files?: unknown; full?: unknown; build?: unknown }, cwd: string): string[] {
  const { into, files, full, build } = body;
  if (build !== undefined && typeof build !== 'boolean') throw new Error('build must be true or false');
  if (full !== undefined && typeof full !== 'boolean') throw new Error('full must be true or false');
  if (into !== undefined && into !== null && typeof into !== 'string') throw new Error('into must be a build branch, build/<n>');
  if (files !== undefined && files !== null && !(Array.isArray(files) && files.every((f) => typeof f === 'string'))) throw new Error('files must be a list of test file paths');
  const list = (files ?? []) as string[];
  if (build) {
    if ((into !== undefined && into !== null) || full || list.length) throw new Error('build takes nothing more: not into, full or files (it lands the build your branch is at the tip of)');
    return ['--build'];
  }
  // Only a missing into is a plain land: an empty or wrong one is refused, never read as main.
  if (into === undefined || into === null) {
    if (full || list.length) throw new Error('full and files go with into: build/<n>');
    return [];
  }
  if (!/^build\/[1-9][0-9]{0,5}$/.test(into)) throw new Error(`into must be a build branch, build/<n>, not ${JSON.stringify(into.slice(0, 80))}`);
  if (full) {
    if (list.length) throw new Error('full runs the whole suite: name no files with it');
    return ['--into', into, '--full'];
  }
  if (list.length > MAX_FILES) throw new Error(`at most ${MAX_FILES} files`);
  let root: string;
  try {
    root = realpathSync(cwd);
  } catch {
    throw new Error('this minion\'s worktree is missing');
  }
  const rel = list.map((f) => {
    const bad = () => new Error(`${JSON.stringify(f.slice(0, 200))} is not a file in your worktree: name the test files this change touched, as paths inside it`);
    if (!f || f.includes('\0')) throw bad();
    let real: string;
    try {
      // Symlinks resolved, so a link can't point the run outside the worktree.
      real = realpathSync(resolve(root, f));
      if (!statSync(real).isFile()) throw bad();
    } catch {
      throw bad();
    }
    const r = relative(root, real);
    if (!r || r === '..' || r.startsWith(`..${sep}`) || isAbsolute(r)) throw bad();
    // Never one land.sh or node would read as an option.
    return r.startsWith('-') ? `.${sep}${r}` : r;
  });
  return ['--into', into, ...rel];
}

export class Landings {
  private readonly root: string;
  private readonly unitTag: string;
  private readonly jobs: HostJobs;

  /** `units`: whether to start each landing in a unit of its own (the runner's `units`, read at each start). */
  constructor(dataDir: string, units: () => boolean = () => false) {
    this.jobs = new HostJobs(units);
    this.root = join(resolve(dataDir), 'run', 'landings');
    // As the runner tags turn units: two servers on one box (a dev copy) never share a unit name.
    this.unitTag = createHash('sha256').update(this.root).digest('hex').slice(0, 8);
    this.prune();
  }

  private dir(ticketId: number): string {
    return join(this.root, String(ticketId));
  }

  /** Start land.sh for a minion, with `args` from landArgs(), unless one runs already; the tool polls get() until it ends. */
  start(ticketId: number, cwd: string, env: Record<string, string>, args: string[] = []): Landing {
    const now = this.get(ticketId);
    if (now && now.code === null) return now;
    this.jobs.start({ dir: this.dir(ticketId), cwd, argv: ['bash', 'tools/land.sh', ...args], env, unit: `citadel-land-${this.unitTag}-${ticketId}-${Date.now()}`, description: `tools/land.sh for minion ${ticketId}`, ticketId });
    return { output: '', code: null };
  }

  /** Landings running as the server's child: the ones a restart would cut off. */
  running(): number {
    return this.jobs.running();
  }

  /** The landing a minion started last, from its folder, whichever server started it. */
  get(ticketId: number): Landing | null {
    const r = this.jobs.state(this.dir(ticketId), MAX_OUTPUT);
    return r && r.code === -1 ? { output: r.output + NO_CODE, code: 1 } : r;
  }

  /** Drop finished landings' folders from long ago. */
  private prune() {
    let names: string[];
    try {
      names = readdirSync(this.root);
    } catch {
      return;
    }
    for (const name of names) {
      try {
        if (Date.now() - statSync(join(this.root, name, 'code')).mtimeMs > KEEP_MS) rmSync(join(this.root, name), { recursive: true, force: true });
      } catch {
        // Still running, or never started: left alone.
      }
    }
  }
}
