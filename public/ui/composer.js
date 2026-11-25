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
// 16px text on phones so iOS doesn't zoom; optional drafts in localStorage; the caret goes in the box by
// itself on desktop (autofocus, below). Buttons and the box take base.css's cui-* classes.

const NARROW = '(max-width: 800px)';
const narrow = () => matchMedia(NARROW).matches;

const CSS = `
:where(.cui-composer) {
  display: flex; flex-wrap: wrap; align-items: flex-end; gap: var(--citadel-space-2);
  margin: 0 0 env(safe-area-inset-bottom, 0px); padding: var(--citadel-space-2);
  background: var(--citadel-surface); border: 1px solid var(--citadel-control-border); border-radius: var(--citadel-radius-lg);
}
:where(.cui-composer:has(.cui-composer-input:focus-visible)) { outline: 2px solid var(--citadel-focus); outline-offset: 2px; }
:where(.cui-composer-error) { flex-basis: 100%; }
/* No border of its own, so one line is control-h tall, level with Send. */
:where(.cui-composer-input) {
  flex: 1; min-width: 0; box-sizing: border-box; border: 0; background: transparent; outline: none;
  resize: none; overflow-y: auto; max-height: 40vh; padding: calc((var(--citadel-control-h) - 1.25em) / 2) var(--citadel-space-1);
}
:where(.cui-composer-row) { display: flex; align-items: center; gap: var(--citadel-space-2); }
/* .cui-btn's display would beat [hidden]. */
:where(.cui-composer-stop[hidden]) { display: none; }
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
  try {
    return JSON.parse(localStorage.getItem(key)) ?? null;
  } catch {
    return null;
  }
};
const saveDraft = (key, value) => {
  try {
    if (value) localStorage.setItem(key, JSON.stringify(value));
    else localStorage.removeItem(key);
  } catch {}
};

/** Grow (or shrink) a textarea to fit its text; its CSS min-height and max-height bound it. */
export function fitHeight(box) {
  // Text only got longer (a key typed): the box can only grow, so one read says whether it must, with no collapse.
  // That keeps typing to one layout a key in a long chat (#1531: 154 layouts for 49 keys before).
  // shortcut: a longer paste over lines it removes leaves the box tall until the text next gets shorter.
  const len = box.value.length,
    grew = len > (box.fitLen ?? Infinity);
  box.fitLen = len;
  if (grew && box.style.height && box.scrollHeight <= box.clientHeight) return;
  // Collapsing to 'auto' can shorten the page for a moment and move the scroll: put it back after,
  // and keep a chat that was at its end there, so the growing box doesn't cover the last message.
  const scrolled = [document.scrollingElement, box.closest('.chat')].filter(Boolean).map((el) => [el, el.scrollTop, el.scrollTop >= el.scrollHeight - el.clientHeight - 2]);
  box.style.height = 'auto';
  // Not laid out (a collapsed panel, or a phone's drawer still tucked away): keep the CSS height.
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

// ---------- autofocus ----------
// Cara, 2026-11-04: "If I have a screen with a chat open in citadel, it should default focus so I dont
// have to click on the chat box to type into it". A box mounted with autofocus (the default) takes the
// caret when it comes up, when the window comes back, and when a dialog or drawer closes. Only where a
// keyboard is the way in: not on a touch-first or phone-wide screen, where it would pop the on-screen
// keyboard over the chat. And only when the caret is free: on the page itself or nowhere, or (as the
// chat comes up) on the link or button just used to open it. Never from another field, a menu or a
// dialog. Nothing else moves it: not a redraw, a new message or loading earlier ones.

const COARSE = '(pointer: coarse)';
const live = []; // boxes mounted with autofocus, oldest first
let listening = false;

function caretIsFree(opening) {
  if (matchMedia(COARSE).matches || narrow()) return false;
  const a = document.activeElement;
  if (!a || a === document.body || a === document.documentElement) return true;
  // What was clicked to open the chat keeps the caret otherwise: a link, or a button outside menus and dialogs.
  return opening && !!a.matches?.('a[href], button') && !a.closest('dialog, [role=menu], [role=dialog], [contenteditable]');
}

const takesCaret = (t) => t.isConnected && !t.disabled && !t.closest('[inert]') && t.getClientRects().length > 0;

/** Put the caret in the newest box that can take it, if it is free. */
const dropGone = () => {
  for (let i = live.length - 1; i >= 0; i--) if (!live[i].isConnected && live[i].dataset.cuiSeen !== undefined) live.splice(i, 1);
};

function autofocus(opening = false) {
  dropGone();
  const box = live.findLast(takesCaret);
  if (box && caretIsFree(opening)) box.focus({ preventScroll: true });
}

function listen() {
  if (listening) return;
  listening = true;
  // After the browser has put back whatever had the caret before (a window coming back, a dialog closing).
  const later = () => setTimeout(autofocus);
  window.addEventListener('focus', later);
  document.addEventListener('close', (e) => e.target?.tagName === 'DIALOG' && later(), true);
  document.addEventListener('citadel-drawer-close', later);
}

/** Once `textarea` is on the page (a caller may build the box elsewhere first), focus it if the caret is free. */
function focusOnceShown(textarea, frames = 60) {
  if (textarea.isConnected) {
    textarea.dataset.cuiSeen = '';
    // A frame later, so a page laying out the chat around it has finished.
    return requestAnimationFrame(() => live.at(-1) === textarea && autofocus(true));
  }
  if (frames) requestAnimationFrame(() => focusOnceShown(textarea, frames - 1));
  else textarea.dataset.cuiSeen = ''; // never shown: dropped once it's off the page
}

// ---------- an automatic reload (#1939) ----------
// Citadel's rail.js reloads a framed app's page by itself after a deploy, and asks first with
// citadel-before-reload on the document (rail.d.ts). What only this page holds says no: a message still being
// sent (its box is already empty, and may be off the page by now) and files waiting in a tray with no words.

/** A send that hasn't settled by now is taken as stuck: it stops holding the reload. Long enough for a video to upload. */
const SEND_HOLD_MS = 10 * 60_000;
const inFlight = new Set(); // one { at } per send not settled yet
const boxes = new Set(); // every box that can send without words; one off the page stays while it has something to
let asked = false;

const waiting = (b) => {
  try {
    return !!b.canSend('');
  } catch {
    return false; // a box whose page is gone
  }
};

function answerReload() {
  if (asked) return;
  asked = true;
  document.addEventListener('citadel-before-reload', (e) => {
    const since = Date.now() - SEND_HOLD_MS;
    if ([...inFlight].some((s) => s.at > since) || [...boxes].some(waiting)) e.preventDefault();
  });
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
    const flight = { at: Date.now() };
    inFlight.add(flight);
    render();
    // Called straight away, inside the submit, so a caller can read state it set just before requestSubmit().
    let sent;
    try {
      sent = Promise.resolve(opts.send(text));
    } catch (err) {
      sent = Promise.reject(err);
    }
    sent
      .catch((err) => {
        // Not sent: put it back, ahead of anything typed since.
        textarea.value = textarea.value.trim() ? `${text}\n${textarea.value}` : text;
        fit();
        save();
        if (opts.onError) opts.onError(err);
        else {
          error.textContent = `Not sent: ${err?.message || err}. Your message is back in the box.`;
          error.hidden = false;
        }
      })
      .finally(() => {
        sending--;
        inFlight.delete(flight); // after a failure's words are back, so one or the other always holds
        render();
      });
  });
  render();
  answerReload();
  // Only a framed page is asked, so Citadel's own chats aren't kept here.
  if (opts.canSend && window.parent !== window) {
    for (const b of boxes) if (b.shown && !b.form.isConnected && !waiting(b)) boxes.delete(b);
    const b = { form, canSend: opts.canSend, shown: false };
    boxes.add(b);
    requestAnimationFrame(() => (b.shown = form.isConnected)); // one built off the page and shown later is never dropped
  }
  if (opts.autofocus !== false) {
    dropGone(); // each box holds its whole page, so the ones gone go now, not at the next focus
    live.push(textarea);
    listen();
    focusOnceShown(textarea);
  }

  return {
    form,
    textarea,
    row,
    sendButton,
    stopButton,
    fit,
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
