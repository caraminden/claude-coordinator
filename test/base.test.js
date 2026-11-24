// The front end's base helpers (public/base.js): paths, file kinds, sizes, costs, ages and minion names.
// Importing it here is itself the check that it needs no document at load.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  account,
  ago,
  api,
  missedNews,
  newsArrived,
  poller,
  whenShown,
  baseName,
  costText,
  fileExt,
  fileHref,
  fileKind,
  fileUrl,
  formatSize,
  isLocalPath,
  isSeen,
  joinPath,
  listGroupsOf,
  me,
  setAccount,
  setView,
  sharedHref,
  sharedUrl,
  shortPath,
  statusLabel,
  taskmasterName,
  threadFullName,
  threadHref,
  threadLabel,
  threadTitleParts,
  uploadUrl,
} from '../public/base.js';

test('joinPath resolves a relative link against its folder', () => {
  const rows = [
    ['docs/specs', 'plan.md', 'docs/specs/plan.md'],
    ['docs/specs', './plan.md', 'docs/specs/plan.md'],
    ['docs/specs', '../img/a.png', 'docs/img/a.png'],
    ['docs', '../../a.png', '../a.png'],
    ['', 'a.png', 'a.png'],
    ['', '../a.png', '../a.png'],
    ['docs', '/abs/a.png', '/abs/a.png'],
    ['/home/x', '../y/a.md', '/home/y/a.md'],
    // The root is never popped.
    ['/home', '../../a.md', '/../a.md'],
    ['docs', '..', '.'],
    ['docs', 'a//b/', 'docs/a/b'],
  ];
  for (const [dir, rel, want] of rows) assert.equal(joinPath(dir, rel), want, `${dir} + ${rel}`);
});

test('fileKind goes by extension, whatever its case, ignoring a query or fragment', () => {
  assert.equal(fileKind('notes/Plan.MD'), 'markdown');
  assert.equal(fileKind('a/b/shot.png?v=2'), 'image');
  assert.equal(fileKind('page.html#top'), 'html');
  assert.equal(fileKind('clip.webm'), 'video');
  assert.equal(fileKind('out.tar'), 'download');
  assert.equal(fileKind('build/app-release.APK'), 'download');
  assert.equal(fileKind('ext/fst-v1.2.xpi'), 'download');
  assert.equal(fileKind('ext.CRX'), 'download');
  assert.equal(fileKind('run.exe'), null);
  assert.equal(fileKind('Makefile'), null);
  assert.equal(fileExt('a/b/shot.png'), 'PNG');
  assert.equal(fileExt('Makefile'), 'FILE');
});

test("baseName is the last part of a path, a folder's trailing slash ignored", () => {
  const rows = [
    ['docs/specs/plan.md', 'plan.md'],
    ['plan.md', 'plan.md'],
    ['/abs/shot.png', 'shot.png'],
    ['docs/specs/', 'specs'],
    ['', ''],
  ];
  for (const [path, want] of rows) assert.equal(baseName(path), want, path);
});

test('file addresses carry the path as one encoded part, so a caller can append &v= and the router gets it back whole', () => {
  const odd = 'docs/50% off & more #2?.md';
  const enc = 'docs%2F50%25%20off%20%26%20more%20%232%3F.md';
  assert.equal(fileUrl(7, odd), `api/tickets/7/file?path=${enc}`);
  assert.equal(fileHref(7, odd), `#/f/7/${enc}`);
  assert.equal(sharedUrl(2, odd), `api/projects/2/shared/file?path=${enc}`);
  assert.equal(sharedHref(2, odd), `#/s/2/${enc}`);
  assert.equal(uploadUrl(7, 'shot 1#.png'), 'api/tickets/7/uploads/shot%201%23.png');
});

test('isLocalPath tells a path from a URL, a fragment or a mail address', () => {
  for (const p of ['a.md', '/abs/a.md', '../a.md']) assert.equal(isLocalPath(p), true, p);
  for (const p of ['https://x.test/a.md', '//x.test/a.md', '#top', 'mailto:a@b.test']) assert.equal(isLocalPath(p), false, p);
});

