import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canGoBack, canGoForward, step } from '../public/navstack.js';

const start = { id: 'x', entries: ['#/p/2'], idx: 0 };

test('a fresh stack has nowhere to go: Back never leaves the app', () => {
  assert.equal(canGoBack(start), false);
  assert.equal(canGoForward(start), false);
  assert.equal(canGoBack(null), false);
});

test('opening views adds entries; going back and forth moves along them', () => {
  let s = step(start, { hash: '#/p/2/t/5' });
  s = step(s, { hash: '#/p/2/t/9' });
  assert.deepEqual(s.entries, ['#/p/2', '#/p/2/t/5', '#/p/2/t/9']);
  assert.equal(s.idx, 2);
  assert.equal(canGoBack(s), true);
  assert.equal(canGoForward(s), false);
  s = step(s, { hash: '#/p/2/t/5', at: 1 });
  assert.equal(canGoBack(s), true);
  assert.equal(canGoForward(s), true);
  s = step(s, { hash: '#/p/2', at: 0 });
  assert.equal(canGoBack(s), false);
  assert.equal(canGoForward(s), true);
});

test('opening a view after going back drops what was forward, as a browser does', () => {
  let s = step(step(start, { hash: '#/p/2/t/5' }), { hash: '#/p/2/t/9' });
  s = step(s, { hash: '#/p/2', at: 0 });
  s = step(s, { hash: '#/p/2/t/7' });
  assert.deepEqual(s.entries, ['#/p/2', '#/p/2/t/7']);
  assert.equal(canGoForward(s), false);
});

test('a replaced address takes the current entry\'s place', () => {
  let s = step(start, { hash: '#/p/2/t/5' });
  s = step(s, { hash: '#/p/2/t/5/x', replaced: true });
  assert.deepEqual(s.entries, ['#/p/2', '#/p/2/t/5/x']);
  assert.equal(s.idx, 1);
});

test('the stack keeps the newest 50 entries, and older entries\' places still find theirs', () => {
  let s = start;
  for (let i = 0; i < 80; i++) s = step(s, { hash: `#/p/2/t/${i}` });
  assert.equal(s.entries.length, 50);
  assert.equal(s.entries.at(-1), '#/p/2/t/79');
  assert.equal(s.idx, 49);
  // The entry before the newest was place 79 (start is place 0): going back lands on it, not on the newest.
  s = step(s, { hash: '#/p/2/t/78', at: 79 });
  assert.equal(s.idx, 48);
  assert.deepEqual(s.entries.slice(-2), ['#/p/2/t/78', '#/p/2/t/79']);
  assert.equal(canGoForward(s), true);
  // A place that has dropped off lands on the oldest kept: Back is off rather than wrong.
  s = step(s, { hash: '#/p/2', at: 0 });
  assert.equal(canGoBack(s), false);
});

test('a move to a place past the end lands on the last entry', () => {
  const s = step(step(start, { hash: '#/p/2/t/5' }), { hash: '#/p/2/t/5', at: 7 });
  assert.equal(s.idx, 1);
});

// The browser side: marks in history.state, sessionStorage, and the replace flag.
test('in a page, links, replaces, back and reload keep the stack right', async () => {
  const entries = [{ hash: '#/p/2', state: null }];
  let at = 0;
  const store = new Map();
  const listeners = {};
  const fire = () => { listeners.popstate?.(); listeners.hashchange?.(); };
  const location = {
    get hash() { return entries[at].hash; },
    set hash(v) { entries.splice(at + 1, Infinity, { hash: v, state: null }); at++; fire(); },
    get href() { return `https://x.test/${entries[at].hash}`; },
    replace(v) { entries[at] = { hash: new URL(v, this.href).hash, state: null }; fire(); },
  };
  const history = {
    get state() { return entries[at].state; },
    replaceState(st) { entries[at].state = st; },
    back() { at--; fire(); },
    forward() { at++; fire(); },
  };
  const buttons = { back: { disabled: null }, forward: { disabled: null } };
  Object.assign(globalThis, {
    window: { addEventListener: (type, fn) => { listeners[type] = fn; } },
    location, history,
    sessionStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) },
    document: { querySelectorAll: (sel) => [sel.includes('back') ? buttons.back : buttons.forward] },
  });
  const nav = await import('../public/navstack.js?page');
  assert.equal(nav.canBack(), false);
  location.hash = '#/p/2/t/5'; // a link or the sidebar
  location.hash = '#/t/202'; // an old address...
  nav.replaceHash('#/p/2/t/9'); // ...swapped for its new one
  assert.deepEqual(entries.map((e) => e.hash), ['#/p/2', '#/p/2/t/5', '#/p/2/t/9']);
  assert.equal(buttons.back.disabled, false);
  assert.equal(buttons.forward.disabled, true);
  nav.goBack();
  assert.equal(location.hash, '#/p/2/t/5');
  assert.equal(buttons.forward.disabled, false);
  history.back(); // Alt+← or a back swipe
  assert.equal(nav.canBack(), false);
  nav.goBack(); // nothing earlier in Citadel: stays put
  assert.equal(at, 0);
  nav.goForward();
  assert.equal(location.hash, '#/p/2/t/5');
  assert.equal(nav.canForward(), true);
  // A reload is a fresh module reading this entry's mark and the stored stack back.
  const reloaded = await import('../public/navstack.js?reload');
  assert.equal(reloaded.canBack(), true);
  assert.equal(reloaded.canForward(), true);
  for (const k of ['window', 'location', 'history', 'sessionStorage', 'document']) delete globalThis[k];
});
