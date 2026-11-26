// Heavy CI jobs placed by Citadel (Build 7 M6c, #2120): an APK or desktop build, or citadel-heavy over CI, waits for its
// size to be free on a PC, and Citadel sends it there (Josh, 2026-11-25, "Q1 What a heavy job waits on: Its size to be
// free"; 2026-11-26 on #2120's card, "Citadel places every job" and "GitHub's run token").
//
// How it is sent: the job asks GitHub for one more label beside its usual ones, `citadel-heavy-<kind>` (apk, desktop,
// suite). No runner carries it by itself, so the job waits in GitHub's queue. Each look (ShipWatch's, every 15 s) Citadel
// sees it queued, asks the balancer (src/machine-balancer.ts) on the PCs that lend the scheme CI, in the owner's order
// (`rank()`), and once one has room puts the label on one idle runner there that has the job's other labels. GitHub
// gives that runner the job; Citadel takes the label off again at once, so the runner takes no second one. The job holds
// its size there until GitHub says it ended, its own last step says so (POST /api/heavy/done with its run token), or its
// lease ends: GitHub unreadable for LEASE_MS frees the room, so a vanished job never holds it for good.
//   - Placing (Josh's pick on #2120's second card, PLACE): the first PC in the owner's order with room takes it. With
//     none, it waits on the first, which starts no new minion turn meanwhile ("hold off on a build until the worker count
//     drops"); after HEAVY_WAIT_MS it starts there anyway, late. A job whose PC is no longer eligible waits on the next.
//   - No PC Citadel balances lends the scheme CI with a runner that has its labels (a runner-only row with no threads
//     reported, a runner on a PC Citadel doesn't know): the label goes at once to any online runner of the repo with its
//     labels, as before Citadel placed jobs.
//   - A label Citadel didn't hand out (one left by a restart) comes off a runner the first time its repo is looked at.
// Citadel down: queued heavy jobs wait for it, as Peek's capped builds do (src/runner-cap.ts). Perigee keeps its own
// rules (Josh, "Machines only for now"): only PCs with a balancer plan are placed on.
// Windows test runs aren't CI jobs: the PC's agent asks for them itself (agentAsk, from public/machine-agent.mjs), and
// they start late where they are after HEAVY_WAIT_MS, since a workspace's checkout is on that one PC.
import { HEAVY, rank, type MachineBalancer } from './machine-balancer.ts';
import { onHost, type Listed } from './ci-runner.ts';
import { thrown } from './thrown.ts';

/** The label a heavy job asks for, then its kind. */
export const HEAVY_LABEL = 'citadel-heavy-';
/** Threads each kind holds: the spec's (an APK or desktop build 8), and a full suite as a ship's run (6). An unknown kind counts as a build. */
export const HEAVY_SIZES: Record<string, number> = { apk: HEAVY.apk, desktop: HEAVY.desktop, suite: 6 };
const WHAT: Record<string, string> = { apk: 'APK build', desktop: 'desktop build', suite: 'citadel-heavy suite' };
/** A handed-out label no runner took in this long comes off, and the job is placed again. */
export const HAND_MS = 10 * 60_000;
/** A job GitHub can't be read for in this long is taken as gone, and its room freed. */
export const LEASE_MS = 10 * 60_000;
/** A Windows test run's lease: its agent asks again about every minute while it waits or runs. */
export const AGENT_LEASE_MS = 3 * 60_000;

/** The heavy label among a job's labels, and its kind; null for a job that asks for none. */
export function heavyKind(labels: readonly string[]): { label: string; kind: string } | null {
  const label = labels.map((l) => l.toLowerCase()).find((l) => l.startsWith(HEAVY_LABEL) && l.length > HEAVY_LABEL.length);
  return label ? { label, kind: label.slice(HEAVY_LABEL.length) } : null;
}

/** A job GitHub has queued that asks for a heavy label (ShipWatch's read of queued runs). */
export interface QueuedHeavy {
  /** owner/name, lowercase. */
  repo: string;
  /** The job's id on GitHub. */
  id: number;
  run: number;
  name: string;
  labels: string[];
}

/** A PC that lends the repo's scheme CI now. */
export interface PlaceMachine {
  id: number;
  name: string;
  priority: number | null;
  /** The hostnames its runner agents reported (Windows, and Linux in WSL): its runners' names start with one. */
  hosts: string[];
}

