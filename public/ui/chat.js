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

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const time = (at) => (typeof at === 'number' ? at : typeof at === 'string' && !Number.isNaN(Date.parse(at)) ? Date.parse(at) : undefined);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const isAgent = (name) => name === 'Agent' || name === 'Task';

/** Who a Grunt is, from its Agent call's input: its description, else its agent type, else "Grunt". */
export function gruntName(input) {
  const name = [input?.description, input?.subagent_type].find((s) => typeof s === 'string' && s.trim());
  return name ? name.trim() : 'Grunt';
}

/** Milliseconds as "41s" or "1m 12s". */
export function duration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

/** The default step label: `mcp__mandate__move_todo` as "Move todo". */
const defaultLabel = (name) => {
  const short = String(name ?? '').replace(/^mcp__.+?__/, '').replace(/_/g, ' ');
  return short.charAt(0).toUpperCase() + short.slice(1);
};

// ---- The model ----

/** One turn as blocks. `card(name, input, id)` says a top-level call is the app's own card, not a step. */
function turnModel(turn, k, last, card) {
  const blocks = [];
  const steps = []; // every step, Grunts' too, to stop the running ones when the turn ends
  const byId = new Map(); // a call's id → its step
  const owner = new Map(); // a Grunt's call id (and its nested Agent calls') → its top-level Grunt row
  const cards = new Map();
  let ended = false;
  const add = (b) => {
    const block = { id: `${k}.${blocks.length}`, ...b };
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
      else if (delta) add({ kind: 'text', message: d.message ?? null, text: delta });
    } else if (e?.type === 'tool') {
      const id = String(d.id);
      const name = String(d.name ?? '');
      const input = d.input && typeof d.input === 'object' ? d.input : {};
      const step = { id, name, input, state: 'running', start: at };
      if (isAgent(name)) Object.assign(step, { grunt: true, steps: [] });
      if (d.parent != null) {
        const row = owner.get(String(d.parent));
        if (!row) continue;
        row.steps.push(step);
        owner.set(id, row);
      } else if (!step.grunt && card?.(name, input, id)) {
        cards.set(id, add({ kind: 'card', tool: id, name, input, result: undefined }));
        continue;
      } else {
        const prev = blocks.at(-1);
        (prev?.kind === 'steps' ? prev : add({ kind: 'steps', steps: [] })).steps.push(step);
        if (step.grunt) owner.set(id, step);
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

/** Turns as the chat draws them. Pure: tests and servers run it without a page. */
export function chatModel(turns, opts = {}) {
  const items = (turns ?? []).map((t, k) => turnModel(t, k, k === turns.length - 1, opts.card));
  return { items, running: !!items.at(-1)?.running };
}

// ---- The drawing, as HTML ----

const STATE_WORD = { running: 'Running', done: 'Done', failed: 'Failed', stopped: 'Stopped' };
const MARK = { done: '✓', failed: '✕', stopped: '–' };
const markHtml = (state) => (state === 'running'
  ? '<span class="cui-spin" role="img" aria-label="Running"></span>'
  : `<span class="cui-mark" data-state="${esc(state)}" role="img" aria-label="${STATE_WORD[state] ?? esc(state)}">${MARK[state] ?? '·'}</span>`);

/** A step's or Grunt's clock: ticking from `data-since` while it runs, fixed once it ends, none without a start. */
const clockHtml = (s, now) => {
  if (s.start == null) return '';
  if (s.state === 'running') return `<span class="cui-time" data-since="${s.start}">${duration(now - s.start)}</span>`;
  return s.end != null ? `<span class="cui-time">${duration(s.end - s.start)}</span>` : '';
};

const labelOf = (s, stepLabel) => (s.grunt ? `Grunt · ${gruntName(s.input)}` : (stepLabel?.(s.name, s.input) ?? defaultLabel(s.name)));

function stepHtml(s, o) {
  return `<li class="cui-step" data-state="${s.state}">${markHtml(s.state)}<span class="cui-step-label">${esc(labelOf(s, o.stepLabel))}</span>${clockHtml(s, o.now)}</li>`;
}

function gruntHtml(g, o, withSteps) {
  const list = withSteps && g.steps.length ? `<ul class="cui-steps">${g.steps.map((s) => stepHtml(s, o)).join('')}</ul>` : '';
  return `<div class="cui-grunt" data-state="${g.state}"><div class="cui-grunt-head">${markHtml(g.state)}<span class="cui-grunt-task">${esc(labelOf(g, o.stepLabel))}</span>${clockHtml(g, o.now)}</div>${list}</div>`;
}

/** A run of steps as one row: the step in hand while it runs, a count once done; open, the list. */
function runHtml(b, o) {
  const open = !!o.open?.has(b.id);
  const n = b.steps.length;
  const now = b.steps.findLast((s) => s.state === 'running');
  const failed = b.steps.filter((s) => s.state === 'failed').length;
  const grunts = b.steps.filter((s) => s.grunt).length;
  const state = now ? 'running' : failed ? 'failed' : b.steps.some((s) => s.state === 'stopped') ? 'stopped' : 'done';
  const label = now
    ? `<b>${esc(now.grunt ? gruntName(now.input) : labelOf(now, o.stepLabel))}…</b> · step ${n}`
    : [plural(n, 'step'), grunts ? plural(grunts, 'Grunt') : '', failed ? `${failed} failed` : ''].filter(Boolean).join(' · ');
  const body = open
    ? `<ul class="cui-steps">${b.steps.map((s) => (s.grunt ? `<li class="cui-step-grunt">${gruntHtml(s, o, true)}</li>` : stepHtml(s, o))).join('')}</ul>`
    : b.steps.filter((s) => s.grunt && s.state === 'running').map((g) => gruntHtml(g, o, true)).join('');
  return `<div class="cui-run" data-state="${state}" data-key="${esc(b.id)}"><button type="button" class="cui-run-head" aria-expanded="${open}">${markHtml(state)}<span class="cui-run-label">${label}</span><span class="cui-chev" aria-hidden="true">${open ? '▾' : '▸'}</span></button>${body}</div>`;
}

function blockHtml(b, o, streaming) {
  switch (b.kind) {
    case 'text': return `<div class="cui-md">${renderMarkdown(b.text, mdOpts(o.markdown, streaming))}</div>`;
    case 'steps': return runHtml(b, o);
    case 'card': return '<div class="cui-card"></div>';
    case 'stopped': return '<div class="cui-stopped">Stopped.</div>';
    case 'error': return `<div class="cui-notice" data-tone="danger"><b>Couldn't finish:</b> ${esc(b.message || b.code)}</div>`;
  }
  return '';
}

/** The kit's markdown options with the app's hooks (`markdown`: text, link, image) over them; nothing else of the app's. */
const mdOpts = (hooks, streaming) => {
  const { text, link, image } = hooks ?? {};
  return { ...(text && { text }), ...(link && { link }), ...(image && { image }), breaks: true, streaming };
};

const askHtml = (text) => (text == null ? '' : `<div class="cui-ask">${esc(text)}</div>`);

/** The chat as HTML (no live parts: cards are empty slots, clocks read at `now`). For a server, a print view or a test. */
export function renderChat(turns, opts = {}) {
  const o = { ...opts, now: opts.now ?? Date.now(), open: new Set(opts.open ?? []) };
  return chatModel(turns, opts).items.map((t) => `<div class="cui-turn">${askHtml(t.ask)}<div class="cui-reply">${t.blocks.map((b, i) => blockHtml(b, o, t.running && i === t.blocks.length - 1)).join('')}</div></div>`).join('');
}

/** A step's state as its mark: a spinner while running, else ✓, ✕ or – with its state as the label. */
export function stepMark(state) {
  adoptStyles();
  return fromHtml(markHtml(state));
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
:where(.cui-empty) { margin: auto; padding: var(--citadel-space-3) var(--citadel-space-5); color: var(--citadel-muted); text-align: center; }
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

function fromHtml(html) {
  const t = document.createElement('template');
  t.innerHTML = html;
  return t.content.firstElementChild;
}

/** Make `a` look like `b`, keeping every node that can stay: so focus, a selection and a reader's place survive. */
function morph(a, b) {
  if (a.nodeType !== b.nodeType || a.nodeName !== b.nodeName) return void a.replaceWith(b);
  if (a.nodeType !== 1) {
    if (a.nodeValue !== b.nodeValue) a.nodeValue = b.nodeValue;
    return;
  }
  for (const { name } of [...a.attributes]) if (!b.hasAttribute(name)) a.removeAttribute(name);
  for (const { name, value } of b.attributes) if (a.getAttribute(name) !== value) a.setAttribute(name, value);
  const ac = [...a.childNodes];
  [...b.childNodes].forEach((c, i) => (ac[i] ? morph(ac[i], c) : a.append(c)));
  for (const n of ac.slice(b.childNodes.length)) n.remove();
}

// Follow new output only within this many pixels of the bottom (Citadel's rule, core.js).
const BOTTOM_SLACK = 24;

/** Mount a chat in `el`, which scrolls: give it a height (flex: 1; min-height: 0 in a column). */
export function mountChat(el, opts = {}) {
  adoptStyles();
  const div = (cls) => Object.assign(document.createElement('div'), { className: cls });
  el.classList.add('cui-chat');
  const empty = div('cui-empty');
  empty.textContent = opts.empty ?? '';
  const log = div('cui-log');
  // The only live region: what the agent is doing when nothing else in the log shows it.
  const live = div('cui-live');
  live.setAttribute('aria-live', 'polite');
  const latest = Object.assign(document.createElement('button'), { type: 'button', className: 'cui-btn cui-small cui-latest', textContent: 'Latest ↓', hidden: true });
  el.replaceChildren(empty, log, live, latest);

  let turns = [];
  let nodes = []; // per turn: { el, reply, blocks: Map(block id → node), choices }
  const open = new Set();
  const cardEls = new Map(); // tool id → { el, done }
  let follow = true;
  let frame = 0;
  let tick = 0;
  let dirty = 0; // the first turn to redraw

  const card = (name, input, id) => {
    if (!opts.block) return false;
    if (!cardEls.has(id)) cardEls.set(id, { el: opts.block(name, input, undefined) ?? null, done: false });
    return !!cardEls.get(id).el;
  };

  function drawTurn(k, t) {
    let n = nodes[k];
    if (!n) {
      n = nodes[k] = { el: div('cui-turn'), reply: div('cui-reply'), blocks: new Map(), choices: null };
      if (t.ask != null) n.el.append(fromHtml(askHtml(t.ask)));
      n.el.append(n.reply);
      log.append(n.el);
    }
    const o = { stepLabel: opts.stepLabel, now: Date.now(), open };
    t.blocks.forEach((b, i) => {
      let node = n.blocks.get(b.id);
      if (b.kind === 'text') {
        const streaming = t.running && i === t.blocks.length - 1;
        node ??= div('');
        if (node.src !== b.text || node.streaming !== streaming) updateMarkdown(node, b.text, mdOpts(opts.markdown, streaming));
        Object.assign(node, { src: b.text, streaming });
      } else if (b.kind === 'card') {
        node ??= div('cui-card');
        const c = cardEls.get(b.tool);
        if (b.result && !c.done) Object.assign(c, { el: opts.block(b.name, b.input, b.result) ?? null, done: true });
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
    for (const c of nodes.flatMap((n) => (n.choices ? [...n.choices.children] : []))) if (m.running) c.disabled = true;
    clearInterval(tick);
    if (m.running) tick = setInterval(ticks, 1000);
    stick();
  }
  let gone = false; // destroyed: a late push (an SSE still open) draws nothing and starts no clock
  const schedule = () => gone || (frame ||= requestAnimationFrame(draw));
  // Timers tick their own text, nothing else redraws.
  const ticks = () => {
    for (const t of el.querySelectorAll('.cui-time[data-since]')) t.textContent = duration(Date.now() - Number(t.dataset.since));
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
  const onClick = (e) => {
    const head = e.target.closest('.cui-run-head');
    if (head && el.contains(head)) {
      const key = head.parentElement.dataset.key;
      if (!open.delete(key)) open.add(key);
      dirty = 0;
      return draw();
    }
    const chip = e.target.closest('.cui-choice[data-say]');
    if (chip && el.contains(chip) && !chip.disabled) {
      for (const c of chip.parentElement.children) c.disabled = true;
      chip.setAttribute('aria-pressed', 'true');
      opts.onReply?.(chip.dataset.say);
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
    /** The chat's history: replaces whatever it shows. */
    load(list) {
      turns = (list ?? []).map((t) => ({ ask: t.ask, events: [...(t.events ?? [])] }));
      nodes = [];
      dirty = 0;
      open.clear();
      log.replaceChildren();
      follow = true;
      now();
    },
    /** Your message: a new turn starts with it. */
    ask(text) {
      for (const n of nodes) {
        for (const c of n.choices?.children ?? []) {
          c.disabled = true;
          if (c.dataset.say === text && !n.choices.querySelector('[aria-pressed="true"]')) c.setAttribute('aria-pressed', 'true');
        }
      }
      turns.push({ ask: text, events: [] });
      follow = true;
      now();
    },
    /** One turn-API event ({ type, data }), as it arrives. One after a turn ended starts a turn of its own. */
    push(event) {
      if (!turns.length || lastEnded()) turns.push({ ask: null, events: [] });
      turns.at(-1).events.push({ ...event, at: event.at ?? Date.now() });
      schedule();
    },
    /** Chips under the newest reply; a tap calls onReply(message). [] clears them. */
    replies(list) {
      now();
      const n = nodes.at(-1);
      if (!n) return;
      n.choices?.remove();
      n.choices = null;
      if (!list?.length) return;
      n.choices = fromHtml(`<div class="cui-choices">${list.map((c) => `<button type="button" class="cui-choice${c.recommended ? ' cui-rec' : ''}" data-say="${esc(c.message ?? c.label)}"${c.message && c.message !== c.label ? ` title="${esc(c.message)}"` : ''}>${esc(c.label)}</button>`).join('')}</div>`);
      n.el.append(n.choices);
      if (chatModel(turns).running) for (const c of n.choices.children) c.disabled = true;
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
