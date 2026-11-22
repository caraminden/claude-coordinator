// A merged card (two ask_question calls of 4 questions in one turn, #958): Send answers all 8, multiSelect included,
// and a recommended option that nobody picked doesn't look picked. Real front end in headless Chromium (test/browser.ts).
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium, launch, waitFor, type Browser, type Page, serveApp, skipMessage, type App } from './browser.ts';

const bin = chromium();
const skip = !bin && skipMessage;

const q = (n: number, multi = false) => ({ header: `Q${n}`, question: `Question ${n}?`, ...(multi ? { multiSelect: true } : {}), options: [{ label: `A${n}`, recommended: true }, { label: `B${n}` }, { label: `C${n}` }] });
const ALL = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => q(n, n === 2 || n === 6));

const STUB = `<script>
  window.ready = true;
  window.sent = [];
  const ALL = ${JSON.stringify(ALL)};
  const now = Date.now();
  const coordinator = { id: 100, project_id: 1, kind: 'coordinator', number: 0, title: 'Taskmaster', status: 'idle', updated_at: 0 };
  const minion = (n) => ({ id: n, project_id: 1, kind: 'ticket', number: n, title: 'Minion ' + n, status: 'idle', updated_at: 0, created_at: now - 1000 });
  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    const path = url.pathname.replace(/^\\//, '');
    if (path === 'api/me') return reply(200, { name: 'Cara', login: 'cara', admin: true, uid: 1 });
    if (path === 'api/projects') return reply(200, [{ id: 1, name: 'Alpha', inbox: 0, icon: null }]);
    if (path === 'api/projects/1') return reply(200, { project: { id: 1, name: 'Alpha', instructions: '' }, coordinator, tickets: [minion(7)], seen: {}, person_notes: {}, pins: [] });
    if (path === 'api/projects/1/recap') return reply(200, { since: null, turns: {} });
    let m;
    if ((m = path.match(/^api\\/tickets\\/(\\d+)\\/answer$/))) { sent.push(JSON.parse(init.body)); return new Promise(() => {}); }
    if ((m = path.match(/^api\\/tickets\\/(\\d+)$/))) return reply(200, { ticket: m[1] === '100' ? coordinator : minion(Number(m[1])) });
    if ((m = path.match(/^api\\/tickets\\/(\\d+)\\/events$/))) {
      if (url.search.includes('after=')) return reply(200, []);
      if (m[1] !== '7') return reply(200, { events: [], tasks: [], more: false });
      return reply(200, { events: [
        { id: 1, ticket_id: 7, kind: 'question', data: JSON.stringify({ id: 'q7', mergeable: true, questions: ALL.slice(0, 4) }), created_at: now - 60_000 },
        { id: 2, ticket_id: 7, kind: 'question_more', data: JSON.stringify({ id: 'q7', questions: ALL }), created_at: now - 59_000 },
      ], tasks: [], more: false });
    }
    if (/inbox$/.test(path)) return reply(200, { items: [] });
    return reply(200, []);
  };
  window.EventSource = class { close() {} };
</script>`;

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

const sendBtn = `[...document.querySelectorAll('.qcard .row button')].find((b) => /^Send/.test(b.textContent))`;
const open = async (opts = {}) => {
  const page: Page = await browser.page(`${app.base}#/p/1/t/7`, { width: 1280, height: 800, ...opts });
  await waitFor(page, 'the card', `document.querySelectorAll('.qcard .q').length === 8`);
  return page;
};

test('a merged 8-question card with pick-any questions sends all eight answers', { skip }, async () => {
  const page = await open();
  assert.equal(await page.eval(`${sendBtn}.disabled`), true, 'nothing picked yet');
  const progress = `document.querySelector('.qcard .progress').textContent`;
  assert.equal(await page.eval(progress), '0 of 8 answered', 'a person sees why Send waits');
  for (let n = 1; n <= 8; n++) {
    await page.eval(`document.querySelector('.qcard [data-q="${n - 1}"] .opt[data-label="B${n}"]').click()`);
    assert.equal(await page.eval(`${sendBtn}.disabled`), n < 8, `after ${n} picks`);
    assert.equal(await page.eval(progress), n < 8 ? `${n} of 8 answered` : 'All answered');
  }
  await page.eval(`document.querySelector('.qcard [data-q="1"] .opt[data-label="C2"]').click()`);
  await page.eval(`${sendBtn}.click()`);
  const sent = (await page.eval('sent')) as any[];
  assert.equal(sent[0].answers.length, 8);
  assert.deepEqual(sent[0].answers[1], { selected: ['B2', 'C2'], other: '' });
});

test('a recommended option nobody picked is not styled as picked', { skip }, async () => {
  const page = await open();
  assert.deepEqual(await page.eval(`[...document.querySelectorAll('.qcard .opt.picked')].length`), 0);
  // Picked and merely suggested differ in fill and border.
  const style = (sel: string) => page.eval(`(() => { const s = getComputedStyle(document.querySelector(${JSON.stringify(sel)})); return s.backgroundColor + '|' + s.borderColor; })()`);
  const suggested = await style('.qcard [data-q="0"] .opt[data-label="A1"]');
  await page.eval(`document.querySelector('.qcard [data-q="0"] .opt[data-label="B1"]').click(); document.querySelector('.qcard [data-q="0"] .opt[data-label="A1"]').click()`);
  const picked = await style('.qcard [data-q="0"] .opt[data-label="A1"]');
  assert.notEqual(suggested, picked);
  const plain = await style('.qcard [data-q="0"] .opt[data-label="C1"]');
  assert.notEqual(suggested, plain, 'a suggestion looks different from a plain option');
  assert.notEqual(suggested.split('|')[0], picked.split('|')[0], 'not the picked fill');
});
