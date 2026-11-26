// Citadel UI: chat. Served to apps as /apps/_citadel/ui/chat.js (types: chat.d.ts beside it). An app's
// agent chat, drawn from Citadel's turn API events: a reply's text, one row per run of tool steps that
// collapses ("✓ 5 steps · 1 Grunt ▸"), running Grunts under it with their own steps and clock, and notices.
// The look is take A of #282 (Cara, 2026-11-02). Docs: kit/skills/contraption-ui/SKILL.md.
//
// Every file in public/ui/ is standalone, because apps load it from outside Citadel's pages:
// - no imports from outside ui/;
// - styles come from a constructed sheet adopted on first use (Citadel's CSP is default-src 'self');
// - nothing it writes carries style="" or <style>;
// - classes are cui-*, and every rule sits in :where(), so an app's own selectors win;
// - its exports and their behaviour are an API apps depend on: test/ui-contract.test.ts holds them.
//   Add, never rename; a real break ships as a new file beside this one.
//
// Three layers: chatModel (pure: turns in, blocks out; from Theory of Crafting's chat-model.ts),
// renderChat (pure: the model as HTML, which the contract test stores), and mountChat (the live log,
// patched in place from the same HTML so a selection, a focused row and a screen reader's place survive).
import { renderMarkdown, updateMarkdown } from './markdown.js';

/** @import { Block, ChatItem, ChatOptions, RenderOptions, Step, Turn, TurnEvent } from './chat.js' */
/** @import { MarkdownOptions } from './markdown.js' */
/** @typedef {Step & { steps: Step[] }} GruntStep A Grunt's step: always has its own list. */
/** @typedef {Extract<Block, { kind: 'card' }>} CardBlock */
/** @typedef {Extract<Block, { kind: 'steps' }>} RunBlock */
/** @typedef {Block extends infer B ? (B extends { id: string } ? Omit<B, 'id'> : never) : never} BlockBody A block before it gets its id. */
/** @typedef {(name: string, input: Record<string, unknown>, id: string) => boolean} CardTest */
/** @typedef {{ stepLabel?: RenderOptions['stepLabel'], markdown?: RenderOptions['markdown'], now: number, open: Set<string>, retry?: boolean }} DrawOpts What the HTML drawing reads. */
/** @typedef {HTMLElement & { src?: string, streaming?: boolean, html?: string }} DrawnNode A block's node, with the last source it was drawn from. */
/** @typedef {{ el: HTMLDivElement, reply: HTMLDivElement, blocks: Map<string, DrawnNode>, choices: HTMLElement | null }} TurnNodes */
/** @typedef {{ isCard: boolean, el: HTMLElement | null, done: boolean }} CardSlot */

/** @param {unknown} s */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => /** @type {Record<string, string>} */ ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
/** @param {unknown} at */
const time = (at) => (typeof at === 'number' ? at : typeof at === 'string' && !Number.isNaN(Date.parse(at)) ? Date.parse(at) : undefined);
/**
 * @param {number} n
 * @param {string} word
 */
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
/** @param {unknown} name */
const isAgent = (name) => name === 'Agent' || name === 'Task';

/**
 * Who a Grunt is, from its Agent call's input: its description, else its agent type, else "Grunt".
 * @type {typeof import('./chat.js').gruntName}
 */
export function gruntName(input) {
  const from = /** @type {{ description?: unknown, subagent_type?: unknown } | null | undefined} */ (input);
  const name = /** @type {string | undefined} */ ([from?.description, from?.subagent_type].find((s) => typeof s === 'string' && s.trim()));
  return name ? name.trim() : 'Grunt';
}

/**
 * Milliseconds as "41s" or "1m 12s".
 * @type {typeof import('./chat.js').duration}
 */
export function duration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

/**
 * The default step label: `mcp__mandate__move_todo` as "Move todo".
 * @param {unknown} name
 */
const defaultLabel = (name) => {
  const short = String(name ?? '')
    .replace(/^mcp__.+?__/, '')
    .replace(/_/g, ' ');
  return short.charAt(0).toUpperCase() + short.slice(1);
};

