// Minion turns on a machine's row (Build 7 T5, public/machine-worker-row.js) in a real browser against the real server,
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
const row = (name: string) => `document.querySelector('.machine-row[data-name="${name}"]')`;
const worker = (sel = '', name = 'my-pc') => `${row(name)}?.querySelector('.worker${sel ? ` ${sel}` : ''}')`;
const textOf = (sel = '') => page.eval<string>(`${worker(sel)}?.textContent ?? ''`);
/** Its Minion turns card (Build 7 M3: a card per role, the worker's part inside it), and that card's switch. */
const card = (name = 'my-pc') => `${row(name)}?.querySelector('.role-card[data-role=turns]')`;
const turnsSwitch = (name = 'my-pc') => `${card(name)}?.querySelector('.rules-switch')`;
/** The card's text: its state's word is the chip in the card's head, the worker's part below says why. */
const cardText = () => page.eval<string>(`${card()}?.textContent ?? ''`);
async function open(name: string) {
  await page.send('Page.navigate', { url: `${srv.base}/#/p/${projectId}/machines` });
  await wait(`${name}'s line`, `!!${row(name)}`);
  await page.eval(`(() => { ${row(name)}.open = true; })()`);
  await wait(`${name}'s switch`, `!!${turnsSwitch(name)}`);
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

test('switched on, the row shows the command at once, and it follows the caps as they are typed', { skip }, async () => {
  assert.equal(await page.eval(`${turnsSwitch()}.id`), `role-switch-${id}-turns`);
  assert.equal(await page.eval(`${turnsSwitch()}.getAttribute('aria-checked')`), 'false');
  await page.eval(`${turnsSwitch()}.click()`);
  // At once: before the server has answered.
  assert.equal(await page.eval(`${turnsSwitch()}.getAttribute('aria-checked')`), 'true');
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
  assert.match(await cardText(), /Needs a Claude sign-in[^]*No turn starts there until its owner signs in/);
  assert.equal(await page.eval(`${worker()}.textContent.includes('ccm_')`), false, 'the token is put away once it is set up');
  says.signedIn = says.github = true;
  await wait('both sign-ins', `/Claude: signed in/.test(${worker()}.textContent) && /GitHub: signed in/.test(${worker()}.textContent)`);
  // Switched on, it was lent to every scheme its owner is in (M3); untick Delve on its card and it is lent to none.
  const lent = async () => (ok(await srv.call(`/api/machines/${id}/roles`)).roles as { role: string; projects: number[] }[]).find((r) => r.role === 'turns')!.projects;
  const chip = `[...${card()}.querySelectorAll('.role-schemes .chip')].find((c) => c.textContent === 'Delve')`;
  assert.equal(await page.eval(`${chip}.getAttribute('aria-pressed')`), 'true');
  assert.match(await cardText(), /Not tested yet/);
  await page.eval(`${chip}.click()`);
  await wait('lent to no scheme', `/Lent to no scheme/.test(${card()}.textContent)`);
  await until('the untick saved', async () => (await lent()).length === 0);
  await page.eval(`${chip}.click()`);
  await wait('the next step', `/Not tested yet/.test(${card()}.textContent)`);
  await until('Delve lent again, saved', async () => (await lent()).join() === String(projectId));
  assert.match(await page.eval<string>(`${row('my-pc')}.querySelector('summary').textContent`), /Setting up.*Minion turns: not tested yet/);
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
  assert.match(await cardText(), /Ready[^]*up to 3 at once[^]*Last passed whole/);
  await page.eval(`[...${worker()}.querySelectorAll('.worker-fold')].find((d) => /caps/.test(d.textContent)).open = true`);
  await wait('the caps', `!!document.getElementById('worker-cap-${id}-threads')`);
  await page.eval(`(() => { const i = document.getElementById('worker-cap-${id}-threads'); i.value = '6'; i.dispatchEvent(new Event('input')); })()`);
  assert.match(await textOf('.worker-fold .worker-command pre'), /citadel-worker caps --workers 3 --threads 6 --memory 10 --disk 80/);
});

test('a machine that is shared says why its switch is off and what to do', { skip }, async () => {
  ok(await srv.call('/api/machines', { name: 'shared-pc' }));
  await open('shared-pc');
  assert.equal(await page.eval(`${turnsSwitch('shared-pc')}.disabled`), true);
  assert.match(await page.eval<string>(`${card('shared-pc')}.textContent`), /only its owner's minions.*add that PC again with "Mine" ticked/);
});
