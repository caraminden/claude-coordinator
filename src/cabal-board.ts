// A cabal's board (#2090, specs/foreman-crews-proposal.md "The cabal board"): one per lead (its Overseer), read by the
// lead, its cabal and people in place of the lead's chat. src/db/cabals.ts keeps what is written (rows, notes, asks, the
// log, the red-run line); everything else on a row is a fact read here: its state from the minions list, merged into
// build/<n> from git, its claims from build-claims.md on the branch, what it waits on from start_after, spend and risk.
// Code says cabal and lead; people read "<cabal>'s Overseer" (Josh, 2026-11-25: one Overseer per build).
import { buildRefs, mergedInto } from './builds.ts';
import type { Store } from './db.ts';
import type { CabalAsk, CabalLogLine, CabalMemberRow } from './db/cabals.ts';
import type { Ticket, TicketFields } from './db-rows.ts';
import { EFFORT_KEY } from './effort-retros.ts';
import { budgetKey, type BudgetState } from './minion-budget.ts';
import { gitOut } from './git.ts';
import { deliveriesOf } from './outbox.ts';
import { pacificClock } from './pacific.ts';
import { pacific } from './schedules.ts';
import { tierLabel } from '../public/model-table.js';
import { parseShipNote, type Risk } from './ship-risk.ts';

export type MemberState = 'roster' | 'sealed' | 'running' | 'idle' | 'blocked' | 'merged' | 'shipped' | 'closed';
/** The word people read for each state. */
export const STATE_WORD: Record<MemberState, string> = {
  roster: 'not started',
  sealed: 'sealed',
  running: 'building',
  idle: 'open',
  blocked: 'blocked',
  merged: 'merged',
  shipped: 'shipped',
  closed: 'dismissed',
};
/** Open ones first, the blocked on top (the picked ledger's order). */
const ORDER: Record<MemberState, number> = { blocked: 0, running: 1, idle: 2, sealed: 3, roster: 4, merged: 5, shipped: 6, closed: 7 };
const DONE = new Set<MemberState>(['merged', 'shipped', 'closed']);
/** At work: what a cabal's width counts (#2091). */
const AT_WORK = new Set<MemberState>(['running', 'idle', 'blocked']);

export interface BoardAsk {
  id: number;
  from: string;
  number: number | null;
  /** The asker's scheme when it isn't the lead's (#2094). */
  scheme: string | null;
  text: string;
  blocking: boolean;
  opened_at: number;
  /** The lead's answer (#2289): null while it is open. The board carries the open asks, then the newest answered few. */
  answer: string | null;
  answered_at: number | null;
}

export interface BoardMember {
  row: number;
  label: string;
  title: string;
  number: number | null;
  /** A member in another scheme (#2094): its scheme's id and name; null in the lead's. */
  project_id: number | null;
  scheme: string | null;
  /** Whether the reader may open its chat (src/access.ts cabalBoardFor); a member of the lead's scheme always may. */
  open: boolean;
  lane: string;
  role: string;
  state: MemberState;
  word: string;
  /** What it waits on: "#N" from its start_after, else what the lead wrote on its row. */
  after: string | null;
  note: string;
  note_at: number | null;
  spend: number;
  risk: Risk | null;
  /** Its line in build-claims.md on build/<n>, in a build cabal. */
  claims: string[];
  /** The files it expects to touch, as listed on its row. */
  files: string[];
  /** Its listed files another member lists too. */
  doubled: string[];
  /** Not started yet (#2091): its handoff, tier and cost, and who approved it on the forming card; '' once started. */
  plan: string;
}

export interface Board {
  /** `project_id` is the lead's scheme; `open` whether the reader may open its chat (src/access.ts cabalBoardFor). */
  lead: { id: number; number: number | null; title: string; spend: number; project_id: number; open: boolean };
  /** "Build 7", the Goal's name, or the lead's title. */
  name: string;
  kind: 'build' | 'goal';
  build: number | null;
  members: BoardMember[];
  asks: BoardAsk[];
  log: CabalLogLine[];
  red: { text: string; at: number } | null;
  counts: { members: number; started: number; merged: number; open: number; working: number; running: number; spend: number };
  /** How many members may be at work at once (#2091). */
  width: number;
}