test('shortPath names the shared folders and keeps the tail of other absolute paths', () => {
  assert.equal(shortPath('/data/projects/2/shared/project/specs/plan.md'), 'scheme shared/specs/plan.md');
  assert.equal(shortPath('/data/projects/2/shared/1022/shot.png'), 'shared files/shot.png');
  assert.equal(shortPath('/data/projects/2/tickets/1022/docs/plan.md'), '…/docs/plan.md');
  assert.equal(shortPath('docs/plan.md'), 'docs/plan.md');
});

test('formatSize switches units and drops the decimal from 10 KB up', () => {
  assert.equal(formatSize(0), '0 B');
  assert.equal(formatSize(1023), '1023 B');
  assert.equal(formatSize(1024), '1.0 KB');
  assert.equal(formatSize(10 * 1024), '10 KB');
  assert.equal(formatSize(1024 * 1024 - 1), '1024 KB');
  assert.equal(formatSize(5.5 * 1024 * 1024), '5.5 MB');
});

test('costText shows cents under $10 and whole dollars from there', () => {
  assert.equal(costText(0.416), '≈ $0.42');
  assert.equal(costText(9.999), '≈ $10.00');
  assert.equal(costText(10), '≈ $10');
  assert.equal(costText(12.5), '≈ $13');
});

test('ago rounds down to the biggest unit', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
  const back = (s) => ago(Date.now() - s * 1000);
  assert.equal(back(59), 'just now');
  assert.equal(back(60), '1m ago');
  assert.equal(back(3599), '59m ago');
  assert.equal(back(3600), '1h ago');
  assert.equal(back(86399), '23h ago');
  assert.equal(back(3 * 86400), '3d ago');
});

test("listGroupsOf reads a scheme's promoted groups and survives junk", () => {
  assert.deepEqual(listGroupsOf({ list_groups: '["area: ui"]' }), ['area: ui']);
  assert.deepEqual(listGroupsOf({ list_groups: '{oops' }), []);
  assert.deepEqual(listGroupsOf({}), []);
  assert.deepEqual(listGroupsOf(null), []);
});

// h() makes elements, so the name helpers that return nodes get the least document that can.
class Node {}
class El extends Node {
  constructor(tag) {
    super();
    this.tag = tag;
    this.attrs = {};
    this.kids = [];
  }
  setAttribute(k, v) {
    this.attrs[k] = v;
  }
  append(c) {
    this.kids.push(c);
  }
  get text() {
    return this.kids.map((k) => (k instanceof El ? k.text : k)).join('');
  }
}
const flat = (parts) =>
  [parts]
    .flat()
    .map((p) =>
      p instanceof El
        ? `<${
            p.className ??
            Object.entries(p.attrs)
              .map(([k, v]) => `${k}=${v}`)
              .join(' ')
          }>${p.text}</>`
        : p,
    )
    .join('');

test('minion names: the full name, its phone-friendly parts, the address and the status word', (t) => {
  Object.assign(globalThis, { Node, document: { createElement: (tag) => new El(tag) } });
  t.after(() => {
    delete globalThis.Node;
    delete globalThis.document;
    setView(null);
  });
  const minion = { id: 900, number: 12, project_id: 2, title: 'Usage bar', status: 'idle', state: 'ready', properties: { type: 'feature' } };
  // No type or state emoji (#647); `other` has no type word; no number falls back to the id.
  assert.equal(threadFullName(minion), '12 FEATURE: Usage bar');
  assert.equal(flat(threadTitleParts(minion)), '12 <wide-only>FEATURE: </>Usage bar');
  const plain = { id: 900, project_id: 2, title: 'Odd job', status: 'idle', properties: { type: 'other' } };
  assert.equal(threadFullName(plain), '900 Odd job');
  assert.equal(flat(threadTitleParts(plain)), '900 Odd job');
  assert.equal(threadHref(minion), '#/p/2/t/12');
  assert.equal(threadHref(plain), '#/t/900');

  // The Taskmaster goes by its scheme's name, and is "Ready" where a new minion is "Starting".
  const tm = { id: 1, kind: 'coordinator', project_id: 2, status: 'new' };
  setView({ kind: 'project', projectId: 2, projects: [{ id: 2, name: 'Citadel' }] });
  assert.equal(threadFullName(tm), 'Citadel Taskmaster');
  assert.equal(flat(threadTitleParts(tm)), '<data-taskmaster-name=2>Citadel Taskmaster</>');
  assert.equal(threadHref(tm), '#/p/2');
  assert.equal(statusLabel(tm), 'Ready');
  assert.equal(statusLabel({ ...minion, status: 'new' }), 'Starting');
  assert.equal(statusLabel(minion), 'Idle');
});

