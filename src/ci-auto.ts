// CI runners join schemes by themselves (#2064; Josh, 2026-11-25: "there shouldnt be separate runners for different
// schemes, there should be one connection that multiple schemes can use", then "can we do anything to streamline/automate
// this process so from the user of citadels perspective it feels like just one connection?"). GitHub wants one runner
// registration per repo on a personal account, so those registrations are plumbing: every PASS_MS this looks at each scheme
// with a GitHub repo and, when it needs a runner of a kind (its workflows ask for its `<slug>-ci…` labels, or a job sits
// queued with one), registers one on each connected PC lending it CI that has none for its repo yet (the spec's section 5:
// ticking a scheme makes that PC register its runners; Josh, 2026-11-25: "load balance across all valid machines"), one
// PC at a time in M6's order, through the runner agent there (src/ci-runner.ts RunnerJobs). A scheme unticked under a PC's
// CI runners has that PC's runners taken off. People hear of it only when it fails (the job's note) or when no PC lends CI
// to a scheme whose jobs wait: one card to its members naming the PCs they could ask, withdrawn once a PC lends it CI or
// serves its repo (#2220). `ci_runners` stays for odd cases.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { lendsRole } from './access.ts';
import { type RunnerAsk, RunnerBusy, runnerLabel } from './ci-runner.ts';
import type { Machine, Project, Store } from './db.ts';
import type { CardQuestion } from './ci-armed.ts';
import { rank } from './machine-balancer.ts';
import { repoSlug } from './prlinks.ts';
import { thrown } from './thrown.ts';

export type Os = 'windows' | 'linux';
const OSES: Os[] = ['windows', 'linux'];

/** How often it looks: slow on purpose (every-scheme §4), each pass reads local files and the agents' samples only. */
export const PASS_MS = 2 * 60_000;
/** After an add or remove starts for a scheme on a PC, the same isn't tried again for this long: the runner shows in the agent's next sample well within it. */
export const RETRY_MS = 30 * 60_000;
/** After one can't start for a reason that lasts (no repo, no GitHub link: the log says why), this long. */
export const FAILED_MS = 6 * 3600_000;
/** After one can't start because a job is going (the scheme's other one, or the agent's for another scheme): the next free pass or so. */
export const BUSY_MS = 5 * 60_000;
/** The no-machine card comes again at most this often while jobs still wait with no PC lending CI. */
export const CARD_MS = 7 * 24 * 3600_000;

/** Which runner a label of the scheme asks for: `<slug>-ci-linux` (and its role labels) a Linux one, `<slug>-ci` (and its) a Windows one; null for anything else (a session runner's `-desktop` is added by hand, as it runs as a person). */
export function osOfLabel(schemeName: string, label: string): Os | null {
  const ci = runnerLabel(schemeName);
  if (!ci) return null;
  const m = new RegExp(`^${ci}(-linux)?(?:-(?:land|side|long|check))?$`).exec(label.toLowerCase());
  return m ? (m[1] ? 'linux' : 'windows') : null;
}

/** The runner kinds a scheme's workflow files ask for by its labels. */
export function askedIn(schemeName: string, texts: string[]): Set<Os> {
  const ci = runnerLabel(schemeName);
  const out = new Set<Os>();
  if (!ci) return out;
  const re = new RegExp(`(?<![a-z0-9-])${ci}(?:-linux)?(?:-(?:land|side|long|check))?(?![a-z0-9-])`, 'g');
  for (const t of texts) for (const m of t.toLowerCase().matchAll(re)) out.add(osOfLabel(schemeName, m[0])!);
  return out;
}

/** A scheme's workflow files as its main checkout has them; none when it has no checkout or no workflows. */
export async function workflowTexts(project: Project): Promise<string[]> {
  if (!project.repo_dir) return [];
  const dir = join(project.repo_dir, '.github', 'workflows');
  const names = await readdir(dir).catch(() => [] as string[]);
  return Promise.all(names.filter((n) => /\.ya?ml$/.test(n)).map((n) => readFile(join(dir, n), 'utf8').catch(() => '')));
}

export interface CiAutoDeps {
  store: Store;
  /** Machines whose runner agent for `os` is connected now. */
  runnerMachines(os: Os): Machine[];
  /** The repos (owner/name, lowercase) a machine's runner agent for `os` has runners for, by its newest sample. */
  reposOn(machineId: number, os: Os): Set<string>;
  /** Each repo's queued self-hosted jobs' labels (lowercase), from ShipWatch's last look. */
  queuedLabels(): Map<string, Set<string>>;
  /** Start a runner job as Citadel itself (RunnerJobs.start with `auto`); throws when it can't start. */
  start(project: Project, ask: RunnerAsk): Promise<unknown>;
  /** The CI room a machine has now (M6's plan: runners awake); null when the balancer has no say there. */
  room(machineId: number): number | null;
  /** Tell the scheme's members no PC lends it CI while its jobs wait, naming the PCs that could (CI on elsewhere). */
  card(project: Project, os: Os, could: Machine[]): void;
  /** Take back an open no-machine card, with a line in its chat saying why (server.ts settleCard). */
  settle(card: { ticket: number; question: string }, line: string): void;
  workflows?: (project: Project) => Promise<string[]>;
  now?: () => number;
  log?: (line: string) => void;
}