export interface HeavyDeps {
  balancer: Pick<MachineBalancer, 'ask' | 'release' | 'done' | 'current' | 'plan'>;
  /** The PCs that may take the repo's heavy jobs: CI on and lent to its scheme, its runner agent connected, a balancer plan there. */
  machines(repo: string): PlaceMachine[];
  /** The repo's runners as GitHub lists them. */
  runners(repo: string): Promise<Listed[]>;
  addLabel(repo: string, runnerId: number, label: string): Promise<boolean>;
  dropLabel(repo: string, runnerId: number, label: string): Promise<void>;
  /** One job as GitHub has it now; null when it can't be read. */
  job(repo: string, id: number): Promise<{ status: string; runner: string | null } | null>;
  now(): number;
  log?: (line: string) => void;
}

type State = 'waiting' | 'handed' | 'running';
interface Held {
  key: string;
  job: QueuedHeavy;
  label: string;
  size: number;
  what: string;
  since: number;
  /** The PC it waits on, was handed to or runs on; null before it has one, or when it went to any runner (no PC lent). */
  home: number | null;
  state: State;
  runner: { id: number; name: string } | null;
  /** When it was handed out, or last seen running. */
  at: number;
  late: boolean;
}

interface AgentJob {
  machine: number;
  until: number;
}

/** What a heavy job's room looks like now, for the log and tests. */
export interface HeavyView {
  key: string;
  what: string;
  state: State;
  machine: number | null;
  runner: string | null;
  since: number;
  late: boolean;
}

const lower = (xs: readonly string[]) => xs.map((x) => x.toLowerCase());

export class HeavyPlacer {
  private d: HeavyDeps;
  private held = new Map<string, Held>();
  private agentJobs = new Map<string, AgentJob>();
  /** Repos whose runners were swept of labels Citadel didn't hand out since this server started. */
  private swept = new Set<string>();
  private busy = false;

  constructor(d: HeavyDeps) {
    this.d = d;
  }

  private say(line: string) {
    this.d.log?.(`Heavy jobs: ${line}`);
  }

  view(): HeavyView[] {
    return [...this.held.values()].map((h) => ({ key: h.key, what: h.what, state: h.state, machine: h.home, runner: h.runner?.name ?? null, since: h.since, late: h.late }));
  }

