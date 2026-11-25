// #1859: what Settings saves show when someone else saves too, when the server refuses, and when you leave: the instructions pages,
// Minion rules, People, your Claude accounts and Skills. Citadel's real front end in headless Chromium, with a server in the page
// whose writes wait until the test answers them.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium, launch, waitFor, type Browser, type Page, serveApp, skipMessage, type App } from './browser.ts';

const bin = chromium();
const skip = !bin && skipMessage;

const STUB = `<script>
  window.ready = true;
  const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const scheme = (id) => ({ id, name: id === 1 ? 'Alpha' : 'Beta', instructions: 'Start.', instructions_updated_by: 'Cara', instructions_updated_at: 1, approval_rules: id === 1 ? 'Bash(base:*)' : '', plugin_dirs: '', optional_plugin_dirs: '', list_groups: '[]', ci_quiet: '', ci_watch: '', ship_path: 'citadel', go_from: 'high', try_first: 'never', shot_widths: '1440,390', shot_themes: 'light', shot_note: '', msg_never_hold: '', skills_off: 'aa bb', msg_loop_limit: 20, msg_loop_min: 10 });
  const skill = (slug) => ({ kind: 'skill', source: 'kit', slug, name: slug, description: slug });
  const account = (n) => ({ n, email: n + '@x', ready: true });
  // Writes wait here, oldest first; checks (the repeats matcher) too, while window.holdChecks is set.
  window.writes = [];
  // What the server holds now, apart from what this tab has been told.
  window.stored = { 1: scheme(1), 2: scheme(2), wide: { text: 'Wide start.', by: 'Cara', at: 1 } };
  window.checks = [];
  window.historyReads = 0;
  window.answer = (body, status) => {
    const w = writes.shift();
    const { was, ...fields } = w.body;
    w.done(reply(body ?? { ...scheme(Number(w.path.split('/').pop()) || 1), ...fields }, status));
  };
  window.refuse = (error = 'Nope', status = 409) => answer({ error }, status);
  window.push = (msg) => {
    if (msg.project) stored[msg.project.id] = msg.project;
    if (msg.instructions) stored.wide = msg.instructions;
    window.es.onmessage({ data: JSON.stringify(msg) });
  };
  window.theirs = (fields) => push({ type: 'project', project: { ...scheme(1), ...fields } });
  window.fetch = async (input, opts = {}) => {
    const path = new URL(typeof input === 'string' ? input : input.url, location.href).pathname.replace(/^\\//, '');
    const method = opts.method ?? 'GET';
    const held = (list) => new Promise((done) => list.push({ path, method, body: JSON.parse(opts.body ?? 'null'), done }));
    if (/instructions\\/overlaps$/.test(path)) return window.holdChecks ? held(checks) : reply({ found: [] });
    if (['PATCH', 'PUT'].includes(method) || path === 'api/me/claude/use') return held(writes);
    if (path === 'api/me') return reply({ id: 1, name: 'Cara', login: 'cara', admin: true, uid: 1 });
    if (path === 'api/projects') return reply([1, 2].map((id) => ({ id, name: scheme(id).name, inbox: 0, icon: null })));
    const one = /^api\\/projects\\/([12])$/.exec(path);
    if (one) return reply({ project: stored[one[1]], coordinator: { id: 100, project_id: Number(one[1]), kind: 'coordinator', number: 0, title: 'Taskmaster', status: 'idle', updated_at: Date.now(), created_at: Date.now() }, tickets: [] });
    if (path === 'api/app/instructions') return reply(stored.wide);
    if (/instructions\\/history$/.test(path)) {
      historyReads++;
      return reply({ history: [] });
    }
    if (path === 'api/people') return reply([{ id: 1, name: 'Cara', login: 'cara', admin: true, has_password: true, claude: 'linked' }, { id: 2, name: 'Josh', login: 'josh', has_password: true, claude: 'linked', disabled: false }]);
    if (path === 'api/me/claude') return reply({ state: 'linked', inUse: 1, accounts: [account(1), account(2), account(3)] });
    if (/\\/skills$/.test(path)) return reply({ items: ['aa', 'bb', 'cc'].map(skill), off: ['aa', 'bb'], usage: {}, days: 30, kitScheme: 1 });
    if (/\\/skills\\/detail$/.test(path)) return new Promise(() => {});
    return reply([]);
  };
  window.EventSource = class {
    constructor() {
      window.es = this;
      setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type: 'hello', usage: {}, version: 'v1' }) }), 100);
    }
    close() {}
  };
  window.type = (sel, text) => {
    const el = document.querySelector(sel);
    el.value = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  window.press = (text) => {
    const b = [...document.querySelectorAll('.instructions-actions button')].find((x) => x.textContent.trim() === text);
    if (b.disabled) throw new Error(text + ' is disabled');
    b.click();
  };
  window.row = (part) => document.querySelector('[data-part="' + part + '"]').closest('[data-rules-row]');
  window.seg = (part, text) => [...row(part).querySelectorAll('.rules-seg button')].find((b) => b.textContent === text);
</script>`;

