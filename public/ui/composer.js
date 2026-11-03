// Citadel UI: the message box under a chat. Served to apps as /apps/_citadel/ui/composer.js (types:
// composer.d.ts beside it); Citadel's own composer (public/composer.js) is built on it, so both behave
// the same. Docs: kit/skills/contraption-ui/SKILL.md.
//
// Every file in public/ui/ is standalone, because apps load it from outside Citadel's pages:
// - no imports from outside ui/;
// - styles come from a constructed sheet adopted on first use (Citadel's CSP is default-src 'self');
// - nothing it writes carries style="" or <style> (a CSSOM write such as el.style.height is fine: CSP
//   doesn't block those, and autogrow needs one);
// - classes are cui-*, and every rule sits in :where(), so an app's own selectors win;
// - its exports and their behaviour are an API apps depend on: test/ui-contract.test.ts holds them.
//   Add, never rename; a real break ships as a new file beside this one.
//
// What it does: grows with its text up to 40% of the screen; Enter sends on desktop and adds a line on
// a phone (Shift+Enter always adds one); never sends half an IME word; continues a numbered list; puts
// the text back when a send fails; Send becomes Stop while busy (with whileBusy 'send', Stop shows
// beside Send, which keeps sending: for a server that queues a message sent mid-turn, as Citadel's does);
// 16px text on phones so iOS doesn't zoom; optional drafts in localStorage. Buttons and the box take base.css's cui-* classes.

const NARROW = '(max-width: 800px)';
const narrow = () => matchMedia(NARROW).matches;

const CSS = `
:where(.cui-composer) {
  display: flex; flex-wrap: wrap; align-items: flex-end; gap: var(--citadel-space-2);
  margin: 0 0 env(safe-area-inset-bottom, 0px); padding: var(--citadel-space-2);
  background: var(--citadel-surface); border: 1px solid var(--citadel-border); border-radius: var(--citadel-radius-lg);
}
:where(.cui-composer:has(.cui-composer-input:focus-visible)) { outline: 2px solid var(--citadel-focus); outline-offset: 2px; }
:where(.cui-composer-error) { flex-basis: 100%; }
/* No border of its own, so one line is control-h tall, level with Send. */
:where(.cui-composer-input) {
  flex: 1; min-width: 0; border: 0; background: transparent; outline: none;
  resize: none; overflow-y: auto; max-height: 40vh; padding: calc((var(--citadel-control-h) - 1.25em) / 2) var(--citadel-space-1);
}
:where(.cui-composer-row) { display: flex; align-items: center; gap: var(--citadel-space-2); }
@media (max-width: 800px) { :where(.cui-composer-input) { font-size: 16px; } }
`;
let sheet = false;
function adoptStyles() {
  if (sheet) return;
  sheet = true;
  // Safari before 16.4 can't construct sheets: there the box works unstyled rather than not at all.
  try {
    const s = new CSSStyleSheet();
    s.replaceSync(CSS);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, s];
  } catch {}
}

const loadDraft = (key) => {
  try { return JSON.parse(localStorage.getItem(key)) ?? null; } catch { return null; }
};
const saveDraft = (key, value) => {
  try {
    if (value) localStorage.setItem(key, JSON.stringify(value));
    else localStorage.removeItem(key);
  } catch {}
};

/** Grow (or shrink) a textarea to fit its text; its CSS min-height and max-height bound it. */
export function fitHeight(box) {
  // Collapsing to 'auto' can shorten the page for a moment and move the scroll: put it back after,
  // and keep a chat that was at its end there, so the growing box doesn't cover the last message.
  const scrolled = [document.scrollingElement, box.closest('.chat')].filter(Boolean)
    .map((el) => [el, el.scrollTop, el.scrollTop >= el.scrollHeight - el.clientHeight - 2]);
  box.style.height = 'auto';
  // Not laid out (a folded panel, or a phone's drawer still tucked away): keep the CSS height.
  if (!box.scrollHeight) box.style.height = '';
  else box.style.height = `${box.scrollHeight + box.offsetHeight - box.clientHeight}px`;
  for (const [el, top, atEnd] of scrolled) el.scrollTop = atEnd ? el.scrollHeight : top;
}

// ---------- numbered lists ----------
// The key that adds a line (Shift+Enter, or Enter where Enter doesn't send) on a "1. …" line starts
// "2. ", and on an empty item after the first ends the list.

const ITEM = /^( *)(\d{1,9})([.)])(?:[ \t]+(.*)|$)/;

/**
 * What Enter does at `start`–`end` in `value` when the caret's line is a numbered item:
 * { from, to, text } to replace, or null when Enter should do what it always does.
 */
export function listEnter(value, start, end) {
  if (start !== end) return null;
  const lineStart = value.lastIndexOf('\n', start - 1) + 1;
  const m = ITEM.exec(value.slice(lineStart, start));
  if (!m) return null;
  const [, indent, num, delim, rest = ''] = m;
  const prev = value.slice(value.lastIndexOf('\n', lineStart - 2) + 1, Math.max(lineStart - 1, 0));
  // An empty item that follows another ends the list; "1." on its own still starts one.
  if (!rest.trim() && !value.slice(start).split('\n', 1)[0].trim() && lineStart && ITEM.test(prev)) {
    return { from: lineStart, to: start, text: '' };
  }
  return { from: start, to: start, text: `\n${indent}${Number(num) + 1}${delim} ` };
}

/**
 * Handles the new-line key on a numbered item in `textarea`; true when it did, so the caller doesn't
 * send. That key is Shift+Enter, or plain Enter too when `enterAddsLine` (phones, where Enter doesn't send).
 */
