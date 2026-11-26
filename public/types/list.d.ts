// The minion list, home and the inbox: rows, build and cabal headers, chains, waits and search hits.
// Part of the page's shapes: the rules and the shared core are in ../types.d.ts.

import type { Ticket } from '../types.js';

/** A build branch's header in the minions list (src/builds.ts). */
export interface BuildHeader {
  build: number;
  merged: number;
  open: number;
  behind: number;
}

/** An open cabal's card in the minions list (src/cabal-cards.ts). */
export interface CabalCard {
  lead: number;
  number: number | null;
  title: string;
  overseer: string;
  build: number | null;
  done: 'merged' | 'shipped';
  members: { id: number | null; number: number | null; label: string; title: string; state: string; word: string; scheme?: string | null }[];
  finished: number;
  next: number;
  asks: number;
  spend: number;
}

/** One thing waiting on a person in a scheme's Needs-you list (src/inbox.ts InboxItem; its `card` is the stored card, read here for who and which). */
export interface InboxItem {
  kind: string;
  ticketId: number;
  at: number;
  card?: { id?: number | string; by?: string; to?: string; stage?: number; notice?: unknown; secret?: unknown; doc?: { path?: string } };
  key: string;
  eventId?: number;
  from?: { projectId: number; scheme: string; number: number | null; kind: string; title: string };
}

/** The signed-in person (GET api/me, src/routes/app.ts meView). */
/** One chunk search by meaning found: GET api/projects/:id/memory's hits (src/memory.ts MemoryHit). */
export interface MemoryHit {
  ticket_id: number;
  /** null for the Taskmaster's chat (kind 'coordinator'). */
  number: number | null;
  title: string;
  kind: string;
  status: string;
  source_kind: 'turn' | 'ticket';
  source_id: number;
  ts: number;
  text: string;
  score: number;
}

// Round 4: chains.js
/** How one minion waits on another (src/chains.ts EdgeKind). */
export type EdgeKind = 'start_after' | 'wait' | 'claim' | 'build';

/** One minion (or an unowned build) in a chain (src/chains.ts ChainNode, from GET api/projects/:id/chains). */
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

/** A wire between two nodes (src/chains.ts ChainEdge): `from` waits on `to`. */
export interface ChainEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  label: string;
}

/** A set of minions joined by waits (src/chains.ts Chain). */
export interface Chain {
  key: string;
  title: string;
  kinds: EdgeKind[];
  nodes: ChainNode[];
  edges: ChainEdge[];
}

/** A minion's change on its way in a release (releases.js pendingRelease), which the list adds to the row as `release`. */
export interface PendingRelease {
  target: string;
  targetId?: string;
  name: string;
  stage: string;
  text?: string;
  since?: number;
  stuck?: boolean;
}

/** A minion as a list row (sidebar.js, threadstate.js): the ticket plus its release on its way, once the list has set it. */
export type ListedTicket = Ticket & { release?: PendingRelease | null };

/** A row's state pill as data (threadstate.js rowState). */
export interface RowState {
  rank: number;
  fam: string;
  cell: string;
  label: string;
  pulse?: boolean;
  counted?: boolean;
  server?: boolean;
  quiet?: boolean;
  since?: number;
  mention?: { by: string; at: number };
}

/** One line of what a minion waits for, in its list row's popover (src/waits-readout.ts WaitRow). */
export interface WaitRow {
  /** The delivery's id, or null for a wait still in an old key (no Cancel here). */
  id: number | null;
  kind: string;
  chip: string;
  what: string;
  headline: string;
  line: string;
  text: string;
  facts: string[];
  link: { project: number; number: number } | null;
  set_by: string;
  since: number | null;
  due: number | null;
  state: 'waiting' | 'held' | 'sending' | 'dropped' | 'failed';
  reason: string | null;
  cancellable: boolean;
}
