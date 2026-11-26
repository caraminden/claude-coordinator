// public/reviews.js (#1309): the Reviewers and critics page shows the shared loading line until its set arrives, then its head and tabs, and empty set draws without error. Citadel's real front end in headless Chromium (test/browser.ts), with fetch answered in the page.
import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import { chromium, launch, waitFor, type Browser, serveApp, skipMessage, type App, type Page } from './browser.ts';
import { pageStub } from './page-stub.ts';

const bin = chromium();
const skip = !bin && skipMessage;

const STUB = pageStub(`
  window.ready = true;
  window.gate = new Promise((r) => { window.open = r; });
  async function route(path) {
    if (path === 'api/projects') return reply(200, [{ id: 1, name: 'Alpha', inbox: 0, icon: null }]);
    if (/^api\\/projects\\/1$/.test(path)) return reply(200, { project: { id: 1, name: 'Alpha', instructions: '' }, coordinator: { id: 100, project_id: 1, kind: 'coordinator', number: 0, title: 'Taskmaster', status: 'idle', updated_at: Date.now(), created_at: Date.now() }, tickets: [] });
    if (path === 'api/projects/1/reviews') { await window.gate; return reply(200, { entries: [], starters: [], audits: [], glance: null }); }
    if (/inbox$/.test(path)) return reply(200, []); // this file's server answered an inbox with []
  }
`);

let app: App;
let browser: Browser;

before(async () => {
  if (skip) return;
  app = await serveApp({ stub: STUB });
  browser = await launch(bin!);
});
after(async () => {
  await browser?.close();
  await app?.close();
});

test('the page shows the shared loading line, then its head and both tabs in the same place', { skip }, async () => {
  const page = await browser.page(`${app.base}#/p/1/reviews`, { width: 1280, height: 800 });
  await waitFor(page, 'the loading line', `!!document.querySelector('.reviews-main .cui-loading[role=status]')`);
  assert.equal(await page.eval(`document.querySelector('.reviews-main .cui-loading').textContent.trim()`), 'Loading…');
  const top = await page.eval<number>(`document.querySelector('.reviews-main .rv-head').getBoundingClientRect().top`);
  await page.eval('window.open()');
  await waitFor(page, 'the set to draw', `!document.querySelector('.reviews-main .cui-loading')`);
  assert.deepEqual(await page.eval(`[...document.querySelectorAll('.reviews-main .rv-tabs button')].map((b) => b.textContent)`), ['This scheme', 'Every scheme']);
  assert.equal(await page.eval<number>(`document.querySelector('.reviews-main .rv-head').getBoundingClientRect().top`), top, 'the head did not move');
});

// ---- Half-typed forms (#1857): what is typed outlives the page's redraws, late answers and other people's changes. ----

