// A cabal lead's hands (#2091, specs/foreman-crews-proposal.md "Forming" and "Starting, unsealing and stopping"). The
// lead lays out its roster on its board, posts it as one forming card for the scheme, and a person's go approves it
// (who and when, per row). Then the lead starts approved rows itself (cabal_start) and unseals, stops and reseals its
// own members (cabal_member), with no Taskmaster relay; the Taskmaster gets one held line per start. Width: at most
// `width` members at work at once (default 4); a start past it waits as next up and starts once a member merges, closes or is sealed. Starts
// go through createMinion, so a member's turns wait for a worker like any minion's (#1868).
import { readFile, stat } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import { tierLabel } from '../public/model-table.js';
import type { Session } from './auth.ts';
import { cabalName, overseerOf, readBoard } from './cabal-board.ts';
import { type CardQuestion, postCard, tellTaskmaster } from './ci-armed.ts';
import type { Ticket } from './db-rows.ts';
import type { CabalMemberRow } from './db/cabals.ts';
import { type App, HttpError, ownWrites } from './http.ts';
import { expectedCost } from './minion-budget.ts';
import { createMinion } from './routes/projects.ts';
import { stopMinion, unparkTicket } from './routes/tickets.ts';
import { thrown } from './thrown.ts';
import { projectSharedDir } from './workspace.ts';

/** What the forming card shows of a row: a change to any of them after the go needs a new card. */
export const APPROVED_FIELDS = ['title', 'handoff', 'model', 'effort', 'cost', 'after'] as const;
export const FORM_GO = 'Start the cabal';
export const FORM_WAIT = 'Not yet';
const WIDTH_MAX = 20;

/** The fields the forming card showed of a row: its go approves a row only if they still read the same. */
export const rowSig = (r: CabalMemberRow) => JSON.stringify(APPROVED_FIELDS.map((k) => r[k]));

/** A row's handoff as a path in the shared folder, refused unless it is a file there. */
export async function handoffPath(app: App, projectId: number, raw: unknown): Promise<string> {
  if (typeof raw !== 'string' || !raw.trim()) throw new HttpError(400, 'handoff must be the path of its handoff file in the shared folder');
  const shared = projectSharedDir(app.dataDir, projectId);
  const given = raw.trim();
  const rel = normalize(given.startsWith(`${shared}/`) ? given.slice(shared.length + 1) : given);
  // No spaces: a brief's readers end a path there (card-starts' rule).
  if (rel.startsWith('/') || rel.split('/').includes('..') || !rel.endsWith('.md') || /\s/.test(rel)) throw new HttpError(400, `handoff must be a .md file in the shared folder (${shared}), not ${given.slice(0, 200)}`);
  const file = join(shared, rel);
  if (!(await stat(file).catch(() => null))?.isFile()) throw new HttpError(400, `No handoff file at ${file}`);
  return rel;
}

const name = (app: App, lead: Ticket) => cabalName(app.store, lead, app.store.getCabal(lead.id)?.name ?? '');
const rowName = (r: CabalMemberRow) => r.label || r.title || `row ${r.id}`;
const money = (n: number) => `$${Math.round(n)}`;

/** One roster line as the forming card shows it. */
const rosterLine = (r: CabalMemberRow) => `- ${[r.label, r.title].filter(Boolean).join(' · ')} · ${r.handoff} · ${tierLabel(r.model, r.effort)}${r.cost != null ? ` · ~${money(r.cost)}` : ''}${r.after ? ` · after ${r.after}` : ''}`;

/**
 * cabal_board's form: one card in the lead's chat, open to the scheme, for every row neither approved nor started.
 * Each needs a title, a handoff, a model and an effort; a row with no cost takes its handoff's "Expected cost" line.
 */
