// The land tool (#213): a minion whose turn runs in its person's container can't run tools/land.sh
// there (no deploy lock, user bus or GitHub login), so the server runs it on the host, in the minion's
// worktree, as a host turn would. Its tests and boot check run as the server's user: landing is as
// trusted as it was before containers.
import { spawn } from 'node:child_process';
import { join } from 'node:path';

export interface Landing {
  /** The tail of what land.sh printed so far. */
  output: string;
  /** Its exit code once it ended, null while it runs. */
  code: number | null;
}

const MAX_OUTPUT = 64 * 1024;

export class Landings {
  private runs = new Map<number, Landing>();

  /** Start land.sh for a minion, unless one runs already; the tool polls get() until it ends. */
  start(ticketId: number, cwd: string, env: Record<string, string>): Landing {
    const now = this.runs.get(ticketId);
    if (now && now.code === null) return now;
    const run: Landing = { output: '', code: null };
    this.runs.set(ticketId, run);
    const child = spawn('bash', [join(cwd, 'tools', 'land.sh')], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const take = (buf: Buffer) => { run.output = (run.output + buf.toString()).slice(-MAX_OUTPUT); };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', (err) => { run.output += `\n${err.message}`; run.code = 127; });
    child.on('close', (code) => { run.code = code ?? 1; });
    return run;
  }

  /** Landings still running. */
  running(): number {
    return [...this.runs.values()].filter((r) => r.code === null).length;
  }

  get(ticketId: number): Landing | null {
    return this.runs.get(ticketId) ?? null;
  }
}
