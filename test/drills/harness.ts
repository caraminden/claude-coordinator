// The fault drills' harness (#1326, RL3 of the reliability lens). A drill boots a real server on a scratch folder with
// fake turns, applies one fault at one named point, boots again and asserts on what was saved, never on timing.
// Drills are not in `npm test`'s gate: they run nightly (.github/workflows/fault-drills.yml) and by hand with
// `citadel-heavy tools/drills`, never on perigee.
// A drill showing a known gap is an expected failure: its assertion's message starts with the finding's code (A1, C8...)
// and `gap('A1')` matches only that (node matches the whole error, `AssertionError [...]: A1: ...`), so a fix turns it red ("expected to fail") and a broken harness fails as itself.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../../src/db.ts';
import { agentToken, bootServer, releaseFake, stopTurns, until, type Booted } from '../helpers.ts';

/** test()'s option for a drill that shows finding `code`: it must fail with that finding's assertion, and only that. */
export const gap = (code: string) => ({ expectFailure: new RegExp(`(^|: )${code}: `) });

export class Drill {
  readonly root: string;
  readonly fake: ReturnType<typeof releaseFake>;
  /** Every line the servers wrote, all boots in one file. */
  readonly log: string;
  srv: Booted | null = null;
  private env: NodeJS.ProcessEnv;

  constructor(name: string, env: NodeJS.ProcessEnv = {}) {
    // Every way in (tools/drills, node --test, an import, citadel-heavy run here when no runner takes it) stops here.
    if (hostname().split('.')[0] === 'perigee') throw new Error('The fault drills never run on perigee: citadel-heavy tools/drills');
    this.root = mkdtempSync(join(tmpdir(), `drill-${name}-`));
    this.fake = releaseFake(this.root);
    this.log = join(this.root, 'server.log');
    // Turns run as detached children (no units: the same on a laptop as on CI), and resumes start 50 ms apart.
    this.env = { CLAUDE_BIN: this.fake.fake, TURN_UNITS: '0', CITADEL_RESUME_GAP_MS: '50', NODE_NO_WARNINGS: '1', ...env };
  }

  get data() {
    return join(this.root, 'data');
  }

  /** Boot a server on the drill's data: `env` for this boot only (a fault point), `wrap` a command it runs under. */
  async boot(env: NodeJS.ProcessEnv = {}, wrap?: string[]) {
    if (this.srv) throw new Error('a server is already up');
    this.srv = await bootServer({ root: this.root, env: { ...this.env, ...env }, wrap, log: this.log });
    return this.srv;
  }

  /** SIGKILL the server, as the OOM killer or a crash would: nothing of its own runs on the way out. */
  async crash() {
    const p = this.srv!.proc;
    this.srv = null;
    if (p.exitCode !== null || p.signalCode !== null) return;
    await new Promise((r) => { p.once('exit', r); p.kill('SIGKILL'); });
  }

  /** A server booted with CITADEL_FAULT_POINT=`point`: wait for it to have died by its own hand there. */
  async died(point: string) {
    const p = this.srv!.proc;
    // The handle stays until it has exited, so a server that never reaches its point is still stopped by cleanup().
    await until(`the server to kill itself at fault point ${point} (src/fault-points.ts; is faultPoint('${point}') in src?)`, () => p.exitCode !== null || p.signalCode !== null, 90_000);
    this.srv = null;
    if (p.signalCode !== 'SIGKILL') throw new Error(`the server exited (${p.exitCode ?? p.signalCode}), not at fault point ${point}`);
  }

  /** A clean stop, as a deploy's restart does. */
  async restart(env: NodeJS.ProcessEnv = {}) {
    await this.srv!.stop({ keepTurns: true });
    this.srv = null;
    return this.boot(env);
  }

  /** Rows from the server's database, read the way an outsider does (read-only, its own connection). */
  rows<T = any>(sql: string, ...args: any[]): T[] {
    const db = new DatabaseSync(join(this.data, 'coordinator.db'), { readOnly: true, timeout: 30_000 });
    try {
      return db.prepare(sql).all(...args) as T[];
    } finally {
      db.close();
    }
  }

  /** How many times the servers logged a line matching `re`. */
  logged(re: RegExp): number {
    return existsSync(this.log) ? readFileSync(this.log, 'utf8').split('\n').filter((l) => re.test(l)).length : 0;
  }

  setting<T = any>(key: string): T | null {
    const row = this.rows<{ value: string }>('SELECT value FROM settings WHERE key = ?', key)[0];
    return row ? JSON.parse(row.value) : null;
  }

  notes(id: number): string[] {
    return this.rows<{ data: string }>("SELECT data FROM events WHERE ticket_id = ? AND kind = 'note' ORDER BY id", id).map((r) => JSON.parse(r.data).text);
  }

