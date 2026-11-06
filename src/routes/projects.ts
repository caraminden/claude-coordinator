// Schemes: their settings and instructions, new minions, the property registry, schedules, the inbox,
// search, and one Taskmaster writing to another's.
import { mkdir, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { cleanPluginDirs, cleanRules, lines } from '../approvals.ts';
import { APP_NAME } from '../appname.ts';
import { catalogue } from '../catalogue.ts';
import { AGENT_NAME } from '../auth.ts';
import { askerKey, EFFORTS, MAX_INSTRUCTIONS, MODELS, ONBOARDING, ONBOARDING_MODES, onboardingOpen, type Project, type Ticket, type User } from '../db.ts';
import { adminAskRefusal, askedCitadelKey, CITADEL_REPLY_MS, lendsMachines, taskmasterTargets } from '../access.ts';
import { inboxCount, inboxItems } from '../inbox.ts';
import { instructionSources, lineDiff } from '../instructions.ts';
import { GLOBAL_OWNER, type Actor } from '../properties.ts';
import { checkFolder, citadelOwner, cloneFolder, errorText, GITHUB_OWNER, githubRepoExists, githubUrl, initRepo, pushToGithub, repoName, SOURCES, validOwner, type GithubEnv, type Source } from '../scheme-repo.ts';
import { personGithub } from '../github-link.ts';
import { describeCron, type Schedule } from '../schedules.ts';
import { KIT } from '../runner.ts';
import { claudeConfigDir } from '../sessions.ts';
import type { Chain } from '../wake.ts';
import { cloneProject, projectDir, removeProjectDir } from '../workspace.ts';
import { ICON_HEADERS, iconVersion, readIcon } from '../scheme-icon.ts';
import { spokenText } from '../memory.ts';
import { buildNumber, HttpError, json, oneOf, readJson, send, str, ticketView, workflowSwitch, type App, type Ctx, type Route } from '../http.ts';

// The coordinator only reads and calls its MCP tools; the work happens in the tickets it creates.
const COORDINATOR_PERMISSION_MODE = 'acceptEdits';

/** A non-admin's GitHub for work the server does for them (#195): their linked token, or no login, never the box's. */
const githubOf = (app: App, user: User) => personGithub(app.github, user, join(app.dataDir, 'people', String(user.id)));

const LINK_FIRST = 'Link GitHub in Settings → Your account first: a new repo goes on your own GitHub account';

/**
 * `owner/name` of the GitHub repo a new scheme called `name` gets, and whose login makes it. An
 * admin's goes under the Citadel-wide owner with the box's login; anyone else's under their own
 * linked account with their token (#195).
 */
async function newRepoSlug(app: App, name: string, admin: boolean, user: User | undefined): Promise<{ slug: string; as: GithubEnv }> {
  let owner: string | null;
  let as: GithubEnv;
  if (admin) {
    owner = app.store.getSetting<string>(GITHUB_OWNER) ?? await citadelOwner();
    if (!owner) throw new HttpError(400, `Set the GitHub owner for new schemes in Settings → ${APP_NAME}-wide first`);
  } else {
    const mine = user ? githubOf(app, user) : null;
    if (!mine?.login) throw new HttpError(403, LINK_FIRST);
    ({ login: owner, env: as } = mine);
  }
  const repo = repoName(name);
  if (!repo) throw new HttpError(400, 'The scheme name needs a letter or digit to name its GitHub repo');
  return { slug: `${owner}/${repo}`, as };
}

/** Put a new scheme's repo on GitHub, recording the outcome on the scheme for its strip. */
async function putOnGithub(app: App, projectId: number, dir: string, slug: string, checked: boolean, as: GithubEnv): Promise<Project> {
  try {
    await pushToGithub(dir, slug, checked, as);
    app.store.setProjectUpstream(projectId, githubUrl(slug), null);
  } catch (err) {
    // Keeps any repo_url: a Retry racing one that just worked mustn't drop its URL.
    app.store.setProjectUpstream(projectId, app.store.getProject(projectId)!.repo_url, errorText(err));
  }
  const saved = app.store.getProject(projectId)!;
  app.broadcast({ type: 'project', project: saved });
  return saved;
}

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

/** Where a new scheme's code came from, for the kickoff message. */
function codeLine(p: Project, source: Source, folder: string | null): string {
  if (source === 'none') return 'no code';
  if (source === 'url') return `cloned from ${p.repo_url}`;
  if (source === 'folder') return `cloned from the folder ${folder}${p.repo_url !== folder ? `, origin ${p.repo_url}` : ''}`;
  return p.github_error ? `a new repo; its GitHub repo wasn't created yet (${p.github_error})` : `a new repo, on GitHub at ${p.repo_url}`;
}

/** The first message a new scheme's Taskmaster gets from "Create and set up": the form, quoted. */
export function kickoff(name: string, code: string, by: string, about: string): string {
  const said = about ? `${by} wrote: "${about}"` : `${by} left "What's it about?" empty, so start by asking.`;
  return `New scheme "${name}" (code: ${code}), created by ${by}. ${said}\n\nSet it up: onboarding has started.`;
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

/** A new minion's `parent` (#N in this scheme), or null for none; a number with no minion here is refused. */
function parentMinion(store: App['store'], projectId: number, n: unknown): Ticket | null {
  if (n === null) return null;
  const t = Number.isInteger(n) ? store.listTickets(projectId).find((t) => t.kind === 'ticket' && t.number === n) : undefined;
  if (!t) throw new HttpError(400, `parent must be a minion number in this scheme; there is no #${String(n).slice(0, 20)} here`);
  return t;
}

/** The minion with this id, if it is one of this scheme's (not its Taskmaster). */
function sameScheme(store: App['store'], projectId: number, id: number | null): Ticket | null {
  const t = id === null ? undefined : store.getTicket(id);
  return t && t.project_id === projectId && t.kind === 'ticket' ? t : null;
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
function actorFor({ session, caller: t, app, project }: Ctx): Actor {
  if (!t) return { kind: 'person', name: session.name };
  if (t.kind !== 'coordinator') return { kind: 'thread', name: `#${t.number} ${t.title}`, projectId: t.project_id, ticketId: t.id };
  return { kind: 'coordinator', name: AGENT_NAME, projectId: t.project_id, ticketId: t.id, setupPlan: project && approvedSetupPlan(app, project, t) };
}

/**
 * While this scheme's setup or tune-up is open, the text of the plan a person approved in its
 * Taskmaster's chat (#180). The newest plan card must be approved, by a person (only they can), after
 * this round opened: a Taskmaster that reopens onboarding by itself has no plan to register under.
 */
function approvedSetupPlan(app: App, project: Project, t: Ticket): string | undefined {
  if (!onboardingOpen(project) || t.project_id !== project.id) return undefined;
  const card = app.store.latestPlan(t.id);
  const plan = card && JSON.parse(card.data);
  return plan?.status === 'approved' && plan.at > app.store.onboardingOpenedAt(project.id) ? `${plan.summary}\n${plan.plan}` : undefined;
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

/** The schemes a person is in (all of them for an admin). */
function visibleSchemes(store: App['store'], who: { uid?: number; admin?: boolean }): Project[] {
  const seen = store.visibleProjects(who);
  return store.listProjects().filter((p) => !seen || seen.has(p.id));
}

// What one line of list_tickets shows (ticketLine in src/mcp.ts), and all a minion gets of another.
const LINE_FIELDS = ['number', 'title', 'properties', 'build', 'model', 'effort', 'workflow', 'status', 'state', 'queued', 'closing', 'note', 'branch', 'created_by', 'parent', 'last_activity'] as const;

export const projectRoutes: Route[] = [
  {
    method: 'GET', path: '/api/projects', who: ['person'],
    // inbox: the count on the scheme's Needs-you badge, for the scheme switcher.
    // icon: the version of the scheme's favicon (#222) for its URL, or null when it has none.
    // hidden: this person hid it (#226); its badge stays at zero.
    // running: a minion or its Taskmaster has a turn running (#248), for the spinner; false when hidden.
    // working: how many minions (not the Taskmaster) have a turn running, the number beside the spinner (#278); 0 when hidden.
    handler: async ({ res, app: { store, runner }, session }) => {
      const hidden = store.hiddenProjects(session.uid ?? -1);
      json(res, 200, await Promise.all(visibleSchemes(store, session).map(async (p) => {
        const tickets = store.listTickets(p.id);
        return {
          ...p, owner: store.getUser(p.owner_id ?? -1)?.name ?? null, tickets: tickets.filter((t) => t.kind === 'ticket').length,
          hidden: hidden.has(p.id),
          inbox: hidden.has(p.id) ? 0 : inboxCount(store, runner.approvals, p.id, session.name, store.seenTimes(session.name, p.id)),
          running: !hidden.has(p.id) && tickets.some((t) => t.status === 'running'),
          working: hidden.has(p.id) ? 0 : tickets.filter((t) => t.kind === 'ticket' && t.status === 'running').length,
          icon: await iconVersion(p.repo_dir),
        };
      })));
    },
  },
  {
    // Hide a scheme from your own lists, badges and pushes, or show it again (#226). Only ever your own.
    method: 'PUT', path: '/api/projects/:project/hidden', who: ['person'],
    async handler({ req, res, app, session, project }) {
      const body = await readJson(req);
      if (typeof body.hidden !== 'boolean') throw new HttpError(400, 'hidden must be true or false');
      if (session.uid === undefined) throw new HttpError(400, 'Sign in again first');
      app.store.setProjectHidden(session.uid, project.id, body.hidden);
      // Every stream of the scheme's people gets it; each tab refreshes only for its own person, like views.
      app.broadcast({ type: 'hidden', name: session.name, projectId: project.id });
      return json(res, 200, { hidden: body.hidden });
    },
  },
  {
    // The scheme's favicon (src/scheme-icon.ts). Its URL carries the version, so it can be kept long.
    method: 'GET', path: '/api/projects/:project/icon', who: ['person'],
    async handler({ res, project }) {
      const icon = await readIcon(project.id, project.repo_dir);
      if (!Buffer.isBuffer(icon)) throw new HttpError(404, icon.missing);
      send(res, 200, { ...ICON_HEADERS, 'Cache-Control': 'private, max-age=31536000, immutable' }, icon);
    },
  },
  {
    // What a scheme being set up can adapt (#172): names and descriptions from every scheme's .claude/ and the kit, never file bodies.
    method: 'GET', path: '/api/catalogue', who: PEOPLE_AND_TASKMASTER,
    handler: ({ res, app, session, caller }) => {
      // A Taskmaster sees what its scheme's owner sees.
      const owner = caller ? app.store.getUser(app.store.getProject(caller.project_id)?.owner_id ?? -1) : null;
      const who = caller ? { uid: owner?.id, admin: !!owner?.admin } : session;
      return json(res, 200, { items: catalogue(visibleSchemes(app.store, who), KIT) });
    },
  },
  {
    method: 'POST', path: '/api/projects', who: ['person'],
    async handler({ req, res, app, session }) {
      if (app.preview) throw new HttpError(403, 'A preview can\'t start schemes');
      const body = await readJson(req);
      const name = str(body.name, 'Name', 80);
      // Checked first too, so a taken name doesn't cost a GitHub lookup; the unique index still decides.
      if (app.store.listProjects().some((p) => p.name === name)) throw new HttpError(409, 'A scheme with that name already exists');
      const repoUrl = typeof body.repoUrl === 'string' && body.repoUrl.trim() ? body.repoUrl.trim() : null;
      // Without a source (older forms), a URL means clone it and none means no repo.
      const source = (oneOf(body.source ?? null, SOURCES, 'Source') ?? (repoUrl ? 'url' : 'none')) as Source;
      let upstream: string | null = null;
      let folder: string | null = null;
      let slug: string | null = null;
      // Whose GitHub the clone or the new repo uses: undefined is the box's login, an admin's only (#195).
      let as: GithubEnv;
      const user = session.uid ? app.store.getUser(session.uid) : undefined;
      // A folder on this machine could be anyone's, another scheme's included.
      if (source === 'folder' && !session.admin) throw new HttpError(403, 'Only an admin can start a scheme from a folder on the server');
      const about = body.about == null || body.about === '' ? '' : str(body.about, 'About', 4000);
      // "Create and set up" starts the Taskmaster's onboarding; "Create only" (and older callers) skip it.
      const setup = body.setup === true;
      if (source === 'url') {
        if (!repoUrl) throw new HttpError(400, 'Repo URL is required');
        if (!/^(https:\/\/|git@)/.test(repoUrl)) throw new HttpError(400, 'Repo URL must be https:// or git@');
        upstream = repoUrl;
        if (!session.admin) {
          // The box's SSH key and gh login are Cara's: anyone else clones with their own token, or none.
          if (!repoUrl.startsWith('https://')) throw new HttpError(400, 'Use the repo\'s https:// URL: a git@ URL would clone with the server\'s own SSH key');
          if (!user) throw new HttpError(403, 'Sign in with your own login to clone a repo');
          as = githubOf(app, user).env;
        }
      } else if (source === 'folder') {
        const checked = await checkFolder(str(body.folder, 'Folder', 4096), app.dataDir);
        if ('error' in checked) throw new HttpError(400, checked.error);
        folder = checked.path;
      } else if (source === 'new') {
        ({ slug, as } = await newRepoSlug(app, name, !!session.admin, user));
        // Refused before anything exists, with the name shown so the person can pick another.
        if (await githubRepoExists(slug, as) === true) throw new HttpError(409, `GitHub repo ${slug} already exists; pick another scheme name`);
      }
      let project;
      try {
        project = app.store.createProject(name, upstream, session.uid ?? null);
      } catch {
        throw new HttpError(409, 'A scheme with that name already exists');
      }
      if (source !== 'none') {
        const dir = join(projectDir(app.dataDir, project.id), 'repo');
        try {
          if (source === 'url') await cloneProject(app.dataDir, project.id, repoUrl!, as);
          else {
            // Project ids can be reused after a failed create; clear any leftover partial repo.
            await rm(dir, { recursive: true, force: true });
            await mkdir(dir, { recursive: true });
            if (source === 'folder') app.store.setProjectUpstream(project.id, await cloneFolder(folder!, dir), null);
            else await initRepo(dir, name, about);
          }
          app.store.setProjectRepoDir(project.id, dir);
        } catch (err: any) {
          app.store.deleteProject(project.id);
          await removeProjectDir(app.dataDir, project.id);
          throw new HttpError(400, `${source === 'new' ? 'Could not make the repo' : 'Could not clone repo'}: ${errorText(err)}`);
        }
        // A GitHub failure keeps the scheme: the strip on it offers Retry, so a blip doesn't lose the form.
        if (source === 'new') await putOnGithub(app, project.id, dir, slug!, true, as);
      }
      app.store.setProjectSettings(project.id, { onboarding: setup ? 'interview' : 'skipped' });
      if (setup) {
        const coordinator = await ensureCoordinator(app, app.store.getProject(project.id)!);
        app.runner.send(coordinator.id, APP_NAME, kickoff(name, codeLine(app.store.getProject(project.id)!, source, folder), session.name, about));
      }
      return json(res, 201, app.store.getProject(project.id));
    },
  },
  {
    // Try again to put a new scheme's repo on GitHub after it failed at creation. It goes where the
    // create would have put it: on the scheme owner's GitHub, with their token, unless they're an admin (#195).
    method: 'POST', path: '/api/projects/:project/github', who: ['person'], access: 'owner',
    async handler({ res, app, project }) {
      if (app.preview) throw new HttpError(403, 'A preview can\'t make GitHub repos');
      if (!project.github_error || !project.repo_dir) throw new HttpError(409, 'This scheme has no GitHub repo waiting to be made');
      const owner = project.owner_id === null ? undefined : app.store.getUser(project.owner_id);
      // A scheme with no owner left was an admin's to begin with (#34 made new repos admin-only).
      const { slug, as } = await newRepoSlug(app, project.name, !owner || !!owner.admin, owner);
      const saved = await putOnGithub(app, project.id, project.repo_dir, slug, false, as);
      if (saved.github_error) throw new HttpError(502, `GitHub repo not created: ${saved.github_error}`);
      return json(res, 200, saved);
    },
  },
  {
    // Citadel-wide settings: the GitHub owner new schemes' repos are made under.
    method: ['GET', 'PUT'], path: '/api/app/settings', who: ['person'],
    async handler({ req, res, app, session }) {
      if (req.method === 'PUT') {
        if (!session.admin) throw new HttpError(403, 'Only an admin can do that');
        const body = await readJson(req);
        if (body.github_owner !== undefined) {
          const owner = typeof body.github_owner === 'string' ? body.github_owner.trim() : '';
          if (owner && !validOwner(owner)) throw new HttpError(400, 'GitHub owner must be an account or organisation name, like caraminden');
          if (owner) app.store.setSetting(GITHUB_OWNER, owner);
          else app.store.deleteSetting(GITHUB_OWNER);
        }
      }
      return json(res, 200, { github_owner: app.store.getSetting<string>(GITHUB_OWNER), github_owner_default: await citadelOwner() });
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
      // People's notes (#146) are for people only: a minion or the Taskmaster gets none.
      const person_notes = caller ? {} : app.store.personNotes(project.id);
      // This person's pinned minions (#179), oldest pin first.
      const pins = caller ? [] : app.store.pinnedTickets(session.name, project.id);
      return json(res, 200, { project, coordinator: ticketView(app, coordinator.id), tickets, seen, person_notes, pins });
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
    method: 'PATCH', path: '/api/projects/:project', who: PEOPLE_AND_TASKMASTER, access: 'owner',
    async handler({ req, res, app, session, caller, project }) {
      const { store, runner } = app;
      // Any of name, instructions, approval_rules, plugin_dirs, default_effort, machine_tools, onboarding, onboarding_mode and list_groups; what is left out stays.
      const body = await readJson(req);
      const fields = ['name', 'instructions', 'approval_rules', 'plugin_dirs', 'default_effort', 'machine_tools', 'onboarding', 'onboarding_mode', 'list_groups'];
      if (fields.every((k) => body[k] === undefined)) throw new HttpError(400, 'Nothing to change');
      const name = body.name === undefined ? project.name : str(body.name, 'Name', 80);
      const settings: Partial<Pick<Project, 'approval_rules' | 'plugin_dirs' | 'default_effort' | 'machine_tools' | 'onboarding' | 'onboarding_mode' | 'list_groups'>> = {};
      // Unlike oneOf, null and '' are refused: there is no "unset" onboarding.
      const required = (v: unknown, all: readonly string[], field: string) => {
        if (typeof v !== 'string' || !all.includes(v)) throw new HttpError(400, `${field} must be one of: ${all.join(', ')}`);
        return v;
      };
      if (body.onboarding !== undefined) settings.onboarding = required(body.onboarding, ONBOARDING, 'onboarding') as Project['onboarding'];
      if (body.onboarding_mode !== undefined) settings.onboarding_mode = required(body.onboarding_mode, ONBOARDING_MODES, 'onboarding_mode') as Project['onboarding_mode'];
      // null or "" leaves effort to Claude Code's default.
      if (body.default_effort !== undefined) settings.default_effort = oneOf(body.default_effort || null, EFFORTS, 'Default effort') ?? '';
      if (body.machine_tools !== undefined) {
        if (typeof body.machine_tools !== 'boolean') throw new HttpError(400, 'machine_tools must be true or false');
        settings.machine_tools = body.machine_tools ? 1 : 0;
      }
      try {
        if (body.approval_rules !== undefined) settings.approval_rules = cleanRules(body.approval_rules);
        if (body.plugin_dirs !== undefined) settings.plugin_dirs = cleanPluginDirs(body.plugin_dirs);
        if (body.list_groups !== undefined) settings.list_groups = JSON.stringify(store.props.listGroups(project.id, body.list_groups));
      } catch (err: any) {
        throw new HttpError(400, err.message);
      }
      // Plugins load code from any folder on the server: an admin's, or an admin's scheme's Taskmaster's.
      if (settings.plugin_dirs !== undefined && settings.plugin_dirs !== (project.plugin_dirs ?? '') && !session.admin) {
        if (!caller || !lendsMachines(store, project)) throw new HttpError(403, 'Only an admin can change plugin folders');
        const refused = adminAskRefusal(store, caller.id);
        if (refused) throw new HttpError(403, refused);
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
        if (coordinator && settings.machine_tools !== undefined) {
          runner.emit(coordinator.id, 'note', { text: `${session.name} ${settings.machine_tools ? 'gave' : 'took'} the connected machines' tools ${settings.machine_tools ? 'to' : 'from'} this scheme's minions. It applies from each minion's next turn.` });
        }
        if (coordinator && settings.onboarding === 'skipped') {
          runner.emit(coordinator.id, 'note', { text: `${session.name} skipped the scheme's setup. Tell the ${AGENT_NAME} to pick it up again any time.` });
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
    // Settings' "Tune up" (#175): onboarding again in tune-up mode, and a message that starts the Taskmaster on it.
    method: 'POST', path: '/api/projects/:project/tune-up', who: ['person'],
    async handler({ res, app, session, project }) {
      if (onboardingOpen(project)) throw new HttpError(409, `${project.onboarding_mode === 'tune-up' ? 'A tune-up' : 'Setup'} is under way already`);
      // The Taskmaster first, so a failure there can't leave onboarding open with nobody told.
      const coordinator = await ensureCoordinator(app, project);
      if (onboardingOpen(app.store.getProject(project.id)!)) throw new HttpError(409, 'A tune-up is under way already');
      app.store.setProjectSettings(project.id, { onboarding: 'interview', onboarding_mode: 'tune-up' });
      app.runner.send(coordinator.id, session.name, 'Tune up this scheme: onboarding is on again, in tune-up mode.');
      const saved = app.store.getProject(project.id)!;
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
    // The Citadel-wide instructions: people, and the Citadel scheme's Taskmaster only (checked below).
    method: ['GET', 'PUT'], path: '/api/app/instructions', who: PEOPLE_AND_TASKMASTER, access: 'admin',
    async handler({ req, res, app, session, caller }) {
      const { store, runner } = app;
      if (caller && caller.project_id !== GLOBAL_OWNER) {
        throw new HttpError(403, `Only people and the ${APP_NAME} scheme's ${AGENT_NAME} use this. The ${APP_NAME}-wide instructions are already in your prompt; to propose a change, message that ${AGENT_NAME} with message_taskmaster`);
      }
      const refused = caller && adminAskRefusal(store, caller.id);
      if (refused) throw new HttpError(403, refused);
      if (req.method === 'GET') return json(res, 200, store.appInstructions());
      const body = await readJson(req);
      if (typeof body.text !== 'string') throw new HttpError(400, 'text must be text');
      const text = body.text.replace(/\r\n/g, '\n').trim();
      if (text.length > MAX_INSTRUCTIONS) {
        throw new HttpError(400, `Instructions are ${text.length.toLocaleString('en')} characters; the limit is ${MAX_INSTRUCTIONS.toLocaleString('en')}`);
      }
      if (text !== store.appInstructions().text) {
        store.setAppInstructions(text, session.name);
        // Every Taskmaster gets the line, since the text reaches every scheme.
        for (const p of store.listProjects()) {
          const coordinator = store.getCoordinator(p.id);
          if (coordinator) runner.emit(coordinator.id, 'note', { text: `${session.name} ${text ? 'updated' : 'cleared'} the ${APP_NAME}-wide instructions; they apply from each minion's next turn in every scheme.` });
        }
        app.broadcast({ type: 'app-instructions', instructions: store.appInstructions() });
      }
      return json(res, 200, store.appInstructions());
    },
  },
  {
    method: 'GET', path: '/api/app/instructions/history', who: ['person'], access: 'admin',
    handler({ res, app }) {
      const history = app.store.appInstructionHistory(5).map((h) => ({ by: h.by, at: h.at, diff: lineDiff(h.old_text, h.new_text) }));
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
      const model = oneOf(body.model ?? null, MODELS, 'Model');
      const effort = oneOf(body.effort ?? null, EFFORTS, 'Effort');
      const workflow = body.workflow == null ? 0 : workflowSwitch(body.workflow);
      // Properties are checked before the minion exists, so a bad one doesn't leave half a minion.
      const props: Record<string, unknown> = body.properties == null ? {} : body.properties;
      if (typeof props !== 'object' || Array.isArray(props)) throw new HttpError(400, 'properties must be an object of key: value');
      const given = (key: string) => Object.keys(props).some((k) => k.toLowerCase() === key.toLowerCase());
      // shortcut: an old session's retired tag (#254) becomes its type through type's aliases (process → chore, idea → ideation); remove after a release.
      if (body.tag && !given('type')) props.type = body.tag;
      if (!caller && !given('requestedBy')) props.requestedBy = session.name;
      // The minion it is started for (#273): `parent` (#N, null for none), else the minion whose relay the Taskmaster's turn answers.
      const parent = body.parent !== undefined ? parentMinion(store, project.id, body.parent) : caller ? sameScheme(store, project.id, runner.relayedBy(caller.id)) : null;
      // A new minion is its starter's: the person, or for the Taskmaster the minion that asked for it, else the person of its turn.
      if (!given('assigned')) {
        const assigned = !caller ? session.name : (parent && store.props.forTarget('minion', parent.id).assigned) || (caller.person_id && store.getUser(caller.person_id)?.name);
        if (assigned) props.assigned = assigned;
      }
      const planned = store.props.check(project.id, props);
      if (caller && !planned.type?.length) {
        throw new HttpError(400, 'Every new minion needs a type in properties (e.g. properties: { type: "feature" }). If none fits, use "other" and ask people where it belongs.');
      }
      // Chained: start_after #N holds the brief until #N's work is live (or merged, with start_when).
      let follow: { leader: Ticket; when: Chain['when']; base: string | null; since: number } | null = null;
      let leader: Ticket | undefined;
      if (body.start_after != null) {
        const when = (oneOf(body.start_when ?? null, ['live', 'merged'], 'start_when') ?? 'live') as Chain['when'];
        leader = store.listTickets(project.id).find((t) => t.kind !== 'coordinator' && t.number === Number(body.start_after));
        if (!leader) throw new HttpError(400, `No minion #${String(body.start_after).slice(0, 20)} in this scheme to start after`);
        const f = waiters.follow(leader.id, when);
        if (f.state === 'unshipped') throw new HttpError(400, `#${leader.number} was dismissed without its work being merged, so nothing can start after it`);
        if (f.state === 'wait') follow = { leader, when, base: f.base, since: f.since };
      }
      // Its build: the one the create sets (null: none), as `build` or the build property; else its parent's, else its start_after leader's.
      const build = body.build !== undefined ? buildNumber(body.build) : given('build') ? undefined : parent?.build ?? leader?.build ?? null;
      // Started from a brief in a file (#129): one minion per brief, so a second start is refused.
      const brief = body.brief == null ? null : { path: str(body.brief.path, 'Brief path', 1000), heading: typeof body.brief.heading === 'string' ? body.brief.heading.trim().slice(0, 500) : '' };
      if (brief && !store.claimBrief(project.id, brief.path, brief.heading, session.name)) throw new HttpError(409, 'That brief has been started already');
      const { id, notes } = await app.newMinion(project, { title, props, model, effort }, session.name)
        .catch((err) => { if (brief) store.settleBrief(project.id, brief.path, brief.heading, null); throw err; });
      // Its first turn runs for whoever asked: the person, or the person of the Taskmaster's turn that made it.
      store.updateTicket(id, { person_id: caller ? caller.person_id : session.uid ?? null, parent: parent?.number ?? null, ...(workflow ? { workflow } : {}) });
      if (build) {
        store.updateTicket(id, { build });
        store.props.setBuild(id, build, session.name);
      }
      // And it is that turn's asker's ask (#255), so its messages back count as theirs.
      const asker = caller && store.turnAsker(caller.id);
      if (asker && asker !== caller!.person_id) store.setSetting(askerKey(id), asker);
      if (brief) {
        store.settleBrief(project.id, brief.path, brief.heading, id);
        const coordinator = store.getCoordinator(project.id);
        if (coordinator) runner.emit(coordinator.id, 'note', { text: `${session.name} started #${store.getTicket(id)!.number} from ${brief.heading || 'the handoff'} in ${basename(brief.path)}` });
      }
      if (follow) {
        const { leader, when } = follow;
        waiters.chain({ ticket: id, after: leader.id, when, message, from: session.name, base: follow.base, since: follow.since });
        store.updateTicket(id, { state: 'parked', note: `starts when #${leader.number} is ${when}` });
        runner.emit(id, 'note', { text: `Created by ${session.name}; its brief is held until #${leader.number} ${leader.title}'s work is ${when}. A message to it gets an answer and it stays parked; Start now starts it.` });
        runner.broadcastTicket(id);
        notes.push(`Parked: it starts by itself once #${leader.number}'s work is ${when}. A message to it gets an answer and it stays parked; message_ticket with start_now starts it now.`);
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
      if (r.unreviewed.length) {
        const coordinator = app.store.getCoordinator(project.id);
        if (coordinator) app.runner.emit(coordinator.id, 'note', { text: `${actor.name} added ${r.unreviewed.map((v) => `${body.key}: ${v}`).join(', ')} to the registry. It's live now; review it in Settings → Properties.` });
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

  // Saved views: each person's own named property filters above the minions list (#194).
  { method: 'GET', path: '/api/projects/:project/views', who: ['person'], handler: ({ res, app, session, project }) => json(res, 200, app.store.listViews(project.id, session.name)) },
  {
    method: 'POST', path: '/api/projects/:project/views', who: ['person'],
    async handler({ req, res, app, session, project }) {
      const body = await readJson(req);
      app.store.saveView(project.id, session.name, str(body.name, 'Name', 40), viewPicks(body.picks));
      // Every stream gets it; each tab refreshes only for its own person, like ticket_pin.
      app.broadcast({ type: 'views', name: session.name, projectId: project.id });
      return json(res, 200, app.store.listViews(project.id, session.name));
    },
  },
  {
    method: 'DELETE', path: '/api/projects/:project/views/:view', who: ['person'],
    handler({ res, app, session, project, params }) {
      if (!app.store.deleteView(project.id, session.name, Number(params.view))) throw new HttpError(404, 'No such view');
      app.broadcast({ type: 'views', name: session.name, projectId: project.id });
      return json(res, 200, app.store.listViews(project.id, session.name));
    },
  },

  // Everything in the scheme waiting on a person: open cards, and minions in state ready or try.
  { method: 'GET', path: '/api/projects/:project/inbox', who: ['person'], handler: ({ res, app, session, project }) => json(res, 200, { items: inboxItems(app.store, app.runner.approvals, project.id, session.name) }) },
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
  // Search by meaning (#331): the scheme's chunks closest to q. scope mine: the calling minion's own
  // chat, or a person's own messages. The router keeps people to their schemes and agents to their own.
  {
    method: 'GET', path: '/api/projects/:project/memory', who: ['person', 'taskmaster', 'minion'],
    async handler({ res, url, app, project, caller, session }) {
      const q = (url.searchParams.get('q') ?? '').trim().slice(0, 1000);
      if (q.length < 2) throw new HttpError(400, 'Say what to look for (q)');
      const mine = oneOf(url.searchParams.get('scope'), ['scheme', 'mine'], 'scope') === 'mine';
      const limit = Number(url.searchParams.get('limit')) || 5;
      if (!app.memory.indexed(project.id)) throw new HttpError(409, `${project.name}'s chats aren't indexed for search by meaning yet`);
      const hits = await app.store.memory
        .search(project.id, q, app.memory.embed, app.memory.model, { limit, ...(mine ? (caller ? { ticketId: caller.id } : { personId: session.uid ?? -1 }) : {}) })
        .catch((err) => {
          console.error('Semantic memory search failed:', err?.cause?.code ?? err?.message ?? err);
          throw new HttpError(503, "The embedding service isn't answering, so search by meaning is down; exact-text search still works");
        });
      return json(res, 200, { hits });
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
      const own = store.getProject(from.project_id)!;
      // Only schemes the turn's person is in, and Citadel (src/access.ts): a scheme they aren't in gets
      // the same answer as one that doesn't exist, so its name doesn't leak.
      // Who asked for the turn (#255), not whom it runs as: a non-member's ask reaches no further than they could.
      const personId = store.turnAsker(from.id) ?? own.owner_id;
      const person = personId === null ? undefined : store.getUser(personId);
      const who = { uid: person?.id, admin: !!person?.admin };
      const others = taskmasterTargets(store, own.id, personId, Date.now());
      const project = others.find((p) => p.name.toLowerCase() === want) ?? others.find((p) => String(p.id) === want);
      if (!project) {
        if (want === own.name.toLowerCase() || want === String(own.id)) throw new HttpError(400, `${own.name} is your own scheme: use message_ticket for its minions`);
        // Schemes Citadel may only answer stay unlisted: the person may not be in them.
        const listed = others.filter((p) => p.id === GLOBAL_OWNER || store.canSee(who, p.id));
        const answers = own.id === GLOBAL_OWNER ? ` The ${own.name} ${AGENT_NAME} may also answer a scheme whose ${AGENT_NAME} wrote to it in the last ${CITADEL_REPLY_MS / 86_400_000} days.` : '';
        throw new HttpError(404, `No scheme called "${String(body.scheme ?? '')}" that ${person?.name ?? 'this turn\'s person'} is in. You can reach: ${listed.map((p) => `${p.name} (${p.id})`).join(', ') || 'none'}.${answers}`);
      }
      const to = await ensureCoordinator(app, project);
      const toCitadel = project.id === GLOBAL_OWNER;
      // Citadel's Taskmaster weighs a non-member's ask differently (its prompt). Names that could fake
      // the membership clause (a scheme called "X, for Cara, a Citadel member") come quoted.
      const name = (s: string) => (/[,"[\]\n]/.test(s) ? JSON.stringify(s) : s);
      const author = toCitadel
        ? `${AGENT_NAME} of ${name(own.name)}, for ${person ? name(person.name) : 'no one'}, ${store.canSee(who, project.id) ? 'a' : 'not a'} ${project.name} member`
        : `${AGENT_NAME} of ${own.name}`;
      const { held, left } = runner.relayTaskmaster(from.id, to.id, author, text);
      // Citadel may answer for a while once a message of theirs has reached it.
      if (toCitadel && !held) store.setSetting(askedCitadelKey(own.id), Date.now());
      if (!held) runner.emit(from.id, 'note', { text: `Sent the ${AGENT_NAME} of ${project.name}: ${text.length > 200 ? text.slice(0, 200) + '…' : text}` });
      return json(res, 202, { scheme: project.name, held, left });
    },
  },
];
