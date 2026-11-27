// What a turn is launched with: its folder, system prompt, review set, scheme-refs file and launch plan, built from
// the facts the turn was given (src/turn-launch.ts turns them into arguments and env). A side question's fork (#932,
// src/side-ask.ts) is built here too, so its tools and prompt, the cached prefix, are its minion's turn's.
// Starting the turn, and what it means for the minion, stays in runner.ts (launchTurn).
// Moved out of runner.ts (#2045): it takes what it needs from the Runner as `TurnLaunchesDeps`.
import { jobMachinesFor } from './machine-jobs.ts';
import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { buildOwnerKey, onboardingOpen, type EventRow, type Project, type Store, type Ticket, type TicketFields } from './db.ts';
import { fableMeter } from './costs.ts';
import { restoreSession, transcriptPath } from './sessions.ts';
import { buildBranchLater, landsBuilds, surveyReports } from './workspace.ts';
import { thrown } from './thrown.ts';
import { publicAddress } from './http.ts';
import { buildPreviewPath } from './previews.ts';
import { type TurnPlace } from './claude-link.ts';
import { runsRepoLater } from './wake.ts';
import { makeTmpDir } from './turn-tmp.ts';
import { codexThreadKey, isCodexModel, type CodexThread } from './codex.ts';
import { decideHold, type HoldDecision, type Holds } from './prompt-hold.ts';
import { cabalName, overseerOf } from './cabal-board.ts';
import { promptParts, promptText, type PromptSections, type TurnMachine } from './prompts.ts';
import { offSkills, pruneKit } from './skills.ts';
import { copyPinned, launchPlan, turnPins, turnSettings, wrapperSpec, type EveryScheme } from './turn-launch.ts';
import { secretEnv } from './secrets.ts';
import { appFolder } from './app-services.ts';
import { homedir } from 'node:os';
import { budgetFor, turnLine } from './minion-budget.ts';
import { isAppTurnsRun } from './schedules.ts';
import { kitLine, readAgentFilesLater, renderSet, reviewSetLine, withoutGoneAgents } from './review-set.ts';
import { warmKey } from './turn-keys.ts';
import type { TurnGithub } from './github-link.ts';
import type { MinionJobs } from './minion-jobs.ts';
import type { CoordinatorEnv } from './runner.ts';

/** Whether `path` is there, asked off the server's thread (#1808). */
const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

/** A container turn's `container` file and first beat (spawnInContainer): it counts as running while its container starts. */
export const containerFiles = async (dir: string, place: { container: string }) => {
  await writeFile(join(dir, 'container'), place.container);
  await writeFile(join(dir, 'beat'), '');
};

/**
 * What building a launch needs from the Runner. Settings that server.ts and tests set on the Runner after it is made
 * (noTurns, units, pool, jobs, placeFor, githubFor...) are read through functions, so a later change still counts.
 */
export interface TurnLaunchesDeps {
  store: Store;
  dataDir: string;
  claudeBin: string;
  deploysRepos: Set<string>;
  refsSeq: Map<number, number>;
  now: () => number;
  promptHolds: () => Holds;
  turnsDir: () => string;
  noTurns: () => boolean;
  units: () => boolean;
  unitTag: () => string;
  pool: () => boolean;
  jobs: () => Pick<MinionJobs, 'turnLine'> | null;
  liveHead: () => string | null;
  coordinatorEnv: CoordinatorEnv;
  heavyEnv: (ticket: TicketFields, person: number | null) => Record<string, string>;
  everySchemeFor: (project: Project, ticket: Ticket, asker: number | null) => EveryScheme | null;
  ticketsDir: (project: Project) => string;
  filesDir: (ticket: Ticket) => string | null;
  sharedDir: (project: Project) => string | null;
  tmpRoot: (projectId: number) => string;
  heldFor: (ticketId: number) => string | null;
  openPr: (ticketId: number) => boolean;
  memoryScheme: (projectId: number) => boolean;
  machines: (project: Project, askers: number[]) => TurnMachine[];
  refsText: (ticket: Ticket) => string;
  codexWhy: (person: number | null) => string | null;
  codexPlaceFor: (person: number) => TurnPlace | null | undefined;
  githubFor: (person: number | null, turnDir: string, later?: boolean) => TurnGithub | null | undefined;
  mediaFor: (person: number | null) => boolean | undefined;
  placeFor: (person: number | null, warm?: string) => TurnPlace | { refused: string } | undefined;
  emit: (ticketId: number, kind: string, data: unknown, reserved?: number) => EventRow;
  /** The Runner's own, so a test that swaps it on the Runner (queue-give-back) swaps the side fork's too. */
  buildLaunch: TurnLaunches['buildLaunch'];
  spawnInContainer: (place: Extract<TurnPlace, { host: false }>, dir: string, wrapper: string[], ticketId: number) => void;
  spawnWrapper: (wrapper: string[], dir: string) => void;
}

