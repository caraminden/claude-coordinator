// A cabal lead's hands (#2091, specs/foreman-crews-proposal.md "Forming" and "Starting, unsealing and stopping"). The
// lead lays out its roster on its board, posts it as one forming card for the scheme, and a person's go approves it
// (who and when, per row). Then the lead starts approved rows itself (cabal_start) and unseals, stops and reseals its
// own members (cabal_member), with no Taskmaster relay; the Taskmaster gets one held line per start. Width: at most
// `width` members at work at once (default 4); a start past it waits as next up and starts once a member merges, closes or is sealed. Starts
// go through createMinion, so a member's turns wait for a worker like any minion's (#1868). A row in another scheme
// (#2094, the spec's "Cabals across schemes") starts only on its own scheme's people's go, and the lead never starts it:
// it asks that scheme's Taskmaster (message_taskmaster, row and action), which starts it with cabal "<scheme>#<lead>".
import { readFile, stat } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import { tierLabel } from '../public/model-table.js';
import { AGENT_NAME, type Session } from './auth.ts';
import { cabalName, overseerOf, readBoard } from './cabal-board.ts';
import { type CardQuestion, postCard, tellTaskmaster } from './ci-armed.ts';
import type { Ticket } from './db-rows.ts';
import type { CabalMemberRow } from './db/cabals.ts';
import { type App, HttpError, ownWrites } from './http.ts';
import { expectedCost } from './minion-budget.ts';
import { APP_NAME } from './appname.ts';
import { createMinion, ensureCoordinatorFor, schemeTarget } from './routes/projects.ts';
import { relayFile } from './taskmaster-files.ts';
import { stopMinion, unparkTicket } from './routes/tickets.ts';
import { thrown } from './thrown.ts';
import { projectSharedDir } from './workspace.ts';

/** What the forming card shows of a row: a change to any of them after the go needs a new card. */
export const APPROVED_FIELDS = ['title', 'handoff', 'model', 'effort', 'cost', 'after', 'project_id'] as const;
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
/** The scheme a row's member runs in: its own, or the lead's. */
export const rowScheme = (lead: Pick<Ticket, 'project_id'>, r: Pick<CabalMemberRow, 'project_id'>) => r.project_id ?? lead.project_id;
const schemeName = (app: App, id: number) => app.store.getProject(id)?.name ?? `scheme ${id}`;
const money = (n: number) => `$${Math.round(n)}`;