// ---- The model ----

/**
 * One turn as blocks. `card(name, input, id)` says a top-level call is the app's own card, not a step.
 * @param {Turn} turn
 * @param {number} k
 * @param {boolean} last
 * @param {CardTest | undefined} card
 * @returns {ChatItem}
 */
function turnModel(turn, k, last, card) {
  /** @type {Block[]} */
  const blocks = [];
  /** @type {Step[]} */
  const steps = []; // every step, Grunts' too, to stop the running ones when the turn ends
  /** @type {Map<string, Step>} */
  const byId = new Map(); // a call's id → its step
  /** @type {Map<string, GruntStep>} */
  const owner = new Map(); // a Grunt's call id (and its nested Agent calls') → its top-level Grunt row
  /** @type {Map<string, CardBlock>} */
  const cards = new Map();
  let ended = false;
  /** @param {BlockBody} b */
  const add = (b) => {
    const block = /** @type {Block} */ ({ id: `${k}.${blocks.length}`, ...b });
    blocks.push(block);
    return block;
  };
  for (const e of turn.events ?? []) {
    const d = e?.data ?? {};
    const at = time(e?.at);
    if (e?.type === 'text') {
      // A Grunt's words never stream (turn API); a new message id is a new paragraph.
      if (d.parent != null) continue;
      const delta = String(d.delta ?? '');
      const prev = blocks.at(-1);
      if (prev?.kind === 'text' && prev.message === (d.message ?? null)) prev.text += delta;
      else if (delta) add({ kind: 'text', message: /** @type {string | null} */ (d.message ?? null), text: delta });
    } else if (e?.type === 'tool') {
      const id = String(d.id);
      const name = String(d.name ?? '');
      const input = /** @type {Record<string, unknown>} */ (d.input && typeof d.input === 'object' ? d.input : {});
      /** @type {Step} */
      const step = { id, name, input, state: 'running', start: at };
      if (isAgent(name)) Object.assign(step, { grunt: true, steps: [] });
      if (d.parent != null) {
        const row = owner.get(String(d.parent));
        if (!row) continue;
        row.steps.push(step);
        owner.set(id, row);
      } else if (!step.grunt && card?.(name, input, id)) {
        cards.set(id, /** @type {CardBlock} */ (add({ kind: 'card', tool: id, name, input, result: undefined })));
        continue;
      } else {
        const prev = blocks.at(-1);
        (prev?.kind === 'steps' ? prev : /** @type {RunBlock} */ (add({ kind: 'steps', steps: [] }))).steps.push(step);
        if (step.grunt) owner.set(id, /** @type {GruntStep} */ (step));
      }
      byId.set(id, step);
      steps.push(step);
    } else if (e?.type === 'tool_result') {
      const id = String(d.id);
      const step = byId.get(id);
      if (step) Object.assign(step, { state: d.ok ? 'done' : 'failed', end: at });
      const c = cards.get(id);
      // All of the event's data (an app may add its own fields), with the id as the call's and ok a boolean.
      if (c) c.result = { ...d, id, ok: !!d.ok };
    } else if (e?.type === 'error') {
      ended = true;
      if (d.code === 'canceled') add({ kind: 'stopped' });
      // Cut off by a restart (#1382): the newest turn offers Retry when the turn API does (not on a second cut in a row).
      else if (d.code === 'interrupted' && d.retry === true && last) add({ kind: 'error', code: 'interrupted', message: String(d.message ?? ''), retry: true });
      else add({ kind: 'error', code: String(d.code ?? 'failed'), message: String(d.message ?? '') });
    } else if (e?.type === 'end') {
      ended = true;
    }
  }
  // A turn runs until it ends, fails or a later one starts; then whatever was still running stopped.
  const running = !ended && last;
  if (!running) for (const s of steps) if (s.state === 'running') s.state = 'stopped';
  return { ask: turn.ask ?? null, blocks, running };
}

/**
 * Turns as the chat draws them. Pure: tests and servers run it without a page.
 * @type {typeof import('./chat.js').chatModel}
 */