export async function postForming(app: App, lead: Ticket, width: unknown): Promise<{ href: string; rows: number }> {
  const { store } = app;
  const cabal = store.getCabal(lead.id);
  if (!cabal) throw new HttpError(409, 'Lay out your roster first (cabal_board action row), then post it');
  const w = width == null ? cabal.width : Number(width);
  if (!Number.isInteger(w) || w < 1 || w > WIDTH_MAX) throw new HttpError(400, `width is how many members may be at work at once, 1 to ${WIDTH_MAX}`);
  const all = store.cabalRows(lead.id);
  const rows = all.filter((r) => r.ticket_id == null && r.approved_at == null);
  if (!rows.length && w === cabal.width) throw new HttpError(409, 'Every row on your roster is approved or started: add a row first, or pass a new width');
  const shared = projectSharedDir(app.dataDir, lead.project_id);
  for (const r of rows) {
    const missing = [!r.title && 'a title', !r.handoff && 'a handoff', !r.model && 'a model', !r.effort && 'an effort'].filter(Boolean);
    if (missing.length) throw new HttpError(400, `Row ${rowName(r)} needs ${missing.join(', ')} before it goes on the forming card`);
    const text = await readFile(join(shared, r.handoff), 'utf8').catch(() => null);
    if (text == null) throw new HttpError(400, `Row ${rowName(r)}'s handoff is gone: ${join(shared, r.handoff)}`);
    if (r.cost == null) {
      const cost = expectedCost(text);
      if (cost != null) {
        store.updateCabalRow(r.id, { cost });
        r.cost = cost;
      }
    }
  }
  const nm = name(app, lead);
  const approved = all.filter((r) => r.approved_at != null || r.ticket_id != null);
  const total = rows.reduce((s, r) => s + (r.cost ?? 0), 0);
  const unknown = rows.filter((r) => r.cost == null).length;
  const head = approved.length ? `${overseerOf({ name: nm })} (#${lead.number}) asks to add ${rows.length} to its cabal of ${approved.length}` : `${overseerOf({ name: nm })} (#${lead.number}) asks to start its cabal of ${rows.length}`;
  const where = lead.build != null ? `merging into Build ${lead.build}'s branch` : 'each shipping to live itself';
  const question: CardQuestion = {
    header: approved.length ? 'Add to the cabal' : 'Start the cabal',
    question:
      `${head}, ${where}, at most ${w} at work at once (the rest wait as next up)${rows.length ? `, about ${money(total)}${unknown ? ` plus ${unknown} with no estimate` : ''}` : ''}.` +
      (rows.length ? `\n\n${rows.map(rosterLine).join('\n')}` : '') +
      `\n\nThe go lets the Overseer start${rows.length ? ' these' : ''}, unseal, stop and reseal its own members itself, and stands for each row's start card up to its cost. Anyone not listed needs another card.`,
    multiSelect: false,
    options: [
      { label: FORM_GO, description: `The Overseer starts them from their handoffs, ${w} at a time; the Taskmaster hears of each start.`, recommended: true },
      { label: FORM_WAIT, description: 'Nothing starts. Say what to change and the Overseer posts a new card.' },
    ],
  };
  const card = postCard(app, lead, { questions: [question], cabalForm: { lead: lead.id, width: w, rows: rows.map((r) => ({ id: r.id, sig: rowSig(r) })) } });
  store.addCabalLog(lead.id, `#${lead.number}`, `Posted the forming card for ${rows.map(rowName).join(', ') || `width ${w}`}`);
  app.broadcast({ type: 'cabal', projectId: lead.project_id, lead: lead.id });
  return { href: card.href, rows: rows.length };
}

/** The go on a forming card: approves each row it showed that still reads the same, and the width. Returns the line the lead reads. */
export function approveRoster(app: App, form: { lead: number; width: number; rows: { id: number; sig: string }[] }, by: string, at = Date.now()): string {
  const { store } = app;
  const ok: string[] = [];
  const changed: string[] = [];
  for (const { id, sig } of form.rows) {
    const r = store.cabalRow(id);
    if (!r || r.lead_id !== form.lead || r.ticket_id != null) continue;
    if (rowSig(r) !== sig) {
      changed.push(rowName(r));
      continue;
    }
    store.updateCabalRow(id, { approved_by: by, approved_at: at });
    ok.push(rowName(r));
  }
  store.setCabalWidth(form.lead, form.width);
  store.addCabalLog(form.lead, by, `Approved on the forming card: ${ok.join(', ') || 'no rows'}; width ${form.width}${changed.length ? `. Changed since the card, so not approved: ${changed.join(', ')}` : ''}`, at);
  const lead = store.getTicket(form.lead);
  if (lead) app.broadcast({ type: 'cabal', projectId: lead.project_id, lead: lead.id });
  return `Approved: ${ok.join(', ') || 'no rows'}; width ${form.width}.${changed.length ? ` Not approved, changed after the card was posted: ${changed.join(', ')} (post a new forming card for them).` : ''} Start them with cabal_start.`;
}

/** A row on the lead's board by its id or label. */
export function findRow(app: App, leadId: number, row: unknown): CabalMemberRow {
  const rows = app.store.cabalRows(leadId);
  const want = String(row ?? '')
    .trim()
    .toLowerCase();
  const r = rows.find((x) => String(x.id) === want) ?? rows.find((x) => x.label && x.label.toLowerCase() === want);
  if (!r) throw new HttpError(404, `No row ${want.slice(0, 20) || '(none given)'} on your board`);
  return r;
}

/** Members at work, as the board reads them (building, open or blocked): what the width counts. One sealed on its chain, merged or dismissed holds no place. */
const atWork = async (app: App, leadId: number) => (await readBoard(app.store, leadId, { parked: (t) => app.runner.parked(t) }))?.counts.working ?? 0;

