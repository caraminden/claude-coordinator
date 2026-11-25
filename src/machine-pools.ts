// The connected machines as places for minion turns (Build 7 T4): which ones lend workers now, what holds each, and whether
// a turn may run there. The line that starts turns (src/turn-line.ts) asks this; nothing here starts one. A machine runs
// only its owner's turns (Josh, 2026-11-25, "owner's turns only"), in schemes it is lent to, and starts none while a ship's
// tests run on that computer. Its size stays under its owner's cap, which its agent holds too.
import { lendsMachine } from './access.ts';
import type { Machine, Store, Ticket } from './db.ts';
import { sameClaude, type WorkerInfo } from './machine-turn.ts';
import { pacificStamp } from './pacific.ts';
import type { PressureReading } from './pressure.ts';
import type { PoolBox } from './turn-limits.ts';
import type { RetryKind } from './turn-outcome.ts';

/** Why a turn can't start on a machine now. `never`: not until someone changes something. `since`: when the machine went away. */
export interface Block {
  why: string;
  never?: true;
  since?: number;
}

export interface MachinePlace {
  id: number;
  name: string;
  owner: number;
  /** Its owner's cap on turns at once; 0 until its agent has said it. */
  cap: number;
  /** What keeps every turn from starting there, or null. */
  block: Block | null;
  /** Away since (0: never here), or null: here, or back in a moment (a restart of this server drops every link for a second or two). */
  away: number | null;
  load: { reading: Pick<PressureReading, 'cpu' | 'mem'>; box: PoolBox; at: number } | null;
}

/** What the line asks of the machines. */
export interface MachineHost {
  /** Where a minion's turns must run: null anywhere, 0 perigee, else the machine it is marked for. */
  mark(ticketId: number): number | null;
  machines(): MachinePlace[];
  nameOf(machineId: number, ticketId?: number): string;
  /** Why this waiting turn may not run on that machine, whatever the machine is doing; null: it may. */
  takes(machineId: number, ticketId: number, via?: RetryKind): Block | null;
  /** A turn marked for a machine can't start there now. */
  stuck(ticketId: number, since: number, block: Block): void;
}

/** A link that has been gone for less than this since the agent's last sync, or since this server started, is coming back. */
const BACK_SOON_MS = 60_000;
/** How long a claude's version here holds before it is asked again: an update mid-day must not leave machines on the old one. */
const CLAUDE_MS = 10 * 60_000;
/** A machine's last moment connected is saved this often, so "away since" outlives a crash of this server. */
const SEEN_MS = 5 * 60_000;
const SEEN = 'worker-seen';

export interface MachinePoolsDeps {
  store: Pick<Store, 'listMachines' | 'getMachine' | 'getProject' | 'getUser' | 'getSetting' | 'setSetting' | 'machineGranted' | 'canSee'>;
  online: (machineId: number) => boolean;
  /** Its owner's Minion turns switch. */
  lends: (m: Machine) => boolean;
  info: (machineId: number) => WorkerInfo | null;
  /** A ship's tests run on that computer. */
  ships: (machineId: number) => boolean;
  /** `claude --version` here. */
  claude: () => Promise<string | null>;
  /** A machine may take turns it couldn't a moment ago. */
  changed: () => void;
  now: () => number;
}

export class MachinePools {
  private d: MachinePoolsDeps;
  private home: { version: string | null; at: number; asking?: true } = { version: null, at: -Infinity };
  private seen: Record<string, number>;
  private readonly began: number;

  constructor(d: MachinePoolsDeps) {
    this.d = d;
    this.seen = d.store.getSetting<Record<string, number>>(SEEN) ?? {};
    this.began = d.now();
  }

  /** The machines whose owner switched Minion turns on. */
  machines(): MachinePlace[] {
    return this.d.store.listMachines().flatMap((m) => (m.owner_id !== null && this.d.lends(m) ? [this.place(m, m.owner_id)] : []));
  }

  private place(m: Machine, owner: number): MachinePlace {
    const info = this.d.info(m.id);
    const load = info?.load ? { reading: { cpu: info.load.cpu, mem: info.load.mem }, box: { freeGb: info.load.freeGb, level: 'ok' as const }, at: info.at } : null;
    const away = this.away(m, info);
    return { id: m.id, name: m.name, owner, cap: info?.max ?? 0, block: this.block(m, info, away), away, load };
  }