export function chatModel(turns, opts = {}) {
  const items = (turns ?? []).map((t, k) => turnModel(t, k, k === turns.length - 1, opts.card));
  return { items, running: !!items.at(-1)?.running };
}

// ---- The drawing, as HTML ----

/** @type {Record<string, string>} */
const STATE_WORD = { running: 'Running', done: 'Done', failed: 'Failed', stopped: 'Stopped' };
/** @type {Record<string, string>} */
const MARK = { done: '✓', failed: '✕', stopped: '–' };
/** @param {string} state */
const markHtml = (state) => (state === 'running' ? '<span class="cui-spin" role="img" aria-label="Running"></span>' : `<span class="cui-mark" data-state="${esc(state)}" role="img" aria-label="${STATE_WORD[state] ?? esc(state)}">${MARK[state] ?? '·'}</span>`);

/**
 * A step's or Grunt's clock: ticking from `data-since` while it runs, fixed once it ends, none without a start.
 * @param {Step} s
 * @param {number} now
 */
const clockHtml = (s, now) => {
  if (s.start == null) return '';
  if (s.state === 'running') return `<span class="cui-time" data-since="${s.start}">${duration(now - s.start)}</span>`;
  return s.end != null ? `<span class="cui-time">${duration(s.end - s.start)}</span>` : '';
};

/**
 * @param {Step} s
 * @param {RenderOptions['stepLabel']} stepLabel
 */
const labelOf = (s, stepLabel) => (s.grunt ? `Grunt · ${gruntName(s.input)}` : (stepLabel?.(s.name, s.input) ?? defaultLabel(s.name)));

/**
 * @param {Step} s
 * @param {DrawOpts} o
 */
function stepHtml(s, o) {
  return `<li class="cui-step" data-state="${s.state}">${markHtml(s.state)}<span class="cui-step-label">${esc(labelOf(s, o.stepLabel))}</span>${clockHtml(s, o.now)}</li>`;
}

/**
 * @param {GruntStep} g
 * @param {DrawOpts} o
 * @param {boolean} withSteps
 */
function gruntHtml(g, o, withSteps) {
  const list = withSteps && g.steps.length ? `<ul class="cui-steps">${g.steps.map((s) => stepHtml(s, o)).join('')}</ul>` : '';
  return `<div class="cui-grunt" data-state="${g.state}"><div class="cui-grunt-head">${markHtml(g.state)}<span class="cui-grunt-task">${esc(labelOf(g, o.stepLabel))}</span>${clockHtml(g, o.now)}</div>${list}</div>`;
}

/**
 * A run of steps as one row: the step in hand while it runs, a count once done; open, the list.
 * @param {RunBlock} b
 * @param {DrawOpts} o
 */
function runHtml(b, o) {
  const open = !!o.open?.has(b.id);
  const n = b.steps.length;
  const now = b.steps.findLast((s) => s.state === 'running');
  const failed = b.steps.filter((s) => s.state === 'failed').length;
  const grunts = b.steps.filter((s) => s.grunt).length;
  const state = now ? 'running' : failed ? 'failed' : b.steps.some((s) => s.state === 'stopped') ? 'stopped' : 'done';
  const label = now ? `<b>${esc(now.grunt ? gruntName(now.input) : labelOf(now, o.stepLabel))}…</b> · step ${n}` : [plural(n, 'step'), grunts ? plural(grunts, 'Grunt') : '', failed ? `${failed} failed` : ''].filter(Boolean).join(' · ');
  const body = open
    ? `<ul class="cui-steps">${b.steps.map((s) => (s.grunt ? `<li class="cui-step-grunt">${gruntHtml(/** @type {GruntStep} */ (s), o, true)}</li>` : stepHtml(s, o))).join('')}</ul>`
    : b.steps
        .filter((s) => s.grunt && s.state === 'running')
        .map((g) => gruntHtml(/** @type {GruntStep} */ (g), o, true))
        .join('');
  return `<div class="cui-run" data-state="${state}" data-key="${esc(b.id)}"><button type="button" class="cui-run-head" aria-expanded="${open}">${markHtml(state)}<span class="cui-run-label">${label}</span><span class="cui-chev" aria-hidden="true">${open ? '▾' : '▸'}</span></button>${body}</div>`;
}

