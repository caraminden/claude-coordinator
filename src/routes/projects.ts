// Schemes: their settings and instructions, new minions, the property registry, schedules, the inbox,
// search, and one Taskmaster writing to another's.
import { checkAsk, formatAsk } from '../ask-form.ts';
import { cleanMsgSettings, cleanNeverHold } from '../msg-settings.ts';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { checkNeed } from '../needs.ts';
import { basename, join, relative, sep } from 'node:path';
import { handoffIn, LATER_STALE_MS, STATUSES as IDEA_STATUSES, type Idea } from '../ideas.ts';
import { cleanPluginDirs, cleanPluginPicks, cleanRules, cleanShotNote, cleanShotThemes, cleanShotWidths, cleanWorkflows, lines } from '../approvals.ts';
import { APP_NAME } from '../appname.ts';
import { catalogue } from '../catalogue.ts';
import { findPlugins } from '../plugin-scan.ts';
import { AGENT_NAME } from '../auth.ts';
import { askerKey, buildOwnerKey, BUILDS_MODES, EFFORTS, FABLE_OKS, GH_RUNNERS_MODES, GRILL_MODES, LAND_MODES, MAX_INSTRUCTIONS, MAX_PERSONAL_INSTRUCTIONS, MODELS, ONBOARDING, ONBOARDING_MODES, onboardingOpen, type Project, type Ticket, type User } from '../db.ts';
import { adminAskRefusal, askedCitadelKey, CITADEL_REPLY_MS, adminOwned, taskmasterTargets } from '../access.ts';
import { HomeBucketCache, homeSince, homeView, inboxItems, inboxWaiting, minionCount } from '../inbox.ts';
import { readScope } from '../read-scope.ts';
import { isShipping, isWorking } from '../../public/schemecounts.js';
import { pickFor, pickReason, tierLabel } from '../../public/model-table.js';
import { FLAG_RULE, findRepeats, flagBlock, flagNote, ownBrief, steppedTier } from '../repeat-bugs.ts';
import { inOrder } from '../../public/reorder.js';
import { GO_FROM, label, SHIP_PATHS, shippingGate, TRY_FIRST, values } from '../../public/shipping.js';
import { instructionSources, lineDiff } from '../instructions.ts';
import { repoSetup } from '../repo-setup.ts';
import { GLOBAL_OWNER, type Actor } from '../properties.ts';
import { checkFolder, citadelOwner, cloneFolder, errorText, GITHUB_OWNER, githubRepoExists, githubUrl, initRepo, pushToGithub, repoName, SOURCES, validOwner, type GithubEnv, type Source } from '../scheme-repo.ts';
import { personGithub } from '../github-link.ts';
import { claimName, type Claim } from '../claims.ts';
import { postCard } from '../ci-armed.ts';
import { pacific } from '../pacific.ts';
import { checkAudits } from '../standard-audits.ts';
import { FLAKE_WINDOW_MS, PROOF_RUNS, fileChangedAt, flakeBrief } from '../flakes.ts';
import { LAND_REDS_MS, landReds, readRetro } from '../land-reds.ts';
import { MODEL_REQUIRED, scheduleFields, scheduleTemplate, scheduleView } from './schedule-api.ts';
import { turnEnv, turnPins } from '../turn-launch.ts';
import { byteSize } from '../prompts.ts';
import { claudeConfigDir } from '../sessions.ts';
import { deleteNote, indexNote, memoryFolders, noteFile, readFolder, saveNote } from '../memory-files.ts';
import { thrown } from '../thrown.ts';
import { loadDecisions, memoryLogins, recheckDecisions } from '../decisions-load.ts';
import { timerBroken } from '../timer-alerts.ts';
import { mailParksUnderOldRule } from '../rule-parks.ts';
import { heldPlan, readVerdicts, ruleHome, saveInstructions, settingsOverlaps, verdictPrompt, type FindReplace } from '../instructions-save.ts';
import { runDescribe } from '../review-describe.ts';
import { postPlan } from '../plan-cards.ts';
import { cardHref } from '../card-links.ts';
import { inScope, searchDecisions } from '../decisions.ts';
import { chainIs, type Chain } from '../wake.ts';
import { EFFORT_KEY, effortFor } from '../effort-retros.ts';
import { chainsOf, type Chain as ChainView, type WaitLink } from '../chains.ts';
import { cloneProject, projectDir, projectSharedDir, removeProjectDir } from '../workspace.ts';
import { briefWarning, namedFiles } from '../brief-lint.ts';
import { budgetKey, type BudgetState, expectedCost, money, START_CARD_USD, startCard, startHoldKey, startNote } from '../minion-budget.ts';
import { relayFile } from '../taskmaster-files.ts';
import { mergedAfter, mergedPage } from '../history.ts';
import { KIT_DIR, listSkills, offSkills } from '../skills.ts';
import { iconHeaders, iconVersion, readIcon } from '../scheme-icon.ts';
import { addArchitectureCheck, addMemoryCurator } from '../standard-audits.ts';
import { spokenText, TWIN_SCORE, type MemoryHit } from '../memory.ts';
import { buildNumber, HttpError, json, oneOf, ownWrites, readJson, send, str, ticketView, workflowSwitch, type App, type Ctx, type Route } from '../http.ts';

// The coordinator only reads and calls its MCP tools; the work happens in the tickets it creates.
/** Home's 14-day ship buckets, the same for every person, kept a minute (#1217 review). */
const homeBuckets = new HomeBucketCache();
/** Each scheme's chains, kept 5 s: every chat open asks for them (#1679). */
const chainCache = new Map<number, { at: number; chains: ChainView[] }>();

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
    owner = app.store.getSetting<string>(GITHUB_OWNER) ?? (await citadelOwner());
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
  await ownWrites(); // the strip and Retry read the outcome back (#1244)
  const saved = app.store.getProject(projectId)!;
  app.broadcast({ type: 'project', project: saved });
  return saved;
}

/**
 * The scheme another scheme's Taskmaster (`from`) may message: only schemes the turn's person is in, and Citadel (src/access.ts).
 * A scheme they aren't in gets the same answer as one that doesn't exist, so its name doesn't leak.
 */
export function schemeTarget(app: App, from: Ticket, scheme: unknown) {
  const { store } = app;
  const want = String(scheme ?? '')
    .trim()
    .toLowerCase();
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
    throw new HttpError(404, `No scheme called "${String(scheme ?? '')}" that ${person?.name ?? "this turn's person"} is in. You can reach: ${listed.map((p) => `${p.name} (${p.id})`).join(', ') || 'none'}.${answers}`);
  }
  return { own, person, who, project };
}

/**
 * message_taskmaster naming the sender's own scheme with a `person` (#1855): that member's Taskmaster in a split scheme.
 * Null when it names another scheme, or none: schemeTarget then answers (own scheme without a person says message_ticket).
 * Refuses the sender itself, an unknown person, and a member with no Taskmaster of their own.
 */
