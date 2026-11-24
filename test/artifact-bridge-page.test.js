// The artifact bridge's page side (public/artifact-bridge.js), run in a bare VM context with a fake viewer:
// the function the server inlines into every HTML page it serves under a file token.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const SRC = readFileSync(join(import.meta.dirname, '..', 'public', 'artifact-bridge.js'), 'utf8');
const FN = SRC.slice(SRC.indexOf('(function (cfg)')).trim();
const TAG = 'citadel-bridge-1';
// The page's timers run 100 times faster: the 100 ms flush is 1 ms, the 15 s request limit 150 ms.
const SCALE = 100;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** A page served with `entries`, framed by a viewer that answers only when told (`answer`). */
function page(entries = []) {
  const posted = [];
  const listeners = [];
  const others = {}; // the page's other listeners (input, keydown), by type
  const host = { postMessage: (m) => posted.push(m) };
  const bars = [];
  const document = {
    body: { append: (el) => bars.push(el) },
    createElement: (tag) => ({
      tag,
      style: {},
      attributes: {},
      setAttribute(k, v) {
        this.attributes[k] = v;
      },
    }),
  };
  const ctx = vm.createContext({
    console,
    document,
    navigator: {},
    crypto: globalThis.crypto,
    setTimeout: (fn, ms = 0) => setTimeout(fn, ms / SCALE),
    clearTimeout,
    addEventListener: (type, fn) => (type === 'message' ? listeners : (others[type] ??= [])).push(fn),
    localStorage: {},
    sessionStorage: {},
  });
  ctx.window = ctx;
  ctx.parent = host;
  vm.runInContext(`${FN}(${JSON.stringify({ page: 't1-0.x.y/p.html', entries: entries.map(([key, value]) => ({ key, value })) })})`, ctx);
  const deliver = (data) => {
    for (const fn of listeners) fn({ source: host, data: { bridge: TAG, ...data } });
  };
  return {
    ctx,
    posted,
    bars,
    deliver,
    /** The page's own events (a key press, typing in a field). */
    fire: (type, e = { type }) => {
      for (const fn of others[type] ?? []) fn(e);
    },
    /** Answer the oldest unanswered request of kind `op`. */
    answer(op, result, ok = true) {
      const m = posted.find((p) => p.op === op && !p.answered);
      assert.ok(m, `no ${op} request waiting`);
      m.answered = true;
      deliver({ re: m.id, ok, result, error: ok ? undefined : String(result) });
    },
    waiting: (op) => posted.filter((p) => p.op === op && !p.answered),
  };
}

test('a write nobody answers any more puts a bar on the page saying it is not connected (#468 S13-3)', async () => {
  const p = page([['k', 'a']]);
  p.answer('hello', { person: 'Cara', entries: [{ key: 'k', value: 'a' }] });
  assert.equal(await p.ctx.citadel.ready, true);
  const set = p.ctx.citadel.storage.set('k', 'b');
  await assert.rejects(set, /did not answer/);
  assert.equal(p.bars.length, 1);
  assert.match(p.bars[0].textContent, /reopen/i);
  // Once, however many writes fail after it.
  await assert.rejects(p.ctx.citadel.storage.set('k', 'c'), /did not answer/);
  assert.equal(p.bars.length, 1);
});

test('one write request is out at a time, so a later flush cannot overtake an earlier one (#468 S13-4)', async () => {
  const p = page();
  p.answer('hello', { person: 'Cara', entries: [] });
  await p.ctx.citadel.ready;
  const first = p.ctx.citadel.storage.set('k', 1);
  await wait(10);
  assert.equal(p.waiting('write').length, 1);
  const second = p.ctx.citadel.storage.set('k', 2);
  await wait(10);
  assert.equal(p.waiting('write').length, 1, 'the second flush waits for the first');
  p.answer('write', { entries: [] });
  await first;
  await wait(10);
  assert.equal(JSON.stringify(p.waiting('write').map((m) => m.entries)), JSON.stringify([[{ key: 'k', value: 2 }]]));
  p.answer('write', { entries: [] });
  await second;
});

test('storing null (or NaN, which JSON makes null) deletes the key here too, as the server does (#468 S13-10)', async () => {
  const p = page([
    ['answer', 1],
    ['storage/n', 2],
  ]);
  p.answer('hello', {
    person: 'Cara',
    entries: [
      { key: 'answer', value: 1 },
      { key: 'storage/n', value: 2 },
    ],
  });
  await p.ctx.citadel.ready;
  const a = p.ctx.citadel.storage.set('answer', null);
  const n = p.ctx.window.storage.set('n', NaN);
  assert.equal(JSON.stringify(await p.ctx.citadel.storage.list()), '[]');
  assert.equal(await p.ctx.window.storage.get('n'), null);
  await wait(10);
  p.answer('write', { entries: [] });
  await Promise.all([a, n]);
});