/** A PC lends CI to the scheme: its CI role is on and the scheme ticked (and, for a person's own, they're in it). */
export function lendsCi(store: Store, m: Machine, project: Project): boolean {
  return !!store.machineRoles(m.id).find((r) => r.role === 'ci')?.on && lendsRole(store, m, 'ci', project);
}

export class CiAuto {
  private d: CiAutoDeps;
  private busy = false;
  /** `<add|remove>:<scheme id>:<os>[:<machine id>]` → when it may be tried again. Set before the job starts (every-scheme §4 q5). */
  private next = new Map<string, number>();
  /** The repos (lowercase) whose workflows asked for runners at the last pass: ShipWatch reads their queued jobs too, before any runner is there. */
  asking = new Set<string>();

  constructor(d: CiAutoDeps) {
    this.d = d;
  }

  private now() {
    return this.d.now?.() ?? Date.now();
  }

  private say(line: string) {
    (this.d.log ?? console.log)(line);
  }

  /** One look at every scheme. Returns what it started, for tests and the log. */
  async pass(): Promise<string[]> {
    if (this.busy) return [];
    this.busy = true;
    const started: string[] = [];
    try {
      for (const project of this.d.store.listProjects()) {
        try {
          this.withdraw(project);
          started.push(...(await this.add(project)));
        } catch (err) {
          this.say(`CI runners: ${project.name}: ${thrown(err).message}`);
        }
      }
      started.push(...(await this.remove()));
    } finally {
      this.busy = false;
    }
    return started;
  }

  /** The runner kinds a scheme needs; each registered on the connected PCs lending it CI that have none for its repo, best first (one job a scheme at a time: RunnerJobs). */
  private async add(project: Project): Promise<string[]> {
    const slug = repoSlug(project.repo_url)?.toLowerCase();
    if (!slug || !runnerLabel(project.name)) return [];
    const queued = new Set([...(this.d.queuedLabels().get(slug) ?? [])].flatMap((l) => osOfLabel(project.name, l) ?? []));
    const asked = askedIn(project.name, await (this.d.workflows ?? workflowTexts)(project));
    if (asked.size) this.asking.add(slug);
    else this.asking.delete(slug);
    const out: string[] = [];
    for (const os of OSES) {
      if (!queued.has(os) && !asked.has(os)) continue;
      const online = this.d.runnerMachines(os);
      const lending = online.filter((m) => lendsCi(this.d.store, m, project));
      const lacking = lending.filter((m) => !this.d.reposOn(m.id, os).has(slug));
      // Jobs wait, nothing connected serves the repo, and no PC lends it CI at all (one that does but is off or asleep will run them when it's back).
      if (queued.has(os) && !lending.length && !online.some((m) => this.d.reposOn(m.id, os).has(slug)) && !this.d.store.listMachines().some((m) => lendsCi(this.d.store, m, project))) {
        this.noMachine(project, os);
      }
      const ranked = rank(lacking.map((m) => ({ id: m.id, priority: m.priority ?? null, free: this.d.room(m.id) ?? 1, m })));
      for (const { m: pick } of ranked) {
        const key = `add:${project.id}:${os}:${pick.id}`;
        if ((this.next.get(key) ?? 0) > this.now()) continue;
        this.next.set(key, this.now() + RETRY_MS);
        try {
          await this.d.start(project, { op: 'add', count: 1, os, host: pick.name });
          out.push(`add ${project.name} ${os} on ${pick.name}`);
          return out;
        } catch (err) {
          const busy = err instanceof RunnerBusy;
          this.next.set(key, this.now() + (busy ? BUSY_MS : FAILED_MS));
          this.say(`CI runners: couldn't register ${project.name}'s ${os} runner on ${pick.name}: ${thrown(err).message}`);
          if (busy) break;
        }
      }
    }
    return out;
  }

  /** Runners on one PC's row (a runner agent joined it; a CI runner host's row is one since Build 10 H6) for a scheme its CI no longer lends to come off. */
  private async remove(): Promise<string[]> {
    const out: string[] = [];
    const projects = this.d.store.listProjects();
    for (const os of OSES) {
      for (const m of this.d.runnerMachines(os)) {
        const ci = this.d.store.machineRoles(m.id).find((r) => r.role === 'ci');
        if (!ci?.on || !ci.setup?.runner_agent) continue;
        for (const repo of this.d.reposOn(m.id, os)) {
          const project = projects.find((p) => repoSlug(p.repo_url)?.toLowerCase() === repo);
          if (!project || lendsCi(this.d.store, m, project)) continue;
          const key = `remove:${project.id}:${os}:${m.id}`;
          if ((this.next.get(key) ?? 0) > this.now()) continue;
          this.next.set(key, this.now() + RETRY_MS);
          try {
            await this.d.start(project, { op: 'remove', count: null, os, host: m.name });
            out.push(`remove ${project.name} ${os} on ${m.name}`);
          } catch (err) {
            this.next.set(key, this.now() + (err instanceof RunnerBusy ? BUSY_MS : FAILED_MS));
            this.say(`CI runners: couldn't take ${project.name}'s ${os} runners off ${m.name}: ${thrown(err).message}`);
          }
        }
      }
    }
    return out;
  }

