// Speaker avatars in chat (#1976): off draws nothing new, the account switch shows at once and goes back when its save
// fails, and a picked picture is sent small and square. Citadel's real front end in headless Chromium.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium, launch, waitFor, type Browser, serveApp, skipMessage, type App, type Page } from './browser.ts';
import { pageStub } from './page-stub.ts';

const bin = chromium();
const skip = !bin && skipMessage;

const STUB = pageStub(`
  window.ready = true;
  window.sent = [];
  window.refuse = false;
  window.mine = { on: false, pic: null, people: { Cara: 'api/people/1/avatar?v=aa', Josh: null } };
  function route(path, url, { method = 'GET', body } = {}) {
    if (path === 'api/projects') return reply(200, [{ id: 1, name: 'Alpha', inbox: 0, icon: null }]);
    if (path === 'api/projects/1') return reply(200, { project: { id: 1, name: 'Alpha', instructions: '' }, coordinator: { id: 100, project_id: 1, kind: 'coordinator', number: 0, title: 'Taskmaster', status: 'idle', updated_at: 0 }, tickets: [], members: [] });
    if (path === 'api/me') return reply(200, { id: 2, name: 'Josh', login: 'josh', admin: false, turns: true, keepChats: true, avatars: window.mine });
    if (path === 'api/me/avatars' || path === 'api/me/avatar') {
      const sent = body ? JSON.parse(body) : null;
      window.sent.push([method, path, sent]);
      if (window.refuse) return reply(500, { error: 'no room' });
      if (path.endsWith('s')) window.mine = { ...window.mine, on: sent.on };
      else { const pic = sent ? 'api/people/2/avatar?v=bb' : null; window.mine = { ...window.mine, pic, people: { ...window.mine.people, Josh: pic } }; }
      return reply(200, window.mine);
    }
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

/** The account page, and beside it a person's, another person's and a relayed minion's message as the chat draws them. */
async function open() {
  const page = await browser.page(`${app.base}#/p/1`, { width: 1280, height: 900 });
  await page.eval(`location.hash = '#/p/1/account'`);
  await waitFor(page, 'the card', `document.querySelector('.avatars-card')`);
  await page.eval(`import('./bubbles.js').then(({ userBubble }) => { const log = document.createElement('div'); log.id = 'shown'; log.append(userBubble('Josh', 'mine', []), userBubble('Cara', 'hers', []), userBubble('#12 A minion', 'relayed', [])); document.body.append(log); })`);
  await waitFor(page, 'the messages', `document.querySelectorAll('#shown > .msg').length === 3`);
  return page;
}
type Drawn = { after: string; image: string; pad: string; left: string };
const drawn = async (page: Page) =>
  (await page.eval(
    `[...document.querySelectorAll('#shown > .msg')].map((m) => { const who = m.querySelector('.who'); return { after: getComputedStyle(who, '::after').content, image: getComputedStyle(who, '::after').backgroundImage, pad: getComputedStyle(who).paddingLeft, left: getComputedStyle(m).borderLeftColor }; })`,
  )) as Drawn[];
const on = `document.documentElement.classList.contains('speaker-avatars')`;
/** Click the switch; whether avatars are on right after, before its save can answer. */
const flip = (page: Page) => page.eval(`document.querySelector('.avatars-card input[type=checkbox]').click(), ${on}`);

test('off draws nothing; on shows at once; a refused save goes back and says so', { skip }, async () => {
  const page = await open();
  for (const m of await drawn(page)) assert.deepEqual([m.after, m.pad], ['none', '0px']);
  assert.equal(await flip(page), true);
  const [josh, cara, minion] = await drawn(page);
  assert.match(josh.after, /^"J"/);
  assert.match(cara.image, /api\/people\/1\/avatar\?v=aa/);
  assert.match(minion.image, /avatar-minion\.svg/);
  assert.notEqual(josh.left, minion.left);
  await waitFor(page, 'the save', `window.sent.length === 1`);
  assert.deepEqual(await page.eval('window.sent[0]'), ['PUT', 'api/me/avatars', { on: true }]);

  await page.eval('window.refuse = true');
  assert.equal(await flip(page), false);
  await waitFor(page, 'the roll back', `${on} && /turn off speaker avatars/.test(document.body.textContent)`);
  assert.equal(await page.eval(`document.querySelector('.avatars-card input[type=checkbox]').checked`), true);
});

test('a picture is cropped square and small, shows at once, goes back when refused, and can be removed', { skip }, async () => {
  const page = await open();
  await flip(page);
  const pick = (type: string) =>
    page.eval(
      `(async () => { const c = document.createElement('canvas'); c.width = 900; c.height = 400; c.getContext('2d').fillRect(0, 0, 900, 400); const blob = ${type === 'image' ? `await new Promise((ok) => c.toBlob(ok))` : `new Blob(['hello'])`}; const d = new DataTransfer(); d.items.add(new File([blob], 'me')); const i = document.querySelector('.avatars-card input[type=file]'); i.files = d.files; i.dispatchEvent(new Event('change')); })()`,
    );
  await pick('text');
  await waitFor(page, 'the refusal', `/couldn't be read as a picture/.test(document.querySelector('.avatars-card').textContent)`);
  await pick('image');
  await waitFor(page, 'the picture saved', `window.sent.length === 2 && document.querySelector('.avatars-card .who.has-pic')`);
  const size = await page.eval(`createImageBitmap(new Blob([Uint8Array.from(atob(window.sent[1][2].data), (c) => c.charCodeAt(0))])).then((b) => [b.width, b.height])`);
  assert.deepEqual(size, [256, 256]);
  await waitFor(page, 'the saved picture in the chat', `/v=bb/.test(getComputedStyle(document.querySelector('#shown .who'), '::after').backgroundImage)`);

  await page.eval('window.refuse = true');
  const remove = `[...document.querySelectorAll('.avatars-card button')].find((b) => b.textContent === 'Remove it')`;
  await page.eval(`${remove}.click()`);
  await waitFor(page, 'the roll back', `/remove your picture/.test(document.body.textContent) && document.querySelector('#shown .who.has-pic')`);
  await page.eval(`window.refuse = false; ${remove}.click()`);
  await waitFor(page, 'it gone', `!document.querySelector('#shown .who[data-person=Josh]').classList.contains('has-pic')`);
  assert.equal(await page.eval(`${remove}.hidden`), true);
});