/** What a row's `after` chains on: a #N, or another row's label whose minion is started. */
function chainOf(app: App, lead: Ticket, r: CabalMemberRow): number | null {
  const after = r.after.trim();
  if (!after) return null;
  const n = /^#?(\d+)$/.exec(after);
  if (n) return Number(n[1]);
  const other = app.store.cabalRows(lead.id).find((x) => x.label && x.label.toLowerCase() === after.toLowerCase());
  if (!other) throw new HttpError(400, `Row ${rowName(r)} waits on "${after}", which is no #N and no label on your board`);
  const t = other.ticket_id != null ? app.store.getTicket(other.ticket_id) : undefined;
  if (!t) throw new HttpError(409, `Row ${rowName(r)} waits on ${after}, which isn't started yet: start ${after} first`);
  return t.number!;
}

/**
 * cabal_start: an approved row starts now, or waits as next up past the width. Refused for a row nobody approved
 * ("add it with a card"), one already started, or one waiting on a row not started yet.
 */
export async function cabalStart(app: App, lead: Ticket, rowRef: unknown, text: unknown): Promise<{ started?: number; title?: string; next?: number; notes?: string[] }> {
  const { store } = app;
  const cabal = store.getCabal(lead.id);
  if (!cabal) throw new HttpError(403, "Only a cabal's lead starts its members, and you lead none");
  const r = findRow(app, lead.id, rowRef);
  if (r.ticket_id != null) throw new HttpError(409, `Row ${rowName(r)} is started already: #${store.getTicket(r.ticket_id)?.number}`);
  if (r.approved_at == null) throw new HttpError(403, `Row ${rowName(r)} isn't on the approved roster: add it with a card (cabal_board action form) and start it once a person says go`);
  const extra = text == null || text === '' ? '' : String(text).slice(0, 4000);
  chainOf(app, lead, r); // refused now, not once it is next up
  if ((await atWork(app, lead.id)) >= cabal.width) {
    if (r.next_at == null) store.updateCabalRow(r.id, { next_at: Date.now() });
    store.addCabalLog(lead.id, `#${lead.number}`, `${rowName(r)} is next up: ${cabal.width} members are open`);
    app.broadcast({ type: 'cabal', projectId: lead.project_id, lead: lead.id });
    const place = store.cabalRows(lead.id).filter((x) => x.next_at != null && x.ticket_id == null && (x.next_at < (r.next_at ?? Date.now()) || x.id === r.id)).length;
    return { next: place };
  }
  return startRow(app, lead, r, extra);
}

async function startRow(app: App, lead: Ticket, r: CabalMemberRow, extra: string) {
  const { store } = app;
  const project = store.getProject(lead.project_id)!;
  const nm = name(app, lead);
  const by = `${overseerOf({ name: nm })} #${lead.number}`;
  const handoff = join(projectSharedDir(app.dataDir, project.id), r.handoff);
  const after = chainOf(app, lead, r);
  const type = store.props.forTarget('minion', lead.id).type;
  const message = [extra, `Your brief is the handoff ${handoff}: read it first and work from it.`, `You are a member of ${nm}'s cabal, row ${rowName(r)}. Its lead is ${overseerOf({ name: nm })}, #${lead.number}: read your cabal_board at each wake, set your note there at milestones, and send your asks there.`]
    .filter(Boolean)
    .join('\n\n');
  const body = {
    title: r.title,
    message,
    model: r.model,
    effort: r.effort,
    properties: { type: (Array.isArray(type) ? type[0] : type) || 'feature' },
    parent: lead.number,
    cabal: lead.number,
    pick_reason: `on ${nm}'s approved roster (row ${rowName(r)})`,
    ...(r.cost != null ? { expected_cost: r.cost } : {}),
    // A build's members wait for a merge into its branch: nothing in a build is live before the build is.
    ...(after != null ? { start_after: after, start_when: lead.build != null ? 'merged' : 'live' } : {}),
  };
  // The lead's own start, as the Taskmaster's would be: its person's turn runs it.
  const session: Session = { name: by, exp: Number.POSITIVE_INFINITY, agent: lead.id };
  const made = await createMinion(app, project, body, session, lead, false, { row: r.id, usd: r.cost });
  store.updateCabalRow(r.id, { next_at: null });
  store.addCabalLog(lead.id, `#${lead.number}`, `Started #${made.number} for ${rowName(r)}`);
  await tellTaskmaster(app, lead, `${by} started #${made.number} ${r.title} from its approved roster (row ${rowName(r)}, approved by ${r.approved_by}).`, false, false, 'fyi', true); // notice: a reply the lead owes another Taskmaster keeps its way back
  app.broadcast({ type: 'cabal', projectId: lead.project_id, lead: lead.id });
  await ownWrites();
  return { started: made.number!, title: r.title, notes: made.notes };
}

