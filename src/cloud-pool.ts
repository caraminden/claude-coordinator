// Cloud sessions as one more place in the worker pool (#2153; Josh, 2026-11-26: "This should be in build 7, essentially these
// are just another class of worker in the worker pool"). A Claude Code cloud session runs a minion's job in Anthropic's VM on
// its sender's own login, so it frees a perigee worker and its ~250 MB (#2147's trial, reports/cloud-batch-poc-2026-11-26.md).
//
// Which jobs, and where they stand in the line:
//   - every research and ideation minion create_ticket or a card's pick starts (Cara, 2026-11-26, on #2153's card: "Every
//     research and ideation minion"; Josh, same day, on card starts: "Same rules as the rest"), but one it keeps home
//     (`cloud: false`, or a brief staysHome keeps: it needs the shared folder, Citadel's tools or its database, which a
//     session lacks, or builds Android; a card's handoff goes as its text, handoffBrief), and a self-contained test sweep
//     marked for the cloud (CLOUD_KINDS). A schedule's start stays home: its run files itself away with Citadel's tools;
//   - the cloud first, though perigee has room (Cara, same answer: "Anything that can go to the cloud with no loss of value
//     should prioritize running there"; src/turn-line.ts); a first turn whose message carries pictures or files stays home;
//   - a job whose longest single step runs over CLOUD.stepMinutes is refused: a cloud session stops one background command at
//     30 minutes, not the session (Cara, 2026-11-26: "I feel like even medium jobs could be moved right? 30m isn't THAT short");
//   - no cap of ours on sessions at once, a day or by weekly plan use (Josh, 2026-11-26: "we shouldnt be adding any limits,
//     we should get any value we can out of cloud sessions"); Anthropic documents none either;
//   - never a Taskmaster's turn, the Overlord's or a ship's: only a minion's ordinary turns are ever placed (the line and
//     src/runner.ts startPlace), and land.sh's CI gate is not a turn at all.
// Once a minion's first turn ran in the cloud its session is kept on it (`cloud-session:<id>`), and every later turn of it is a
// follow-up to that session (src/cloud-turn.mjs), on the same person's login: sender pays, never another person's.
import type { Store } from './db.ts';
import { githubRepo } from './github.ts';

/** The line's place for the cloud: perigee is 0, a connected machine its id. */
export const CLOUD_PLACE = -1;

export const CLOUD = {
  /** The longest single step a job may have: the VM stops one background command at 30 minutes (#2147). */
  stepMinutes: 25,
  /** How long a turn waits for its session's result before reading it back through teleport: a session may run several steps. */
  turnMinutes: 90,
  /** How often the driver looks for the session's branch. */
  pollMs: 20_000,
  /**
   * What a cloud turn is counted as costing, in dollars: an estimate, since the session runs on its sender's plan and its tokens
   * never reach Citadel. From #2147's trial (reports/cloud-batch-poc-2026-11-26.md, note 3): ~$0.35–0.45 for a session's first
   * 20 minutes, ~$0.02–0.25 a later step.
   */
  costUsd: { start: 0.4, followUp: 0.1 },
  /** How long a pty start may take before it gives up (first runs answer onboarding screens: 55 s in the trial). */
  startMs: 180_000,
  /** A session with no push for this long is read back for a question open in it (#2191). */
  idleMs: 8 * 60_000,
};

/**
 * The admin switch for every scheme's cloud sessions (#2193; Cara, 2026-11-26: "Lets turn off cloud sessions until we figure this
 * out": a session can't have a back-and-forth with people). Off unless an admin set it true; a session already running keeps its
 * follow-ups (CloudPool.bound in the runner), and saved marks wait for it.
 */
export const CLOUD_SWITCH = 'cloud-sessions';
export const CLOUD_OFF = 'cloud sessions are off for every scheme (the admin switch on the Citadel-wide settings page), so it runs at perigee';

/** The minion types that go to the cloud with no mark. */
export const CLOUD_TYPES: readonly string[] = ['research', 'ideation'];

/** A brief that builds Android stays home: a session's default Limited network blocks dl.google.com, the SDK and Google's Maven
 * (#2154; Josh, 2026-11-26: "No, record it as a no"). */
const ANDROID_BRIEF = /\b(gradlew?|apks?|android sdk|assemble(debug|release)|cap (build|sync|run) android|android (app|build|emulator|instrumented|tests?)|(build|run|test)(s|ing)? (the |an? |its )?android|emulator)\b/i;

/** A brief that names Citadel's own tools or database stays home: a session has neither. */
const CITADEL_BRIEF = /\b(list_tickets|read_minion|read_ticket|search_minions|search_decisions|search_memory|message_coordinator|message_minion|message_taskmaster|create_ticket|hand_off_land|close_self|set_thread_status|propose_plan|review_set|list_schedules|host_check|sqlite3|coordinator\.db)\b/i;

