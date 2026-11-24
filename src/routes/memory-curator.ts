// The memory curator's routes (#1111): a run proposes with propose_memory, and a member either approves it all on the
// card, which the run then applies with apply_memory (#1803), or picks change by change on the Memory page. Both write
// through decideTidy, and Put back undoes an applied tidy for 30 days.
import { join } from 'node:path';
import { cardHref } from '../card-links.ts';
import { memoryLogins } from '../decisions-load.ts';
import { lineDiff } from '../instructions.ts';
import { memoryFolders, readFolder } from '../memory-files.ts';
import { applyChanges, checkChanges, curatorTarget, countLine, KEEP_MS, restoreSaved, withDrift, type Change, type Proposal } from '../memory-curator.ts';
import { HttpError, json, readJson, type App, type Route } from '../http.ts';
import type { Project } from '../db.ts';
import { deliverAnswer, postPlan } from './tickets.ts';

const folderOf = (app: App, project: Project, id: string) => memoryFolders(project.repo_dir, memoryLogins(app)).find((f) => f.id === id) ?? null;

/** The proposal's card in its run's chat, if it has one. */
export function tidyCard(app: App, p: Proposal): { id: number; card: any } | null {
  if (p.ticket_id === null) return null;
  const event = app.store.eventsOfKinds(p.ticket_id, ['plan']).find((e) => JSON.parse(e.data)?.memory?.proposal === p.id);
  return event ? { id: event.id, card: JSON.parse(event.data) } : null;
}

/** Settle the proposal's card in the run's chat and tell the run, which then closes itself. */
function settleCard(app: App, p: Proposal, status: 'approved' | 'rejected' | 'superseded', by: string, text: string) {
  if (p.ticket_id === null) return;
  const found = tidyCard(app, p);
  // A card approved but not yet applied is settled again when the page turns it down or a newer tidy replaces it.
  if (found && (found.card.status === 'pending' || (found.card.status === 'approved' && status !== 'approved'))) {
    const result = { status, by, at: Date.now() };
    app.store.setEventData(found.id, { ...found.card, ...result });
    app.runner.emit(p.ticket_id, 'plan_result', { id: found.card.id, ...result });
  }
  if (app.store.getTicket(p.ticket_id)?.status !== 'closed') deliverAnswer(app, p.ticket_id, by, text, { memoryProposal: { id: p.id, status } });
}

/** What the card's Approve all covers: every change but the flags, which change nothing, and the deletes, which a member
 *  ticks one by one on the Memory page (Josh, 2026-11-19: "Delete, each ticked"; approve all never covers one). */
export const approveAll = (changes: Pick<Change, 'id' | 'action'>[]): number[] => changes.filter((c) => c.action !== 'flag' && c.action !== 'delete').map((c) => c.id);

/**
 * The one write path for a tidy (#1803): the page's ticks and the run's apply_memory both decide through here. Applies
 * `apply` (none turns it all down) and records the decision; a tidy already decided is refused, so nothing applies twice.
 * Synchronous from the status check to decide(), so a tidy decided meanwhile can't be written.
 */
export function decideTidy(app: App, project: Project, p: Proposal, apply: number[], by: string) {
  if (p.status !== 'open') throw new HttpError(409, p.status === 'superseded' ? 'A newer tidy replaced this one' : `${p.decided_by} already decided this tidy`);
  const folder = folderOf(app, project, p.folder);
  if (!folder && apply.length) throw new HttpError(409, 'The memory folder this tidy was for is gone');
  const { changes, backup } = folder
    ? applyChanges(folder.dir, p.changes, new Set(apply), (file) => app.store.deleteClaudeState(join(folder.rel, file)))
    : { changes: p.changes.map((c) => ({ ...c, outcome: c.action === 'flag' ? 'noted' : 'turned down' })), backup: [] };
  const status = apply.length ? 'applied' as const : 'dismissed' as const;
  if (!app.store.memoryProposals.decide(p.id, { status, changes, backup, by })) throw new HttpError(409, 'Someone decided this tidy just now');
  const applied = changes.filter((c) => c.outcome === 'applied');
  const skipped = changes.filter((c) => c.outcome === 'changed since' || c.outcome?.startsWith('failed'));
  const line = `${by} applied ${applied.length} of your memory changes (${countLine(applied) || 'none took'}).${skipped.length ? ` Skipped: ${skipped.map((c) => `${c.file} (${c.outcome})`).join(', ')}.` : ''}`;
  return { changes, status, line, applied, skipped };
}

