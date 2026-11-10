// The Machines page in a real browser (headless Chromium, test/browser.ts) against the real server and a real
// agent (#439): adding a machine asks a name and gives one install line, and what it lends is ticked in its row
// from what its agent found there.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { bootServer, REPO, stopProcs, type Booted } from './helpers.ts';
import { machineFakes } from './machine-fakes.ts';
import { chromium, launch, type Browser, type Page } from './browser.ts';

const bin = chromium();
const skip = !bin && 'no headless Chromium in ~/.cache/ms-playwright';

let srv: Booted;
let browser: Browser;
let page: Page;
let projectId = 0;
const procs: ChildProcess[] = [];
const dir = mkdtempSync(join(tmpdir(), 'machine-browser-'));
const { mcpServer } = machineFakes(dir);

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
  await stopProcs(procs);
  await srv?.stop();
  rmSync(dir, { recursive: true, force: true });
});

const wait = async (what: string, expression: string) => {
  for (const end = Date.now() + 10_000; !(await page.eval(expression).catch(() => false)); await new Promise((r) => setTimeout(r, 50))) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
  }
};
const shown = () => page.eval<string[]>('[...document.querySelectorAll("#machine-setup .machine-setup-way:not([hidden]) pre")].map((p) => p.textContent)');
const pressed = () => page.eval<string>('document.querySelector("#machine-setup [aria-pressed=true]")?.textContent ?? ""');
const row = (name: string) => `[...document.querySelectorAll('.machine-row')].find((r) => r.querySelector('.name').textContent === ${JSON.stringify(name)})`;
const machine = async (name: string) => (await srv.call('/api/machines')).data.find((m: any) => m.name === name);

async function openMachines() {
  await page.send('Page.navigate', { url: `${srv.base}/#/p/${projectId}/machines` });
  await wait('the Machines page', '!!document.querySelector(".machine-add-toggle") && !!document.querySelector("#machine-list")');
}

/** Open an add form, give it a name and submit it, then wait for its install line. */
async function add(name: string, form = '.machine-add:not(.runners)') {
  await page.eval(`(() => {
    const f = document.querySelector(${JSON.stringify(form)});
    if (f.hidden) f.previousElementSibling.querySelector('button').click();
    f.querySelector('[name=name]').value = ${JSON.stringify(name)};
    f.requestSubmit();
  })()`);
  await wait(`${name}'s install line`, `document.querySelector('#machine-setup strong')?.textContent === 'Connect ${name}'`);
}

/** Open a machine's line, where its ticks and buttons are (#437). */
async function open(name: string) {
  await wait(`${name}'s line`, `!!${row(name)}`);
  await page.eval(`(() => { const r = ${row(name)}; if (!r.classList.contains('open')) r.querySelector('.machine-open').click(); })()`);
  await wait(`${name}'s line to open`, `${row(name)}.classList.contains('open')`);
}

test('adding a machine asks its name and nothing about MCP servers or folders, then gives one install line', { skip }, async () => {
  await openMachines();
  assert.deepEqual(await page.eval<string[]>('[...document.querySelectorAll(".machine-add:not(.runners) [name]")].map((i) => i.name)'), ['name', 'always_on', 'mine']);
  await add('pick-box');
  // Headless Chromium here says Linux: that line shows, the other a click away, and nothing else.
  assert.deepEqual(await page.eval<string[]>('[...document.querySelectorAll("#machine-setup .chip")].map((b) => b.textContent)'), ['Windows', 'macOS or Linux']);
  assert.equal(await pressed(), 'macOS or Linux');
  let lines = await shown();
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^mkdir -p ~\/coordinator-agent && cd ~\/coordinator-agent &&\n[\s\S]* ccm_\d+_[\w-]+ --config machine-agent\.json --install pick-box$/);
  await page.eval(`[...document.querySelectorAll('#machine-setup .chip')].find((b) => b.textContent === 'Windows').click()`);
  lines = await shown();
  assert.equal(lines.length, 1);
  assert.match(lines[0], /conhost\.exe/);
  for (const s of [...lines, await page.eval<string>('document.querySelector("#machine-setup").textContent')]) assert.doesNotMatch(s, /--claude-mcp|Just try it| -- /);
  assert.match(await page.eval<string>('document.querySelector("#machine-setup .machine-setup-way:not([hidden])").textContent'), /%USERPROFILE%\\coordinator-agent\\machine-agent-pick-box\.log/);
  assert.match(await page.eval<string>('document.querySelector("#machine-setup").textContent'), /open it and tick what to lend/);
  const m = await machine('pick-box');
  assert.deepEqual([m.always_on, m.mcp_kind, m.lend], [true, null, null]);
});