let app: App;
let browser: Browser;
const open = async (hash: string, ready: string): Promise<Page> => {
  const page = await browser.page(`${app.base}#/${hash}`, { width: 1280, height: 900 });
  await waitFor(page, `${hash} to draw`, ready);
  await waitFor(page, 'the stream', '!!window.es?.onmessage');
  return page;
};
const box = '#instructions-text';
const value = (page: Page, sel = box) => page.eval<string>(`document.querySelector('${sel}').value`);
const draft = (page: Page, sel = box) => page.eval<boolean>(`document.querySelector('${sel}').hasAttribute('data-draft')`);
const status = (page: Page) => page.eval<string>(`document.querySelector('.instructions-actions [role=status]').textContent`);
const waiting = (page: Page, n: number) => waitFor(page, `${n} writes`, `writes.length === ${n}`);
/** Let the page do what an answer makes it do: replies read after it, one behind the other, each with the page's turn to act on it. */
const settle = (page: Page) => page.eval('(async () => { for (let i = 0; i < 10; i++) await reply({}).json().then(() => scheduler.yield()); })()');
const instructions = () => open('p/1/instructions', `document.querySelector('${box}')?.value === 'Start.'`);
const rules = () => open('p/1/approvals', `!!document.querySelector('[data-part="needs-approval"]')`);

before(async () => {
  if (skip) return;
  app = await serveApp({ stub: STUB });
  browser = await launch(bin!);
});
after(async () => {
  await browser?.close();
  await app?.close();
});

test('a save names the text its draft began from, and a refusal keeps yours in the box and says why (SP4)', { skip }, async () => {
  const page = await instructions();
  await page.eval(`type('${box}', 'Start. Mine.'); theirs({ instructions: 'Start. Josh.', instructions_updated_by: 'Josh' }); press('Save')`);
  await waiting(page, 1);
  assert.deepEqual(await page.eval('writes[0].body'), { instructions: 'Start. Mine.', was: { instructions: 'Start.' } });
  const reads = await page.eval<number>('historyReads');
  await page.eval(`refuse('Josh saved a different text since you opened it')`);
  await waitFor(page, 'the refusal', `/Josh saved/.test(document.querySelector('.instructions-actions [role=status]').textContent)`);
  assert.equal(await value(page), 'Start. Mine.');
  await waitFor(page, 'their change in Recent changes', `historyReads > ${reads}`);
  // A second try still hasn't seen theirs, so it names the same version.
  await page.eval(`press('Save')`);
  await waiting(page, 1);
  assert.equal(await page.eval('writes[0].body.was.instructions'), 'Start.');
  await page.eval(`refuse()`);
  await settle(page);
  // Discard loads theirs; a change made on top of it names it.
  await page.eval(`press('Discard')`);
  assert.equal(await value(page), 'Start. Josh.');
  await page.eval(`type('${box}', 'Start. Josh. Mine.'); press('Save')`);
  await waiting(page, 1);
  assert.equal(await page.eval('writes[0].body.was.instructions'), 'Start. Josh.');
});