/** One change as the page shows it: its diff, and whether its note moved on since. */
const shown = (c: Change & { drifted?: boolean }) => ({
  ...c,
  diff: c.action === 'index' ? lineDiff(c.wasLine ?? '', c.line ?? '') : c.action === 'flag' ? [] : lineDiff(c.was ?? '', c.action === 'delete' ? '' : c.text ?? ''),
});

function view(app: App, project: Project) {
  const { memoryProposals } = app.store;
  memoryProposals.prune();
  const open = memoryProposals.open(project.id);
  const dir = open ? folderOf(app, project, open.folder)?.dir : null;
  const card = open && tidyCard(app, open)?.card;
  return {
    open: open && {
      id: open.id, created_at: open.created_at, ticket: open.ticket_id === null ? null : app.store.getTicket(open.ticket_id)?.number ?? null,
      // Approved on its card (#1803) and waiting for the run to apply it: the page says so, and its ticks still work.
      approved_by: (card?.status === 'approved' && card.by) || null,
      changes: (dir ? withDrift(dir, open.changes) : open.changes).map(shown),
    },
    kept: memoryProposals.kept(project.id).map((p) => ({
      id: p.id, status: p.status, decided_by: p.decided_by, decided_at: p.decided_at, until: (p.decided_at ?? 0) + KEEP_MS,
      counts: countLine(p.changes.filter((c) => c.outcome === 'applied')),
    })),
  };
}

