// A person's Claude and Codex plan usage. One set: the usage bars, the account list and the state rows share these.
// Part of the page's shapes: the rules and the shared core are in ../types.d.ts.

/** One window of a Claude account's plan usage (src/turn-messages.ts UsageWindow). */
export interface UsageWindow {
  utilization: number;
  resetsAt: number | null;
  status: string | null;
}

/** The parts of a window the meters read (src/account-pick.ts MeterWindow). */
export type MeterWindow = Pick<UsageWindow, 'utilization' | 'resetsAt'>;
/** A row of the account list, as the combined bar and its tooltip read it (claudeusage.js). */
export interface UsageAccount {
  n?: number;
  label: string;
  same?: string | null;
  usage?: { weekly?: MeterWindow | null; session?: MeterWindow | null } | null;
}
/** A Claude account's plan usage as a turn last reported it (src/turn-messages.ts Usage). */
export interface PlanUsage {
  weekly: UsageWindow | null;
  session: UsageWindow | null;
  updatedAt: number;
}

/** A person's Claude usage as the stream and api/me give it (src/runner.ts usageOf: Usage, which account new minions use and why, and each account). */
export interface ClaudeUsage extends PlanUsage {
  account?: number;
  why?: string;
  pinned?: number;
  accounts?: { n: number; label: string; same?: string; usage: PlanUsage | null }[];
}

/** One window of a person's Codex usage (src/codex.ts CodexUsage): resetsAt in seconds. */
export interface CodexWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

export interface CodexUsage {
  primary: CodexWindow | null;
  secondary: CodexWindow | null;
  updatedAt: number;
}

/** What codexusage.js reads: a CodexUsage that may not say when it was read, or none. */
export type CodexUsageIn = (Pick<CodexUsage, 'primary' | 'secondary'> & Partial<Pick<CodexUsage, 'updatedAt'>>) | null | undefined;
/** A person's Codex override as the stream gives it (src/runner.ts codexView). */
export interface CodexState {
  ready: boolean;
  why: string | null;
  on: boolean;
  usage: CodexUsage | null;
}
