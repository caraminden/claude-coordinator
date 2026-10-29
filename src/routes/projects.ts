// Schemes: their settings and instructions, new minions, the property registry, schedules, the inbox,
// search, and one Taskmaster writing to another's.
import { mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { cleanPluginDirs, cleanRules, lines } from '../approvals.ts';
import { AGENT_NAME } from '../auth.ts';
import { EFFORTS, MAX_INSTRUCTIONS, MODELS, TICKET_TAGS, type Project, type Ticket, type TicketTag } from '../db.ts';
import { inboxItems } from '../inbox.ts';
import { instructionSources, lineDiff } from '../instructions.ts';
import { GLOBAL_OWNER, type Actor } from '../properties.ts';
import { TAG_TO_TYPE } from '../property-seed.ts';
import { describeCron, type Schedule } from '../schedules.ts';
import { claudeConfigDir } from '../sessions.ts';
import type { Chain } from '../wake.ts';
import { cloneProject, projectDir, removeProjectDir } from '../workspace.ts';
import { HttpError, json, oneOf, readJson, str, ticketView, type App, type Ctx, type Route } from '../http.ts';

// The coordinator only reads and calls its MCP tools; the work happens in the tickets it creates.
const COORDINATOR_PERMISSION_MODE = 'acceptEdits';

/** The project's coordinator ticket, created the first time someone opens the project. */
export async function ensureCoordinator(app: App, project: Project): Promise<Ticket> {
  const { store } = app;
  const existing = store.getCoordinator(project.id);
  if (existing) return existing;
  const cwd = join(projectDir(app.dataDir, project.id), 'coordinator');
  await mkdir(cwd, { recursive: true });
  try {
    const t = store.createTicket({
      project_id: project.id,
      kind: 'coordinator',
      title: 'Coordinator',
      permission_mode: COORDINATOR_PERMISSION_MODE,
      created_by: AGENT_NAME,
    });
    store.setTicketDir(t.id, cwd, null);
  } catch {
    // Lost a race with a concurrent request; the unique index kept a single coordinator.
  }
  return store.getCoordinator(project.id)!;
}

/** A schedule's name, cron, brief and type from a request body: all of them (`all`) or those given. */
function scheduleFields(app: App, projectId: number, body: any, all: boolean) {
  const out: { name?: string; cron?: string; brief?: string; type?: string } = {};
  if (all || body.name !== undefined) out.name = str(body.name, 'Name', 80);
  if (all || body.cron !== undefined) out.cron = str(body.cron, 'cron', 100);
  if (all || body.brief !== undefined) out.brief = str(body.brief, 'Brief', 100_000);
  // Each run's minion gets this type; checked against the registry now so a run can't fail on it later.
  if (all || body.type !== undefined) out.type = app.store.props.check(projectId, { type: body.type ?? 'chore' }).type?.[0] ?? 'chore';
  return out;
}

/** A schedule for the API: its cron in words and its last run's minion number. */
function scheduleView(app: App, s: Schedule) {
  return { ...s, when: describeCron(s.cron), last_number: s.last_ticket_id ? (app.store.getTicket(s.last_ticket_id)?.number ?? null) : null };
}

/** A stand-in title from the start of a first message, cut at a word near 40 characters. */
function provisionalTitle(message: string): string {
  const line = message.split('\n').find((l) => l.trim())!.replace(/\s+/g, ' ').trim();
  if (line.length <= 40) return line;
  const cut = line.slice(0, 40);
  const space = cut.lastIndexOf(' ');
  return `${(space > 20 ? cut.slice(0, space) : cut).replace(/[\s,.;:-]+$/, '')}…`;
}

/** A saved view's picks from a request: key → a non-empty list of text or number values. */
function viewPicks(v: unknown): Record<string, (string | number)[]> {
  const bad = () => new HttpError(400, 'picks must be an object of key: [values], with at least one value');
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw bad();
  const entries = Object.entries(v);
  if (!entries.length || entries.length > 50) throw bad();
  for (const [key, values] of entries) {
    if (key.length > 60 || !Array.isArray(values) || !values.length || values.length > 200) throw bad();
    if (!values.every((x) => (typeof x === 'string' && x.length <= 200) || Number.isFinite(x))) throw bad();
  }
  return v as Record<string, (string | number)[]>;
}

/** Who is changing properties: a person, a scheme's Taskmaster, or a minion. */
function actorFor({ session, caller: t }: Ctx): Actor {
  if (!t) return { kind: 'person', name: session.name };
  const kind = t.kind === 'coordinator' ? 'coordinator' : 'thread';
  return { kind, name: kind === 'coordinator' ? AGENT_NAME : `#${t.number} ${t.title}`, projectId: t.project_id, ticketId: t.id };
}

/** What people and Claude said in an event, for searching (not tool calls or their output). */
function spokenText(kind: string, data: any): string {
  if (kind === 'user_message') return typeof data?.text === 'string' ? data.text : '';
  if (data?.type !== 'assistant') return '';
  return (data.message?.content ?? []).filter((b: any) => b?.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('\n');
}

/** Minions whose chat says `q`: the newest hit per minion with a snippet, and its oldest (oldestId); `ticketId` narrows it to one. */
function searchProject(app: App, projectId: number, q: string, ticketId?: number) {
  const needle = q.toLowerCase();
  const hits = new Map<number, { ticketId: number; eventId: number; oldestId: number; at: number; snippet: string; matches: number }>();
  // SQL narrows by the raw JSON; the check below keeps only real hits in the spoken text.
  for (const ev of app.store.findEvents(projectId, q, 3000, ticketId)) {
    let text: string;
    try {
      text = spokenText(ev.kind, JSON.parse(ev.data));
    } catch {
      continue;
    }
    const at = text.toLowerCase().indexOf(needle);
    if (at < 0) continue;
    const hit = hits.get(ev.ticket_id);
    if (hit) {
      hit.matches++;
      hit.oldestId = ev.id;
      continue;
    }
    const start = Math.max(0, at - 50);
    const end = Math.min(text.length, at + needle.length + 70);
    const snippet = (start ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ').trim() + (end < text.length ? '…' : '');
    hits.set(ev.ticket_id, { ticketId: ev.ticket_id, eventId: ev.id, oldestId: ev.id, at: ev.created_at, snippet, matches: 1 });
  }
  return [...hits.values()].slice(0, 100);
}

const PEOPLE_AND_TASKMASTER = ['person', 'taskmaster'] as const;

// What one line of list_tickets shows (ticketLine in src/mcp.ts), and all a minion gets of another.
const LINE_FIELDS = ['number', 'title', 'tag', 'properties', 'build', 'model', 'effort', 'status', 'state', 'queued', 'closing', 'note', 'branch', 'created_by', 'last_activity'] as const;

export const projectRoutes: Route[] = [
  {
    method: 'GET', path: '/api/projects', who: ['person'],
    handler: ({ res, app: { store } }) => json(res, 200, store.listProjects().map((p) => ({ ...p, tickets: store.listTickets(p.id).filter((t) => t.kind === 'ticket').length }))),
  },
  {
    method: 'POST', path: '/api/projects', who: ['person'],
    async handler({ req, res, app }) {
      if (app.preview) throw new HttpError(403, 'A preview can\'t start schemes');
      const body = await readJson(req);
      const name = str(body.name, 'Name', 80);
      const repoUrl = typeof body.repoUrl === 'string' && body.repoUrl.trim() ? body.repoUrl.trim() : null;
      if (repoUrl && !/^(https:\/\/|git@)/.test(repoUrl)) throw new HttpError(400, 'Repo URL must be https:// or git@');
      let project;
      try {
        project = app.store.createProject(name, repoUrl);
      } catch {
        throw new HttpError(409, 'A scheme with that name already exists');
      }
      if (repoUrl) {
        try {
          app.store.setProjectRepoDir(project.id, await cloneProject(app.dataDir, project.id, repoUrl));
        } catch (err: any) {
          app.store.deleteProject(project.id);
          await removeProjectDir(app.dataDir, project.id);
          throw new HttpError(400, `Could not clone repo: ${err.stderr?.trim() || err.message}`);
        }
      }
      return json(res, 201, app.store.getProject(project.id));
    },
  },
  {
    method: 'GET', path: '/api/projects/:project', who: PEOPLE_AND_TASKMASTER,
    async handler({ res, app, session, caller, project }) {
      const coordinator = await ensureCoordinator(app, project);
      const tickets = app.store
        .listTickets(project.id)
        .filter((t) => t.kind === 'ticket')
        .map((t) => app.runner.view(t));
      // When this person last looked at each thread, so rows they have already seen can be shown quieter.
      const seen = caller ? {} : app.store.seenTimes(session.name, project.id);
      return json(res, 200, { project, coordinator: ticketView(app, coordinator.id), tickets, seen });
    },
  },
  {
    // The scheme's minions as list_tickets prints them, for its minions too: read-only, and only the
    // line's fields, the latest activity line among them (no approval cards, costs or paths). checkRole keeps a minion to its own scheme.
    method: 'GET', path: '/api/projects/:project/tickets', who: ['person', 'taskmaster', 'minion'],
    handler({ res, url, app, project }) {
      const closed = url.searchParams.get('include_closed') === '1';
      const tickets = app.store
        .listTickets(project.id)
        .filter((t) => t.kind === 'ticket' && (closed || t.status !== 'closed'))
        .map((t) => {
          const v = app.runner.view(t);
          return Object.fromEntries(LINE_FIELDS.map((k) => [k, v[k]]));
        });
      return json(res, 200, { tickets });
    },
  },
  {
    method: 'PATCH', path: '/api/projects/:project', who: PEOPLE_AND_TASKMASTER,
    async handler({ req, res, app, session, project }) {
      const { store, runner } = app;
      // Any of name, instructions, approval_rules, plugin_dirs and default_effort; what is left out stays.
      const body = await readJson(req);
      if (body.name === undefined && body.instructions === undefined && body.approval_rules === undefined && body.plugin_dirs === undefined && body.default_effort === undefined) {
        throw new HttpError(400, 'Nothing to change');
      }
      const name = body.name === undefined ? project.name : str(body.name, 'Name', 80);
      const settings: Partial<Pick<Project, 'approval_rules' | 'plugin_dirs' | 'default_effort'>> = {};
      // null or "" leaves effort to Claude Code's default.
      if (body.default_effort !== undefined) settings.default_effort = oneOf(body.default_effort || null, EFFORTS, 'Default effort') ?? '';
      try {
        if (body.approval_rules !== undefined) settings.approval_rules = cleanRules(body.approval_rules);
        if (body.plugin_dirs !== undefined) settings.plugin_dirs = cleanPluginDirs(body.plugin_dirs);
      } catch (err: any) {
        throw new HttpError(400, err.message);
      }
      if (body.instructions !== undefined && typeof body.instructions !== 'string') throw new HttpError(400, 'instructions must be text');
      const instructions = body.instructions === undefined ? project.instructions : body.instructions.replace(/\r\n/g, '\n').trim();
      if (instructions.length > MAX_INSTRUCTIONS) {
        throw new HttpError(400, `Instructions are ${instructions.length.toLocaleString('en')} characters; the limit is ${MAX_INSTRUCTIONS.toLocaleString('en')}`);
      }
      // Renamed first: it is the only change that can still be refused (a taken name).
      if (name !== project.name) {
        try {
          store.renameProject(project.id, name);
        } catch (err: any) {
          throw new HttpError(409, err.message);
        }
        const coordinator = store.getCoordinator(project.id);
        if (coordinator) runner.emit(coordinator.id, 'note', { text: `${session.name} renamed the scheme from "${project.name}" to "${name}".` });
      }
      for (const k of Object.keys(settings) as (keyof typeof settings)[]) if (settings[k] === project[k]) delete settings[k];
      if (Object.keys(settings).length) {
        store.setProjectSettings(project.id, settings);
        // Who changed what gets a permanent line in the coordinator's chat, since rules decide what needs a person's OK.
        const coordinator = store.getCoordinator(project.id);
        const shown = (text: string) => (text ? lines(text).join(', ') : 'none');
        if (coordinator && settings.approval_rules !== undefined) {
          runner.emit(coordinator.id, 'note', { text: `${session.name} set the approval rules to: ${shown(settings.approval_rules)}. They apply from each minion's next turn.` });
        }
        if (coordinator && settings.plugin_dirs !== undefined) {
          runner.emit(coordinator.id, 'note', { text: `${session.name} set the plugin folders to: ${shown(settings.plugin_dirs)}. They apply from each minion's next turn.` });
        }
        if (coordinator && settings.default_effort !== undefined) {
          runner.emit(coordinator.id, 'note', { text: `${session.name} set the scheme's default effort to ${settings.default_effort || "Claude Code's default"}. It applies from each minion's next turn.` });
        }
      }
      if (instructions !== project.instructions) {
        store.setProjectInstructions(project.id, instructions, session.name);
        const coordinator = store.getCoordinator(project.id);
        if (coordinator) {
          runner.emit(coordinator.id, 'note', {
            text: `${session.name} ${instructions ? 'updated' : 'cleared'} the scheme instructions; they apply from each minion's next turn.`,
          });
        }
      }
      const saved = store.getProject(project.id)!;
      app.broadcast({ type: 'project', project: saved });
      return json(res, 200, saved);
    },
  },
  {
    method: 'GET', path: '/api/projects/:project/instructions/history', who: ['person'],
    handler({ res, app, project }) {
      const history = app.store.instructionHistory(project.id, 5).map((h) => ({ by: h.by, at: h.at, diff: lineDiff(h.old_text, h.new_text) }));
      return json(res, 200, { history });
    },
  },
  {
    method: 'GET', path: '/api/projects/:project/instructions/sources', who: ['person'],
    handler: async ({ res, app, project }) => json(res, 200, { sources: await instructionSources(project, claudeConfigDir(process.env), app.dataDir), max: MAX_INSTRUCTIONS }),
  },

  {
    method: 'POST', path: '/api/projects/:project/tickets', who: PEOPLE_AND_TASKMASTER,
    async handler({ req, res, app, session, caller, project }) {
      const { store, runner, waiters } = app;
      // Every new minion gets a git worktree in the scheme's real repo.
      if (app.preview) throw new HttpError(403, 'A preview can\'t start minions');
      const body = await readJson(req);
      const message = str(body.message, 'First message', 100_000);
      // Without a title (the New thread form sends none) start from the message's opening words;
      // the thread renames itself once it knows what the work is.
      const title = body.title === undefined ? provisionalTitle(message) : str(body.title, 'Title', 120);
      // Insert first so concurrent creates get distinct ids, then build the working dir.
      const tag = oneOf(body.tag ?? null, TICKET_TAGS, 'Tag') as TicketTag | null;
      const model = oneOf(body.model ?? null, MODELS, 'Model');
      const effort = oneOf(body.effort ?? null, EFFORTS, 'Effort');
      // Properties are checked before the minion exists, so a bad one doesn't leave half a minion.
      const props: Record<string, unknown> = body.properties == null ? {} : body.properties;
      if (typeof props !== 'object' || Array.isArray(props)) throw new HttpError(400, 'properties must be an object of key: value');
      const given = (key: string) => Object.keys(props).some((k) => k.toLowerCase() === key.toLowerCase());
      if (tag && !given('type')) props.type = TAG_TO_TYPE[tag];
      if (!caller && !given('requestedBy')) props.requestedBy = session.name;
      const planned = store.props.check(project.id, props);
      if (caller && !planned.type?.length) {
        throw new HttpError(400, 'Every new minion needs a type in properties (e.g. properties: { type: "feature" }). If none fits, use "other" and ask people where it belongs.');
      }
      // Chained: start_after #N holds the brief until #N's work is live (or merged, with start_when).
      let follow: { leader: Ticket; when: Chain['when']; base: string | null; since: number } | null = null;
      if (body.start_after != null) {
        const when = (oneOf(body.start_when ?? null, ['live', 'merged'], 'start_when') ?? 'live') as Chain['when'];
        const leader = store.listTickets(project.id).find((t) => t.kind !== 'coordinator' && t.number === Number(body.start_after));
        if (!leader) throw new HttpError(400, `No minion #${String(body.start_after).slice(0, 20)} in this scheme to start after`);
        const f = waiters.follow(leader.id, when);
        if (f.state === 'unshipped') throw new HttpError(400, `#${leader.number} was dismissed without its work being merged, so nothing can start after it`);
        if (f.state === 'wait') follow = { leader, when, base: f.base, since: f.since };
      }
      // Started from a brief in a file (#129): one minion per brief, so a second start is refused.
      const brief = body.brief == null ? null : { path: str(body.brief.path, 'Brief path', 1000), heading: typeof body.brief.heading === 'string' ? body.brief.heading.trim().slice(0, 500) : '' };
      if (brief && !store.claimBrief(project.id, brief.path, brief.heading, session.name)) throw new HttpError(409, 'That brief has been started already');
      const { id, notes } = await app.newMinion(project, { title, tag, props, model, effort }, session.name)
        .catch((err) => { if (brief) store.settleBrief(project.id, brief.path, brief.heading, null); throw err; });
      if (brief) {
        store.settleBrief(project.id, brief.path, brief.heading, id);
        const coordinator = store.getCoordinator(project.id);
        if (coordinator) runner.emit(coordinator.id, 'note', { text: `${session.name} started #${store.getTicket(id)!.number} from ${brief.heading || 'the handoff'} in ${basename(brief.path)}` });
      }
      if (follow) {
        const { leader, when } = follow;
        waiters.chain({ ticket: id, after: leader.id, when, message, from: session.name, base: follow.base, since: follow.since });
        store.updateTicket(id, { state: 'parked', note: `starts when #${leader.number} is ${when}` });
        runner.emit(id, 'note', { text: `Created by ${session.name}; its brief is held until #${leader.number} ${leader.title}'s work is ${when}. A message to it starts it now.` });
        runner.broadcastTicket(id);
        notes.push(`Parked: it starts by itself once #${leader.number}'s work is ${when}. A message to it starts it now.`);
      } else {
        runner.send(id, session.name, message, [], { brief: true });
      }
      return json(res, 201, { ...ticketView(app, id), notes });
    },
  },

  // Which briefs in a file (?path=, its absolute path) have been started, and as which minion (#129).
  {
    method: 'GET', path: '/api/projects/:project/briefs', who: ['person'],
    handler: ({ res, url, app, project }) => json(res, 200, app.store.briefStarts(project.id, url.searchParams.get('path') ?? '')),
  },

  // The property registry: everyone reads it; people and the Taskmaster change it, minions propose.
  {
    method: 'GET', path: '/api/projects/:project/properties', who: ['person', 'taskmaster', 'minion'],
    handler: ({ res, app, project }) => json(res, 200, { keys: app.store.props.list(project.id), globalOwner: GLOBAL_OWNER }),
  },
  {
    method: 'POST', path: '/api/projects/:project/properties/keys', who: PEOPLE_AND_TASKMASTER,
    async handler(ctx) {
      const { app, project } = ctx;
      const r = app.store.props.registerKey(project.id, await readJson(ctx.req), actorFor(ctx));
      if (r.registered) app.registryChanged(project.id, r.scope === 'global');
      return json(ctx.res, r.registered ? 201 : 200, r);
    },
  },
  {
    method: 'POST', path: '/api/projects/:project/properties/values', who: PEOPLE_AND_TASKMASTER,
    async handler(ctx) {
      const { app, project } = ctx;
      const body = await readJson(ctx.req);
      const actor = actorFor(ctx);
      const r = app.store.props.registerValues(project.id, body.key, body.values, actor, !!body.force);
      if (r.added.length || r.updated.length) app.registryChanged(project.id, app.store.props.isGlobal(project.id, body.key));
      if (r.unreviewed) {
        const coordinator = app.store.getCoordinator(project.id);
        if (coordinator) app.runner.emit(coordinator.id, 'note', { text: `${actor.name} added ${r.added.map((v) => `${body.key}: ${v}`).join(', ')} to the registry. It's live now; review it in Settings → Properties.` });
      }
      return json(ctx.res, 200, r);
    },
  },
  {
    method: 'POST', path: '/api/projects/:project/properties/review', who: PEOPLE_AND_TASKMASTER,
    async handler(ctx) {
      const { app, project } = ctx;
      const body = await readJson(ctx.req);
      const global = app.store.props.isGlobal(project.id, body.key);
      const r = app.store.props.review(project.id, body, actorFor(ctx));
      app.registryChanged(project.id, global);
      return json(ctx.res, 200, r);
    },
  },
  {
    method: 'POST', path: '/api/projects/:project/properties/proposals', who: ['minion'],
    refuse: 'Taskmasters and people register keys and values directly; proposals are for minions',
    async handler(ctx) {
      const { app, project } = ctx;
      const body = await readJson(ctx.req);
      const actor = actorFor(ctx);
      const r = app.store.props.propose(project.id, body, actor);
      if (r.proposed) {
        app.registryChanged(project.id, false);
        const what = body.value === undefined ? `a new key \`${body.key}\`` : `\`${body.key}: ${body.value}\``;
        const coordinator = await ensureCoordinator(app, project);
        app.runner.send(coordinator.id, actor.name, `Property proposal: ${what}. Reason: ${body.reason}\n\nApprove or reject it with review_property (new keys need a person: ask them).`, []);
      }
      return json(ctx.res, 200, r);
    },
  },

  // Saved views: named property filters above the minions list, shared by everyone in the scheme.
  { method: 'GET', path: '/api/projects/:project/views', who: ['person'], handler: ({ res, app, project }) => json(res, 200, app.store.listViews(project.id)) },
  {
    method: 'POST', path: '/api/projects/:project/views', who: ['person'],
    async handler({ req, res, app, session, project }) {
      const body = await readJson(req);
      app.store.saveView(project.id, str(body.name, 'Name', 40), viewPicks(body.picks), session.name);
      app.broadcast({ type: 'views', projectId: project.id });
      return json(res, 200, app.store.listViews(project.id));
    },
  },
  {
    method: 'DELETE', path: '/api/projects/:project/views/:view', who: ['person'],
    handler({ res, app, project, params }) {
      if (!app.store.deleteView(project.id, Number(params.view))) throw new HttpError(404, 'No such view');
      app.broadcast({ type: 'views', projectId: project.id });
      return json(res, 200, app.store.listViews(project.id));
    },
  },

  // Everything in the scheme waiting on a person: open cards, and minions in state ready or try.
  { method: 'GET', path: '/api/projects/:project/inbox', who: ['person'], handler: ({ res, app, project }) => json(res, 200, { items: inboxItems(app.store, app.runner.approvals, project.id) }) },
  // What happened in the scheme since this person last did something there, for the Taskmaster chat.
  { method: 'GET', path: '/api/projects/:project/recap', who: ['person'], handler: ({ res, app, session, project }) => json(res, 200, app.store.recap(session.name, project.id)) },
  {
    method: 'GET', path: '/api/projects/:project/search', who: ['person'],
    handler({ res, url, app, project }) {
      const q = (url.searchParams.get('q') ?? '').trim().slice(0, 200);
      const ticket = Number(url.searchParams.get('ticket')) || undefined;
      return json(res, 200, q.length < 2 ? [] : searchProject(app, project.id, q, ticket));
    },
  },

  // The scheme's scheduled minions, for the Schedules panel and the Taskmaster; each with the number
  // of the minion its last run started. People and the Taskmaster add them; minions can't.
  {
    method: 'GET', path: '/api/projects/:project/schedules', who: PEOPLE_AND_TASKMASTER,
    handler: ({ res, app, project }) => json(res, 200, { schedules: app.store.schedules.list(project.id).map((s) => scheduleView(app, s)) }),
  },
  {
    method: 'POST', path: '/api/projects/:project/schedules', who: PEOPLE_AND_TASKMASTER,
    async handler({ req, res, app, session, project }) {
      const fields = scheduleFields(app, project.id, await readJson(req), true);
      const s = app.store.schedules.create({ project_id: project.id, ...(fields as Required<typeof fields>), created_by: session.name });
      app.broadcast({ type: 'schedules', projectId: project.id });
      return json(res, 201, scheduleView(app, s));
    },
  },
  // Edit, pause or resume, or delete a schedule; runs it already started stay.
  {
    method: 'PATCH', path: '/api/schedules/:schedule', who: PEOPLE_AND_TASKMASTER,
    async handler({ req, res, app, schedule: s }) {
      const body = await readJson(req);
      const patch: Record<string, unknown> = scheduleFields(app, s.project_id, body, false);
      if (body.paused !== undefined) {
        if (typeof body.paused !== 'boolean') throw new HttpError(400, 'paused must be true or false');
        patch.paused = body.paused;
      }
      const updated = app.store.schedules.update(s.id, patch);
      app.broadcast({ type: 'schedules', projectId: s.project_id });
      return json(res, 200, scheduleView(app, updated));
    },
  },
  {
    method: 'DELETE', path: '/api/schedules/:schedule', who: PEOPLE_AND_TASKMASTER,
    handler({ res, app, schedule: s }) {
      app.store.schedules.remove(s.id);
      app.broadcast({ type: 'schedules', projectId: s.project_id });
      return json(res, 200, { deleted: s.id });
    },
  },

  {
    // message_taskmaster: one scheme's Taskmaster writes to another's, the only way out of its own
    // scheme. It reaches that Taskmaster alone, never its minions.
    method: 'POST', path: '/api/taskmaster', who: ['taskmaster'], refuse: `Only a ${AGENT_NAME} can message another scheme's ${AGENT_NAME}`,
    async handler({ req, res, app, caller }) {
      const from = caller!;
      const { store, runner } = app;
      const body = await readJson(req);
      const text = str(body.text, 'Message', 10_000);
      const want = String(body.scheme ?? '').trim().toLowerCase();
      const others = store.listProjects().filter((p) => p.id !== from.project_id);
      const project = others.find((p) => p.name.toLowerCase() === want) ?? others.find((p) => String(p.id) === want);
      if (!project) {
        const own = store.getProject(from.project_id)!;
        if (want === own.name.toLowerCase() || want === String(own.id)) throw new HttpError(400, `${own.name} is your own scheme: use message_ticket for its minions`);
        throw new HttpError(404, `No other scheme called "${String(body.scheme ?? '')}". The other schemes: ${others.map((p) => `${p.name} (${p.id})`).join(', ') || 'none'}`);
      }
      const to = await ensureCoordinator(app, project);
      const sender = store.getProject(from.project_id)!.name;
      const { held, left } = runner.relayTaskmaster(from.id, to.id, `${AGENT_NAME} of ${sender}`, text);
      if (!held) runner.emit(from.id, 'note', { text: `Sent the ${AGENT_NAME} of ${project.name}: ${text.length > 200 ? text.slice(0, 200) + '…' : text}` });
      return json(res, 202, { scheme: project.name, held, left });
    },
  },
];