test('isSeen: a thread opened at or after its last change, and not one never opened', (t) => {
  t.after(() => setView(null));
  setView({ kind: 'project', projectId: 2, seen: { 5: 1000 } });
  assert.equal(isSeen({ id: 5, updated_at: 1000 }), true, 'opened at the moment it last changed');
  assert.equal(isSeen({ id: 5, updated_at: 999 }), true);
  assert.equal(isSeen({ id: 5, updated_at: 1001 }), false, 'changed since');
  assert.equal(isSeen({ id: 6, updated_at: 1 }), false, 'never opened');
  setView({ kind: 'project', projectId: 2 });
  assert.equal(isSeen({ id: 5, updated_at: 1 }), false, 'nothing opened yet');
});

test('the Taskmaster goes by the name of the scheme asked for, from the list or the scheme on screen', (t) => {
  t.after(() => setView(null));
  setView({
    kind: 'project',
    projectId: 2,
    projects: [
      { id: 1, name: 'Delve' },
      { id: 2, name: 'Citadel' },
    ],
  });
  assert.equal(taskmasterName(), 'Citadel Taskmaster', 'the scheme on screen by default');
  assert.equal(taskmasterName(1), 'Delve Taskmaster');
  assert.equal(taskmasterName(9), 'Taskmaster', 'a scheme not in the list');
  // A page with only its own scheme loaded (no list) names that one, and no other.
  setView({ kind: 'thread', projectId: 3, project: { id: 3, name: 'Mandate' } });
  assert.equal(taskmasterName(), 'Mandate Taskmaster');
  assert.equal(taskmasterName(1), 'Taskmaster');
  setView({ kind: 'project', projectId: 4, projects: [{ id: 4, name: '' }] });
  assert.equal(taskmasterName(), 'Taskmaster', 'a scheme with no name');
  setView(null);
  assert.equal(taskmasterName(2), 'Taskmaster', 'before anything loads');
});

test('threadLabel: "#number title" for a minion, falling back to the id, and the scheme\'s Taskmaster name for a Taskmaster', (t) => {
  t.after(() => setView(null));
  setView({
    kind: 'project',
    projectId: 2,
    projects: [
      { id: 1, name: 'Delve' },
      { id: 2, name: 'Citadel' },
    ],
  });
  assert.equal(threadLabel({ id: 900, kind: 'ticket', number: 12, project_id: 2, title: 'Usage bar' }), '#12 Usage bar');
  assert.equal(threadLabel({ id: 900, kind: 'ticket', project_id: 2, title: 'Odd job' }), '#900 Odd job', 'a server from before per-scheme numbers');
  assert.equal(threadLabel({ id: 50, kind: 'ticket', number: 3, project_id: 1, title: 'Cave art' }), '#3 Cave art', "another scheme's minion");
  assert.equal(threadLabel({ id: 1, kind: 'coordinator', project_id: 1, title: 'ignored' }), 'Delve Taskmaster', 'its own scheme, not the one on screen');
});

test('setAccount: who is signed in, as every module reads it, and nobody after signing out', (t) => {
  t.after(() => setAccount(null));
  setAccount({ name: 'Cara', login: 'cara', admin: true });
  assert.equal(me, 'Cara');
  assert.equal(account.login, 'cara');
  setAccount(null);
  assert.equal(me, null);
  assert.equal(account, null);
});

test('missedNews: a tab back within a minute with stream news since it hid asks for nothing; longer, silent or frozen resyncs (#1528)', () => {
  const hid = 1_000_000;
  assert.equal(missedNews(hid, hid + 5_000, hid + 59_999, false), false, 'hidden under a minute, the stream delivered meanwhile');
  assert.equal(missedNews(hid, hid + 5_000, hid + 60_000, false), true, 'hidden a minute or more');
  assert.equal(missedNews(hid, hid - 1, hid + 10_000, false), true, 'no stream message since it hid: maybe a dead stream that still reads OPEN');
  assert.equal(missedNews(hid, hid + 5_000, hid + 10_000, true), true, 'the browser froze the page');
});

