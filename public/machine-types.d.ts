// The machines' API shapes (Build 7, worker machines): the Machines page, its panels, the Workers tile's machine rows and
// the Runs on mark. Kept apart from types.d.ts, which re-exports them, so that file's size budget holds.
import type { WorkerLimit, WorkersTile } from './types.js';

/** A machine's row on the Workers tile (src/turn-line.ts machinePools, src/routes/workers.ts). */
export interface WorkerMachine {
  id: number;
  name: string;
  owner: string | null;
  mine: boolean;
  used: number;
  size: number;
  cap: number;
  pool: WorkersTile['pool'];
  min: number;
  max: number;
  waiting: number;
  block: string | null;
  priority: number | null;
  balanced: string | null;
  away: number | null;
  pressed: string | null;
  limits: WorkerLimit[];
}

/** One place on the tile: perigee (id 0) or a machine. */
export type WorkerPlace = Pick<WorkerMachine, 'id' | 'name' | 'used' | 'size' | 'pool' | 'limits'>;

// The role cards and worker row.

/** A role's name on a machine (src/machine-roles.ts Role). */
export type MachineRoleKey = 'tools' | 'screen' | 'ci' | 'turns' | 'gpu';

/** The caps an owner sets on a role's card (src/machine-roles.ts Caps, without the Tools ticks machines.ts view takes out). */
export interface MachineRoleCaps {
  workers?: number;
  runners?: number;
  threads?: number;
  memory_gb?: number;
  disk_gb?: number;
}

/** One role of a machine as its row's cards read it (src/machines.ts view `roles`, src/machine-roles.ts RoleRow plus its name). */
export interface MachineRole {
  role: MachineRoleKey;
  name: string;
  on: boolean;
  caps: MachineRoleCaps;
  setup: Record<string, unknown> | null;
  projects: number[];
}

/** A worker's caps (src/worker-join.ts WorkerCaps). */
export interface MachineWorkerCaps {
  workers: number;
  threads: number;
  memory_gb: number;
  disk_gb: number;
}

/** One line of a worker's self-test (src/worker-join.ts CheckLine). */
export interface MachineCheckLine {
  key: string;
  name: string;
  state: 'waiting' | 'running' | 'ok' | 'fail';
  text: string;
}

/** A worker's self-test (src/worker-join.ts SelfTest). */
export interface MachineSelfTest {
  id: string;
  at: number;
  done: number | null;
  ok: boolean;
  why: string | null;
  lines: MachineCheckLine[];
}

/** A folder its owner lets marked minions use (src/host-reach.ts HostFolder). */
export interface MachineFolder {
  name: string;
  path: string;
  write: boolean;
  ready: boolean;
}

/** A program its owner lets marked minions start (src/host-reach.ts HostProgram). */
export interface MachineProgram {
  name: string;
  path: string;
  about: string;
  args: boolean;
}

/** A machine's minion-turn worker as its row shows it (src/worker-join.ts WorkerView). */
export interface MachineWorker {
  on: boolean;
  here: boolean;
  seen: number | null;
  host: string | null;
  wsl: boolean;
  caps: MachineWorkerCaps | null;
  image: { state: 'ready' | 'building' | 'failed' | 'own'; text: string } | null;
  claude: string | null;
  claude_wanted: string | null;
  signed_in: boolean | null;
  github: boolean | null;
  disk_gb: number | null;
  full: boolean;
  folders: MachineFolder[] | null;
  folder_problems: string[];
  test: MachineSelfTest | null;
  passed: number | null;
  twice: boolean;
}

/** What a machine's agent last reported about its PC (src/machine-join.ts MachineReport). */
export interface MachineReport {
  host: string;
  os: 'windows' | 'linux' | 'macos';
  os_name: string;
  wsl: { present: boolean; version: string | null } | null;
  in_wsl: boolean;
  threads: number;
  memory_gb: number;
  disk_free_gb: number | null;
  gpu: string | null;
  screen: boolean | null;
  admin: boolean | null;
  agent: number;
}