/** Whether create_ticket keeps a brief home: it needs the shared folder (by its path, or by name), which a session can't read, or builds Android. */
export function staysHome(brief: string, sharedDir: string): boolean {
  // A card start's pointer to its handoff is no need when the handoff's text comes with it: only that text is judged.
  const at = brief.indexOf(HANDOFF_TEXT);
  const own = at < 0 ? brief : brief.slice(at + HANDOFF_TEXT.length);
  return own.includes(sharedDir) || /\bshared\/project\b|\bshared (folder|dir(ectory)?|project( folder)?)\b/i.test(own) || ANDROID_BRIEF.test(own) || CITADEL_BRIEF.test(own);
}

const HANDOFF_TEXT = "\n\nThe handoff as it reads now, for a cloud session, which can't open the shared folder:\n\n";

/** A card start's brief (src/card-starts.ts): the pointer to its handoff, and the handoff's text too when a session may take it, by
 * the same rule as any start (Josh, 2026-11-26: "Same rules as the rest"; "We should off load any and everything to the cloud
 * that we can do without loss of value"). The pointer stays first: the duplicate check, ideas and the handoff tidy read it. */
export function handoffBrief(pointer: string, text: string, type: unknown, sharedDir: string): string {
  const go = CLOUD_TYPES.includes(typeof type === 'string' ? type : '') && !staysHome(text, sharedDir) && pointer.length + text.length < 90_000;
  return go ? `${pointer}${HANDOFF_TEXT}${text}` : pointer;
}

/** What a cloud turn's result says it cost (src/cloud-turn.mjs's `cloud_cost_usd`, an estimate), or null: not one, or not a sane number. */
export function cloudSpend(ev: object): number | null {
  const v = (ev as { cloud_cost_usd?: unknown }).cloud_cost_usd;
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 5 ? v : null;
}

/** What may be marked for the cloud: the job kinds #2147 proved. */
export const CLOUD_KINDS = ['research', 'ideation', 'sweep'] as const;
export type CloudKind = (typeof CLOUD_KINDS)[number];

/** A minion's mark that it may run as a cloud session: what kind of job, and how long it should take. */
export interface CloudMark {
  kind: CloudKind;
  minutes: number;
  by: string;
  at: number;
}

/** A minion's cloud session: started on `person`'s login and `account`; its last turn's result comes back on `branch`. `sha`: the last result read. */
export interface CloudSession {
  session: string;
  url: string | null;
  branch: string;
  person: number;
  /** The Claude account it was started on: its follow-ups run there and nowhere else, as the session lives on it. */
  account: number | null;
  sha: string | null;
  at: number;
}

export const markKey = (ticketId: number) => `cloud-mark:${ticketId}`;
export const sessionKey = (ticketId: number) => `cloud-session:${ticketId}`;
const goKey = (ticketId: number) => `cloud-go:${ticketId}`;

/** A cloud result branch for one turn of a minion's session: `cloud/<id>`, its id the minion's and when the turn started. */
export const cloudBranch = (ticketId: number, now: number) => `cloud/t${ticketId}-${now.toString(36)}`;

/** Why a mark can't be set, or null. Its scheme's repo having a GitHub origin is checked where it is set (routes): the session clones and pushes there. */
export function markRefusal(kind: unknown, minutes: unknown): string | null {
  if (typeof kind !== 'string' || !(CLOUD_KINDS as readonly string[]).includes(kind)) return `cloud kind must be one of ${CLOUD_KINDS.join(', ')}`;
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0) return 'cloud minutes must be a positive number: how long its longest single step should take';
  if (minutes > CLOUD.stepMinutes) return `a cloud session stops a background command at 30 minutes, so a job with a step over ${CLOUD.stepMinutes} minutes is refused for the cloud: this one's is ${minutes}`;
  return null;
}

export interface StartIn {
  mark: CloudMark | null;
  /** create_ticket let this research or ideation minion go: it started it, and its brief names nothing a session lacks. */
  go: boolean;
  /** Its scheme's repo is on GitHub, where a session clones it from. */
  github: boolean;
  /** The minion's `type` property. */
  type: string | null;
  /** It has run a turn before, on perigee or a machine: its conversation is there, so it stays. */
  ran: boolean;
}

/** create_ticket's `cloud` for a minion of `type` in a scheme whose repo is `repoUrl`, its brief `brief`: the mark,
 * `go` for a research or ideation minion let go with none, null to keep it home, or why the mark can't be. */