  /** The stream lines of `type` saved in a minion's chat. */
  stream(id: number, type: string): any[] {
    return this.rows<{ data: string }>("SELECT data FROM events WHERE ticket_id = ? AND kind = 'claude' ORDER BY id", id).map((r) => JSON.parse(r.data)).filter((d) => d.type === type);
  }

  status(id: number): string {
    return this.rows<{ status: string }>('SELECT status FROM tickets WHERE id = ?', id)[0]?.status;
  }

  async project(name = 'Drill') {
    return (await this.srv!.call('/api/projects', { name })).data as { id: number };
  }

  /** A new minion in `project` whose first turn starts now, with the fake claude held until release. */
  async minion(project: number, message = 'build it'): Promise<number> {
    const made = (await this.srv!.call(`/api/projects/${project}/tickets`, { message })).data;
    return (made.ticket ?? made).id;
  }

  /** The folder of a minion's current turn, once its wrapper and claude have started. */
  turnDir(id: number): string | null {
    const dir = this.setting<{ dir?: string }>(`turn:${id}`)?.dir;
    return dir && existsSync(join(dir, 'pid.json')) ? dir : null;
  }

  pids(dir: string): { wrapper: number; claude: number } {
    return JSON.parse(readFileSync(join(dir, 'pid.json'), 'utf8'));
  }

  /**
   * A minion with a git worktree whose tools/land.sh lands once `go` exists (a file in the drill's folder), then
   * hands its branch off as hand_off_land does. Returns the minion and the go file.
   */
  async handOff(project: number, title = 'Ship'): Promise<{ id: number; go: string }> {
    const store = new Store(join(this.data, 'coordinator.db'));
    const id = store.createTicket({ project_id: project, title, permission_mode: 'default', created_by: 'Cara' }).id;
    const cwd = join(this.root, `worktree-${id}`);
    const go = join(this.root, `go-${id}`);
    mkdirSync(join(cwd, 'tools'), { recursive: true });
    writeFileSync(join(cwd, 'tools', 'land.sh'), `[ "$1" = --check ] && exit 0
echo started
for i in $(seq 6000); do [ -e ${JSON.stringify(go)} ] && break; sleep 0.05; done
echo 'land: main is now at abc1234 "#${id}: ${title}"'
`);
    for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=Drill', '-c', 'user.email=drill@example.invalid', 'commit', '-qm', 'init']]) execFileSync('git', args, { cwd });
    store.setTicketDir(id, cwd, null);
    store.db.close();
    const res = await fetch(`${this.srv!.base}/api/tickets/${id}/land/handoff`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${agentToken(this.data, id)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ summary: title, risk: 'low', risk_reason: 'a drill', go: 'Drill, 2026-11-20 12:00 PST' }),
    });
    if (res.status !== 202) throw new Error(`hand-off refused: ${res.status} ${await res.text()}`);
    return { id, go };
  }

  /** The hand-off's folder: handoff.json until it is settled, handoff.done.json after. */
  landing(id: number) {
    return join(this.data, 'run', 'landings', String(id));
  }

  /** The shipped lines in a minion's chat. */
  /** Minions made straight in the database: no first turn, and no server needs to be up. */
  tickets(project: number, n: number): number[] {
    const store = new Store(join(this.data, 'coordinator.db'));
    try {
      return Array.from({ length: n }, (_, i) => store.createTicket({ project_id: project, title: `Drill ${i}`, permission_mode: 'default', created_by: 'Cara' }).id);
    } finally {
      store.db.close();
    }
  }

  shipped(id: number) {
    return this.notes(id).filter((n) => n.startsWith('Shipped abc1234'));
  }

  async cleanup() {
    this.fake.setRelease('ok');
    await this.srv?.stop({ keepTurns: true });
    this.srv = null;
    await stopTurns(this.root);
    rmSync(this.root, { recursive: true, force: true });
  }
}

/** An `until` that ran out of time, as opposed to a read or an assert that threw: only a timeout may count as a gap. */
export const timedOut = (e: unknown) => e instanceof Error && e.message.startsWith('Timed out waiting for');

/** Freeze or thaw a process: a stalled event loop that can't be told from a real one. */
export const signal = (pid: number, sig: NodeJS.Signals) => process.kill(pid, sig);

/** Whether a scope with a CPU quota can be made here (a user systemd manager with the cpu controller). */
export function canThrottle(): boolean {
  return spawnSync('systemd-run', ['--user', '--scope', '--quiet', '-p', 'CPUQuota=20%', '--', 'true'], { stdio: 'ignore', timeout: 10_000 }).status === 0;
}