const filling = new Set<number>();

/** A member's turn ended, it was sealed or stopped, or it was dismissed: a place may be free, so its lead's next-up rows start. */
export function fillFor(app: App, ticketId: number): void {
  const lead = app.store.cabalRowOf(ticketId)?.lead_id;
  if (lead != null) void fillCabal(app, lead).catch((err) => console.error(`Starting cabal #${lead}'s next up failed:`, err));
}

/** After a member closes, is sealed or ends a turn: next-up rows start, oldest first, while the width has room. A failed start is held mail to the lead. */
export async function fillCabal(app: App, leadId: number): Promise<void> {
  if (filling.has(leadId)) return;
  filling.add(leadId);
  try {
    const { store } = app;
    for (;;) {
      const lead = store.getTicket(leadId);
      const cabal = store.getCabal(leadId);
      if (!lead || !cabal || lead.status === 'closed') return;
      const next = store
        .cabalRows(leadId)
        .filter((r) => r.next_at != null && r.ticket_id == null && r.approved_at != null)
        .sort((a, b) => a.next_at! - b.next_at! || a.id - b.id)[0];
      if (!next || (await atWork(app, leadId)) >= cabal.width) return;
      try {
        await startRow(app, lead, next, '');
      } catch (err) {
        store.updateCabalRow(next.id, { next_at: null });
        const why = thrown(err).message;
        store.addCabalLog(leadId, 'Citadel', `Couldn't start ${rowName(next)} from next up: ${why}`);
        app.runner.leaveMail(leadId, 'Citadel', `Row ${rowName(next)} was next up, but its start was refused: ${why}. It is off next up; fix it and run cabal_start again.`);
      }
    }
  } finally {
    filling.delete(leadId);
  }
}

/** cabal_member: the lead unseals, stops or reseals one of its own started members; any other minion is refused. */
export async function memberAction(app: App, lead: Ticket, action: unknown, minion: unknown): Promise<string> {
  const { store, runner } = app;
  if (!store.getCabal(lead.id)) throw new HttpError(403, "Only a cabal's lead does this, and you lead none");
  const n = Number(minion);
  const t = Number.isInteger(n) && n > 0 ? store.getTicketByNumber(lead.project_id, n) : undefined;
  if (!t || t.kind === 'coordinator') throw new HttpError(404, `No minion #${String(minion).slice(0, 20)} in this scheme`);
  // Its own: started by this lead from an approved row. A row's `minion` link alone doesn't make one (any minion can set it).
  const row = store.cabalRowOf(t.id);
  if (row?.lead_id !== lead.id || row.approved_at == null || t.parent !== lead.number) throw new HttpError(403, `#${t.number} isn't one you started from your approved roster: you unseal, stop and reseal only your own members`);
  if (t.status === 'closed') throw new HttpError(409, `#${t.number} is dismissed`);
  const author = `#${lead.number} ${lead.title}`;
  if (action === 'unseal') {
    if (!runner.parked(t)) throw new HttpError(409, `#${t.number} isn't sealed`);
    if (app.waiters.chains().some((c) => c.ticket === t.id && c.held)) throw new HttpError(409, `#${t.number} is on hold: only a person's Unseal or the Taskmaster starts it`);
    await unparkTicket(app, t, `#${lead.number}`, author);
    store.addCabalLog(lead.id, `#${lead.number}`, `Unsealed #${t.number}`);
    return `Unsealed #${t.number}: it runs now, or once a worker is free.`;
  }
  if (action === 'stop') {
    const { stopped, ship } = stopMinion(app, t, author);
    store.addCabalLog(lead.id, `#${lead.number}`, `Stopped #${t.number}`);
    fillFor(app, t.id);
    return `${stopped ? `Stopped #${t.number}'s turn` : `#${t.number} had no turn running`}; its queued messages are dropped.${ship ? ` ${ship}` : ''}`;
  }
  if (action === 'reseal') {
    store.updateTicket(t.id, { state: 'parked' }, { kind: 'agent', name: author });
    runner.emit(t.id, 'note', { text: `${author}, its cabal's lead, sealed it: messages to it wait until it is unsealed.` });
    runner.broadcastTicket(t.id);
    store.addCabalLog(lead.id, `#${lead.number}`, `Resealed #${t.number}`);
    await ownWrites();
    fillFor(app, t.id);
    return `Sealed #${t.number}: ${runner.isRunning(t.id) ? 'its running turn finishes, then ' : ''}messages to it wait until you unseal it.`;
  }
  throw new HttpError(400, 'action must be unseal, stop or reseal');
}