test('a tab that missed their update loads it on the refusal, so Discard brings theirs (SP4)', { skip }, async () => {
  const page = await instructions();
  await page.eval(`type('${box}', 'Start. Mine.'); stored[1].instructions = 'Start. Josh.'; press('Save')`);
  await waiting(page, 1);
  await page.eval(`refuse('Josh saved a different text since you opened it')`);
  await waitFor(page, 'theirs behind the draft', `(press('Discard'), document.querySelector('${box}').value === 'Start. Josh.') || (type('${box}', 'Start. Mine.'), false)`);
  const wide = '#app-instructions-text';
  const tab = await open('p/1/app-instructions', `document.querySelector('${wide}')?.value === 'Wide start.'`);
  await tab.eval(`type('${wide}', 'Wide mine.'); stored.wide = { text: 'Wide Josh.', by: 'Josh', at: 2 }; press('Save')`);
  await waiting(tab, 1);
  await tab.eval(`refuse('Josh saved a different text since you opened it')`);
  await waitFor(tab, 'theirs in the page head', `/Josh/.test(document.getElementById('app-instructions-head').textContent)`);
  assert.equal(await value(tab, wide), 'Wide mine.');
  await tab.eval(`press('Discard')`);
  assert.equal(await value(tab, wide), 'Wide Josh.');
});

test('an update that arrives while a refusal fetches theirs is newer, and stays (SP4)', { skip }, async () => {
  const hold = `const real = window.fetch; window.reads = []; window.fetch = (url, o) => (!o?.method || o.method === 'GET') && /projects\\/1\\?tickets=open|app\\/instructions$/.test(String(url)) ? new Promise((done) => reads.push(async () => done(await real(url, o)))) : real(url, o)`;
  const wide = '#app-instructions-text';
  for (const [hash, sel, start, newer] of [
    ['p/1/instructions', box, 'Start.', `theirs({ instructions: 'Newer.' })`],
    ['p/1/app-instructions', wide, 'Wide start.', `push({ type: 'app-instructions', instructions: { text: 'Newer.', by: 'Josh', at: 3 } })`],
  ]) {
    const page = await open(hash, `document.querySelector('${sel}')?.value === '${start}'`);
    await page.eval(`${hold}; type('${sel}', 'Mine.'); press('Save')`);
    await waiting(page, 1);
    await page.eval(`refuse('Josh saved a different text since you opened it')`);
    await waitFor(page, 'the fetch', 'reads.length === 1');
    // What it fetched was read before the update; `stored` is put back to that older text.
    await page.eval(`${newer}; stored[1].instructions = stored.wide.text = 'Older.'; reads[0]()`);
    await settle(page);
    await page.eval(`press('Discard')`);
    assert.equal(await value(page, sel), 'Newer.');
  }
});

test('a save after another of yours began from it, answered or not (SP4)', { skip }, async () => {
  const page = await instructions();
  await page.eval(`type('${box}', 'A'); press('Save')`);
  await waiting(page, 1);
  await page.eval(`type('${box}', 'A B'); press('Save')`);
  await settle(page);
  await page.eval(`answer()`);
  await waiting(page, 1);
  assert.deepEqual(await page.eval('writes[0].body'), { instructions: 'A B', was: { instructions: 'A' } });
  await page.eval(`answer()`);
  await settle(page);
  assert.equal(await draft(page), false);
  await page.eval(`type('${box}', 'A B C'); press('Save')`);
  await waiting(page, 1);
  assert.equal(await page.eval('writes[0].body.was.instructions'), 'A B');
});

test('the Citadel-wide instructions: the version, the refusal, and an update in between (SP4, SP13)', { skip }, async () => {
  const wide = '#app-instructions-text';
  const page = await open('p/1/app-instructions', `document.querySelector('${wide}')?.value === 'Wide start.'`);
  const theirs = `push({ type: 'app-instructions', instructions: { text: 'Wide start. Josh.', by: 'Josh', at: 2 } })`;
  await page.eval(`type('${wide}', 'Wide mine.'); ${theirs}; press('Save')`);
  await waiting(page, 1);
  assert.deepEqual(await page.eval('writes[0].body'), { text: 'Wide mine.', was: 'Wide start.' });
  await page.eval(`${theirs}; refuse('Josh saved a different text since you opened it')`);
  await waitFor(page, 'the refusal', `/Josh saved/.test(document.querySelector('.instructions-actions [role=status]').textContent)`);
  assert.equal(await value(page, wide), 'Wide mine.');
  await page.eval(`press('Discard')`);
  assert.equal(await value(page, wide), 'Wide start. Josh.');
});

