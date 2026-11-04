// ui/composer.js's mountComposer on a tiny fake DOM: what Citadel's chat and every app rely on.
// The browser-only parts (autogrow's measuring, list continuation's execCommand) are checked in a
// dev copy; listEnter has its own tests (lists.test.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

class El {
  constructor(tag) {
    Object.assign(this, { tag, children: [], attrs: {}, dataset: {}, style: {}, listeners: {}, value: '', hidden: false, disabled: false, type: '', scrollHeight: 0, offsetHeight: 0, clientHeight: 0 });
    const classes = new Set();
    this.classList = { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)), contains: (c) => classes.has(c) };
  }
  set className(v) { for (const c of v.split(' ')) this.classList.toggle(c, true); }
  set textContent(v) { this.text = v; }
  get textContent() { return this.text ?? this.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join(''); }
  append(...kids) { this.children.push(...kids); }
  setAttribute(k, v) { this.attrs[k] = v; }
  toggleAttribute(k, on) { if (on) this.attrs[k] = ''; else delete this.attrs[k]; }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  dispatch(type, props = {}) {
    const e = { type, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...props };
    for (const fn of this.listeners[type] ?? []) fn(e);
    return e;
  }
  closest(sel) { return sel.includes('dialog') && this.inDialog ? {} : null; }
  matches(sel) { return sel.split(', ').some((s) => s.replace(/\[.*\]/, '') === this.tag); }
  getClientRects() { return this.isConnected ? [{}] : []; }
  focus(opts) { this.focusedWith = opts; document.activeElement = this; }
  requestSubmit() { this.dispatch('submit'); }
  /** A click, then what the browser does after it: a submit button submits its form. */
  click(form) {
    const e = this.dispatch('click');
    if (!e.defaultPrevented && this.type === 'submit' && !this.disabled) form.requestSubmit();
  }
}

let narrow = false;
let coarse = false;
const store = new Map();
const on = (target) => Object.assign(target, {
  listeners: {},
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); },
  fire(type, e = {}) { for (const fn of this.listeners[type] ?? []) fn(e); },
});
const body = new El('body');
globalThis.document = on({ createElement: (tag) => new El(tag), scrollingElement: null, adoptedStyleSheets: [], body, activeElement: body });
globalThis.window = on({});
globalThis.matchMedia = (q) => ({ matches: q === '(pointer: coarse)' ? coarse : narrow });
let frames = [];
globalThis.requestAnimationFrame = (fn) => frames.push(fn);
/** Run the frames queued so far, and those they queue, `n` deep. */
const flush = (n = 3) => {
  for (let i = 0; i < n; i++) {
    const now = frames;
    frames = [];
    for (const fn of now) fn();
  }
};
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
const { mountComposer } = await import('../public/ui/composer.js');

const tick = () => new Promise((r) => setTimeout(r, 0));
function mount(opts = {}) {
  const sent = [];
  const box = mountComposer(new El('div'), { send: (t) => sent.push(t), ...opts });
  const type = (text) => {
    box.textarea.value = text;
    box.textarea.dispatch('input');
  };
  const key = (props) => box.textarea.dispatch('keydown', { key: 'Enter', shiftKey: false, isComposing: false, keyCode: 13, ...props });
  return { box, sent, type, key };
}

test('Enter sends the trimmed text on desktop and empties the box; Shift+Enter does not', () => {
  narrow = false;
  const { box, sent, type, key } = mount();
  type('  hello  ');
  assert.equal(key({ shiftKey: true }).defaultPrevented, false);
  assert.deepEqual(sent, []);
  key();
  assert.deepEqual(sent, ['hello']);
  assert.equal(box.value, '');
});

test('on a phone Enter adds a line; the Send button sends', () => {
  narrow = true;
  const { box, sent, type, key } = mount();
  type('hello');
  assert.equal(key().defaultPrevented, false);
  assert.deepEqual(sent, []);
  box.sendButton.click(box.form);
  assert.deepEqual(sent, ['hello']);
  narrow = false;
});

test('an Enter that ends an IME composition never sends', () => {
  const { sent, type, key } = mount();
  type('かな');
  key({ isComposing: true });
  key({ keyCode: 229 }); // Safari: after compositionend, isComposing false
  assert.deepEqual(sent, []);
});

