// Citadel UI: chat. Types for /apps/_citadel/ui/chat.js. A stable API: names and options are only ever
// added (test/ui-contract.test.ts checks this file against the module's exports).
// Like every file in public/ui/, standalone: apps fetch it from /apps/_citadel/ui/ beside the module.

/** One event from Citadel's turn API (`POST /api/contraptions/turns`): the SSE event name as `type`, its JSON as `data`. */
export interface TurnEvent {
  type: 'start' | 'text' | 'tool' | 'tool_result' | 'compacted' | 'end' | 'error' | (string & {});
  data: Record<string, unknown>;
  /** When it happened (ms or an ISO string). push() stamps the time it arrived; without one, history shows no clocks. */
  at?: number | string;
}

/** A person's message and the agent's reply to it. `ask` null: a turn nobody typed (the app started it). */
export interface Turn {
  ask?: string | null;
  /** Its events in order. It runs until an `end` or `error`, or until a later turn starts. */
  events: TurnEvent[];
}

export type StepState = 'running' | 'done' | 'failed' | 'stopped';

/** One tool call. A Grunt (an Agent call) carries its own calls in `steps`, grouped by the turn API's `parent`. */
export interface Step {
  id: string;
  name: string;
  input: Record<string, unknown>;
  state: StepState;
  /** ms, when known. */
  start?: number;
  end?: number;
  grunt?: true;
  steps?: Step[];
}

export type Block =
  /** Words, split per message id (or, without ids, at each tool call). */
  | { id: string; kind: 'text'; message: string | null; text: string }
  /** A run of top-level calls between texts, drawn as one row that folds. */
  | { id: string; kind: 'steps'; steps: Step[] }
  /** A call the app draws as its own card (mountChat's `block`); `result` once it has one. */
  | { id: string; kind: 'card'; tool: string; name: string; input: Record<string, unknown>; result?: { ok: boolean } }
  /** The turn was canceled: "Stopped." */
  | { id: string; kind: 'stopped' }
  /** The turn failed: a danger notice with the turn API's code and message. */
  | { id: string; kind: 'error'; code: string; message: string };

export interface ChatItem {
  ask: string | null;
  blocks: Block[];
  running: boolean;
}

export interface ChatModel {
  items: ChatItem[];
  /** The newest turn is still running. */
  running: boolean;
}

/** Turns as the chat draws them. Pure. `card(name, input, id)`: true when that top-level call is the app's own card, not a step. */
export function chatModel(turns: Turn[], opts?: { card?: (name: string, input: Record<string, unknown>, id: string) => boolean }): ChatModel;

export interface RenderOptions {
  /** A step's words, worded to read right both running and done: ("Moving “Dry cleaning”"). Default: the tool's short name ("Move todo"). */
  stepLabel?: (name: string, input: Record<string, unknown>) => string;
}

/** The chat as HTML, with no live parts (cards are empty slots, clocks read at `now`). For a server, a print view or a test. */
export function renderChat(turns: Turn[], opts?: RenderOptions & { now?: number; open?: string[] }): string;

export interface ChatOptions extends RenderOptions {
  /**
   * Your own card for a top-level tool call (Theory of Crafting's viability card). Called when the call
   * starts (`result` undefined) and once more when its result comes. Return an element to draw the call
   * as that card where it fell in the reply (an empty one holds the place until the result), or null on
   * the first call to leave it a step.
   */
  block?: (name: string, input: Record<string, unknown>, result: { ok: boolean } | undefined) => HTMLElement | null;
  /** What an empty chat says ("Ask the Acolyte to do anything in Mandate."). */
  empty?: string;
  /** A reply chip was tapped: send `message` as the person's (then call ask()). */
  onReply?: (message: string) => void;
}

export interface Chat {
  /** The chat's history: replaces whatever it shows. */
  load(turns: Turn[]): void;
  /** Your message: a new turn starts with it, "Thinking…" until its events come. */
  ask(text: string): void;
  /** One turn-API event as it arrives; only what it changed redraws. An event after a turn ended starts a turn of its own. */
  push(event: TurnEvent): void;
  /** Chips under the newest reply (an agent's offered choices, one-tap replies). A tap disables them, marks it picked and calls onReply. [] clears them. */
  replies(list: { label: string; message?: string; recommended?: boolean }[]): void;
  destroy(): void;
}

/**
 * Mount a chat in `el`, which becomes the scroller: give it a height (`flex: 1; min-height: 0` in a
 * column). Link /apps/_citadel/theme.css and ui/base.css first. It follows new output only within
 * 24 px of the bottom, with a "Latest" button otherwise; the working line is its only live region.
 */
export function mountChat(el: HTMLElement, opts?: ChatOptions): Chat;

/** A step's state as its mark: a spinner while running, else ✓, ✕ or –, labelled for screen readers. */
export function stepMark(state: StepState): HTMLSpanElement;

/** Who a Grunt is, from its Agent call's input: its description, else its agent type, else "Grunt". */
export function gruntName(input: unknown): string;

/** Milliseconds as "41s" or "1m 12s". */
export function duration(ms: number): string;