/** "#4: a.ts b/" lines of build-claims.md, read as land.sh's claims_check does: a list mark, backticks and commas are spaces. */
export function parseClaims(text: string): Map<number, string[]> {
  const out = new Map<number, string[]>();
  for (const raw of text.split('\n')) {
    const l = raw.replace(/^[-*][ \t]+/, '').replace(/[`,]/g, ' ');
    const m = /^#(\d+):(.*)$/.exec(l);
    if (m) out.set(Number(m[1]), [...(out.get(Number(m[1])) ?? []), ...m[2].split(/[ \t]+/).filter(Boolean)]);
  }
  return out;
}

/** The files on a row, one a line (commas and spaces split too). */
export const rowFiles = (files: string): string[] => [
  ...new Set(
    files
      .split(/[\n,\s]+/)
      .map((f) => f.trim().replace(/^`|`$/g, ''))
      .filter(Boolean),
  ),
];

/** Each member's files that another lists too: the same path, or one inside a folder (ending in /) another lists. */
export function doubledFiles(lists: string[][]): string[][] {
  const hit = (a: string, b: string) => a === b || (a.endsWith('/') && b.startsWith(a)) || (b.endsWith('/') && a.startsWith(b));
  return lists.map((mine, i) => mine.filter((f) => lists.some((other, j) => j !== i && other.some((g) => hit(f, g)))));
}

export interface BoardDeps {
  /** Whether a minion is sealed (Runner.parked: state sealed, chained, or waiting on its start card). */
  parked: (t: TicketFields) => boolean;
}

/** The lead's board with every fact read now, or null when it leads none. */
export async function readBoard(store: Store, leadId: number, deps: BoardDeps): Promise<Board | null> {
  const cabal = store.getCabal(leadId);
  const lead = store.getTicket(leadId);
  if (!cabal || !lead) return null;
  const repoDir = store.getProject(lead.project_id)?.repo_dir ?? null;
  const ref = lead.build != null && repoDir ? ((await buildRefs(repoDir)).get(lead.build) ?? null) : null;
  const claims = ref && repoDir ? parseClaims((await gitOut(['show', `${ref}:build-claims.md`], repoDir)) ?? '') : new Map<number, string[]>();
  const rows = store.cabalRows(leadId);
  const asks = store.cabalAsks(leadId);
  const answered = answeredAsks(store, leadId); // read with the open ones, before any await: an answer meanwhile can't show an ask twice
  const tickets = new Map(rows.filter((r) => r.ticket_id != null).map((r) => [r.ticket_id!, store.getTicket(r.ticket_id!)]));
  const fileLists = rows.map((r) => rowFiles(r.files));
  const doubled = doubledFiles(fileLists);
  const members: BoardMember[] = [];
  for (const [i, r] of rows.entries()) {
    const t = r.ticket_id != null ? tickets.get(r.ticket_id) : undefined;
    const ship = parseShipNote(t ? (store.lastShipNote(t.id) ?? '') : '');
    // A member in another scheme ships to its own main: it never merges into this repo's build branch (#2094).
    const where = t?.project_id ?? r.project_id ?? lead.project_id;
    const scheme = where === lead.project_id ? null : (store.getProject(where)?.name ?? `scheme ${where}`);
    // A Plot's branch that shipped to main is deleted: its members' merges can't be read from git, but their own Merged notes still say so (#2327).
    const branchGone = !scheme && lead.build != null && !!repoDir && !ref;
    const state = await stateOf(t, ship?.kind ?? null, scheme ? null : ref, repoDir, asks, deps, branchGone);
    members.push({
      row: r.id,
      label: r.label,
      title: r.title || t?.title || '',
      number: t?.number ?? null,
      project_id: scheme ? where : null,
      scheme,
      open: true,
      lane: r.lane,
      role: r.role,
      state,
      word: state === 'idle' && t?.state && t.state !== 'parked' ? t.state : state === 'roster' && r.asked_at != null ? `asked ${scheme}` : state === 'roster' && r.next_at != null ? 'next up' : state === 'roster' && r.approved_at != null ? 'approved' : STATE_WORD[state],
      plan: t ? '' : [r.handoff, r.model && tierLabel(r.model, r.effort), r.cost != null && money(r.cost), r.approved_at != null && `approved by ${r.approved_by}`].filter(Boolean).join(' · '),
      after: (t && afterOf(store, t)) || r.after || null,
      note: r.note,
      note_at: r.note_at,
      spend: t ? store.ticketCost(t.id) : 0,
      risk: ship?.risk ?? null,
      claims: t?.number != null ? (claims.get(t.number) ?? []) : [],
      files: fileLists[i],
      doubled: doubled[i],
    });
  }
  members.sort((a, b) => ORDER[a.state] - ORDER[b.state]);
  const byTicket = new Map(rows.map((r) => [r.ticket_id, r]));
  const leadSpend = store.ticketCost(leadId);
  return {
    lead: { id: lead.id, number: lead.number, title: lead.title, spend: leadSpend, project_id: lead.project_id, open: true },
    name: cabalName(store, lead, cabal.name),
    kind: ref ? 'build' : 'goal',
    build: ref ? lead.build : null,
    members,
    asks: [...asks, ...answered].map((a) => askOf(store, lead.project_id, a, byTicket.get(a.ticket_id), store.getTicket(a.ticket_id))),
    log: store.cabalLog(leadId),
    red: cabal.red ? { text: cabal.red, at: cabal.red_at ?? cabal.created_at } : null,
    width: cabal.width,
    counts: {
      members: members.length,
      started: members.filter((m) => m.state !== 'roster').length,
      merged: members.filter((m) => m.state === 'merged' || m.state === 'shipped').length,
      open: members.filter((m) => !DONE.has(m.state)).length,
      working: members.filter((m) => AT_WORK.has(m.state)).length,
      running: members.filter((m) => m.state === 'running').length,
      spend: members.reduce((s, m) => s + m.spend, leadSpend),
    },
  };
}

async function stateOf(t: Ticket | undefined, ship: 'shipped' | 'merged' | null, ref: string | null, repoDir: string | null, asks: CabalAsk[], deps: BoardDeps, branchGone = false): Promise<MemberState> {
  if (!t) return 'roster';
  const merged = !!(ref && repoDir && (await mergedInto(repoDir, t, ref)));
  const open = t.status !== 'closed';
  // A merged commit isn't finished work: a member still at work, blocked or sealed keeps that state (#2302).
  const live = open && asks.some((a) => a.ticket_id === t.id && a.blocking) ? 'blocked' : open && t.status === 'running' ? 'running' : open && deps.parked(t) ? 'sealed' : null;
  if (merged && !live) return 'merged';
  if (ship === 'shipped' || (branchGone && ship === 'merged' && !live)) return 'shipped';
  if (t.status === 'closed') return 'closed';
  if (live) return live;
  return 'idle';
}

/** "#N" of the minion it starts after, from its chain (start_after), while it still waits. */
function afterOf(store: Store, t: Ticket): string | null {
  const chain = deliveriesOf(store, 'chain', { to: t.id, states: ['waiting', 'held', 'sending'] })[0];
  const leader = chain ? store.getTicket(chain.when_arg.after) : undefined;
  return leader?.number != null ? `#${leader.number}` : null;
}

const askOf = (store: Store, leadScheme: number, a: CabalAsk, row: CabalMemberRow | undefined, t: Ticket | undefined): BoardAsk => ({
  id: a.id,
  from: row?.label || t?.title || `#${t?.number ?? '?'}`,
  number: t?.number ?? null,
  scheme: t && t.project_id !== leadScheme ? (store.getProject(t.project_id)?.name ?? null) : null,
  text: a.text,
  blocking: !!a.blocking,
  opened_at: a.opened_at,
  answer: a.answer,
  answered_at: a.answered_at,
});

/** The newest answered asks, so the board shows what the lead said (#2289). */
const answeredAsks = (store: Store, leadId: number) =>
  store
    .cabalAsks(leadId, false)
    .filter((a) => a.answered_at != null)
    .sort((x, y) => (y.answered_at ?? 0) - (x.answered_at ?? 0))
    .slice(0, 10);

/** The asks still waiting on the lead. */
export const openAsks = (b: Pick<Board, 'asks'>) => b.asks.filter((a) => a.answered_at == null);

/** A build's cabal is always "Build 7" (Josh, 2026-11-25: "Build 7's Overseer"); a name only names a goal cabal. */
export const cabalName = (store: Store, lead: Ticket, name: string) => (lead.build != null ? `Plot ${lead.build}` : name || String(store.props.forTarget('minion', lead.id)[EFFORT_KEY] ?? '') || lead.title);

/** People's name for the lead: "Build 7's Overseer", "Worker machines' Overseer". */
export const overseerOf = (board: Pick<Board, 'name'>) => `${board.name}${/s$/i.test(board.name) ? "'" : "'s"} Overseer`;

const money = (n: number) => `$${n.toFixed(2)}`;

const when = (at: number) => pacific(at);
const waited = (ms: number) => (ms < 3_600_000 ? `${Math.round(ms / 60_000)} min` : `${(ms / 3_600_000).toFixed(1)} h`);

/**
 * What the lead writes its cabal's retro from (#2096): each member's start, ships or merges, dismissal and spend against
 * its row's expected cost, every ask with how long it waited, and the whole log (starts, reds). `seen` is the board as
 * the reader may see it, and this shows no more: a reader outside the lead's scheme gets its own schemes' rows and asks
 * and no log, and a ship note's words (from the member's chat) only where that chat opens.
 */
export function timelineText(store: Store, seen: Board): string {
  const lead = store.getTicket(seen.lead.id)!;
  const rows = new Map(store.cabalRows(lead.id).map((r) => [r.id, r]));
  const out = [`${/^Plot \d/.test(seen.name) ? seen.name : `${seen.name} Plot`} timeline (Pacific). Board: #/p/${seen.lead.project_id}/cabal/${seen.lead.number} · ${overseerOf(seen)} spent ${money(seen.lead.spend)}, the Plot ${money(seen.counts.spend)}`, 'Members:'];
  for (const m of seen.members) {
    const row = rows.get(m.row);
    const t = row?.ticket_id != null ? store.getTicket(row.ticket_id) : undefined;
    const who = [m.label, m.scheme ? `[${m.scheme}]` : '', m.number != null ? `#${m.number}` : 'never started', m.title].filter(Boolean).join(' ');
    if (!t) {
      out.push(`- ${who}`);
      continue;
    }
    // The words are from the member's chat; a chat that doesn't open for the reader gives only when and which.
    const ships = store.shipNotes(t.id).map((x) => `${when(x.at)} ${m.open ? x.text.slice(0, 160) : x.text.startsWith('Merged') ? 'merged' : 'shipped'}`);
    // The row's expected cost, else what its start set (a member put on the board without a planned row).
    const expected = row?.cost ?? store.getSetting<BudgetState>(budgetKey(t.id))?.estimate;
    const cells = [who, `started ${when(t.created_at)}`, ...ships, t.closed_at != null ? `dismissed ${when(t.closed_at)}` : 'open', `spent ${money(m.spend)}${expected != null ? ` of ~${money(expected)} expected` : ', no expected cost'}`];
    out.push(`- ${cells.join(' | ')}`);
  }
  const asks = store.cabalAsks(lead.id, false);
  const visible = new Set(seen.members.map((m) => rows.get(m.row)?.ticket_id));
  const mine = asks.filter((a) => seen.lead.open || visible.has(a.ticket_id));
  out.push(mine.length ? `Asks (${mine.length}):` : 'No asks.');
  for (const a of mine) {
    const t = store.getTicket(a.ticket_id);
    const scheme = t && t.project_id !== seen.lead.project_id ? `${store.getProject(t.project_id)?.name} ` : '';
    const answer = a.answered_at != null ? `answered after ${waited(a.answered_at - a.opened_at)}: ${(a.answer ?? '').slice(0, 160)}` : 'never answered';
    out.push(`- ${when(a.opened_at)} ${scheme}#${t?.number ?? '?'}${a.blocking ? ' BLOCKING' : ''}: ${a.text.slice(0, 200)} | ${answer}`);
  }
  if (seen.lead.open) {
    const log = store.cabalLog(lead.id, 1000);
    out.push(log.length ? 'Log:' : 'Log: empty.', ...log.map((l) => `- ${when(l.at)} ${l.by}: ${l.text}`));
  }
  return out.join('\n');
}

/** The board as compact text, for cabal_board's read: what an agent needs, a line a member. */
/** `me`: the reader, marked "(you)" on its row (a #N alone could be another scheme's). */
export function boardText(b: Board, me: Pick<TicketFields, 'number' | 'project_id'> | null = null): string {
  const c = b.counts;
  const out = [
    `${/^Plot \d/.test(b.name) ? b.name : `${b.name} Plot`} (${b.kind === 'build' ? `build/${b.build}` : 'goal, no branch'}) · ${overseerOf(b)} #${b.lead.number} · ${c.members} on the roster, ${c.started} started · ${c.merged} ${b.kind === 'build' ? 'merged' : 'shipped'} · ${c.open} open · ${c.working} at work, up to ${b.width} at once · ${c.running} building · ${money(c.spend)} spent`,
  ];
  if (b.red) out.push(`RED (${pacificClock(b.red.at)}): ${b.red.text}`);
  const open = openAsks(b);
  out.push(open.length ? `Open asks (${open.length}):` : 'No open asks.');
  for (const a of open) out.push(`- ask ${a.id}${a.blocking ? ' BLOCKING' : ''} from ${a.from}${a.number != null ? ` ${a.scheme ? `${a.scheme} ` : ''}#${a.number}` : ''} (${pacificClock(a.opened_at)}): ${a.text}`);
  if (!b.members.length) out.push('Roster: empty.');
  else out.push('Members (row id · label #N title | state | waits on | note | spend | risk | claims or files):');
  for (const m of b.members) {
    const files = m.claims.length ? `claims ${m.claims.join(' ')}` : m.files.length ? `files ${m.files.join(' ')}` : '';
    const cells = [
      `${m.row} · ${[m.label, m.scheme ? `[${m.scheme}]` : '', m.number != null ? `#${m.number}` : 'roster', m.title].filter(Boolean).join(' ')}${m.number != null && m.number === me?.number && (m.project_id ?? b.lead.project_id) === me.project_id ? ' (you)' : ''}${m.role ? ` [${m.role}]` : ''}${m.lane ? ` {${m.lane}}` : ''}`,
      m.word,
      m.after ? `after ${m.after}` : '',
      m.note,
      m.spend ? money(m.spend) : '',
      m.risk ? `risk ${m.risk}` : '',
      files,
      m.doubled.length ? `DOUBLED: ${m.doubled.join(' ')}` : '',
      m.plan,
    ];
    out.push(cells.filter(Boolean).join(' | '));
  }
  if (b.log.length) out.push(`Log (last ${b.log.length}):`, ...b.log.map((l) => `- ${pacificClock(l.at)} ${l.by}: ${l.text}`));
  return out.join('\n');
}
