// A flake fix has to prove it held (#1120, idea S5). Three jobs, run every few minutes by server.ts:
//  1. Count every flake line the retro log holds (shared/retro-log/<day>/land.md), not only the ones a land's own output named:
//     the table held 4 rows against about 98 log lines in 9 days, because a minion's own test runs and a deploy's never reach it.
//  2. The third sighting of one test file inside 7 days starts one bug minion for it. A file whose fix was held and then flaked
//     again is reopened (a new minion at once: it was fixed once already).
//  3. A fix is held only once the flake-proof workflow (50 runs of the file, 5 batches of 10 copies at once, on the desktop runner) is green on the fix
//     minion's branch; the Test health tab shows the clean runs so far.
// No test is skipped or quarantined (Cara, 2026-11-10: "Keep failing, log it").
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pacificStamp } from './pacific.ts';
import type { Job, Run } from './ci-health.ts';
import type { FlakeFix, Project, Store } from './db.ts';
import { classifyFlake } from './flake-evidence.ts';
import { ALARM_QUIET_MS, ALARM_WINDOW_MS, FLAKE_REPEAT, sameFlake, suspectCommits, fileChangedAt, FLAKE_REPEAT_MS, FLAKE_WINDOW_MS, cleanRuns, flakeBrief, parseRetroFlakes } from './flakes.ts';

/** A log line within this of a counted sighting of the same file is that sighting: a land counts at its end, the log at the flake. */
/** Minions one scheme's pass starts at most. */
const MAX_STARTS_PER_PASS = 2;
/** Evidence is read from CI for at most this many sightings per pass, none older than this (their runs have rolled off the branch's list). */
const MAX_EVIDENCE_PER_PASS = 10;
const EVIDENCE_MAX_AGE_MS = 6 * 3_600_000;
const SAME_SIGHTING_MS = 30 * 60_000;

export interface FlakeFixDeps {
  store: Store;
  /** The scheme's shared folder, where retro-log/ is; null for a scheme with none. */
  sharedDir: (projectId: number) => string | null;
  /** Start the fix minion (server.ts's newMinion and its first message); its id. */
  start: (project: Project, brief: { title: string; message: string }) => Promise<{ id: number }>;
  /** The flake-proof workflow's runs on a branch, and a run's jobs (CiHealth.workflowRuns and runJobs); null when GitHub won't say. */
  runs: (project: Project, branch: string) => Promise<Run[] | null>;
  jobs: (project: Project, run: Run) => Promise<Job[] | null>;
  /** When the test file last changed on main (ms; default: git log in the scheme's repo). Sightings before it don't count toward a new fix (#1219). */
  changedAt?: (project: Project, file: string) => Promise<number | null>;
  /** Wake the scheme's Taskmaster with the same-flake alarm (#1245); true once the send went through. */
  wake?: (project: Project, text: string) => boolean;
  /** The commits most likely to have brought the flake (default: git in the scheme's repo). */
  suspect?: (project: Project, file: string, firstAt: number) => Promise<string | null>;
  /** The failing test's name and error from the CI run behind a flake line (#1438); null when the log can't say. server.ts reads the scheme's GitHub repo with gh; without it no row keeps one. */
  evidence?: (project: Project, branch: string, file: string, at: number) => Promise<{ name: string; message: string } | null>;
  now?: () => number;
}

export class FlakeFixes {
  private busy = false;
  private d: FlakeFixDeps;
  constructor(d: FlakeFixDeps) { this.d = d; }

  private evidence(p: Project, branch: string, file: string, at: number) {
    return this.d.evidence ? this.d.evidence(p, branch, file, at) : Promise.resolve(null);
  }

  /** Retro-log flake lines of the last 14 days that no counted sighting covers become flake_events rows; how many. */
  async ingest(project: Project, now: number): Promise<number> {
    const dir = this.d.sharedDir(project.id);
    if (!dir) return 0;
    const root = join(dir, 'retro-log');
    let days: string[];
    try { days = readdirSync(root).filter((n) => /^\d{4}-\d\d-\d\d$/.test(n)).sort(); } catch { return 0; }
    const since = now - FLAKE_WINDOW_MS;
    const fresh: { file: string; at: number; source: string; branch?: string }[] = [];
    for (const day of days) {
      if (Date.parse(`${day}T23:59:59Z`) < since) continue;
      let md: string;
      try { md = readFileSync(join(root, day, 'land.md'), 'utf8'); } catch { continue; }
      for (const s of parseRetroFlakes(md, day)) {
        if (s.at >= since && s.at <= now + 60_000 && !this.d.store.hasFlakeNear(project.id, s.file, s.at, SAME_SIGHTING_MS)) fresh.push(s);
      }
    }
    // After the check, so two log lines of one file close together both count the first time.
    // The first pass after a deploy reads 14 days of lines: only a few hours' newest ones are looked up, a few per pass, so the alarm behind this isn't held. The rest keep no message.
    let looked = 0;
    for (const s of fresh) {
      // Only a CI run has a log the server can read; perigee's own runs and smoke lines keep no message. A failed read never holds the row back.
      const look = s.source === 'in CI' && s.branch && now - s.at < EVIDENCE_MAX_AGE_MS && looked++ < MAX_EVIDENCE_PER_PASS;
      const found = look ? await this.evidence(project, s.branch, s.file, s.at).catch(() => null) : null;
      this.d.store.addFlakeEvents(project.id, null, null, s.at, [{ file: s.file, source: s.source, detail: '', ...(found ? { testName: found.name, message: found.message, cls: classifyFlake(found.message) } : {}) }]);
    }
    return fresh.length;
  }