/** What Retry sends after a cut-off turn: the session's transcript holds the work so far, so the agent carries on from it. */
export const RETRY_SAY = 'Your last turn was cut off before it finished. Carry on from where you were.';

/**
 * @param {Block} b
 * @param {DrawOpts} o
 * @param {boolean} streaming
 */
function blockHtml(b, o, streaming) {
  switch (b.kind) {
    case 'text':
      return `<div class="cui-md">${renderMarkdown(b.text, mdOpts(o.markdown, streaming))}</div>`;
    case 'steps':
      return runHtml(b, o);
    case 'card':
      return '<div class="cui-card"></div>';
    case 'stopped':
      return '<div class="cui-stopped">Stopped.</div>';
    case 'error': {
      const notice = `<div class="cui-notice" data-tone="danger"><b>Couldn't finish:</b> ${esc(b.message || b.code)}</div>`;
      // A live chat with onReply only: the tap sends RETRY_SAY as the person's message, in the same session.
      return b.retry && o.retry ? `<div>${notice}<div class="cui-choices"><button type="button" class="cui-choice" data-say="${esc(RETRY_SAY)}">Retry</button></div></div>` : notice;
    }
  }
  return '';
}

/**
 * The kit's markdown options with the app's hooks (`markdown`: text, link, image) over them; nothing else of the app's.
 * @param {RenderOptions['markdown']} hooks
 * @param {boolean} streaming
 * @returns {MarkdownOptions}
 */
const mdOpts = (hooks, streaming) => {
  const { text, link, image } = hooks ?? {};
  return { ...(text && { text }), ...(link && { link }), ...(image && { image }), breaks: true, streaming };
};

/** @param {string | null | undefined} text */
const askHtml = (text) => (text == null ? '' : `<div class="cui-ask">${esc(text)}</div>`);

/**
 * The chat as HTML (no live parts: cards are empty slots, clocks read at `now`). For a server, a print view or a test.
 * @type {typeof import('./chat.js').renderChat}
 */
export function renderChat(turns, opts = {}) {
  const o = { ...opts, now: opts.now ?? Date.now(), open: new Set(opts.open ?? []) };
  return chatModel(turns, /** @type {{ card?: CardTest }} */ (opts))
    .items.map((t) => `<div class="cui-turn">${askHtml(t.ask)}<div class="cui-reply">${t.blocks.map((b, i) => blockHtml(b, o, t.running && i === t.blocks.length - 1)).join('')}</div></div>`)
    .join('');
}

/**
 * A step's state as its mark: a spinner while running, else ✓, ✕ or – with its state as the label.
 * @type {typeof import('./chat.js').stepMark}
 */
export function stepMark(state) {
  adoptStyles();
  return /** @type {HTMLSpanElement} */ (fromHtml(markHtml(state)));
}

// ---- In the page ----

