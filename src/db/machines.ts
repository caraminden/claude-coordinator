// Machines (the CI runners and computers people lend to schemes), their load samples and their jobs (#1313: src/db.ts by area).
import type { Machine, MachineJob, Store } from '../db.ts';

/** A row of machine_joins (src/db-schema.ts). */
export type MachineJoin = { id: number; code_hash: string; asker_id: number | null; created_by: string; owner_id: number | null; machine_id: number | null; created_at: number; expires_at: number; used_at: number | null; joined_id: number | null };
import { type Caps, type LegacyLend, legacyFromRoles, parseLegacyLend, ROLES, type Role, type RoleRow, rolesFromLegacy, runnerHost, type Ticks } from '../machine-roles.ts';

export const machineQueries = {
  listMachines(this: Store): Machine[] {
    return this.db.prepare('SELECT * FROM machines ORDER BY name').all() as unknown as Machine[];
  },

  getMachine(this: Store, id: number): Machine | undefined {
    return this.db.prepare('SELECT * FROM machines WHERE id = ?').get(id) as unknown as Machine | undefined;
  },

  /** The machines that are VMs on this computer (Build 10 H4), by name. */
  machineVms(this: Store, hostId: number): Machine[] {
    return this.listMachines().filter((m) => m.vm_of === hostId);
  },

  /**
   * Make a machine a VM on its host (Build 10 H4; Cara, 2026-11-26: "really just a capability of a machine"). It takes the
   * host's owner, so who manages it and whose turns get it follow the host; its own roles (what it lends, to which
   * schemes) stay its own, edited from the host's card. A machine is never its own host, nor a VM on a VM.
   * shortcut: the owner is copied here, not followed live; nothing changes a machine's owner after it is made today (a
   * person deleted clears both alike), so a future owner change must copy it to the host's VMs too.
   */
  linkMachineVm(this: Store, vmId: number, hostId: number): boolean {
    const r = this.db.prepare('UPDATE machines SET vm_of = ?2, owner_id = (SELECT owner_id FROM machines WHERE id = ?2) WHERE id = ?1 AND ?1 != ?2 AND (SELECT vm_of FROM machines WHERE id = ?2) IS NULL AND NOT EXISTS (SELECT 1 FROM machines WHERE vm_of = ?1)').run(vmId, hostId);
    return Number(r.changes) > 0;
  },

  /** A join code for Connect a computer (Build 7 M2, src/machine-join.ts), hashed; machineId: the row an Update reconnects. */
  addMachineJoin(this: Store, j: { codeHash: string; askerId: number | null; by: string; ownerId: number | null; machineId: number | null; at: number; expiresAt: number }): number {
    const { lastInsertRowid } = this.db.prepare('INSERT INTO machine_joins (code_hash, asker_id, created_by, owner_id, machine_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(j.codeHash, j.askerId, j.by, j.ownerId, j.machineId, j.at, j.expiresAt);
    return Number(lastInsertRowid);
  },

  machineJoin(this: Store, id: number): MachineJoin | undefined {
    return this.db.prepare('SELECT * FROM machine_joins WHERE id = ?').get(id) as unknown as MachineJoin | undefined;
  },

  /** Use a join code: the one unused, unexpired row with this hash, marked used in the same statement (so a code works once), or null. */
  takeMachineJoin(this: Store, codeHash: string, now: number): MachineJoin | null {
    return (this.db.prepare('UPDATE machine_joins SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING *').get(now, codeHash, now) as unknown as MachineJoin | undefined) ?? null;
  },

  /** The row a used code made or reconnected. */
  setMachineJoined(this: Store, id: number, machineId: number) {
    this.db.prepare('UPDATE machine_joins SET joined_id = ? WHERE id = ?').run(machineId, id);
  },

  /** Codes a day past their end, used or not: the panel that showed one is long closed. */
  pruneMachineJoins(this: Store, before: number) {
    this.db.prepare('DELETE FROM machine_joins WHERE expires_at < ?').run(before);
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

  /** Two rows that were one PC merged (Build 7 M2b): the one that goes keeps its CI load history on the kept one. */
  moveRunnerLoad(this: Store, from: number, into: number) {
    this.db.prepare('UPDATE runner_load SET machine_id = ? WHERE machine_id = ?').run(into, from);
  },

  pruneRunnerLoad(this: Store, before: number) {
    this.db.prepare('DELETE FROM runner_load WHERE at < ?').run(before);
  },

  /**
   * Every machine has an owner (Build 10 H1; Cara, 2026-11-26: "every machine should have an owner"). A row with none
   * (a shared one, #28 and #438, or one an older release added after a rollback) gets the person its created_by names
   * (their name or login, one person only), else whoever made the join code that connected it (machine_joins). It
   * keeps reaching the turns it reached while shared: each of its roles but Minion turns goes to every turn in its
   * schemes (caps.everyone, access.ts lendsToEveryone), and its owner can take that back. A row none of those name is
   * left without one and said, for a person to settle (it lends nothing meanwhile): an owner is never guessed. Every
   * boot (Store's constructor, after machineRoleTables); says what it did, for the deploy's notes.
   */
  /**
   * Every boot, after the owner backfill (which reads the flag): a CI runner host's row (#328, or one an older release made)
   * becomes one PC's row, as any other (Build 10 H6, "one kind of machine"). Its last_check loses the runners flag, and its
   * CI role's runner_host becomes runner_agent, which says only that a runner agent has connected there, so the next one
   * keeps its CI role's schemes as they are. Its roles, schemes and token stay. Says what it did, for the deploy's notes.
   */
  runnerHostRows(this: Store) {
    const rows = (this.db.prepare('SELECT id, name, last_check FROM machines ORDER BY id').all() as { id: number; name: string; last_check: string | null }[]).filter((m) => runnerHost(m.last_check) || this.machineRoles(m.id).some((r) => r.role === 'ci' && r.setup?.runner_host !== undefined));
    if (!rows.length) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const m of rows) {
        if (runnerHost(m.last_check)) this.db.prepare('UPDATE machines SET last_check = NULL WHERE id = ?').run(m.id);
        this.writeMachineRoles(m.id, (roles) =>
          roles.map((r) => {
            if (r.role !== 'ci' || r.setup?.runner_host === undefined) return r;
            const { runner_host: _, ...setup } = r.setup;
            return { ...r, setup: { ...setup, runner_agent: true } };
          }),
        );
        console.log(`Machines (H6): ${m.name} (row ${m.id}) was a CI runner host's row; it is one PC's row now, its CI role and schemes as they were.`);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  },

  machineOwners(this: Store) {
    const rows = this.db.prepare('SELECT id, name, created_by, scoped, last_check FROM machines WHERE owner_id IS NULL ORDER BY id').all() as { id: number; name: string; created_by: string; scoped: number; last_check: string | null }[];
    if (!rows.length) return;
    const users = this.listUsers();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const m of rows) {
        const by = m.created_by.trim().toLowerCase();
        const named = users.filter((u) => u.name.toLowerCase() === by || u.login.toLowerCase() === by);
        const join = this.db.prepare('SELECT owner_id, asker_id FROM machine_joins WHERE joined_id = ? AND machine_id IS NULL AND COALESCE(owner_id, asker_id) IN (SELECT id FROM users) ORDER BY id LIMIT 1').get(m.id) as { owner_id: number | null; asker_id: number | null } | undefined;
        const owner = named.length === 1 ? { id: named[0].id, why: `created_by "${m.created_by}"` } : join ? { id: (join.owner_id ?? join.asker_id)!, why: 'the join code that connected it' } : null;
        if (!owner) {
          console.log(`Machine owners (H1): ${m.name} (row ${m.id}) has no owner, and neither its created_by ("${m.created_by}") nor a join code names one person: left as it is, lending nothing, for a person to give it an owner or remove it.`);
          continue;
        }
        this.db.prepare('UPDATE machines SET owner_id = ? WHERE id = ?').run(owner.id, m.id);
        // A CI runner host from before #438 never given a list served every scheme an admin owns (machines.scoped 0,
        // which nothing reads any more): those go on its CI role's list.
        const adminOwned = !m.scoped && runnerHost(m.last_check) ? this.listProjects().flatMap((p) => (this.getUser(p.owner_id ?? -1)?.admin ? [p.id] : [])) : null;
        this.writeMachineRoles(m.id, (roles) => roles.map((r) => (r.role === 'turns' ? r : { ...r, caps: { ...r.caps, everyone: true }, ...(adminOwned && r.role === 'ci' ? { projects: adminOwned } : {}) })));
        const name = users.find((u) => u.id === owner.id)!.name;
        console.log(`Machine owners (H1): ${m.name} (row ${m.id}) is now ${name}'s, from ${owner.why}; its roles but Minion turns stay lent to every turn in their schemes.`);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  },

  /** A machine `ownerId` owns and manages (#306): every machine has one (Build 10 H1). It is lent to no scheme until some are added (#438). */
  createMachine(this: Store, name: string, tokenHash: string, by: string, ownerId: number): Machine {
    if (!Number.isInteger(ownerId)) throw new Error(`A machine needs an owner, not ${ownerId}`); // and the foreign key wants a real person
    const { lastInsertRowid } = this.db.prepare('INSERT INTO machines (name, token_hash, created_by, created_at, owner_id, scoped) VALUES (?, ?, ?, ?, ?, 1)').run(name, tokenHash, by, Date.now(), ownerId);
    return this.getMachine(Number(lastInsertRowid))!;
  },

  updateMachine(this: Store, id: number, fields: Partial<Pick<Machine, 'name' | 'token_hash' | 'token_sealed' | 'last_seen_at' | 'notes' | 'workspace_tools' | 'mcp_kind' | 'mcp_command' | 'always_on' | 'last_check' | 'lend' | 'jobs' | 'job_settings' | 'report' | 'priority'>>) {
    const { lend, ...rest } = fields;
    const keys = Object.keys(rest) as (keyof typeof rest)[];
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
    // An older release (a rollback) made it a CI runner host: the CI role goes on, lent where the machine was, as its runner
    // tokens were before roles (ci-runner.ts mayFetch); runnerHostRows makes it one PC's row again at the next boot.
    // A row with no role rows yet reads its CI setup as runner_host (rolesFromLegacy), which this release never keeps.
    if (keys.includes('last_check') && runnerHost(rest.last_check ?? null) && !this.machineRoles(id).find((r) => r.role === 'ci')?.setup?.runner_agent) {
      this.writeMachineRoles(id, (roles) =>
        roles.map((r) => {
          if (r.role !== 'ci') return r;
          const { runner_host: _, ...setup } = r.setup ?? {};
          return { ...r, on: true, projects: r.on ? r.projects : legacyFromRoles(roles).projects, setup: { ...setup, runner_agent: true } };
        }),
      );
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

  /**
   * A person joined or made a scheme, or one was made that they see (an admin): each PC of theirs with CI on serves it too, as a role switched on goes to every scheme
   * they are in (Josh, "Every scheme you're in"; #2064: so a scheme made later gets runners with no one asking). A scheme
   * they untick later stays unticked: this runs only as they join.
   */
  lendCiToJoined(this: Store, projectId: number, userId: number) {
    for (const m of this.listMachines()) {
      if (m.owner_id !== userId) continue;
      const ci = this.machineRoles(m.id).find((r) => r.role === 'ci');
      if (ci?.on && !ci.projects.includes(projectId)) this.writeMachineRoles(m.id, (roles) => roles.map((r) => (r.role === 'ci' ? { ...r, projects: [...r.projects, projectId] } : r)));
    }
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

  /**
   * Save the one list (#438: the Machines page from before roles, a lend card): what it adds goes to every role that's
   * on, what it drops comes off every role. Only the change: a role's own list is otherwise kept, so lending Tools to one
   * more scheme doesn't hand CI's or GPU jobs' schemes to the rest.
   */
  setMachineProjects(this: Store, machineId: number, projectIds: number[]) {
    const was = new Set(this.machineProjects(machineId));
    const want = new Set(projectIds);
    const added = [...want].filter((id) => !was.has(id));
    this.writeMachineRoles(machineId, (roles) => roles.map((r) => ({ ...r, projects: [...new Set([...r.projects.filter((id) => want.has(id) || !was.has(id)), ...(r.on ? added : [])])] })), true);
  },

  /**
   * Change one role: switch it, give its schemes (the whole list), merge caps (null clears one) or set its setup.
   * Switched on with no list, a role keeps the list it had, or with none is lent to `everyScheme` (the schemes its
   * owner is in: the caller finds them). Returns its roles after.
   */
  setMachineRole(this: Store, machineId: number, role: Role, change: { on?: boolean; projects?: number[]; caps?: Record<string, number | null | Ticks | true>; setup?: Record<string, unknown> | null; everyScheme?: number[] }): RoleRow[] {
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
   * The one write of a machine's roles: a row for each of ROLES and their lists, then the old columns from them (lend,
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
