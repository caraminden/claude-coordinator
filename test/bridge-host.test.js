// The artifact bridge's viewer side (public/bridge-host.js) when Citadel is slow, restarting or just reconnected (#1862):
// a page's write lands once, its Send goes once, and what others changed while the stream was down reaches it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachBridge, bridgeUnsaved, onArtifactData, refreshFrames, TAG } from '../public/bridge-host.js';

/** A viewer whose window, frames and API are stand-ins: what it posted to each page, and what it asked the server. */
function viewer(t, api) {
  let onMessage = null;
  globalThis.addEventListener = (type, fn) => {
    if (type === 'message') onMessage = fn;
  };
  const opened = [];
  t.after(() => {
    delete globalThis.addEventListener;
    // Taken out at the end, so the next test's viewer starts with no frames (and listens afresh).
    for (const f of opened) f.close();
    onArtifactData('none');
  });
  return (page, tab = false, more = {}) => {
    const posted = [];
    const win = { closed: false, postMessage: (m) => posted.push(m) };
    const iframe = { isConnected: true, contentWindow: win };
    attachBridge(tab ? null : iframe, { open: { artifact: 1 }, name: `${page}.html`, owner: 'Cara', api, ...(tab ? { tab: win } : {}), ...more });
    const f = {
      posted,
      ask: (id, body) => onMessage({ source: win, origin: 'null', data: { bridge: TAG, id, page, ...body } }),
      close: () => {
        iframe.isConnected = false;
        win.closed = true;
      },
    };
    opened.push(f);
    return f;
  };
}
const settled = () => new Promise((r) => setImmediate(r));

test('the viewer says it has a request, and that it still works on it, until it answers; a new front end waits for a write on its way (#1862)', async (t) => {
  let land;
  const open = viewer(t, () => new Promise((r) => (land = r)));
  const p = open('pw');
  p.ask(1, { op: 'write', entries: [{ key: 'k', value: 1 }] });
  assert.deepEqual(p.posted, [{ bridge: TAG, ack: 1 }]);
  assert.equal(bridgeUnsaved(), true, 'a reload now could lose it');
  p.ask(1, { op: 'alive' });
  assert.deepEqual(p.posted.at(-1), { bridge: TAG, ack: 1 });
  assert.equal(p.posted.length, 2);
  land({ store: 's', entries: [], person: 'Cara' });
  await settled();
  assert.equal(p.posted.at(-1).ok, true);
  assert.equal(bridgeUnsaved(), false);
  p.ask(1, { op: 'alive' });
  assert.equal(p.posted.length, 3, 'nothing is being worked on any more');
  // A page that opens is told who looks at what before the server has answered.
  p.ask(2, { op: 'hello' });
  assert.equal(bridgeUnsaved(), true, 'picks may wait on a hello');
  assert.deepEqual(p.posted.at(-1).known, { person: null, file: 'pw.html', owner: 'Cara', draw: false });
});

test('a page whose hello fails as Citadel restarts holds a new front end: it may have picks waiting on it (#1862)', async (t) => {
  let fail = Object.assign(new Error('restarting'), { status: 502 });
  const open = viewer(t, async () => {
    if (fail) throw fail;
    return { store: 's', entries: [], person: 'Cara' };
  });
  const p = open('ph');
  p.ask(1, { op: 'hello' });
  await settled();
  assert.equal(p.posted.at(-1).retry, true);
  assert.equal(bridgeUnsaved(), true);
  fail = null;
  p.ask(2, { op: 'hello' });
  await settled();
  assert.equal(bridgeUnsaved(), false);
});

test('a Send pressed again while the first is out posts once, and one pressed again after a lost reply carries the same id (#1862)', async (t) => {
  for (const tab of [false, true]) {
    const calls = [];
    const open = viewer(t, (_path, { body }) => new Promise((resolve, reject) => calls.push({ body, resolve, reject })));
    const p = open(tab ? 'pt' : 'ps', tab);
    p.ask(1, { op: 'send', text: 'Picks: 3' });
    p.ask(2, { op: 'send', text: 'Picks: 3' });
    await settled();
    assert.equal(calls.length, 1);
    calls[0].reject(new TypeError('Failed to fetch'));
    await settled();
    assert.deepEqual(
      p.posted
        .filter((m) => m.re)
        .map((m) => [m.re, m.ok])
        .sort(),
      [
        [1, false],
        [2, false],
      ],
      'both hear how it went',
    );
    p.ask(3, { op: 'send', text: 'Picks: 3' });
    await settled();
    assert.equal(calls.length, 2);
    assert.ok(calls[0].body.sendId);
    assert.equal(calls[1].body.sendId, calls[0].body.sendId, 'the server may have taken the first');
    calls[1].resolve({ to: { label: '#4' } });
    await settled();
    assert.deepEqual(p.posted.at(-1), { bridge: TAG, re: 3, ok: true, result: { sent: true, to: '#4' } });
    if (tab) break; // a tab waits a few seconds between sends
    p.ask(4, { op: 'send', text: 'Picks: 3' });
    p.ask(5, { op: 'send', text: 'Picks: 4' });
    await settled();
    assert.equal(new Set(calls.map((c) => c.body.sendId)).size, 3, 'the same text sent afresh, or another, is a message of its own');
    for (const c of calls.slice(2)) c.resolve({ to: { label: '#4' } });
    await settled();
    p.close();
  }
});