  /**
   * An unanswered no-machine card whose question no longer holds comes down (#2220: one sat 8 hours after the scheme was
   * ticked, and its person answered a stale question). Only on a PC lending the scheme CI or serving its repo: an empty
   * queue read (a restart, a cancelled job) proves nothing. Found by its words, so cards posted before this count too.
   */
  private withdraw(project: Project) {
    const { store } = this.d;
    const slug = repoSlug(project.repo_url)?.toLowerCase();
    const taskmaster = store.getOverlord(project.id);
    if (!slug || !taskmaster) return;
    for (const e of store.openCardsOf(taskmaster.id)) {
      if (e.kind !== 'question') continue;
      const card = JSON.parse(e.data) as { id: string; questions?: CardQuestion[] };
      const [q, more] = card.questions ?? [];
      if (more || q?.header !== CARD_HEADER || !q.question.startsWith(waiting(project))) continue;
      const os: Os = q.question.startsWith(`${waiting(project)}Linux`) ? 'linux' : 'windows';
      const lent = store.listMachines().find((m) => lendsCi(store, m, project));
      const serving = lent ? undefined : this.d.runnerMachines(os).find((m) => this.d.reposOn(m.id, os).has(slug));
      const pc = lent ?? serving;
      if (!pc) continue;
      this.d.settle({ ticket: taskmaster.id, question: card.id }, `Withdrew the CI runners card: ${pc.name} ${lent ? `now lends ${project.name} its CI runners` : `has a runner for ${project.name}`}, so there's nothing to answer.`);
      // Unticked again while jobs wait, that's news: ask at once, not after CARD_MS. Not for a PC only still holding a
      // runner (CI off there): it would bring a new card each time it slept.
      if (lent) store.deleteSetting(cardKey(project));
    }
  }

  /** Jobs wait and no PC lends CI here: one card, again only after CARD_MS (kept in settings, so a restart doesn't repeat it). */
  private noMachine(project: Project, os: Os) {
    const key = cardKey(project);
    const at = this.d.store.getSetting<number>(key);
    if (at !== null && this.now() - at < CARD_MS) return;
    this.d.store.setSetting(key, this.now());
    const could = this.d.store.listMachines().filter((m) => !!this.d.store.machineRoles(m.id).find((r) => r.role === 'ci' && (r.on || r.setup?.runner_agent)) && !lendsCi(this.d.store, m, project));
    this.d.card(project, os, could);
  }
}

const CARD_HEADER = 'CI runners';
/** When the scheme's no-machine card last went up, in settings. */
const cardKey = (project: Project) => `ci_auto_card:${project.id}`;
/** How the no-machine card's question begins, up to the runner's kind: how an open one is found again. */
const waiting = (project: Project) => `${project.name}'s CI jobs are waiting for a `;

/** The no-machine card's one question, for the scheme's members (in its Taskmaster's chat): the PCs they could ask to be lent, by whose they are. */
export function noMachineCard(store: Store, project: Project, os: Os, could: Machine[]): CardQuestion {
  const kind = os === 'linux' ? 'Linux' : 'Windows';
  const whose = (m: Machine) => store.getUser(m.owner_id ?? -1)?.name ?? 'its owner';
  const asks = could.slice(0, 3).map((m) => ({
    label: `Ask ${whose(m)} to lend ${m.name}`.slice(0, 80),
    description: `${m.name} runs CI for other schemes. Once ${project.name} is ticked under its CI runners, it gets a runner by itself.`,
  }));
  return {
    header: CARD_HEADER,
    question: could.length
      ? `${waiting(project)}${kind} runner, and no computer lends its CI runners to ${project.name}. ${could.length === 1 ? 'One computer could' : `${could.length} computers could`}: ${could.map((m) => `${m.name} (${whose(m)}'s)`).join(', ')}. What do you want to do?`
      : `${waiting(project)}${kind} runner, and no computer hosts CI runners yet. A member can connect one (Machines, Connect a computer) and switch its CI runners on; ${project.name} then gets a runner by itself. What do you want to do?`,
    options: [...(asks.length ? asks : [{ label: "I'll connect a computer", description: 'Connect it on the Machines page and switch on its CI runners.' }]), { label: 'Leave the jobs waiting', description: 'Nothing changes; they run once a computer lends CI here.' }],
  };
}