/** One roster line as the forming card shows it. */
const rosterLine = (app: App, lead: Ticket) => (r: CabalMemberRow) =>
  `- ${rowScheme(lead, r) !== lead.project_id ? `[${schemeName(app, rowScheme(lead, r))}] ` : ''}${[r.label, r.title].filter(Boolean).join(' · ')} · ${r.handoff} · ${tierLabel(r.model, r.effort)}${r.cost != null ? ` · ~${money(r.cost)}` : ''}${r.after ? ` · after ${r.after}` : ''}`;

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
  const others = [...new Set(rows.map((r) => rowScheme(lead, r)).filter((p) => p !== lead.project_id))];
  const elsewhere = others.length ? `\n\nRows marked with another scheme run there and ship to its own main${lead.build != null ? `, never into Build ${lead.build}` : ''}: its Taskmaster starts them when the Overseer asks, and only that scheme's people's go approves them (they get this card too).` : '';
  const question: CardQuestion = {
    header: approved.length ? 'Add to the cabal' : 'Start the cabal',
    question:
      `${head}, ${where}, at most ${w} at work at once (the rest wait as next up)${rows.length ? `, about ${money(total)}${unknown ? ` plus ${unknown} with no estimate` : ''}` : ''}.` +
      (rows.length ? `\n\n${rows.map(rosterLine(app, lead)).join('\n')}` : '') +
      elsewhere +
      `\n\nThe go lets the Overseer start${rows.length ? ' these' : ''}, unseal, stop and reseal its own members itself, and stands for each row's start card up to its cost. Anyone not listed needs another card.`,
    multiSelect: false,
    options: [
      { label: FORM_GO, description: `The Overseer starts them from their handoffs, ${w} at a time; the Taskmaster hears of each start.`, recommended: true },
      { label: FORM_WAIT, description: 'Nothing starts. Say what to change and the Overseer posts a new card.' },
    ],
  };
  const card = postCard(app, lead, { questions: [question], cabalForm: { lead: lead.id, width: w, rows: rows.map((r) => ({ id: r.id, sig: rowSig(r) })) } });
  // Each other scheme's people get a card of their own rows in their Taskmaster's chat; its answer comes to the lead (asker).
  const own = schemeName(app, lead.project_id);
  for (const p of others) {
    const project = store.getProject(p);
    if (!project) continue;
    const theirs = rows.filter((r) => rowScheme(lead, r) === p);
    const sum = theirs.reduce((s, r) => s + (r.cost ?? 0), 0);
    postCard(app, await ensureCoordinatorFor(app, project, null), {
      asker: lead.id,
      cabalForm: { lead: lead.id, width: w, rows: theirs.map((r) => ({ id: r.id, sig: rowSig(r) })) },
      questions: [
        {
          header: 'Start cabal members',
          question:
            `${overseerOf({ name: nm })}, #${lead.number} in ${own}, leads a cabal there and asks to start ${theirs.length} of its members in ${project.name}, about ${money(sum)}:\n\n${theirs.map(rosterLine(app, lead)).join('\n')}` +
            `\n\nThey run and ship here, to ${project.name}'s own main${lead.build != null ? `, never into ${own}'s Build ${lead.build}` : ''}. Your ${AGENT_NAME} starts each when the Overseer asks, and their notes and asks go to the cabal's board. Only a ${project.name} member's go starts them.`,
          multiSelect: false,
          options: [
            { label: FORM_GO, description: `Your ${AGENT_NAME} starts them when the Overseer asks.`, recommended: true },
            { label: FORM_WAIT, description: 'Nothing starts here. Say what to change and the Overseer posts a new card.' },
          ],
        },
      ],
    });
  }
  store.addCabalLog(lead.id, `#${lead.number}`, `Posted the forming card for ${rows.map(rowName).join(', ') || `width ${w}`}`);
  cabalChanged(app, lead.id);
  return { href: card.href, rows: rows.length };
}

/**
 * The go on a forming card: approves each row it showed that still reads the same, and the width. A row in another scheme
 * only on the go of a member of that scheme (#2094). Returns the line the lead reads.
 */
export function approveRoster(app: App, form: { lead: number; width: number; rows: { id: number; sig: string }[] }, who: Pick<Session, 'name' | 'uid' | 'admin'>, at = Date.now()): string {
  const { store } = app;
  const by = who.name;
  const ok: string[] = [];
  const changed: string[] = [];
  const notTheirs: string[] = [];
  const leadT = store.getTicket(form.lead);
  for (const { id, sig } of form.rows) {
    const r = store.cabalRow(id);
    if (!r || !leadT || r.lead_id !== form.lead || r.ticket_id != null) continue;
    if (rowSig(r) !== sig) {
      changed.push(rowName(r));
      continue;
    }
    const p = rowScheme(leadT, r);
    if (p !== leadT.project_id && !store.canSee(who, p)) {
      notTheirs.push(`${rowName(r)} (${schemeName(app, p)})`);
      continue;
    }
    store.updateCabalRow(id, { approved_by: by, approved_at: at });
    ok.push(rowName(r));
  }
  store.setCabalWidth(form.lead, form.width);
  const waits = notTheirs.length ? `. Not approved, for their own scheme's people to approve on their card: ${notTheirs.join(', ')}` : '';
  store.addCabalLog(form.lead, by, `Approved on the forming card: ${ok.join(', ') || 'no rows'}; width ${form.width}${changed.length ? `. Changed since the card, so not approved: ${changed.join(', ')}` : ''}${waits}`, at);
  cabalChanged(app, form.lead);
  return `Approved: ${ok.join(', ') || 'no rows'}; width ${form.width}.${changed.length ? ` Not approved, changed after the card was posted: ${changed.join(', ')} (post a new forming card for them).` : ''}${waits ? `${waits.slice(1)}.` : ''} Start them with cabal_start, and a row in another scheme with message_taskmaster (row, action start).`;
}

