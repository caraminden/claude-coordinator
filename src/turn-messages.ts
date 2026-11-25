// What a turn is given and what it reports: a queued message with its images and files, plan usage readings, and the slash commands it loaded.
// Moved out of runner.ts (#1840), which re-exports what it exported.

export interface UsageWindow {
  utilization: number; // 0..1 of the plan's limit
  resetsAt: number | null; // epoch ms
  status: string | null;
}

/** The Claude account's plan usage, as last reported by a turn. */
export interface Usage {
  weekly: UsageWindow | null;
  session: UsageWindow | null; // the rolling five-hour window
  updatedAt: number;
}

/** A rate_limit_event's `rate_limit_info`: each window's reading, by name (seven_day, five_hour). */
export interface RateLimitInfo {
  unifiedWindows?: Record<string, Record<string, unknown> | null | undefined>;
}

/** One window of Codex's account/rateLimits. */
export interface CodexWindow {
  usedPercent?: unknown;
  windowDurationMins?: unknown;
  resetsAt?: unknown;
}

export interface CodexLimits {
  primary?: CodexWindow | null;
  secondary?: CodexWindow | null;
}

export function usageWindow(w: Record<string, unknown> | null | undefined): UsageWindow | null {
  if (!w || typeof w.utilization !== 'number') return null;
  return {
    utilization: w.utilization,
    resetsAt: typeof w.resetsAt === 'number' ? w.resetsAt * 1000 : null,
    status: typeof w.status === 'string' ? w.status : null,
  };
}

export interface MessageImage {
  name: string;
  path: string;
  mediaType: string;
}

/** A file people attached, saved in the thread's files folder (src/uploads.ts). */
export interface MessageFile {
  name: string;
  path: string;
  size: number;
  type: string;
}

export interface QueuedMessage {
  author: string;
  text: string;
  images: MessageImage[];
  files?: MessageFile[];
  about?: string; // the file a comment is on
  id?: number; // its user_message event, for taking it back while queued
  from?: number; // the minion or Taskmaster that relayed it, whose turn's person it carries
  typed?: boolean; // a signed-in person sent it from the chat; only these can be a go to merge (#201)
  own?: boolean; // a person sent it themselves: typed, or a card's answer; only these carry their own secrets (#838)
  asker?: number | null; // whose ask it is (Store.turnAsker), taken when it was sent; null for no person's
  fresh?: 'handoff' | 'compact'; // a Taskmaster's fresh-start step (#406), which runs alone
  cold?: true; // held mail left because its recipient was cold (#413), for the Held list (#1059)
  fyi?: boolean; // a notice that needs no action (its PR merged, CI passed): it doesn't cancel a pending close_self (#619)
  parked?: string; // held for a sealed minion (#718): when it was sent, "2026-11-14 18:02" UTC
  keepalive?: true; // a hidden keepalive (#862, src/keepalive.ts): no chat, no state, nothing of the minion's changes
  card?: string; // the kept card it answers (#1916): only the turn that gets this may have its pass
  rerun?: true; // a cut-off turn's, given back to run again (#1958): it wakes nobody, so a seal set since stays
  light?: true; // a machine's notice of success (a land that landed, CI passed, a job done): a turn of only these runs at low effort (#951)
}

/** The slash commands a chat's last turn loaded (its init event, #937), and the scheme's newest, for a chat with no turn yet. */
export interface LoadedCommands {
  names: string[];
  plugins: { name: string; path: string }[];
  cwd: string;
}