export class TurnLaunches {
  private d: TurnLaunchesDeps;
  constructor(d: TurnLaunchesDeps) {
    this.d = d;
  }

  /** Which system prompt a turn runs with (src/prompt-hold.ts): the one its session last ran with while it is warm. */
  private holdFor(ticket: Ticket, current: PromptSections): HoldDecision {
    const record = this.d.promptHolds().record(ticket.id);
    return decideHold({ record, held: record && this.d.promptHolds().sections(record.hash), current, session: ticket.session_id, lastEnd: this.d.store.lastTurnEnd(ticket.id), now: this.d.now() });
  }

  /**
   * A launch from the facts a turn was given (src/turn-launch.ts), in a folder of its own named `name`. A side
   * question's fork (#932, src/side-ask.ts) builds its own here too, so its tools and prompt, the cached prefix,
   * are its minion's turn's. Throws, removing the folder, when the launch can't be built.
   */
  async buildLaunch(
    project: Project,
    ticket: Ticket,
    f: {
      place: TurnPlace;
      person: number | null;
      asker: number | null;
      machines: TurnMachine[];
      model: string | null;
      effort: string | null;
      typedBy: number | null;
      secrets: Map<string, string>;
      name: string;
      folders: { files: string | null; shared: string | null; memory: string | null };
      codex: { thread: string | null } | null;
      github?: number | null;
      side?: boolean;
      /** The machine it is placed on (startPlace). */
      worker?: { id: number; name: string } | null;
      /** The machine's name when this turn reaches its host (T8): run_on_host and the /host folders. */
      reach?: string | null;
    },
  ) {
    const { place, person, asker, machines, model, effort, codex } = f;
    const { files: filesDir, shared: sharedDir, memory: memoryDir } = f.folders;
    // The turn's folder, with its own copy of the pinned files: a restart sweeps the server's copy, and
    // the tripwire hook must still be there for a turn that outlives it.
    const dir = join(place.host ? this.d.turnsDir() : place.turnsDir, f.name);
    const pin = join(dir, 'pin');
    // Every file call here goes through fs/promises (#1808): on a busy disk a launch's sync calls held the server's thread ~1.2 s.
    await mkdir(dir, { recursive: true });
    try {
      const pins = turnPins();
      await copyPinned(pins.MCP_DIR, pin, !!place.host);
      // Kit skills the scheme turned off on its Skills page (#1062) aren't in this turn's copy at all. Not for Codex:
      // codex-turn.ts installs this kit into the person's shared Codex home, so pruning here would cut it from their other schemes too.
      if (!codex) await pruneKit(join(pin, basename(pins.KIT)), offSkills(project));
      // Deploys, pending-deploy and previews only mean something in the scheme whose code this server runs.
      // Sticky once true (#1276): a `git cat-file` that fails under load would flip it off for one turn, and with it the system prompt.
      const deploys = ticket.kind !== 'coordinator' && !!project.repo_dir && (this.d.deploysRepos.has(project.repo_dir) || ((await runsRepoLater(project.repo_dir, this.d.liveHead())) && !!this.d.deploysRepos.add(project.repo_dir)));
      // A file, not an argument: in claude's argv, a turn's own `pkill -f <word from the prompt>` would match claude itself.
      // Builds (specs/build-branches.md): only once the scheme's land.sh can merge into one.
      const builds = await landsBuilds(project.repo_dir);
      const build =
        builds && ticket.kind !== 'coordinator' && ticket.build
          ? {
              build: ticket.build,
              branch: await buildBranchLater(project.repo_dir, ticket.build),
              owner: this.d.store.getSetting<number>(buildOwnerKey(project.id, ticket.build)) === ticket.id,
              // Only this server's own scheme has build previews (src/previews.ts).
              preview: deploys ? `${publicAddress(this.d.noTurns()) ?? ''}/${buildPreviewPath(ticket.build)}` : null,
            }
          : null;
      // Its cabal (#2095): the board it leads or is on, named as people read it, with its Overseer's #N.
      const leadId = ticket.kind === 'coordinator' ? null : this.d.store.getCabal(ticket.id) ? ticket.id : (this.d.store.cabalRowOf(ticket.id)?.lead_id ?? null);
      const lead = leadId == null ? undefined : this.d.store.getTicket(leadId);
      const cabalAs = lead && cabalName(this.d.store, lead, this.d.store.getCabal(lead.id)?.name ?? '');
      const cabal = lead && {
        lead: lead.id === ticket.id,
        name: cabalAs!,
        overseer: overseerOf({ name: cabalAs! }),
        build: lead.build,
        ref: `${lead.project_id === project.id ? '' : `${this.d.store.getProject(lead.project_id)?.name ?? 'another scheme'} `}#${lead.number}`,
      };
      // What the Citadel scheme's Taskmaster may read in every scheme this turn (#656): its prompt and its launch say the same.
      const everyScheme = this.d.everySchemeFor(project, ticket, asker);
      const everySchemeView = everyScheme && {
        data: everyScheme.data,
        schemes: this.d.store
          .listProjects()
          .filter((p) => p.id !== project.id)
          .map((p) => ({ id: p.id, name: p.name })),
        apps: this.d.store.listContraptions().map((c) => ({ name: c.name, folder: appFolder(c, homedir()) })),
      };
      // Two halves (#878): system-prompt.md, the same for every minion of the scheme, and the per-minion and volatile lines that open the turn message.
      // Machines a minion may queue jobs on (#857): lent to this scheme with a jobs block; the owner's go card is the gate.
      const jobMachines = ticket.kind === 'coordinator' ? [] : jobMachinesFor(this.d.store, project.id);
      const parts = promptParts(
        project,
        ticket.kind === 'ticket' ? { ...ticket, type: this.d.store.props.forTarget('minion', ticket.id).type } : ticket,
        filesDir,
        sharedDir,
        this.d.ticketsDir(project),
        memoryDir,
        machines,
        deploys,
        this.d.store.appInstructions().text,
        this.d.heldFor(ticket.id),
        ticket.kind === 'coordinator' && onboardingOpen(project) ? surveyReports(this.d.dataDir) : [],
        build,
        builds,
        everySchemeView,
        this.d.store.personalLayer(ticket),
        this.d.openPr(ticket.id),
        ticket.kind === 'coordinator' && this.d.store.isSplit(project.id) ? (ticket.coordinator_of == null ? 'overlord' : 'person') : null,
        jobMachines,
        ticket.kind === 'coordinator' && fableMeter(this.d.store).over,
        cabal ?? null,
      );
      // A warm session keeps the prompt it last ran with (#1276): a changed byte would re-write its whole cached conversation.
      // Codex has no such cache to keep.
      const current = parts.system;
      const hold = codex ? null : this.holdFor(ticket, current);
      if (hold) parts.system = hold.system;
      const system = promptText(parts.system);
      await writeFile(join(dir, 'system-prompt.md'), system);
      // The scheme's review set (Build 4), fresh each turn so a page edit or a kit starter fix reaches the next turn's critics.
      const reviewDir = join(dir, 'review-set');
      const reviews = withoutGoneAgents(this.d.store.reviews.list(project.id), await readAgentFilesLater(project.repo_dir));
      // Phase 3: people's recorded verdicts, and the minion's ask for entries that read the requester's words.
      const verdicts = this.d.store.reviews.verdicts(project.id);
      const reviewFiles = new Map<string, string>();
      const reviewOn = renderSet(reviews, reviewDir, verdicts, reviews.some((e) => e.enabled && e.context.requester) ? this.d.store.reviews.requesterWords(ticket.id) : null, reviewFiles);
      // A scheme with no reviewers on gets no review-set line; the kit line says only what it changed from the kit's defaults.
      parts.turn.reviewSet = [reviewOn ? reviewSetLine(reviewDir, reviewOn, reviews) : '', kitLine(reviews, join(dir, 'review-kit'), verdicts, this.d.store.reviews.lessons(project.id), reviewFiles)].filter(Boolean);
      for (const [file, text] of reviewFiles) {
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, text);
      }
      // Its budget (#1114) each turn: what its kind of work usually costs and what it has used.
      const budget = ticket.kind === 'ticket' ? budgetFor(this.d.store, ticket) : null;
      if (budget) parts.turn.budget = [turnLine(budget, this.d.store.ticketCost(ticket.id))];
      const jobs = this.d.jobs()?.turnLine(ticket.id);
      if (jobs) parts.turn.jobs = [jobs];
      // What changed since the held prompt, last in the turn's [System] note. A side question's fork gets the prompt, not the note.
      if (hold?.note) parts.turn.rulesChanged = [hold.note];
      const context = promptText(parts.turn);
      // Its own temp folder on disk, cleared on dismissal (#218). CLAUDE_CODE_TMPDIR moves Claude Code's
      // /tmp/claude-<uid>, which ignores TMPDIR. A command or script that sets its own TMPDIR still wins.
      let tmp: string | null = null;
      try {
        tmp = await makeTmpDir(this.d.tmpRoot(project.id), ticket.id);
      } catch (err) {
        this.d.emit(ticket.id, 'note', { text: `Could not make this minion's temp folder, so it uses the shared one: ${thrown(err).message}` });
      }
      // The link check reads the reply against the folders the chat serves this turn's files from (ticketRoots).
      // A file, not an argument: a scheme's minion list outgrows a command line.
      // A refresh before follow() misses this turn: launchTurn rewrites it when one ran (refsSeq).
      const refsSeq = this.d.refsSeq.get(project.id) ?? 0;
      await writeFile(join(dir, 'scheme-refs.json'), this.d.refsText(ticket));
      // A host turn has no Codex hook, so the server login's Codex reviews run in its Codex container (#398): woken
      // (by the caller) if it stopped (a reboot) without replacing one a review may be running in.
      const codexAt = place.host && person !== null ? (this.d.codexPlaceFor(person) ?? null) : null;
      const reviewAt = codexAt && !codexAt.host ? codexAt : null;
      // CITADEL_, not COORDINATOR_: a warm turn's flag must not move the keepalive fingerprint (src/keepalive.ts).
      const coordinator = { ...this.d.coordinatorEnv(ticket), ...(hold?.warm ? { CITADEL_TOOL_HOLD: '1' } : {}) };
      const heavy = this.d.heavyEnv(ticket, person);
      // The person's own GitHub token (or none, so it can't push), and a line saying whose it is. Its empty gh folder made here, off the thread (#1808).
      const github = this.d.githubFor(f.github === undefined ? person : f.github, dir, true) ?? null;
      if (github?.env.GH_CONFIG_DIR) await mkdir(github.env.GH_CONFIG_DIR, { recursive: true, mode: 0o700 });
      const typer = f.typedBy ? this.d.store.getUser(f.typedBy) : undefined;
      const homeOf = this.d.store
        .listContraptions()
        .filter((c) => c.home_scheme === project.id)
        .map((c) => c.name);
      // A side question's fork runs as the server's child: it is short, and a restart loses it anyway.
      const unit = this.d.units() && place.host && !f.side && !f.worker ? `citadel-turn-${this.d.unitTag()}-${basename(dir)}` : null;
      // A host turn with no unit of its own (a side question) keeps its own helpers: a pool it started would live in the
      // server's cgroup and die on the next deploy restart, with every host turn's calls.
      // Everything the turn is launched with, from the facts chosen above (src/turn-launch.ts).
      const plan = await launchPlan({
        project,
        ticket,
        dir,
        pins,
        place,
        machines,
        model,
        effort,
        deploys,
        unit,
        pool: this.d.pool() && !codex && (!!f.worker || !(place.host && !unit && this.d.units())),
        machine: !!f.worker,
        ...(f.worker && f.reach ? { hostReach: f.reach } : {}),
        folders: {
          files: filesDir,
          shared: sharedDir,
          memory: memoryDir,
          tmp,
          tickets: this.d.ticketsDir(project),
          data: dirname(this.d.store.path),
          // A Taskmaster's git rules cover only open minions' worktrees (coordinatorAccess).
          openTickets:
            ticket.kind === 'coordinator'
              ? this.d.store
                  .listTickets(project.id)
                  .filter((t) => t.kind !== 'coordinator' && t.status !== 'closed' && t.cwd)
                  .map((t) => t.cwd!)
              : undefined,
        },
        codex,
        codexReview: reviewAt ? { container: reviewAt.container, turnsDir: reviewAt.turnsDir, env: reviewAt.env } : null,
        env: { server: process.env, coordinator, heavy, github: github?.env ?? null, secrets: secretEnv(f.secrets) },
        memory: this.d.memoryScheme(project.id),
        media: !!this.d.mediaFor(person),
        // A Codex turn has image_gen itself; a host turn reaches Codex only through the person's Codex container.
        codexImages: !codex && ticket.kind !== 'coordinator' && !this.d.codexWhy(person) && (!place.host || !!reviewAt),
        // A minion on a cabal board or leading one (#2090) is offered cabal_board; no other turn pays for its text.
        cabal: ticket.kind !== 'coordinator' && (this.d.store.getCabal(ticket.id) ? 'lead' : this.d.store.inCabal(ticket.id)),
        typer: typer && !typer.disabled_at ? { id: typer.id, login: typer.login } : null,
        homeContraptions: homeOf,
        jobMachines,
        appTurnsRun: ticket.kind !== 'coordinator' && homeOf.length > 0 && isAppTurnsRun(this.d.store, ticket),
        everyScheme,
        claudeBin: this.d.claudeBin,
        ...(f.side ? { side: true } : {}),
      });
      return { plan, dir, system, parts, context, pins, github, unit, reviewAt, refsSeq, hold: hold && { decision: hold, current } };
    } catch (err) {
      await rm(dir, { recursive: true, force: true });
      throw err;
    }
  }

  /**
   * Start a side question's fork (#932, src/side-ask.ts): the minion's own launch (buildLaunch, with the read-only
   * guard) on the asker's login, resuming `resume` (the minion's session, forked; or the fork, for a follow-up), with
   * `prompt` as its message. Nothing of the minion's changes: not its session, state or queue. Throws with a reason
   * people can read when it can't start.
   */
  async sideLaunch(ticketId: number, asker: number, prompt: string, resume: { id: string; fork: boolean }) {
    if (this.d.noTurns()) throw new Error('This is a preview: it never runs turns.');
    const ticket = this.d.store.getTicket(ticketId);
    const project = ticket && this.d.store.getProject(ticket.project_id);
    if (!ticket || !project || ticket.kind === 'coordinator' || !ticket.cwd) throw new Error('Only a minion with a folder can be asked on the side.');
    // Sender pays (#213): the asker's own login, never the minion's person's. The minion's warm key, so its warm account wins when it is the asker's.
    const place = this.d.placeFor(asker, warmKey(ticket)) ?? { host: true as const };
    if ('refused' in place) throw new Error(place.refused);
    const { model, effort } = turnSettings(ticket, project);
    if (isCodexModel(model) || this.d.store.getSetting<CodexThread>(codexThreadKey(ticket.id))) throw new Error('This minion runs on Codex, so it has no Claude session to ask on the side.');
    // The tools come from the minion's own turn's people (its person and asker), so the fork's cached prefix is the turn's.
    const person = ticket.person_id;
    const turnAsker = this.d.store.turnAsker(ticket.id) ?? person;
    const machines = this.d.machines(project, turnAsker !== null ? [turnAsker] : []);
    const { plan, dir } = await this.d.buildLaunch(project, ticket, {
      place,
      person,
      asker: turnAsker,
      machines,
      model,
      effort,
      typedBy: null,
      secrets: new Map(),
      name: `side-${ticket.id}-${Date.now()}`,
      folders: { files: this.d.filesDir(ticket), shared: this.d.sharedDir(project), memory: null },
      codex: null,
      github: asker,
      side: true,
    });
    try {
      for (const f of plan.files) await writeFile(join(dir, f.name), f.text, f.mode === undefined ? {} : { mode: f.mode });
      // The asker's login may lack the minion's session: put back the database's copy, as of its last finished turn.
      // shortcut: mid-turn on another login, the fork sees the session as its last turn left it; copying the live transcript across would show the turn so far.
      if (resume.fork) await restoreSession(this.d.store, ticket, project, plan.configDir);
      if (!(await exists(transcriptPath(plan.configDir, ticket.cwd, resume.id)!))) throw new Error(resume.fork ? 'This minion has no session to ask yet.' : 'This side thread has ended; ask a new question.');
      plan.args.push('--resume', resume.id, ...(resume.fork ? ['--fork-session'] : []));
      await writeFile(join(dir, 'prompt.jsonl'), prompt);
      for (const f of ['stream.jsonl', 'stderr.log', 'steer.jsonl']) await writeFile(join(dir, f), '');
      await writeFile(join(dir, 'spec.json'), JSON.stringify(wrapperSpec(plan, ticket.cwd)), { mode: 0o600 });
      if (plan.spawn.how === 'container') await containerFiles(dir, place as Extract<TurnPlace, { host: false }>);
    } catch (err) {
      await rm(dir, { recursive: true, force: true });
      throw err;
    }
    if (plan.spawn.how === 'container') this.d.spawnInContainer(place as Extract<TurnPlace, { host: false }>, dir, plan.spawn.wrapper, ticket.id);
    else this.d.spawnWrapper(plan.spawn.wrapper, dir);
    return { dir, configDir: plan.configDir, cwd: ticket.cwd, account: place.account ?? 1, container: place.host ? null : place.container };
  }
}