  /**
   * The same-flake alarm (#1245): a test file that passed alone on 3 different branches inside 30 minutes wakes the Taskmaster
   * once, naming the file, the branches and the commit that likely brought it, so a fix starts in minutes: Nov 19's review-set-api
   * went red 23 times in 2.5 hours. It reads the retro log's own lines (the branch is there; flake_events rows keep none), and
   * counts only sightings after the file's newest commit on main (#1219). One alarm per file until a day passes or the file changes on main.
   */
  async alarm(project: Project, now: number): Promise<number> {
    const dir = this.d.sharedDir(project.id);
    if (!dir || !this.d.wake) return 0;
    const root = join(dir, 'retro-log');
    let days: string[];
    try { days = readdirSync(root).filter((n) => /^\d{4}-\d\d-\d\d$/.test(n)).sort(); } catch { return 0; }
    const since = now - 2 * ALARM_QUIET_MS;
    const byFile = new Map<string, { at: number; branch?: string }[]>();
    for (const day of days) {
      if (Date.parse(`${day}T23:59:59Z`) < since) continue;
      let md: string;
      try { md = readFileSync(join(root, day, 'land.md'), 'utf8'); } catch { continue; }
      for (const s of parseRetroFlakes(md, day)) if (s.at >= since && s.at <= now) byFile.set(s.file, [...(byFile.get(s.file) ?? []), s]);
    }
    let woke = 0;
    for (const [file, all] of byFile) {
      const key = `flake-alarm:${project.id}:${file}`;
      const last = this.d.store.getSetting<number>(key) ?? 0;
      const changed = await (this.d.changedAt ?? ((p, f) => (p.repo_dir ? fileChangedAt(p.repo_dir, f) : Promise.resolve(null))))(project, file);
      if (last && now - last < ALARM_QUIET_MS && !(changed != null && changed > last)) continue;
      const sights = all.filter((s) => s.at > last && (changed == null || s.at > changed)).sort((a, b) => a.at - b.at);
      const hit = sameFlake(sights);
      if (!hit) continue;
      const commits = await (this.d.suspect ?? ((p, f, t) => (p.repo_dir ? suspectCommits(p.repo_dir, f, t) : Promise.resolve(null))))(project, file, hit.first);
      const text = `Same-flake alarm: ${file} failed in the full run and passed alone on ${hit.branches.length} different branches inside ${ALARM_WINDOW_MS / 60_000} minutes (${hit.branches.join(', ')}), the first at ${pacificStamp(hit.first)}. `
        + `That is a bug in the test or the code it tests, not load: every ship meanwhile pays a red run. ${commits ? `Likely cause: ${commits}. ` : ''}`
        + `Start a minion to fix it now (the Test health tab on the CI page has the button). It rings once for this file until a day passes or the file changes on main.`;
      if (this.d.wake(project, text)) { this.d.store.setSetting(key, now); woke++; }
    }
    return woke;
  }