test('a store refresh keeps writes that are on their way on top (#468 S13-7)', async () => {
  const p = page([['k', 'a']]);
  const set = p.ctx.citadel.storage.set('k', 'b');
  await wait(10); // flushed: waiting on the viewer's hello
  p.answer('hello', { person: 'Cara', entries: [{ key: 'k', value: 'a' }] });
  await p.ctx.citadel.ready;
  assert.equal(await p.ctx.citadel.storage.get('k'), 'b');
  await wait(10);
  p.answer('write', { entries: [{ key: 'k', value: 'b' }] });
  await set;
  // Once it has landed, a refresh is what the server holds.
  p.deliver({ op: 'changed', entries: [{ key: 'k', value: 'c' }] });
  assert.equal(await p.ctx.citadel.storage.get('k'), 'c');
});

test('a write Citadel could not take while it restarts stays on the page, on top of refreshes, and is sent again until it lands (#821)', async () => {
  const p = page([['k', 'a']]);
  p.answer('hello', { person: 'Cara', entries: [{ key: 'k', value: 'a' }] });
  await p.ctx.citadel.ready;
  const states = [];
  p.ctx.citadel.watchSaves((s) => states.push(s));
  let landed = false;
  const set = p.ctx.citadel.storage.set('k', 'b').then(() => {
    landed = true;
  });
  await wait(10);
  assert.equal(p.ctx.citadel.saveState(), 'saving');
  const first = p.waiting('write')[0];
  first.answered = true;
  p.deliver({ re: first.id, ok: false, error: 'Citadel is restarting, try again in a moment', retry: true });
  await wait(1);
  assert.equal(p.ctx.citadel.saveState(), 'retrying');
  assert.equal(landed, false, 'the write is still on its way, not failed');
  assert.equal(p.bars.length, 0, 'a restart is not a lost connection');
  // What the server holds meanwhile doesn't wipe it.
  p.deliver({ op: 'changed', entries: [{ key: 'k', value: 'a' }] });
  assert.equal(await p.ctx.citadel.storage.get('k'), 'b');
  // Sent again, with the same value, once Citadel is back.
  await wait(40);
  assert.equal(JSON.stringify(p.waiting('write').map((m) => m.entries)), JSON.stringify([[{ key: 'k', value: 'b' }]]));
  p.answer('write', { entries: [{ key: 'k', value: 'b' }] });
  await set;
  assert.equal(p.ctx.citadel.saveState(), 'saved');
  assert.deepEqual(states, ['saved', 'saving', 'retrying', 'saved'], 'told now, then on each change');
});

test('a write the viewer refuses for good still fails at once, and the save state says saved again (#821)', async () => {
  const p = page();
  p.answer('hello', { person: 'Cara', entries: [] });
  await p.ctx.citadel.ready;
  const set = p.ctx.citadel.storage.set('k', 'x');
  await wait(10);
  p.answer('write', 'Too many writes; slow down', false);
  await assert.rejects(set, /Too many writes/);
  assert.equal(p.ctx.citadel.saveState(), 'saved');
});

test('typing on the page tells the viewer, at most once a second, so a new front end does not reload under it (#821)', async () => {
  const p = page();
  p.answer('hello', { person: 'Cara', entries: [] });
  await p.ctx.citadel.ready;
  p.fire('input');
  p.fire('keydown');
  p.fire('input');
  assert.equal(p.posted.filter((m) => m.op === 'typing').length, 1);
});

test('a link to another site opens a tab and asks the viewer nothing', async () => {
  const p = page();
  const opened = [];
  Object.assign(p.ctx, { URL, location: { origin: 'null' }, open: (...a) => opened.push(a) });
  p.ctx.document.baseURI = 'https://citadel.example/files/p.html';
  const a = { getAttribute: (k) => (k === 'href' ? 'https://example.org/x' : null) };
  const e = {
    button: 0,
    defaultPrevented: false,
    target: { closest: () => a },
    preventDefault() {
      this.defaultPrevented = true;
    },
  };
  p.fire('click', e);
  assert.equal(e.defaultPrevented, true);
  assert.deepEqual(opened, [['https://example.org/x', '_blank', 'noopener']]);
  assert.equal(p.waiting('link').length, 0);
});
