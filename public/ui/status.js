// Citadel UI: a steady status line and steady labels. Served to apps as /apps/_citadel/ui/status.js (types:
// status.d.ts beside it); their look is base.css's cui-status and cui-steady. Docs:
// kit/skills/contraption-ui/SKILL.md. Cara 2026-11-04 (in Theory of Crafting): "set up rules that make sure
// status changes like that dont move any UI elements".
//
// Every file in public/ui/ is standalone, because apps load it from outside Citadel's pages:
// - no imports from outside ui/; nothing it writes carries style="" or <style>;
// - classes are cui-*, and every rule sits in :where(), so an app's own selectors win;
// - its exports and their behaviour are an API apps depend on: test/ui-contract.test.ts holds them.
//   Add, never rename; a real break ships as a new file beside this one.
//
// What it does: statusSlot() keeps a status line drawn at a fixed height, empty when there's nothing to say,
// so saying something (or nothing) never moves what's around it. Its text stays one line, cut off with an
// ellipsis, with the whole of it in the kit tooltip (data-tip-overflow: ui/tip.js shows it only while it's
// cut off). steadyLabel() stacks every label a button can show in one grid cell and shows one, so the
// button keeps the width of its widest label. Both work from plain markup too: this module only writes it,
// and the *Html() builders write the same markup as strings, escaped, for views that draw HTML. toast()
// says something in passing in the top layer, so it takes no room at all, with a button (Retry) when it has one.

const TONES = new Set(['ok', 'warn', 'danger', 'info', 'violet', 'neutral']);

/** Make `el` a status line (div.cui-status, role="status") and return its controls. */
export function statusSlot(el) {
  el.classList.add('cui-status');
  if (!el.hasAttribute('role')) el.setAttribute('role', 'status');
  const show = (text, tone, working) => {
    if (tone && TONES.has(tone)) el.dataset.tone = tone;
    else delete el.dataset.tone;
    if (!text && !working) return el.replaceChildren();
    const line = document.createElement('span');
    line.className = 'cui-status-text';
    line.textContent = text;
    line.dataset.tip = text;
    line.setAttribute('data-tip-overflow', '');
    if (!working) return el.replaceChildren(line);
    const spin = document.createElement('span');
    spin.className = 'cui-spin';
    spin.setAttribute('aria-hidden', 'true');
    el.replaceChildren(spin, line);
  };
  return {
    element: el,
    text: (text, opts = {}) => show(text ?? '', opts.tone),
    working: (text = 'Working…') => show(text, null, true),
    clear: () => show('', null),
  };
}

/**
 * Put `labels` in `el` (a button, usually) as a cui-steady stack, showing `current` (default the first). The
 * element keeps the width of the widest label whichever shows. A label is text, or a Node (a spinner and text).
 */
export function steadyLabel(el, labels, current) {
  const stack = document.createElement('span');
  stack.className = 'cui-steady';
  const parts = new Map();
  for (const [key, label] of Object.entries(labels)) {
    const part = document.createElement('span');
    part.dataset.label = key;
    part.append(label);
    parts.set(key, part);
    stack.append(part);
  }
  el.replaceChildren(stack);
  let shown = null;
  const set = (key) => {
    if (!parts.has(key)) throw new Error(`steadyLabel: no label "${key}"`);
    for (const [k, part] of parts) part.hidden = k !== key;
    shown = key;
  };
  set(current ?? parts.keys().next().value);
  return {
    element: stack,
    set,
    get current() {
      return shown;
    },
  };
}

// The same markup as strings, for views that draw HTML. Text is escaped here; `inner` is HTML you made.
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);
const toneAttr = (tone) => (TONES.has(tone) ? ` data-tone="${tone}"` : '');

/** A status line as HTML (a span, so it can sit in a heading): `inner` is statusTextHtml() and the like, or ''. */
export function statusSlotHtml(inner = '', opts = {}) {
  const cls = ['cui-status', opts.fill && 'cui-status-fill', opts.className].filter(Boolean).join(' ');
  return `<span class="${esc(cls)}" role="status"${toneAttr(opts.tone)}>${inner}</span>`;
}

/** One line of status text as HTML: cut off with an ellipsis, whole in its tip; a tone colours this text alone. */
export const statusTextHtml = (text, opts = {}) =>
  `<span class="cui-status-text"${toneAttr(opts.tone)} data-tip="${esc(text)}" data-tip-overflow>${esc(text)}</span>`;

/** A spinner and what's running, as HTML for a status line. */
export const statusWorkingHtml = (text = 'Working…') => `<span class="cui-spin" aria-hidden="true"></span>${statusTextHtml(text)}`;

/** steadyLabel()'s stack as HTML: every label (text) in one cell, showing `current` (default the first). */
export function steadyLabelHtml(labels, current) {
  const keys = Object.keys(labels);
  const show = current ?? keys[0];
  if (!keys.includes(show)) throw new Error(`steadyLabel: no label "${show}"`);
  const parts = keys.map((k) => `<span data-label="${esc(k)}"${k === show ? '' : ' hidden'}>${esc(labels[k])}</span>`);
  return `<span class="cui-steady">${parts.join('')}</span>`;
}

let pop = null;
let say = null;
let timer = 0;
let onHide = null;

/** The topmost open modal dialog, or null (also where :modal isn't supported). */
function topModal() {
  try { return [...document.querySelectorAll('dialog:modal')].at(-1) ?? null; } catch { return null; }
}

function hideToast() {
  clearTimeout(timer);
  if (pop?.matches(':popover-open')) pop.hidePopover();
  if (say) say.textContent = '';
  const f = onHide;
  onHide = null;
  f?.();
}

/**
 * Say `text` in passing: a toast at the bottom centre, in the top layer, for `ms` (default 4 s) or until it's
 * tapped. One at a time: a new one replaces the last. A screen reader hears it from a live region. `action`
 * ({ label, run }) adds a button after the text that runs `run` and sends the toast away (Retry); `onHide` is
 * called once when this toast goes, however it goes (its time, a tap, its action, a newer toast).
 */
export function toast(text, opts = {}) {
  if (!pop?.isConnected) {
    pop = document.createElement('div');
    pop.className = 'cui-toast';
    pop.setAttribute('popover', 'manual');
    pop.addEventListener('click', hideToast);
    say = document.createElement('div');
    say.className = 'cui-toast-say';
    say.setAttribute('role', 'status');
    document.body.append(pop, say);
  }
  hideToast();
  // Inside the topmost open modal dialog, if any: everything outside one is inert, so its button couldn't be clicked nor its words heard.
  const home = topModal() ?? document.body;
  if (pop.parentNode !== home) home.append(pop, say);
  if (TONES.has(opts.tone)) pop.dataset.tone = opts.tone;
  else delete pop.dataset.tone;
  pop.textContent = text;
  // The live region says the text; the toast itself is hidden from a screen reader unless it has a button to reach.
  pop.toggleAttribute('aria-hidden', !opts.action);
  if (opts.action) {
    const line = document.createElement('span');
    line.className = 'cui-toast-text';
    line.textContent = text;
    const act = document.createElement('button');
    act.type = 'button';
    act.className = 'cui-btn cui-small cui-toast-action';
    act.textContent = opts.action.label;
    act.addEventListener('click', () => opts.action.run());
    pop.replaceChildren(line, act);
  }
  pop.showPopover();
  onHide = opts.onHide ?? null;
  // A frame later, so a live region made just now is in place before it changes and is heard.
  requestAnimationFrame(() => pop.matches(':popover-open') && (say.textContent = text));
  timer = setTimeout(hideToast, opts.ms ?? 4000);
}