/** fetch replaced by one that counts calls and answers when told to. */
function fakeFetch(t) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = (path, opts) => new Promise((resolve) => calls.push({ path, method: opts?.method ?? 'GET', answer: (body) => resolve({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)) }) }));
  t.after(() => {
    globalThis.fetch = real;
    newsArrived();
  });
  return calls;
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('api: GETs of one path at once share a request, and each caller gets its own copy (#1528)', async (t) => {
  const calls = fakeFetch(t);
  const a = api('api/x'),
    b = api('api/x'),
    c = api('api/y');
  assert.deepEqual(
    calls.map((x) => x.path),
    ['api/x', 'api/y'],
  );
  calls[0].answer({ list: [1] });
  calls[1].answer({});
  const [ra, rb] = await Promise.all([a, b, c]);
  assert.deepEqual(ra, { list: [1] });
  assert.notEqual(ra, rb, "a caller changing its answer leaves the other's alone");
  await settle();
  api('api/x');
  assert.equal(calls.length, 3, 'once answered, the next GET asks again');
});

test('api: a write, or news on the stream, stops a later GET joining one sent before it (#1528)', async (t) => {
  const calls = fakeFetch(t);
  api('api/x');
  api('api/x', { method: 'POST', body: { a: 1 } });
  api('api/x');
  assert.deepEqual(
    calls.map((x) => x.method),
    ['GET', 'POST', 'GET'],
    'after a write',
  );
  newsArrived();
  api('api/x');
  assert.equal(calls.length, 4, 'after stream news');
  api('api/x');
  assert.equal(calls.length, 4, 'and shares again after that');
  for (const x of calls) x.answer({});
});

test('whenShown: runs at once in a shown tab, and only once the tab is next shown in a hidden one (#1528)', (t) => {
  const ran = [];
  whenShown(() => ran.push('no document'));
  const listeners = new Set();
  globalThis.document = { hidden: true, addEventListener: (_, f) => listeners.add(f), removeEventListener: (_, f) => listeners.delete(f) };
  t.after(() => {
    delete globalThis.document;
  });
  const change = (hidden) => {
    document.hidden = hidden;
    for (const f of [...listeners]) f();
  };
  whenShown(() => ran.push('poll'));
  assert.deepEqual(ran, ['no document'], 'nothing while hidden');
  change(true);
  assert.deepEqual(ran, ['no document'], 'still hidden');
  change(false);
  assert.deepEqual(ran, ['no document', 'poll'], 'shown');
  change(true);
  change(false);
  assert.deepEqual(ran, ['no document', 'poll'], 'once');
  whenShown(() => ran.push('shown tab'));
  assert.deepEqual(ran, ['no document', 'poll', 'shown tab']);
});

test('poller: one read at a time, a joiner during a read takes it, it waits while hidden and stops on false (#1610)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const listeners = new Set();
  globalThis.document = { hidden: false, addEventListener: (_, f) => listeners.add(f), removeEventListener: (_, f) => listeners.delete(f) };
  t.after(() => {
    delete globalThis.document;
  });
  const flush = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  let reads = 0,
    release = null,
    alive = true;
  const p = poller(() => {
    reads++;
    return new Promise((r) => {
      release = () => r(alive ? undefined : false);
    });
  }, 60_000);
  p.now();
  p.now();
  t.mock.timers.tick(0);
  assert.equal(reads, 1, 'two now() calls before the timer fire one read');
  p.now();
  t.mock.timers.tick(0);
  assert.equal(reads, 1, 'now() during a read starts no second one');
  document.hidden = true;
  release();
  await flush();
  t.mock.timers.tick(60_000);
  assert.equal(reads, 1, 'due but hidden: waits');
  p.now();
  t.mock.timers.tick(0);
  assert.equal(reads, 1, 'now() while a read is due starts no second one');
  document.hidden = false;
  for (const f of [...listeners]) f();
  assert.equal(reads, 2, 'read once shown');
  alive = false;
  release();
  await flush();
  t.mock.timers.tick(120_000);
  assert.equal(reads, 2, 'false stops the loop');
  p.now();
  t.mock.timers.tick(0);
  assert.equal(reads, 3, 'now() restarts a stopped one');
  release();
  await flush();
});