test('a failed send puts the text back ahead of what was typed since, and says so', async () => {
  let fail;
  const { box, type, key } = mount({ send: () => new Promise((_, rej) => (fail = rej)) });
  type('first');
  key();
  assert.equal(box.sendButton.disabled, true, 'Send waits while the message is on its way');
  type('typed meanwhile');
  fail(new Error('offline'));
  await tick();
  assert.equal(box.value, 'first\ntyped meanwhile');
  assert.equal(box.sendButton.disabled, false);
  const notice = box.form.children[0];
  assert.equal(notice.hidden, false);
  assert.match(notice.textContent, /offline/);
  // A send that throws outright counts as failed too; the next submit clears the notice first.
  const thrown = mount({ send: () => { throw new Error('nope'); } });
  thrown.type('again');
  thrown.key();
  await tick();
  assert.equal(thrown.box.value, 'again');
});

test('onError replaces the built-in notice', async () => {
  const errors = [];
  const { box, type, key } = mount({ send: () => Promise.reject(new Error('x')), onError: (e) => errors.push(e.message) });
  type('hi');
  key();
  await tick();
  assert.deepEqual(errors, ['x']);
  assert.equal(box.form.children[0].hidden, true);
});

test('canSend can refuse a send or allow an empty one', () => {
  let ok = false;
  const { box, sent, type, key } = mount({ canSend: (t) => ok || t === 'go' });
  type('wait');
  key();
  assert.deepEqual(sent, []);
  assert.equal(box.value, 'wait', 'a refused send leaves the box alone');
  type('');
  ok = true;
  key();
  assert.deepEqual(sent, ['']);
});

test('send runs inside the submit, so state set just before requestSubmit() is still there', () => {
  let flag = false;
  const seen = [];
  const { box, type } = mount({ send: () => seen.push(flag) });
  type('queued');
  flag = true;
  box.form.requestSubmit();
  flag = false;
  assert.deepEqual(seen, [true]);
});

test('busy with stop: Send shows as Stop, typing stays, Enter waits, and Stop never sends', () => {
  let stops = 0;
  const { box, sent, type, key } = mount();
  const s = mountComposer(new El('div'), { send: (t) => sent.push(t), stop: () => { stops++; s.busy(false); } });
  s.busy(true);
  assert.equal(s.sendButton.textContent, 'Stop');
  assert.equal('data-busy' in s.form.attrs, true);
  s.textarea.value = 'half a thought';
  s.textarea.dispatch('keydown', { key: 'Enter', shiftKey: false, isComposing: false, keyCode: 13 });
  assert.deepEqual(sent, []);
  // stop() ends busy at once; the same click must not then submit as Send.
  s.sendButton.click(s.form);
  assert.equal(stops, 1);
  assert.deepEqual(sent, []);
  assert.equal(s.sendButton.textContent, 'Send');
  assert.equal(s.textarea.value, 'half a thought');
  // Without stop, busy changes nothing about sending.
  box.busy(true);
  type('steer');
  key();
  assert.deepEqual(sent, ['steer']);
});

test('whileBusy send: Stop shows beside Send while busy, Send and Enter keep sending, Stop never sends', async () => {
  let stops = 0;
  const sent = [];
  const s = mountComposer(new El('div'), { send: (t) => sent.push(t), stop: () => { stops++; s.busy(false); }, whileBusy: 'send' });
  assert.deepEqual(s.row.children, [s.stopButton, s.sendButton], 'Stop sits before Send');
  assert.equal(s.stopButton.hidden, true, 'hidden until busy');
  s.busy(true);
  assert.equal(s.stopButton.hidden, false);
  assert.equal(s.sendButton.textContent, 'Send');
  assert.equal(s.sendButton.classList.contains('cui-primary'), true);
  s.textarea.value = 'one more thing';
  s.textarea.dispatch('keydown', { key: 'Enter', shiftKey: false, isComposing: false, keyCode: 13 });
  await tick(); // Send waits while the first is on its way
  s.textarea.value = 'and another';
  s.sendButton.click(s.form);
  assert.deepEqual(sent, ['one more thing', 'and another']);
  s.textarea.value = 'kept';
  s.stopButton.click(s.form);
  assert.equal(stops, 1);
  assert.deepEqual(sent, ['one more thing', 'and another']);
  assert.equal(s.textarea.value, 'kept');
  assert.equal(s.stopButton.hidden, true, 'gone once the turn ends');
  // The fake DOM has no styles: in a page, .cui-btn's display beats [hidden] unless the composer's sheet hides it.
  assert.match(readFileSync(new URL('../public/ui/composer.js', import.meta.url), 'utf8'), /:where\(\.cui-composer-stop\[hidden\]\) \{ display: none; \}/);
  // Without stop, or with the default, there is no separate Stop.
  assert.equal(mountComposer(new El('div'), { send() {}, whileBusy: 'send' }).stopButton, null);
  assert.equal(mountComposer(new El('div'), { send() {}, stop() {} }).stopButton, null);
});

