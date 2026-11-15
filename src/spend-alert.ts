/**
 * Runaway-turn spend alert (#723): a running turn's cost, estimated from its stream, and the stages
 * ($25, $50, $100 to start) at which people hear about it.
 *
 * The stream's input side is exact (each API message's input, cache read and cache write tokens arrive
 * with its first event), but its output_tokens is the message_start snapshot, a handful of tokens, not
 * the final count. So output is estimated as 3x the visible output (text plus tool inputs, 4 characters
 * a token), the rest being thinking. On the 14 turns over $20 in the week to Nov 14 that lands within
 * 10% of the turn's real cost on 13, the worst 15% low; test/spend-alert.test.ts checks three of them.
 * Grunts' messages stream too (with parent_tool_use_id) and count, as they're most of a big turn's cost.
 * Codex turns don't stream Claude usage and aren't metered.
 */

/** Dollars per million tokens: input, output, cache read. Cache writes cost input x1.25 (5 min) or x2 (1 h). */
const PRICES: [family: RegExp, input: number, output: number, cacheRead: number][] = [
  [/fable|mythos/, 8, 40, 0.2],
  [/opus/, 4, 20, 0.2],
  [/sonnet/, 2, 10, 0.1],
  [/haiku/, 0.1, 0.5, 0.01],
];

/** Starting stages in dollars (the handoff's), until a scheme sets its own. */
export const DEFAULT_STAGES = [25, 50, 100];
/** The Citadel-wide setting holding the stages, a list of dollar amounts. */
export const STAGES_SETTING = 'spend_alert_stages';

/** Visible output tokens are this share of all output; the rest is thinking (calibrated, see above). */
const OUTPUT_PER_VISIBLE = 3;
const CHARS_PER_TOKEN = 4;

export function priceFor(model: unknown): { input: number; output: number; cacheRead: number } | null {
  if (typeof model !== 'string') return null;
  const row = PRICES.find(([family]) => family.test(model));
  return row ? { input: row[1], output: row[2], cacheRead: row[3] } : null;
}

/** Characters of a message's visible output: text blocks and tool inputs as sent. */
export function visibleChars(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const b of content) {
    if (b?.type === 'text' && typeof b.text === 'string') n += b.text.length;
    else if (b?.type === 'tool_use' && b.input !== undefined) n += JSON.stringify(b.input)?.length ?? 0;
  }
  return n;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/** One API message's input side in dollars, and its output price per token; null for a model without a price. */
function inputSide(model: unknown, usage: any): { input: number; outPrice: number } | null {
  const p = priceFor(model);
  if (!p || !usage || typeof usage !== 'object') return null;
  const cc = usage.cache_creation && typeof usage.cache_creation === 'object' ? usage.cache_creation : null;
  const w5 = cc ? num(cc.ephemeral_5m_input_tokens) : num(usage.cache_creation_input_tokens);
  const w1 = cc ? num(cc.ephemeral_1h_input_tokens) : 0;
  const input = (num(usage.input_tokens) * p.input + num(usage.cache_read_input_tokens) * p.cacheRead + (w5 * 1.25 + w1 * 2) * p.input) / 1e6;
  return { input, outPrice: p.output / 1e6 };
}

/** What a turn's meter keeps across a restart, in its TurnState. */
export interface SpendState {
  /** The estimate so far, in dollars. */
  usd: number;
  /** How many stages have fired. */
  fired: number;
  /** Someone picked Keep going: no more alerts this turn. */
  muted?: string;
  /** The last alert: the stage it passed, its chat card's event and when, for the minions list and Needs you. */
  alert?: { stage: number; event: number; at: number };
}

/**
 * A turn's alert nobody has answered (#723; Cara, 2026-11-14: "This should show on the minion list view as an alert",
 * "it could show up in your inbox"): the stage passed, the estimate now and the card's event; null once Keep going
 * was picked or before any stage fired. The runner drops a turn's spend with its turn, so no turn means none.
 */
export function openSpend(spend: SpendState | undefined): { stage: number; usd: number; event: number; at: number } | null {
  return spend?.alert && !spend.muted ? { ...spend.alert, usd: Math.round(num(spend.usd)) } : null;
}

interface Message { input: number; outPrice: number; snapshot: number; chars: number; cost: number }

/**
 * A turn's running cost. Each content block streams as its own event under the same message id with the
 * usage repeated, so usage counts once per id while visible output adds up across its events.
 * The ids are kept in memory only: after a restart a message split across it counts its input twice, which is cents.
 */
export class SpendMeter {
  usd: number;
  fired: number;
  muted?: string;
  alert?: { stage: number; event: number; at: number };
  private messages = new Map<string, Message>();

  constructor(state: SpendState = { usd: 0, fired: 0 }) {
    this.usd = num(state.usd);
    this.fired = Math.max(0, Math.floor(num(state.fired)));
    if (state.muted) this.muted = state.muted;
    const a = state.alert;
    if (a && Number.isFinite(a.stage) && Number.isInteger(a.event) && Number.isFinite(a.at)) this.alert = { stage: a.stage, event: a.event, at: a.at };
  }

  get state(): SpendState {
    return { usd: this.usd, fired: this.fired, ...(this.muted ? { muted: this.muted } : {}), ...(this.alert ? { alert: this.alert } : {}) };
  }

  /** Count a stream event (a no-op for anything but an assistant message with usage); true if the estimate moved. */
  add(ev: any): boolean {
    if (ev?.type !== 'assistant' || typeof ev.message?.id !== 'string') return false;
    const m = ev.message;
    return this.addMessage(m.id, m.model, m.usage, visibleChars(m.content));
  }

  /** Count one event of an API message: its usage (counted once per id) and `chars` more visible output. */
  addMessage(id: string, model: unknown, usage: any, chars: number): boolean {
    let msg = this.messages.get(id);
    if (!msg) {
      const side = inputSide(model, usage);
      if (!side) return false;
      msg = { ...side, snapshot: num(usage.output_tokens), chars: 0, cost: 0 };
      this.messages.set(id, msg);
    }
    msg.chars += chars;
    const output = Math.max(msg.snapshot, (OUTPUT_PER_VISIBLE * msg.chars) / CHARS_PER_TOKEN);
    const cost = msg.input + output * msg.outPrice;
    if (cost === msg.cost) return false;
    this.usd += cost - msg.cost;
    msg.cost = cost;
    return true;
  }

  /**
   * The stage the estimate has newly passed, if one fires: each fires once, and passing several at once
   * fires only the highest. Nothing fires once muted (the stages still count, so unmuting can't replay them).
   */
  crossed(stages: number[]): number | null {
    let passed = 0;
    while (passed < stages.length && this.usd >= stages[passed]) passed++;
    if (passed <= this.fired) return null;
    this.fired = passed;
    return this.muted ? null : stages[passed - 1];
  }
}

/** The stages to use: the setting's list when it's a usable one (positive amounts, sorted), else the defaults. */
export function stagesFrom(setting: unknown): number[] {
  if (!Array.isArray(setting)) return DEFAULT_STAGES;
  const stages = setting.filter((n): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0).sort((a, b) => a - b);
  return stages.length ? stages : DEFAULT_STAGES;
}

/** The alert's words, as in the handoff: "This turn has used about $30 in 70 min." */
export function spendText(usd: number, ms: number): string {
  return `This turn has used about $${Math.round(usd)} in ${Math.max(1, Math.round(ms / 60_000))} min.`;
}
