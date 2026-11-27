// Minion turns on a computer's card (Build 7 T5, public/machine-worker-row.js; Build 10 H3: the For me tile) in a real browser against the real server,
// in a scheme of its own, with a worker that says what the real one says (test/worker-join.test.ts runs that one).
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { bootServer, ok, type Booted } from './helpers.ts';
import { until } from './wait.ts';
import { chromium, launch, waitFor, type Browser, type Page } from './browser.ts';

const bin = chromium();
const skip = !bin && 'no headless Chromium in ~/.cache/ms-playwright';
let srv: Booted;
let browser: Browser;
let page: Page;
let projectId = 0;
let id = 0;
let token = '';
let beat: NodeJS.Timeout | undefined;

before(async () => {
  if (skip) return;
  srv = await bootServer();
  projectId = ok(await srv.call('/api/projects', { name: 'Delve' })).id;
  const made = ok(await srv.call('/api/machines', { name: 'my-pc', mine: true }));
  id = made.machine.id;
  token = made.token;
  browser = await launch(bin!);
  page = await browser.page('data:text/html,<script>window.ready=true</script>', { width: 1200, height: 900 });
  const [name, value] = srv.cookie.split('=');
  await page.send('Network.setCookie', { name, value, url: srv.base });
  await open('my-pc');
});
after(async () => {
  clearInterval(beat);
  await browser?.close();
  await srv?.stop();
});