test('typed approval rules and the screenshot note name what they began from (SP4)', { skip }, async () => {
  const page = await rules();
  await page.eval(`type('#approval-rules', 'Bash(base:*)\\nBash(mine:*)'); theirs({ approval_rules: 'Bash(base:*)\\nBash(josh:*)' })`);
  await page.eval(`row('needs-approval').querySelector('.settings-row-actions button').click()`);
  await waiting(page, 1);
  assert.deepEqual(await page.eval('writes[0].body'), { approval_rules: 'Bash(base:*)\nBash(mine:*)', was: { approval_rules: 'Bash(base:*)' } });
  await page.eval(`theirs({ approval_rules: 'Bash(base:*)\\nBash(josh:*)' }); refuse()`);
  await settle(page);
  assert.equal(await value(page, '#approval-rules'), 'Bash(base:*)\nBash(mine:*)');
  const note = '#shot-note';
  await page.eval(`type('${note}', 'Mine'); theirs({ shot_note: 'Josh' }); row('screenshots').querySelector('.settings-row-actions button').click()`);
  await waiting(page, 1);
  assert.deepEqual(await page.eval('writes[0].body'), { shot_note: 'Mine', was: { shot_note: '' } });
  await page.eval(`refuse()`);
  await settle(page);
  assert.equal(await value(page, note), 'Mine');
});

test('Save finishes for its own scheme when you leave during the repeats check (SP7)', { skip }, async () => {
  for (const found of ['[]', `[{ label: 'CLAUDE.md', line: 3, excerpt: 'x', why: 'repeats it' }]`]) {
    const page = await instructions();
    await page.eval(`window.holdChecks = true; type('${box}', 'Left behind.'); press('Save')`);
    await waitFor(page, 'the check', 'checks.length === 1');
    await page.eval(`location.hash = '#/p/2/instructions'`);
    await waitFor(page, "Beta's page", `[...document.querySelectorAll('.instructions-main a.close-view')].some((a) => a.getAttribute('href') === '#/p/2')`);
    await page.eval(`checks[0].done(reply({ found: ${found} }))`);
    await waiting(page, 1);
    const sent = await page.eval<{ path: string; body: { instructions: string } }>('({ path: writes[0].path, body: writes[0].body })');
    assert.equal(sent.path, 'api/projects/1');
    assert.equal(sent.body.instructions, 'Left behind.');
    if (found !== '[]') await waitFor(page, 'the note', `/already said/i.test(document.body.textContent)`);
    await page.eval(`refuse()`);
    await settle(page);
    assert.equal(await value(page), 'Start.', "Beta's box is its own");
  }
});

test('two quick saves of one thing, both refused, end on what the server has (SP12)', { skip }, async () => {
  const both = async (page: Page, first: string, second: string) => {
    await page.eval(first);
    await waiting(page, 1);
    await page.eval(second);
    for (let i = 0; i < 2; i++) {
      await waiting(page, 1);
      await page.eval('refuse()');
      await settle(page);
    }
  };
  const page = await rules();
  await both(page, `seg('persons-go', 'Never').click()`, `seg('persons-go', 'Medium and up').click()`);
  assert.equal(await page.eval(`row('persons-go').querySelector('.rules-seg [aria-pressed=true]').textContent`), 'High');

  const people = await open('p/1/people', `/Josh/.test(document.querySelector('.people-list')?.textContent ?? '')`);
  const act = (t: string) => `[...document.querySelectorAll('.people-list button')].find((b) => b.textContent === '${t}').click()`;
  await both(people, act('Disable'), act('Enable'));
  assert.equal(await people.eval(`[...document.querySelectorAll('.people-list button')].some((b) => b.textContent === 'Disable')`), true);

  const mine = await open('p/1/account', `document.querySelectorAll('.acct-list li').length === 3`);
  const pin = (n: number) => `document.querySelectorAll('.acct-list li')[${n - 1}].querySelector('.acts button').click()`;
  await both(mine, pin(2), pin(3));
  assert.doesNotMatch(await mine.eval<string>(`document.querySelector('.acct-list').textContent`), /Pinned/);

  const skills = await open('p/1/skills', `document.querySelectorAll('.sk-row').length === 3`);
  await skills.eval(`for (const d of document.querySelectorAll('.sk-row')) d.open = true`);
  await waitFor(skills, 'the switches', `document.querySelectorAll('.rules-switch').length === 3`);
  const flip = (s: string) => `document.querySelector('.rules-switch[aria-label^="${s}:"]').click()`;
  await both(skills, flip('aa'), flip('bb'));
  assert.deepEqual(await skills.eval(`['aa', 'bb'].map((s) => document.querySelector('.rules-switch[aria-label^="' + s + ':"]').getAttribute('aria-checked'))`), ['false', 'false']);
});