  private away(m: Machine, info: WorkerInfo | null): number | null {
    const now = this.d.now();
    const key = String(m.id);
    if (this.d.online(m.id)) {
      if (now - (this.seen[key] ?? 0) >= SEEN_MS) this.d.store.setSetting(SEEN, (this.seen = { ...this.seen, [key]: now }));
      return null;
    }
    const last = Math.max(this.seen[key] ?? 0, m.last_seen_at ?? 0, info?.at ?? 0);
    return last && now - Math.max(info?.at ?? 0, this.began) < BACK_SOON_MS ? null : last;
  }

  private block(m: Machine, info: WorkerInfo | null, away: number | null): Block | null {
    if (!this.d.online(m.id)) return away === null ? { why: 'reconnecting' } : away ? { why: `away since ${pacificStamp(away)}`, since: away } : { why: 'it has not connected yet' };
    if (!info) return { why: 'its agent has not said it can run turns' };
    const home = this.homeClaude();
    if (!sameClaude(home, info.claude)) return { why: home ? `its Claude is ${info.claude ?? 'not known'}, and this server's is ${home}` : 'checking its Claude' };
    return this.d.ships(m.id) ? { why: "a ship's tests are running there" } : null;
  }

  /** This server's claude, asked again by itself as it ages; null until the first answer. */
  private homeClaude(): string | null {
    if (!this.home.asking && this.d.now() - this.home.at >= CLAUDE_MS) {
      this.home.asking = true;
      void this.d.claude().then((v) => {
        const first = this.home.version === null;
        this.home = { version: v, at: this.d.now() }; // one that can't be read is no match (block)
        if (first) this.d.changed();
      });
    }
    return this.home.version;
  }

  /** Why a turn of this minion for `person` may never run on that machine as things stand, or null. */
  refuses(machineId: number, ticket: Pick<Ticket, 'project_id'>, person: number | null, name?: string): Block | null {
    const never = (why: string): Block => ({ why, never: true });
    const m = this.d.store.getMachine(machineId);
    // A removed machine's number can come to another one.
    if (!m || m.owner_id === null || (name && m.name !== name)) return never('that computer was removed');
    const owner = this.d.store.getUser(m.owner_id)?.name ?? 'its owner';
    if (!this.d.lends(m)) return never(`${owner} has switched Minion turns off there`);
    if (person !== m.owner_id) return never(`it runs only ${owner}'s turns, and this one is ${person === null ? 'nobody' : (this.d.store.getUser(person)?.name ?? 'someone else')}'s`);
    const project = this.d.store.getProject(ticket.project_id);
    if (!project || !lendsMachine(this.d.store as Store, m, project, [m.owner_id])) return never('it is not lent to this scheme');
    return this.d.info(m.id)?.signedIn === false ? never(`${owner} is not signed in to Claude there`) : null;
  }

  nameOf(machineId: number): string {
    return this.d.store.getMachine(machineId)?.name ?? `machine ${machineId}`;
  }

  /** The machine as a turn is launched on it, or why it can't be any more. */
  launch(machineId: number, ticket: Pick<Ticket, 'project_id'>, person: number | null, name?: string): { id: number; name: string } | Block {
    const refused = this.refuses(machineId, ticket, person, name);
    if (refused) return refused;
    const p = this.machines().find((m) => m.id === machineId)!;
    return p.block ?? { id: p.id, name: p.name };
  }

  /** "Runs on" choices for a person: each machine of theirs, with why it can't be picked. */
  choices(projectId: number, person: number | null): { id: number; name: string; why: string | null }[] {
    return this.d.store.listMachines().flatMap((m) => {
      if (m.owner_id === null || !(this.d.lends(m) || m.owner_id === person)) return [];
      const why = m.owner_id !== person ? `only ${this.d.store.getUser(m.owner_id)?.name ?? 'its owner'} can pick it` : (this.refuses(m.id, { project_id: projectId }, person)?.why ?? null);
      return [{ id: m.id, name: m.name, why }];
    });
  }
}