test('a machine lends what is ticked in its row from what its agent found, with no new token', { skip }, async () => {
  await openMachines();
  await add('tick-box');
  const token = (await shown())[0].match(/ccm_\d+_[\w-]+/)![0];
  await srv.call(`/api/machines/${(await machine('tick-box')).id}`, { projects: [projectId] }, 'PATCH');
  mkdirSync(join(dir, 'vault'));
  writeFileSync(join(dir, '.claude.json'), JSON.stringify({ mcpServers: { 'godot-ai': { command: process.execPath, args: [mcpServer], env: { KEY: 'sk-secret-123' } } } }));
  writeFileSync(join(dir, 'machine-agent.json'), JSON.stringify({ workspaces: { vault: { path: join(dir, 'vault') } } }));
  procs.push(spawn(process.execPath, [join(REPO, 'public/machine-agent.mjs'), srv.base, token, '--config', join(dir, 'machine-agent.json')], { stdio: 'ignore', env: { ...process.env, MACHINES_URL: undefined, CLAUDE_CONFIG_DIR: dir } }));
  for (const end = Date.now() + 20_000; !(await machine('tick-box')).found?.length;) {
    if (Date.now() > end) throw new Error('the agent never reported');
    await new Promise((r) => setTimeout(r, 100));
  }
  await openMachines();
  await wait('its line to ask for a tick', `/Lends nothing: nothing is ticked/.test(${row('tick-box')}?.textContent ?? '')`);
  await open('tick-box');
  const boxes = `[...${row('tick-box')}.querySelectorAll('.machine-lends label')]`;
  assert.deepEqual(await page.eval<string[]>(`${boxes}.map((l) => l.textContent + ':' + l.querySelector('input').checked)`), ['godot-ai · from Claude Code\'s config:false', 'vault:false']);
  assert.doesNotMatch(await page.eval<string>('document.body.textContent'), /sk-secret-123/);
  for (const n of [0, 1]) {
    await page.eval(`${boxes}[${n}].querySelector('input').click()`);
    await wait(`tick ${n} to save`, `${boxes}[${n}]?.querySelector('input').checked === true`);
  }
  for (const end = Date.now() + 20_000; (await machine('tick-box')).status !== 'ready';) {
    if (Date.now() > end) throw new Error(`never Ready: ${JSON.stringify(await machine('tick-box'))}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  const m = await machine('tick-box');
  assert.deepEqual(m.lend, { server: 'godot-ai', workspaces: ['vault'] });
  assert.equal(await page.eval<boolean>('!!document.querySelector("#machine-setup strong")'), false, 'ticking made no new token to paste');
  assert.equal(m.online, true, 'the agent it was installed with still serves it');
});

test('a machine set up before ticks shows what it lends as set on that computer, with a way to reinstall', { skip }, async () => {
  const { machine: old, token } = (await srv.call('/api/machines', { name: 'old-box' })).data;
  procs.push(spawn(process.execPath, [join(REPO, 'public/machine-agent.mjs'), srv.base, token, '--', process.execPath, mcpServer], { stdio: 'ignore', env: { ...process.env, MACHINES_URL: undefined } }));
  for (const end = Date.now() + 20_000; !(await machine('old-box')).online;) {
    if (Date.now() > end) throw new Error('the old agent never connected');
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal((await machine('old-box')).managed, false);
  await openMachines();
  await open('old-box');
  const text = await page.eval<string>(`${row('old-box')}.querySelector('.machine-lends').textContent`);
  assert.match(text, /MCP server: .* · set on that computer/);
  assert.match(text, /Reinstall to manage from here/);
  assert.equal(await page.eval<number>(`${row('old-box')}.querySelectorAll('.machine-lends input').length`), 0, 'nothing to tick on an agent that takes no ticks');
  // Reinstalling is a new token and the one install line; the confirm says what changes.
  const asked = await page.eval<string>(`(() => { let said = ''; window.confirm = (t) => { said = t; return true; }; [...${row('old-box')}.querySelectorAll('.machine-lends button')].find((b) => b.textContent === 'Reinstall to manage from here').click(); return said; })()`);
  assert.match(asked, /servers/);
  await wait('old-box\'s install line', `document.querySelector('#machine-setup strong')?.textContent === 'Connect old-box'`);
  assert.match((await shown())[0], /--config machine-agent\.json --install old-box$/);
  assert.equal(old.id > 0, true);
});

test('a CI runner host is added from its own button and gets its own install line', { skip }, async () => {
  await openMachines();
  await add('runner-pc', '.machine-add.runners');
  assert.equal(await pressed(), '', 'no Windows or macOS choice: the runner agent is a Windows program');
  const [line] = await shown();
  assert.ok(line.startsWith(`$u = '${srv.base}';`), line);
  assert.match(line, /-MachineToken 'ccm_\d+_[\w-]+'$/);
  // It sits under CI runners from the start, before its agent has ever connected.
  assert.equal((await machine('runner-pc')).runners, true);
  await wait('its line under CI runners', `!!${row('runner-pc')}`);
  assert.match(await page.eval<string>(`${row('runner-pc')}.closest('.machine-group, section, div[class*=group]')?.textContent ?? document.querySelector('#machine-list').textContent`), /CI runners[\s\S]*runner-pc/);
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
  await wait('both to be saved', `fetch('api/machines').then((r) => r.json()).then((l) => l.find((m) => m.id === ${machine.id}).projects.length === 2)`);
  // The first answer's broadcast can show the list without the second pick for a moment; it comes back with its own.
  await wait('both chips', `${row}.querySelectorAll('.scheme-chip').length === 2`);
  assert.deepEqual(await chips(), ['P', 'Other scheme']);
  assert.equal(await page.eval(`${row}.querySelector('select.add-scheme').hidden`), true, 'no scheme left to add');
  await page.eval(`${row}.querySelector('.scheme-chip button[aria-label="Remove P"]').click()`);
  assert.deepEqual(await chips(), ['Other scheme']);
  await wait('the removal to be saved', `fetch('api/machines').then((r) => r.json()).then((l) => l.find((m) => m.id === ${machine.id}).projects.length === 1)`);
  assert.deepEqual(await saved(), [other.id]);
});