test("a refusal after someone's update brings your text back (SP13)", { skip }, async () => {
  const page = await instructions();
  await page.eval(`type('${box}', 'Long work.'); press('Save')`);
  await waiting(page, 1);
  await page.eval(`theirs({ shot_note: 'x' })`); // any change of theirs, broadcast before mine is stored
  await page.eval(`refuse()`);
  await settle(page);
  assert.equal(await value(page), 'Long work.');
  assert.match(await status(page), /^Not saved/);
  assert.equal(await draft(page), true);
  await page.eval(`press('Save')`);
  await waiting(page, 1);
  assert.equal(await page.eval('writes[0].body.was.instructions'), 'Start.');
});

test("someone's update into a clean box keeps the counter and buttons in step (SP13)", { skip }, async () => {
  const page = await instructions();
  await page.eval(`theirs({ instructions: 'Start. Josh wrote more.' })`);
  assert.equal(await value(page), 'Start. Josh wrote more.');
  assert.match(await page.eval<string>(`document.querySelector('.instructions-actions .counter').textContent`), /^23 /);
});

test('a hand-typed rule that ticks a box ends clean after its save (SP15)', { skip }, async () => {
  const page = await rules();
  await page.eval(`type('#approval-rules', 'Bash(base:*)\\nBash(gh release create:*)'); row('needs-approval').querySelector('.settings-row-actions button').click()`);
  await waiting(page, 1);
  await page.eval('answer()');
  await settle(page);
  assert.equal(await value(page, '#approval-rules'), 'Bash(base:*)');
  assert.equal(await draft(page, '#approval-rules'), false);
});

test("a pick or someone's update leaves the number you are typing and your focus where they are (SP15, SP16)", { skip }, async () => {
  const page = await rules();
  const num = `document.querySelector('[aria-label="Loop guard count"]')`;
  // Every row opened, as a person has the one they type in.
  await page.eval(`for (const b of document.querySelectorAll('[data-rules-row] [aria-expanded=false]')) b.click(); for (const d of document.querySelectorAll('details')) d.open = true; window.kept = ${num}; kept.focus(); kept.value = '12';`);
  assert.equal(await page.eval('document.activeElement === kept'), true, 'the box takes focus');
  await page.eval(`theirs({ shot_note: 'x', approval_rules: 'Bash(base:*)\\nBash(josh:*)' })`);
  assert.deepEqual(await page.eval(`[${num} === kept, document.activeElement === kept, ${num}.value]`), [true, true, '12']);
  // No longer being typed in, it takes someone's new number.
  await page.eval(`${num}.value = '20'; ${num}.blur(); theirs({ msg_loop_limit: 33 })`);
  assert.equal(await page.eval(`${num}.value`), '33');
  // Sent and refused, it goes back to the number stored.
  await page.eval(`kept.focus(); kept.value = '12'; kept.dispatchEvent(new Event('change'))`);
  await waiting(page, 1);
  await page.eval('refuse()');
  await settle(page);
  assert.equal(await page.eval(`${num}.value`), '33');
  // A segment picked with the keyboard keeps the focus.
  await page.eval(`(() => { const b = seg('persons-go', 'Never'); b.focus(); b.click(); })()`);
  assert.deepEqual(await page.eval(`[document.activeElement.textContent, document.activeElement.getAttribute('aria-pressed')]`), ['Never', 'true']);
});

test("someone's first hand rule opens the field without taking your focus (SP15)", { skip }, async () => {
  const page = await open('p/2/approvals', `document.querySelector('#approval-rules')?.hidden`);
  await page.eval(`document.querySelector('[data-rules-row][data-part="persons-go"]').open = true; seg('persons-go', 'High').focus()`);
  await page.eval(`push({ type: 'project', project: { ...scheme(2), approval_rules: 'Bash(josh:*)' } })`);
  assert.deepEqual(await page.eval(`[document.querySelector('#approval-rules').hidden, document.activeElement.textContent]`), [false, 'High']);
});
