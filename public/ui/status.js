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
// button keeps the width of its widest label. Both work from plain markup too: this module only writes it.

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
