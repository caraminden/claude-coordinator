// The chat: a turn's events, its progress, the open session and the message box.
// Part of the page's shapes: the rules and the shared core are in ../types.d.ts.

import type { mergedView } from '../mine.js';
import type { narrationSorter } from '../narration.js';
import type { applyEvent, createProgress } from '../progress.js';

/** A step of a chat's plan (progress.js createProgress's `tasks`, built by applyEvent). */
/** One segment of a plan's track (progress.js planTrack): guess minutes, state, then an underway step's own clock. */
export type TrackStep = [estimate: number | null, state: 'c' | 'i' | 'h' | 'p', since?: number | null, usual?: number, workedMs?: number];

export interface ProgressTask {
  id: string;
  /** The plan tool's step number. */
  n?: number;
  subject: string;
  activeForm?: string;
  description?: string;
  outcome?: string;
  note?: string;
  /** 'pending', 'in_progress' or 'completed'. */
  status: string;
  actions: number;
  estimate?: number | null;
  startedAt?: number | null;
  doneN?: number;
  work?: number;
  workFrom?: number | null;
  kind?: string;
  /** The status the minion set on this step itself (the plan tool's `status`), which wins over the server's guess. */
  own?: 'todo' | 'doing' | 'done' | 'dropped';
  seen?: boolean;
  stage?: string;
}

/** A chat's plan and turn state (progress.js createProgress), its steps typed. */
export type Progress = Omit<ReturnType<typeof createProgress>, 'tasks'> & { tasks: ProgressTask[] };

/** A tool call in the open chat (thread.js drawEvent): the block, its plan step, and its result once it comes. */
export interface ChatAction {
  block: ReturnType<typeof applyEvent>[number]['block'];
  taskId: ReturnType<typeof applyEvent>[number]['taskId'];
  result: { content: unknown; is_error?: boolean; cut?: boolean; event: { id: number; ticket: number } } | null;
  startedAt: number;
  doneAt?: number;
  event: { id: number; ticket: number };
}

/** One of Claude's words in the open chat, as thread.js hands it to narration.js: its message and body. */
export interface NarrationText {
  el: HTMLElement;
  body?: Node;
  text: string;
}

/** The open chat's narration sorter (narration.js), carrying thread.js's lines. */
export type NarrationSorter = ReturnType<typeof narrationSorter<NarrationText>>;

/** A line of the running turn's words waiting to fold or stay (narration.js), or a break between stretches. */
export type Fold = ReturnType<NarrationSorter['text']>[number] | { fate: 'break'; text?: undefined };

/** A message you sent that the server's history doesn't have yet (composer.js send). */
export interface PendingMessage {
  el: HTMLElement;
  urls: string[];
  text: string;
  sendId: string;
  saved: unknown[];
  state: string;
  retry?: () => Promise<unknown>;
}

/** The chat's newest plan card (cards.js planCard): a later one is shown as a revision of it. */
export interface PlanMemo {
  plan: string;
  summary: string;
  /** Its card, once drawn: `status` is 'approved' once someone approved it. */
  handle: { status: string } | null;
}

/** A chat's drawing state that a merged Taskmaster view swaps per session (thread.js SESSION_STATE). */
interface SessionState {
  part?: NonNullable<ReturnType<typeof mergedView>>['parts'][number];
  progress: Progress;
  turnActions: ChatAction[];
  actions: Map<string, ChatAction>;
  folds: Fold[];
  heldCards: Node[];
  pendingMessages: PendingMessage[];
  lastPlan: PlanMemo | null;
  gruntStarts: Map<string, number>;
  sawInit: boolean;
  latestReply: number | null;
  turnNote: string | null;
  turnInitAt: number | undefined;
  narration: NarrationSorter;
  narrationEl: HTMLElement | null;
  pendingRequest: { id: number; author: string; text: string }[];
  turnRequest: { id: number; author: string; text: string }[] | undefined;
}

/** One step of a plan call's `steps` (src/mcp.ts PLAN; progress.js planError checks it). */
export interface PlanStep {
  n: number;
  step?: string;
  doing?: string;
  why?: string;
  outcome?: string;
  minutes?: number;
  status?: string;
  kind?: string;
}

/** What a tool call's input holds that progress.js and the readouts read (Claude's tool inputs; the plan tools' too). */
export interface ToolInput {
  command?: string;
  description?: string;
  file_path?: string;
  notebook_path?: string;
  pattern?: string;
  path?: string;
  url?: string;
  query?: string;
  prompt?: string;
  skill?: string;
  subagent_type?: string;
  run_in_background?: boolean;
  ticket_id?: number | string;
  title?: string;
  text?: string;
  notice?: string;
  kind?: string;
  state?: string;
  taskId?: string | number;
  subject?: string;
  activeForm?: string;
  status?: string;
  metadata?: { estimate?: unknown; outcome?: unknown };
  todos?: { content: string; activeForm?: string; status: string }[];
  steps?: PlanStep[];
}

/** A tool call in a Claude message (stream-json `tool_use` block); `work` and `cut` come from eventcut.js's cut-down copy. */
export interface ToolBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input?: ToolInput;
  work?: string;
  /** Input field -> its whole length, for each field a page's copy cut short. */
  cut?: Record<string, number>;
}

/** A tool's result in a user message (stream-json `tool_result` block). */
export interface ResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content?: unknown;
  is_error?: boolean;
  /** The whole length, when a page's copy was cut short. */
  cut?: number;
}

/** A block of a Claude message's content as the server stores it (src/claude-events.ts ContentBlock): which fields it has depends on `type`; ToolBlock and ResultBlock are the two a page reads. */
export interface ChatBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: ToolInput;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
  work?: string;
  cut?: unknown;
}

/** The `data` of a `claude` chat event, as progress.js reads it (stream-json). */
export interface ClaudeEvent {
  type?: string;
  subtype?: string;
  model?: unknown;
  is_error?: boolean;
  parent_tool_use_id?: string | null;
  turn_state?: string | null;
  message?: { content?: ChatBlock[] | string };
}

/** A picture or file waiting on a message, as a draft saves it (composer.js createAttachments). */
export interface SavedItem {
  mediaType?: string;
  data?: string;
  upload?: { name: string; size: number; type: string; label?: string };
  note?: { text: string; label: string };
}

/** The chat's message box form with the hooks composer.js hangs on it for thread.js, replies and the paste listener. */
export type ComposerForm = HTMLFormElement & {
  pasteAnywhere: (e: ClipboardEvent) => void;
  sendAndUnpark: () => void;
  sendText: (text: string) => Promise<unknown>;
  editBack: (text: string, saved?: SavedItem[]) => () => void;
  attach: (saved: SavedItem[]) => unknown[];
};

/** A person's message drawn in the chat (bubbles.js userBubble), with what thread.js hangs on it for its ✎ (markQueued). */
export interface Bubble extends HTMLElement {
  /** What the ✎ puts back in the message box while it waits in the queue. */
  sent?: { text: string; images: string[]; files: NonNullable<SavedItem['upload']>[] };
}