export const memoryCuratorRoutes: Route[] = [
  {
    // propose_memory: a curator run's tidy, checked against the folder now. Nothing is written until a member decides.
    method: 'POST', path: '/api/tickets/:ticket/memory-proposal', who: ['minion'], refuse: 'Only the curator run itself can propose a memory tidy in its chat',
    async handler({ req, res, app, ticket }) {
      const project = app.store.getProject(ticket.project_id)!;
      const t = curatorTarget(project.repo_dir, memoryLogins(app));
      if (!t) throw new HttpError(404, 'This scheme has no memory folder Citadel can reach, so there is nothing to tidy: say so in one line and close yourself');
      const body = await readJson(req);
      if (Array.isArray(body.changes) && !body.changes.length) throw new HttpError(400, 'Nothing to propose: say so in one line and close yourself with close_self');
      const changes = checkChanges(readFolder(t.folder, () => false), body.changes);
      const { proposal, superseded } = app.store.memoryProposals.create({ project_id: project.id, ticket_id: ticket.id, folder: t.folder.id, changes });
      for (const old of superseded) settleCard(app, old, 'superseded', 'Citadel', `A newer memory tidy (from #${ticket.number}) replaced this one; nothing of yours was applied. Close yourself with close_self.`);
      const counts = countLine(changes);
      const event = postPlan(app, ticket.id, {
        summary: `Memory tidy: ${counts}`,
        plan: changes.map((c) => `- **${c.action}** \`${c.file}\`: ${c.reason}`).join('\n'),
        memory: { proposal: proposal.id, project: project.id, counts },
      });
      return json(res, 201, { proposal: proposal.id, href: cardHref(ticket, event.id), folder: t.folder.dir, counts });
    },
  },
  {
    method: 'GET', path: '/api/projects/:project/memory-proposals', who: ['person'],
    handler: ({ res, app, project }) => json(res, 200, view(app, project)),
  },
  {
    // Apply the ticked changes and turn down the rest; none ticked turns the whole tidy down (Josh, 2026-11-19: "Any scheme member").
    method: 'POST', path: '/api/projects/:project/memory-proposals/:id/decide', who: ['person'],
    async handler({ req, res, app, project, params, session }) {
      // The body first: from the status check to decide() nothing awaits, so a tidy superseded or decided meanwhile can't be written.
      const body = await readJson(req);
      const p = app.store.memoryProposals.get(Number(params.id));
      if (!p || p.project_id !== project.id) throw new HttpError(404, 'No such memory tidy');
      if (!Array.isArray(body.apply) || body.apply.some((n: unknown) => !Number.isInteger(n))) throw new HttpError(400, 'apply must list the ticked changes\' ids');
      const { changes, status, line } = decideTidy(app, project, p, body.apply, session.name);
      settleCard(app, p, status === 'applied' ? 'approved' : 'rejected', session.name, status === 'applied'
        ? `${line} Nothing more to do: close yourself with close_self.`
        : `${session.name} turned the memory tidy down; nothing changed. Close yourself with close_self.`);
      return json(res, 200, { changes, view: view(app, project) });
    },
  },
  {
    // apply_memory (#1803; Cara, 2026-11-24: "We should make it something a minion can do with approval"): the run applies
    // its own tidy once a member pressed Approve on its card, through the same decideTidy as the page's ticks.
    method: 'POST', path: '/api/tickets/:ticket/memory-proposal/apply', who: ['minion'], refuse: 'Only the curator run itself applies its approved tidy',
    handler({ res, app, ticket }) {
      const project = app.store.getProject(ticket.project_id)!;
      const p = app.store.memoryProposals.latestOf(ticket.id);
      if (!p) throw new HttpError(404, 'This minion has proposed no memory tidy');
      if (p.status !== 'open') throw new HttpError(409, p.status === 'superseded' ? 'A newer tidy replaced yours; nothing of yours was applied. Close yourself with close_self.' : `${p.decided_by} already ${p.status === 'applied' ? 'applied' : 'turned down'} this tidy; nothing more to apply. Report that and close yourself with close_self.`);
      const card = tidyCard(app, p)?.card;
      if (card?.status !== 'approved') throw new HttpError(409, 'Not approved: a member approves the tidy on its card (or ticks it on the Memory page), and the answer comes as a message. Apply nothing yourself; end your turn in state ready.');
      const { changes, applied, skipped } = decideTidy(app, project, p, approveAll(p.changes), card.by);
      const line = `Applied ${applied.length} of the ${approveAll(p.changes).length} changes ${card.by} approved (${countLine(applied) || 'none took'}).${skipped.length ? ` Skipped: ${skipped.map((c) => `${c.file} (${c.outcome})`).join(', ')}.` : ''}`;
      return json(res, 200, { line, changes: changes.map((c) => ({ action: c.action, file: c.file, outcome: c.outcome })) });
    },
  },
  {
    // Put back: every note an applied tidy touched goes back as it was, while its copy is kept (30 days).
    method: 'POST', path: '/api/projects/:project/memory-proposals/:id/restore', who: ['person'],
    async handler({ res, app, project, params, session }) {
      app.store.memoryProposals.prune();
      const p = app.store.memoryProposals.get(Number(params.id));
      if (!p || p.project_id !== project.id) throw new HttpError(404, 'No such memory tidy');
      if (!p.backup) throw new HttpError(409, p.restored_by ? `${p.restored_by} already put it back` : 'Its old notes are no longer kept (30 days)');
      const folder = folderOf(app, project, p.folder);
      if (!folder) throw new HttpError(409, 'The memory folder this tidy was for is gone');
      const { restored, failed } = restoreSaved(folder.dir, p.backup, (file) => app.store.deleteClaudeState(join(folder.rel, file)));
      // Its copy stays until every note is back: putting one back twice writes the same text, so a retry is safe.
      if (failed.length) throw new HttpError(409, `Put back ${restored} of ${p.backup.length}; not ${failed.join(', ')}. Fix that and press Put back again.`);
      app.store.memoryProposals.restored(p.id, session.name);
      return json(res, 200, { restored, view: view(app, project) });
    },
  },
];
