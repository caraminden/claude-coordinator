// Who waits on whom in a scheme, for its Chains page (#1679; Cara, 2026-11-22: "this could be linked to in the chip that
// shows that a minion is waiting on another minion"). A chain is a set of minions joined by waits: every wait that names
// another minion (start_after, wake_when_live on its work, a note from it: Cara picked "every wait on another minion"),
// each claim's queue in order (the pipeline lane), and a build's feeders into its build minion. It only reads.
import type { Ticket } from './db.ts';

/** One wait as the minions list's chip has it (src/waits-readout.ts WaitRow): the minion it names, if any. */
export interface WaitLink {
  kind: string;
  state: string;
  chip: string;
  headline?: string;
  link: { project: number; number: number } | null;
}

export type EdgeKind = 'start_after' | 'wait' | 'claim' | 'build';

export interface ChainNode {
  /** The ticket's id, or `build:<n>` for a build with no build minion named. */
  key: string;
  id: number | null;
  project: number;
  number: number | null;
  title: string;
  status: string;
  state: string | null;
  /** The column it sits in, left to right: 0 waits on nobody in the chain. */
  col: number;
}

export interface ChainEdge {
  /** The minion that waits. */
  from: string;
  /** The minion it waits on. */
  to: string;
  kind: EdgeKind;
  /** In words, for the node's "after" line: "the pipeline lane", "Build 4", or the wait's chip. */
  label: string;
}

export interface Chain {
  /** Stable for the page's highlight and keyed redraws: its leftmost node's key. */
  key: string;
  title: string;
  kinds: EdgeKind[];
  nodes: ChainNode[];
  edges: ChainEdge[];
}

export interface ChainInput {
  /** The scheme's minions (whatever their status: dismissed ones still wait on nothing, but can be waited on). */
  tickets: Ticket[];
  /** A minion's waits as the list shows them. */
  waitsOf: (t: Ticket) => WaitLink[];
  /** A minion named by a wait, possibly in another scheme. */
  find: (project: number, number: number) => Ticket | undefined;
  /** By id, for claim holders and build minions. */
  get: (id: number) => Ticket | undefined;
  /** Each claim with its holder and its waiting queue in order. */
  claims: { name: string; holder: number | null; waiting: number[] }[];
  /** The builds with a build/<n> branch, with their build minion's id when one was named. */
  builds: { build: number; owner: number | null }[];
}

const open = (t: Ticket | undefined): t is Ticket => !!t && t.status !== 'closed' && t.kind !== 'coordinator';
const LIVE = new Set(['waiting', 'held', 'sending']);
/** "pipeline-lane" → "Pipeline lane". */
const claimTitle = (name: string) => name.charAt(0).toUpperCase() + name.slice(1).replace(/-/g, ' ');

export function chainsOf(input: ChainInput): Chain[] {
  const nodes = new Map<string, ChainNode>();
  const edges: ChainEdge[] = [];
  const seen = new Set<string>();
  const nodeOf = (t: Ticket): string => {
    const key = String(t.id);
    if (!nodes.has(key)) nodes.set(key, { key, id: t.id, project: t.project_id, number: t.number, title: t.title, status: t.status, state: t.state ?? null, col: 0 });
    return key;
  };
  const edge = (from: string, to: string, kind: EdgeKind, label: string) => {
    // Once per pair and kind: #12 can both start after #11 and queue behind it, and the card shows both.
    if (from === to || seen.has(`${from}>${to}>${kind}`)) return;
    seen.add(`${from}>${to}>${kind}`);
    edges.push({ from, to, kind, label });
  };

  // Waits that name another minion: only an open minion's, as its chip shows them.
  for (const t of input.tickets.filter(open)) {
    for (const w of input.waitsOf(t)) {
      if (!w.link || !LIVE.has(w.state)) continue;
      const other = input.find(w.link.project, w.link.number);
      if (!other || other.kind === 'coordinator') continue;
      edge(nodeOf(t), nodeOf(other), w.kind === 'chain' ? 'start_after' : 'wait', w.chip);
    }
  }
  // A claim's queue: the holder first, then each waiting minion after the one before it.
  for (const c of input.claims) {
    const line = [c.holder, ...c.waiting].map((id) => (id == null ? undefined : input.get(id))).filter(open);
    if (line.length < 2) continue;
    for (let i = 1; i < line.length; i++) edge(nodeOf(line[i]), nodeOf(line[i - 1]), 'claim', claimTitle(c.name));
  }
  // A build's feeders, each into its build minion (or the build itself when none was named).
  for (const b of input.builds) {
    const owner = b.owner == null ? undefined : input.get(b.owner);
    const feeders = input.tickets.filter((t) => open(t) && t.build === b.build && t.id !== owner?.id);
    if (!feeders.length) continue;
    let into: string;
    if (owner) into = nodeOf(owner);
    else {
      into = `build:${b.build}`;
      nodes.set(into, { key: into, id: null, project: feeders[0].project_id, number: null, title: `Plot ${b.build}`, status: 'build', state: null, col: 0 });
    }
    // The build minion waits on its feeders: they sit left of it.
    for (const f of feeders) edge(into, nodeOf(f), 'build', `Plot ${b.build}`);
  }

  // Join them into chains (union-find over the edges).
  const parent = new Map<string, string>();
  const root = (k: string): string => {
    let r = k;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(k, r);
    return r;
  };
  for (const k of nodes.keys()) parent.set(k, k);
  for (const e of edges) parent.set(root(e.from), root(e.to));

  // Columns: a minion sits one right of the furthest minion it waits on. In a loop (two minions waiting on each other)
  // the wait back to a minion still being placed counts for nothing, so the loop takes one column per minion in it.
  const waitsOn = new Map<string, string[]>();
  for (const e of edges) waitsOn.set(e.from, [...(waitsOn.get(e.from) ?? []), e.to]);
  const cols = new Map<string, number>();
  const placing = new Set<string>();
  const colOf = (k: string): number => {
    if (cols.has(k)) return cols.get(k)!;
    if (placing.has(k)) return -1;
    placing.add(k);
    const c = Math.max(-1, ...(waitsOn.get(k) ?? []).map(colOf)) + 1;
    placing.delete(k);
    cols.set(k, c);
    return c;
  };
  for (const n of nodes.values()) n.col = colOf(n.key);

  const groups = new Map<string, ChainNode[]>();
  for (const n of nodes.values()) groups.set(root(n.key), [...(groups.get(root(n.key)) ?? []), n]);
  const order: EdgeKind[] = ['claim', 'build', 'start_after', 'wait'];
  const chains = [...groups.values()].map((list): Chain => {
    const keys = new Set(list.map((n) => n.key));
    const own = edges.filter((e) => keys.has(e.from));
    // Within a column, keep the order the minions arrived in (a claim's queue order, a build's feeders by number).
    list.sort((a, b) => a.col - b.col || (a.number ?? 0) - (b.number ?? 0));
    const kinds = order.filter((k) => own.some((e) => e.kind === k));
    const lead = list[0];
    const names = [...new Set(own.filter((e) => e.kind === 'claim' || e.kind === 'build').map((e) => e.label))];
    const title = names.length ? names.join(' · ') : kinds[0] === 'start_after' ? `Starts after #${lead.number}` : `Waiting on #${lead.number}`;
    return { key: lead.key, title, kinds, nodes: list, edges: own };
  });
  const rank = (c: Chain) => order.indexOf(c.kinds[0] ?? 'wait');
  return chains.sort((a, b) => rank(a) - rank(b) || b.nodes.length - a.nodes.length || (a.nodes[0].number ?? 0) - (b.nodes[0].number ?? 0));
}