test('drafts: saved as typed, back on mount, gone once sent', () => {
  store.clear();
  const a = mount({ draftKey: 'd:1' });
  a.type('unsent words');
  assert.equal(store.get('d:1'), JSON.stringify('unsent words'));
  const b = mount({ draftKey: 'd:1' });
  assert.equal(b.box.value, 'unsent words');
  b.key();
  assert.equal(store.has('d:1'), false);
});

// ---------- autofocus (Cara, 2026-11-04: "it should default focus so I dont have to click on the chat box") ----------

/** A box that is on the page, with the caret at `active` (the page body by default). */
function shown(opts = {}, active = body) {
  narrow = false;
  coarse = false;
  document.activeElement = active;
  const m = mount(opts);
  m.box.textarea.isConnected = true;
  flush();
  return m.box.textarea;
}

test('autofocus: the box takes the caret when it comes up on desktop, without scrolling', () => {
  const t = shown();
  assert.equal(document.activeElement, t);
  assert.deepEqual(t.focusedWith, { preventScroll: true });
});

test('autofocus: as the chat opens, from the link or button that opened it, but never from a field', () => {
  for (const opener of ['a', 'button']) {
    const t = shown({}, new El(opener));
    assert.equal(document.activeElement, t, `from the ${opener} just clicked`);
  }
  const search = new El('input');
  shown({}, search);
  assert.equal(document.activeElement, search, 'the search box keeps it');
  const inCard = Object.assign(new El('button'), { inDialog: true });
  shown({}, inCard);
  assert.equal(document.activeElement, inCard, 'a button in a dialog keeps it');
});

test('autofocus: never on a phone-wide or touch-first screen, nor with autofocus: false', () => {
  for (const [n, c] of [[true, false], [false, true]]) {
    document.activeElement = body;
    [narrow, coarse] = [n, c];
    const { box } = mount();
    box.textarea.isConnected = true;
    flush();
    assert.equal(document.activeElement, body, `narrow ${n}, coarse ${c}`);
  }
  shown({ autofocus: false });
  assert.equal(document.activeElement, body);
});

test('autofocus: back in the window or after a dialog closes, only when nothing has the caret', async () => {
  const t = shown();
  for (const [target, type, e] of [[window, 'focus'], [document, 'close', { target: { tagName: 'DIALOG' } }], [document, 'citadel-drawer-close']]) {
    document.activeElement = body;
    target.fire(type, e);
    await tick();
    assert.equal(document.activeElement, t, type);
    const field = new El('textarea');
    document.activeElement = field;
    target.fire(type, e);
    await tick();
    assert.equal(document.activeElement, field, `${type} leaves another field alone`);
    const link = new El('a');
    document.activeElement = link;
    target.fire(type, e);
    await tick();
    assert.equal(document.activeElement, link, `${type} leaves a focused link alone`);
  }
});

test('autofocus: the newest box on the page takes it; one taken off the page drops out', async () => {
  const old = shown();
  const t = shown();
  assert.equal(document.activeElement, t);
  t.isConnected = false;
  document.activeElement = body;
  window.fire('focus');
  await tick();
  assert.equal(document.activeElement, old, 'the one still on the page');
  t.disabled = true;
  t.isConnected = true;
  document.activeElement = body;
  window.fire('focus');
  await tick();
  assert.equal(document.activeElement, old, 'a disabled box is passed over');
});
