// Connect a computer with one command (Build 7 M2, specs/machine-connections.md section 2; Josh, 2026-11-25: "A · One
// command with a join code"). Any member presses Connect a computer and gets a command carrying a join code: one use,
// good for 15 minutes, kept here only hashed. The agent on that PC swaps it for its machine's own ccm_ token, which it
// keeps, and says what the PC can do; the row is named from its hostname. An Update code reconnects a row that exists
// (an agent from before reports nothing): the same swap, for that row, under its own name.
import { createHash, randomBytes } from 'node:crypto';
import type { Machine, Store } from './db.ts';
import type { MachineJoin } from './db/machines.ts';
import { HttpError } from './http.ts';
import { RESERVED_NAMES, WS_SUFFIX } from './machines.ts';

/** The newest agent version (public/machine-agent.mjs AGENT_VERSION, which test/machine-join.test.ts pins this to): a row whose agent reports less, or nothing, offers Update. */
export const LATEST_AGENT = 5;
/** Whether a connected agent's report says it is from before: none, or an older version. */
export const agentIsOld = (report: Pick<MachineReport, 'agent'> | null | undefined): boolean => !report || report.agent < LATEST_AGENT;
/** How long a code works (the spec: 15 minutes, one use). */
export const JOIN_MS = 15 * 60_000;

// No 0, 1, I or O: a code read off a screen and typed has nothing to mix up.
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
export const JOIN_CODE = /^cj_[2-9A-HJ-NP-Z]{12}$/;

/** A new code: 12 letters of 32, 60 bits, which a 15-minute single use never needs more than. */
export function newJoinCode(): string {
  return `cj_${[...randomBytes(12)].map((b) => ALPHABET[b & 31]).join('')}`;
}

export const hashJoinCode = (code: string) => createHash('sha256').update(code).digest('hex');

/** What a machine's agent says its PC can do (public/machine-agent.mjs machineReport), as kept and shown. */
export type MachineReport = {
  host: string;
  os: 'windows' | 'linux' | 'macos';
  /** "Windows 11", "Ubuntu 24.04.1 LTS", "macOS 14.5". */
  os_name: string;
  /** Windows: WSL there, and its version ("2.3.26"); null when it isn't. Linux: whether the agent itself runs inside WSL. */
  wsl: { present: boolean; version: string | null } | null;
  in_wsl: boolean;
  threads: number;
  memory_gb: number;
  disk_free_gb: number | null;
  gpu: string | null;
  /** A signed-in desktop: what the Windows screen role needs. Null: the agent couldn't tell. */
  screen: boolean | null;
  /** The person running it can become an administrator (UAC, sudo): what CI's setup needs once. */
  admin: boolean | null;
  /** Windows: Hyper-V there, and its VMs' names (null: Hyper-V is there but the agent may not list them). Null off Windows or from an older agent. */
  hyperv: { present: boolean; vms: string[] | null } | null;
  /** The agent's own version (an agent that reports nothing is from before, and its row offers Update). */
  agent: number;
};

const text = (v: unknown, n: number) =>
  typeof v === 'string'
    ? v
        .replace(/[\x00-\x1f\x7f]/g, '')
        .trim()
        .slice(0, n)
    : '';
const count = (v: unknown, max: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(Math.round(v * 10) / 10, max) : null);
const flag = (v: unknown) => (typeof v === 'boolean' ? v : null);

/** An agent's report as kept: known keys only, each bounded; null when it isn't one. */
export function cleanReport(v: unknown): MachineReport | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  const os = r.os === 'windows' || r.os === 'linux' || r.os === 'macos' ? r.os : null;
  if (!os) return null;
  const w = r.wsl && typeof r.wsl === 'object' ? (r.wsl as Record<string, unknown>) : null;
  const hv = r.hyperv && typeof r.hyperv === 'object' ? (r.hyperv as Record<string, unknown>) : null;
  return {
    host: text(r.host, 100),
    os,
    os_name: text(r.os_name, 80),
    wsl: w ? { present: w.present === true, version: text(w.version, 40) || null } : null,
    in_wsl: r.in_wsl === true,
    threads: count(r.threads, 4096) ?? 0,
    memory_gb: count(r.memory_gb, 65_536) ?? 0,
    disk_free_gb: count(r.disk_free_gb, 1_000_000),
    gpu: text(r.gpu, 120) || null,
    screen: flag(r.screen),
    admin: flag(r.admin),
    hyperv: hv ? { present: hv.present === true, vms: Array.isArray(hv.vms) ? [...new Set(hv.vms.map((n) => text(n, 100)).filter(Boolean))].slice(0, 50) : null } : null,
    agent: Number.isInteger(r.agent) ? Math.min(r.agent as number, 1_000_000) : 0,
  };
}

export const storedReport = (m: Pick<Machine, 'report'>): MachineReport | null => {
  try {
    return m.report ? cleanReport(JSON.parse(m.report)) : null;
  } catch {
    return null;
  }
};