const DRAFTS = `<script>
  window.ready = true;
  window.errors = [];
  addEventListener('error', (e) => errors.push(String(e.message)));
  addEventListener('unhandledrejection', (e) => errors.push(String(e.reason?.stack ?? e.reason)));
  const now = Date.now();
  const entry = (slug, name, more) => ({ slug, name, kind: 'critic', stage: 'work', when: 'ask', triggers: { ask: true }, context: {}, body: 'saved text of ' + slug, enabled: true, trial: false, gate: null, kit: false, file: null, on_fail: null, panel: null, runs: [], verdicts: [], version: 1, updated_by: 'cara', updated_at: now, ...more });
  const set = () => [
    entry('ui', 'UI critic', { verdicts: [{ id: 1, words: 'too strict', person: 'josh', at: now, minion: '#1' }, { id: 2, words: 'too soft', person: 'josh', at: now, minion: '#2' }] }),
    entry('art', 'Art critic'),
    entry('pre-ship-review', 'Pre-ship review', { kit: true, kind: 'reviewer', stage: 'ship', what: 'Reviews the diff', lessons: [{ kind: 'lint', lesson: true, why: 'CI does it', count: 3, last: now }] }),
    entry('lens-ui', 'Lens: UI', { kit: true, kind: 'reviewer', stage: 'ship', what: 'A lens' }),
  ];
  window.sets = { 1: set(), 2: set() };
  window.down = false; // every list read fails
  window.calls = [];
  window.waits = []; // { match, wait }: a request whose "METHOD path" holds \`match\` is answered, but only arrives once \`wait\` settles
  window.hold = (match) => { const w = { match }; w.wait = new Promise((r) => { w.open = r; }); waits.push(w); return w; };
  const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const answer = (method, path, body) => {
    if (path === 'api/me') return reply({ name: 'Cara', login: 'cara', admin: true, uid: 1 });
    if (path === 'api/projects') return reply([1, 2].map((id) => ({ id, name: id === 1 ? 'Alpha' : 'Beta', inbox: 0, icon: null })));
    let m = path.match(/^api\\/projects\\/(\\d)$/);
    if (m) return reply({ project: { id: +m[1], name: m[1] === '1' ? 'Alpha' : 'Beta', instructions: '' }, coordinator: { id: 100 + +m[1], project_id: +m[1], kind: 'coordinator', number: 0, title: 'Taskmaster', status: 'idle', updated_at: now, created_at: now }, tickets: [] });
    if (/properties$/.test(path)) return reply({ keys: [] });
    if (path === 'api/reviews/schemes') return reply({ schemes: [] });
    m = path.match(/^api\\/projects\\/(\\d)\\/reviews(?:\\/([^/]+))?(?:\\/(.+))?$/);
    if (!m) return reply([]);
    const list = sets[m[1]];
    const [, , slug, rest] = m;
    const e = list.find((x) => x.slug === slug);
    if (!slug && method === 'GET') return down ? reply({ error: 'Restarting' }, 502) : reply({ entries: structuredClone(list), starters: [], audits: [], glance: null });
    if (!slug) { const made = entry(body.slug, body.slug, { trial: true }); list.push(made); return reply(made, 201); }
    if (slug === 'describe') return reply({ note: 'Answered', proposals: [{ slug: 'art', name: 'Art critic', before: 'a', after: 'b', version: 1 }] });
    if (rest === 'versions') return reply({ versions: [1, 0].map((v) => ({ version: v, by: 'cara', at: now, note: 'In ' + m[1] })) });
    if (rest === 'restore') { e.version++; e.body = 'restored in ' + m[1]; return reply(structuredClone(e)); }
    if (method === 'PATCH') {
      if (body.version !== undefined && body.version !== e.version) return reply({ error: slug + ' is at version ' + e.version + ' now' }, 409);
      const { version, note, when, ...f } = body;
      Object.assign(e, f, { version: e.version + 1 });
      return reply(structuredClone(e));
    }
    return reply({ ok: true });
  };
  window.fetch = async (input, init = {}) => {
    const path = new URL(typeof input === 'string' ? input : input.url, location.href).pathname.replace(/^\\//, '');
    const line = (init.method ?? 'GET') + ' ' + path;
    calls.push(line);
    const r = answer(init.method ?? 'GET', path, init.body ? JSON.parse(init.body) : null);
    const at = waits.findIndex((w) => line.includes(w.match));
    if (at >= 0) await waits.splice(at, 1)[0].wait;
    return r;
  };
  // The stub answers within the task that asks, so a few frames on an answer is drawn.
  window.drawn = async () => { for (let i = 0; i < 5; i++) await new Promise(requestAnimationFrame); };
  window.streams = [];
  window.EventSource = class { constructor() { streams.push(this); } close() {} };
  // What the server sends when a minion records a run, a verdict or a refute, or anyone saves.
  window.changed = (projectId = 1) => streams.at(-1).onmessage({ data: JSON.stringify({ type: 'reviews', projectId }) });
  window.$ = (sel) => document.querySelector('.reviews-main ' + sel);
  window.press = (text, within = '') => {
    const b = [...document.querySelectorAll('.reviews-main ' + within + ' button')].find((x) => x.textContent.trim().startsWith(text));
    if (!b) throw new Error('no button ' + text);
    b.click();
  };
  window.openEdit = (name) => { [...document.querySelectorAll('.reviews-main .rv-card, .reviews-main .rv-lens-name')].find((x) => x.textContent.includes(name)).click(); press('Edit by hand'); };
  window.type = (sel, text) => { const el = $(sel); el.value = text; el.dispatchEvent(new Event('input', { bubbles: true })); };
  window.drafts = () => [...document.querySelectorAll('#app [data-draft]')].some((el) => el.value.trim()); // core.js unsentWork
</script>`;

const BODY = '.rv-form .rv-bodytext';
let drafts: App;
before(async () => {
  if (!skip) drafts = await serveApp({ stub: DRAFTS });
});
after(() => drafts?.close());
// Some fifty open pages in one browser slow each other's boot on a loaded box.
const opened: Page[] = [];
afterEach(async () => {
  for (const page of opened.splice(0)) await page.send('Page.close');
});

