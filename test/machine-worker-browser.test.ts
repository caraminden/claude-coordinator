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
async function open(name: string) {
  await page.send('Page.navigate', { url: `${srv.base}/#/p/${projectId}/machines` });
  await wait(`${name}'s line`, `!!${row(name)}`);
  await page.eval(`(() => { ${row(name)}.open = true; })()`);
  await wait(`${name}'s switch`, `!!${worker('.rules-switch', name)}`);
}
/** What the worker's program posts, over and over until it says something else. */
const says = { image: { state: 'ready', text: 'claude 2' }, github: false as boolean, signedIn: false as boolean, test: null as null | { id: string; done: boolean; lines: { key: string; state: string; text: string }[] } };
let asked: string | null = null;
async function post(path: string, body: object) {
  const res = await fetch(srv.base + path, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return (await res.json()) as { test: string | null };
}
async function word() {
  await post('/api/machines/turns', { worker: { claude: '2.0.0', max: 3, signedIn: says.signedIn }, turns: [] });
  asked = (await post('/api/machines/worker', { boot: 'b', started: 1, host: 'MY-PC', wsl: true, caps: { workers: 3, threads: 4, memory_gb: 10, disk_gb: 80 }, image: says.image, github: says.github, disk_gb: 12, full: false, test: says.test })).test;
}

test('switched on, the row shows the command at once, and it follows the caps as they are typed', { skip }, async () => {
  assert.equal(await page.eval(`${worker('.rules-switch')}.getAttribute('aria-checked')`), 'false');
  await page.eval(`${worker('.rules-switch')}.click()`);
  // At once: before the server has answered.
  assert.equal(await page.eval(`${worker('.rules-switch')}.getAttribute('aria-checked')`), 'true');
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

test('a redraw while a cap is being typed keeps the cursor there', { skip }, async () => {
  await page.eval(`(() => { const i = document.getElementById('worker-cap-${id}-disk_gb'); i.focus(); i.setSelectionRange(1, 1); window.was = i; })()`);
  await srv.call(`/api/machines/${id}`, { always_on: false }, 'PATCH');
  await wait('a redraw', `!document.contains(window.was)`);
  assert.deepEqual(await page.eval('[document.activeElement.id, document.activeElement.selectionStart]'), [`worker-cap-${id}-disk_gb`, 1]);
});

test('connected, it asks for the sign-ins that are missing and shows the ones that are there', { skip }, async () => {
  await word();
  beat = setInterval(() => void word().catch(() => {}), 1000);
  await wait('the sign-in command', `[...${worker()}.querySelectorAll('.worker-sign pre')].some((p) => p.textContent.trim() === 'wsl -d citadel-workers -u root --exec /usr/local/bin/citadel-worker signin')`);
  assert.match(await textOf(), /Needs a Claude sign-in/);
  assert.equal(await page.eval(`${worker()}.textContent.includes('ccm_')`), false, 'the token is put away once it is set up');
  says.signedIn = says.github = true;
  await wait('both sign-ins', `/Claude: signed in/.test(${worker()}.textContent) && /GitHub: signed in/.test(${worker()}.textContent)`);
  assert.match(await textOf(), /Lent to no scheme/);
  await srv.call(`/api/machines/${id}`, { projects: [projectId] }, 'PATCH');
  await wait('the next step', `/Not tested yet/.test(${worker()}.textContent)`);
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
  assert.match(await textOf(), /Ready[^]*up to 3 at once[^]*Last passed whole/);
  await page.eval(`[...${worker()}.querySelectorAll('.worker-fold')].find((d) => /caps/.test(d.textContent)).open = true`);
  await wait('the caps', `!!document.getElementById('worker-cap-${id}-threads')`);
  await page.eval(`(() => { const i = document.getElementById('worker-cap-${id}-threads'); i.value = '6'; i.dispatchEvent(new Event('input')); })()`);
  assert.match(await textOf('.worker-fold .worker-command pre'), /citadel-worker caps --workers 3 --threads 6 --memory 10 --disk 80/);
});

test('a machine that is shared says why its switch is off and what to do', { skip }, async () => {
  ok(await srv.call('/api/machines', { name: 'shared-pc' }));
  await open('shared-pc');
  assert.equal(await page.eval(`${worker('.rules-switch', 'shared-pc')}.disabled`), true);
  assert.match(await page.eval<string>(`${worker('', 'shared-pc')}.textContent`), /only its owner's minions.*add it again with "Mine" ticked/);
});