/**
 * A machine name from a hostname, as the Machines page takes them (lowercase letters, digits and dashes, 30 at most):
 * DESKTOP-JOSH is desktop-josh, and a name another row has gets -2, -3 and on.
 */
export function nameFromHost(host: string, taken: (name: string) => boolean): string {
  const base =
    host
      .toLowerCase()
      .replace(/\..*$/, '') // a domain after the first dot is the network's, not the PC's
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/-{2,}/g, '-')
      .slice(0, 30)
      .replace(/-+$/, '') || 'computer';
  if (!taken(base)) return base;
  for (let n = 2; ; n++) {
    const name = `${base.slice(0, 30 - String(n).length - 1).replace(/-+$/, '')}-${n}`;
    if (!taken(name)) return name;
  }
}

/** Make a code for `asker`: a new row owned by `ownerId`, or an Update of `machine`. Returns its id and the code, shown once. */
export function makeJoin(store: Store, asker: { uid: number | null; name: string }, ownerId: number | null, machine: Machine | null, now = Date.now()) {
  store.pruneMachineJoins(now - 24 * 3600_000);
  const code = newJoinCode();
  const id = store.addMachineJoin({ codeHash: hashJoinCode(code), askerId: asker.uid, by: asker.name, ownerId: machine ? machine.owner_id : ownerId, machineId: machine?.id ?? null, at: now, expiresAt: now + JOIN_MS });
  return { id, code, expires_at: now + JOIN_MS };
}

/** Where a code stands, for the panel that showed it: waiting, too old, used (its agent not connected yet) or connected: `connected`, its row's agent online and reporting since the code was used. */
export function joinState(join: MachineJoin, connected: boolean, now = Date.now()): 'waiting' | 'expired' | 'joined' | 'connected' {
  if (join.used_at === null) return now >= join.expires_at ? 'expired' : 'waiting';
  return connected ? 'connected' : 'joined';
}

/**
 * Swap a code for a token (the agent's POST /api/machines/join): the code is used in the same statement that finds it,
 * so a second try with it is refused. A new row is named from the hostname and owned by whoever made the code; an
 * Update's row gets a new token, which the new agent's service replaces the old one's with.
 */
export function redeemJoin(store: Store, issueToken: (machineId: number) => string, body: Record<string, unknown>, now = Date.now(), removing: (machineId: number) => boolean = () => false, liveHost: (machineId: number) => string | null = () => null): { id: number; name: string; token: string } {
  const code = typeof body.code === 'string' ? body.code.trim() : '';
  if (!JOIN_CODE.test(code)) throw new HttpError(400, "That isn't a join code: copy the whole command from the Machines page again");
  const report = cleanReport(body.report);
  const join = store.takeMachineJoin(hashJoinCode(code), now);
  if (!join) throw new HttpError(410, 'This join code is used or more than 15 minutes old: press Connect a computer on the Machines page for a new one');
  let machine: Machine | undefined;
  if (join.machine_id !== null) {
    machine = store.getMachine(join.machine_id);
    if (!machine) throw new HttpError(410, 'The machine this code updates was removed: press Connect a computer for a new one');
    // As the token route: a new token would cut the draining agent off before its copies are home.
    if (removing(machine.id)) throw new HttpError(409, `${machine.name} is being removed: it gets no new token until its copies are cleared`);
    // Pasted on another PC, its agent would replace the live one there (#2194: a VM's Update, run on its host); an agent that names no PC can't show it's the same one.
    const live = liveHost(machine.id);
    const here = report?.host || text(body.host, 100);
    if (live && here.toLowerCase() !== live.toLowerCase()) throw new HttpError(409, `This code updates ${machine.name}, whose agent runs on ${live}, but this PC is ${here || 'unnamed'}. Press Update for a new code and run it on ${live} itself (for a VM, inside it); to add this PC, press Connect a computer instead`);
  } else {
    // Every machine has an owner (Build 10 H1): whoever made the code, which Connect a computer does with their own login.
    const owner = join.owner_id ?? join.asker_id;
    if (owner === null) throw new HttpError(410, 'This join code has no one to own the machine: press Connect a computer on the Machines page for a new one');
    const host = report?.host || text(body.host, 100);
    const names = new Set(store.listMachines().map((m) => m.name));
    const taken = (n: string) => names.has(n) || RESERVED_NAMES.has(n) || n.endsWith(WS_SUFFIX);
    // Two PCs joining at once can pick one name: the second takes the next.
    for (let tries = 0; !machine && tries < 5; tries++) {
      const name = nameFromHost(host, taken);
      try {
        machine = store.createMachine(name, '', join.created_by, owner);
      } catch (err) {
        if (!/UNIQUE/.test(String(err))) throw err;
        names.add(name);
      }
    }
    // The code is spent by now, so a new one is what works.
    if (!machine) throw new HttpError(409, 'Could not name this machine: press Connect a computer for a new code');
  }
  const token = issueToken(machine.id);
  if (report) store.updateMachine(machine.id, { report: JSON.stringify(report) });
  store.setMachineJoined(join.id, machine.id);
  return { id: machine.id, name: machine.name, token };
}