test('after the stream dropped, every page open here is sent what its store holds now, an Open tab too, tried again until Citadel answers (#1862)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let fail = null;
  let value = 1;
  const open = viewer(t, async (_path, { body }) => {
    if (fail) throw fail;
    return { store: body.page, entries: [{ key: 'k', value }] };
  });
  const [p, tab, quiet] = [open('p1'), open('p2', true), open('p3')];
  for (const f of [p, tab]) f.ask(1, { op: 'hello' });
  await settled();
  for (const f of [p, tab]) f.posted.length = 0;
  value = 2;
  fail = new TypeError('Failed to fetch');
  refreshFrames();
  await settled();
  assert.deepEqual([p.posted, tab.posted], [[], []]);
  fail = null;
  t.mock.timers.tick(1000);
  await settled();
  const now = { bridge: TAG, op: 'changed', entries: [{ key: 'k', value: 2 }] };
  assert.deepEqual([p.posted, tab.posted, quiet.posted], [[now], [now], []]);
});

test("an older look at a store that answers late never puts a page's old values back (#1862)", async (t) => {
  const lists = [];
  const open = viewer(t, (_path, { body }) => (body.op === 'list' && lists.length < 2 ? new Promise((r) => lists.push(r)) : Promise.resolve({ store: 's', entries: [] })));
  const p = open('p1');
  lists.push(0, 0);
  p.ask(1, { op: 'hello' });
  await settled();
  lists.length = 0;
  p.posted.length = 0;
  onArtifactData('s');
  onArtifactData('s');
  lists[1]({ store: 's', entries: [{ key: 'k', value: 'new' }] });
  await settled();
  lists[0]({ store: 's', entries: [{ key: 'k', value: 'old' }] });
  await settled();
  assert.deepEqual(
    p.posted.map((m) => m.entries[0].value),
    ['new'],
  );
});

test('a Send too long for Citadel hears so, and posts nothing; a page the viewer may not answer still hears nothing (#1940 HK1)', async (t) => {
  let calls = 0;
  const open = viewer(t, async () => (calls++, { to: { label: '#4' } }));
  const p = open('pl');
  p.ask(1, { op: 'send', text: 'x'.repeat(12_345) });
  await settled();
  assert.deepEqual(
    p.posted.filter((m) => m.re),
    [{ bridge: TAG, re: 1, ok: false, error: '12,345 characters is too long (10,000 at most). Shorten your notes and send again' }],
  );
  assert.equal(calls, 0);
  p.posted.length = 0;
  p.ask(2, { op: 'send', text: 'x'.repeat(12_345), bridge: 'other' });
  await settled();
  assert.deepEqual(p.posted, []);
});

test('the viewer closes on a Send only once the page has stored what it wrote on the answer, or after 5 s (#1940 HK3)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const closed = [];
  const open = viewer(t, async (path) => (path === 'api/artifact-send' ? { to: { label: '#4' } } : { store: 's', entries: [], person: 'Cara' }));
  const answered = (p, id) => p.posted.some((m) => m.re === id && m.ok);
  const p = open('pc', false, { afterSend: () => closed.push('pc') });
  p.ask(1, { op: 'send', text: 'Picks: 3' });
  await settled();
  assert.ok(answered(p, 1));
  assert.deepEqual(closed, [], 'the page still has to store that it sent');
  p.ask(2, { op: 'write', entries: [{ key: 'localStorage/sent', value: 'Picks: 3' }] });
  await settled();
  assert.ok(answered(p, 2), 'the write lands in the open viewer');
  p.ask(3, { op: 'kept' });
  await settled();
  assert.deepEqual(closed, ['pc']);
  // Something it wrote was refused for good: closing would lose it without a word.
  const full = open('pf', false, { afterSend: () => closed.push('pf') });
  full.ask(1, { op: 'send', text: 'a' });
  await settled();
  full.ask(2, { op: 'kept', all: false });
  await settled();
  t.mock.timers.tick(5000);
  await settled();
  assert.deepEqual(closed, ['pc']);
  // A page that never says (it was served before this, or its write waits for a restart) holds it 5 s; one closed meanwhile, or kept open, isn't closed.
  const old = open('po', false, { afterSend: () => closed.push('po') });
  const left = open('pl', false, { afterSend: () => closed.push('pl') });
  const stays = open('pk', false, { afterSend: () => closed.push('pk') });
  old.ask(1, { op: 'send', text: 'a' });
  left.ask(1, { op: 'send', text: 'a' });
  stays.ask(1, { op: 'send', text: 'a', keepOpen: true });
  await settled();
  left.close();
  t.mock.timers.tick(4999);
  await settled();
  assert.deepEqual(closed, ['pc']);
  t.mock.timers.tick(1);
  await settled();
  assert.deepEqual(closed, ['pc', 'po']);
});