/** A machine as the Machines page gets it (src/machines.ts view, GET api/machines and the `machines` stream message): the fields the role cards and worker row read. */
export interface MachineRow {
  id: number;
  name: string;
  owner_id: number | null;
  online: boolean;
  status: 'ready' | 'fix' | 'down' | 'asleep' | 'checking';
  reason: string;
  last_seen_at: number | null;
  token_showable: boolean;
  /** The schemes it is lent to: its list. */
  projects: number[];
  /** A CI runner host's row. */
  runners: boolean;
  roles?: MachineRole[];
  /** The roles Pause all switched off; null when it isn't paused. */
  paused: MachineRoleKey[] | null;
  priority: number | null;
  worker: MachineWorker | null;
  report: MachineReport | null;
  lend: { server: string | null; workspaces: string[] } | null;
  /** What its agent's jobs block lets jobs use, or null: no jobs there. */
  jobs: { gpu?: unknown } | null;
  workspaces: { name: string; tasks?: { name: string }[] }[];
  screen: { holder: { what: string; who: string; since: number | null } | null; line: unknown[] } | null;
  programs: MachineProgram[] | null;
  config_file: string | null;
  removing?: unknown;
  /** For the connect, merge and remove panels (src/machines.ts view). */
  created_at: number;
  /** Other rows its owner has for this PC (one hostname). */
  same_pc?: { id: number; name: string }[];
  /** A merge waiting on this row's runner agents connecting to the kept row (src/machine-merge.ts Merge). */
  merging?: { from: number; into: number; os: ('windows' | 'linux')[]; by: string; at: number } | null;
}

// The connect, merge, remove, set up and runs-on pages.

/** Where a join code stands (src/machine-join.ts joinState). */
export type MachineJoinState = 'waiting' | 'expired' | 'joined' | 'connected';

/** A join code just made (POST api/machines/joins, api/machines/:id/join: src/routes/machines.ts). */
export interface MachineJoin {
  id: number;
  code: string;
  expires_at: number;
  agent_url: string;
  /** Only on an Update's: the machine's own name. */
  name?: string;
}

/** A join code as watched (GET api/machines/joins/:id: src/routes/machines.ts). */
export interface MachineJoinLook {
  id: number;
  expires_at: number;
  state: MachineJoinState;
  machine: MachineRow | null;
}

/** A merge's lines to paste (POST api/machines/:id/merge: src/routes/machine-merge.ts lines). */
export interface MachineMergeLines {
  into: { id: number; name: string };
  from: { id: number; name: string };
  os: ('windows' | 'linux')[];
  token: string;
  agent_url: string;
}

/** What takes a removed worker off its PC, by shell (src/machine-away.ts UNINSTALL). */
export interface MachineUninstall {
  powershell: string;
  bash: string;
}

/** The answer to DELETE api/machines/:id (src/routes/machines.ts): a 202 carries removing. */
export interface MachineRemoveReply {
  removing?: boolean;
  uninstall: MachineUninstall;
}

/** A step of a role's Set up (src/role-setup.ts Step). */
export interface SetupStep {
  text: string;
  state: 'waiting' | 'running' | 'ok' | 'fail';
}

/** What a PC lacks that needs an administrator (src/role-setup.ts Admin). */
export interface SetupAdmin {
  needs: string[];
  pm: string | null;
}

/** A role's Set up or Test run, in the role's setup.run (src/role-setup.ts Run). */
export interface SetupRun {
  id: string;
  role: 'tools' | 'screen' | 'turns' | 'gpu';
  kind: 'setup' | 'test';
  at: number;
  by: string;
  done: number | null;
  ok: boolean | null;
  why: string | null;
  admin: SetupAdmin | null;
  worker_install: boolean;
  steps: SetupStep[];
  report: string | null;
  shot: number | null;
}

/** A minion's Runs on mark (src/runs-on.ts view). */
export interface RunsOnMark {
  on: string;
  /** Unset on the mark the page shows at once, before the server's answer. */
  machine?: number | null;
  by: string;
  at: number;
}

/** One computer a person could pick for Runs on, with why not (src/machine-pools.ts choices). */
export interface RunsOnChoice {
  id: number;
  name: string;
  why: string | null;
}