  /**
   * One look, after ShipWatch read the queued runs: `queued` is every heavy job queued now in the repos it read, and
   * `read` those repos (a job missing from a repo that wasn't read may still be queued).
   */
  async pass(queued: readonly QueuedHeavy[], read: ReadonlySet<string>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const now = this.d.now();
      const listed = new Map<string, Promise<Listed[] | null>>();
      const runners = (repo: string) => {
        let p = listed.get(repo);
        if (!p) {
          p = this.d.runners(repo).catch((err) => {
            this.say(`${repo}'s runners: ${thrown(err).message}`);
            return null;
          });
          listed.set(repo, p);
        }
        return p;
      };
      const seen = new Set<string>();
      for (const q of queued) {
        const k = heavyKind(q.labels);
        if (!k) continue;
        const key = keyOf(q.repo, q.id);
        seen.add(key);
        if (!this.held.has(key)) {
          const what = `${WHAT[k.kind] ?? `${k.kind} job`} in ${q.repo}`;
          this.held.set(key, { key, job: q, label: k.label, size: HEAVY_SIZES[k.kind] ?? HEAVY.apk, what, since: now, home: null, state: 'waiting', runner: null, at: now, late: false });
        }
      }
      for (const h of [...this.held.values()]) {
        try {
          await this.step(h, now, seen.has(h.key), read.has(h.job.repo), runners);
        } catch (err) {
          this.say(`${h.what} (job ${h.job.id}): ${thrown(err).message}`);
        }
      }
      for (const repo of read) {
        if (this.swept.has(repo)) continue;
        const list = await runners(repo);
        if (!list) continue;
        this.swept.add(repo);
        const handed = new Set([...this.held.values()].filter((h) => h.state === 'handed' && h.job.repo === repo).map((h) => `${h.runner?.id}:${h.label}`));
        for (const r of list) {
          for (const l of lower(r.labels)) {
            if (!l.startsWith(HEAVY_LABEL) || handed.has(`${r.id}:${l}`)) continue;
            await this.d.dropLabel(repo, r.id, l).catch((err) => this.say(`couldn't take ${l} off ${r.name}: ${thrown(err).message}`));
            this.say(`took ${l} off ${r.name} in ${repo}: Citadel didn't hand it out (left from before a restart)`);
          }
        }
      }
    } finally {
      this.busy = false;
    }
  }

  private async step(h: Held, now: number, queuedNow: boolean, repoRead: boolean, runners: (repo: string) => Promise<Listed[] | null>) {
    if (h.state === 'waiting') {
      if (!queuedNow) {
        if (!repoRead) return;
        // Not queued any more and never handed out: cancelled, or a runner took it some other way (a label added by hand).
        const j = await this.d.job(h.job.repo, h.job.id);
        if (j?.status === 'in_progress' || j?.status === 'queued') {
          if (j.status === 'in_progress') this.running(h, now, j.runner);
          return;
        }
        return this.finish(h, j ? `it ${j.status === 'completed' ? 'ended' : j.status} before it was placed` : 'GitHub no longer lists it');
      }
      return this.place(h, now, await runners(h.job.repo));
    }
    const j = await this.d.job(h.job.repo, h.job.id);
    if (h.state === 'handed') {
      if (j && j.status !== 'queued') {
        await this.unlabel(h);
        if (j.status === 'completed') return this.finish(h, 'it ended');
        return this.running(h, now, j.runner);
      }
      if (now - h.at < (j ? HAND_MS : LEASE_MS)) return;
      // No runner took it (the one labelled went busy, or went away): place it again; its wait keeps counting.
      await this.unlabel(h);
      if (!j) return this.finish(h, `GitHub couldn't be read for ${LEASE_MS / 60_000} min`);
      // shortcut: its room is asked for afresh, so the balancer's 30 min count from here; keep the job waiting there if that bites.
      if (h.home !== null) this.d.balancer.release(h.home, h.key, null);
      h.home = null;
      this.say(`${h.what}: no runner took it in ${HAND_MS / 60_000} min on ${h.runner?.name}; placing it again`);
      h.state = 'waiting';
      h.runner = null;
      return;
    }
    // Running: GitHub says when it ends; a lease covers a job GitHub stops showing.
    if (j?.status === 'completed') return this.finish(h, 'it ended');
    if (j) h.at = now;
    else if (now - h.at >= LEASE_MS) return this.finish(h, `its lease ended: GitHub couldn't be read for ${LEASE_MS / 60_000} min`);
  }

  private running(h: Held, now: number, runner: string | null) {
    h.state = 'running';
    h.at = now;
    if (runner) h.runner = { id: h.runner?.name === runner ? h.runner.id : 0, name: runner };
  }

  /** Where it goes now, if anywhere: the first PC in the owner's order with room; else it waits on the first. */
  private async place(h: Held, now: number, list: Listed[] | null) {
    if (!list) return;
    const needs = lower(h.job.labels).filter((l) => l !== h.label);
    const fits = (r: Listed) => r.status === 'online' && needs.every((l) => lower(r.labels).includes(l));
    const on = (m: PlaceMachine) => list.filter((r) => fits(r) && m.hosts.some((host) => onHost(r.name, host)));
    const b = this.d.balancer;
    const eligible = this.d.machines(h.job.repo).filter((m) => m.hosts.length && on(m).length);
    const ranked = rank(eligible.map((m) => ({ ...m, free: 1 + (b.current(m.id)?.workers ?? 0) })));
    if (!ranked.length) {
      if (h.home !== null) b.release(h.home, h.key, null);
      h.home = null;
      // No PC Citadel balances may take it: any runner with its labels does, at once, as before Citadel placed jobs.
      await this.hand(h, null, list.filter(fits), now, false);
      return;
    }
    const job = { key: h.key, label: h.what, size: h.size };
    // Its PC went (role off, agent away): it waits on the first again.
    if (h.home !== null && !ranked.some((m) => m.id === h.home)) {
      b.release(h.home, h.key, null);
      h.home = null;
    }
    const home = ranked.find((m) => m.id === h.home) ?? ranked[0];
    const asked = h.home === home.id;
    h.home = home.id;
    // Another PC with room now takes it (PLACE: the owner's order, each filled before the next).
    const other = async (m: PlaceMachine & { free: number }) => {
      if (b.ask(m.id, job) === 'wait') {
        b.release(m.id, h.key, null);
        return false;
      }
      if (!(await this.hand(h, m, on(m), now, false))) return false;
      b.release(home.id, h.key, null);
      return true;
    };
    const at = ranked.indexOf(home);
    for (const m of ranked.slice(0, at)) if (await other(m)) return;
    // Its own PC: asked the first time; after that its plan says, so a late start isn't taken before the others are tried.
    const plan = asked ? b.plan(home.id) : null;
    if (!asked || plan?.start.includes(h.key)) {
      const go = b.ask(home.id, job);
      if (go !== 'wait') return void (await this.hand(h, home, on(home), now, go === 'late'));
    }
    for (const m of ranked.slice(at + 1)) if (await other(m)) return;
    if (plan?.late.includes(h.key) && b.ask(home.id, job) === 'late') await this.hand(h, home, on(home), now, true);
  }

  /** The label onto one runner there, idle first. False (and its room given back) when none took it. */
  private async hand(h: Held, m: PlaceMachine | null, runners: Listed[], now: number, late: boolean): Promise<boolean> {
    for (const r of [...runners].sort((a, b) => Number(a.busy) - Number(b.busy))) {
      try {
        if (!(await this.d.addLabel(h.job.repo, r.id, h.label))) continue;
      } catch (err) {
        this.say(`couldn't put ${h.label} on ${r.name}: ${thrown(err).message}`);
        continue;
      }
      h.state = 'handed';
      h.home = m?.id ?? null;
      h.runner = { id: r.id, name: r.name };
      h.at = now;
      h.late = late;
      const waited = Math.round((now - h.since) / 60_000);
      this.say(`${h.what} (job ${h.job.id}) goes to ${r.name}${m ? ` on ${m.name}` : ' (no PC lends its scheme CI with room)'}${late ? `, late: it waited ${waited} min for room` : waited ? ` after ${waited} min` : ''}`);
      return true;
    }
    if (m) this.d.balancer.release(m.id, h.key, null);
    if (h.home === m?.id) h.home = null;
    return false;
  }

  private async unlabel(h: Held) {
    if (h.state !== 'handed' || !h.runner) return;
    await this.d.dropLabel(h.job.repo, h.runner.id, h.label).catch((err) => this.say(`couldn't take ${h.label} off ${h.runner?.name}: ${thrown(err).message}`));
  }

  private async finish(h: Held, why: string) {
    await this.unlabel(h);
    this.held.delete(h.key);
    this.d.balancer.done(h.key);
    this.say(`${h.what} (job ${h.job.id}) let go of its room: ${why}`);
  }

  /** A job's last step (its run token names the run; RUNNER_NAME the runner): its room is free at once. True when one was held. */
  async doneRun(repo: string, run: number, runner: string): Promise<boolean> {
    const r = runner.toLowerCase();
    let any = false;
    for (const h of [...this.held.values()]) {
      if (h.job.repo !== repo.toLowerCase() || h.job.run !== run || h.state === 'waiting' || h.runner?.name.toLowerCase() !== r) continue;
      await this.finish(h, 'its last step said so');
      any = true;
    }
    return any;
  }

  /**
   * A Windows test run on a PC asks for its size (its agent, with the PC's token): 'start', 'late' (it waited
   * HEAVY_WAIT_MS) or 'wait' (ask again within AGENT_LEASE_MS; meanwhile no new turn starts there). Each ask while it runs
   * renews its lease.
   */
  agentAsk(machineId: number, key: string, label: string): 'start' | 'late' | 'wait' {
    const k = agentKey(machineId, key);
    this.agentJobs.set(k, { machine: machineId, until: this.d.now() + AGENT_LEASE_MS });
    return this.d.balancer.ask(machineId, { key: k, label, size: HEAVY.windows });
  }

  agentDone(machineId: number, key: string) {
    const k = agentKey(machineId, key);
    this.agentJobs.delete(k);
    this.d.balancer.release(machineId, k, null);
  }

  /** Agent jobs whose lease ended (their agent stopped asking: it crashed, or went away) give their room back. */
  expire() {
    const now = this.d.now();
    for (const [k, j] of this.agentJobs) {
      if (j.until > now) continue;
      this.agentJobs.delete(k);
      this.d.balancer.release(j.machine, k, null);
      this.say(`a Windows test run on machine ${j.machine} let go of its room: its agent stopped asking for ${AGENT_LEASE_MS / 60_000} min`);
    }
  }
}

// A trailing ';' so one key never starts another (MachineBalancer.release matches by prefix).
const keyOf = (repo: string, id: number) => `ci:${repo.toLowerCase()}#${id};`;
const agentKey = (machineId: number, key: string) => `win:${machineId}:${key};`;
