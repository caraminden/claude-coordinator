// The CI problems: what is wrong now, in words. Pure: no GitHub, no store.
import { lines } from './approvals.ts';
import type { Project } from './db.ts';
import { ciState } from './ci-verdict.ts';
import { pacific } from './pacific.ts';
import { quietUntil } from './alert-wakes.ts';
import type { Job, Run, Runner } from './ci-health.ts';
import { LONG_MINUTES, type LongJob } from './long-jobs.ts';

/** A job waiting this long on labels only offline runners serve rings. */
export const WAIT_MS = 10 * 60_000;
/** A runner on one job this long is probably hung. */
export const HUNG_MS = 2 * 3600_000;
/**
 * The wait (#1662, Cara 2026-11-22, "Keep 1 h"): a red on main with no minion naming its run this long after the Taskmaster
 * heard rings, and so does every problem that waits (`held`) still open this long after it opened.
 */
export const RED_FIX_MS = 3600_000;
// A land/** run still queued this long has no landing waiting on it (a gate gives up after minutes): GitHub lost it.
export const ORPHAN_MS = 3600_000;
/** The conclusions that say something of main: a run that couldn't start (startup_failure: a broken `uses:` or permissions) is red too; a cancelled one says nothing. */
export const VERDICTS = new Set(['success', 'failure', 'startup_failure', 'timed_out']);
export const redRun = (r: Pick<Run, 'status' | 'conclusion'>) => VERDICTS.has(r.conclusion ?? '') && ciState(r.status, r.conclusion) === 'fail';
const RAN = new Set(['success', 'failure']);

export interface Problem {
  key: string;
  /** What happened, starting "CI: ". */
  title: string;
  /** Why it happened, as far as Citadel can tell. */
  why?: string;
  /** What fixes it, and who. */
  fix?: string;
  /** The words a person reads in Mandate (#1659, Cara 2026-11-22: "which thing is broken and what is being done"): what is wrong in plain words, and what happens next; title, why and fix stay for the Taskmaster's wake and the CI page, which need the run numbers. */
  plain?: { what: string; next: string };
  /** Who is already on it, for the one alert's words (#1659): set as the alert is made, never kept. */
  onIt?: string;
  /** Informational: a plain item, never an alarm. */
  quiet?: boolean;
  /**
   * #1662 (Cara's pick, 2026-11-22: "After the wait, if nobody's on it"): quiet while its Taskmaster, woken at once, gets someone
   * on it; it rings at this time if it is still open. Set only while it waits.
   */
  held?: number;
  /** When it opened, for the "Broken now" list (#1662); kept across polls by ci-health. */
  since?: number;
  /** What it's shared by (`host:<computer>`, or `billing`): a problem touching several schemes wakes Citadel's Taskmaster once; one scheme's alone wakes that scheme's (#983). */
  shared?: string;
  /** The fix minion on it, once one names the run (#992). */
  fixMinion?: { number: number; closed: boolean };
  /** A red with no fix minion yet (#1078): when it starts ringing, and whether it already does. */
  noFix?: { ringsAt: number; late: boolean };
  /** The re-run that tests the fix minion's fix (#1078, from #1074's mark): the commit, its run once GitHub lists it, and where it stands. */
  rerun?: { sha: string; url?: string; state: 'running' | 'failed' | 'manual' };
  /** The fix minion as the list shows it (#1078), read live by the route for the page; never kept. */
  fixTicket?: Record<string, unknown>;
  /** Where a person goes for it (#992): the fix minion's chat, else the Taskmaster's, at the wake. Set by `snapshot`, never kept. */
  link?: ProblemLink;
}
export interface ProblemLink {
  kind: 'minion' | 'taskmaster';
  href: string;
  label: string;
  closed?: boolean;
}
/** Where each woken problem's wake landed: the Taskmaster's scheme and chat entry, by `<scheme>:<key>` (or the shared key). */
export type WakeAt = Record<string, { project: number; entry: number }>;

