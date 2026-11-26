// Machines (the CI runners and computers people lend to schemes), their load samples and their jobs (#1313: src/db.ts by area).
import type { Machine, MachineJob, Store } from '../db.ts';
import { type Caps, type LegacyLend, legacyFromRoles, parseLegacyLend, ROLES, type Role, type RoleRow, rolesFromLegacy, runnerHost, type Ticks } from '../machine-roles.ts';

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
    const { lend, ...rest } = fields;
    const keys = Object.keys(rest) as (keyof typeof rest)[];
    const wasRunner = keys.includes('last_check') && runnerHost(this.getMachine(id)?.last_check ?? null);
    if (keys.length) this.db.prepare(`UPDATE machines SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => rest[k] ?? null), id);
    // What it lends goes into its roles (the old column is written from them): the Tools ticks, and the GPU and Minion
    // turns switches. A switch turned on here gets the machine's one list, as the old column lent it.
    if (lend !== undefined) {
      const l = parseLegacyLend(lend);
      this.writeMachineRoles(id, (roles) => {
        const one = legacyFromRoles(roles).projects;
        const on = (r: RoleRow, v: boolean) => ({ ...r, on: v, projects: v && !r.on ? one : r.projects });
        return roles.map((r) => (r.role === 'tools' ? { ...r, caps: { ...r.caps, ticks: l ? { server: l.server, workspaces: l.workspaces, ...(l.before_ticks ? { before_ticks: true as const } : {}) } : null } } : r.role === 'gpu' ? on(r, !l?.gpu_off) : r.role === 'turns' ? on(r, !!l?.worker) : r));
      });
    }
    // It just became a CI runner host (added as one, or a runner agent connected with its key): the CI role goes on,
    // lent where the machine was, as its runner tokens were before roles (ci-runner.ts mayFetch).
    if (keys.includes('last_check') && !wasRunner && runnerHost(rest.last_check ?? null)) {
      this.writeMachineRoles(id, (roles) => roles.map((r) => (r.role === 'ci' && !r.on ? { ...r, on: true, projects: legacyFromRoles(roles).projects } : r)));
    }
  },

  /** A new job (#857); returns it. */
  addMachineJob(
    this: Store,
    j: Omit<MachineJob, 'id' | 'go' | 'go_by' | 'paused_by' | 'card' | 'input_token_hash' | 'started_at' | 'ended_at' | 'run_s' | 'server_run_s' | 'gpu_busy_s' | 'live' | 'live_at' | 'exit_code' | 'error' | 'outputs' | 'upload_bytes' | 'swept_at' | 'pause_failed'> & Partial<Pick<MachineJob, 'go' | 'go_by'>>,
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

  /**
   * A machine's roles (src/machine-roles.ts), every one of ROLES in order. A machine no role row was written for
   * yet (one made since the migration that nothing has changed) has the roles its old columns say.
   */
  machineRoles(this: Store, machineId: number): RoleRow[] {
    const rows = this.db.prepare('SELECT role, "on", caps, setup FROM machine_roles WHERE machine_id = ?').all(machineId) as { role: string; on: number; caps: string; setup: string | null }[];
    if (!rows.length) {
      // Migrated as it is read; the next write of its roles saves them (Store.machineRoleTables migrates every machine at boot).
      const m = this.getMachine(machineId);
      const old = (this.db.prepare('SELECT project_id FROM machine_projects WHERE machine_id = ?').all(machineId) as { project_id: number }[]).map((r) => r.project_id);
      return rolesFromLegacy({ lend: m?.lend ?? null, last_check: m?.last_check ?? null }, old);
    }
    const lists = this.db.prepare('SELECT role, project_id FROM machine_role_projects WHERE machine_id = ? ORDER BY project_id').all(machineId) as { role: string; project_id: number }[];
    const json = <T>(t: string | null, empty: T): T => {
      try {
        return t ? (JSON.parse(t) as T) : empty;
      } catch {
        return empty;
      }
    };
    return ROLES.map((role) => {
      const r = rows.find((x) => x.role === role);
      return { role, on: !!r?.on, caps: json<Caps>(r?.caps ?? null, {}), setup: json<Record<string, unknown> | null>(r?.setup ?? null, null), projects: lists.filter((l) => l.role === role).map((l) => l.project_id) };
    });
  },

  /** Whether this role of the machine is switched on and lent to the scheme (access.ts lendsRole adds who asked). */
  roleGrants(this: Store, machineId: number, role: Role, projectId: number): boolean {
    const r = this.machineRoles(machineId).find((x) => x.role === role)!;
    return r.on && r.projects.includes(projectId);
  },

  /** What a machine lends, as machines.ts Lend has it (its Tools ticks and its GPU and Minion turns switches), from its roles. */
  machineLend(this: Store, machineId: number): LegacyLend | null {
    return legacyFromRoles(this.machineRoles(machineId)).lend;
  },

  /** The schemes any of a machine's roles that's on is lent to: its one list as the Machines page's lending list shows it. */
  machineProjects(this: Store, machineId: number): number[] {
    return legacyFromRoles(this.machineRoles(machineId)).projects;
  },

  machineGranted(this: Store, machineId: number, projectId: number): boolean {
    return this.machineProjects(machineId).includes(projectId);
  },

  /** Lend a machine to exactly these schemes: the one list (#438), so every role that's on gets it. */
  setMachineProjects(this: Store, machineId: number, projectIds: number[]) {
    this.writeMachineRoles(machineId, (roles) => roles.map((r) => (r.on ? { ...r, projects: [...projectIds] } : r)), true);
  },

  /**
   * Change one role: switch it, give its schemes (the whole list), merge caps (null clears one) or set its setup.
   * Switched on with no list, a role keeps the list it had, or with none is lent to `everyScheme` (the schemes its
   * owner is in: the caller finds them). Returns its roles after.
   */
  setMachineRole(this: Store, machineId: number, role: Role, change: { on?: boolean; projects?: number[]; caps?: Record<string, number | null | Ticks>; setup?: Record<string, unknown> | null; everyScheme?: number[] }): RoleRow[] {
    return this.writeMachineRoles(
      machineId,
      (roles) =>
        roles.map((r) => {
          if (r.role !== role) return r;
          const on = change.on ?? r.on;
          const caps: Caps = { ...r.caps };
          for (const [k, v] of Object.entries(change.caps ?? {})) {
            if (v === null && k !== 'ticks') delete (caps as Record<string, unknown>)[k];
            else (caps as Record<string, unknown>)[k] = v;
          }
          const projects = change.projects ?? (on && !r.on && !r.projects.length ? (change.everyScheme ?? []) : r.projects);
          return { ...r, on, caps, projects: [...new Set(projects)], ...(change.setup !== undefined ? { setup: change.setup } : {}) };
        }),
      change.projects !== undefined,
    );
  },

  /**
   * The one write of a machine's roles: all five rows and their lists, then the old columns from them (lend,
   * machine_projects, and scoped once a person gave a list: `listed`), so an older release reads the same (machine-roles.ts legacyFromRoles).
   */
  writeMachineRoles(this: Store, machineId: number, change: (roles: RoleRow[]) => RoleRow[], listed = false): RoleRow[] {
    // Inside the boot migration's own transaction it joins that one.
    const own = !this.db.isTransaction;
    if (own) this.db.exec('BEGIN IMMEDIATE');
    try {
      const roles = change(this.machineRoles(machineId));
      this.db.prepare('DELETE FROM machine_roles WHERE machine_id = ?').run(machineId);
      this.db.prepare('DELETE FROM machine_role_projects WHERE machine_id = ?').run(machineId);
      const role = this.db.prepare('INSERT INTO machine_roles (machine_id, role, "on", caps, setup) VALUES (?, ?, ?, ?, ?)');
      const list = this.db.prepare('INSERT OR IGNORE INTO machine_role_projects (machine_id, role, project_id) SELECT ?, ?, id FROM projects WHERE id = ?');
      for (const r of roles) {
        role.run(machineId, r.role, r.on ? 1 : 0, JSON.stringify(r.caps), r.setup === null ? null : JSON.stringify(r.setup));
        for (const p of r.projects) list.run(machineId, r.role, p);
      }
      const old = legacyFromRoles(this.machineRoles(machineId));
      this.db.prepare('UPDATE machines SET lend = ? WHERE id = ?').run(old.lend ? JSON.stringify(old.lend) : null, machineId);
      this.db.prepare('DELETE FROM machine_projects WHERE machine_id = ?').run(machineId);
      const add = this.db.prepare('INSERT INTO machine_projects (machine_id, project_id) VALUES (?, ?)');
      for (const id of old.projects) add.run(machineId, id);
      // Only a CI runner host from before #438 is still unscoped; giving it a list, even an empty one, ends "every scheme an admin owns" for it.
      if (listed) this.db.prepare('UPDATE machines SET scoped = 1 WHERE id = ?').run(machineId);
      if (own) this.db.exec('COMMIT');
      return this.machineRoles(machineId);
    } catch (err) {
      if (own) this.db.exec('ROLLBACK');
      throw err;
    }
  },

  deleteMachine(this: Store, id: number) {
    this.db.prepare('DELETE FROM machines WHERE id = ?').run(id);
  },
};
