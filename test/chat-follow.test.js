// ui/chat.js's mountChat keeping the log at its end, on a tiny fake DOM with a scroller that has a
// height (#287, from Mandate #39): a block card that fills in after mounting, a scroller that shrinks
// (an undo bar, a phone keyboard) and the kit's own late scroll event must not leave it short of the
// end; only a person's gesture (wheel, touch, keys, pointer) lets go of it.
import { test } from 'node:test';
import assert from 'node:assert/strict';

class El {
  constructor(tag) {
    Object.assign(this, { tag, children: [], attrs: {}, dataset: {}, listeners: {}, hidden: false, className: '', textContent: '' });
    this.classList = { add() {}, remove() {} };
  }
  get firstChild() {
    return this.children[0] ?? null;
  }
  append(...kids) {
    for (const k of kids) this.children.push(k);
  }
  replaceChildren(...kids) {
    this.children = [];
    this.append(...kids);
  }
  setAttribute(k, v) {
    this.attrs[k] = v;
  }
  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }
  removeEventListener(type, fn) {
    this.listeners[type] = (this.listeners[type] ?? []).filter((f) => f !== fn);
  }
  dispatch(type, props = {}) {
    for (const fn of this.listeners[type] ?? []) fn({ type, target: this, ...props });
  }
  querySelectorAll() {
    return [];
  }
  contains() {
    return false;
  }
  set innerHTML(_) {
    this.content = { firstElementChild: new El('div') };
  }
}

/** A scroller with a height: `content` px of log in a box `clientHeight` tall. Like a browser, setting
 * scrollTop clamps it and queues a scroll event that arrives later (flush()). */
class Scroller extends El {
  constructor() {
    super('div');
    Object.assign(this, { content: 0, clientHeight: 400, top: 0, queued: false });
  }
  get scrollHeight() {
    return Math.max(this.content, this.clientHeight);
  }
  get scrollTop() {
    return this.top;
  }
  set scrollTop(v) {
    const top = Math.max(0, Math.min(v, this.scrollHeight - this.clientHeight));
    if (top !== this.top) this.queued = true;
    this.top = top;
  }
  get atEnd() {
    return this.top === this.scrollHeight - this.clientHeight;
  }
  /** A person scrolling to `top`: their gesture first, then the scroll. */
  scrollBy(dy, gesture = { type: 'wheel', deltaY: dy }) {
    (gesture.type === 'keydown' ? doc : this).dispatch(gesture.type, gesture); // keys reach document, focus being on body
    this.scrollTop = this.top + dy;
    flush();
  }
}

let frames = [];
const observers = [];
let clock = 1000;
const doc = new El('document');
globalThis.document = Object.assign(doc, { createElement: (tag) => new El(tag), adoptedStyleSheets: [] });
globalThis.requestAnimationFrame = (fn) => frames.push(fn);
globalThis.cancelAnimationFrame = () => {};
globalThis.ResizeObserver = class {
  constructor(fn) {
    Object.assign(this, { fn, targets: new Set() });
    observers.push(this);
  }
  observe(t) {
    this.targets.add(t);
  }
  disconnect() {
    this.targets.clear();
  }
};
Object.defineProperty(performance, 'now', { value: () => clock, configurable: true });
/** Layout changed the size of `target`: its observers hear of it. */
const resized = (target) => {
  for (const o of observers) if (o.targets.has(target)) o.fn([{ target }]);
};

const { mountChat } = await import('../public/ui/chat.js');
let box;
/** Run what the browser would next: animation frames, then the scroll event a scrollTop change queued. */
function flush() {
  for (const fn of frames.splice(0)) fn();
  if (box?.queued) {
    box.queued = false;
    box.dispatch('scroll');
  }
}

function mount() {
  frames = [];
  box = new Scroller();
  const card = new El('div');
  const chat = mountChat(box, { block: (name) => (name === 'history' ? card : null) });
  const log = box.children.find((c) => c.className === 'cui-log');
  const latest = box.children.find((c) => c.className.includes('cui-latest'));
  chat.push({ type: 'tool', data: { id: 'h', name: 'history', input: {}, parent: null } });
  chat.push({ type: 'tool_result', data: { id: 'h', ok: true, parent: null } });
  chat.push({ type: 'end', data: {} });
  box.content = 1000;
  flush();
  assert.equal(box.top, 600, 'the first draw lands at the end');
  return { chat, log, latest };
}

test("a block that fills in after mounting keeps the log at the end, even when the kit's own scroll event arrives late", () => {
  const { chat, log, latest } = mount();
  // The history card's fetch lands: the log grows before the draw's scroll event is delivered.
  box.content = 1500;
  box.top = 400; // the event the draw queued arrives after the growth, short of the new end
  box.dispatch('scroll');
  resized(log);
  flush();
  assert.ok(box.atEnd, `at ${box.top}, not the end (1100)`);
  assert.equal(latest.hidden, true, 'no "Latest ↓" while following');
  // And without any scroll event, the growth alone brings it to the end.
  box.content = 1700;
  resized(log);
  flush();
  assert.equal(box.top, 1300);
  chat.destroy();
});

test('a scroller that shrinks (an undo bar, a phone keyboard) stays at the end', () => {
  const { chat, latest } = mount();
  box.clientHeight = 250;
  resized(box);
  flush();
  assert.equal(box.top, 750);
  assert.equal(latest.hidden, true);
  chat.destroy();
});

test("only a person's gesture lets go of the end; coming back to it follows again", () => {
  const { chat, log, latest } = mount();
  // Wheeling down at the end while the log grows doesn't let go.
  box.content = 1100;
  box.scrollBy(40, { type: 'wheel', deltaY: 40 });
  resized(log);
  flush();
  assert.ok(box.atEnd);
  // Wheeling up does: growth leaves them where they are, and "Latest ↓" shows.
  box.scrollBy(-300);
  assert.equal(latest.hidden, false);
  box.content = 1600;
  resized(log);
  clock += 5000;
  box.dispatch('scroll'); // a late event of the kit's own changes nothing either
  flush();
  assert.equal(box.top, 400);
  // Back at the end by hand, it follows again.
  clock += 5000;
  box.scrollBy(800, { type: 'keydown', key: 'End' });
  // PageUp, heard on document, lets go.
  clock += 5000;
  box.scrollBy(-300, { type: 'keydown', key: 'PageUp' });
  assert.equal(latest.hidden, false);
  box.scrollBy(800, { type: 'keydown', key: 'End' });
  assert.equal(latest.hidden, true);
  box.content = 1800;
  resized(log);
  flush();
  assert.ok(box.atEnd);
  // A finger dragging the log up lets go too, and a fling after lifting it keeps going without a fight.
  clock += 5000;
  box.scrollBy(-50, { type: 'touchstart' });
  doc.dispatch('touchend');
  assert.equal(latest.hidden, false);
  clock += 100;
  box.scrollTop = box.top - 200;
  flush();
  assert.equal(box.top, 1150);
  // "Latest ↓" takes them back and follows.
  latest.dispatch('click');
  flush();
  assert.ok(box.atEnd);
  assert.equal(latest.hidden, true);
  chat.destroy();
});

test("a scroll that isn't a person's, while following, goes back to the end", () => {
  const { chat, latest } = mount();
  clock += 5000;
  box.scrollTop = 100; // scroll anchoring, a layout jump: nobody asked to leave the end
  flush();
  assert.ok(box.atEnd);
  assert.equal(latest.hidden, true);
  chat.destroy();
});