export function newMark(repoUrl: string | null, cloud: unknown, type: unknown, brief: string, sharedDir: string): string | null | { go: true } | { kind: CloudKind; minutes: number } {
  if (cloud === false) return null;
  if (cloud == null) return CLOUD_TYPES.includes(typeof type === 'string' ? type : '') && !staysHome(brief, sharedDir) ? { go: true } : null;
  if (ANDROID_BRIEF.test(brief)) return "a brief that builds Android can't run as a cloud session: its network blocks dl.google.com (the SDK and Google's Maven); leave out cloud";
  const c = (cloud && typeof cloud === 'object' ? cloud : {}) as Partial<Record<'kind' | 'minutes', unknown>>;
  const refused = markRefusal(c.kind, c.minutes);
  if (refused) return refused;
  const kind = c.kind as CloudKind;
  if (kind !== 'sweep' && type !== kind) return `cloud kind ${kind} is for a minion of type ${kind}; this one's type is ${typeof type === 'string' ? type : 'unset'} (a test sweep is kind sweep)`;
  if (!githubRepo(repoUrl ?? '')) return "a cloud session clones the scheme's repo from GitHub, and this scheme's repo isn't on GitHub";
  return { kind, minutes: c.minutes as number };
}

/** Why a minion's first turn can't start as a cloud session now, or null: it may. */
export function startBlock(i: StartIn): string | null {
  if (!i.mark && !CLOUD_TYPES.includes(i.type ?? '')) return 'not a research or ideation minion, nor marked for the cloud';
  if (!i.mark && !i.go) return 'kept at perigee: its brief needs the shared folder or Citadel, or create_ticket kept it home';
  if (i.ran) return 'it has run here before';
  if (i.mark) {
    const refused = markRefusal(i.mark.kind, i.mark.minutes);
    if (refused) return refused;
    if (i.mark.kind !== 'sweep' && i.type !== i.mark.kind) return `marked ${i.mark.kind} but its type is ${i.type ?? 'unset'}`;
  }
  if (!i.github) return "its scheme's repo isn't on GitHub, where a cloud session clones it";
  return null;
}

/** The cloud pool's saved state: marks and sessions. */
export class CloudPool {
  private store: Pick<Store, 'getSetting' | 'setSetting' | 'deleteSetting'>;

  constructor(store: Pick<Store, 'getSetting' | 'setSetting' | 'deleteSetting'>) {
    this.store = store;
  }

  /** The admin switch (CLOUD_SWITCH): whether a new cloud session may start at all. */
  on(): boolean {
    return this.store.getSetting<boolean>(CLOUD_SWITCH) === true;
  }

  mark(ticketId: number): CloudMark | null {
    return this.store.getSetting<CloudMark>(markKey(ticketId)) ?? null;
  }

  /** Mark a minion for the cloud (a test sweep, or a research or ideation one with its step time), or clear it with null; returns why it can't be, or null. */
  setMark(ticketId: number, mark: Omit<CloudMark, 'at'> | null, now = Date.now()): string | null {
    if (!mark) {
      this.store.deleteSetting(markKey(ticketId));
      return null;
    }
    const refused = markRefusal(mark.kind, mark.minutes);
    if (refused) return refused;
    this.store.setSetting(markKey(ticketId), { ...mark, at: now });
    return null;
  }

  /** What create_ticket decided (newMark): a mark kept, or a research or ideation minion let go. */
  made(ticketId: number, cloud: { go: true } | { kind: CloudKind; minutes: number }, by: string) {
    if ('go' in cloud) this.store.setSetting(goKey(ticketId), true);
    else this.setMark(ticketId, { ...cloud, by });
  }

  /** Whether the cloud may take it at all, before anything costlier is asked: marked, or let go and still of a type that goes. */
  may(ticketId: number, type: string | null): boolean {
    return this.on() && (!!this.mark(ticketId) || (!!this.store.getSetting<boolean>(goKey(ticketId)) && CLOUD_TYPES.includes(type ?? '')));
  }

  session(ticketId: number): CloudSession | null {
    return this.store.getSetting<CloudSession>(sessionKey(ticketId)) ?? null;
  }

  /** Keep a minion's session, or what changed of it (the last result read). */
  setSession(ticketId: number, s: CloudSession) {
    this.store.setSetting(sessionKey(ticketId), s);
  }

  /** Why `ticketId`'s first turn can't start as a cloud session now, or null. */
  takes(ticketId: number, i: Pick<StartIn, 'type' | 'ran'> & { repoUrl: string | null }): string | null {
    if (!this.on()) return CLOUD_OFF;
    return startBlock({ ...i, github: !!githubRepo(i.repoUrl ?? ''), mark: this.mark(ticketId), go: !!this.store.getSetting<boolean>(goKey(ticketId)) });
  }