function sameSchemeTarget(app: App, from: Ticket, scheme: unknown, person: unknown) {
  const { store } = app;
  const want = String(scheme ?? '').trim().toLowerCase();
  const own = store.getProject(from.project_id)!;
  if (want !== own.name.toLowerCase() && want !== String(own.id)) return null;
  if (person == null || person === '') return null;
  const raw = str(person, 'person', 200);
  const user = store.findUser('name', store.props.personName(raw) || raw);
  if (!user) throw new HttpError(400, `No person called "${raw}"`);
  const to = store.listCoordinators(own.id).find((t) => t.coordinator_of === user.id);
  if (!to) throw new HttpError(400, `${user.name} has no ${AGENT_NAME} of their own in ${own.name}: ${own.name} is one scheme, so ask them in the chat or leave a note on a minion`);
  if (to.id === from.id) throw new HttpError(400, `That is yourself: ${user.name} is your own ${AGENT_NAME}`);
  const asker = store.turnAsker(from.id) ?? own.owner_id;
  const asked = asker === null ? undefined : store.getUser(asker);
  return { own, person: asked, who: { uid: asked?.id, admin: !!asked?.admin }, project: own, to };
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

/**
 * The Taskmaster a person's message goes to (#919): their own, made the first time a member who isn't the owner
 * writes (that splits the scheme, R3: "From the second person"). The owner before a split, a non-member and
 * nobody get the scheme's only one or, after the split, the Overlord.
 */
export async function ensureCoordinatorFor(app: App, project: Project, personId: number | null | undefined): Promise<Ticket> {
  const { store, runner } = app;
  const only = await ensureCoordinator(app, project);
  if (personId == null) return store.getOverlord(project.id) ?? only;
  const own = store.coordinatorFor(project.id, personId) ?? only;
  if (own.coordinator_of === personId) return own;
  const split = store.isSplit(project.id);
  if (!split && (project.owner_id == null || project.owner_id === personId)) return own;
  if (!store.listMembers(project.id).some((m) => m.id === personId)) return own;
  const before = new Set(store.listCoordinators(project.id).map((t) => t.id));
  const mine = store.splitScheme(project.id, personId);
  if (!split) runner.emit(only.id, 'note', { text: `${store.getUser(personId)?.name ?? 'Someone'} wrote to the ${AGENT_NAME}, so each person in this scheme now has their own; this one is ${store.getUser(project.owner_id!)?.name ?? 'the owner'}'s, and a new Overlord does the scheme-wide jobs.` });
  for (const t of store.listCoordinators(project.id)) if (!before.has(t.id) || t.id === only.id) runner.broadcastTicket(t.id);
  return mine;
}

/** Which Taskmaster of scheme `project` last wrote to Taskmaster `to`: where `to`'s next message there goes, once (#919). */
const replyKey = (to: number, project: number) => `taskmaster_reply:${to}:${project}`;

/**
 * The Taskmaster of `project` a message_taskmaster from `from` reaches (#919): with `person`, that member's own,
 * else the Overlord; without, the one of `project` that last wrote to `from` (a reply, once), else the sender's
 * person's own, else the Overlord. An unsplit scheme has just the one.
 */
async function taskmasterTo(app: App, from: Ticket, own: Project, project: Project, person: unknown): Promise<Ticket> {
  const { store } = app;
  const only = await ensureCoordinator(app, project);
  if (person != null && person !== '') {
    const raw = str(person, 'person', 200);
    const user = store.findUser('name', store.props.personName(raw) || raw);
    if (!user) throw new HttpError(400, `No person called "${raw}"; leave person out for the scheme's Overlord`);
    return store.coordinatorFor(project.id, user.id) ?? only;
  }
  const back = store.getTicket(store.getSetting<number>(replyKey(from.id, project.id)) ?? 0);
  store.deleteSetting(replyKey(from.id, project.id));
  if (back?.kind === 'coordinator' && back.project_id === project.id) return back;
  return store.coordinatorFor(project.id, from.coordinator_of) ?? only;
}

/** " (Josh's)" or " (the Overlord)" after a split scheme's Taskmaster's name, so the receiver knows who wrote. */
function senderLabel(app: App, from: Ticket): string {
  if (!app.store.isSplit(from.project_id)) return '';
  return from.coordinator_of == null ? ' (the Overlord)' : ` (${app.store.getUser(from.coordinator_of)?.name ?? 'someone'}'s)`;
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

/** Minion hits with each one's owner (its `assigned`, for the duplicate checks' "Josh's") and whether it's close enough to be a twin. */
function minionHits(app: App, hits: MemoryHit[]): (MemoryHit & { owner: string | null; twin: boolean })[] {
  return hits.map((h) => ({ ...h, owner: String(app.store.props.forTarget('minion', h.ticket_id).assigned ?? '') || null, twin: h.score >= TWIN_SCORE }));
}

/**
 * After a start: a person's gets a quiet note in its chat naming open minions that read like the same work (#689);
 * in a split scheme the Overlord hears of every start but its own as held mail, and gets a card when one reads like
 * another person's open minion (#921). Never blocks the start; a failed search says nothing.
 */
async function startChecks(app: App, projectId: number, id: number, startedBy: string, caller: Ticket | null | undefined, text: string) {
  const { store } = app;
  const minion = store.getTicket(id);
  const overlord = store.isSplit(projectId) ? store.getOverlord(projectId) : undefined;
  const watching = overlord && overlord.id !== caller?.id ? overlord : undefined;
  if (!minion) return;
  if (watching) app.runner.leaveMail(watching.id, 'Citadel', `${startedBy} started #${minion.number} ${minion.title}`);
  if ((caller && !watching) || !app.memory.indexed(projectId)) return;
  try {
    const hits = await app.store.memory.search(projectId, text.slice(0, 1000), app.memory.embed, app.memory.model, { limit: 3, openMinions: true });
    const twins = minionHits(app, hits).filter((h) => h.twin && h.ticket_id !== id);
    if (!twins.length || !store.getTicket(id)) return;
    if (!caller) app.runner.emit(id, 'note', { text: `Similar and open: ${twins.map((h) => `#${h.number} '${h.title}'${h.owner ? `, ${h.owner}'s` : ''}`).join('; ')}` });
    // The Overlord only flags another person's: a person's own look-alikes are theirs and their Taskmaster's to see.
    const mine = store.minionOwner(minion) ?? (caller ? caller.coordinator_of : null);
    const theirs = twins.map((h) => ({ ...h, by: store.minionOwner({ id: h.ticket_id }) })).find((h) => h.by != null && h.by !== mine);
    if (!watching || !theirs) return;
    const who = store.getUser(theirs.by!)?.name ?? 'someone';
    postCard(app, watching, {
      questions: [
        {
          header: 'Duplicate start?',
          question: `${startedBy} started #${minion.number} '${minion.title}', which reads like ${who}'s #${theirs.number} '${theirs.title}' (match ${theirs.score.toFixed(2)}). Same work?`,
          multiSelect: false,
          options: [
            { label: 'Both stay', description: 'Different work after all; nothing to do.', recommended: true },
            { label: `Dismiss #${minion.number}`, description: `#${theirs.number} carries on; #${minion.number} is dismissed and its starter told why.` },
            { label: 'Merge into one', description: `Both owners' Taskmasters are sent a note, which they read on their next turn, to agree which minion carries on with both briefs.` },
          ],
        },
      ],
    });
  } catch {}
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
  const line = message
    .split('\n')
    .find((l) => l.trim())!
    .replace(/\s+/g, ' ')
    .trim();
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

/** Where a claim's holder is (#1334), and how far along the bar: its plan's steps fill Working; Reviewing and Shipping sit near the end. */
function holderStage(app: App, t: Ticket | undefined): { stage: 'working' | 'reviewing' | 'shipping' | null; progress: number; step: { n: number; of: number; done: number } | null } {
  if (!t || t.kind === 'coordinator') return { stage: null, progress: 0, step: null };
  if (t.state === 'pending-deploy' || app.landings.get(t.id)?.code === null) return { stage: 'shipping', progress: 0.93, step: null };
  const step = t.status === 'closed' ? null : app.runner.progressOf(t).step;
  if (step?.label && /review/i.test(step.label) && step.done < step.of) return { stage: 'reviewing', progress: 0.78, step };
  return { stage: 'working', progress: step ? 0.6 * (step.done / step.of) : 0, step: step && { n: step.n, of: step.of, done: step.done } };
}

/** A queued minion's state for its chip: a past holder, chained behind another (start_after), not started yet, working now, or waiting. */
function queuedState(app: App, t: Ticket | undefined, done: boolean): { state: string; after: number | null } {
  if (done) return { state: 'done', after: null };
  const chain = t && app.waiters.chains().find((c) => c.ticket === t.id);
  if (chain) return { state: 'chained', after: app.store.getTicket(chain.after)?.number ?? null };
  if (!t || t.status === 'closed') return { state: 'gone', after: null };
  if (t.status === 'new') return { state: 'new', after: null };
  return { state: app.runner.isRunning(t.id) || app.runner.turnLine.has(t.id) ? 'working' : 'waiting', after: null };
}

/**
 * A claim as the tools and the page show it: its holder's number and title and a Pacific time beside the ids, and its
 * queue (#1334): past holders, the holder's stage, the waiting in order, and when the history allows, each one's expected start.
 */
export function claimView(app: App, c: Claim, now = Date.now()) {
  const { store } = app;
  const t = store.getTicket(c.holder);
  // A Taskmaster that took a claim for itself has no number: name it (#921).
  const holder_name = t?.kind !== 'coordinator' ? `#${t?.number ?? c.holder} ${t?.title ?? ''}`.trim() : t.coordinator_of != null ? `${store.getUser(t.coordinator_of)?.name ?? 'a person'}'s Taskmaster` : store.isSplit(t.project_id) ? 'the Overlord' : 'the Taskmaster';
  const rows = store.claims.queue(c.project_id, c.name);
  const est = rows.some((r) => r.done_at == null) ? store.claims.estimate(c.project_id, c.name) : null;
  const left = est ? Math.max(est.median - (now - c.since), 0) : 0;
  let ahead = 0;
  const queue = rows.map((r) => {
    const q = store.getTicket(r.ticket);
    const done = r.done_at != null;
    const starts = est && !done ? now + left + est.median * ahead++ : null;
    return { number: q?.number ?? null, title: q?.title ?? '', ...queuedState(app, q, done), done_at: r.done_at, how: r.how, starts_at: starts, starts_text: starts ? pacific(starts) : null };
  });
  const waiting = queue.filter((q) => q.state !== 'done').length;
  return {
    ...c,
    holder_number: t?.number ?? null,
    holder_title: t?.title ?? '',
    holder_name,
    since_text: `since ${pacific(c.since)}`,
    ...holderStage(app, t),
    queue,
    // Steps of this run: past holders, the holder, the waiting. Its time left only once ESTIMATE_MIN holders have finished.
    done: queue.length - waiting,
    total: queue.length + 1,
    estimate: est && waiting ? { left_ms: left + est.median * waiting, median_ms: est.median, of: est.of } : null,
  };
}

/** A claim's queue from a body's list of minion numbers: open minions of this scheme, in order. */
function queueOf(app: App, projectId: number, raw: unknown): number[] {
  if (!Array.isArray(raw) || raw.length > 50) throw new HttpError(400, 'queue is a list of up to 50 minion numbers, first in line first');
  return raw.map((n) => {
    const t = app.store.getTicketByNumber(projectId, Number(n));
    if (!t || t.kind === 'coordinator' || t.status === 'closed') throw new HttpError(400, `No open minion #${Number(n)} in this scheme`);
    return t.id;
  });
}

const PEOPLE_AND_TASKMASTER = ['person', 'taskmaster'] as const;

/** The schemes a person is in (all of them for an admin). */
function visibleSchemes(store: App['store'], who: { uid?: number; admin?: boolean }): Project[] {
  const seen = store.visibleProjects(who);
  return store.listProjects().filter((p) => !seen || seen.has(p.id));
}

// What one line of list_tickets shows (ticketLine in src/mcp.ts), and all a minion gets of another.
export const LINE_FIELDS = ['number', 'title', 'properties', 'build', 'model', 'effort', 'workflow', 'plugin_dirs', 'status', 'state', 'queued', 'closing', 'note', 'branch', 'created_by', 'parent', 'last_activity', 'open_cards'] as const;

export const projectRoutes: Route[] = [
  {
    method: 'GET',
    path: '/api/projects',
    who: ['person'],
    // inbox: the count on the scheme's Needs-you badge, for the scheme switcher.
    // icon: the version of the scheme's favicon (#222) for its URL, or null when it has none.
    // hidden: this person hid it (#226); its badge stays at zero.
    // member: they own it or were added to it (#674); false for one only admin reach opens, listed apart from theirs.
    // running: a minion or its Taskmaster has a turn doing work (#248; not one held on an approval card, #373), for the spinner; false when hidden.
    // shipping: how many minions have no turn but the server works for them: ship in line, landing, deploying (#727, #1294); 0 when hidden.
    // working: how many minions (not the Taskmaster) have a turn doing work, the number beside the spinner (#278); 0 when hidden.
    // coordinator_id: the scheme's Taskmaster, null until its first open makes one.
    // fresh: something waits on this person that wasn't waiting when they last had the scheme open (#498, #539), for the
    // violet badge. A scheme they've never had open since #539 takes today's items as seen, so nothing is marked on day one.
    handler: async ({ res, app: { store, runner }, session }) => {
      const hidden = store.hiddenProjects(session.uid ?? -1);
      const member = store.memberSchemes(session.uid);
      const busy = (t: Ticket) => isWorking({ status: runner.shownStatus(t), approvals: runner.approvals.waiting(t.id), server_work: runner.serverWork(t.id) });
      const seenItems = store.seenItems(session.name);
      // In the order they dragged the shelf into (#649); one they haven't placed goes at the end.
      const schemes: Project[] = inOrder(visibleSchemes(store, session), (p: Project) => p.id, session.uid === undefined ? [] : store.listOrder(session.uid, 'schemes'));
      // Each scheme's part up to its icon's await runs in one read scope (src/read-scope.ts, #1527): the people, settings and waits it reads per minion come once.
      json(
        res,
        200,
        await Promise.all(
          readScope(store.db, () =>
            schemes.map(async (p) => {
              const tickets = store.listTickets(p.id);
              const waiting = hidden.has(p.id) ? [] : inboxWaiting(store, runner.approvals, p.id, session.name, store.seenTimes(session.name, p.id));
              const seen = seenItems.get(p.id);
              if (!hidden.has(p.id) && !seen)
                store.setSeenItems(
                  session.name,
                  p.id,
                  waiting.map((i) => i.key),
                  true,
                );
              const inbox = minionCount(waiting);
              return {
                ...p,
                owner: store.getUser(p.owner_id ?? -1)?.name ?? null,
                tickets: tickets.filter((t) => t.kind === 'ticket').length,
                hidden: hidden.has(p.id),
                member: member.has(p.id),
                inbox,
                fresh: !!seen && waiting.some((i) => !seen.has(i.key)),
                running: !hidden.has(p.id) && tickets.some(busy),
                working: hidden.has(p.id) ? 0 : tickets.filter((t) => t.kind === 'ticket' && busy(t)).length,
                shipping: hidden.has(p.id) ? 0 : tickets.filter((t) => t.kind === 'ticket' && isShipping({ status: runner.shownStatus(t), approvals: runner.approvals.waiting(t.id), server_work: runner.serverWork(t.id) })).length,
                icon: await iconVersion(p.repo_dir, { store, projectId: p.id }),
                // Its Taskmaster, so a scheme switch fetches that chat alongside the scheme (#538): the person's own once split (#919).
                coordinator_id: store.coordinatorFor(p.id, session.uid ?? null)?.id ?? null,
              };
            }),
          ),
        ),
      );
    },
  },
  {
    // Home (#1140): what waits on you across your schemes, what's working in them, and what shipped since your last visit here.
    method: 'GET',
    path: '/api/home',
    who: ['person'],
    handler: async ({ res, app: { store, runner, ciHealth }, session }) => {
      await homeBuckets.ready(store);
      const busy = (t: Ticket) => isWorking({ status: runner.shownStatus(t), approvals: runner.approvals.waiting(t.id), server_work: runner.serverWork(t.id) });
      const home = homeView(store, runner.approvals, session, busy, homeSince(store, session.name, Date.now()), Date.now(), homeBuckets);
      // The waiting minions as a scheme's list draws them (#1217: Josh, 2026-11-20, "the normal minion list render"), and when this person last opened each.
      const ids = [...new Set(home.items.map((i) => i.ticketId))];
      const seen: Record<number, number> = {};
      for (const s of home.schemes) for (const [id, at] of Object.entries(store.seenTimes(session.name, s.id))) if (ids.includes(Number(id))) seen[Number(id)] = at;
      // #1662: what's broken now in the schemes they can see, for the strip at the top (CI problems, then failed timer jobs).
      const see = (id: number) => store.canSee(session, id);
      const broken = [...(ciHealth?.broken(see) ?? []), ...timerBroken(store, see)];
      json(res, 200, { ...home, tickets: runner.views(ids.map((id) => store.getTicket(id)).filter((t): t is Ticket => !!t)), seen, broken });
    },
  },
  {
    // Hide a scheme from your own lists, badges and pushes, or show it again (#226). Only ever your own.
    method: 'PUT',
    path: '/api/projects/:project/hidden',
    who: ['person'],
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
    // A scheme's month of outside-API spend by service, OpenRouter beside it, and its optional cap (#839). Any member reads; any member sets the cap.
    method: ['GET', 'PUT'],
    path: '/api/projects/:project/spend',
    who: ['person'],
    async handler({ req, res, app, project }) {
      if (req.method === 'PUT') {
        const body = await readJson(req);
        if (!('cap_usd' in body)) throw new HttpError(400, 'cap_usd is a number, or null for none');
        app.outsideSpend.setCap(project.id, body.cap_usd);
      }
      return json(res, 200, app.outsideSpend.month(project.id));
    },
  },
  {
    // The Needs-you items this person saw waiting while in the scheme (#539: InboxItem.key): the scheme list marks the badge when one not among them waits.
    method: 'PUT',
    path: '/api/projects/:project/seen-items',
    who: ['person'],
    async handler({ req, res, app, session, project }) {
      const { keys } = await readJson(req);
      if (!Array.isArray(keys) || keys.length > 1000 || !keys.every((k) => typeof k === 'string' && k.length <= 200)) throw new HttpError(400, 'keys must be a list of item keys');
      app.store.setSeenItems(session.name, project.id, keys);
      // Their other tabs and devices unmark the badge too; each tab takes only its own person's.
      app.broadcast({ type: 'seen-items', name: session.name, projectId: project.id });
      return json(res, 200, { keys });
    },
  },
  {
    // The scheme's favicon (src/scheme-icon.ts). Its URL carries the version, so it can be kept long.
    method: 'GET',
    path: '/api/projects/:project/icon',
    who: ['person'],
    async handler({ res, project, session, app: { store, contraptions } }) {
      // The home app may gate its routes: it is asked as the person asking, when they may use it.
      const user = typeof session.uid === 'number' ? store.getUser(session.uid) : undefined;
      const icon = await readIcon(project.id, project.repo_dir, store, (c) => (user && contraptions.enabled(c.name, user.id) ? contraptions.signIdentity(c.name, user) : null));
      if ('missing' in icon) throw new HttpError(404, icon.missing);
      send(res, 200, { ...iconHeaders(icon.type), 'Cache-Control': 'private, max-age=31536000, immutable' }, icon.body);
    },
  },
  {
    // Many schemes' favicons in one answer (#1543): ?ids=<id>.<v>,… (what the list's `icon` field makes the icon URL's ?v=). Each key
    // answers a `data:` URL for an SVG, the icon route's URL for any other type (kept off the JSON), or null (none, or not theirs).
    // The page keeps the answers by key, so a new version is the only thing it asks for again.
    method: 'GET',
    path: '/api/icons',
    who: ['person'],
    async handler({ res, url, session, app: { store, contraptions } }) {
      const keys = (url.searchParams.get('ids') ?? '').split(',').filter(Boolean);
      if (keys.length > 200 || !keys.every((k) => /^\d{1,9}\.\d{1,20}$/.test(k))) throw new HttpError(400, 'ids must be a list of <scheme>.<version>');
      const mine = new Map(visibleSchemes(store, session).map((p) => [p.id, p]));
      const user = typeof session.uid === 'number' ? store.getUser(session.uid) : undefined;
      const identityFor = (c: { name: string }) => (user && contraptions.enabled(c.name, user.id) ? contraptions.signIdentity(c.name, user) : null);
      const icons: Record<string, string | null> = {};
      for (const key of keys) {
        const [id, v] = key.split('.');
        const p = mine.get(Number(id));
        const icon = p ? await readIcon(p.id, p.repo_dir, store, identityFor) : null;
        icons[key] = !icon || 'missing' in icon ? null : icon.type === 'image/svg+xml' ? `data:image/svg+xml;base64,${icon.body.toString('base64')}` : `api/projects/${id}/icon?v=${v}`;
      }
      return json(res, 200, { icons });
    },
  },
  {
    // What a scheme being set up can adapt (#172): names and descriptions from every scheme's .claude/ and the kit, never file bodies.
    method: 'GET',
    path: '/api/catalogue',
    who: PEOPLE_AND_TASKMASTER,
    handler: ({ res, app, session, caller }) => {
      // A Taskmaster sees what its scheme's owner sees.
      const owner = caller ? app.store.getUser(app.store.getProject(caller.project_id)?.owner_id ?? -1) : null;
      const who = caller ? { uid: owner?.id, admin: !!owner?.admin } : session;
      return json(res, 200, { items: catalogue(visibleSchemes(app.store, who), turnPins().KIT) });
    },
  },
  {
    method: 'POST',
    path: '/api/projects',
    who: ['person'],
    async handler({ req, res, app, session }) {
      if (app.preview) throw new HttpError(403, "A preview can't start schemes");
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
        // Whose GitHub, not who may (#621): the flag, so a Citadel member still clones with their own token.
        if (!user?.admin) {
          // The box's SSH key and gh login are Cara's: anyone else clones with their own token, or none.
          if (!repoUrl.startsWith('https://')) throw new HttpError(400, "Use the repo's https:// URL: a git@ URL would clone with the server's own SSH key");
          if (!user) throw new HttpError(403, 'Sign in with your own login to clone a repo');
          as = githubOf(app, user).env;
        }
      } else if (source === 'folder') {
        const checked = await checkFolder(str(body.folder, 'Folder', 4096), app.dataDir);
        if ('error' in checked) throw new HttpError(400, checked.error);
        folder = checked.path;
      } else if (source === 'new') {
        ({ slug, as } = await newRepoSlug(app, name, !!user?.admin, user));
        // Refused before anything exists, with the name shown so the person can pick another.
        if ((await githubRepoExists(slug, as)) === true) throw new HttpError(409, `GitHub repo ${slug} already exists; pick another scheme name`);
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
        } catch (err) {
          app.store.deleteProject(project.id);
          await removeProjectDir(app.dataDir, project.id);
          throw new HttpError(400, `${source === 'new' ? 'Could not make the repo' : 'Could not clone repo'}: ${errorText(err)}`);
        }
        // A GitHub failure keeps the scheme: the strip on it offers Retry, so a blip doesn't lose the form.
        if (source === 'new') await putOnGithub(app, project.id, dir, slug!, true, as);
      }
      app.store.setProjectSettings(project.id, { onboarding: setup ? 'interview' : 'skipped' });
      await ownWrites(); // the kickoff and the reply re-read the scheme it just wrote (#1244)
      addMemoryCurator(app.store, app.dataDir, project.id);
      addArchitectureCheck(app.store, app.dataDir, project.id);
      void app.releases.refresh(true); // its targets show up without anyone asking (#627)
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
    // Any member may ask (#621): it makes the repo the owner already asked for, the same way.
    method: 'POST',
    path: '/api/projects/:project/github',
    who: ['person'],
    async handler({ res, app, project }) {
      if (app.preview) throw new HttpError(403, "A preview can't make GitHub repos");
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
    method: ['GET', 'PUT'],
    path: '/api/app/settings',
    who: ['person'],
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
    method: 'GET',
    path: '/api/projects/:project',
    who: PEOPLE_AND_TASKMASTER,
    everyScheme: true,
    // ?tickets=open leaves the dismissed minions out (`dismissed` counts them), and ?tickets=closed sends only them: the page
    // draws the scheme from the open ones and fetches the dismissed behind it, 80% of Citadel's payload (#538). ?tickets=none
    // sends no minions, for a caller that wants only the scheme's own fields: every minion's view took 9 to 31 s under load (#1514).
    async handler({ res, url, app, session, caller, project }) {
      // A person gets their own Taskmaster once the scheme is split (#919), as the scheme list's coordinator_id does.
      const only = await ensureCoordinator(app, project);
      const coordinator = caller ? only : (app.store.coordinatorFor(project.id, session.uid ?? null) ?? only);
      const which = url.searchParams.get('tickets');
      // ?number=N sends only that minion: the Taskmaster's tools turn a number into an id this way, on each call (#609).
      const number = url.searchParams.has('number') ? Number(url.searchParams.get('number')) : null;
      const all = app.store.listTickets(project.id).filter((t) => t.kind === 'ticket');
      const dismissed = all.filter((t) => t.status === 'closed').length;
      let picked = all.filter((t) => (which === 'open' ? t.status !== 'closed' : which === 'closed' ? t.status === 'closed' : which !== 'none')).filter((t) => number === null || t.number === number);
      // The dismissed list is read a page at a time, newest first (closed-list-on-demand): ?limit= a page, ?before=<updated_at>&before_id=
      // the last row of the page before, ?q= only those whose number, title or properties match (the page's thread search), ?since= only
      // those updated after that time (the recap), ?ids=1,2 only those. `more` says whether another page follows; none of them is sent
      // without ?limit=, so the old whole list still comes to a caller that asks for it.
      let more = false;
      if (which === 'closed') {
        const num = (k: string) => (url.searchParams.has(k) ? Number(url.searchParams.get(k)) : null);
        const [limit, before, beforeId, since] = [num('limit'), num('before'), num('before_id'), num('since')];
        const ids = url.searchParams.get('ids')?.split(',').map(Number).filter(Number.isFinite);
        const q = url.searchParams.get('q')?.trim().toLowerCase();
        picked.sort((a, b) => b.updated_at - a.updated_at || b.id - a.id);
        if (ids) picked = picked.filter((t) => ids.includes(t.id));
        if (since !== null) picked = picked.filter((t) => t.updated_at > since);
        if (before !== null) picked = picked.filter((t) => t.updated_at < before || (t.updated_at === before && t.id < (beforeId ?? Infinity)));
        if (q) {
          // The page's own match (threadMatches in public/threadgroups.js): the number, or the title or a property value containing it.
          const props = app.store.props.forTargets(
            'minion',
            picked.map((t) => t.id),
          );
          picked = picked.filter((t) => {
            if (String(t.number) === q.replace(/^#/, '')) return true;
            const p = props.get(t.id) ?? {};
            const fields = [t.title, ...Object.entries(p).flatMap(([k, v]) => [v].flat().map((x) => (q.includes(':') ? `${k}: ${x}` : String(x))))];
            return fields.some((f) => f?.toLowerCase().includes(q));
          });
        }
        if (limit !== null && picked.length > limit) {
          more = true;
          picked = picked.slice(0, limit);
        }
      }
      const tickets = app.runner.views(picked);
      // When this person last looked at each thread, so rows they have already seen can be shown quieter.
      const seen = caller ? {} : app.store.seenTimes(session.name, project.id);
      // People's notes (#146) are for people only: a minion or the Taskmaster gets none.
      const person_notes = caller ? {} : app.store.personNotes(project.id);
      // This person's pinned minions (#179), oldest pin first.
      const pins = caller ? [] : app.store.pinnedTickets(session.name, project.id);
      // Each build branch's standing, for its header in the list (src/builds.ts); [] without build branches.
      const builds = app.builds?.get(project.id) ?? [];
      // Builds' previews are of this server's own code, so only its own scheme's headers link one (src/previews.ts).
      const build_previews = !!app.previews && app.previews.buildScheme()?.id === project.id;
      // Per-person Taskmasters (#919): a person's page opens their own, and `taskmasters` lists every session for
      // Mine and Everyone (#920): person_id null is the Overlord. Empty until the scheme splits. updated_at and status: when its
      // offered replies count as seen in Needs you and whether its turn spins the pill, as for any minion (#1400).
      const all_tms = app.store.listCoordinators(project.id);
      const own = !caller && all_tms.length > 1 ? (app.store.coordinatorFor(project.id, session.uid!) ?? coordinator) : coordinator;
      const taskmasters = all_tms.length > 1 ? all_tms.map((t) => ({ id: t.id, person_id: t.coordinator_of, person_name: t.coordinator_of == null ? null : (app.store.getUser(t.coordinator_of)?.name ?? null), updated_at: t.updated_at, status: t.status })) : [];
      return json(res, 200, { project, coordinator: readScope(app.store.db, () => ticketView(app, own.id)), taskmasters, tickets, dismissed, ...(which === 'closed' ? { more } : {}), seen, person_notes, pins, builds, build_previews });
    },
  },
  {
    method: 'GET',
    path: '/api/projects/:project/taskmaster-events',
    who: ['person'],
    everyScheme: true,
    // Mine and Everyone (#920): your Taskmaster's chat with the others', paged as one by event id (history.ts).
    // Mine adds only the Overlord's for-everyone items and card answers; Everyone adds every session whole.
    async handler({ res, url, app, session, project }) {
      const { store } = app;
      const list = store.listCoordinators(project.id);
      const own = store.coordinatorFor(project.id, session.uid!) ?? list[0];
      const everyone = url.searchParams.get('view') === 'everyone';
      // Someone who hasn't written yet has no Taskmaster of their own, so theirs is the Overlord: Mine filters it too.
      const parts = !own ? [] : [{ id: own.id, mine: !everyone && own.coordinator_of == null && list.length > 1 }, ...list.filter((t) => t.id !== own.id && (everyone || t.coordinator_of == null)).map((t) => ({ id: t.id, mine: !everyone }))];
      const num = (k: string) => Number(url.searchParams.get(k)) || undefined;
      if (url.searchParams.has('after')) return json(res, 200, mergedAfter(store, parts, num('after') ?? 0));
      return json(res, 200, mergedPage(store, parts, { before: num('before'), limit: num('limit'), from: num('from') }));
    },
  },
  {
    // The scheme's minions as list_tickets prints them, for its minions too: read-only, and only the
    // line's fields, the latest activity line and waiting cards' labels and links among them (no card
    // contents, costs or paths). checkRole keeps a minion to its own scheme.
    method: 'GET',
    path: '/api/projects/:project/tickets',
    who: ['person', 'taskmaster', 'minion'],
    everyScheme: true,
    handler({ res, url, app, project, caller }) {
      const closed = url.searchParams.get('include_closed') === '1';
      const listed = app.store.listTickets(project.id).filter((t) => t.kind === 'ticket' && (closed || t.status !== 'closed'));
      const tickets = app.runner.views(listed).map((v, i) => {
        const t = listed[i];
        // A minion also gets each one's worktree (#783), to find who owns a file; the Taskmaster's read_ticket shows it.
        return { ...Object.fromEntries(LINE_FIELDS.map((k) => [k, v[k as keyof typeof v]])), ...(caller && caller.kind !== 'coordinator' && t.cwd ? { worktree: t.cwd } : {}) };
      });
      // Yesterday's contraption errors for the Taskmaster's look at the scheme (#835); none when there were none.
      const errors = app.errorDigest?.summary(project.id) ?? null;
      return json(res, 200, { tickets, scheme: project.name, ...(errors ? { errors } : {}) });
    },
  },
  {
    // Any member changes its settings (#621, Cara 2026-11-12), plugin folders still an admin's (below).
    method: 'PATCH',
    path: '/api/projects/:project',
    who: PEOPLE_AND_TASKMASTER,
    async handler({ req, res, app, session, caller, project }) {
      const { store, runner } = app;
      // Any of name, instructions, approval_rules, plugin_dirs, optional_plugin_dirs, default_effort, onboarding, onboarding_mode, list_groups, ci_quiet, ci_watch, land_mode, fable_ok, builds, grill, gh_runners, the shot_* settings, ship_path, go_from, try_first, the msg_* settings and msg_never_hold; what is left out stays.
      const body = await readJson(req);
      const fields = [
        'name',
        'instructions',
        'approval_rules',
        'plugin_dirs',
        'optional_plugin_dirs',
        'default_effort',
        'onboarding',
        'onboarding_mode',
        'list_groups',
        'ci_quiet',
        'ci_watch',
        'land_mode',
        'fable_ok',
        'builds',
        'grill',
        'gh_runners',
        'shot_widths',
        'shot_themes',
        'shots_required',
        'shot_note',
        'ship_path',
        'go_from',
        'try_first',
        'rules_review',
        'msg_loop_limit',
        'msg_loop_min',
        'msg_cold_min',
        'msg_hold_h',
        'msg_never_hold',
        'repo_url',
        'skills_off',
      ];
      if (fields.every((k) => body[k] === undefined)) throw new HttpError(400, 'Nothing to change');
      for (const k of fields) if (body[k] !== undefined) store.usage.used('setting', `scheme.${k}`, session.uid ?? session.name); // the usage ledger (#1306)
      const name = body.name === undefined ? project.name : str(body.name, 'Name', 80);
      const settings: Partial<
        Pick<
          Project,
          | 'approval_rules'
          | 'plugin_dirs'
          | 'optional_plugin_dirs'
          | 'default_effort'
          | 'onboarding'
          | 'onboarding_mode'
          | 'list_groups'
          | 'ci_quiet'
          | 'ci_watch'
          | 'land_mode'
          | 'fable_ok'
          | 'builds'
          | 'grill'
          | 'gh_runners'
          | 'shot_widths'
          | 'shot_themes'
          | 'shots_required'
          | 'shot_note'
          | 'ship_path'
          | 'go_from'
          | 'try_first'
          | 'msg_loop_limit'
          | 'msg_loop_min'
          | 'msg_cold_min'
          | 'msg_hold_h'
          | 'msg_never_hold'
          | 'rules_review'
          | 'skills_off'
        >
      > = {};
      // Unlike oneOf, null and '' are refused: there is no "unset" onboarding.
      const required = (v: unknown, all: readonly string[], field: string) => {
        if (typeof v !== 'string' || !all.includes(v)) throw new HttpError(400, `${field} must be one of: ${all.join(', ')}`);
        return v;
      };
      if (body.onboarding !== undefined) settings.onboarding = required(body.onboarding, ONBOARDING, 'onboarding') as Project['onboarding'];
      if (body.onboarding_mode !== undefined) settings.onboarding_mode = required(body.onboarding_mode, ONBOARDING_MODES, 'onboarding_mode') as Project['onboarding_mode'];
      if (body.land_mode !== undefined) settings.land_mode = required(body.land_mode, LAND_MODES, 'land_mode') as Project['land_mode'];
      if (body.fable_ok !== undefined) settings.fable_ok = required(body.fable_ok, FABLE_OKS, 'fable_ok') as Project['fable_ok'];
      if (body.builds !== undefined) settings.builds = required(body.builds, BUILDS_MODES, 'builds') as Project['builds'];
      if (body.grill !== undefined) settings.grill = required(body.grill, GRILL_MODES, 'grill') as Project['grill'];
      if (body.gh_runners !== undefined) settings.gh_runners = required(body.gh_runners, GH_RUNNERS_MODES, 'gh_runners') as Project['gh_runners'];
      // Fast mode is the kit's land.sh's LAND_FAST (#1017): a land.sh without it would land every change on the full gate.
      if (settings.land_mode === 'fast' && project.land_mode !== 'fast') {
        const land = project.repo_dir ? await readFile(join(project.repo_dir, 'tools', 'land.sh'), 'utf8').catch(() => '') : '';
        if (!/\bLAND_FAST\b/.test(land) || !/--verify\b/.test(land)) throw new HttpError(409, `This scheme's tools/land.sh ${land ? "doesn't know fast mode yet" : 'is missing'}: re-sync it from the kit's land template (kit/skills/scheme-setup/templates/land.sh) on main first, then turn fast mode on.`);
      }
      // Screenshot settings (#1044): widths in px, themes light and/or dark, a switch and one line of free text.
      try {
        if (body.shot_widths !== undefined) settings.shot_widths = cleanShotWidths(body.shot_widths);
        if (body.shot_themes !== undefined) settings.shot_themes = cleanShotThemes(body.shot_themes);
        if (body.shot_note !== undefined) settings.shot_note = cleanShotNote(body.shot_note);
      } catch (err) {
        throw new HttpError(400, thrown(err).message!);
      }
      // Message settings (#1059): whole numbers inside src/msg-settings.ts's bounds.
      try {
        Object.assign(settings, cleanMsgSettings(body));
        if (body.msg_never_hold !== undefined) settings.msg_never_hold = cleanNeverHold(body.msg_never_hold);
      } catch (err) {
        throw new HttpError(400, thrown(err).message!);
      }
      if (body.shots_required !== undefined) {
        if (typeof body.shots_required !== 'boolean') throw new HttpError(400, 'shots_required must be true or false');
        settings.shots_required = body.shots_required ? 1 : 0;
      }
      if (body.ship_path !== undefined) settings.ship_path = required(body.ship_path, values(SHIP_PATHS), 'ship_path') as Project['ship_path'];
      if (body.go_from !== undefined) settings.go_from = required(body.go_from, values(GO_FROM), 'go_from') as Project['go_from'];
      if (body.rules_review !== undefined) {
        if (typeof body.rules_review !== 'boolean') throw new HttpError(400, 'rules_review must be true or false');
        settings.rules_review = body.rules_review ? 1 : 0;
      }
      // Kit skills turned off on the Skills page (#1062): any member, nothing locked (Josh, 2026-11-19); only skills the kit has.
      if (body.skills_off !== undefined) {
        const kit = new Set(
          listSkills(KIT_DIR, null)
            .filter((i) => i.kind === 'skill')
            .map((i) => i.slug),
        );
        if (!Array.isArray(body.skills_off) || body.skills_off.some((s: unknown) => typeof s !== 'string' || !kit.has(s))) throw new HttpError(400, "skills_off must be a list of the kit's skill names");
        settings.skills_off = [...new Set(body.skills_off as string[])].sort().join(' ');
      }
      if (body.try_first !== undefined) settings.try_first = required(body.try_first, values(TRY_FIRST), 'try_first') as Project['try_first'];
      if ((settings.ship_path ?? project.ship_path) === 'pr-person' && settings.go_from !== undefined && settings.go_from !== 'all') {
        throw new HttpError(400, 'When a person merges every pull request, every change waits for their go: pick another way to ship first');
      }
      // null or "" leaves effort to Claude Code's default.
      if (body.default_effort !== undefined) settings.default_effort = oneOf(body.default_effort || null, EFFORTS, 'Default effort') ?? '';
      try {
        if (body.approval_rules !== undefined) settings.approval_rules = cleanRules(body.approval_rules);
        if (body.plugin_dirs !== undefined) settings.plugin_dirs = cleanPluginDirs(body.plugin_dirs);
        if (body.optional_plugin_dirs !== undefined) settings.optional_plugin_dirs = cleanPluginDirs(body.optional_plugin_dirs);
        if (body.ci_quiet !== undefined) settings.ci_quiet = cleanWorkflows(body.ci_quiet);
        if (body.ci_watch !== undefined) settings.ci_watch = cleanWorkflows(body.ci_watch, 'Watched CI workflows');
        if (body.list_groups !== undefined) settings.list_groups = JSON.stringify(store.props.listGroups(project.id, body.list_groups));
      } catch (err) {
        throw new HttpError(400, thrown(err).message!);
      }
      // Plugins load code from any folder on the server: an admin's, or an admin's scheme's Taskmaster's.
      // The optional ones too (#361): a minion picks from them without an admin, so registering one is the gate.
      const pluginsChanged = (['plugin_dirs', 'optional_plugin_dirs'] as const).some((k) => settings[k] !== undefined && settings[k] !== (project[k] ?? ''));
      if (pluginsChanged && !session.admin) {
        if (!caller || !adminOwned(store, project)) throw new HttpError(403, 'Only an admin can change plugin folders');
        const refused = adminAskRefusal(store, caller.id);
        if (refused) throw new HttpError(403, refused);
      }
      if (body.instructions !== undefined && typeof body.instructions !== 'string') throw new HttpError(400, 'instructions must be text');
      const instructions = body.instructions === undefined ? project.instructions : body.instructions.replace(/\r\n/g, '\n').trim();
      if (instructions.length > MAX_INSTRUCTIONS) {
        throw new HttpError(400, `Instructions are ${instructions.length.toLocaleString('en')} characters; the limit is ${MAX_INSTRUCTIONS.toLocaleString('en')}`);
      }
      // A repo URL only records where the repo lives: no clone, no re-pointing of a checkout. Refused before anything saves.
      let repoUrl: string | null = null;
      if (body.repo_url !== undefined) {
        repoUrl = typeof body.repo_url === 'string' ? body.repo_url.trim() : '';
        if (!/^(https:\/\/|git@)/.test(repoUrl!)) throw new HttpError(400, 'Repo URL must be https:// or git@');
        if (/\s/.test(repoUrl!) || /^https:\/\/[^/]*@/.test(repoUrl!)) throw new HttpError(400, 'Repo URL cannot hold spaces or a login');
        if (repoUrl === project.repo_url) repoUrl = null;
        else if (project.repo_url && body.replace_repo !== true) {
          throw new HttpError(409, `This scheme's repo is already ${project.repo_url}; send replace_repo: true to point it at ${repoUrl} instead`);
        }
      }
      // Worked out before anything is written, since it can still refuse (too many approval rules). The one gate (#1043): the go threshold and the merge approval can't disagree, whichever of them this save changed.
      const gate = shippingGate({ ...project, ...settings });
      if (gate.go_from !== (settings.go_from ?? project.go_from)) settings.go_from = gate.go_from;
      if (gate.approval_rules !== (settings.approval_rules ?? project.approval_rules)) {
        try {
          settings.approval_rules = cleanRules(gate.approval_rules);
        } catch (e) {
          throw new HttpError(400, `Shipping ticks "Merge a pull request" under Approvals, which doesn't fit: ${(e as Error).message}`);
        }
      }
      // Renamed first: it is the only change that can still be refused (a taken name).
      if (name !== project.name) {
        try {
          store.renameProject(project.id, name);
        } catch (err) {
          throw new HttpError(409, thrown(err).message!);
        }
        const coordinator = store.getOverlord(project.id);
        if (coordinator) runner.emit(coordinator.id, 'note', { everyone: true, text: `${session.name} renamed the scheme from "${project.name}" to "${name}".` });
      }
      if (repoUrl) {
        store.setProjectUpstream(project.id, repoUrl, null);
        const coordinator = store.getOverlord(project.id);
        if (coordinator) {
          runner.emit(coordinator.id, 'note', {
            everyone: true,
            text: `${session.name} set the scheme's repo to ${repoUrl}. Nothing was cloned or re-pointed: a person still has to clone it into the scheme's repo folder${project.repo_dir ? ' (a checkout exists and its origin decides at the next restart: until it is re-pointed to this repo, the old URL comes back)' : ''}, set up the push guard, and give Citadel's GitHub access to it.`,
          });
        }
      }
      for (const k of Object.keys(settings) as (keyof typeof settings)[]) if (settings[k] === project[k]) delete settings[k];
      if (Object.keys(settings).length) {
        store.setProjectSettings(project.id, settings);
        // Who changed what gets a permanent line in the coordinator's chat, since rules decide what needs a person's OK.
        const coordinator = store.getOverlord(project.id);
        const shown = (text: string) => (text ? lines(text).join(', ') : 'none');
        if (coordinator && settings.approval_rules !== undefined) {
          runner.emit(coordinator.id, 'note', { everyone: true, text: `${session.name} set the approval rules to: ${shown(settings.approval_rules)}. They apply from each minion's next turn.` });
        }
        if (coordinator && settings.plugin_dirs !== undefined) {
          runner.emit(coordinator.id, 'note', { everyone: true, text: `${session.name} set the plugin folders to: ${shown(settings.plugin_dirs)}. They apply from each minion's next turn.` });
        }
        if (coordinator && settings.optional_plugin_dirs !== undefined) {
          runner.emit(coordinator.id, 'note', { everyone: true, text: `${session.name} set the optional plugin folders to: ${shown(settings.optional_plugin_dirs)}. Minions load them only when they pick them, from their next turn.` });
        }
        if (coordinator && settings.ci_quiet !== undefined) {
          runner.emit(coordinator.id, 'note', { everyone: true, text: `${session.name} set the quiet CI workflows to: ${shown(settings.ci_quiet)}. Their red scheduled and dispatched runs no longer tell you.` });
        }
        if (coordinator && settings.ci_watch !== undefined) {
          runner.emit(coordinator.id, 'note', { everyone: true, text: `${session.name} set the watched CI workflows to: ${shown(settings.ci_watch)}. When one goes red on main, you're woken once per red streak and told when it's back to green.` });
        }
        if (settings.land_mode === 'fast') app.fastMode?.reset(project.id);
        if (coordinator && settings.land_mode !== undefined) {
          runner.emit(coordinator.id, 'note', {
            everyone: true,
            text:
              settings.land_mode === 'fast'
                ? `${session.name} turned fast mode on. Low and medium changes now ship live on the smoke check alone, and the full suite runs on main behind them: a red reopens the minion whose change broke it, and comes to you if it isn't fixed in 30 minutes. High-risk changes and pipeline changes keep the full gate.`
                : `${session.name} turned fast mode off. Every change waits for the full check and CI again before it ships.`,
          });
        }
        if (coordinator && (['ship_path', 'go_from', 'try_first'] as const).some((k) => settings[k] !== undefined)) {
          const now = { ...project, ...settings };
          runner.emit(coordinator.id, 'note', {
            everyone: true,
            text: `${session.name} set Shipping to: ${label(SHIP_PATHS, now.ship_path)}; a person's go: ${label(GO_FROM, now.go_from).toLowerCase()}; try it first: ${label(TRY_FIRST, now.try_first).toLowerCase()}. It applies from each minion's next turn and wins over the scheme instructions. If those still describe shipping differently, offer the members a card to bring them in line.`,
          });
        }
        if (coordinator && settings.skills_off !== undefined) {
          const was = new Set(offSkills(project));
          const now = offSkills({ skills_off: settings.skills_off });
          const off = now.filter((x) => !was.has(x));
          const on = [...was].filter((x) => !now.includes(x));
          const named = (xs: string[]) => xs.map((x) => `citadel:${x}`).join(', ');
          runner.emit(coordinator.id, 'note', { everyone: true, text: `${session.name} ${[off.length ? `turned off ${named(off)}` : '', on.length ? `turned back on ${named(on)}` : ''].filter(Boolean).join(' and ')} on the Skills page. It applies from each minion's next turn.` });
        }
        if (coordinator && settings.default_effort !== undefined) {
          runner.emit(coordinator.id, 'note', { everyone: true, text: `${session.name} set the scheme's default effort to ${settings.default_effort || "Claude Code's default"}. It applies from each minion's next turn.` });
        }
        if (coordinator && settings.onboarding === 'skipped') {
          runner.emit(coordinator.id, 'note', { everyone: true, text: `${session.name} skipped the scheme's setup. Tell the ${AGENT_NAME} to pick it up again any time.` });
        }
      }
      if (instructions !== project.instructions) {
        store.setProjectInstructions(project.id, instructions, session.name);
        await ownWrites(); // the decisions log is read from the new instructions (#1244)
        recheckDecisions(app, [store.getProject(project.id)!]);
        mailParksUnderOldRule(app, [store.getProject(project.id)!], project.instructions, instructions, 'scheme');
        const coordinator = store.getOverlord(project.id);
        if (coordinator) {
          runner.emit(coordinator.id, 'note', { everyone: true, text: `${session.name} ${instructions ? 'updated' : 'cleared'} the scheme instructions; they apply from each minion's next turn.` });
        }
      }
      await ownWrites(); // the reply and the broadcast re-read the row it just wrote (#1244)
      const saved = store.getProject(project.id)!;
      app.broadcast({ type: 'project', project: saved });
      return json(res, 200, saved);
    },
  },
  {
    // Settings' "Tune up" (#175): onboarding again in tune-up mode, and a message that starts the Taskmaster on it.
    method: 'POST',
    path: '/api/projects/:project/tune-up',
    who: ['person'],
    async handler({ res, app, session, project }) {
      if (onboardingOpen(project)) throw new HttpError(409, `${project.onboarding_mode === 'tune-up' ? 'A tune-up' : 'Setup'} is under way already`);
      // The Taskmaster first, so a failure there can't leave onboarding open with nobody told.
      const coordinator = await ensureCoordinatorFor(app, project, session.uid);
      if (onboardingOpen(app.store.getProject(project.id)!)) throw new HttpError(409, 'A tune-up is under way already');
      app.store.setProjectSettings(project.id, { onboarding: 'interview', onboarding_mode: 'tune-up' });
      await ownWrites(); // the Taskmaster's turn and the reply read the row back (#1244)
      app.runner.send(coordinator.id, session.name, 'Tune up this scheme: onboarding is on again, in tune-up mode.');
      const saved = app.store.getProject(project.id)!;
      app.broadcast({ type: 'project', project: saved });
      return json(res, 200, saved);
    },
  },
  {
    method: 'GET',
    path: '/api/projects/:project/instructions/history',
    who: ['person'],
    handler({ res, app, project }) {
      const history = app.store.instructionHistory(project.id, 5).map((h) => ({ by: h.by, at: h.at, diff: lineDiff(h.old_text, h.new_text), before: h.old_text }));
      return json(res, 200, { history });
    },
  },
  {
    // Your own instructions (#688): the text for everywhere and this scheme's, for the My instructions tab.
    method: ['GET', 'PUT'],
    path: '/api/projects/:project/my-instructions',
    who: ['person'],
    async handler({ req, res, app, session, project }) {
      const uid = session.uid;
      if (typeof uid !== 'number') throw new HttpError(400, 'Sign in again first');
      if (req.method === 'PUT') {
        const body = await readJson(req);
        if (body.scope !== 'everywhere' && body.scope !== 'scheme') throw new HttpError(400, 'scope must be everywhere or scheme');
        if (typeof body.text !== 'string') throw new HttpError(400, 'text must be text');
        const text = body.text.replace(/\r\n/g, '\n').trim();
        if (text.length > MAX_PERSONAL_INSTRUCTIONS) {
          throw new HttpError(400, `Instructions are ${text.length.toLocaleString('en')} characters; the limit is ${MAX_PERSONAL_INSTRUCTIONS.toLocaleString('en')}`);
        }
        app.store.setPersonalInstructions(uid, body.scope === 'scheme' ? project.id : null, text);
        await ownWrites(); // the reply reads them back (#1244)
      }
      return json(res, 200, { everywhere: app.store.personalInstructions(uid, null), scheme: app.store.personalInstructions(uid, project.id), max: MAX_PERSONAL_INSTRUCTIONS });
    },
  },
  {
    method: 'GET',
    path: '/api/projects/:project/my-instructions/history',
    who: ['person'],
    handler({ res, app, session, project, url }) {
      if (typeof session.uid !== 'number') throw new HttpError(400, 'Sign in again first');
      const history = app.store.personalInstructionHistory(session.uid, url.searchParams.get('scope') === 'scheme' ? project.id : null, 5).map((h) => ({ by: session.name, at: h.at, diff: lineDiff(h.old_text, h.new_text) }));
      return json(res, 200, { history });
    },
  },
  {
    // The Taskmaster's read_person_instructions: its own prompt never carries a person's text, so it reads it before starting a minion for them.
    method: 'GET',
    path: '/api/projects/:project/people/:person/instructions',
    who: ['taskmaster'],
    handler({ res, app, project, params }) {
      const asked = decodeURIComponent(params.person);
      const name = app.store.props.personName(asked);
      const user = name ? app.store.findUser('name', name) : undefined;
      if (!user) throw new HttpError(404, `No one called ${asked}`);
      return json(res, 200, { name: user.name, everywhere: app.store.personalInstructions(user.id, null).text, scheme: app.store.personalInstructions(user.id, project.id).text });
    },
  },
  {
    // The Citadel-wide instructions: people, and the Citadel scheme's Taskmaster only (checked below).
    method: ['GET', 'PUT'],
    path: '/api/app/instructions',
    who: PEOPLE_AND_TASKMASTER,
    access: 'admin',
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
      const was = store.appInstructions().text;
      if (text !== was) {
        store.setAppInstructions(text, session.name);
        await ownWrites(); // the decisions log, the broadcast and the reply read them back (#1244)
        recheckDecisions(app, store.listProjects());
        mailParksUnderOldRule(app, store.listProjects(), was, text, `${APP_NAME}-wide`);
        // Every Taskmaster gets the line, since the text reaches every scheme.
        for (const p of store.listProjects()) {
          const coordinator = store.getOverlord(p.id);
          if (coordinator) runner.emit(coordinator.id, 'note', { everyone: true, text: `${session.name} ${text ? 'updated' : 'cleared'} the ${APP_NAME}-wide instructions; they apply from each minion's next turn in every scheme.` });
        }
        app.broadcast({ type: 'app-instructions', instructions: store.appInstructions() });
      }
      return json(res, 200, store.appInstructions());
    },
  },
  {
    method: 'GET',
    path: '/api/app/instructions/history',
    who: ['person'],
    access: 'admin',
    handler({ res, app }) {
      const history = app.store.appInstructionHistory(5).map((h) => ({ by: h.by, at: h.at, diff: lineDiff(h.old_text, h.new_text), before: h.old_text }));
      return json(res, 200, { history });
    },
  },
  {
    // edit_instructions (#961): a minion edits its scheme's or the Citadel-wide Settings text like any other instruction file.
    // Every find must match exactly once, or nothing is saved; one save through the same setters and history as Settings.
    method: 'POST',
    path: '/api/tickets/:ticket/edit-instructions',
    who: ['minion'],
    refuse: 'Only the minion itself can edit instructions from its chat',
    async handler(ctx) {
      const { req, res, app, ticket } = ctx;
      const { store } = app;
      const body = await readJson(req);
      if (body.scope !== 'scheme' && body.scope !== 'citadel') throw new HttpError(400, 'scope must be "scheme" or "citadel"');
      if (!Array.isArray(body.edits) || !body.edits.length) throw new HttpError(400, 'edits must be a non-empty list of { find, replace }');
      const edits = body.edits as { find?: unknown; replace?: unknown }[];
      // Scheme text: any minion of its scheme, as any minion may change its scheme's repo (handoff, #961). Citadel-wide: only a turn run for a member.
      const citadel = body.scope === 'citadel';
      if (citadel) {
        const refused = adminAskRefusal(store, ticket.id);
        if (refused) throw new HttpError(403, refused);
      }
      const project = store.getProject(ticket.project_id)!;
      const original = citadel ? store.appInstructions().text : project.instructions;
      let text = original;
      const failed: string[] = [];
      edits.forEach((e, i) => {
        if (typeof e?.find !== 'string' || !e.find || typeof e.replace !== 'string') return void failed.push(`edit ${i + 1}: find must be non-empty text and replace must be text`);
        const n = text.split(e.find).length - 1;
        if (n !== 1) return void failed.push(`edit ${i + 1}: "${e.find.slice(0, 60)}" matches ${n} times, not once`);
        text = text.replace(e.find, () => e.replace as string);
      });
      if (failed.length) throw new HttpError(409, `Nothing saved. ${failed.join('; ')}`);
      text = text.replace(/\r\n/g, '\n').trim();
      if (text.length > MAX_INSTRUCTIONS) throw new HttpError(400, `Instructions would be ${text.length.toLocaleString('en')} characters; the limit is ${MAX_INSTRUCTIONS.toLocaleString('en')}`);
      if (text === original) throw new HttpError(400, 'Those edits change nothing');
      // What the turn's own Grunt found already says it (#1162): plain lines, checked like any request text.
      if (body.overlaps != null && (!Array.isArray(body.overlaps) || body.overlaps.length > 30 || body.overlaps.some((o: unknown) => typeof o !== 'string' || o.length > 1000))) throw new HttpError(400, 'overlaps must be a list of at most 30 lines of text');
      const fromGrunt = ((body.overlaps ?? []) as string[]).map((o) => o.trim()).filter(Boolean);
      const askerId = store.turnAsker(ticket.id);
      const asker = askerId === null ? undefined : store.getUser(askerId);
      const by = `#${ticket.number ?? ticket.id} for ${asker?.name ?? 'nobody'}`;
      const scope = citadel ? 'citadel' : 'scheme';
      const held = { scope, project: project.id, old: original, text, edits: edits as FindReplace[], by } as const;
      const found = settingsOverlaps(app, project, scope, original, text);
      if (found.length || fromGrunt.length) {
        // Held on a card for the person the turn runs for (Josh, 2026-11-20, "Hold it on a card"): Save anyway, Work it in or Cancel edit.
        const count = found.length + fromGrunt.length;
        const event = postPlan(app, ticket.id, {
          summary: `Edit to the ${citadel ? `${APP_NAME}-wide` : 'scheme'} instructions repeats ${count === 1 ? 'one place' : `${count} places`}`,
          plan: heldPlan(scope, found, fromGrunt, held.edits),
          instructions: { ...held, count },
          ...(asker && store.listMembers(project.id).some((u) => u.id === asker.id) ? { to: asker.name } : {}),
        });
        return json(res, 202, { held: count, id: JSON.parse(event.data).id, href: cardHref(ticket, event.id), found: found.map((o) => `${o.label}${o.line ? `:${o.line}` : ''}: ${o.why}`) });
      }
      await saveInstructions(app, ticket.id, held);
      return json(res, 200, { saved: citadel ? `${APP_NAME}-wide` : 'scheme', edits: edits.length, length: text.length });
    },
  },
  {
    // A person's own Settings save (#1162): what already says the new words, shown before the save so they can save
    // anyway or keep editing. The matcher only: a minion's edit adds its Grunt's findings, a person reads the list.
    // The Taskmaster's set_app_instructions and set_project_instructions ask it first too (#1211).
    method: 'POST',
    path: '/api/projects/:project/instructions/overlaps',
    who: PEOPLE_AND_TASKMASTER,
    async handler({ req, res, app, project, caller }) {
      const body = await readJson(req);
      if (body.scope !== 'scheme' && body.scope !== 'citadel') throw new HttpError(400, 'scope must be "scheme" or "citadel"');
      if (caller && body.scope === 'citadel' && caller.project_id !== GLOBAL_OWNER) throw new HttpError(403, `Only people and the ${APP_NAME} scheme's ${AGENT_NAME} edit the ${APP_NAME}-wide instructions`);
      if (typeof body.text !== 'string' || body.text.length > MAX_INSTRUCTIONS * 2) throw new HttpError(400, 'text must be text');
      const before = body.scope === 'citadel' ? app.store.appInstructions().text : project.instructions;
      const found = settingsOverlaps(app, project, body.scope, before, body.text.replace(/\r\n/g, '\n').trim());
      return json(res, 200, { found });
    },
  },
  {
    // The Sonnet check on a person's Settings save (#1211; Josh, 2026-11-20: "Matcher, then a Grunt"): asked after the
    // matcher's list is on screen, only when it found something, on the saver's own Claude login (sender pays). No login
    // or a failed check gives no verdicts and says why; the list stays and Save anyway still works ("Keep the matcher list").
    method: 'POST',
    path: '/api/projects/:project/instructions/overlaps/verdicts',
    who: ['person'],
    refuse: "Only a person's own Settings save gets the Sonnet check, on their own Claude login",
    async handler({ req, res, app, session, project }) {
      const body = await readJson(req);
      if (body.scope !== 'scheme' && body.scope !== 'citadel') throw new HttpError(400, 'scope must be "scheme" or "citadel"');
      if (typeof body.text !== 'string' || body.text.length > MAX_INSTRUCTIONS * 2) throw new HttpError(400, 'text must be text');
      const before = body.scope === 'citadel' ? app.store.appInstructions().text : project.instructions;
      const text = body.text.replace(/\r\n/g, '\n').trim();
      const found = settingsOverlaps(app, project, body.scope, before, text);
      // What the verdicts are for, in order, so the page can drop them if its list was different (a save in between).
      const places = found.map((o) => `${o.label}|${o.line}`);
      if (!found.length) return json(res, 200, { verdicts: [], places });
      const place = app.claude.place(session.uid!);
      if (!place) return json(res, 200, { unlinked: "Your Claude plan isn't linked (Settings → Your account), so there's no login of yours to run the check on" });
      try {
        const reply = await runDescribe(
          place,
          verdictPrompt(body.scope, before, text, found, (id) => ruleHome(app, project, id)),
          { claudeBin: process.env.CLAUDE_BIN ?? 'claude', hostEnv: turnEnv(process.env), cwd: join(app.claude.turnsDir(session.uid!), 'repeat-check'), timeoutMs: 30_000 },
        );
        return json(res, 200, { verdicts: readVerdicts(reply, found.length), places });
      } catch (err) {
        return json(res, 200, { failed: String(thrown(err).message).slice(0, 300) });
      }
    },
  },
  {
    method: 'GET',
    path: '/api/projects/:project/repo-setup',
    who: ['person'],
    handler: async ({ res, project }) => json(res, 200, project.repo_dir ? await repoSetup(project.repo_dir) : { facts: null, rules: [], skills: [] }),
  },
  {
    method: 'GET',
    path: '/api/projects/:project/instructions/sources',
    who: ['person'],
    handler: async ({ res, app, project }) => json(res, 200, { sources: await instructionSources(project, claudeConfigDir(process.env), app.dataDir), max: MAX_INSTRUCTIONS }),
  },

  {
    method: 'POST',
    path: '/api/projects/:project/tickets',
    who: PEOPLE_AND_TASKMASTER,
    async handler({ req, res, app, session, caller, project }) {
      const { store, runner, waiters } = app;
      // Every new minion gets a git worktree in the scheme's real repo.
      if (app.preview) throw new HttpError(403, "A preview can't start minions");
      const body = await readJson(req);
      const message = str(body.message, 'First message', 100_000);
      // Without a title (the New thread form sends none) start from the message's opening words;
      // the thread renames itself once it knows what the work is.
      const title = body.title === undefined ? provisionalTitle(message) : str(body.title, 'Title', 120);
      // Insert first so concurrent creates get distinct ids, then build the working dir.
      // Every start names its model and effort (#698): the Taskmaster picks them from its table, a person's start with none gets the table's pick for its type below.
      if (caller && (body.model == null || body.effort == null)) throw new HttpError(400, MODEL_REQUIRED('create_ticket'));
      let model = oneOf(body.model ?? null, MODELS, 'Model');
      let effort = oneOf(body.effort ?? null, EFFORTS, 'Effort');
      const workflow = body.workflow == null ? 0 : workflowSwitch(body.workflow);
      // Its expected cost (#1674): the larger of create_ticket's expected_cost and the brief's (or its handoff's) "Expected cost: $N" line,
      // so a low param can't slip a big brief past its start card.
      const briefText = `${message}\n${namedFiles(message, projectSharedDir(app.dataDir, project.id))}`;
      const givenCost = body.expected_cost == null ? null : Number(body.expected_cost);
      if (givenCost != null && !(Number.isFinite(givenCost) && givenCost > 0 && givenCost <= 100_000)) throw new HttpError(400, 'expected_cost must be dollars, more than 0');
      const lineCost = expectedCost(briefText);
      const estimate = givenCost == null || lineCost == null ? (givenCost ?? lineCost) : Math.max(givenCost, lineCost);
      let plugins = '';
      try {
        plugins = cleanPluginPicks(body.plugin_dirs, project.optional_plugin_dirs);
      } catch (err) {
        throw new HttpError(400, thrown(err).message!);
      }
      // Properties are checked before the minion exists, so a bad one doesn't leave half a minion.
      const props: Record<string, unknown> = body.properties == null ? {} : body.properties;
      if (typeof props !== 'object' || Array.isArray(props)) throw new HttpError(400, 'properties must be an object of key: value');
      // Spelled as the registry matches keys (src/properties.ts `loose`): effort_name is effortName.
      const loose = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
      const given = (key: string) => Object.keys(props).some((k) => loose(k) === loose(key));
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
      // #1488: a Taskmaster's second start from one handoff (Nov 20: two flake minions) is refused, memory index or not; not_duplicate overrides.
      if (caller && body.not_duplicate !== true) {
        const shared = projectSharedDir(app.dataDir, project.id);
        // A closed minion's handoff is tidied into handoffs/shipped/ or not-picked/ (#1371): the same file either way.
        const fileOf = (text: string) => handoffIn(text, shared)?.replace(/^handoffs\/(?:shipped|not-picked)\//, 'handoffs/') ?? null;
        const rel = fileOf(message);
        const held = new Map(waiters.chains().map((c) => [c.ticket, c.message]));
        const textOf = (data: string | null) => {
          try {
            return String(JSON.parse(data ?? '{}').text ?? '');
          } catch {
            return '';
          }
        };
        const twins = rel ? store.briefsSince(project.id, Date.now() - 3 * 86_400_000).filter((t) => fileOf(held.get(t.id) ?? textOf(t.data)) === rel) : [];
        if (twins.length) {
          throw new HttpError(
            409,
            `Not created: ${twins.map((t) => `#${t.number} ${t.title} (${t.status})`).join('; ')} already started from ${rel} (open, or closed in the last 3 days). ` + 'If it is the same work, message it instead (message_ticket, or reopen it). If not, call create_ticket again with not_duplicate: true.',
          );
        }
      }
      const table = pickFor(planned.type?.[0]);
      // Why it runs on this model (#1061): the table's pick for its type (the Taskmaster picks from the table), or a person's own choice.
      const byHand = !caller && (model !== null || effort !== null);
      model ??= table.model;
      effort ??= table.effort;
      const pickBy = byHand ? session.name : caller ? 'Taskmaster' : 'table';
      let because = pickReason(byHand ? session.name : 'table', planned.type?.[0], model, effort, typeof body.pick_reason === 'string' ? body.pick_reason.slice(0, 200) : '');
      // Third fix (#1157): a bug that looks like 2+ earlier fixes of the last 14 days starts with "diagnose first", one tier up from the table's pick.
      const repeat = planned.type?.[0] === 'bug' ? await findRepeats(store, project, { title, brief: ownBrief(message), at: Date.now() }).catch(() => []) : [];
      const stepped = repeat.length ? steppedTier({ model: model!, effort: effort! }, table, project.fable_ok !== 'off') : null;
      const tierWas = tierLabel(model, effort);
      if (stepped) {
        ({ model, effort } = stepped);
        because = `third fix (${repeat.map((m) => `#${m.number}`).join(', ')}): one tier up → ${tierLabel(model, effort)}`;
      }
      const brief0 = repeat.length ? `${flagBlock(repeat)}${FLAG_RULE}${message}` : message;
      // Chained: start_after #N holds the brief until #N's work is live (or merged, with start_when).
      let follow: { leader: Ticket; when: Chain['when']; base: string | null; since: number } | null = null;
      let leader: Ticket | undefined;
      if (body.start_after != null) {
        const when = (oneOf(body.start_when ?? null, ['live', 'merged'], 'start_when') ?? 'live') as Chain['when'];
        leader = store.listTickets(project.id).find((t) => t.kind !== 'coordinator' && t.number === Number(body.start_after));
        if (!leader) throw new HttpError(400, `No minion #${String(body.start_after).slice(0, 20)} in this scheme to start after`);
        const f = await waiters.follow(leader.id, when);
        if (f.state === 'unshipped') throw new HttpError(400, `#${leader.number} was dismissed without its work shipping, so nothing can start after it`);
        if (f.state === 'wait') follow = { leader, when, base: f.base, since: f.since };
      }
      // Its build: the one the create sets (null: none), as `build` or the build property; else its parent's, else its start_after leader's.
      const build = body.build !== undefined ? buildNumber(body.build) : given('build') ? undefined : (parent?.build ?? leader?.build ?? null);
      // Its effort (#1751, src/effort-retros.ts): its own, else its leader's, else its parent's; an unnamed chain is named after its leader.
      const effortOf = (t: Ticket | null | undefined) => (t ? ((store.props.forTarget('minion', t.id)[EFFORT_KEY] as string | undefined) ?? null) : null);
      const joins = given(EFFORT_KEY) ? null : effortFor(null, leader ? { number: leader.number!, effort: effortOf(leader) } : null, effortOf(parent));
      if (joins?.name) props[EFFORT_KEY] = joins.name;
      if (joins?.stampLeader && leader) store.props.set('minion', leader.id, project.id, { [EFFORT_KEY]: joins.name }, session.name);
      // The build's own minion (build branches, specs/build-branches.md): it keeps the list and lands the build.
      const owner = body.build_owner === true;
      if (owner && !build && !given('build')) throw new HttpError(400, "build_owner needs a build: pass build (the scheme's highest build number plus one for a new one)");
      const { id, notes } = await app.newMinion(project, { title, props, model, effort, build }, session.name);
      // Its first turn runs for whoever asked: the person, or the person of the Taskmaster's turn that made it.
      store.addPick(id, model, effort, pickBy, because);
      store.updateTicket(id, { picked_because: because, person_id: caller ? caller.person_id : (session.uid ?? null), parent: parent?.number ?? null, ...(workflow ? { workflow } : {}), ...(plugins ? { plugin_dirs: plugins } : {}) });
      await ownWrites(); // its build owner and the reply read the row back (#1244)
      const ownBuild = owner ? (store.getTicket(id)?.build ?? null) : null;
      if (ownBuild) store.setSetting(buildOwnerKey(project.id, ownBuild), id);
      // And it is that turn's asker's ask (#255), so its messages back count as theirs.
      const asker = caller && store.turnAsker(caller.id);
      if (asker && asker !== caller!.person_id) store.setSetting(askerKey(id), asker);
      // The ideas ledger (#1150): a minion started from a handoff (a brief naming one) marks its idea started, a chained one too.
      try {
        const shared = projectSharedDir(app.dataDir, project.id);
        const rel = handoffIn(message, shared);
        if (rel) store.ideas.linkHandoff(project.id, shared, rel, store.getTicket(id)!);
      } catch (e) {
        console.error(`ideas: linking #${id}: ${(e as Error).message}`);
      }
      // A split scheme's other Taskmasters read it in their next turn's digest (#919).
      if (store.isSplit(project.id)) {
        const by = caller?.kind === 'coordinator' ? caller : null;
        const who = !by ? session.name : by.coordinator_of == null ? 'The Overlord' : `${store.getUser(by.coordinator_of)?.name ?? 'Someone'}'s ${AGENT_NAME}`;
        store.noteDigest(project.id, by?.id ?? 0, `${who} started #${store.getTicket(id)!.number} ${title}`);
      }
      if (estimate) store.setSetting(budgetKey(id), { estimate } satisfies BudgetState);
      // Over $30, an agent's brief waits for a person's start card; a person starting their own is their OK. Every message
      // to it is held meanwhile (runner.send), a chained one's brief too.
      if (caller && estimate && estimate > START_CARD_USD) {
        const t = store.getTicket(id)!;
        const owner = store.minionOwner(t);
        const to = owner != null ? store.getUser(owner)?.name : undefined;
        const card = postCard(app, t, { questions: [startCard(t.number!, title, estimate)], startCost: estimate, ...(to ? { to } : {}) });
        store.setSetting(startHoldKey(id), { usd: estimate, card: card.id });
        // Not sealed (#1757): it waits on a person, so it lists and counts as needing one; the setting above holds its turns.
        if (!follow) store.updateTicket(id, { note: startNote(estimate) });
        notes.push(
          `Held: its brief expects about ${money(estimate)}, over ${money(START_CARD_USD)}, so no turn runs until a person answers its start card (${card.href}): Start, or Split first (it is dismissed and you split the brief). It isn't sealed: it shows as waiting on a person. Link that card in your reply; you can't answer it or start it yourself.`,
        );
      }
      if (follow) {
        const { leader, when } = follow;
        waiters.chain({ ticket: id, after: leader.id, when, message: brief0, from: session.name, base: follow.base, since: follow.since });
        store.updateTicket(id, { state: 'parked', note: `starts when #${leader.number} ${chainIs(when, leader.build)}` });
        runner.emit(id, 'note', { text: `Created by ${session.name}; its brief is held until #${leader.number} ${leader.title}'s work ${chainIs(when, leader.build)}. Messages to it wait for that start; Unseal starts it now.` });
        runner.broadcastTicket(id);
        notes.push(`Sealed: it starts by itself once #${leader.number}'s work ${chainIs(when, leader.build)}. Messages to it are held for that start; message_ticket with \`unpark\` starts it now.`);
      } else {
        runner.send(id, session.name, brief0, [], { brief: true });
      }
      if (repeat.length) {
        const tier = stepped ? { from: tierWas, to: tierLabel(model, effort) } : null;
        notes.push(flagNote(repeat, tier));
        runner.emit(id, 'note', { text: `Third-fix flag: looks like ${repeat.map((m) => `#${m.number}`).join(', ')}, so its brief starts with "diagnose first"${tier ? ` and it runs on ${tier.to}` : ''}.` });
      }
      // A brief an agent wrote (the Taskmaster's) is checked for its person's words and done-when (#1108); a person's own typed ask is already their words.
      if (caller) {
        const warning = briefWarning(briefText);
        if (warning) notes.push(warning);
        if (estimate == null) notes.push(`Cost check: the brief has no "Expected cost: $N" line (citadel:briefing, part 8), so its budget marks use the usual cost for its type. Put one in your next brief.`);
      }
      // The Taskmaster's create_ticket checks for look-alikes before it creates (#488); startChecks covers the rest.
      void startChecks(app, project.id, id, session.name, caller, `${title}\n${message}`);
      return json(res, 201, { ...ticketView(app, id), notes });
    },
  },

  // The scheme's Claude Code memory notes, read and written in place (the Orders → Memory page); a PUT with index: true adds a note's line to MEMORY.md. Not /memory, which is search over chats.
  {
    method: ['GET', 'PUT', 'DELETE'],
    path: '/api/projects/:project/memory-files',
    who: ['person'],
    async handler({ req, res, url, app, project }) {
      const folders = memoryFolders(project.repo_dir, memoryLogins(app));
      const closed = (n: number) => {
        return app.store.getTicketByNumber(project.id, n)?.status === 'closed';
      };
      if (req.method !== 'GET') {
        const body = req.method === 'PUT' ? await readJson(req) : {};
        const folder = folders.find((f) => f.id === (req.method === 'PUT' ? body.folder : url.searchParams.get('folder')));
        const file = noteFile(req.method === 'PUT' ? body.file : url.searchParams.get('file'));
        if (!folder || !file) throw new HttpError(400, 'Say which folder and note');
        try {
          if (req.method === 'DELETE') {
            deleteNote(folder.dir, file);
            // The saved copy of it too, or the next turn's restore puts the note back (sessions.ts writeBack).
            app.store.deleteClaudeState(join(folder.rel, file));
          } else if (body.index === true) indexNote(folder.dir, file);
          else {
            if (typeof body.text !== 'string' || body.text.length > 200_000) throw new HttpError(400, 'text must be text under 200 KB');
            saveNote(folder.dir, file, body.text);
          }
        } catch (err) {
          if (err instanceof HttpError) throw err;
          throw new HttpError(thrown(err).status ?? 404, thrown(err).message!);
        }
      }
      return json(res, 200, { folders: folders.map((f) => readFolder(f, closed)) });
    },
  },
  // The CI page's Test health tab (#1063): fast mode's state and known reds, and the flakiest test files of the last 14 days, each with the open minion on it.
  {
    method: 'GET',
    path: '/api/projects/:project/test-health',
    who: ['person'],
    async handler({ res, app, project }) {
      const { store } = app;
      const open = store.listTickets(project.id).filter((t) => t.kind !== 'coordinator' && t.status !== 'closed');
      const counts = store.flakeCounts(project.id, Date.now() - FLAKE_WINDOW_MS);
      // Sightings from before the file's newest commit on main (#1219): shown as such, and not counted toward a new fix.
      const changed = new Map(await Promise.all(counts.map(async (f) => [f.file, project.repo_dir ? await fileChangedAt(project.repo_dir, f.file) : null] as const)));
      const flakes = counts.map((f) => {
        const at = changed.get(f.file) ?? null;
        const before = at == null ? 0 : store.flakeSightings(project.id, f.file, Date.now() - FLAKE_WINDOW_MS).filter((t) => t <= at).length;
        const title = flakeBrief(f.file, 0, []).title;
        const fx = store.flakeFix(project.id, f.file);
        const ft = fx?.ticket_id == null ? undefined : store.getTicket(fx.ticket_id);
        // The fix (#1120): its minion's number and person, its age, and the clean runs of the 50 the desktop proof needs.
        const fix = fx && { state: fx.state, minion: ft?.number ?? null, owner: ft?.person_id == null ? null : (store.getUser(ft.person_id)?.name ?? null), startedAt: fx.started_at, heldAt: fx.held_at, cleanRuns: fx.clean_runs, need: PROOF_RUNS, reopened: fx.reopened };
        return { ...f, ...app.store.flakeMessages(project.id, f.file, Date.now() - FLAKE_WINDOW_MS), before, changedAt: at, fix: fix ?? null, minion: open.find((t) => t.title === title)?.number ?? ft?.number ?? null, lastMinion: f.ticketId == null ? null : (store.getTicket(f.ticketId)?.number ?? null) };
      });
      // The last day's land runs, each red one under its cause (#1607); null when GitHub can't be read.
      const since = Date.now() - LAND_REDS_MS;
      const read = (await app.ciHealth?.runsSince(project, since)) ?? null;
      const landRed = read && { ...landReds(read.runs, await readRetro(projectSharedDir(app.dataDir, project.id), since, Date.now()), since), partial: read.partial };
      json(res, 200, { fast: project.land_mode === 'fast' ? (app.fastMode?.view(project.id) ?? null) : null, flakes, landReds: landRed, now: Date.now() });
    },
  },
  // The first message "Start a minion to fix it" shows for a flaky file, for the person to read and confirm (#1063).
  {
    method: 'GET',
    path: '/api/projects/:project/flake-brief',
    who: ['person'],
    handler({ res, url, app, project }) {
      const file = url.searchParams.get('file') ?? '';
      const row = app.store.flakeCounts(project.id, Date.now() - FLAKE_WINDOW_MS, 1000).find((f) => f.file === file);
      if (!row) throw new HttpError(404, 'No flake of that file in the last 14 days');
      json(res, 200, flakeBrief(file, row.count, app.store.flakeDetails(project.id, file), app.store.flakeMessages(project.id, file, Date.now() - FLAKE_WINDOW_MS).messages));
    },
  },

  // The ideas ledger (#1150): every idea the scheme was shown, its pick, handoff and minion. The list re-reads the
  // scheme's pages and handoffs in the background once it is a few minutes old; ?status= and ?q= filter.
  {
    method: 'GET',
    path: '/api/projects/:project/ideas',
    who: ['person', 'taskmaster', 'minion'],
    async handler({ res, url, app, project }) {
      const status = url.searchParams.get('status');
      if (status && !(IDEA_STATUSES as readonly string[]).includes(status)) throw new HttpError(400, `status is one of ${IDEA_STATUSES.join(', ')}`);
      json(res, 200, await ideasView(app, project, status, (url.searchParams.get('q') ?? '').slice(0, 200)));
    },
  },
  {
    // A hand fix: { status: one of the statuses, or null for automatic } and/or { ticket: #N, null to unlink, or 'auto' }.
    method: 'POST',
    path: '/api/projects/:project/ideas/:id',
    who: ['person', 'taskmaster', 'minion'],
    async handler({ req, res, app, project, params, session, caller }) {
      const body = await readJson(req);
      const row = app.store.ideas.get(Number(params.id));
      if (!row || row.project_id !== project.id) throw new HttpError(404, 'No such idea in this scheme');
      const change: Parameters<typeof app.store.ideas.edit>[2] = {};
      if (body.status !== undefined) {
        if (body.status !== null && !(IDEA_STATUSES as readonly string[]).includes(body.status)) throw new HttpError(400, `status is one of ${IDEA_STATUSES.join(', ')}, or null`);
        change.status = body.status;
      }
      if (body.ticket !== undefined) {
        if (body.ticket === null || body.ticket === 'auto') change.ticket = body.ticket;
        else {
          const t = app.store.getTicketByNumber(project.id, Number(body.ticket));
          if (!t) throw new HttpError(404, `No minion #${body.ticket} in this scheme`);
          change.ticket = { id: t.id, number: t.number };
        }
      }
      const by = caller ? (caller.kind === 'coordinator' ? 'Taskmaster' : `#${caller.number}`) : session.name;
      const updated = app.store.ideas.edit(row.id, by, change);
      json(res, 200, { idea: ideaRow(app, project, updated) });
    },
  },
  // Every dated decision this scheme can see, parsed live from where it is written (the Orders → Decisions page and
  // search_decisions, #1064). ?scope=scheme|citadel|all, ?q= to search.
  {
    method: 'GET',
    path: '/api/projects/:project/decisions',
    who: ['person', 'taskmaster', 'minion'],
    async handler({ res, url, app, project }) {
      const scope = url.searchParams.get('scope') ?? 'all';
      if (!['scheme', 'citadel', 'all'].includes(scope)) throw new HttpError(400, 'scope must be scheme, citadel or all');
      const q = (url.searchParams.get('q') ?? '').slice(0, 200);
      const { decisions, counts } = await loadDecisions(app, project);
      const shown = decisions.filter((d) => inScope(d, scope));
      const found = q.trim() ? searchDecisions(shown, q) : shown;
      // The decisions the rows point at (what reversed them, what they reverse), so a reader can name them.
      const ids = new Set(found.flatMap((d) => [d.reversed?.by ?? '', ...d.reverses]));
      json(res, 200, { decisions: found, counts, all: decisions.length, linked: decisions.filter((d) => ids.has(d.id)) });
    },
  },
  // The plugin folders in the scheme's repo, for the Minion rules page's picker (#1041). Saving them stays admin-only (PATCH).
  {
    method: 'GET',
    path: '/api/projects/:project/plugins',
    who: ['person'],
    async handler({ res, project }) {
      json(res, 200, { plugins: project.repo_dir ? await findPlugins(project.repo_dir) : [] });
    },
  },
  // The property registry: everyone reads it; people and the Taskmaster change it, minions propose.
  {
    method: 'GET',
    path: '/api/projects/:project/properties',
    who: ['person', 'taskmaster', 'minion'],
    handler: ({ res, app, project }) => json(res, 200, { keys: app.store.props.list(project.id), globalOwner: GLOBAL_OWNER }),
  },
  {
    method: 'POST',
    path: '/api/projects/:project/properties/keys',
    who: PEOPLE_AND_TASKMASTER,
    async handler(ctx) {
      const { app, project } = ctx;
      const r = app.store.props.registerKey(project.id, await readJson(ctx.req), actorFor(ctx));
      if (r.registered) app.registryChanged(project.id, r.scope === 'global');
      return json(ctx.res, r.registered ? 201 : 200, r);
    },
  },
  {
    method: 'POST',
    path: '/api/projects/:project/properties/values',
    who: PEOPLE_AND_TASKMASTER,
    async handler(ctx) {
      const { app, project } = ctx;
      const body = await readJson(ctx.req);
      const actor = actorFor(ctx);
      const r = app.store.props.registerValues(project.id, body.key, body.values, actor, !!body.force);
      if (r.added.length || r.updated.length) app.registryChanged(project.id, app.store.props.isGlobal(project.id, body.key));
      if (r.unreviewed.length) {
        const coordinator = app.store.getOverlord(project.id);
        if (coordinator) app.runner.emit(coordinator.id, 'note', { everyone: true, text: `${actor.name} added ${r.unreviewed.map((v) => `${body.key}: ${v}`).join(', ')} to the registry. It's live now; review it in Orders → Properties.` });
      }
      return json(ctx.res, 200, r);
    },
  },
  {
    method: 'POST',
    path: '/api/projects/:project/properties/review',
    who: PEOPLE_AND_TASKMASTER,
    async handler(ctx) {
      const { app, project } = ctx;
      const body = await readJson(ctx.req);
      const global = app.store.props.isGlobal(project.id, body.key);
      const r = app.store.props.review(project.id, body, actorFor(ctx));
      app.registryChanged(project.id, global);
      return json(ctx.res, 200, r);
    },
  },

  // Saved views: each person's own named property filters above the minions list (#194).
  { method: 'GET', path: '/api/projects/:project/views', who: ['person'], handler: ({ res, app, session, project }) => json(res, 200, app.store.listViews(project.id, session.name)) },
  {
    method: 'POST',
    path: '/api/projects/:project/views',
    who: ['person'],
    async handler({ req, res, app, session, project }) {
      const body = await readJson(req);
      app.store.saveView(project.id, session.name, str(body.name, 'Name', 40), viewPicks(body.picks));
      await ownWrites(); // the broadcast's refresh and the reply list it (#1244)
      // Every stream gets it; each tab refreshes only for its own person, like ticket_pin.
      app.broadcast({ type: 'views', name: session.name, projectId: project.id });
      return json(res, 200, app.store.listViews(project.id, session.name));
    },
  },
  {
    method: 'DELETE',
    path: '/api/projects/:project/views/:view',
    who: ['person'],
    handler({ res, app, session, project, params }) {
      if (!app.store.deleteView(project.id, session.name, Number(params.view))) throw new HttpError(404, 'No such view');
      app.broadcast({ type: 'views', name: session.name, projectId: project.id });
      return json(res, 200, app.store.listViews(project.id, session.name));
    },
  },

  // Everything in the scheme waiting on a person: open cards, and minions in state ready, complete or try; only this scheme's (a card another scheme addressed to them stays out: Josh, 2026-11-19, docs/adr/0015).
  {
    method: 'GET',
    path: '/api/projects/:project/inbox',
    who: ['person'],
    handler: ({ res, app, session, project }) =>
      json(res, 200, {
        items: inboxItems(app.store, app.runner.approvals, project.id, session.name),
      }),
  },
  // What happened in the scheme since this person last did something there, for the Taskmaster chat.
  { method: 'GET', path: '/api/projects/:project/recap', who: ['person'], handler: ({ res, app, session, project }) => json(res, 200, app.store.recap(session.name, project.id)) },
  {
    method: 'GET',
    path: '/api/projects/:project/search',
    who: ['person'],
    handler({ res, url, app, project }) {
      const q = (url.searchParams.get('q') ?? '').trim().slice(0, 200);
      const ticket = Number(url.searchParams.get('ticket')) || undefined;
      return json(res, 200, q.length < 2 ? [] : searchProject(app, project.id, q, ticket));
    },
  },
  // Search by meaning (#331): the scheme's chunks closest to q. scope mine: the calling minion's own
  // chat, or a person's own messages; minions: open minions' titles and notes (create_ticket's duplicate check, #488). The router keeps people to their schemes and agents to their own.
  {
    method: 'GET',
    path: '/api/projects/:project/memory',
    who: ['person', 'taskmaster', 'minion'],
    async handler({ res, url, app, project, caller, session }) {
      const q = (url.searchParams.get('q') ?? '').trim().slice(0, 1000);
      if (q.length < 2) throw new HttpError(400, 'Say what to look for (q)');
      const scope = oneOf(url.searchParams.get('scope'), ['scheme', 'mine', 'minions'], 'scope');
      const mine = scope === 'mine';
      const limit = Number(url.searchParams.get('limit')) || 5;
      if (!app.memory.indexed(project.id)) throw new HttpError(409, `${project.name}'s chats aren't indexed for search by meaning yet`);
      const hits = await app.store.memory.search(project.id, q, app.memory.embed, app.memory.model, { limit, openMinions: scope === 'minions', ...(mine ? (caller ? { ticketId: caller.id } : { personId: session.uid ?? -1 }) : {}) }).catch((err) => {
        console.error('Semantic memory search failed:', err?.cause?.code ?? err?.message ?? err);
        throw new HttpError(503, "The embedding service isn't answering, so search by meaning is down; exact-text search still works");
      });
      return json(res, 200, { hits: scope === 'minions' ? minionHits(app, hits) : hits });
    },
  },
  // Past minions and handoffs by words (#1156, search_minions): ?q= (empty lists the newest closed), ?since=YYYY-MM-DD, ?limit=.
  {
    method: 'GET',
    path: '/api/projects/:project/past-minions',
    who: ['person', 'taskmaster', 'minion'],
    handler({ res, url, app, project }) {
      const since = (url.searchParams.get('since') ?? '').trim();
      if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since)) throw new HttpError(400, 'since is a date, YYYY-MM-DD');
      const q = (url.searchParams.get('q') ?? '').slice(0, 500);
      // Pacific midnight, near enough either side of daylight saving for a day's cut.
      const hits = app.store.minionIndex.search(project.id, q, { since: since ? Date.parse(`${since}T00:00:00-08:00`) : 0, limit: Number(url.searchParams.get('limit')) || 10 });
      return json(res, 200, { hits });
    },
  },

  // The scheme's scheduled minions, for the Schedules page and the Taskmaster; each with the number
  // of the minion its last run started. People and the Taskmaster add them; minions can't.
  {
    method: 'GET',
    path: '/api/projects/:project/schedules',
    who: PEOPLE_AND_TASKMASTER,
    handler: ({ res, app, project }) => json(res, 200, { schedules: app.store.schedules.list(project.id).map((s) => scheduleView(app, s)) }),
  },
  // Who waits on whom (#1679), for the Chains page and the chat head's chain link: waits on another minion, claim queues,
  // build feeders. Read from what the minions list already holds; cached a few seconds, as every chat open asks.
  {
    method: 'GET',
    path: '/api/projects/:project/chains',
    who: PEOPLE_AND_TASKMASTER,
    handler: ({ res, app, project }) => {
      const hit = chainCache.get(project.id);
      if (hit && hit.at > Date.now() - 5000) return json(res, 200, { chains: hit.chains });
      const { store } = app;
      const shown = (t: Ticket) => ({ ...t, status: app.runner.shownStatus(t) });
      const found = (t: Ticket | undefined) => t && shown(t);
      const chains = chainsOf({
        tickets: store.listTickets(project.id).map(shown),
        waitsOf: (t) => app.runner.outboxWaits(t) as WaitLink[],
        find: (p, n) => found(store.getTicketByNumber(p, n)),
        get: (id) => found(store.getTicket(id)),
        claims: store.claims.list(project.id).map((c) => ({ name: c.name, holder: c.holder, waiting: store.claims.waiting(project.id, c.name) })),
        builds: (app.builds?.get(project.id) ?? []).map((b) => ({ build: b.build, owner: b.owner })),
      });
      chainCache.set(project.id, { at: Date.now(), chains });
      return json(res, 200, { chains });
    },
  },
  {
    method: 'GET',
    path: '/api/projects/:project/schedule-audits',
    who: PEOPLE_AND_TASKMASTER,
    handler: ({ res, app, project }) => json(res, 200, { audits: checkAudits(app.store, project.id) }),
  },
  {
    method: 'POST',
    path: '/api/projects/:project/schedules',
    who: PEOPLE_AND_TASKMASTER,
    async handler({ req, res, app, session, caller, project }) {
      const { body, extra } = scheduleTemplate(app, project, await readJson(req), null);
      const fields = scheduleFields(app, project.id, body, true, !!caller);
      const s = app.store.schedules.create({ project_id: project.id, ...(fields as Required<typeof fields>), ...extra, created_by: session.name });
      app.broadcast({ type: 'schedules', projectId: project.id });
      return json(res, 201, scheduleView(app, s));
    },
  },
  // The post-deploy watch's checks per deploy (#1060): this server's own deploys, so Citadel's Releases page only.
  {
    method: 'GET',
    path: '/api/deploy-watch',
    who: ['person'],
    handler: ({ res, app }) => json(res, 200, { deploys: app.health?.watch?.report() ?? [] }),
  },
  // Claims (#921): the pipeline lane and other single-holder duties. Everyone in the scheme reads them; people and
  // Taskmasters take and free them (every member decides alike, so any of them frees one whoever holds it).
  // Three lines after every ship (#1119, src/ship-lessons.ts): the scheme's queue, read and marked taken by its weekly
  // Ship lessons run or a Taskmaster now, and by the memory curator (#1111) once it reads the queue.
  {
    method: 'GET',
    path: '/api/projects/:project/ship-lessons',
    who: ['person', 'taskmaster', 'minion'],
    handler: ({ res, url, app, project }) => {
      const days = Math.min(Math.max(Number(url.searchParams.get('days')) || 60, 1), 365);
      const since = Date.now() - days * 86_400_000;
      const week = app.store.lessons.stats(project.id, Date.now() - 7 * 86_400_000);
      return json(res, 200, { days, lessons: app.store.lessons.list(project.id, { since, taken: url.searchParams.get('taken') === '1' }), week, window: app.store.lessons.stats(project.id, since) });
    },
  },
  {
    method: 'POST',
    path: '/api/projects/:project/ship-lessons/take',
    who: ['person', 'taskmaster', 'minion'],
    async handler({ req, res, app, project }) {
      const body = await readJson(req);
      if (!Array.isArray(body.ids) || !body.ids.length || body.ids.length > 200 || !body.ids.every((n: unknown) => Number.isInteger(n) && (n as number) > 0)) throw new HttpError(400, 'ids is a list of 1 to 200 lesson ids');
      const note = str(body.note, 'Note', 300);
      return json(res, 200, { taken: app.store.lessons.take(project.id, body.ids, note) });
    },
  },
  {
    method: 'GET',
    path: '/api/projects/:project/claims',
    who: ['person', 'taskmaster', 'minion'],
    handler: ({ res, app, project }) => json(res, 200, { claims: app.store.claims.list(project.id).map((c) => claimView(app, c)) }),
  },
  {
    method: 'POST',
    path: '/api/projects/:project/claims',
    who: PEOPLE_AND_TASKMASTER,
    refuse: 'Only people and Taskmasters take claims; ask your Taskmaster',
    async handler({ req, res, app, session, caller, project }) {
      const body = await readJson(req);
      const name = claimName(body.name);
      const note = body.note == null ? '' : str(body.note, 'Note', 300);
      const queue = body.queue == null ? null : queueOf(app, project.id, body.queue);
      let holder: Ticket | null | undefined = caller;
      if (body.minion != null) {
        holder = app.store.getTicketByNumber(project.id, Number(body.minion));
        if (!holder || holder.kind === 'coordinator' || holder.status === 'closed') throw new HttpError(400, `No open minion #${Number(body.minion)} in this scheme`);
      }
      const held = app.store.claims.get(project.id, name);
      // Only a queue (#1334): edit the line of a claim someone else holds, or start a free one with the first in line, who is told.
      if (queue && body.minion == null && held && held.holder !== holder?.id) {
        app.store.claims.setQueue(project.id, name, queue, session.name);
        app.broadcast({ type: 'claims', projectId: project.id });
        return json(res, 200, { claim: claimView(app, held) });
      }
      const first = queue?.length && body.minion == null && !held;
      if (first) holder = app.store.getTicket(queue[0])!;
      if (!holder) throw new HttpError(400, 'Name the minion that holds it (minion: its number), or give a queue');
      const taken = app.store.claims.take(project.id, name, holder.id, session.name, note);
      if (taken.held) {
        const v = claimView(app, taken.held);
        throw new HttpError(409, `${name} is held by ${v.holder_name}, taken by ${v.taken_by} ${v.since_text}${taken.held.note ? ` (${taken.held.note})` : ''}. Release it first if it should move, or add to its queue.`);
      }
      if (queue) app.store.claims.setQueue(project.id, name, queue, session.name);
      if (first) app.runner.claimPassed(project.id, [{ to: taken.claim }], `${session.name} started its queue with you`, session.name);
      else app.broadcast({ type: 'claims', projectId: project.id });
      const view = claimView(app, taken.claim);
      if (app.store.isSplit(project.id)) app.store.noteDigest(project.id, caller?.id ?? holder.id, `${session.name} claimed ${name} for ${view.holder_name}${note ? ` (${note})` : ''}`);
      return json(res, held ? 200 : 201, { claim: view });
    },
  },
  {
    // The page's reorder and remove (#1334): the whole waiting order, first in line first.
    method: 'PUT',
    path: '/api/projects/:project/claims/:name/queue',
    who: PEOPLE_AND_TASKMASTER,
    async handler({ req, res, app, session, project, params }) {
      const name = claimName(decodeURIComponent(params.name));
      const queue = queueOf(app, project.id, (await readJson(req)).queue);
      const held = app.store.claims.get(project.id, name);
      if (!held) throw new HttpError(404, `Nobody holds ${name}, so it has no queue`);
      app.store.claims.setQueue(project.id, name, queue, session.name);
      app.broadcast({ type: 'claims', projectId: project.id });
      return json(res, 200, { claim: claimView(app, held) });
    },
  },
  {
    // Release: the claim passes to the first in its queue, who hears so (#1334), or is free. Taskmasters only (the `release` tool): the page
    // has no Release button, since a person can't tell whom it would pass to (#1435).
    method: 'DELETE',
    path: '/api/projects/:project/claims/:name',
    who: ['taskmaster'],
    refuse: 'Only Taskmasters pass a claim on; ask yours',
    handler({ res, app, session, caller, project, params, url }) {
      const name = claimName(decodeURIComponent(params.name));
      // ?holder=<number>: the holder the caller saw, so a second Release click can't pass it on twice.
      const saw = url.searchParams.get('holder');
      const now = app.store.claims.get(project.id, name);
      if (saw != null && now && app.store.getTicket(now.holder)?.number !== Number(saw)) {
        throw new HttpError(409, `${name} already passed to ${claimView(app, now).holder_name}; nothing was released`);
      }
      const passed = app.store.claims.passOn(project.id, name, 'released');
      const view = passed && claimView(app, passed.from);
      if (passed && view) {
        if (passed.to) app.runner.claimPassed(project.id, [passed], `${session.name} released it from ${view.holder_name}`, session.name);
        else app.broadcast({ type: 'claims', projectId: project.id });
        if (app.store.isSplit(project.id)) app.store.noteDigest(project.id, caller?.id ?? view.holder, `${session.name} released ${view.name} (held by ${view.holder_name})${passed.to ? `; it passed to the next in its queue` : ''}`);
      }
      return json(res, 200, { released: view || null, ...(passed?.to && { claim: claimView(app, passed.to) }) });
    },
  },
  // Edit, pause or resume, or delete a schedule; runs it already started stay.
  {
    method: 'PATCH',
    path: '/api/schedules/:schedule',
    who: PEOPLE_AND_TASKMASTER,
    async handler({ req, res, app, schedule: s }) {
      const project = app.store.getProject(s.project_id)!;
      const { body, extra } = scheduleTemplate(app, project, await readJson(req), s);
      const patch: Record<string, unknown> = { ...scheduleFields(app, s.project_id, body, false, false, s), ...extra };
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
    method: 'DELETE',
    path: '/api/schedules/:schedule',
    who: PEOPLE_AND_TASKMASTER,
    handler({ res, app, schedule: s }) {
      app.store.schedules.remove(s.id);
      app.broadcast({ type: 'schedules', projectId: s.project_id });
      return json(res, 200, { deleted: s.id });
    },
  },

  {
    // message_taskmaster: one scheme's Taskmaster writes to another's, the only way out of its own
    // scheme. It reaches that Taskmaster alone, never its minions.
    method: 'POST',
    path: '/api/taskmaster',
    who: ['taskmaster'],
    refuse: `Only a ${AGENT_NAME} can message another scheme's ${AGENT_NAME}`,
    async handler({ req, res, app, caller }) {
      const from = caller!;
      const { store, runner } = app;
      const body = await readJson(req);
      if (body.need == null && !body.saw) str(body.text, 'Message', 10_000); // an empty send is still told the message is missing
      // Held mail (#405): wake: false waits for the other Taskmaster's next turn instead of starting one.
      const checked = checkNeed(body);
      if ('error' in checked) throw new HttpError(400, checked.error);
      const { need } = checked;
      // An ask (anything but a fyi) takes the four-part form (#1165); a fyi stays free text.
      let text: string;
      if (need === 'fyi') text = str(body.text, 'Message', 10_000);
      else {
        const form = checkAsk(body);
        if ('error' in form) throw new HttpError(400, form.error);
        text = formatAsk(form.ask);
        if (text.length > 10_000) throw new HttpError(400, 'Message is too long: at most 10,000 characters, a longer one goes in file');
      }
      // Its own scheme plus a person: that member's Taskmaster there, as held mail only (a wake would start a turn on their login).
      const mate = sameSchemeTarget(app, from, body.scheme, body.person);
      const wake = body.wake !== false && need !== 'fyi' && !mate;
      const { own, person, who, project } = mate ?? schemeTarget(app, from, body.scheme);
      const to = mate?.to ?? (await taskmasterTo(app, from, own, project, body.person));
      const toCitadel = project.id === GLOBAL_OWNER;
      // Citadel's Taskmaster weighs a non-member's ask differently (its prompt). Names that could fake
      // the membership clause (a scheme called "X, for Cara, a Citadel member") come quoted.
      const name = (s: string) => (/[,"[\]\n]/.test(s) ? JSON.stringify(s) : s);
      const author = toCitadel ? `${AGENT_NAME} of ${name(own.name)}, for ${person ? name(person.name) : 'no one'}, ${store.canSee(who, project.id) ? 'a' : 'not a'} ${project.name} member` : `${AGENT_NAME} of ${own.name}${senderLabel(app, from)}`;
      // A file (#405) is copied into the receiver's shared inbox/ before anything is sent, so a bad path sends nothing.
      const file = body.file == null || body.file === '' ? null : relayFile(projectSharedDir(app.dataDir, own.id), projectSharedDir(app.dataDir, project.id), own.name, str(body.file, 'File', 1000));
      const attached = file ? `\n${APP_NAME} copied a file it attached into your scheme's shared folder, where your minions can read it too: ${file.path} (${byteSize(file.size)})` : '';
      const { held, left, woke } = runner.relayTaskmaster(from.id, to.id, author, text, wake, attached, body.urgent === true, need);
      // A reply from that scheme comes back to this Taskmaster, not to whichever of its scheme's is default (#919).
      if (!held) store.setSetting(replyKey(to.id, own.id), from.id);
      // Citadel may answer for a while once a message of theirs has reached it.
      if (toCitadel && !held) store.setSetting(askedCitadelKey(own.id), Date.now());
      if (!held) runner.emit(from.id, 'note', { need, text: `${wake || woke ? 'Sent' : 'Left held mail for'} the ${AGENT_NAME} of ${project.name}${mate ? ` (${store.getUser(to.coordinator_of!)?.name ?? 'someone'}'s)` : ''}: ${text.length > 200 ? text.slice(0, 200) + '…' : text}${file ? `\nWith a file, copied to ${file.path}` : ''}` });
      return json(res, 202, { scheme: project.name, held, left, ...(woke ? { woke } : {}), ...(file ? { file: file.path } : {}) });
    },
  },
];

/** One ledger row as the page shows it: links to its page, handoff and minion, made here so they always open. */
function ideaRow(app: App, project: Project, r: Idea) {
  const shared = projectSharedDir(app.dataDir, project.id);
  const inShared = (abs: string) => (abs.startsWith(shared + sep) ? relative(shared, abs).split(sep).join('/') : null);
  const pageRel = r.page ? inShared(r.page) : null;
  const pageArt = r.page && !pageRel ? app.store.latestArtifact(project.id, [r.page]) : undefined;
  const t = r.ticket_id ? app.store.getTicket(r.ticket_id) : undefined;
  return {
    ...r,
    page_label: r.page ? (pageRel ?? basename(r.page)) : null,
    page_href: pageRel ? `#/s/${project.id}/${encodeURIComponent(pageRel)}` : pageArt ? `#/a/${pageArt.id}` : null,
    handoff_href: r.handoff && existsSync(join(shared, r.handoff)) ? `#/s/${project.id}/${encodeURIComponent(r.handoff)}` : null,
    minion: t ? { number: t.number, title: t.title, status: t.status } : r.number ? { number: r.number, title: null, status: null } : null,
  };
}

const IDEAS_FRESH_MS = 5 * 60_000;
const ideasSynced = new Map<number, number>();

/** The ledger for the page and the ideas tool: rows (filtered), counts by status, and the Later rows waiting over two weeks. */
export async function ideasView(app: App, project: Project, status: string | null, q: string) {
  const shared = projectSharedDir(app.dataDir, project.id);
  const first = !ideasSynced.has(project.id);
  if (first || Date.now() - ideasSynced.get(project.id)! > IDEAS_FRESH_MS) {
    ideasSynced.set(project.id, Date.now());
    // The first look in a server's life reads everything first, so the page opens full; later ones refresh behind it.
    // Paced either way: the read yields to other requests between its steps (#1414).
    if (first) await app.store.ideas.now(project.id, shared);
    else app.store.ideas.soon(project.id, shared, 0);
  } else app.store.ideas.restatus(project.id);
  const all = app.store.ideas.list(project.id);
  const counts = Object.fromEntries(IDEA_STATUSES.map((s) => [s, all.filter((r) => r.status === s).length]));
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hit = (r: Idea) => !words.length || words.every((w) => [r.title, r.card, r.words, r.handoff, r.decided_by, r.number ? `#${r.number}` : '', r.source_number ? `#${r.source_number}` : ''].some((f) => f?.toLowerCase().includes(w)));
  const rows = all.filter((r) => (!status || r.status === status) && hit(r));
  const cutoff = Date.now() - LATER_STALE_MS;
  const waiting = all.filter((r) => r.status === 'later' && (r.decided_at ?? r.created_at) < cutoff).map((r) => r.id);
  return { ideas: rows.map((r) => ideaRow(app, project, r)), counts, total: all.length, waiting };
}