const CSS = `
:where(.cui-chat) { display: flex; flex-direction: column; overflow-y: auto; overscroll-behavior: contain; color: var(--citadel-text); font: var(--citadel-size-body)/1.5 var(--citadel-font); }
:where(.cui-log) { display: flex; flex-direction: column; gap: var(--citadel-space-3); padding: var(--citadel-space-3); }
:where(.cui-turn) { display: flex; flex-direction: column; gap: var(--citadel-space-3); }
:where(.cui-ask) {
  align-self: flex-end; max-width: 85%; box-sizing: border-box; padding: var(--citadel-space-2) var(--citadel-space-3);
  white-space: pre-wrap; overflow-wrap: anywhere; border-radius: var(--citadel-radius-lg);
  background: color-mix(in srgb, var(--citadel-accent) 9%, var(--citadel-surface));
  border: 1px solid color-mix(in srgb, var(--citadel-accent) 30%, var(--citadel-border));
}
:where(.cui-reply) { display: flex; flex-direction: column; gap: var(--citadel-space-2); min-width: 0; }
:where(.cui-reply:empty, .cui-card:empty) { display: none; }
:where(.cui-run) { border: 1px solid var(--citadel-border); border-radius: var(--citadel-radius); background: var(--citadel-surface); font-size: var(--citadel-size-small); }
:where(.cui-run-head) {
  display: flex; align-items: center; gap: var(--citadel-space-2); width: 100%; box-sizing: border-box; margin: 0;
  padding: 6px var(--citadel-space-3); border: 0; border-radius: inherit; background: none; cursor: pointer;
  font: inherit; line-height: 1.4; color: var(--citadel-muted); text-align: left;
}
:where(.cui-run-label) { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
:where(.cui-run-label b) { color: var(--citadel-text); font-weight: 600; }
:where(.cui-run[data-state="failed"] > .cui-run-head) { color: var(--citadel-danger); }
:where(.cui-run-head:focus) { outline: none; }
:where(.cui-run-head:focus-visible) { outline: 2px solid var(--citadel-focus); outline-offset: -2px; }
:where(.cui-chev) { flex: none; }
@media (max-width: 800px) { :where(.cui-run-head) { min-height: var(--citadel-control-h); } }
:where(.cui-steps) { list-style: none; margin: 0; padding: 0 var(--citadel-space-3) 6px; }
:where(.cui-step, .cui-grunt-head) { display: flex; align-items: center; gap: var(--citadel-space-2); padding: 3px 0; line-height: 1.4; }
:where(.cui-step-label, .cui-grunt-task) { flex: 1; min-width: 0; overflow-wrap: anywhere; }
:where(.cui-grunt-task) { color: var(--citadel-text); }
:where(.cui-run .cui-time) { flex: none; color: var(--citadel-muted); font-variant-numeric: tabular-nums; }
:where(.cui-mark) { display: inline-block; flex: none; width: 1em; text-align: center; color: var(--citadel-muted); }
:where(.cui-mark[data-state="done"]) { color: var(--citadel-ok); }
:where(.cui-mark[data-state="failed"]) { color: var(--citadel-danger); }
:where(.cui-grunt) { margin: 0 var(--citadel-space-3) 6px; padding: 3px var(--citadel-space-2); border-radius: var(--citadel-radius-sm); background: var(--citadel-bg); }
:where(.cui-steps .cui-grunt) { margin: 3px 0; }
:where(.cui-grunt .cui-steps) { padding: 0 0 0 22px; }
:where(.cui-stopped) { color: var(--citadel-muted); font-size: var(--citadel-size-small); }
:where(.cui-empty.cui-chat-empty) { margin: auto; padding: var(--citadel-space-3) var(--citadel-space-5); color: var(--citadel-muted); text-align: center; }
:where(.cui-live) { padding: 0 var(--citadel-space-3); }
:where(.cui-live > .cui-working) { margin-bottom: var(--citadel-space-2); }
:where(.cui-latest) { position: sticky; bottom: var(--citadel-space-3); align-self: center; margin-top: auto; }
:where(.cui-latest[hidden]) { display: none; }
`;
let sheet = false;
function adoptStyles() {
  if (sheet) return;
  sheet = true;
  // Safari before 16.4 can't construct sheets: there the chat draws unstyled rather than not at all.
  try {
    const s = new CSSStyleSheet();
    s.replaceSync(CSS);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, s];
  } catch {}
}

/**
 * @param {string} html
 * @returns {HTMLElement}
 */
function fromHtml(html) {
  const t = document.createElement('template');
  t.innerHTML = html;
  return /** @type {HTMLElement} */ (t.content.firstElementChild);
}

/**
 * Make `a` look like `b`, keeping every node that can stay: so focus, a selection and a reader's place survive.
 * @param {ChildNode} a
 * @param {ChildNode} b
 * @returns {void}
 */