/** A board was written: its open panels read it again, in the lead's scheme and every scheme with a member on it, and the minions list's cards are read again. */
export function cabalChanged(app: App, leadId: number): void {
  const { store } = app;
  const lead = store.getTicket(leadId);
  if (!lead) return;
  const schemes = new Set([lead.project_id, ...store.cabalRows(leadId).map((r) => (r.ticket_id != null ? (store.getTicket(r.ticket_id)?.project_id ?? lead.project_id) : rowScheme(lead, r)))]);
  for (const projectId of schemes) app.broadcast({ type: 'cabal', projectId, lead: leadId });
  void app.cabals?.refresh(lead.project_id).catch(() => {});
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
const atWork = async (app: App, leadId: number) => ((await readBoard(app.store, leadId, { parked: (t) => app.runner.parked(t) }))?.counts.working ?? 0) + app.store.cabalRows(leadId).filter((r) => r.asked_at != null && r.ticket_id == null).length; // a row asked of another scheme's Taskmaster holds its place

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
export async function cabalStart(app: App, lead: Ticket, rowRef: unknown, text: unknown, via: 'cabal_start' | 'message_taskmaster' = 'cabal_start'): Promise<StartResult> {
  const { store } = app;
  const cabal = store.getCabal(lead.id);
  if (!cabal) throw new HttpError(403, "Only a cabal's lead starts its members, and you lead none");
  const r = findRow(app, lead.id, rowRef);
  const there = rowScheme(lead, r) !== lead.project_id;
  if (there && via === 'cabal_start') throw new HttpError(400, `Row ${rowName(r)} is in ${schemeName(app, rowScheme(lead, r))}: its ${AGENT_NAME} starts it. Ask it with message_taskmaster (row ${r.id}, action start)`);
  if (!there && via === 'message_taskmaster') throw new HttpError(400, `Row ${rowName(r)} is in your own scheme: start it with cabal_start`);
  if (r.ticket_id != null) throw new HttpError(409, `Row ${rowName(r)} is started already: ${there ? `${schemeName(app, rowScheme(lead, r))} ` : ''}#${store.getTicket(r.ticket_id)?.number}`);
  if (r.approved_at == null) throw new HttpError(403, `Row ${rowName(r)} isn't on the approved roster: add it with a card (cabal_board action form) and start it once ${there ? `a ${schemeName(app, rowScheme(lead, r))} member` : 'a person'} says go`);
  const extra = text == null || text === '' ? '' : String(text).slice(0, 4000);
  if (!there) chainOf(app, lead, r); // refused now, not once it is next up
  if ((await atWork(app, lead.id)) >= cabal.width) {
    if (r.next_at == null) store.updateCabalRow(r.id, { next_at: Date.now() });
    store.addCabalLog(lead.id, `#${lead.number}`, `${rowName(r)} is next up: ${cabal.width} members are open`);
    cabalChanged(app, lead.id);
    const place = store.cabalRows(lead.id).filter((x) => x.next_at != null && x.ticket_id == null && (x.next_at < (r.next_at ?? Date.now()) || x.id === r.id)).length;
    return { next: place };
  }
  return startRow(app, lead, r, extra);
}

type StartResult = { started?: number; title?: string; next?: number; notes?: string[]; asked?: string; held?: boolean };

async function startRow(app: App, lead: Ticket, r: CabalMemberRow, extra: string): Promise<StartResult> {
  if (rowScheme(lead, r) !== lead.project_id) return askStart(app, lead, r, extra);
  const { store } = app;
  const project = store.getProject(lead.project_id)!;
  const nm = name(app, lead);
  const by = `${overseerOf({ name: nm })} #${lead.number}`;
  // Checked again at the start: a next-up row may start long after its card, and its handoff may be gone by then.
  const handoff = join(projectSharedDir(app.dataDir, project.id), await handoffPath(app, project.id, r.handoff));
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
    not_duplicate: true, // people approved this row's handoff on its card, even one an earlier minion started from
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
  cabalChanged(app, lead.id);
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
    if (runner.parked(t)) throw new HttpError(409, `#${t.number} is sealed already`);
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

/** A lead's ask to the Taskmaster of a row's scheme (#2094): sent from the lead, so the loop guard counts the pair, and never set as that Taskmaster's reply path. */
async function askTaskmaster(app: App, lead: Ticket, r: CabalMemberRow, need: 'start' | 'ask', text: (file: string | null) => string, handoff?: string): Promise<{ scheme: string; held: boolean }> {
  const { store, runner } = app;
  const project = store.getProject(rowScheme(lead, r));
  if (!project) throw new HttpError(409, `Row ${rowName(r)}'s scheme is gone`);
  // Only a scheme the lead's person is in: the same reach as its Taskmaster's message_taskmaster (a 404 says which).
  schemeTarget(app, lead, project.id);
  const own = store.getProject(lead.project_id)!;
  const to = await ensureCoordinatorFor(app, project, null);
  // Its handoff goes to that scheme's shared inbox/, where its minion can read it: turns never read across schemes' folders.
  const file = handoff ? relayFile(projectSharedDir(app.dataDir, own.id), projectSharedDir(app.dataDir, project.id), own.name, handoff) : null;
  const author = `${overseerOf({ name: name(app, lead) })} (#${lead.number} of ${own.name})`;
  const body = text(file?.path ?? null);
  const { held } = runner.relayTaskmaster(lead.id, to.id, author, body, true, '', false, need);
  runner.emit(lead.id, 'note', { need, text: `${held ? 'Held by the loop guard: the message' : 'Sent the message'} to the ${AGENT_NAME} of ${project.name}: ${body.length > 200 ? `${body.slice(0, 200)}…` : body}` });
  return { scheme: project.name, held };
}

/** An approved row in another scheme "starts": the lead asks that scheme's Taskmaster, and it holds its place until the member joins. */
async function askStart(app: App, lead: Ticket, r: CabalMemberRow, extra: string): Promise<StartResult> {
  const { store } = app;
  const own = schemeName(app, lead.project_id);
  const there = schemeName(app, rowScheme(lead, r));
  const nm = name(app, lead);
  const cost = r.cost != null ? `, expected_cost ${Math.round(r.cost)}` : '';
  const ships =
    lead.build != null
      ? ` It ships in ${there}, to your own main, like any of your minions: it is never merged into Build ${lead.build}, whose branch is in ${own}'s repo. If it must not go live before Build ${lead.build}, the Overseer asks you to seal it.`
      : ` It ships in ${there}, to your own main, like any of your minions.`;
  const r2 = await askTaskmaster(
    app,
    lead,
    r,
    'start',
    (file) =>
      `${overseerOf({ name: nm })} leads a cabal in ${own} and asks you to start one of its members here, in ${there}: row ${rowName(r)}, "${r.title}". ${r.approved_by} approved it for ${there} on the cabal's forming card.\n\n` +
      `Start it with create_ticket: title "${r.title}" exactly, cabal "${own}#${lead.number}" (that puts it on the cabal's board), model ${r.model}, effort ${r.effort}${cost}, and a message saying its brief is the handoff at ${file} and that it is a member of ${nm}'s cabal: it reads its cabal_board at each wake, sets its note there at milestones and sends its asks there.${ships}` +
      `\n\nIf you won't start it, tell the ${AGENT_NAME} of ${own} why with message_taskmaster.${extra ? `\n\nThe Overseer adds: ${extra}` : ''}`,
    r.handoff,
  );
  store.updateCabalRow(r.id, { next_at: null, asked_at: Date.now() });
  store.addCabalLog(lead.id, `#${lead.number}`, `Asked ${there}'s ${AGENT_NAME} to start ${rowName(r)}${r2.held ? ' (held by the loop guard)' : ''}`);
  cabalChanged(app, lead.id);
  await ownWrites();
  return { asked: there, held: r2.held, title: r.title };
}

/**
 * A lead's message_taskmaster (#2094): its own cabal's asks only, for one of its roster rows in another scheme: start
 * (an approved row), or unseal, stop or seal (a member started there for its row). Anything else is refused.
 */
export async function cabalTaskmaster(app: App, lead: Ticket, body: Record<string, unknown>): Promise<StartResult & { text?: string }> {
  const { store } = app;
  if (!store.getCabal(lead.id)) throw new HttpError(403, `message_taskmaster is a cabal lead's, for its own roster rows in other schemes, and you lead no cabal: anything for another scheme goes to your ${AGENT_NAME} with message_coordinator`);
  const action = String(body.action ?? '');
  if (!['start', 'unseal', 'stop', 'seal'].includes(action)) throw new HttpError(400, `A lead's message_taskmaster only asks a start, unseal, stop or seal for one of its roster rows in another scheme: anything else goes to your ${AGENT_NAME} with message_coordinator`);
  const r = findRow(app, lead.id, body.row);
  const p = rowScheme(lead, r);
  if (p === lead.project_id) throw new HttpError(400, `Row ${rowName(r)} is in your own scheme: use cabal_start or cabal_member`);
  const want = String(body.scheme ?? '')
    .trim()
    .toLowerCase();
  if (want && want !== schemeName(app, p).toLowerCase() && want !== String(p)) throw new HttpError(400, `Row ${rowName(r)} is in ${schemeName(app, p)}, not ${String(body.scheme).slice(0, 60)}`);
  const extra = body.text == null || body.text === '' ? '' : String(body.text).slice(0, 4000);
  if (action === 'start') return cabalStart(app, lead, r.id, extra, 'message_taskmaster');
  const there = schemeName(app, p);
  const t = r.ticket_id != null ? store.getTicket(r.ticket_id) : undefined;
  if (!t || t.project_id !== p) throw new HttpError(409, `Row ${rowName(r)} has no member started in ${there} yet: ask for its start first (action start)`);
  if (r.approved_at == null) throw new HttpError(403, `${there} #${t.number} isn't one started from your approved roster`);
  if (t.status === 'closed') throw new HttpError(409, `${there} #${t.number} is dismissed`);
  const nm = name(app, lead);
  const what =
    action === 'unseal'
      ? `unseal your #${t.number} "${t.title}" (message_ticket with unpark)`
      : action === 'stop'
        ? `stop your #${t.number} "${t.title}"'s turn (stop_ticket)`
        : `seal your #${t.number} "${t.title}" (update_ticket, state sealed) so it doesn't ship yet${lead.build != null ? `: it must not go live before ${schemeName(app, lead.project_id)}'s Build ${lead.build}. The Overseer asks you to unseal it once Build ${lead.build} is live` : ''}`;
  const r2 = await askTaskmaster(app, lead, r, 'ask', () => `${overseerOf({ name: nm })} asks you to ${what}. It is a member of ${nm}'s cabal in ${schemeName(app, lead.project_id)} (row ${rowName(r)}).${extra ? `\n\nThe Overseer adds: ${extra}` : ''}`);
  store.addCabalLog(lead.id, `#${lead.number}`, `Asked ${there}'s ${AGENT_NAME} to ${action} ${there} #${t.number}${r2.held ? ' (held by the loop guard)' : ''}`);
  cabalChanged(app, lead.id);
  const later = action === 'seal' && lead.build != null ? ` Once Build ${lead.build} is live, ask again with action unseal; relay_when_live to ${there} on your build's ship can queue that note now.` : '';
  return { asked: there, held: r2.held, text: `${r2.held ? `The loop guard held your ask to ${there}'s ${AGENT_NAME}: finish your turn.` : `Asked ${there}'s ${AGENT_NAME} to ${action} its #${t.number}; it acts in its own scheme.`}${later}` };
}
