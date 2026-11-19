// A scheme's message settings (#1059): the loop guard's count and window, when a silent recipient counts as cold, and how
// long cold mail may wait. One home for the defaults, the bounds and every sentence that quotes them, so the tool text
// and the "Held" lists never carry a typed number. The defaults are what the constants were before they were settings.
export interface MsgSettings {
  /** Messages between a pair (both ways) that go through per window before the next is held. */
  loopLimit: number;
  /** The loop guard's window, in minutes. */
  loopMin: number;
  /** Minutes idle before a recipient is cold and non-urgent mail to it is held. */
  coldMin: number;
  /** Hours cold mail may wait before it wakes its recipient anyway. */
  holdH: number;
}
export const MSG_DEFAULTS: MsgSettings = { loopLimit: 6, loopMin: 10, coldMin: 55, holdH: 3 };
/** Inclusive bounds. Cold stays at or under 55: past an hour the prompt cache has lapsed, so holding saves nothing. */
export const MSG_BOUNDS: Record<keyof MsgSettings, [number, number]> = { loopLimit: [3, 20], loopMin: [5, 60], coldMin: [10, 55], holdH: [1, 12] };
export const MSG_COLUMNS: Record<keyof MsgSettings, string> = { loopLimit: 'msg_loop_limit', loopMin: 'msg_loop_min', coldMin: 'msg_cold_min', holdH: 'msg_hold_h' };

type Row = Partial<Record<(typeof MSG_COLUMNS)[keyof MsgSettings], number>>;
/** A scheme's settings from its row; a missing or out-of-range column reads as the default. */
export function msgSettings(project?: Row | null): MsgSettings {
  const out = { ...MSG_DEFAULTS };
  for (const k of Object.keys(MSG_COLUMNS) as (keyof MsgSettings)[]) {
    const v = project?.[MSG_COLUMNS[k]];
    if (Number.isInteger(v) && v! >= MSG_BOUNDS[k][0] && v! <= MSG_BOUNDS[k][1]) out[k] = v!;
  }
  return out;
}
/** The turn env value (COORDINATOR_MSG), or undefined at the defaults so a scheme that changed nothing keeps its prompt hash. */
export const msgEnv = (s: MsgSettings): string | undefined => (JSON.stringify(s) === JSON.stringify(MSG_DEFAULTS) ? undefined : `${s.loopLimit},${s.loopMin},${s.coldMin},${s.holdH}`);
/** The settings the thread MCP server was launched with. */
export function msgFromEnv(v: string | undefined): MsgSettings {
  const [loopLimit, loopMin, coldMin, holdH] = (v ?? '').split(',').map(Number);
  return v ? msgSettings({ msg_loop_limit: loopLimit, msg_loop_min: loopMin, msg_cold_min: coldMin, msg_hold_h: holdH }) : { ...MSG_DEFAULTS };
}
/** A PATCH body's four fields (any may be missing), refused outside the bounds. */
export function cleanMsgSettings(body: Record<string, unknown>): Row {
  const out: Row = {};
  for (const k of Object.keys(MSG_COLUMNS) as (keyof MsgSettings)[]) {
    const col = MSG_COLUMNS[k], v = body[col];
    if (v === undefined) continue;
    const [lo, hi] = MSG_BOUNDS[k];
    if (!Number.isInteger(v) || (v as number) < lo || (v as number) > hi) throw new Error(`${col} must be a whole number from ${lo} to ${hi}`);
    out[col] = v as number;
  }
  return out;
}
/** "a message" wording shared by the paused notes and the tool results. */
export const loopText = (s: MsgSettings) => `${s.loopLimit} messages in ${s.loopMin} minutes`;
/** What message_ticket, message_coordinator and message_minion say when the loop guard holds a message. */
export const heldToolText = (s: MsgSettings, who: string) => `Held, not delivered: ${who} have exchanged as many messages as the loop guard allows (${loopText(s)}), so it waits for a person to continue. Do not resend it.`;
/** What the sender is told when the recipient is cold. */
export const coldToolText = (s: MsgSettings, who: string) => `Left as held mail: ${who} has been idle over ${s.coldMin} minutes, so its prompt cache (1 hour) is lapsing and waking it would re-read its whole context. It shows in its chat now and reaches it with its next turn: a person's message, or within ${s.holdH} hours. Do not resend it. If it must act now after all, send a short follow-up with urgent: true, which wakes it with this one too.`;
