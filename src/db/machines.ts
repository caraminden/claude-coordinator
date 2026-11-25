// Machines (the CI runners and computers people lend to schemes), their load samples and their jobs (#1313: src/db.ts by area).
import type { Machine, MachineJob, Store } from '../db.ts';

export const machineQueries = {
  listMachines(this: Store): Machine[] {
    return this.db.prepare('SELECT * FROM machines ORDER BY name').all() as unknown as Machine[];
  },

  getMachine(this: Store, id: number): Machine | undefined {
    return this.db.prepare('SELECT * FROM machines WHERE id = ?').get(id) as unknown as Machine | undefined;
  },

  /** A CI runner agent's load sample (#534), as JSON. */
  addRunnerLoad(this: Store, machineId: number, at: number, data: string) {
    this.db.prepare('INSERT INTO runner_load (machine_id, at, data) VALUES (?, ?, ?)').run(machineId, at, data);
  },

  /** Many samples in one commit (CiLoad's buffer, #791); one whose machine has since been deleted is dropped. */
  addRunnerLoads(this: Store, rows: { machine: number; at: number; data: string }[]) {
    const ins = this.db.prepare('INSERT INTO runner_load (machine_id, at, data) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM machines WHERE id = ?)');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const r of rows) ins.run(r.machine, r.at, r.data, r.machine);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  },

  /** Every agent's samples from `since` on, oldest first. */
  runnerLoadSince(this: Store, since: number): { machine_id: number; at: number; data: string }[] {
    return this.db.prepare('SELECT machine_id, at, data FROM runner_load WHERE at >= ? ORDER BY at').all(since) as { machine_id: number; at: number; data: string }[];
  },

  pruneRunnerLoad(this: Store, before: number) {
    this.db.prepare('DELETE FROM runner_load WHERE at < ?').run(before);
  },

  /** A machine `ownerId` manages (#306), or a shared one with none. It is lent to no scheme until some are added (#438). */
  createMachine(this: Store, name: string, tokenHash: string, by: string, ownerId: number | null = null): Machine {
    const { lastInsertRowid } = this.db.prepare('INSERT INTO machines (name, token_hash, created_by, created_at, owner_id, scoped) VALUES (?, ?, ?, ?, ?, 1)').run(name, tokenHash, by, Date.now(), ownerId);
    return this.getMachine(Number(lastInsertRowid))!;
  },

  updateMachine(this: Store, id: number, fields: Partial<Pick<Machine, 'name' | 'token_hash' | 'token_sealed' | 'last_seen_at' | 'notes' | 'workspace_tools' | 'mcp_kind' | 'mcp_command' | 'always_on' | 'last_check' | 'lend' | 'jobs' | 'job_settings'>>) {
    const keys = Object.keys(fields) as (keyof typeof fields)[];
    if (!keys.length) return;
    this.db.prepare(`UPDATE machines SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k] ?? null), id);
  },

  /** A new job (#857); returns it. */
  addMachineJob(
    this: Store,
    j: Omit<MachineJob, 'id' | 'go' | 'go_by' | 'paused_by' | 'card' | 'input_token_hash' | 'started_at' | 'ended_at' | 'run_s' | 'server_run_s' | 'gpu_busy_s' | 'live' | 'live_at' | 'exit_code' | 'error' | 'outputs' | 'upload_bytes' | 'swept_at'> & Partial<Pick<MachineJob, 'go' | 'go_by'>>,
  ): MachineJob {
    const keys = Object.keys(j) as (keyof typeof j)[];
    const { lastInsertRowid } = this.db.prepare(`INSERT INTO machine_jobs (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map((k) => j[k] ?? null));
    return this.getMachineJob(Number(lastInsertRowid))!;
  },

  getMachineJob(this: Store, id: number): MachineJob | undefined {
    return this.db.prepare('SELECT * FROM machine_jobs WHERE id = ?').get(id) as unknown as MachineJob | undefined;
  },

  updateMachineJob(this: Store, id: number, fields: Partial<Omit<MachineJob, 'id' | 'machine_id' | 'project_id' | 'kind' | 'kind_hash' | 'created_at'>>) {
    const keys = Object.keys(fields) as (keyof typeof fields)[];
    if (!keys.length) return;
    this.db.prepare(`UPDATE machine_jobs SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k] ?? null), id);
  },

  /** Jobs matching one of these: a machine's, a minion's, a contraption's, or in some states; newest first, at most `limit`. */
  machineJobs(this: Store, where: { machine?: number; ticket?: number; contraption?: number; states?: readonly string[]; endedBefore?: number }, limit = 100): MachineJob[] {
    const conds: string[] = [];
    const args: (number | string)[] = [];
    if (where.machine !== undefined) {
      conds.push('machine_id = ?');
      args.push(where.machine);
    }
    if (where.ticket !== undefined) {
      conds.push('ticket_id = ?');
      args.push(where.ticket);
    }
    if (where.contraption !== undefined) {
      conds.push('contraption_id = ?');
      args.push(where.contraption);
    }
    if (where.states) {
      conds.push(`state IN (${where.states.map(() => '?').join(', ')})`);
      args.push(...where.states);
    }
    if (where.endedBefore !== undefined) {
      conds.push('ended_at < ? AND swept_at IS NULL');
      args.push(where.endedBefore);
    }
    return this.db.prepare(`SELECT * FROM machine_jobs ${conds.length ? `WHERE ${conds.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`).all(...args, limit) as unknown as MachineJob[];
  },

  /** The bytes of job results a scheme holds on this server now (#857): what the 20 GB cap counts. */
  jobResultBytes(this: Store, projectId: number): number {
    return (this.db.prepare('SELECT COALESCE(SUM(upload_bytes), 0) AS n FROM machine_jobs WHERE project_id = ? AND swept_at IS NULL').get(projectId) as { n: number }).n;
  },

  /** The standing go for a kind on a machine (#857), or undefined. */
  jobKind(this: Store, machineId: number, hash: string): { machine_id: number; hash: string; name: string; recipe: string; allowed_by: string; at: number } | undefined {
    return this.db.prepare('SELECT * FROM machine_job_kinds WHERE machine_id = ? AND hash = ?').get(machineId, hash) as ReturnType<typeof machineQueries.jobKind>;
  },

  allowJobKind(this: Store, machineId: number, hash: string, name: string, recipe: string, by: string) {
    this.db.prepare('INSERT OR REPLACE INTO machine_job_kinds (machine_id, hash, name, recipe, allowed_by, at) VALUES (?, ?, ?, ?, ?, ?)').run(machineId, hash, name, recipe, by, Date.now());
  },

  /** Take back a standing go; false if there was none. */
  forgetJobKind(this: Store, machineId: number, hash: string): boolean {
    return this.db.prepare('DELETE FROM machine_job_kinds WHERE machine_id = ? AND hash = ?').run(machineId, hash).changes > 0;
  },

  /** A machine's standing goes, newest first. */
  jobKinds(this: Store, machineId: number): { hash: string; name: string; recipe: string; allowed_by: string; at: number }[] {
    return this.db.prepare('SELECT hash, name, recipe, allowed_by, at FROM machine_job_kinds WHERE machine_id = ? ORDER BY at DESC').all(machineId) as ReturnType<typeof machineQueries.jobKinds>;
  },

  /** The schemes a machine is lent to. */
  machineProjects(this: Store, machineId: number): number[] {
    return (this.db.prepare('SELECT project_id FROM machine_projects WHERE machine_id = ? ORDER BY project_id').all(machineId) as { project_id: number }[]).map((r) => r.project_id);
  },

  machineGranted(this: Store, machineId: number, projectId: number): boolean {
    return !!this.db.prepare('SELECT 1 FROM machine_projects WHERE machine_id = ? AND project_id = ?').get(machineId, projectId);
  },

  /** Lend a machine to exactly these schemes. */
  setMachineProjects(this: Store, machineId: number, projectIds: number[]) {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM machine_projects WHERE machine_id = ?').run(machineId);
      const add = this.db.prepare('INSERT OR IGNORE INTO machine_projects (machine_id, project_id) VALUES (?, ?)');
      for (const id of projectIds) add.run(machineId, id);
      // Only a CI runner host from before #438 is still unscoped; giving it a list ends "every scheme an admin owns" for it.
      this.db.prepare('UPDATE machines SET scoped = 1 WHERE id = ?').run(machineId);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  },

  deleteMachine(this: Store, id: number) {
    this.db.prepare('DELETE FROM machines WHERE id = ?').run(id);
  },
};
