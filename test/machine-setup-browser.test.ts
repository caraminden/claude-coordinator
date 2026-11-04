// The Machines page in a real browser (headless Chromium, test/browser.ts) against the real server: the setup
// lines follow what the machine was added with, not what the add form shows later (#308: Josh added
// josh-laptop with "None" and still got a scheduled task running --claude-mcp godot-ai).
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { bootServer, type Booted } from './helpers.ts';
import { chromium, launch, type Browser, type Page } from './browser.ts';

const bin = chromium();
const skip = !bin && 'no headless Chromium in ~/.cache/ms-playwright';

let srv: Booted;
let browser: Browser;
let page: Page;
let projectId = 0;

before(async () => {
  if (skip) return;
  srv = await bootServer();
  projectId = (await srv.call('/api/projects', { name: 'P' })).data.id;
  browser = await launch(bin!);
  page = await browser.page('data:text/html,<script>window.ready=true</script>', { width: 1200, height: 900 });
  const [name, value] = srv.cookie.split('=');
  await page.send('Network.setCookie', { name, value, url: srv.base });
});

after(async () => {
  await browser?.close();
  await srv?.stop();
});

const wait = async (what: string, expression: string) => {
  for (const end = Date.now() + 10_000; !(await page.eval(expression).catch(() => false)); await new Promise((r) => setTimeout(r, 50))) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
  }
};
const snippets = () => page.eval<string[]>('[...document.querySelectorAll("#machine-setup pre")].map((p) => p.textContent)');

async function openMachines() {
  await page.send('Page.navigate', { url: `${srv.base}/#/p/${projectId}/machines` });
  await wait('the Machines page', '!!document.querySelector(".machine-add select[name=kind]")');
}

/** Fill the add form and submit it, then wait for its setup lines. */
async function add(name: string, kind: string, command?: string) {
  await page.eval(`(() => {
    const f = document.querySelector('.machine-add');
    f.querySelector('[name=name]').value = ${JSON.stringify(name)};
    const kind = f.querySelector('[name=kind]');
    kind.value = ${JSON.stringify(kind)};
    kind.dispatchEvent(new Event('change'));
    ${command === undefined ? '' : `f.querySelector('[name=command]').value = ${JSON.stringify(command)};`}
    f.requestSubmit();
  })()`);
  await wait(`${name}'s setup lines`, `document.querySelector('#machine-setup strong')?.textContent === 'Connect ${name}'`);
}

async function newToken(name: string) {
  await page.eval(`(() => {
    window.confirm = () => true;
    const row = [...document.querySelectorAll('.machine-row')].find((r) => r.querySelector('.name').textContent === ${JSON.stringify(name)});
    [...row.querySelectorAll('button')].find((b) => b.textContent === 'New token').click();
  })()`);
  await wait(`${name}'s new setup lines`, `document.querySelector('#machine-setup strong')?.textContent === 'Connect ${name}'`);
}

test('a machine added with None gets setup lines without an MCP server, now and after a new token (#308)', { skip }, async () => {
  await openMachines();
  await add('josh-laptop', 'none');
  for (const s of await snippets()) assert.doesNotMatch(s, /--claude-mcp|-- /, 'the add form said None');

  // Back on the page later the form is fresh (godot-ai), and a new token still says None.
  await openMachines();
  await wait('the machine list', '!!document.querySelector(".machine-row")');
  await newToken('josh-laptop');
  const [windows, terminal] = await snippets();
  assert.doesNotMatch(windows, /--claude-mcp|-- /);
  assert.doesNotMatch(terminal, /--claude-mcp|-- /);
});

test('a machine\'s setup lines keep its own server when the form changes for the next one (#308)', { skip }, async () => {
  await openMachines();
  await add('cmd-box', 'command', 'npx -y some-mcp');
  // Picking something else in the form, as for the next machine, leaves cmd-box's lines alone.
  await page.eval(`(() => { const k = document.querySelector('.machine-add [name=kind]'); k.value = 'none'; k.dispatchEvent(new Event('change')); })()`);
  for (const s of await snippets()) assert.match(s, / -- npx -y some-mcp/);

  await openMachines();
  await wait('the machine list', '!!document.querySelector(".machine-row")');
  await newToken('cmd-box');
  for (const s of await snippets()) assert.match(s, / -- npx -y some-mcp/);
  // And the godot-ai default still reaches a machine added with it.
  await add('godot-box', 'claude');
  for (const s of await snippets()) assert.match(s, /--claude-mcp godot-ai/);
});

test('a machine added before its server was kept follows the form, and says so (#308)', { skip }, async () => {
  await srv.call('/api/machines', { name: 'old-box' }); // no kind: as an older page added it
  await openMachines();
  await wait('the machine list', '!!document.querySelector(".machine-row")');
  await newToken('old-box');
  assert.match(await page.eval<string>('document.querySelector("#machine-setup").textContent'), /added before Citadel kept which MCP server it runs/);
  for (const s of await snippets()) assert.match(s, /--claude-mcp godot-ai/, 'the fresh form says godot-ai');
  await page.eval(`(() => { const k = document.querySelector('.machine-add [name=kind]'); k.value = 'none'; k.dispatchEvent(new Event('change')); })()`);
  for (const s of await snippets()) assert.doesNotMatch(s, /--claude-mcp|-- /, 'picking None in the form fixes its lines');
});