function morph(a, b) {
  if (a.nodeType !== b.nodeType || a.nodeName !== b.nodeName) return void a.replaceWith(b);
  if (a.nodeType !== 1) {
    if (a.nodeValue !== b.nodeValue) a.nodeValue = b.nodeValue;
    return;
  }
  const ea = /** @type {Element} */ (a);
  const eb = /** @type {Element} */ (b);
  for (const { name } of [...ea.attributes]) if (!eb.hasAttribute(name)) ea.removeAttribute(name);
  for (const { name, value } of eb.attributes) if (ea.getAttribute(name) !== value) ea.setAttribute(name, value);
  const ac = [...a.childNodes];
  [...b.childNodes].forEach((c, i) => (ac[i] ? morph(ac[i], c) : ea.append(c)));
  for (const n of ac.slice(b.childNodes.length)) n.remove();
}

// Follow new output only within this many pixels of the bottom (Citadel's rule, core.js).
const BOTTOM_SLACK = 24;

/**
 * Mount a chat in `el`, which scrolls: give it a height (flex: 1; min-height: 0 in a column).
 * @type {typeof import('./chat.js').mountChat}
 */
export function mountChat(el, opts = {}) {
  adoptStyles();
  /** @param {string} cls */
  const div = (cls) => Object.assign(document.createElement('div'), { className: cls });
  el.classList.add('cui-chat');
  const empty = div('cui-empty cui-chat-empty');
  empty.textContent = opts.empty ?? '';
  const log = div('cui-log');
  // The only live region: what the agent is doing when nothing else in the log shows it.
  const live = div('cui-live');
  live.setAttribute('aria-live', 'polite');
  const latest = Object.assign(document.createElement('button'), { type: 'button', className: 'cui-btn cui-small cui-latest', textContent: 'Latest ↓', hidden: true });
  el.replaceChildren(empty, log, live, latest);

  /** @type {Turn[]} */
  let turns = [];
  /** @type {TurnNodes[]} */
  let nodes = []; // per turn: { el, reply, blocks: Map(block id → node), choices }
  /** @type {Set<string>} */
  const open = new Set();
  /** @type {Map<string, CardSlot>} */
  const cardEls = new Map(); // tool id → { isCard, el, done }
  let follow = true;
  let frame = 0;
  let tick = 0;
  let dirty = 0; // the first turn to redraw

  /** @type {CardTest} */
  const card = (name, input, id) => {
    if (!opts.block) return false;
    if (!cardEls.has(id)) {
      const el = opts.block(name, input, undefined) ?? null;
      // Settled by this first call: a result drawn as null empties the card, and the blocks after it keep their ids.
      cardEls.set(id, { isCard: !!el, el, done: false });
    }
    return /** @type {CardSlot} */ (cardEls.get(id)).isCard;
  };

  /**
   * @param {number} k
   * @param {ChatItem} t
   */
  function drawTurn(k, t) {
    let n = nodes[k];
    if (!n) {
      n = nodes[k] = { el: div('cui-turn'), reply: div('cui-reply'), blocks: new Map(), choices: null };
      if (t.ask != null) n.el.append(fromHtml(askHtml(t.ask)));
      n.el.append(n.reply);
      log.append(n.el);
    }
    const o = { stepLabel: opts.stepLabel, now: Date.now(), open, retry: !!opts.onReply };
    t.blocks.forEach((b, i) => {
      let node = n.blocks.get(b.id);
      if (b.kind === 'text') {
        const streaming = t.running && i === t.blocks.length - 1;
        node ??= div('');
        if (node.src !== b.text || node.streaming !== streaming) updateMarkdown(node, b.text, mdOpts(opts.markdown, streaming));
        Object.assign(node, { src: b.text, streaming });
      } else if (b.kind === 'card') {
        node ??= div('cui-card');
        const c = /** @type {CardSlot} */ (cardEls.get(b.tool));
        if (b.result && !c.done) Object.assign(c, { el: opts.block?.(b.name, b.input, b.result) ?? null, done: true });
        if (node.firstChild !== c.el) node.replaceChildren(...(c.el ? [c.el] : []));
      } else {
        const html = blockHtml(b, o, false);
        if (!node) node = fromHtml(html);
        else if (node.html !== html) morph(node, fromHtml(html));
        node.html = html;
      }
      if (!n.blocks.has(b.id)) {
        n.blocks.set(b.id, node);
        n.reply.append(node);
      }
    });
  }

  function draw() {
    frame = 0;
    const m = chatModel(turns, { card });
    empty.hidden = turns.length > 0 || !opts.empty;
    for (let k = dirty; k < m.items.length; k++) drawTurn(k, m.items[k]);
    dirty = Math.max(0, m.items.length - 1);
    // "Thinking…" only while nothing else shows progress: no text arriving, no step or Grunt running.
    const last = m.items.at(-1)?.blocks.at(-1);
    const busy = m.running && !(last?.kind === 'text' || (last?.kind === 'steps' && last.steps.some((s) => s.state === 'running')));
    if (busy !== !!live.firstChild) live.replaceChildren(...(busy ? [fromHtml('<div class="cui-working"><span class="cui-spin"></span>Thinking…</div>')] : []));
    for (const c of nodes.flatMap((n) => (n.choices ? /** @type {HTMLButtonElement[]} */ ([...n.choices.children]) : []))) if (m.running) c.disabled = true;
    // Once it ends, chips given while it ran come alive: the newest reply's, unless one was already tapped.
    const newest = nodes.at(-1)?.choices;
    if (!m.running && newest && !newest.querySelector('[aria-pressed="true"]')) for (const c of /** @type {Iterable<HTMLButtonElement>} */ (newest.children)) c.disabled = false;
    clearInterval(tick);
    if (m.running) tick = setInterval(ticks, 1000);
    stick();
  }
  let gone = false; // destroyed: a late push (an SSE still open) draws nothing and starts no clock
  const schedule = () => gone || (frame ||= requestAnimationFrame(draw));
  // Timers tick their own text, nothing else redraws.
  const ticks = () => {
    for (const t of /** @type {NodeListOf<HTMLElement>} */ (el.querySelectorAll('.cui-time[data-since]'))) t.textContent = duration(Date.now() - Number(t.dataset.since));
  };

  // Following the end: only a person can let go of it, by scrolling up with a gesture. Content that
  // grows (a card filling in), a box that shrinks (an undo bar, a phone keyboard) and the scroll events
  // of the kit's own moves, however late, keep it at the end (#287).
  let lastTop = 0;
  let pressed = false; // a finger or pointer is down on the log (a drag, the scrollbar)
  let personUntil = 0; // scrolls before this are a person's: just after a gesture, and a fling's tail
  const PERSON_MS = 500;
  const stick = () => {
    if (follow) el.scrollTop = el.scrollHeight;
  };
  const onScroll = () => {
    const now = performance.now();
    const byPerson = pressed || now < personUntil;
    if (byPerson) personUntil = Math.max(personUntil, now + 150);
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - BOTTOM_SLACK) follow = true;
    else if (follow && byPerson && el.scrollTop < lastTop) follow = false;
    else stick();
    lastTop = el.scrollTop;
    latest.hidden = follow;
  };
  /** @param {Event} e */
  const gesture = (e) => {
    if (e.type === 'touchstart' || e.type === 'pointerdown') pressed = true;
    personUntil = performance.now() + PERSON_MS;
  };
  const release = () => {
    if (!pressed) return;
    pressed = false;
    personUntil = performance.now() + PERSON_MS; // a fling keeps going after the finger lifts
  };
  const sized = typeof ResizeObserver === 'function' ? new ResizeObserver(stick) : null;
  /** @param {MouseEvent} e */
  const onClick = (e) => {
    const target = /** @type {Element} */ (e.target);
    const head = target.closest('.cui-run-head');
    if (head && el.contains(head)) {
      const key = /** @type {string} */ (/** @type {HTMLElement} */ (head.parentElement).dataset.key);
      if (!open.delete(key)) open.add(key);
      dirty = 0;
      return draw();
    }
    const chip = /** @type {HTMLButtonElement | null} */ (target.closest('.cui-choice[data-say]'));
    if (chip && el.contains(chip) && !chip.disabled) {
      // Every chip in the log, not just its row: a Retry and the app's reply chips can both be live (#1382).
      for (const c of /** @type {NodeListOf<HTMLButtonElement>} */ (el.querySelectorAll('.cui-choice'))) c.disabled = true;
      chip.setAttribute('aria-pressed', 'true');
      opts.onReply?.(/** @type {string} */ (chip.dataset.say));
    }
  };
  const toLatest = () => {
    el.scrollTop = el.scrollHeight;
    follow = true;
    latest.hidden = true;
  };
  el.addEventListener('scroll', onScroll, { passive: true });
  for (const type of ['wheel', 'touchstart', 'touchmove', 'pointerdown']) el.addEventListener(type, gesture, { passive: true });
  // Keys scroll the log with focus on the page's body (after a click in it), so they're heard on document.
  document.addEventListener('keydown', gesture, { passive: true });
  for (const type of ['touchend', 'touchcancel', 'pointerup', 'pointercancel']) document.addEventListener(type, release, { passive: true });
  sized?.observe(el);
  sized?.observe(log);
  el.addEventListener('click', onClick);
  latest.addEventListener('click', toLatest);

  const now = () => {
    cancelAnimationFrame(frame);
    if (!gone) draw();
  };
  const lastEnded = () => turns.at(-1)?.events.some((e) => e.type === 'end' || e.type === 'error');

  const chat = {
    /**
     * The chat's history: replaces whatever it shows.
     * @param {Turn[]} list
     */
    load(list) {
      turns = (list ?? []).map((t) => ({ ask: t.ask, events: [...(t.events ?? [])] }));
      nodes = [];
      dirty = 0;
      open.clear();
      log.replaceChildren();
      follow = true;
      now();
    },
    /**
     * Your message: a new turn starts with it.
     * @param {string} text
     */
    ask(text) {
      for (const n of nodes) {
        for (const c of /** @type {Iterable<HTMLButtonElement>} */ (n.choices?.children ?? [])) {
          c.disabled = true;
          if (c.dataset.say === text && !n.choices?.querySelector('[aria-pressed="true"]')) c.setAttribute('aria-pressed', 'true');
        }
      }
      turns.push({ ask: text, events: [] });
      follow = true;
      now();
    },
    /**
     * One turn-API event ({ type, data }), as it arrives. One after a turn ended starts a turn of its own.
     * @param {TurnEvent} event
     */
    push(event) {
      if (!turns.length || lastEnded()) turns.push({ ask: null, events: [] });
      /** @type {Turn} */ (turns.at(-1)).events.push({ ...event, at: event.at ?? Date.now() });
      schedule();
    },
    /**
     * Chips under the newest reply; a tap calls onReply(message). [] clears them.
     * @param {{ label: string, message?: string, recommended?: boolean }[]} list
     */
    replies(list) {
      now();
      const n = nodes.at(-1);
      if (!n) return;
      n.choices?.remove();
      n.choices = null;
      if (!list?.length) return;
      n.choices = fromHtml(`<div class="cui-choices">${list.map((c) => `<button type="button" class="cui-choice${c.recommended ? ' cui-rec' : ''}" data-say="${esc(c.message ?? c.label)}"${c.message && c.message !== c.label ? ` title="${esc(c.message)}"` : ''}>${esc(c.label)}</button>`).join('')}</div>`);
      n.el.append(n.choices);
      if (chatModel(turns).running) for (const c of /** @type {Iterable<HTMLButtonElement>} */ (n.choices.children)) c.disabled = true;
      stick();
    },
    destroy() {
      gone = true;
      nodes = [];
      cancelAnimationFrame(frame);
      clearInterval(tick);
      el.removeEventListener('scroll', onScroll);
      for (const type of ['wheel', 'touchstart', 'touchmove', 'pointerdown']) el.removeEventListener(type, gesture);
      document.removeEventListener('keydown', gesture);
      for (const type of ['touchend', 'touchcancel', 'pointerup', 'pointercancel']) document.removeEventListener(type, release);
      sized?.disconnect();
      el.removeEventListener('click', onClick);
      el.replaceChildren();
      el.classList.remove('cui-chat');
    },
  };
  now();
  return chat;
}