  /** The Test health tab's and the escalation's rules; the minions it starts. */
  async escalate(project: Project, now: number): Promise<number> {
    const { store } = this.d;
    let started = 0;
    for (const file of store.flakeFiles(project.id, now - FLAKE_REPEAT_MS)) {
      if (started >= MAX_STARTS_PER_PASS) break; // the first pass after a deploy reads 14 days of log: the rest start on the next passes
      const fix = store.flakeFix(project.id, file);
      const sights = store.flakeSightings(project.id, file, now - FLAKE_REPEAT_MS);
      let id: number | null = null;
      // A live minion already on the file owns it, whatever its title or the fix row's state (#1373 started beside #1349 through the held branch).
      const base = file.split('/').pop()!;
      const open = (t: { kind: string; status: string }) => t.kind !== 'coordinator' && t.status !== 'closed';
      const own = fix?.ticket_id == null ? undefined : store.getTicket(fix.ticket_id);
      const owner = own && open(own) ? own : store.listTickets(project.id).find((t) => open(t) && [' ', '/', ':'].some((c) => t.title.includes(c + base)));
      if (fix && owner) continue;
      if (!fix) {
        if (sights.length < FLAKE_REPEAT) continue;
        // Sightings from before the file's newest commit were of the file as it was: a fix may already have shipped (#1189). Only newer ones count.
        const changed = await (this.d.changedAt ?? ((p, f) => (p.repo_dir ? fileChangedAt(p.repo_dir, f) : Promise.resolve(null))))(project, file);
        if (changed != null && sights.filter((t) => t > changed).length < FLAKE_REPEAT) continue;
        // A minion a person already started from the tab's button owns it: record the fix on that one, start no second.
        if (owner) { store.addFlakeFix(project.id, file, owner.id, now); continue; }
        id = store.addFlakeFix(project.id, file, null, now);
      } else if (fix.state === 'held') {
        if (!sights.some((t) => t > (fix.held_at ?? 0))) continue;
        store.updateFlakeFix(fix.id, { state: 'open', reopened: fix.reopened + 1, clean_runs: 0, held_at: null, proof_run: null, started_at: now, ticket_id: null });
        id = fix.id;
      } else {
        const t = fix.ticket_id == null ? undefined : store.getTicket(fix.ticket_id);
        const gone = !t || t.status === 'closed';
        // An open fix with no live minion starts another only on 3 new sightings since it began, or at once if its minion never started.
        if (!gone || (fix.ticket_id != null && sights.filter((x) => x > fix.started_at).length < FLAKE_REPEAT)) continue;
        store.updateFlakeFix(fix.id, { started_at: now, ticket_id: null, clean_runs: 0, proof_run: null });
        id = fix.id;
      }
      try {
        const count = store.flakeCounts(project.id, now - FLAKE_WINDOW_MS, 1000).find((f) => f.file === file)?.count ?? sights.length;
        const m = await this.d.start(project, flakeBrief(file, count, store.flakeDetails(project.id, file)));
        store.updateFlakeFix(id, { ticket_id: m.id });
        started++;
      } catch (err: any) {
        console.error(`Starting the fix of flaky ${file} failed; the next pass retries: ${err?.message ?? err}`);
      }
    }
    return started;
  }

  /** Each open fix's newest flake-proof run on its minion's branch: the clean runs so far, and held once the run is green. */
  async prove(project: Project, now: number): Promise<void> {
    const { store } = this.d;
    for (const fix of store.flakeFixes(project.id)) {
      if (fix.state !== 'open' || fix.ticket_id == null) continue;
      const branch = store.getTicket(fix.ticket_id)?.branch;
      if (!branch) continue;
      const runs = await this.d.runs(project, branch);
      const run = (runs ?? []).filter((r) => r.display_title === `flake-proof ${fix.file}` && Date.parse(r.created_at) >= fix.started_at)
        .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
      if (!run) continue;
      const jobs = await this.d.jobs(project, run);
      const steps = ((jobs ?? [])[0]?.steps ?? []) as { name?: string; conclusion?: string | null }[];
      const done = run.status === 'completed';
      const clean = cleanRuns(steps, done ? run.conclusion : null);
      if (done && run.conclusion === 'success') store.updateFlakeFix(fix.id, { state: 'held', clean_runs: clean, held_at: now, proof_run: run.id });
      else if (clean !== fix.clean_runs || fix.proof_run !== run.id) store.updateFlakeFix(fix.id, { clean_runs: clean, proof_run: run.id });
    }
  }

  /** Fix #1009 held machine-agent-jobs before it flaked again: recorded once, so its next sighting reopens it from the real log. */
  seedPast(project: Project) {
    const { store } = this.d;
    const key = 'flake-fixes:seeded-1009';
    if (store.getSetting<boolean>(key)) return;
    const t = store.listTickets(project.id).find((x) => x.number === 1009 && x.title === 'Fix the repeat flaky tests' && x.status === 'closed');
    store.setSetting(key, true);
    const file = 'test/machine-agent-jobs.test.ts';
    if (!t || !t.closed_at || store.flakeFix(project.id, file)) return;
    store.addFlakeFix(project.id, file, t.id, t.created_at, { state: 'held', clean_runs: 0, held_at: t.closed_at });
  }

  async tick(projects: Project[]): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const now = (this.d.now ?? Date.now)();
      for (const p of projects) {
        try {
          this.seedPast(p);
          await this.ingest(p, now);
          await this.alarm(p, now);
          await this.escalate(p, now);
          await this.prove(p, now);
        } catch (err: any) {
          console.error(`Flake fixes of ${p.name} failed: ${err?.message ?? err}`);
        }
      }
    } finally {
      this.busy = false;
    }
  }
}