export const WAKE_AT = 'ci-health:wake-at';
/**
 * Where a person goes for an open problem (#992, Cara 2026-11-18): the minion fixing it (its chat, the number and title, and whether it has
 * closed with the red still open); else its Taskmaster's chat at the entry the wake became, or at the chat alone when none was recorded.
 * A shared problem's wake is under its shared key (`<key>#<scheme>` when one scheme's alone).
 */
export function problemLink(x: Problem, scheme: number, wakes: WakeAt, titleOf: (n: number) => string | undefined): ProblemLink {
  if (x.fixMinion) {
    const { number: n, closed } = x.fixMinion;
    return { kind: 'minion', href: `#/p/${scheme}/t/${n}`, label: `#${n} ${titleOf(n) ?? ''}`.trim(), closed };
  }
  const at = x.shared ? (wakes[`${x.shared}#${scheme}`] ?? wakes[x.shared]) : wakes[`${scheme}:${x.key}`];
  return at ? { kind: 'taskmaster', href: `#/p/${at.project}?e=${at.entry}`, label: "the Taskmaster's wake" } : { kind: 'taskmaster', href: `#/p/${scheme}`, label: 'the Taskmaster' };
}

export const WAKE_STEPS =
  "People's phones ring for this. Start a fix minion now and name this problem in its brief; if it needs a person (billing, a machine that's off, a runner), ask them with a card instead. If it's expected, add the workflow to the scheme's quiet CI workflows (set_project_settings quiet_workflows).";

/** `x` waiting from `since` (#1662): quiet and `held` until RED_FIX_MS after its Taskmaster can hear (2-9 AM Pacific counts from 9), its next step saying when it rings; then as it was. */
export function held(x: Problem, since: number, now: number): Problem {
  const ringsAt = (quietUntil(since) ?? since) + RED_FIX_MS;
  if (now >= ringsAt) return { ...x, since: x.since ?? since };
  const rings = `if it's still broken at ${clock(ringsAt)}, people's phones ring`;
  return { ...x, since: x.since ?? since, quiet: true, held: ringsAt, plain: x.plain && { ...x.plain, next: `${x.plain.next.replace(/\.$/, '')}; ${rings}` } };
}

export const cap = (s: string, n = 500) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
/**
 * What Mandate shows for a problem (#1659): the scheme and what is wrong in plain words, who is on it, what happens next. The run
 * is the CI page's link, not a number here. A problem with no `plain` keeps its itemText.
 */
export function humanText(scheme: string, x: Problem): string {
  if (!x.plain) return itemText(x, `${scheme}: ${x.title.replace(/^CI: /, '')}`);
  const end = (t: string) => t.replace(/\.$/, '');
  return cap([`${scheme}: ${end(x.plain.what)}`, x.onIt && end(x.onIt), end(x.plain.next)].filter(Boolean).join('. ') + '.');
}
/** A problem's words for an item: what, then why and the fix (Mandate keeps 500 characters). */
export const itemText = (x: Problem, lead = x.title) => cap([lead.replace(/\.$/, ''), x.onIt && `On it: ${x.onIt.replace(/\.$/, '')}`, x.why && `Why: ${x.why.replace(/\.$/, '')}`, x.fix && `Fix: ${x.fix.replace(/\.$/, '')}`].filter(Boolean).join('. ') + '.');