  /**
   * What the driver's stream says of the session (src/cloud-turn.mjs, a `system` event of subtype `cloud`): kept on the
   * minion. The stream is a turn's output, so only what looks like an id and a result branch is kept.
   */
  heard(ticketId: number, person: number, account: number | null, ev: object, now = Date.now()) {
    const { session, url, branch, sha } = ev as Partial<Record<'session' | 'url' | 'branch' | 'sha', unknown>>;
    const ok = (v: unknown, re: RegExp): v is string => typeof v === 'string' && re.test(v);
    const was = this.session(ticketId);
    // The driver gave up on it (a follow-up refused): forgotten, so the minion's next turn runs at perigee, not bound to it.
    if ((ev as { gone?: unknown }).gone === true) {
      if (was && was.session === session) this.store.deleteSetting(sessionKey(ticketId));
      return;
    }
    if (!ok(session, /^session_[A-Za-z0-9_-]{8,100}$/) || !ok(branch, /^cloud\/[A-Za-z0-9_-]{1,80}$/)) return;
    const same = was?.session === session;
    this.setSession(ticketId, {
      session: session,
      url: ok(url, /^https:\/\/claude\.ai\/code\/session_[A-Za-z0-9_-]+$/) ? url : same ? (was?.url ?? null) : null,
      branch: branch,
      person: same ? was!.person : person,
      account: same ? was!.account : account,
      sha: ok(sha, /^[0-9a-f]{40,64}$/) ? sha : same ? (was?.sha ?? null) : null,
      at: same ? was!.at : now,
    });
  }

  /** A cloud turn's job for src/cloud-turn.mjs: a new session from the minion's messages, or a follow-up to the one it has. */
  job(t: { id: number; number: number | null; cwd: string }, batch: { author: string; text: string; images?: unknown[]; files?: unknown[] }[], claude: string, files: string | null, now: number, run: { model?: string | null; effort?: string | null } = {}) {
    const s = this.session(t.id);
    const branch = cloudBranch(t.id, now);
    // shortcut: pictures and attached files aren't sent to a session, only the words (a first turn carrying them stays home, the
    // runner's cloudAsk); a follow-up says so, so the session can ask. Send them as links if a cloud job comes to need them.
    const left = (m: (typeof batch)[number]) => (m.images?.length ?? 0) + (m.files?.length ?? 0);
    const messages = batch.map((m) => `[${m.author}]: ${m.text}${left(m) ? `\n(${left(m)} picture(s) or file(s) came with this in Citadel's chat; you can't see them, so say so if the job needs them.)` : ''}`).join('\n\n');
    const text = cloudPrompt({ ticket: t.number ?? t.id, branch, minutes: this.mark(t.id)?.minutes ?? null, first: !s, messages });
    const cost = s ? CLOUD.costUsd.followUp : CLOUD.costUsd.start;
    return { claude, cwd: t.cwd, branch, last: s?.branch ?? null, session: s?.session ?? null, sha: s?.sha ?? null, text, files, model: run.model ?? null, effort: run.effort ?? null, cost, limitMs: CLOUD.turnMinutes * 60_000, idleMs: CLOUD.idleMs, pollMs: CLOUD.pollMs, startMs: CLOUD.startMs };
  }
}

/** How a session sends its result home: the first message's instructions, after the minion's own messages. */
export function cloudPrompt(o: { ticket: number; branch: string; minutes: number | null; first: boolean; messages: string }): string {
  const how = [
    `Send your result home this way (Citadel reads it off the branch; nobody reads this session):`,
    `1. Write \`.citadel/result.json\`: {"reply": "<markdown for the chat>", "card": null, "files": []}.`,
    `   - "files": report or other files you made, put under \`.citadel/out/\` and listed by that path; people see them.`,
    `   - "card": when you need a person's decision, {"questions": [{"question": "...?", "header": "<24 chars>", "options": [{"label": "...", "description": "...", "recommended": true}, {"label": "...", "description": "..."}], "multiSelect": false}]} (2 to 4 options, exactly one recommended), then stop: the answer comes back as your next message here.`,
    `   - Never use AskUserQuestion or anything else that waits on a person in this session: nobody sees it there. Put the question in "card" and stop.`,
    `2. Commit them and push: \`git push origin HEAD:refs/heads/${o.branch}\`. Push once for each result.`,
    `3. If the push fails, print the same JSON between a line \`CITADEL-RESULT-BEGIN\` and a line \`CITADEL-RESULT-END\` as your last message.`,
  ].join('\n');
  if (!o.first) return `${o.messages}\n\n---\n${how}`;
  return [
    `You are minion #${o.ticket}'s cloud session: Citadel (a web app that runs Claude Code sessions as workers) sent this job here. You have the repo and the web; you don't have Citadel's tools, its shared folder, its database or its server's files.`,
    `Run each long command (a build, a test run) in the foreground and keep it under ${CLOUD.stepMinutes} minutes, splitting a longer one into steps: the session stops a background command at 30 minutes, and a job still running when you stop dies.${o.minutes ? ` This job's longest step should take about ${o.minutes} minutes.` : ''}`,
    `The job:\n\n${o.messages}`,
    `---\n${how}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}