async function reviews(scheme = 1): Promise<Page> {
  const page = await browser.page(`${drafts.base}#/p/${scheme}/reviews`, { width: 1440, height: 900 });
  opened.push(page);
  await waitFor(page, 'the board', `$('.rv-card') && streams.at(-1)?.onmessage`);
  return page;
}
/** Goes somewhere else in the app, and waits for that page. */
const go = async (page: Page, hash: string, shown: string) => {
  await page.eval(`location.hash = ${JSON.stringify(hash)}`);
  await waitFor(page, hash, shown);
};
const IN_SCHEME = (name: string) => `$('.rv-scheme')?.textContent.includes(${JSON.stringify(name)}) && $('.rv-card')`;

// What else can happen on the page while a form is open, each ending once its redraw is on screen.
const REDRAWS: Record<string, (page: Page) => Promise<unknown>> = {
  'an Ask answer': async (page) => {
    await page.eval(`type('.rv-ask-row input', 'stricter'), press('Ask')`);
    await waitFor(page, 'the answer', `$('.rv-proposal')`);
  },
  Apply: async (page) => {
    await REDRAWS['an Ask answer']!(page);
    await page.eval(`type('${BODY}', 'typed'), press('Apply')`);
    await waitFor(page, 'it applied', `$('.rv-applied')`);
  },
  Dismiss: async (page) => {
    await REDRAWS['an Ask answer']!(page);
    await page.eval(`type('${BODY}', 'typed'), press('Dismiss')`);
    await waitFor(page, 'the proposal gone', `!$('.rv-proposal')`);
  },
  'the lenses toggle': (page) => page.eval(`$('.rv-lens-row').click()`),
  'the tabs': async (page) => {
    await page.eval(`press('Every scheme', '.rv-tabs')`);
    await waitFor(page, 'the other tab', `!$('.rv-board')`);
    await page.eval(`press('This scheme', '.rv-tabs')`);
  },
  'leaving and coming back': async (page) => {
    await go(page, '#/p/1/settings', `!document.querySelector('.reviews-main')`);
    const was = await page.eval(`calls.length`);
    await go(page, '#/p/1/reviews', `$('.rv-card') && calls.slice(${was}).includes('GET api/projects/1/reviews')`);
    await page.eval('drawn()'); // the list it just read redraws the page
  },
};

for (const [what, redraw] of Object.entries(REDRAWS)) {
  test(`text in an open Edit form survives ${what}`, { skip }, async () => {
    const page = await reviews();
    await page.eval(`openEdit('UI critic'), type('${BODY}', 'typed')`);
    await redraw(page);
    assert.equal(await page.eval(`$('${BODY}')?.value`), 'typed');
    assert.deepEqual(await page.eval('errors'), []);
  });
  if (what === 'Apply' || what === 'Dismiss') continue; // these two type in the Edit form themselves
  test(`text in an open New form survives ${what}`, { skip }, async () => {
    const page = await reviews();
    await page.eval(`press('+ New'), type('.rv-form input', 'my-critic')`);
    await redraw(page);
    assert.equal(await page.eval(`$('.rv-form input')?.value`), 'my-critic');
  });
}

test('removing a verdict leaves the list and keeps the rest of the form', { skip }, async () => {
  const page = await reviews();
  await page.eval(`openEdit('UI critic'), type('${BODY}', 'typed'), press('Remove', '.rv-verdicts')`);
  await waitFor(page, 'it gone', `document.querySelectorAll('.reviews-main .rv-form .rv-verdicts li').length === 1`);
  assert.equal(await page.eval(`$('${BODY}').value`), 'typed');
});

test('removing a lesson leaves the list and keeps the rest of the form', { skip }, async () => {
  const page = await reviews();
  await page.eval(`openEdit('Pre-ship review'), type('${BODY}', 'typed'), press('Remove', '.rv-verdicts')`);
  await waitFor(page, 'it gone', `!$('.rv-form .rv-verdicts')`);
  assert.equal(await page.eval(`$('${BODY}').value`), 'typed');
});

test("closing the lenses keeps a lens's open Edit form", { skip }, async () => {
  const page = await reviews();
  await page.eval(`$('.rv-lens-row').click(), $('.rv-lens-name').click(), press('Edit by hand'), type('${BODY}', 'typed'), $('.rv-lens-row').click()`);
  assert.equal(await page.eval(`!!$('.rv-lens-list')`), false, 'the lenses closed');
  assert.equal(await page.eval(`$('${BODY}')?.value`), 'typed');
});

