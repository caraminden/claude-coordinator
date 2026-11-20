// The memory curator's routes (#1111): a run proposes with propose_memory, a member decides change by change on the
// Memory page, and Put back undoes an applied tidy for 30 days. The card in the run's chat waits on the page's decision.
import { join } from 'node:path';
import { cardHref } from '../card-links.ts';
import { memoryLogins } from '../decisions-load.ts';
import { lineDiff } from '../instructions.ts';
import { memoryFolders, readFolder, type MemoryFolder } from '../memory-files.ts';
import { applyChanges, checkChanges, countLine, KEEP_MS, restoreSaved, withDrift, type Change, type Proposal } from '../memory-curator.ts';
import { HttpError, json, readJson, type App, type Route } from '../http.ts';
import type { Project } from '../db.ts';
import { deliverAnswer, postPlan } from './tickets.ts';

/** The folder a tidy works on: the scheme's reachable memory folder with the most notes (one per scheme in practice). */
function target(app: App, project: Project): { folder: MemoryFolder; notes: number } | null {
  const closed = () => false;
  return memoryFolders(project.repo_dir, memoryLogins(app))
    .map((folder) => ({ folder, view: readFolder(folder, closed) }))
    .filter((f) => f.view.reachable)
    .sort((a, b) => b.view.notes.length - a.view.notes.length)
    .map(({ folder, view }) => ({ folder, notes: view.notes.length }))[0] ?? null;
}

const folderOf = (app: App, project: Project, id: string) => memoryFolders(project.repo_dir, memoryLogins(app)).find((f) => f.id === id) ?? null;

/** Settle the proposal's card in the run's chat and tell the run, which then closes itself. */
function settleCard(app: App, p: Proposal, status: 'approved' | 'rejected' | 'superseded', by: string, text: string) {
  if (p.ticket_id === null) return;
  const event = app.store.eventsOfKinds(p.ticket_id, ['plan']).find((e) => JSON.parse(e.data)?.memory?.proposal === p.id);
  if (event) {
    const card = JSON.parse(event.data);
    if (card.status === 'pending') {
      const result = { status, by, at: Date.now() };
      app.store.setEventData(event.id, { ...card, ...result });
      app.runner.emit(p.ticket_id, 'plan_result', { id: card.id, ...result });
    }
  }
  if (app.store.getTicket(p.ticket_id)?.status !== 'closed') deliverAnswer(app, p.ticket_id, by, text, { memoryProposal: { id: p.id, status } });
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
  return {
    open: open && {
      id: open.id, created_at: open.created_at, ticket: open.ticket_id === null ? null : app.store.getTicket(open.ticket_id)?.number ?? null,
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
      const t = target(app, project);
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
      const p = app.store.memoryProposals.get(Number(params.id));
      if (!p || p.project_id !== project.id) throw new HttpError(404, 'No such memory tidy');
      if (p.status !== 'open') throw new HttpError(409, p.status === 'superseded' ? 'A newer tidy replaced this one' : `${p.decided_by} already decided this tidy`);
      const body = await readJson(req);
      if (!Array.isArray(body.apply) || body.apply.some((n: unknown) => !Number.isInteger(n))) throw new HttpError(400, 'apply must list the ticked changes\' ids');
      const folder = folderOf(app, project, p.folder);
      if (!folder && body.apply.length) throw new HttpError(409, 'The memory folder this tidy was for is gone');
      const { changes, backup } = folder
        ? applyChanges(folder.dir, p.changes, new Set(body.apply), (file) => app.store.deleteClaudeState(join(folder.rel, file)))
        : { changes: p.changes.map((c) => ({ ...c, outcome: c.action === 'flag' ? 'noted' : 'turned down' })), backup: [] };
      const applied = changes.filter((c) => c.outcome === 'applied');
      const status = body.apply.length ? 'applied' : 'dismissed';
      if (!app.store.memoryProposals.decide(p.id, { status, changes, backup, by: session.name })) throw new HttpError(409, 'Someone decided this tidy just now');
      const skipped = changes.filter((c) => c.outcome === 'changed since' || c.outcome?.startsWith('failed'));
      settleCard(app, p, status === 'applied' ? 'approved' : 'rejected', session.name, status === 'applied'
        ? `${session.name} applied ${applied.length} of your memory changes (${countLine(applied) || 'none took'}).${skipped.length ? ` Skipped: ${skipped.map((c) => `${c.file} (${c.outcome})`).join(', ')}.` : ''} Nothing more to do: close yourself with close_self.`
        : `${session.name} turned the memory tidy down; nothing changed. Close yourself with close_self.`);
      return json(res, 200, { changes, view: view(app, project) });
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
      const n = restoreSaved(folder.dir, p.backup, (file) => app.store.deleteClaudeState(join(folder.rel, file)));
      app.store.memoryProposals.restored(p.id, session.name);
      return json(res, 200, { restored: n, view: view(app, project) });
    },
  },
];
