// Removing a worker machine on the Machines page (Build 7 #2044, public/machine-remove.js): its row says Removing… at once,
// the command that takes the worker off that PC is shown with its shell, and a plain machine just goes. A real browser
// against the real server; a 202 (copies still to clear) is stubbed at fetch, as test/machine-away.test.ts covers it.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { bootServer, ok, type Booted } from './helpers.ts';
import { chromium, launch, waitFor, type Browser, type Page } from './browser.ts';

type Uninstall = (machine: object, reply: object) => { tag: string; command: string } | null;
// A browser module with no types.
const { uninstallFor } = (await import(new URL('../public/machine-remove.js', import.meta.url).href)) as { uninstallFor: Uninstall };
const bin = chromium();
const skip = !bin && 'no headless Chromium in ~/.cache/ms-playwright';
const reply = { powershell: 'wsl --unregister citadel-workers', bash: 'sudo citadel-worker remove' };
let srv: Booted;
let browser: Browser;
let page: Page;
let projectId = 0;

test('the command is the one for the shell its worker runs in, and a machine with no worker gets none', () => {
  assert.deepEqual(uninstallFor({ worker: { host: 'MY-PC', wsl: true } }, { uninstall: reply }), { tag: 'powershell', command: reply.powershell });
  assert.deepEqual(uninstallFor({ worker: { host: 'box', wsl: false } }, { uninstall: reply }), { tag: 'bash', command: reply.bash });
  assert.equal(uninstallFor({ worker: { host: null, wsl: false } }, { uninstall: reply }), null);
  assert.equal(uninstallFor({ worker: null }, { uninstall: reply }), null);
  // A 202 says a worker's copies are there, whatever the row had heard of it.
  assert.deepEqual(uninstallFor({ worker: null }, { removing: true, uninstall: reply }), { tag: 'bash', command: reply.bash });
});

/** A machine whose worker has said hello once, so its row knows it has one. */
async function worker(name: string) {
  const made = ok(await srv.call('/api/machines', { name, mine: true }));
  const post = (path: string, body: object) => fetch(srv.base + path, { method: 'POST', headers: { Authorization: `Bearer ${made.token}`, 'Content-Type': 'application/json', 'X-Citadel-Worker': 'b' }, body: JSON.stringify(body) });
  await post('/api/machines/turns', { worker: { claude: '2.0.0', max: 3, signedIn: false }, turns: [] });
  await post('/api/machines/worker', { boot: 'b', installed: 1, host: 'MY-PC', wsl: true, caps: { workers: 3, threads: 4, memory_gb: 10, disk_gb: 80 }, image: { state: 'ready', text: 'ok' }, github: false, disk_gb: 1, full: false, test: null });
}

before(async () => {
  if (skip) return;
  srv = await bootServer();
  projectId = ok(await srv.call('/api/projects', { name: 'Delve' })).id;
  await worker('win-pc');
  await worker('busy-pc');
  ok(await srv.call('/api/machines', { name: 'tools-only', mine: true }));
  browser = await launch(bin!);
  page = await browser.page('data:text/html,<script>window.ready=true</script>', { width: 1200, height: 900 });
  const [name, value] = srv.cookie.split('=');
  await page.send('Network.setCookie', { name, value, url: srv.base });
  await page.send('Page.navigate', { url: `${srv.base}/#/p/${projectId}/machines` });
  await wait('the machines', `document.querySelectorAll('.machine-row').length === 3`);
  // DELETE is held until the test lets it go, and answered as `window.answer` says (null: the server's own).
  await page.eval(`(() => {
    window.confirm = () => true;
    const real = window.fetch;
    window.fetch = async (url, opts) => {
      if (opts?.method !== 'DELETE') return real(url, opts);
      await new Promise((go) => { window.go = go; });
      const a = window.answer;
      return a ? new Response(JSON.stringify(a.body), { status: a.status, headers: { 'Content-Type': 'application/json' } }) : real(url, opts);
    };
  })()`);
});
after(async () => {
  await browser?.close();
  await srv?.stop();
});

const wait = (what: string, expression: string) => waitFor(page, what, expression);
const row = (name: string) => `document.querySelector('.machine-row[data-name="${name}"]')`;
const panel = (name: string) => `document.querySelector('.machine-removal[data-name="${name}"]')`;
const button = (name: string) => `[...${row(name)}.querySelectorAll('.machine-buttons button')].find((b) => /^Remov/.test(b.textContent))`;
async function remove(name: string, answer: object | null) {
  await page.eval(`(() => { window.go = null; window.answer = ${JSON.stringify(answer)}; ${row(name)}.open = true; })()`);
  await wait('its Remove button', `!!${button(name)}`);
  await page.eval(`${button(name)}.click()`);
}
const go = async () => {
  await wait('the request', '!!window.go');
  await page.eval('window.go()');
};

test('a failed remove puts the row back, with a toast that retries', { skip }, async () => {
  await remove('busy-pc', { status: 500, body: { error: 'no luck' } });
  // At once: before the server has answered.
  assert.match(await page.eval<string>(`${row('busy-pc')}.querySelector('summary').textContent`), /Removing…/);
  assert.equal(await page.eval(`${button('busy-pc')}.disabled`), true);
  await go();
  await wait('the toast', `/Couldn't remove busy-pc: no luck[^]*Retry/.test(document.body.textContent)`);
  assert.doesNotMatch(await page.eval<string>(`${row('busy-pc')}.querySelector('summary').textContent`), /Removing…/);
  assert.equal(await page.eval(`!!${panel('busy-pc')}`), false);
});

test('while it drains (202) the row stays, Removing…, with the command and its shell', { skip }, async () => {
  await remove('busy-pc', { status: 202, body: { removing: true, uninstall: reply } });
  await go();
  await wait('the command', `!!${panel('busy-pc')}?.querySelector('pre.cui-shell[data-tone=powershell]')`);
  assert.equal(await page.eval(`${panel('busy-pc')}.querySelector('pre').textContent`), reply.powershell);
  assert.match(await page.eval<string>(`${row('busy-pc')}.querySelector('summary').textContent`), /Removing…/);
});

test('gone at once (200) the row is dropped, and a worker still gets its command', { skip }, async () => {
  await remove('win-pc', null);
  await go();
  await wait('the row gone', `!${row('win-pc')}`);
  await wait('the command', `!!${panel('win-pc')}?.querySelector('pre')`);
  assert.match(await page.eval<string>(`${panel('win-pc')}.textContent`), /win-pc is removed[^]*wsl --unregister citadel-workers/);
  await page.eval(`${panel('win-pc')}.querySelector('button.secondary').click()`);
  assert.equal(await page.eval(`!!${panel('win-pc')}`), false);
});

test('a machine with no worker just goes, with nothing to run', { skip }, async () => {
  await remove('tools-only', null);
  await go();
  await wait('the row gone', `!${row('tools-only')}`);
  assert.equal(await page.eval(`!!${panel('tools-only')}`), false);
});

test('a machine added later under a removed one’s id starts clean', { skip }, async () => {
  await worker('old-pc');
  // Its row knows it has a worker.
  await wait('its row', `!!${row('old-pc')}?.textContent.includes('MY-PC')`);
  await remove('old-pc', null);
  await go();
  await wait('the row gone', `!${row('old-pc')}`);
  await worker('new-pc');
  await wait('the new row', `!!${row('new-pc')}`);
  assert.doesNotMatch(await page.eval<string>(`${row('new-pc')}.querySelector('summary').textContent`), /Removing…/);
  assert.match(await page.eval<string>(`${panel('old-pc')}.textContent`), /old-pc is removed/);
});