test('Cancel drops what was typed', { skip }, async () => {
  const page = await reviews();
  await page.eval(`openEdit('UI critic'), type('${BODY}', 'typed'), press('Cancel'), press('Edit by hand')`);
  assert.equal(await page.eval(`$('${BODY}').value`), 'saved text of ui');
});

test("a redraw leaves the cursor and the text's scroll where they were in a form", { skip }, async () => {
  const page = await reviews();
  await page.eval(`type('.rv-ask-row input', 'stricter'), window.late = hold('reviews/describe'), press('Ask'), openEdit('UI critic'), type('${BODY}', 'a line\\n'.repeat(200))`);
  await page.eval(`(() => { const t = $('${BODY}'); t.focus(); t.setSelectionRange(5, 9); t.scrollTop = 300; late.open(); })()`);
  await waitFor(page, 'the answer', `$('.rv-proposal')`);
  assert.deepEqual(await page.eval(`(() => { const t = $('${BODY}'); return [document.activeElement === t, t.selectionStart, t.selectionEnd, t.scrollTop]; })()`), [true, 5, 9, 300]);
});

// ---- SP5: runs, verdicts and refutes arriving ----

test('a run arriving keeps unsaved hand-off steps, and Save then sends them', { skip }, async () => {
  const page = await reviews();
  await page.eval(`press('+ Step'), sets[1][1].name = 'Renamed critic', changed()`);
  await waitFor(page, 'the run shown', `$('.rv-board').textContent.includes('Renamed critic')`);
  assert.equal(await page.eval(`document.querySelectorAll('.reviews-main .rv-onfail-row').length`), 1);
  await page.eval(`press('Save hand-offs')`);
  await waitFor(page, 'the steps saved', `sets[1][0].on_fail?.length === 1`);
  assert.equal(await page.eval(`$('.rv-onfail .cui-primary').hidden`), true, 'nothing left to save');
});

test('a run arriving while a step has the focus waits until it leaves', { skip }, async () => {
  const page = await reviews();
  await page.eval(`sets[1][0].on_fail = [{ after: 2, to: 'person' }], changed()`);
  await waitFor(page, 'the step', `$('.rv-onfail-row input')`);
  await page.eval(`$('.rv-onfail-row input').focus(), window.stood = $('.rv-onfail-row input'), sets[1][1].name = 'Renamed critic', changed()`);
  await page.eval('drawn()');
  assert.equal(await page.eval(`document.activeElement === stood && stood.isConnected`), true);
  await page.eval(`stood.blur()`);
  await waitFor(page, 'the page to catch up', `$('.rv-board').textContent.includes('Renamed critic')`);
});

test('a run arriving leaves the cursor in the describe box and a panel name being typed', { skip }, async () => {
  const page = await reviews();
  await page.eval(`$('.rv-ask-row input').focus(), type('.rv-ask-row input', 'make it'), $('.rv-ask-row input').setSelectionRange(2, 2), changed()`);
  await page.eval('drawn()');
  assert.deepEqual(await page.eval(`(() => { const i = $('.rv-ask-row input'); return [document.activeElement === i, i.value, i.selectionStart]; })()`), [true, 'make it', 2]);
  await page.eval(`$('input[list=rv-panels]').focus(), type('input[list=rv-panels]', 'loo'), changed()`);
  await page.eval('drawn()');
  assert.equal(await page.eval(`$('input[list=rv-panels]').value`), 'loo');
});

// ---- SP3: the deploy reload ----

test("a form with typed text holds a deploy's reload; an untouched or put-back one doesn't", { skip }, async () => {
  const page = await reviews();
  assert.equal(await page.eval('drafts()'), false, 'the page as it opens');
  await page.eval(`openEdit('UI critic')`);
  assert.equal(await page.eval('drafts()'), false, 'an untouched Edit form');
  assert.equal(await page.eval(`type('${BODY}', 'typed'), drafts()`), true, 'a typed rubric');
  assert.equal(await page.eval(`type('${BODY}', ''), drafts()`), true, 'a cleared rubric');
  assert.equal(await page.eval(`type('${BODY}', 'saved text of ui'), drafts()`), false, 'put back');
  assert.equal(await page.eval(`press('Cancel'), press('+ New'), drafts()`), false, 'an empty New form');
  assert.equal(await page.eval(`type('.rv-form input', 'x'), drafts()`), true, 'a typed New form');
  assert.equal(await page.eval(`press('Cancel'), drafts()`), false, 'closed');
  await page.eval(`openEdit('UI critic'), press('Cancel'), press('+ Step')`);
  assert.equal(await page.eval('drafts()'), true, 'unsaved hand-offs');
  await page.eval(`press('×'), type('.rv-ask-row input', 'stricter')`);
  assert.equal(await page.eval('drafts()'), true, 'an unsent description');
  await page.eval(`press('Ask')`);
  await waitFor(page, 'the answer', `$('.rv-proposal')`);
  assert.equal(await page.eval('drafts()'), false, 'an answered one');
});

