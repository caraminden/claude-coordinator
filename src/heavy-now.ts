// What heavy jobs each place holds or has waiting now, for the Workers tile (#2109): perigee's from citadel-heavy's slot
// and wait files, a machine's from its Builds jobs and the balancer (which also holds its CI, Windows and GPU jobs).
import { schemeOfWho, type AppOwners } from './host-load.ts';
import type { HeavyJob as Balanced } from './machine-balancer.ts';
import type { MachineJob } from './db.ts';
import type { HeavyJobs } from './waits.ts';

export interface HeavyNowJob {
  /** '' for a job the balancer names by itself ("APK build in owner/repo"). */
  scheme: string;
  what: string;
  /** Its size on the machine; perigee's slot jobs carry none. */
  threads: number | null;
  /** What it waits on; null while it runs. */
  waiting: string | null;
}

export interface HeavyNow {
  /** perigee's heavy slots and their line. */
  home: HeavyNowJob[];
  machines: { id: number; name: string; jobs: HeavyNowJob[] }[];
}

/** citadel-heavy's wait reasons, said on a row. */
const LINE: Record<string, string> = { line: 'in line', slots: 'all slots busy', load: 'perigee is busy', memory: 'short on memory', first: 'a deploy goes first' };

export interface HeavyNowInput {
  perigee: HeavyJobs;
  owners?: AppOwners;
  machines: { id: number; name: string }[];
  /** Builds jobs queued, starting or running, and any GPU job the balancer names. */
  jobs: MachineJob[];
  balanced: (machineId: number) => readonly Balanced[];
  /** Why a queued job waits (MachineJobs.waits). */
  waits: (job: MachineJob) => string | null;
  scheme: (projectId: number) => string;
}

export function heavyNow(i: HeavyNowInput): HeavyNow {
  const slot = (who: string, what: string, waiting: string | null): HeavyNowJob => ({ scheme: schemeOfWho(who, i.owners), what, threads: null, waiting });
  const home = [
    ...i.perigee.holders.map((j) => slot(j.who, j.what, null)),
    // 'ease' is a nested session claude-pace holds, no heavy job.
    ...i.perigee.waiters.filter((j) => j.reason !== 'ease').map((j) => slot(j.who, j.what, LINE[j.reason ?? ''] ?? 'in line')),
  ];
  const threads = (j: MachineJob) => Number((JSON.parse(j.kind) as { threads?: number }).threads) || null;
  const machines = i.machines.flatMap(({ id, name }) => {
    const held = i.balanced(id);
    const builds = i.jobs.filter((j) => j.machine_id === id && j.go === 'builds').map((j): HeavyNowJob => ({ scheme: i.scheme(j.project_id), what: j.reason, threads: threads(j), waiting: j.state === 'queued' ? (i.waits(j) === 'machine offline' ? 'machine offline' : 'no room yet') : null }));
    const others = held
      .filter((h) => !h.key.startsWith('build:'))
      .map((h): HeavyNowJob => {
        const gpu = h.key.startsWith('gpu:') ? i.jobs.find((j) => `gpu:${j.id}` === h.key) : undefined;
        return { scheme: gpu ? i.scheme(gpu.project_id) : '', what: gpu ? `${gpu.kind_name} (GPU job)` : h.label, threads: h.size, waiting: h.running ? null : 'no room yet' };
      });
    const jobs = [...builds, ...others].sort((a, b) => Number(a.waiting !== null) - Number(b.waiting !== null));
    return jobs.length ? [{ id, name, jobs }] : [];
  });
  return { home, machines };
}
