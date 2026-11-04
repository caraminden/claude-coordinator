// Citadel UI: the composer. Types for /apps/_citadel/ui/composer.js. A stable API: names and options are
// only ever added (test/ui-contract.test.ts checks this file against the module's exports).
// Like every file in public/ui/, standalone: apps fetch it from /apps/_citadel/ui/ beside the module.

export interface ComposerOptions {
  /** Called with the trimmed text when the person sends. The box empties at once; resolve once the message is accepted. Reject (or throw) when it wasn't: the text goes back in the box, ahead of anything typed since, and the error shows. */
  send(text: string): Promise<unknown> | unknown;
  /** Given, Send becomes Stop while `busy(true)`, and Stop calls this. Typing still works; Enter doesn't send. With `whileBusy: 'send'`, Stop shows beside Send instead. */
  stop?(): void;
  /**
   * What Send does while `busy(true)` with `stop` given. 'stop' (default): Send becomes Stop, and nothing
   * sends until the turn ends. 'send': Send keeps sending (Enter too), and a Stop button shows before it
   * in the row: for a server that queues or steers a message sent mid-turn, as Citadel's own chat does.
   */
  whileBusy?: 'stop' | 'send';
  /** The box's hint. */
  placeholder?: string;
  /** The box's accessible name (default: the placeholder, which names it as it changes; else "Message"). */
  label?: string;
  /** Keep unsent text in localStorage under this key (as JSON), restored on mount: one key per chat. */
  draftKey?: string;
  /** Whether a send may go, given the trimmed text (default: it isn't empty). For a message that can carry more than text, or to refuse while something is still getting ready. */
  canSend?(text: string): boolean;
  /**
   * Put the caret in the box by itself (default true; false opts out): when it comes up, when the window
   * comes back, and when a dialog or drawer closes. Desktop only (not under `(pointer: coarse)` or at
   * 800px and under, where it would pop the keyboard over the chat), and only when nothing else has the
   * caret: never from another field, a menu or a dialog. With several boxes on the page, the newest shown one.
   */
  autofocus?: boolean;
  /** Shows a failed send's error (default: a cui-notice in the composer, gone on the next send). */
  onError?(error: unknown): void;
}

export interface Composer {
  /** Mark a turn running (true) or done (false). With `stop`, Send shows as Stop meanwhile. The form carries data-busy while busy. */
  busy(on: boolean): void;
  focus(): void;
  /** The box's text; setting it resizes the box and saves the draft. */
  value: string;
  /** Re-measure the box, after something other than typing changed its width or text. */
  fit(): void;
  /** form.cui-composer: add classes, or put your own controls in it. */
  form: HTMLFormElement;
  /** textarea.cui-input.cui-composer-input. */
  textarea: HTMLTextAreaElement;
  /** div.cui-composer-row beside the box, holding Send: put your own buttons before it. */
  row: HTMLDivElement;
  /** Send (button.cui-btn.cui-primary.cui-composer-send), or Stop while busy with `stop` (unless `whileBusy: 'send'`). */
  sendButton: HTMLButtonElement;
  /** With `stop` and `whileBusy: 'send'`: Stop (button.cui-btn.cui-danger.cui-composer-stop) before Send in the row, hidden unless busy. Otherwise null. */
  stopButton: HTMLButtonElement | null;
}

/**
 * Append a message box to `el`. It grows with its text up to 40% of the screen; Enter sends on desktop
 * and adds a line at 800px and under (Shift+Enter always adds one); it never sends half an IME word;
 * a numbered list continues; text is 16px on phones; the form pads for the phone's home bar.
 * Link /apps/_citadel/theme.css and ui/base.css for its look.
 */
export function mountComposer(el: Element, opts: ComposerOptions): Composer;

/** Grow (or shrink) a textarea to fit its text, bounded by its CSS min-height and max-height. For your other text boxes. */
export function fitHeight(textarea: HTMLTextAreaElement): void;

/** What Enter does at `start`–`end` in `value` when the caret's line is a numbered item: the edit to make, or null when Enter does what it always does. */
export function listEnter(value: string, start: number, end: number): { from: number; to: number; text: string } | null;

/**
 * Continue a numbered list on the new-line key in `textarea`, from its keydown handler; true when it did,
 * so don't send. That key is Shift+Enter, or plain Enter too when `enterAddsLine` (phones). For your
 * other text boxes; the composer does this itself.
 */
export function continueList(textarea: HTMLTextAreaElement, e: KeyboardEvent, enterAddsLine?: boolean): boolean;
