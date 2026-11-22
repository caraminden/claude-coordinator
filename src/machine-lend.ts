// propose_machine_lend (#1638; Cara, 2026-11-22, picked "Propose, card, link", "Who can save the page", "Both", and
// "Machine switches"): a minion or Taskmaster asks for a machine's lending to change, a card in its chat shows the change,
// and Approve saves it through the Machines page's own PATCH (patchMachine), so the agent is told and sessions on what is
// no longer lent end exactly as a page save does. The card keeps the change, not a copy of the old ticks: Approve applies
// it to the machine as it is then, so a tick made on the page in between isn't undone.
import { SERVER_NAME, WORKSPACE_NAME, type Lend } from './machines.ts';

/** What a proposal changes. Each field left out stays as it is. */
export type LendChange = {
  /** Put the proposing scheme on the machine's list (true) or take it off (false). */
  here?: boolean;
  /** Workspaces (folders) to tick and to untick. */
  tick?: string[];
  untick?: string[];
  /** The MCP server to lend, or null to untick it. */
  server?: string | null;
  /** The switches: workspace tools (an agent from before ticks) and always on. */
  workspace_tools?: boolean;
  always_on?: boolean;
  /** The GPU jobs switch (#1175): false refuses GPU tasks and stops one running. */
  gpu?: boolean;
};

/** The machine's state a change applies to: what the Machines page shows. */
export type MachineNow = { projects: number[]; lend: Lend | null; workspace_tools: boolean; always_on: boolean; managed?: boolean | null };

const names = (v: unknown, what: string): string[] | undefined => {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length > 50 || !v.every((w) => typeof w === 'string' && WORKSPACE_NAME.test(w))) throw new Error(`${what} must be a list of workspace names, as list_machines shows them`);
  return [...new Set(v as string[])];
};
const bool = (v: unknown, what: string): boolean | undefined => {
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') throw new Error(`${what} must be true or false`);
  return v;
};

/** A proposal's change from the tool's arguments; throws a message for the caller on anything malformed. */
export function parseLendChange(body: any): LendChange {
  const change: LendChange = {};
  const here = bool(body.here, 'here');
  if (here !== undefined) change.here = here;
  const tick = names(body.tick, 'tick');
  const untick = names(body.untick, 'untick');
  if (tick?.length) change.tick = tick;
  if (untick?.length) change.untick = untick;
  if (tick && untick && tick.some((w) => untick.includes(w))) throw new Error('A workspace is in both tick and untick');
  if (body.server !== undefined) {
    if (body.server !== null && !(typeof body.server === 'string' && SERVER_NAME.test(body.server))) throw new Error('server must be an MCP server\'s name, as list_machines shows it, or null to untick it');
    change.server = body.server;
  }
  for (const k of ['workspace_tools', 'always_on', 'gpu'] as const) {
    const v = bool(body[k], k);
    if (v !== undefined) change[k] = v;
  }
  return change;
}

/** The Machines page's PATCH body that makes a change on the machine as it is now: only the fields that would differ, so {} is nothing to do. */
export function lendPatch(change: LendChange, now: MachineNow, schemeId: number): { projects?: number[]; lend?: Lend; workspace_tools?: boolean; always_on?: boolean } {
  const patch: ReturnType<typeof lendPatch> = {};
  if (change.here !== undefined && change.here !== now.projects.includes(schemeId)) {
    patch.projects = change.here ? [...now.projects, schemeId] : now.projects.filter((id) => id !== schemeId);
  }
  const gpuFlip = change.gpu !== undefined && change.gpu === !!now.lend?.gpu_off;
  if (now.managed === false) {
    // An agent from before ticks: the page's GPU switch saves only that (public/settings-machines.js).
    if (gpuFlip) patch.lend = { server: null, workspaces: [], before_ticks: true, ...(change.gpu ? {} : { gpu_off: true as const }) };
  } else if (change.tick || change.untick || change.server !== undefined || gpuFlip) {
    // As a tick on the page does: the stored lend with this change, keeping its GPU switch unless the change sets it.
    const { before_ticks: _, gpu_off: off, ...base } = now.lend ?? { server: null, workspaces: [] };
    const workspaces = [...base.workspaces.filter((w) => !change.untick?.includes(w)), ...(change.tick ?? []).filter((w) => !base.workspaces.includes(w))];
    const server = change.server !== undefined ? change.server : base.server;
    const gpuOff = change.gpu !== undefined ? !change.gpu : !!off;
    if (server !== base.server || workspaces.length !== base.workspaces.length || workspaces.some((w) => !base.workspaces.includes(w)) || gpuOff !== !!off || now.lend?.before_ticks) {
      patch.lend = { ...base, server, workspaces, ...(gpuOff ? { gpu_off: true as const } : {}) };
    }
  }
  for (const k of ['workspace_tools', 'always_on'] as const) if (change[k] !== undefined && change[k] !== now[k]) patch[k] = change[k];
  return patch;
}

/** The change in words, one line each, for the card and its notification: what differs from now, and what it lends after. */
export function lendLines(change: LendChange, now: MachineNow, scheme: { id: number; name: string }, machine: string): string[] {
  const patch = lendPatch(change, now, scheme.id);
  const lend = patch.lend ?? now.lend ?? { server: null, workspaces: [] };
  const was = now.lend ?? { server: null, workspaces: [] };
  const lines: string[] = [];
  if (patch.projects) lines.push(change.here ? `+ Lend ${machine} to ${scheme.name}` : `− Take ${machine} from ${scheme.name}: its minions lose it now, mid-turn too`);
  if (patch.lend) {
    for (const w of lend.workspaces.filter((w) => !was.workspaces.includes(w))) lines.push(`+ Tick the ${w} workspace`);
    for (const w of was.workspaces.filter((w) => !lend.workspaces.includes(w))) lines.push(`− Untick the ${w} workspace: every scheme it is lent to loses it`);
    if (lend.server !== was.server) lines.push(lend.server ? `+ Lend the ${lend.server} MCP server${was.server ? ` in place of ${was.server}` : ''}` : `− Untick the ${was.server} MCP server`);
    if (!!lend.gpu_off !== !!was.gpu_off) lines.push(lend.gpu_off ? '− Switch GPU jobs off: GPU tasks are refused and a running one stops' : '+ Switch GPU jobs on');
  }
  if (patch.workspace_tools !== undefined) lines.push(`${patch.workspace_tools ? '+ Switch workspace tools on' : '− Switch workspace tools off'}`);
  if (patch.always_on !== undefined) lines.push(patch.always_on ? '+ Always on: offline over 5 minutes shows as Down' : '− Not always on: offline shows as Asleep');
  return lines;
}

/** What the machine lends once a change is made, in one line: the check a person reads before approving. */
export function lendAfter(change: LendChange, now: MachineNow, schemeId: number): Lend {
  const patch = lendPatch(change, now, schemeId);
  return patch.lend ?? now.lend ?? { server: null, workspaces: [] };
}