test("typed text holds a deploy's reload while the Every scheme tab is up", { skip }, async () => {
  const page = await reviews();
  await page.eval(`openEdit('UI critic'), type('${BODY}', 'typed'), press('Every scheme', '.rv-tabs')`);
  await waitFor(page, 'the other tab', `!$('.rv-board')`);
  assert.equal(await page.eval('drafts()'), true, 'a typed rubric');
  await page.eval(`press('This scheme', '.rv-tabs'), press('Cancel'), press('Every scheme', '.rv-tabs')`);
  assert.equal(await page.eval('drafts()'), false, 'a closed form');
  await page.eval(`press('This scheme', '.rv-tabs'), type('.rv-ask-row input', 'stricter'), window.late = hold('reviews/describe'), press('Ask'), press('Every scheme', '.rv-tabs')`);
  assert.equal(await page.eval('drafts()'), true, 'an unanswered description');
  await page.eval('late.open()');
  await waitFor(page, 'the answer', '!drafts()');
});

test('hand-offs left unsaved behind an Edit form hold the reload too', { skip }, async () => {
  const page = await reviews();
  await page.eval(`press('+ Step'), press('Edit by hand')`);
  assert.equal(await page.eval('drafts()'), true);
});

// ---- SP6: a refused stale save ----

test('after a refused stale save, Cancel then Edit opens the newest version', { skip }, async () => {
  const page = await reviews();
  await page.eval(`openEdit('UI critic'), type('${BODY}', 'mine'), Object.assign(sets[1][0], { version: 8, body: 'theirs' }), changed(), press('Save')`);
  await waitFor(page, 'the refusal', `$('.rv-form .error')?.hidden === false`);
  assert.equal(await page.eval(`$('${BODY}').value`), 'mine', 'the refused text stays');
  await page.eval(`press('Cancel')`);
  await waitFor(page, 'the newest version', `$('.rv-ver')?.textContent.includes('Version 8')`);
  await page.eval(`press('Edit by hand')`);
  assert.equal(await page.eval(`$('${BODY}').value`), 'theirs');
  await page.eval(`type('${BODY}', 'mine again'), press('Save')`);
  await waitFor(page, 'the save', `sets[1][0].body === 'mine again'`);
});

for (const name of ['UI critic', 'Pre-ship review']) {
  test(`Save in ${name}'s form is refused when a newer list arrived while it was open`, { skip }, async () => {
    const page = await reviews();
    const at = name === 'UI critic' ? 0 : 2;
    await page.eval(`openEdit('${name}'), press('Cancel')`);
    await page.eval(`Object.assign(sets[1][${at}], { version: 8, body: 'theirs' }), sets[1][1].name = 'Renamed critic', window.late = hold('GET api/projects/1/reviews'), changed(), press('Edit by hand'), type('${BODY}', 'mine'), late.open()`);
    await waitFor(page, 'the newer list', `$('.rv-board').textContent.includes('Renamed critic')`);
    await page.eval(`press('Save')`);
    await waitFor(page, 'the refusal', `$('.rv-form .error')?.hidden === false`);
    assert.equal(await page.eval(`sets[1][${at}].body`), 'theirs');
  });
}

// ---- SP10: late answers ----

test('a list answered after a newer one leaves the newer one on the page', { skip }, async () => {
  const page = await reviews();
  await page.eval(`window.late = hold('GET api/projects/1/reviews'), changed(), sets[1][0].version = 8, changed()`);
  await waitFor(page, 'the newer list', `$('.rv-ver')?.textContent.includes('Version 8')`);
  await page.eval(`late.open(), drawn()`);
  assert.match(String(await page.eval(`$('.rv-ver').textContent`)), /Version 8/);
});