export function continueList(textarea, e, enterAddsLine = false) {
  if (e.key !== 'Enter' || !(e.shiftKey || enterAddsLine) || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return false;
  const edit = listEnter(textarea.value, textarea.selectionStart, textarea.selectionEnd);
  if (!edit) return false;
  e.preventDefault();
  textarea.setSelectionRange(edit.from, edit.to);
  // insertText keeps Ctrl+Z working and fires input, which saves the draft and resizes the box.
  if (!(edit.text ? document.execCommand('insertText', false, edit.text) : document.execCommand('delete'))) {
    textarea.setRangeText(edit.text, edit.from, edit.to, 'end');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  }
  revealCaret(textarea);
  return true;
}

// A scripted insert doesn't scroll the box the way a typed newline does, so the new item could sit
// below its bottom edge: measure the text up to the caret in a hidden copy and scroll down to it.
function revealCaret(textarea) {
  const copy = textarea.cloneNode();
  copy.removeAttribute('id');
  copy.style.cssText += `;position:absolute;visibility:hidden;box-sizing:border-box;height:0;min-height:0;width:${textarea.offsetWidth}px`;
  copy.value = textarea.value.slice(0, textarea.selectionEnd);
  textarea.after(copy);
  const caretBottom = copy.scrollHeight;
  copy.remove();
  if (caretBottom > textarea.scrollTop + textarea.clientHeight) textarea.scrollTop = caretBottom - textarea.clientHeight;
}

// ---------- the composer ----------

const make = (tag, props, ...children) => {
  const el = Object.assign(document.createElement(tag), props);
  el.append(...children);
  return el;
};

/**
 * A message box appended to `el`: a form.cui-composer holding a one-line textarea and, beside it, a row
 * with Send. Returns
 * its controls; see composer.d.ts for the options and what each does.
 */
export function mountComposer(el, opts) {
  adoptStyles();
  const { draftKey } = opts;
  const textarea = make('textarea', { className: 'cui-input cui-composer-input', rows: 1, placeholder: opts.placeholder ?? '' });
  // Without a label the placeholder names the box, and follows it when the app changes it.
  if (opts.label || !opts.placeholder) textarea.setAttribute('aria-label', opts.label || 'Message');
  const sendButton = make('button', { type: 'submit', className: 'cui-btn cui-primary cui-composer-send' }, 'Send');
  const error = make('div', { className: 'cui-notice cui-composer-error', hidden: true });
  error.dataset.tone = 'danger';
  error.setAttribute('role', 'alert');
  // whileBusy 'send': Stop is its own button, shown beside Send while busy, and Send keeps sending.
  const stopBeside = !!opts.stop && opts.whileBusy === 'send';
  const stopButton = stopBeside ? make('button', { type: 'button', className: 'cui-btn cui-danger cui-composer-stop', hidden: true }, 'Stop') : null;
  stopButton?.addEventListener('click', () => opts.stop());
  const row = make('div', { className: 'cui-composer-row' }, ...(stopButton ? [stopButton] : []), sendButton);
  const form = make('form', { className: 'cui-composer' }, error, textarea, row);
  el.append(form);

  let busy = false;
  let sending = 0;
  const stopping = () => busy && !!opts.stop && !stopBeside;
  const render = () => {
    const stop = stopping();
    sendButton.textContent = stop ? 'Stop' : 'Send';
    sendButton.classList.toggle('cui-primary', !stop);
    sendButton.classList.toggle('cui-danger', stop);
    // While a message is on its way Send waits (a second tap would find the box empty anyway); Stop never does.
    sendButton.disabled = !stop && sending > 0;
    form.toggleAttribute('data-busy', busy);
    if (stopButton) stopButton.hidden = !busy;
  };
  sendButton.addEventListener('click', (e) => {
    if (!stopping()) return;
    // Cancelled first: stop() may end busy at once, and this click would then submit as Send.
    e.preventDefault();
    opts.stop();
  });

  const fit = () => fitHeight(textarea);
  const save = () => draftKey && saveDraft(draftKey, textarea.value);
  if (draftKey) textarea.value = loadDraft(draftKey) ?? '';
  requestAnimationFrame(fit);
  textarea.addEventListener('input', () => {
    fit();
    save();
  });

  textarea.addEventListener('keydown', (e) => {
    // Leave Enter alone while an IME is composing, or it would send half a word. Safari fires the
    // Enter that ends a composition after compositionend, with isComposing false but keyCode 229.
    if (e.isComposing || e.keyCode === 229) return;
    if (continueList(textarea, e, narrow())) return;
    // On a phone Enter adds a line; the Send button sends.
    if (e.key === 'Enter' && !e.shiftKey && !narrow()) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (stopping()) return;
    const text = textarea.value.trim();
    if (!(opts.canSend ? opts.canSend(text) : text)) return;
    error.hidden = true;
    textarea.value = '';
    fit();
    save();
    sending++;
    render();
    // Called straight away, inside the submit, so a caller can read state it set just before requestSubmit().
    let sent;
    try {
      sent = Promise.resolve(opts.send(text));
    } catch (err) {
      sent = Promise.reject(err);
    }
    sent.catch((err) => {
      // Not sent: put it back, ahead of anything typed since.
      textarea.value = textarea.value.trim() ? `${text}\n${textarea.value}` : text;
      fit();
      save();
      if (opts.onError) opts.onError(err);
      else {
        error.textContent = `Not sent: ${err?.message || err}. Your message is back in the box.`;
        error.hidden = false;
      }
    }).finally(() => {
      sending--;
      render();
    });
  });
  render();

  return {
    form, textarea, row, sendButton, stopButton, fit,
    busy(on) {
      busy = !!on;
      render();
    },
    focus() {
      textarea.focus();
    },
    get value() {
      return textarea.value;
    },
    set value(v) {
      textarea.value = v;
      fit();
      save();
    },
  };
}