export const at = (s: string) => Date.parse(s);
export const short = (sha: string) => sha.slice(0, 7);
export const runUrl = (slug: string, r: Run) => `https://github.com/${slug}/actions/runs/${r.id}`;
/** A run's workflow file name, as a scheme's ci_quiet lists it. */
export const workflowFile = (r: Run) => (r.path ?? '').split('/').pop() || r.name;
/** citadel-heavy's workflow (#1160): a minion's own command, dispatched on the default branch, so never a verdict on it (#1254). */
export const HEAVY_WORKFLOW = 'citadel-heavy.yml';
export const quietWorkflow = (p: Project, r: Run) => workflowFile(r) === HEAVY_WORKFLOW || lines(p.ci_quiet).includes(workflowFile(r));
/** When dispatched runs started counting (#678), so the deploy that brought them told none from before. */
export const DISPATCH_SINCE = 'ci-health:dispatch-since';

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "Nov 5, 10:31 PST". Always dated: a title that dropped it for today would change at midnight and re-send the alert (#509). */
export const clock = pacific;

/** Keep `offline` (runner name → first seen offline) in step with the runner list, in place. */
export function trackOffline(runners: Runner[], offline: Record<string, number>, now: number): void {
  const names = new Set(runners.map((r) => r.name));
  for (const name of Object.keys(offline)) if (!names.has(name)) delete offline[name];
  for (const r of runners) {
    if (r.status !== 'offline') delete offline[r.name];
    else offline[r.name] ??= now;
  }
}

/** The repo's runners that can take a job: they carry every label it asks for (GitHub matches them case-blind). */
export function servers(runners: Runner[], j: Pick<Job, 'labels'>): Runner[] {
  const want = j.labels.map((l) => l.toLowerCase());
  return runners.filter((r) => want.every((l) => r.labels?.some((x) => x.name.toLowerCase() === l)));
}

/**
 * Work stuck on dead runners: jobs queued WAIT_MS or more whose labels only offline runners serve, per set of labels.
 * A queue behind busy online runners, or on GitHub's hosted runners (none of the repo's serve it), is the page's.
 */
export function stuckProblems(runners: Runner[], jobs: Job[], offline: Record<string, number>, now: number): Problem[] {
  const groups = new Map<string, Job[]>();
  for (const j of jobs) {
    if (j.status !== 'queued' || now - at(j.created_at) < WAIT_MS) continue;
    const can = servers(runners, j);
    if (can.length && can.every((r) => r.status === 'offline')) groups.set(labelsOf(j), [...(groups.get(labelsOf(j)) ?? []), j]);
  }
  return [...groups].map(([labels, waiting]) => {
    const can = servers(runners, waiting[0]);
    const names = can.map((r) => r.name);
    const host = sharedHost(names) ?? (names.length === 1 ? names[0].replace(/(-linux)?(-\d+)?$/i, '') : null);
    const down = Math.min(...can.map((r) => offline[r.name] ?? now));
    const since = Math.min(...waiting.map((j) => at(j.created_at)));
    return {
      key: `stuck:${labels}`,
      title: `CI: ${plural(waiting.length, 'job')} on ${labels} ${waiting.length === 1 ? 'has' : 'have'} waited for a runner since ${clock(since)}`,
      why: `every runner that serves ${labels} (${names.join(', ')}) is offline, since ${clock(down)}`,
      shared: `host:${computerOf(names)}`,
      plain: {
        what: `${plural(waiting.length, 'CI job')} can't start: ${host ? `${host} is offline` : `every runner for ${labels} is offline`} (since ${clock(down)})`,
        next: host ? `Turn on ${host} or restart its runner service; the jobs then start by themselves` : 'Bring one of those runners back online; the jobs then start by themselves',
      },
      fix: host ? `turn on ${host} or restart its runner service; once one is online the jobs start by themselves` : `bring one of those runners back online; the jobs start by themselves`,
    };
  });
}

/** The minutes a long job may run: its command's DEADLINE_MIN=<n> when it sets one, else LONG_MINUTES (the run's own time limit, 6 h). */
export function longDeadlineMs(l: Pick<LongJob, 'command'>): number {
  const m = /\bDEADLINE_MIN=(\d+)/.exec(l.command);
  return (m && Number(m[1]) > 0 ? Number(m[1]) : LONG_MINUTES) * 60_000;
}

/**
 * Runners on one job HUNG_MS or more: no job here runs that long, so it is probably hung. A planned long job (citadel-heavy
 * --long, `longs`) that is running keeps to its own deadline instead: quiet inside it, a hung problem naming it past it.
 * Either waits (#1662, `held`) from when it became hung: its Taskmaster first, people's phones RED_FIX_MS later.
 */
export function hungProblems(jobs: Job[], now: number, longs: Pick<LongJob, 'run_id' | 'state' | 'command' | 'started_at'>[] = []): Problem[] {
  const out: Problem[] = [];
  for (const j of jobs) {
    if (j.status !== 'in_progress' || !j.runner_name || !j.started_at || now - at(j.started_at) < HUNG_MS) continue;
    const long = j.run_id != null ? longs.find((l) => l.state === 'running' && l.run_id === j.run_id) : undefined;
    const next = 'Cancel that run on GitHub (the CI page links it), then restart the runner if it stays busy';
    const base = { key: `hung:${j.runner_name}`, fix: `cancel run ${j.run_id} on GitHub, then restart the runner if it stays busy` };
    if (!long) {
      out.push(
        held(
          {
            ...base,
            title: `CI: runner ${j.runner_name} has run ${j.name} (run ${j.run_id}) since ${clock(at(j.started_at))}`,
            plain: { what: `runner ${j.runner_name} has been busy on one job (${j.name}) since ${clock(at(j.started_at))}, over 2 hours, so it is probably hung and jobs queued for it wait`, next },
            why: 'over 2 h on one job is far past a normal run, so it is probably hung (a test waiting forever, or its PC asleep mid-job), and jobs queued for it wait',
          },
          at(j.started_at) + HUNG_MS,
          now,
        ),
      );
      continue;
    }
    const limit = longDeadlineMs(long);
    if (now - (long.started_at ?? at(j.started_at)) < limit) continue;
    out.push(
      held(
        {
          ...base,
          title: `CI: runner ${j.runner_name} has run ${j.name} (run ${j.run_id}), a long job, since ${clock(at(j.started_at))}, past its ${Math.round(limit / 60_000)} min deadline`,
          plain: { what: `runner ${j.runner_name} is still on a long job (${j.name}) past its ${Math.round(limit / 60_000)} minute deadline, so it is probably hung and jobs queued for it wait`, next },
          why: `a long job (citadel-heavy --long) is allowed ${Math.round(limit / 60_000)} min, and this one is still running, so it is probably hung, and jobs queued for it wait`,
        },
        (long.started_at ?? at(j.started_at)) + limit,
        now,
      ),
    );
  }
  return out;
}

/** A job that ended without starting: no steps ran and no runner took it (a billing block, or a runner that never came). */
export const neverStarted = (j: Job) => j.status === 'completed' && j.conclusion === 'failure' && !j.runner_name && !j.steps?.length;
export const labelsOf = (j: Job) => (j.labels.length ? j.labels.join(', ') : 'no labels');

/**
 * Jobs, per set of runs-on labels, that never started since the last one with those labels that did; the newest
 * dead job of each group is the one whose GitHub annotation says why.
 */
export function deadGroups(jobs: Job[]): { labels: string; dead: Job[] }[] {
  const groups = new Map<string, Job[]>();
  for (const j of [...jobs].sort((a, b) => at(a.created_at) - at(b.created_at))) {
    const key = labelsOf(j);
    if (neverStarted(j)) groups.set(key, [...(groups.get(key) ?? []), j]);
    else if (j.runner_name) groups.delete(key);
  }
  return [...groups].map(([labels, dead]) => ({ labels, dead }));
}

export function deadProblem(g: { labels: string; dead: Job[] }, reason: string | null): Problem {
  const n = g.dead.length;
  const billing = !!reason && /billing|spending limit|payment|budget/i.test(reason);
  return {
    key: `nostart:${g.labels}`,
    title: `CI: ${plural(n, 'job')} on ${g.labels} didn't start since ${clock(at(g.dead[0].created_at))}, so ${n === 1 ? "it isn't a test failure" : "they aren't test failures"}`,
    why: reason ? `GitHub says: "${cap(reason, 300)}"` : 'no runner took them and GitHub gave no reason',
    plain: {
      what: `${plural(n, 'CI job')} never started${billing ? ': the GitHub Actions bill or spending limit is blocking them' : ' (no runner took them), so this is not a test failure'} (since ${clock(at(g.dead[0].created_at))})`,
      next: billing ? "Raise the Actions spending limit or fix the payment in the repo owner's GitHub billing settings, then re-run them" : `Check that a runner for ${g.labels} is online, then re-run them`,
    },
    ...(billing ? { shared: 'billing' } : {}),
    fix: billing ? "raise the Actions spending limit or fix the payment in the repo owner's GitHub billing settings, then re-run them" : `check that a runner carries ${g.labels} and is online, then re-run them`,
  };
}

/**
 * Queued land/** runs older than ORPHAN_MS that no landing in the line waits on: not a run id a landing holds, nor a
 * branch of a landing's ticket (land/ticket/551-…), so a landing that hasn't read its run yet keeps it.
 */
export function orphanRuns(runs: Run[], line: Record<string, { name: string; run?: number | null; ciSince?: number; tests?: boolean; green?: boolean }>, now: number): Run[] {
  const held = Object.values(line);
  // A landing in its CI wait whose run we haven't read may be about to take any run of its commit (land.sh finds one by SHA, whatever its branch).
  if (held.some((l) => l.ciSince != null && !l.run && !l.tests && !l.green)) return [];
  return runs.filter((r) => r.status === 'queued' && r.head_branch.startsWith('land/') && now - at(r.created_at) >= ORPHAN_MS && !held.some((l) => l.run === r.id || (/^#(\d+)$/.test(l.name) && r.head_branch.includes(`/${l.name.slice(1)}-`))));
}

/** Where a failed job failed: "job › step". */
export const place = (job: Job) => {
  const step = (job.steps as { name?: string; conclusion?: string }[] | undefined)?.find((x) => x.conclusion === 'failure')?.name;
  return `${job.name}${step ? ` › ${step}` : ''}`;
};

/** A red on the default branch as kept until it's back to green: its first red run, when its Taskmaster heard, where it failed. */
export interface RedMark {
  run: number;
  at: string;
  told?: number;
  where?: string;
  /** The re-run of the workflow on main after its fix minion's fix went live (#1074), once Citadel has one. */
  rerun?: Rerun;
  /** #1491: the streak's later red runs on the branch (a fix minion may name one of them), newest last, at most 20. */
  runs?: number[];
  /** #1491: the first red run's failing tests, read once from its failed jobs' logs ([] when none named one): the fixer match and the Investigate brief. */
  failures?: { file: string; name: string; message: string }[];
  /** #1491: the minion credited as the fixer when none names the run: the first after the red whose shipped commit touched a failing test file. */
  fixer?: { ticket: number; sha: string; file: string };
  /** #1491: the workflow's file (tests.yml), for the Investigate brief. */
  file?: string;
  /** #1491 ("names the run anywhere in its chat"): minions whose chat names a run of the streak, and the newest event id read for them. */
  chat?: { ids: number[]; upTo: number };
  /** When the first red run made after the closed fix minion `fix` (its number) closed ended: its hour counts from here, however many reds follow. */
  after?: { fix: number; at: number };
  /** Minions whose re-run another minion's replaced (`rerun`): green frees those still waiting on theirs. */
  waited?: number[];
  /** The red run's name, for a workflow whose run name shows its inputs (flake-proof.yml): only runs of the same name are this red's. */
  title?: string;
}
/**
 * The run that tests a red's fix (#1074): `sha`, the default branch's tip holding the fix minion's work (its branch at
 * `tip`), seen at `at`; `run` once GitHub lists it. `dispatched`: Citadel started it (else a run already there, a push's).
 * `hosted`: the workflow runs on GitHub's own runners, so Citadel left it for a person (Actions minutes). `error`: the
 * dispatch GitHub refused, or lost twice. `failed`: it went red and the fix minion was woken. `inputs`: each run of the
 * workflow takes an input, so a person starts it. `resent`: when a dispatch GitHub never listed was sent again.
 */
export interface Rerun {
  ticket: number;
  sha: string;
  tip: string;
  at: number;
  run?: number;
  dispatched?: boolean;
  hosted?: boolean;
  inputs?: boolean;
  error?: string;
  failed?: boolean;
  resent?: number;
}
/** The minion fixing a red, and when it closed (null while open). */
export interface Fix {
  number: number;
  closedAt: number | null;
  /** #1491: credited by its shipped commit, not named: "shipped 768d6ce touching test/x.test.ts". */
  via?: string;
}

/**
 * A red on main (#968, Cara: "Quiet item, Taskmaster fixes"): a quiet item while a fix is on its way, ringing when none
 * started within RED_FIX_MS of the Taskmaster hearing, the newest verdict, made after the fix minion closed, is still
 * red RED_FIX_MS after it ended with no new minion on it (#1662), that minion closed RED_FIX_MS ago with no newer run, or the
 * fix shipped and only a person can start its re-run (#1662: hosted runners cost Actions minutes). `newest` is the workflow's newest verdict there; green, and there is nothing to say.
 */
export function redProblem(file: string, branch: string, mark: RedMark, newest: Run, fix: Fix | null, now: number, slug?: string): Problem | null {
  const red = redProblemOf(file, branch, mark, newest, fix, now, slug);
  if (!red) return red;
  const x = { ...red, since: at(mark.at) };
  if (!fix) {
    const ringsAt = (mark.told ?? now) + RED_FIX_MS;
    return { ...x, noFix: { ringsAt, late: now >= ringsAt } };
  }
  const re = mark.rerun;
  const rerun = fix.closedAt == null && re?.ticket != null ? { sha: short(re.sha), url: re.run && slug ? runUrl(slug, { id: re.run } as Run) : undefined, state: re.failed ? ('failed' as const) : re.hosted || re.inputs || re.error ? ('manual' as const) : ('running' as const) } : undefined;
  return { ...x, fixMinion: { number: fix.number, closed: fix.closedAt != null }, ...(rerun && { rerun }) };
}
export function redProblemOf(file: string, branch: string, mark: RedMark, newest: Run, fix: Fix | null, now: number, slug?: string): Problem | null {
  if (!redRun(newest)) return null;
  const told = mark.told ?? now;
  const key = `red:${newest.workflow_id}`;
  const what = `CI: ${file} failed on ${branch} (run ${mark.run}${mark.where ? `, at ${mark.where}` : ''})`;
  // Plain words (#1659): the workflow's name on GitHub, not its file, and where it failed; the run is the CI page's link.
  const red = `CI "${newest.name || file}" is failing on ${branch}${mark.where ? ` (${mark.where})` : ''}`;
  const quietIt = `mute ${newest.name || file} in the scheme's quiet CI workflows if the red is expected`;
  const re = mark.rerun;
  // #1074: the fix minion's fix is live and held open on the re-run of the workflow on the branch.
  if (fix && fix.closedAt == null && re?.ticket != null) {
    const n = `#${fix.number}`;
    const url = re.run && slug ? `: ${runUrl(slug, { id: re.run } as Run)}` : '';
    if (re.failed) {
      return {
        key,
        quiet: true,
        plain: { what: `${red}, and the re-run with #${fix.number}'s fix failed too`, next: `#${fix.number} has been woken to fix it again; Citadel re-runs it once the next fix is live` },
        title: `${what}, and re-run ${re.run} on ${short(re.sha)} failed too`,
        why: `run ${re.run} on ${short(re.sha)}, which has fix minion ${n}'s fix, failed${url}`,
        fix: `${n} was woken to fix it again; Citadel re-runs ${file} on ${branch} once its next fix is live`,
      };
    }
    // #1662 (Cara's pick: "At once"): only a person can start it, so it rings.
    if (re.hosted || re.inputs || re.error) {
      return {
        key,
        plain: { what: `${red}; #${fix.number}'s fix shipped but the tests need re-running by hand`, next: `${re.hosted ? "They run on GitHub's own runners, which cost Actions minutes, so Citadel doesn't start them. " : ''}Re-run them on ${branch} from the CI page; this clears when they pass` },
        title: `${what}: fix minion ${n} shipped; re-run ${file} on ${branch} by hand`,
        why: re.hosted ? `${file} runs on GitHub's own runners, which cost Actions minutes, so Citadel doesn't start it` : re.inputs ? `each ${file} run takes an input, so Citadel doesn't start it` : `Citadel's re-run didn't start: ${re.error}`,
        fix: `a person re-runs ${file} on ${branch}${re.hosted ? ' (it costs Actions minutes)' : ''}; this clears when it's green, and ${n} closes then`,
      };
    }
    return {
      key,
      quiet: true,
      plain: { what: `${red}; #${fix.number}'s fix shipped and is being re-tested`, next: `This clears when the re-run passes; if it fails, #${fix.number} is woken again` },
      title: `${what}: fix minion ${n} shipped; re-running on ${short(re.sha)}`,
      why: `${n}'s fix is on ${branch}, so ${re.dispatched ? `Citadel started ${file} there at ${clock(re.at)}` : `${file} runs on it`}${url || ' (the run shows here once GitHub lists it)'}`,
      fix: `this clears when that run is green, and ${n} closes then; if it's red, ${n} is woken`,
    };
  }
  // #1662 (Cara's pick: "After the wait, if nobody's on it"): its Taskmaster first; a new minion naming the run makes it the fix above.
  if (fix?.closedAt != null && at(newest.created_at) > fix.closedAt) {
    return held(
      {
        key,
        plain: { what: `${red}, and still is after #${fix.number} closed, so its fix didn't hold`, next: `Reopen #${fix.number} or start another fix minion; ${quietIt}` },
        title: `${what}, and is still red after fix minion #${fix.number} closed`,
        why: `run ${newest.id} on ${short(newest.head_sha)}, made after #${fix.number} closed at ${clock(fix.closedAt)}, failed too, so the fix didn't hold`,
        fix: `reopen #${fix.number} or start another fix minion naming run ${newest.id}; if it's CI itself (a runner, GitHub), add ${file} to the scheme's quiet CI workflows`,
      },
      // The first red after it closed, not the newest: reds that come more often than hourly would put the ring off for good.
      mark.after?.fix === fix.number ? mark.after.at : at(newest.updated_at ?? newest.created_at),
      now,
    );
  }
  // Closed an hour with no newer run: it landed nothing that ran CI, so main is still red with nobody on it.
  if (fix?.closedAt != null && now - fix.closedAt >= RED_FIX_MS) {
    return {
      key,
      plain: { what: `${red}, and an hour after #${fix.number} closed it hasn't gone green`, next: `Reopen #${fix.number} or start another fix minion; if a fix shipped, re-run the tests to check it` },
      title: `${what}, and is still red an hour after fix minion #${fix.number} closed`,
      why: `no ${file} run on ${branch} has gone green since #${fix.number} closed at ${clock(fix.closedAt)}`,
      fix: `reopen #${fix.number} or start another fix minion naming run ${mark.run}; if a fix shipped, re-run ${file} on ${branch} to check it`,
    };
  }
  if (fix) {
    return {
      key,
      quiet: true,
      plain: { what: `${red}${fix.closedAt == null ? '' : `; #${fix.number} closed and main is waiting on its next run`}`, next: 'This clears when it is green again' },
      title: `${what}: fix minion #${fix.number} ${fix.closedAt == null ? 'started' : 'closed, waiting on the next run'}`,
      why: `the newest ${file} verdict on ${branch} is red${fix.via ? `; #${fix.number} ${fix.via}` : ''}`,
      fix: `#${fix.number} is on it; this clears when ${file} is back to green`,
    };
  }
  const late = now - told >= RED_FIX_MS;
  return {
    key,
    quiet: !late,
    plain: late ? { what: `${red}, and no fix has been started`, next: `Ask the Taskmaster to start a fix minion, or ${quietIt}` } : { what: red, next: `If no fix minion has started by ${clock(told + RED_FIX_MS)}, this rings` },
    title: `${what}${late ? ': no fix minion started' : ''}`,
    why: late ? `its Taskmaster heard at ${clock(told)} and no minion naming run ${mark.run} has started since` : `the newest ${file} verdict on ${branch} is red; its Taskmaster heard at ${clock(told)}`,
    fix: late ? `ask the Taskmaster to start a fix minion naming run ${mark.run}, or add ${file} to the scheme's quiet CI workflows if the red is expected` : `the Taskmaster starts a fix minion naming run ${mark.run}; this rings at ${clock(told + RED_FIX_MS)} if none has`,
  };
}

/** #1491: a red's problem once a person's Investigate started minion #`n` for it, until the next poll's redProblem finds it by the run its title names. */
export function startedRed(x: Problem, n: number): Problem {
  const { noFix: _, rerun: __, ...rest } = x;
  return { ...rest, quiet: true, plain: x.plain && { what: x.plain.what, next: 'This clears when it is green again' }, title: x.title.replace(/(\(run [^)]*\)).*$/, `$1: fix minion #${n} started`), fixMinion: { number: n, closed: false }, fix: `#${n} is on it; this clears when the workflow is back to green` };
}

/** The newest two verdict runs of a workflow's runs on the default branch (newest first): the one to check, and the one before. */
export function verdictPair(runs: Run[]): [Run, Run] | null {
  const v = runs.filter((r) => r.status === 'completed' && RAN.has(r.conclusion ?? '')); // a run that couldn't start has no jobs to compare
  return v.length >= 2 && v[0].conclusion === 'success' ? [v[0], v[1]] : null;
}

/**
 * The jobs a green run skipped that ran (passed or failed) in the verdict before it: green that proves less than it
 * says. The CI page shows them (#968, Cara: "Page only"), as a docs-only land skips them on purpose.
 */
export function skippedJobs(latestJobs: Job[], beforeJobs: Job[]): string[] {
  const ran = new Set(beforeJobs.filter((j) => RAN.has(j.conclusion ?? '')).map((j) => j.name));
  return latestJobs.filter((j) => j.conclusion === 'skipped' && ran.has(j.name)).map((j) => j.name);
}

/** The schemes named, up to three, or counted. */
export const schemesText = (names: string[]) => (names.length > 3 ? `${names.length} schemes` : names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0]);

/** The computer a runner is on: its name without the -desktop, -2, -perf or -linux that add-runner appends. Schemes on one PC share it. */
export const computerOf = (names: string[]) => names.map((n) => n.replace(/(-(desktop|linux|perf|\d+))+$/i, '')).sort()[0];

/**
 * The PC a set of runners share, if they do: runner names are its computer name, with -2, -perf or -linux and the
 * like after it (tools/ci-runner/add-runner.*).
 */
export function sharedHost(names: string[]): string | null {
  if (names.length < 2) return null;
  const host = names.map((n) => n.replace(/(-linux)?(-\d+)?$/i, '')).sort((a, b) => a.length - b.length)[0];
  const h = host.toLowerCase();
  return names.every((n) => n.toLowerCase() === h || n.toLowerCase().startsWith(`${h}-`)) ? host : null;
}

/**
 * The one alert's words for every scheme's open problems: one in full (what, why, fix); several counted, then each in
 * turn, cut to Mandate's 500 characters. The CI page it links has them all.
 */
export function bundleTitle(open: { scheme: string; problem: Problem }[]): string {
  if (open.length === 1) return humanText(open[0].scheme, open[0].problem);
  const each = open.map((x) => humanText(x.scheme, x.problem).replace(/\.$/, ''));
  return cap(`CI: ${plural(open.length, 'problem')} in ${schemesText([...new Set(open.map((x) => x.scheme))])}. ${each.join('; ')}.`);
}
/** The CI page's address (#968), which every CI item links. */
export const ciPage = (projectId: number) => `/c/#/p/${projectId}/ci`;
/** Who the one alert comes from in Mandate: no scheme of its own, so a switch for CI health alone. */
export const CI_SENDER = { id: 0, name: 'CI health' };
export const BUNDLE_ITEM = 'ci.open';

/** A Mandate item key for a problem (Mandate allows A-Z a-z 0-9 . _ : - and 128 characters). */
export const itemKey = (key: string) => `ci.${key.replace(/[^A-Za-z0-9._:-]+/g, '_')}`.slice(0, 128);