test("a save answered after a scheme switch leaves the other scheme's set and open form alone", { skip }, async () => {
  const page = await reviews();
  await page.eval(`openEdit('UI critic'), type('${BODY}', 'for Alpha'), window.late = hold('PATCH'), press('Save')`);
  await go(page, '#/p/2/reviews', IN_SCHEME('Beta'));
  await page.eval(`openEdit('UI critic'), type('${BODY}', 'for Beta'), late.open()`);
  await waitFor(page, 'the save answered', `[...document.querySelectorAll('body *')].some((x) => x.children.length === 0 && x.textContent.startsWith('Saved as version'))`);
  assert.equal(await page.eval(`$('${BODY}')?.value`), 'for Beta');
  await page.eval(`press('Cancel'), press('Edit by hand')`);
  assert.equal(await page.eval(`$('${BODY}').value`), 'saved text of ui', "Beta's own text");
});

test("a save answered after another entry's Edit opened leaves that form open", { skip }, async () => {
  const page = await reviews();
  await page.eval(`openEdit('UI critic'), type('${BODY}', 'ui text'), window.late = hold('PATCH'), press('Save'), openEdit('Art critic'), type('${BODY}', 'art text'), late.open()`);
  await waitFor(page, 'the save answered', `[...document.querySelectorAll('body *')].some((x) => x.children.length === 0 && x.textContent.startsWith('Saved as version'))`);
  assert.equal(await page.eval(`$('${BODY}')?.value`), 'art text');
});

test('a save refused after its form closed says so', { skip }, async () => {
  const page = await reviews();
  await page.eval(`openEdit('UI critic'), type('${BODY}', 'ui text'), sets[1][0].version = 8, window.late = hold('PATCH'), press('Save'), press('Cancel'), late.open()`);
  await waitFor(page, 'the toast', `document.body.textContent.includes("Couldn't save UI critic")`);
});

test("a New answered after a scheme switch isn't added to the other scheme", { skip }, async () => {
  const page = await reviews();
  await page.eval(`press('+ New'), type('.rv-form input', 'made-in-alpha'), window.late = hold('POST'), press('Add on trial')`);
  await go(page, '#/p/2/reviews', IN_SCHEME('Beta'));
  await page.eval(`press('+ New'), type('.rv-form input', 'beta-typed'), late.open()`);
  await page.eval('drawn()');
  assert.equal(await page.eval(`$('.rv-form input')?.value`), 'beta-typed');
  assert.equal(await page.eval(`$('.rv-board').textContent.includes('made-in-alpha')`), false);
});

test("History answered after a scheme switch or on another entry isn't shown there", { skip }, async () => {
  const page = await reviews();
  await go(page, '#/p/2/reviews', IN_SCHEME('Beta'));
  await page.eval(`window.beta = hold('projects/2/reviews/ui/versions'), press('History')`);
  await go(page, '#/p/1/reviews', IN_SCHEME('Alpha'));
  await page.eval(`window.alpha = hold('projects/1/reviews/ui/versions'), press('History'), beta.open()`);
  await page.eval('drawn()');
  assert.equal(await page.eval(`$('.rv-history')?.textContent.includes('In 2') ?? false`), false, "Beta's history in Alpha");
  await page.eval(`alpha.open()`);
  await waitFor(page, "Alpha's own", `$('.rv-history')?.textContent.includes('In 1')`);
});

test("a Restore answered after a scheme switch leaves the other scheme's entry alone", { skip }, async () => {
  const page = await reviews();
  await page.eval(`press('History')`);
  await waitFor(page, 'the versions', `$('.rv-history')`);
  await page.eval(`window.late = hold('restore'), press('Restore')`);
  await go(page, '#/p/2/reviews', IN_SCHEME('Beta'));
  await page.eval(`late.open()`);
  await waitFor(page, 'the restore answered', `document.body.textContent.includes('Restored version 0')`);
  await page.eval(`openEdit('UI critic')`);
  assert.equal(await page.eval(`$('${BODY}').value`), 'saved text of ui');
});

// ---- SP14: the first error ----

test('a later good load clears the first error', { skip }, async () => {
  const page = await reviews();
  await page.eval(`down = true`);
  await go(page, '#/p/2/reviews', `$('.rv-body > .error')`);
  await page.eval(`down = false, changed(2)`);
  await waitFor(page, 'the set', `$('.rv-card') && !$('.rv-body > .error')`);
});
