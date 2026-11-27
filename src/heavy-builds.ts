// Where a heavy job runs, and its container builds on the machines' Builds role (H2, specs/heavy-jobs-across-machines.md sections 2 and 3 in the shared folder). Josh, 2026-11-25:
// "I guess its fine if those run on perigee when it has room, but we should load balance it across our other machiens",
// and his picks on #2060's page (2026-11-26): "B · Perigee is the last machine", "By what comes back", "A new Builds role".
//   How a job travels (Q2, tools/citadel-heavy): one whose files must come back (--back), or in a scheme with no CI,
// asks place() for the machines whose Builds role is on, lent to its scheme and set up for this release's images, and
// runs there as a container job (src/machine-jobs.ts's builds lane, tools/heavy-builds.ts). One that brings back only a
// log goes to the scheme's CI, as before: src/heavy-place.ts (#2120) already ranks the PCs lending CI by rank() and
// holds a job for room on the first.
//   Placing ranks by M6's rank(): the owner's order, then warm (it last ran this scheme's kind there), then most room.
// Perigee's small slot stands after all of them: an empty answer sends the job to perigee's line, which takes it when
// its slot is free and asks place() again each minute meanwhile. --here, light and priority jobs never ask.
// Pure but for BuildPlacer's reads.
import { HEAVY_SIZES } from './heavy-place.ts';
import { type MachineBalancer, rank } from './machine-balancer.ts';

export const HEAVY_KINDS = ['apk', 'cargo', 'suite', 'other'] as const;
export type HeavyKind = (typeof HEAVY_KINDS)[number];
/** Threads each kind is counted as: #2120's sizes (an APK 8, a suite 6), plus cargo as a build (8) and anything else 4. */
export const KIND_SIZE: Record<HeavyKind, number> = { apk: HEAVY_SIZES.apk, cargo: 8, suite: HEAVY_SIZES.suite, other: 4 };
/** The build image (tools/build-images/images.json's key) each kind runs in, and its cache volume and where it goes. */
export const KIND_IMAGE: Record<HeavyKind, { image: 'android' | 'node' | 'rust'; volume: string; at: string }> = {
  apk: { image: 'android', volume: 'citadel-gradle', at: '/cache/gradle' },
  // shortcut: the crates are cached, not the toolchains a rust-toolchain.toml names (RUSTUP_HOME stays the image's); move RUSTUP_HOME into the volume if those downloads show up in run times.
  cargo: { image: 'rust', volume: 'citadel-cargo', at: '/cache/cargo' },
  suite: { image: 'node', volume: 'citadel-npm', at: '/cache/npm' },
  other: { image: 'node', volume: 'citadel-npm', at: '/cache/npm' },
};

export const isHeavyKind = (v: unknown): v is HeavyKind => typeof v === 'string' && (HEAVY_KINDS as readonly string[]).includes(v);

/** A machine that may take the job, as placing sees it: its owner's order and its free threads now. */
export interface Spot {
  id: number;
  name: string;
  priority: number | null;
  /** Threads free there now, after its plan (ships, CI waiting, turns, heavy jobs held). */
  free: number;
}

/** The machines that may take a job of `size` threads, best first; empty: perigee's line (take B). */
export function place<T extends Spot>(size: number, spots: readonly T[], warm: number | null = null): T[] {
  return rank(
    spots.filter((s) => s.free >= size),
    { warm },
  );
}

export interface PlaceDeps {
  /** Every machine with an owner that is online, with its owner's order. */
  machines: () => { id: number; name: string; priority: number | null }[];
  /** Its Builds role is on, lent to this scheme, and its last Set up is green for the images this release ships. */
  builds: (machineId: number, projectId: number) => boolean;
  /** Threads free there now for a build (the balancer's, under the Builds role's threads cap), or null where it has no say yet. */
  free: (machineId: number) => number | null;
  /** The machine that last ran this scheme's container job of this kind, for the warm tie-break. */
  warm: (projectId: number, kind: HeavyKind) => number | null;
}

export interface PlaceAsk {
  projectId: number;
  kind: HeavyKind;
  /** Threads it needs; the kind's size when left out. */
  size?: number;
}

/** place() over the live machines. */
export class BuildPlacer {
  private d: PlaceDeps;
  constructor(d: PlaceDeps) {
    this.d = d;
  }

  place(ask: PlaceAsk): Spot[] {
    const size = ask.size ?? KIND_SIZE[ask.kind];
    const spots = this.d.machines().flatMap((m) => {
      if (!this.d.builds(m.id, ask.projectId)) return [];
      const free = this.d.free(m.id);
      return free === null ? [] : [{ ...m, free }];
    });
    return place(size, spots, this.d.warm(ask.projectId, ask.kind));
  }

  /** The machine may take this scheme's build jobs now (a start checks it again, whatever place() said a moment before). */
  buildsMay(machineId: number, projectId: number): boolean {
    return this.d.machines().some((m) => m.id === machineId) && this.d.builds(machineId, projectId);
  }
}

/** A machine's Builds role is set up green for the images this release ships (src/role-setup.ts keeps its last run in setup.run). */
export function buildsReady(setup: Record<string, unknown> | null, shipped: Record<string, string>): boolean {
  const run = setup?.run as { role?: unknown; ok?: unknown; images?: unknown } | undefined;
  return run?.role === 'builds' && run.ok === true && Object.keys(shipped).length > 0 && JSON.stringify(run.images ?? {}) === JSON.stringify(shipped);
}

/**
 * May a heavy job start on a machine now (the balancer's ask()), a build also kept under its Builds role's threads
 * `cap`: place() only read the room, and two jobs placed at once must not both start past it. A build bigger than the
 * cap starts when no other build runs there, so it never waits for ever.
 */
export function buildRoom(balancer: Pick<MachineBalancer, 'ask' | 'holding'>, machineId: number, job: { key: string; label: string; size: number }, cap: number | null): 'start' | 'late' | 'wait' {
  const held = cap === null || !job.key.startsWith('build:') ? 0 : balancer.holding(machineId, 'build:');
  if (cap !== null && held > 0 && held + job.size > cap) return 'wait';
  return balancer.ask(machineId, job);
}
