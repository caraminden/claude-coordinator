// Citadel UI: the four states every page draws: loading, failed (with a retry), empty, and tabs. Served to apps as
// /apps/_citadel/ui/state.js (types: state.d.ts beside it); their look is base.css's cui-loading, cui-failed,
// cui-empty and cui-tabs. Docs: kit/skills/contraption-ui/SKILL.md. Cara 2026-11-16: "UI reflowing without a user
// input should be avoided", so give a loading line the height of what replaces it with your own min-height rule.
//
// Standalone like every file in public/ui/: no imports, no inline styles, cui-* classes.

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

/** A loading line: a spinner and `text` in div.cui-loading, role="status". */
export function loadingLine(text = 'Loading…') {
  const box = el('div', 'cui-loading');
  box.setAttribute('role', 'status');
  const spin = el('span', 'cui-spin');
  spin.setAttribute('aria-hidden', 'true');
  box.append(spin, el('span', 'cui-loading-text', text));
  return box;
}

/** A failure line: `text` and, when `retry` is given, a Retry button (label overridable) that calls it. */
export function failedLine(text, { retry, label = 'Retry' } = {}) {
  const box = el('div', 'cui-failed');
  box.setAttribute('role', 'alert');
  box.append(el('span', 'cui-failed-text', text));
  if (retry) {
    const b = el('button', 'cui-btn cui-small', label);
    b.type = 'button';
    b.addEventListener('click', () => retry());
    box.append(b);
  }
  return box;
}

/** An empty state: a mark, a title and what would fill it. `tone` is a chip tone (default ok: empty is good). */
export function emptyState(title, line, { mark = '✓', tone = 'ok' } = {}) {
  const box = el('div', 'cui-empty');
  box.dataset.tone = tone;
  const m = el('span', 'cui-empty-mark', mark);
  m.setAttribute('aria-hidden', 'true');
  const text = el('div', 'cui-empty-text');
  text.append(el('b', null, title));
  if (line) text.append(el('span', null, line));
  box.append(m, text);
  return box;
}

/**
 * A row of tabs (div.cui-tabs, role="tablist"). `items` is [key, label | Node] pairs; `onSelect(key)` runs on every click
 * (the picked tab's too) and on an arrow key (then with { keyboard: true } as a second argument, so a page that redraws the row can focus the new one). Returns { element, set(key), current }. `set` changes the picked tab without
 * calling onSelect. The picked tab is the one with aria-selected="true", so a page that sets it itself stays in step.
 */
export function tabs({ items, current, onSelect, label, className = '' }) {
  const box = el('div', `cui-tabs ${className}`.trim());
  box.setAttribute('role', 'tablist');
  if (label) box.setAttribute('aria-label', label);
  const buttons = items.map(([key, content]) => {
    const b = el('button', 'cui-tab');
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.dataset.key = key;
    b.append(content instanceof Node ? content : document.createTextNode(content));
    b.addEventListener('click', () => {
      show(key);
      onSelect?.(key);
    });
    return b;
  });
  const now = () => buttons.find((b) => b.getAttribute('aria-selected') === 'true')?.dataset.key;
  function show(key) {
    for (const b of buttons) {
      const on = b.dataset.key === key;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    }
  }
  box.addEventListener('keydown', (e) => {
    const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!d) return;
    const i = buttons.findIndex((b) => b.dataset.key === now());
    const next = buttons[(i + d + buttons.length) % buttons.length];
    show(next.dataset.key);
    next.focus();
    onSelect?.(next.dataset.key, { keyboard: true });
    e.preventDefault();
  });
  box.append(...buttons);
  show(current ?? items[0]?.[0]);
  return {
    element: box,
    set: show,
    get current() {
      return now();
    },
  };
}
