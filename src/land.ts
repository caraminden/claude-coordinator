// The land tool (#213): a minion whose turn runs in its person's container can't run tools/land.sh
// there (no deploy lock, user bus or GitHub login), so the server runs it on the host, in the minion's
// worktree, as a host turn would. Its tests and boot check run as the server's user: landing is as
// trusted as it was before containers.
//
// It runs as a host job (src/host-job.ts, #508), in a unit of its own: a restart of
// the server neither kills it nor waits for it, and its output and exit code go to files under
// run/landings/<minion>/, so the next server reports them to the tool still polling. Without units
// (tests, a dev copy) or when systemd-run fails, it runs as the server's child, which a restart would
// cut off: only those count toward the runner's interruptible().
import { createHash } from 'node:crypto';
import { readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
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

  /** Start land.sh for a minion, unless one runs already; the tool polls get() until it ends. */
  start(ticketId: number, cwd: string, env: Record<string, string>): Landing {
    const now = this.get(ticketId);
    if (now && now.code === null) return now;
    this.jobs.start({ dir: this.dir(ticketId), cwd, argv: ['bash', 'tools/land.sh'], env, unit: `citadel-land-${this.unitTag}-${ticketId}-${Date.now()}`, description: `tools/land.sh for minion ${ticketId}`, ticketId });
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
