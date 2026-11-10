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
const snippets = () => page.eval<string[]>('[...document.querySelectorAll("#machine-setup .machine-setup-way:not([data-os=runner]) pre")].map((p) => p.textContent)');

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
    const row = () => [...document.querySelectorAll('.machine-row')].find((r) => r.querySelector('.name').textContent === ${JSON.stringify(name)});
    // Its buttons are on its opened line (#437); opening it redraws the list.
    if (!row().classList.contains('open')) row().querySelector('.machine-open').click();
    [...row().querySelectorAll('button')].find((b) => b.textContent === 'New token').click();
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
  const [windows, background, terminal] = await snippets();
  for (const s of [windows, background, terminal]) assert.doesNotMatch(s, /--claude-mcp|-- /);
});

test('the setup shows the viewer\'s own kind of computer first, the others a click away (#309)', { skip }, async () => {
  await openMachines();
  await add('pick-box', 'claude');
  const shown = () => page.eval<string[]>('[...document.querySelectorAll("#machine-setup .machine-setup-way:not([hidden]) pre")].map((p) => p.textContent)');
  const pressed = () => page.eval<string>('document.querySelector("#machine-setup [aria-pressed=true]").textContent');
  // Headless Chromium here says Linux.
  assert.equal(await pressed(), 'macOS or Linux');
  let [only] = await shown();
  assert.equal((await shown()).length, 1);
  assert.match(only, /^mkdir -p ~\/coordinator-agent && cd ~\/coordinator-agent &&\n[\s\S]* --install pick-box --claude-mcp godot-ai$/);
  const click = (label: string) => page.eval(`[...document.querySelectorAll('#machine-setup .chip')].find((b) => b.textContent === ${JSON.stringify(label)}).click()`);
  await click('Windows');
  [only] = await shown();
  assert.match(only, /conhost\.exe/);
  assert.match(await page.eval<string>('document.querySelector("#machine-setup .machine-setup-way:not([hidden])").textContent'), /%USERPROFILE%\\coordinator-agent\\machine-agent-pick-box\.log/);
  // The pick holds while the form below changes the lines.
  await page.eval(`(() => { const f = document.querySelector('.machine-add [name=folder]'); f.value = '/tmp/vault'; f.dispatchEvent(new Event('input')); })()`);
  assert.equal(await pressed(), 'Windows');
  await click('Just try it');
  [only] = await shown();
  assert.match(only, /^curl -fsSLO /);
  assert.match(await page.eval<string>('document.querySelector("#machine-setup .machine-setup-way:not([hidden])").textContent'), /stops when you close it/);
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
  assert.match(await page.eval<string>('document.querySelector("#machine-setup").textContent'), /Citadel doesn't know what old-box runs.*godot-ai/);
  for (const s of await snippets()) assert.match(s, /--claude-mcp godot-ai/, 'the fresh form says godot-ai');
  await page.eval(`(() => { const k = document.querySelector('.machine-add [name=kind]'); k.value = 'none'; k.dispatchEvent(new Event('change')); })()`);
  for (const s of await snippets()) assert.doesNotMatch(s, /--claude-mcp|-- /, 'picking None in the form fixes its lines');
});

test('the CI runner agent tab shows the install line with this app\'s address and the token filled in', { skip }, async () => {
  await openMachines();
  await add('runner-pc', 'none');
  const line = await page.eval<string>('document.querySelector("#machine-setup [data-os=runner] pre").textContent');
  assert.ok(line.startsWith(`$u = '${srv.base}';`), line);
  assert.match(line, /-MachineToken 'ccm_\d+_[\w-]+'$/);
});

test('Who gets it is one list of scheme chips: + scheme adds one at once, × takes it away (#438)', { skip }, async () => {
  const other = (await srv.call('/api/projects', { name: 'Other scheme' })).data;
  const { machine } = (await srv.call('/api/machines', { name: 'chip-box' })).data;
  await openMachines();
  await wait('the machine list', '!!document.querySelector(".machine-row")');
  const row = `[...document.querySelectorAll('.machine-row')].find((r) => r.querySelector('.name').textContent === 'chip-box')`;
  await page.eval(`${row}.querySelector('.machine-open').click()`);
  const chips = () => page.eval<string[]>(`[...${row}.querySelectorAll('.scheme-chip > span')].map((c) => c.textContent)`);
  const saved = async () => (await srv.call('/api/machines')).data.find((m: any) => m.id === machine.id).projects;
  assert.deepEqual(await chips(), []);
  assert.match(await page.eval<string>(`${row}.querySelector('.machine-lending').textContent`), /No scheme gets it yet/);
  assert.equal(await page.eval(`!!${row}.querySelector('input[type=radio]')`), false, 'no "every scheme an admin owns" radio');
  const add = (id: number) => page.eval(`(() => { const s = ${row}.querySelector('select.add-scheme'); s.value = '${id}'; s.dispatchEvent(new Event('change')); })()`);
  // Two picks in a row both count, before either answer is back.
  await add(projectId);
  await add(other.id);
  assert.deepEqual(await chips(), ['P', 'Other scheme']);
  await wait('both to be saved', `fetch('api/machines').then((r) => r.json()).then((l) => l.find((m) => m.id === ${machine.id}).projects.length === 2)`);
  assert.equal(await page.eval(`${row}.querySelector('select.add-scheme').hidden`), true, 'no scheme left to add');
  await page.eval(`${row}.querySelector('.scheme-chip button[aria-label="Remove P"]').click()`);
  assert.deepEqual(await chips(), ['Other scheme']);
  await wait('the removal to be saved', `fetch('api/machines').then((r) => r.json()).then((l) => l.find((m) => m.id === ${machine.id}).projects.length === 1)`);
  assert.deepEqual(await saved(), [other.id]);
});