const wait = (what: string, expression: string) => waitFor(page, what, expression);
const row = (name: string) => `document.querySelector('.mcard[data-name="${name}"]')`;
const worker = (sel = '', name = 'my-pc') => `${row(name)}?.querySelector('.worker${sel ? ` ${sel}` : ''}')`;
const textOf = (sel = '') => page.eval<string>(`${worker(sel)}?.textContent ?? ''`);
/** The For me tile (take B): Minion turns' switch, or Set up in its place until the worker is installed. */
const tile = (name = 'my-pc') => `${row(name)}?.querySelector('.mcard-tile.me')`;
const turnsSwitch = (name = 'my-pc') => `${tile(name)}?.querySelector('.rules-switch')`;
/** The tile's text: its state is the big line, and the worker's part below says why. */
const cardText = () => page.eval<string>(`${row('my-pc')}?.textContent ?? ''`);
async function open(name: string) {
  await page.send('Page.navigate', { url: `${srv.base}/#/p/${projectId}/machines` });
  await wait(`${name}'s card`, `!!${row(name)}`);
}
/** What the worker's program posts, over and over until it says something else. */
const says = { image: { state: 'ready', text: 'claude 2' }, github: false as boolean, signedIn: false as boolean, test: null as null | { id: string; done: boolean; lines: { key: string; state: string; text: string }[] } };
let asked: string | null = null;
async function post(path: string, body: object) {
  const res = await fetch(srv.base + path, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Citadel-Worker': 'b' }, body: JSON.stringify(body) });
  return (await res.json()) as { test: string | null };
}
async function word() {
  await post('/api/machines/turns', { worker: { claude: '2.0.0', max: 3, signedIn: says.signedIn }, turns: [] });
  asked = (await post('/api/machines/worker', { boot: 'b', installed: 1, host: 'MY-PC', wsl: true, caps: { workers: 3, threads: 4, memory_gb: 10, disk_gb: 80 }, image: says.image, github: says.github, disk_gb: 12, full: false, test: says.test })).test;
}

test('switched on, the card shows the command at once, and it follows the caps as they are typed', { skip }, async () => {
  // Not set up, the tile offers Set up in the switch's place: it switches turns on and opens the steps (spec section 4).
  assert.equal(await page.eval(`${tile()}.querySelector('.rules-switch')`), null);
  await page.eval(`[...${tile()}.querySelectorAll('button')].find((b) => b.textContent === 'Set up').click()`);
  // At once: before the server has answered.
  assert.equal(await page.eval(`${turnsSwitch()}.getAttribute('aria-checked')`), 'true');
  assert.equal(await page.eval(`${turnsSwitch()}.getAttribute('aria-label')`), 'Minion turns on my-pc');
  await wait('the command', `!!${worker('.worker-command pre')}`);
  const command = () => page.eval<string>(`${worker('.worker-command pre')}.textContent`);
  assert.match(await command(), new RegExp(`CC_MACHINE_TOKEN='${token}'.*--workers 6 --threads 8 --memory 24 --disk 60`));
  await page.eval(`(() => { const i = ${worker(`#worker-cap-${id}-workers`)}; i.focus(); i.value = '4'; i.dispatchEvent(new Event('input')); })()`);
  assert.match(await command(), /--workers 4 --threads 8/);
  await page.eval(`(() => { const i = document.activeElement; i.value = 'x'; i.dispatchEvent(new Event('input')); })()`);
  assert.match(await command(), /--workers 4 --threads 8/, 'half-typed, it keeps the last whole number');
  assert.equal(await page.eval(`document.activeElement.getAttribute('aria-invalid')`), 'true');
  await page.eval(`[...${worker()}.querySelectorAll('.worker-os .chip')].find((b) => b.textContent === 'Windows').click()`);
  assert.match(await command(), /-Workers 4 -Threads 8 -MemoryGB 24 -DiskGB 60/);
  assert.equal(await page.eval(`!!${worker('.worker-command pre.cui-shell[data-tone=powershell]')}`), true, 'the block says where it runs');
});

test('a redraw while a cap is being typed keeps the cursor there, and what was half-typed', { skip }, async () => {
  await page.eval(`(() => { const i = document.getElementById('worker-cap-${id}-disk_gb'); i.focus(); i.value = '6x'; i.dispatchEvent(new Event('input')); i.setSelectionRange(1, 1); window.was = i; })()`);
  await srv.call(`/api/machines/${id}`, { always_on: false }, 'PATCH');
  await wait('a redraw', `!document.contains(window.was)`);
  assert.deepEqual(await page.eval('[document.activeElement.id, document.activeElement.selectionStart, document.activeElement.value, document.activeElement.getAttribute("aria-invalid")]'), [`worker-cap-${id}-disk_gb`, 1, '6x', 'true']);
});

test('connected, it asks for the sign-ins that are missing and shows the ones that are there', { skip }, async () => {
  await word();
  beat = setInterval(() => void word().catch(() => {}), 1000);
  await wait('the sign-in command', `[...${worker()}.querySelectorAll('.worker-sign pre')].some((p) => p.textContent.trim() === 'wsl -d citadel-workers -u root --exec /usr/local/bin/citadel-worker signin')`);
  assert.match(await cardText(), /Sign in to Claude here[^]*No turn starts there until its owner signs in/);
  assert.equal(await page.eval(`${worker()}.textContent.includes('ccm_')`), false, 'the token is put away once it is set up');
  says.signedIn = says.github = true;
  await wait('both sign-ins', `/Claude: signed in/.test(${worker()}.textContent) && /GitHub: signed in/.test(${worker()}.textContent)`);
  // Take B drops the per-scheme chips on Minion turns (they are only its owner's: spec section 2), and with them "Lent to no scheme".
  assert.match(await cardText(), /No turn starts there until its self-test passes/);
  assert.match(await page.eval<string>(`${row('my-pc')}.querySelector('.mcard-tile.me .mcard-big').textContent`), /Not tested yet/);
});

test('the self-test runs from the row, line by line, and the row ends Ready; the caps then change by a command on that PC', { skip }, async () => {
  await page.eval(`(() => { ${worker('.worker-part-head button')}.click(); })()`);
  await wait('it running, at once', `${worker('.worker-part-head button')}.textContent === 'Running…'`);
  await until('the worker to hear of it', () => asked);
  const keys = ['image', 'folders', 'sync', 'process', 'link', 'tools', 'disk', 'programs'];
  says.test = {
    id: asked!,
    done: false,
    lines: [
      { key: 'image', state: 'ok', text: 'claude 2' },
      { key: 'folders', state: 'running', text: '' },
    ],
  };
  await wait('its first line', `${worker('.worker-checks li[data-state=ok]')}?.textContent.includes('claude 2') && !!${worker('.worker-checks li[data-state=running]')}`);
  says.test = { id: asked!, done: true, lines: keys.map((key) => ({ key, state: 'ok', text: 'fine' })) };
  await wait('all green', `${worker()}.dataset.tone === 'ok' && ${worker()}.querySelectorAll('.worker-checks li[data-state=ok]').length === 8`);
  assert.match(await cardText(), /My worker pool: up to 3 at once[^]*Its owner's minions run there, up to 3 at once[^]*Last passed whole/);
  await page.eval(`[...${worker()}.querySelectorAll('.worker-fold')].find((d) => /caps/.test(d.textContent)).open = true`);
  await wait('the caps', `!!document.getElementById('worker-cap-${id}-threads')`);
  await page.eval(`(() => { const i = document.getElementById('worker-cap-${id}-threads'); i.value = '6'; i.dispatchEvent(new Event('input')); })()`);
  assert.match(await textOf('.worker-fold .worker-command pre'), /citadel-worker caps --workers 3 --threads 6 --memory 10 --disk 80/);
});

test("someone else's computer says why its Minion turns can't be switched on here: only its owner's turns run there", { skip }, async () => {
  // Every machine has an owner now (Build 10 H1), so the old shared PC is another person's: no switch and no Set up for the viewer.
  const made = (await srv.call('/api/people', { name: 'Mira' })).data;
  const invited = await fetch(`${srv.base}/api/invite/${made.token}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'a-long-password' }) });
  ok(await srv.as({ cookie: invited.headers.get('set-cookie')!.split(';')[0] })('/api/machines', { name: 'miras-pc', mine: true }));
  await open('miras-pc');
  assert.equal(await page.eval(`${tile('miras-pc')}.querySelector('button').disabled`), true);
  assert.match(await page.eval<string>(`${tile('miras-pc')}.textContent`), /Can’t run turns here[^]*Only its owner can switch Minion turns on/);
});
