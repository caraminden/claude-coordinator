// A machine's roles (Build 7 M1, specs/machine-connections.md section 8): what one PC lends, each role switched on or off
// and lent to its own schemes. The tables (machine_roles, machine_role_projects) are the truth; until the old columns
// are dropped in a later build, every write also rewrites machines.lend and machine_projects from them, so a rollback
// reads what this release had (legacyFromRoles). Pure: the store (src/db/machines.ts) reads and writes the rows.

/** The roles, in the order the Machines page shows them. */
export const ROLES = ['tools', 'screen', 'ci', 'turns', 'gpu'] as const;
export type Role = (typeof ROLES)[number];
/** The words people read for each role. */
export const ROLE_NAMES: Record<Role, string> = { tools: 'Tools and folders', screen: 'Windows screen', ci: 'CI runners', turns: 'Minion turns', gpu: 'GPU jobs' };

/**
 * Which MCP server and workspaces the Tools role lends (#439's ticks; machines.ts Lend), kept in its caps as `ticks`.
 * null: none ticked yet (an agent from before #439, or one that hasn't reported), which the agent's first report fills.
 */
export type Ticks = { server: string | null; workspaces: string[]; before_ticks?: true } | null;
/** The caps an owner sets on the page (M3): workers, runners, threads, memory and disk; whole numbers from 0. */
export const CAP_KEYS = ['workers', 'runners', 'threads', 'memory_gb', 'disk_gb'] as const;
export type Caps = Partial<Record<(typeof CAP_KEYS)[number], number>> & { ticks?: Ticks };

export type RoleRow = { role: Role; on: boolean; caps: Caps; setup: Record<string, unknown> | null; projects: number[] };
/** machines.lend as the releases before roles wrote and read it (machines.ts Lend). */
export type LegacyLend = { server: string | null; workspaces: string[]; gpu_off?: true; before_ticks?: true; worker?: true };

export const isRole = (v: unknown): v is Role => typeof v === 'string' && (ROLES as readonly string[]).includes(v);

/** machines.lend as stored, or null when it is empty or not one (an older release only ever wrote machines.ts cleanLend's shape). */
export function parseLegacyLend(text: string | null): LegacyLend | null {
  let v: unknown;
  try {
    v = text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (!(o.server === null || typeof o.server === 'string') || !Array.isArray(o.workspaces)) return null;
  return {
    server: o.server,
    workspaces: [...new Set(o.workspaces.filter((w): w is string => typeof w === 'string'))],
    ...(o.gpu_off === true ? { gpu_off: true as const } : {}),
    ...(o.before_ticks === true ? { before_ticks: true as const } : {}),
    ...(o.worker === true ? { worker: true as const } : {}),
  };
}

/** Whether a machine is a CI runner host (machines.last_check says runners, #328): what it lends is runner tokens. */
/**
 * The CI role's setup marks a runner host this release has seen (`runner_host`), so one an older release made is caught; and a
 * PC row a runner agent joined (`runner_agent`, M2b), so a flag an older release wrote for it there (a rollback) changes no role.
 */
export const runnerSeen = (roles: readonly RoleRow[]) => {
  const setup = roles.find((r) => r.role === 'ci')?.setup;
  return setup?.runner_host === true || setup?.runner_agent === true;
};
export const runnerHost = (lastCheck: string | null) => /"runners":true/.test(lastCheck ?? '');

/**
 * A machine's roles from the columns before roles (the migration, and the roles of a machine no row has been
 * written for yet): lend.server and lend.workspaces become the Tools role's ticks, lend.gpu_off the GPU switch,
 * lend.worker the Minion turns switch, a runner host's flag the CI switch; Windows screen is new and starts off.
 * Tools is on unless it is a runner host, which lends turns nothing. machine_projects, its one list, goes to every
 * role that's on, so every turn, tool and runner token goes where it went before.
 */
export function rolesFromLegacy(m: { lend: string | null; last_check: string | null }, projects: readonly number[]): RoleRow[] {
  const lend = parseLegacyLend(m.lend);
  const runners = runnerHost(m.last_check);
  const ticks: Ticks = lend ? { server: lend.server, workspaces: lend.workspaces, ...(lend.before_ticks ? { before_ticks: true as const } : {}) } : null;
  const on: Record<Role, boolean> = { tools: !runners, screen: false, ci: runners, turns: !!lend?.worker, gpu: !lend?.gpu_off };
  const list = [...new Set(projects)].sort((a, b) => a - b);
  return ROLES.map((role) => ({ role, on: on[role], caps: role === 'tools' ? { ticks } : {}, setup: role === 'ci' && runners ? { runner_host: true } : null, projects: on[role] ? [...list] : [] }));
}

/**
 * The old columns as a rollback reads them: lend from the Tools ticks and the GPU and Minion turns switches, and one
 * scheme list, every role that's on's together. A scheme's list per role is the newer shape, so an older release
 * lends the machine wherever any role that's on is lent.
 */
export function legacyFromRoles(roles: readonly RoleRow[]): { lend: LegacyLend | null; projects: number[] } {
  const by = (r: Role) => roles.find((x) => x.role === r);
  const ticks = by('tools')?.caps.ticks ?? null;
  const gpuOff = by('gpu')?.on === false;
  const worker = by('turns')?.on === true;
  const lend: LegacyLend | null = ticks || gpuOff || worker ? { ...(ticks ?? { server: null, workspaces: [], before_ticks: true as const }), ...(gpuOff ? { gpu_off: true as const } : {}), ...(worker ? { worker: true as const } : {}) } : null;
  const projects = [...new Set(roles.flatMap((r) => (r.on ? r.projects : [])))].sort((a, b) => a - b);
  return { lend, projects };
}

/** A lend the same as another, whatever the order of its keys and workspaces. */
export function sameLend(a: LegacyLend | null, b: LegacyLend | null): boolean {
  const key = (l: LegacyLend | null) => l && JSON.stringify([l.server, [...l.workspaces].sort(), !!l.gpu_off, !!l.before_ticks, !!l.worker]);
  return key(a) === key(b);
}

/**
 * A PATCH's caps for a role: whole numbers from 0 for the keys in CAP_KEYS, or null to clear one; anything else
 * throws its words. Ticks are not set here: they change through the machine's own PATCH (lend), which tells its agent.
 */
export function cleanCaps(input: unknown): Partial<Record<(typeof CAP_KEYS)[number], number | null>> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error('caps must be an object');
  const out: Partial<Record<(typeof CAP_KEYS)[number], number | null>> = {};
  for (const [k, v] of Object.entries(input)) {
    if (!(CAP_KEYS as readonly string[]).includes(k)) throw new Error(`caps can only set ${CAP_KEYS.join(', ')}`);
    if (v !== null && !(Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 1_000_000)) throw new Error(`caps.${k} must be a whole number from 0, or null`);
    out[k as (typeof CAP_KEYS)[number]] = v as number | null;
  }
  return out;
}
