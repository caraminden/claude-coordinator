// Settings → Your account's Claude and Codex cards (#1856): what Cancel, Unlink and Sign out send, a refused code, and a
// poll that fails. Citadel's real front end in headless Chromium (test/browser.ts), with fetch answered in the page.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium, launch, waitFor, type Browser, serveApp, skipMessage, type App } from './browser.ts';

const bin = chromium();
const skip = !bin && skipMessage;

const STUB = `<script>
  window.ready = true;
  const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  // The cards' polls at once, not in seconds.
  const later = window.setTimeout;
  window.setTimeout = (f, ms, ...a) => later(f, ms === 2000 || ms === 5000 ? 20 : ms, ...a);
  window.confirm = () => true;
  window.sent = [];
  const one = [{ n: 1, email: 'josh@x', linkedAt: 1, ready: true }];
  window.claude = { state: 'not linked', accounts: [], inUse: null };
  window.codex = { state: 'not linked' };
  window.fail = { claude: 0, codex: 0 };
  window.linkedClaude = { state: 'linked', accounts: one, inUse: 1 };
  window.codeBox = { state: 'waiting for code', accounts: one, inUse: 1, linking: 1, url: 'https://claude.ai/oauth/x' };
  window.fetch = async (input, opts = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    const path = url.pathname.replace(/^\\//, '');
    const method = opts.method ?? 'GET';
    if (path === 'api/me') return reply({ name: 'Josh', login: 'josh', admin: false, uid: 2 });
    if (path === 'api/projects') return reply([{ id: 1, name: 'Alpha', inbox: 0, icon: null }]);
    if (/^api\\/projects\\/1$/.test(path)) return reply({ project: { id: 1, name: 'Alpha', instructions: '' }, coordinator: { id: 100, project_id: 1, kind: 'coordinator', number: 0, title: 'Taskmaster', status: 'idle', updated_at: 0 }, tickets: [], members: [] });
    if (path === 'api/me/claude/code') return reply({ error: 'No sign-in is waiting for a code: start linking again.' }, 400);
    for (const who of ['claude', 'codex']) {
      if (path !== 'api/me/' + who) continue;
      if (method !== 'GET') window.sent.push(method + ' ' + path + url.search);
      else if (window.fail[who] > 0) { window.fail[who]--; throw new TypeError('Failed to fetch'); }
      return reply(window[who]);
    }
    return reply([]);
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

/** The account page with its Claude and Codex cards as `state` says (an expression over the stub's variables). */
async function accountPage(state: string) {
  const page = await browser.page(`${app.base}#/p/1`, { width: 1280, height: 800 });
  await page.eval(`${state}; location.hash = '#/p/1/account'`);
  await waitFor(page, 'the cards', `document.querySelectorAll('.account-card .link-chip').length >= 2`);
  return page;
}
const card = (name: string) => `[...document.querySelectorAll('.account-card')].find((c) => c.querySelector('h3')?.firstChild?.textContent === '${name}')`;
const click = (name: string, label: string) => `[...${card(name)}.querySelectorAll('button')].find((b) => b.textContent === '${label}').click()`;
const chip = (name: string) => `${card(name)}?.querySelector('.link-chip')?.textContent`;

test('Cancel sends a request that cannot remove anything; Unlink and Sign out say they remove', { skip }, async () => {
  let page = await accountPage(`window.claude = window.codeBox; window.codex = { state: 'waiting', url: 'https://x', code: 'AB12' }`);
  await page.eval(`${click('Claude', 'Cancel')}; ${click('Codex', 'Cancel')}`);
  await waitFor(page, 'both requests', `window.sent.length === 2`);
  assert.deepEqual(await page.eval('window.sent'), ['DELETE api/me/claude?account=1', 'DELETE api/me/codex']);

  page = await accountPage(`window.claude = window.linkedClaude; window.codex = { state: 'linked' }`);
  await page.eval(`${click('Claude', 'Unlink')}; ${click('Codex', 'Sign out')}`);
  await waitFor(page, 'both requests', `window.sent.length === 2`);
  assert.deepEqual(await page.eval('window.sent'), ['DELETE api/me/claude?account=1&unlink=1', 'DELETE api/me/codex?unlink=1']);
});

test('a refused code re-reads the sign-in, so a card nobody waits on stops offering the code box', { skip }, async () => {
  const page = await accountPage(`window.claude = window.codeBox`);
  await page.eval(`window.claude = window.linkedClaude; const i = ${card('Claude')}.querySelector('input'); i.value = 'abc'; i.form.requestSubmit()`);
  await waitFor(page, 'the refusal', `!!${card('Claude')}.querySelector('.error')`);
  assert.equal(await page.eval(`${card('Claude')}.querySelector('.error').textContent`), 'No sign-in is waiting for a code: start linking again.');
  assert.equal(await page.eval(`!!${card('Claude')}.querySelector('input[placeholder="Paste the code here"]')`), false);
  assert.equal(await page.eval(`${card('Claude')}.textContent.includes('Cancel')`), false);
});

test('a refused code whose re-read fails keeps the code box and says why', { skip }, async () => {
  const page = await accountPage(`window.claude = window.codeBox`);
  await page.eval(`window.fail.claude = 1; const i = ${card('Claude')}.querySelector('input'); i.value = 'abc'; i.form.requestSubmit()`);
  await waitFor(page, 'the refusal', `!!${card('Claude')}.querySelector('.error')`);
  assert.equal(await page.eval(`!!${card('Claude')}.querySelector('input[placeholder="Paste the code here"]')`), true);
});

test('a failed poll is tried again: both cards carry on to the linked state', { skip }, async () => {
  const page = await accountPage(`window.claude = { state: 'starting', accounts: [], inUse: null, linking: 1 }; window.codex = { state: 'waiting', url: 'https://x', code: 'AB12' }`);
  await page.eval(`window.fail = { claude: 2, codex: 2 }`);
  await waitFor(page, 'both failures', `window.fail.claude === 0 && window.fail.codex === 0`);
  await page.eval(`window.claude = window.linkedClaude; window.codex = { state: 'linked' }`);
  await waitFor(page, 'Claude to carry on', `/linked/i.test(${chip('Claude')}) && !/Not/.test(${chip('Claude')})`);
  await waitFor(page, 'Codex to carry on', `${chip('Codex')} === 'Linked'`);
});
