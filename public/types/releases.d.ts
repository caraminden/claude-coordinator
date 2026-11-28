// The Releases page.
// Part of the page's shapes: the rules and the shared core are in ../types.d.ts.

/** A release target (src/releases.ts Target). */
export interface ReleaseTarget {
  id: string;
  projectId: number;
  name: string;
  kind: string;
  link: string | null;
  numbering?: { name?: string; number?: 'run' | 'count' };
}

/** One release of a target (src/releases.ts Release, with src/ship-failures.ts FailureDetail and FailureNext). */
export interface Release {
  version: string;
  number: number | null;
  link: string | null;
  name?: string;
  changes: { ticketId: number; number: number | null; title: string; fix?: string }[];
  started: number | null;
  live: number | null;
  outcome: string;
  stages: Record<string, number>;
  commit?: string;
  failure?: {
    kind: string;
    names: string[];
    more: number;
    ci: string | null;
    next: { kind: 'again'; at: number } | { kind: 'shipped'; release: string | null } | { kind: 'line'; place: string | null; holds: boolean } | { kind: 'closed' } | { kind: 'fixing' | 'idle'; note: string | null };
  };
}

// Round 4: releases.js (GET api/releases, src/releases.ts; ReleaseTarget and Release are above)
/** A ship try's early test (src/waits.ts EarlyTest). */
export interface EarlyTest {
  state: 'running' | 'passed' | 'failed' | 'dropped';
  brief: string;
  text: string;
}

/** A failed try seen again in line (src/ship-failures.ts LastTry). */
export interface LastTry {
  kind: string;
  names: string[];
  more: number;
  ci: string | null;
  at: number;
}

/** Where a change or release is (src/releases.ts Progress). */
export interface ReleaseProgress {
  stage: string;
  since: number;
  usual: number | null;
  waitingOn: string | null;
  text: string;
  brief?: string;
  label?: string;
  done?: number;
  total?: number;
  early?: EarlyTest;
  train?: { role: 'front' | 'rider' | 'waiting'; label: string; size?: number; front?: string; members?: string[]; quick?: true };
}

/** One minion's change in the release under way (src/releases.ts Change). */
export interface ReleaseChange extends ReleaseProgress {
  ticketId: number;
  number: number | null;
  title: string;
  canPreview?: boolean;
  later?: boolean;
  idle?: boolean;
  lastTry?: LastTry;
  fix?: string;
}

/** A line of the ship under way (src/land-news.ts NewsItem). */
export interface NewsItem {
  tone: 'bad' | 'warn' | 'info';
  text: string;
  refs?: Record<string, number>;
}

/** The release being made (src/releases.ts Next). */
export interface ReleaseNext extends ReleaseProgress {
  number: number | null;
  name?: string;
  link: string | null;
  stages: { name: string; usual: number | null }[];
  eta: number | null;
  news?: NewsItem[];
  changes: ReleaseChange[];
}

/** Who placed a waiter in the ship line (src/ship-line-state.ts Placed). */
export interface Placed {
  by: string;
  at: number;
  reason?: string;
  taskmaster: boolean;
}

/** One entry of the ship line (src/releases.ts LineEntry). */
export interface LineEntry {
  name: string;
  ticketId: number | null;
  holds: boolean;
  label?: string;
  place: string;
  seq: number;
  movable: boolean;
  why?: string;
  placed?: Placed;
  stage: string;
  since: number;
  lastTry?: LastTry;
  /** src/frozen-ships.ts Frozen. */
  frozen?: { unit: string; since: number; thaw: string };
}

/** A preview, download or site made to try a change (src/releases.ts TestCopy). */
export interface TestCopy {
  kind: 'preview' | 'build-preview' | 'download' | 'site' | 'debug-apk';
  target: string | null;
  name: string;
  path?: string;
  file?: string;
  port?: number;
  link?: string;
  at?: number;
  ticketId?: number;
  number?: number;
  build?: number;
  running: boolean;
  commit: string | null;
}

/** A target's Deploy button state (src/auto-deploy.ts DeployInfo). */
export interface DeployInfo {
  can: boolean;
  auto: boolean;
  due: number | null;
  more: boolean;
}

/** A roll back's pin (src/last-green.ts Pin). */
export interface Pin {
  sha: string;
  from: string;
  at: number;
  by: string;
  build?: { run: number; sha: string; workflow: string };
  code?: number;
}

/** A target's Roll back to last green state (src/rollback.ts RollbackInfo). */
export interface RollbackInfo {
  sha: string;
  can: boolean;
  pin: Pin | null;
  running: boolean;
  failed: { sha: string; at: number; why: string } | null;
}

/** One target's card (src/releases.ts TargetView). */
export interface TargetView {
  target: ReleaseTarget;
  current: Release | null;
  next: ReleaseNext | null;
  line: LineEntry[];
  testCopies: TestCopy[];
  recent: Release[];
  deploy?: DeployInfo;
  releaseKey?: string;
  rollback?: RollbackInfo;
  quick?: QuickInfo;
}

/** Quick trains on Citadel's server card (src/quick-view.ts QuickInfo, #2245). */
export interface QuickInfo {
  on: boolean;
  behind: { at: number; top: string; ships: number[]; running: boolean }[];
  pinning: { ids: string[]; ships: number[]; at: number | null } | null;
  reds: { ids: string[]; n: number | null; at: number; escalateAt: number; escalated: boolean }[];
}

/** One scheme's releases (src/releases.ts SchemeReleases). */
export interface SchemeReleases {
  projectId: number;
  targets: TargetView[];
  testCopies: TestCopy[];
}
