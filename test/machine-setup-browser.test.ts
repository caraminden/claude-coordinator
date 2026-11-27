// The Machines page in a real browser (headless Chromium, test/browser.ts) against the real server and a real
// agent (#439): adding a machine asks a name and gives one install line, and what it lends is ticked in its row
// from what its agent found there.
import assert from 'node:assert/strict';
import { type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { bootServer, stopProcs, type Booted } from './helpers.ts';
import { machineFakes } from './machine-fakes.ts';
import { chromium, launch, waitFor, type Browser, type Page } from './browser.ts';

const bin = chromium();
const skip = !bin && 'no headless Chromium in ~/.cache/ms-playwright';

let srv: Booted;
let browser: Browser;
let page: Page;
let projectId = 0;
const procs: ChildProcess[] = [];
const dir = mkdtempSync(join(tmpdir(), 'machine-browser-'));
const { mcpServer, startMachineAgent } = machineFakes(dir, procs);

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

const wait = (what: string, expression: string) => waitFor(page, what, expression);
const shown = () => page.eval<string[]>('[...document.querySelectorAll("#machine-setup .machine-setup-way:not([hidden]) pre")].map((p) => p.textContent)');
const pressed = () => page.eval<string>('document.querySelector("#machine-setup [aria-pressed=true]")?.textContent ?? ""');
const row = (name: string) => `[...document.querySelectorAll('.machine-row')].find((r) => r.querySelector('.settings-row-title').textContent === ${JSON.stringify(name)})`;
const machine = async (name: string) => (await srv.call('/api/machines')).data.find((m: { name: string }) => m.name === name);

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
  await page.eval(`(() => { const r = ${row(name)}; r.open = true; })()`);
  await wait(`${name}'s line to open`, `${row(name)}.open && !!${row(name)}.querySelector('.machine-body')`);
}

test('adding a machine asks its name and nothing about MCP servers or folders, then gives one install line', { skip }, async () => {
  await openMachines();
  assert.deepEqual(await page.eval<string[]>('[...document.querySelectorAll(".machine-add:not(.runners) [name]")].map((i) => i.name)'), ['name', 'always_on'], "no Mine tick: every machine is its adder's (Build 10 H1)");
  await add('pick-box');
  // Headless Chromium here says Linux: that line shows, the other a click away, and nothing else.
  assert.deepEqual(await page.eval<string[]>('[...document.querySelectorAll("#machine-setup .chip")].map((b) => b.textContent)'), ['Windows', 'macOS or Linux', 'GPU jobs (WSL)']);
  assert.equal(await pressed(), 'macOS or Linux');
  let lines = await shown();
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^mkdir -p ~\/coordinator-agent && cd ~\/coordinator-agent &&\n[\s\S]* ccm_\d+_[\w-]+ --config machine-agent\.json --install pick-box$/);
  await page.eval(`[...document.querySelectorAll('#machine-setup .chip')].find((b) => b.textContent === 'Windows').click()`);
  lines = await shown();
  assert.equal(lines.length, 1);
  assert.match(lines[0], /conhost\.exe/);
  // GPU jobs (#858): the same Linux line, pasted in the citadel-jobs distro, and a pointer to its jobs block.
  await page.eval(`[...document.querySelectorAll('#machine-setup .chip')].find((b) => b.textContent === 'GPU jobs (WSL)').click()`);
  assert.match((await shown())[0], /--install pick-box$/);
  assert.match(await page.eval<string>('document.querySelector("#machine-setup .machine-setup-way:not([hidden])").textContent'), /wsl -d citadel-jobs[\s\S]*"jobs" block/);
  await page.eval(`[...document.querySelectorAll('#machine-setup .chip')].find((b) => b.textContent === 'Windows').click()`);
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
  startMachineAgent({ base: srv.base, token, run: ['--config', join(dir, 'machine-agent.json')], env: { CLAUDE_CONFIG_DIR: dir } });
  for (const end = Date.now() + 20_000; !(await machine('tick-box')).found?.length; ) {
    if (Date.now() > end) throw new Error('the agent never reported');
    await new Promise((r) => setTimeout(r, 100));
  }
  await openMachines();
  await wait('its line to ask for a tick', `/Lends nothing: nothing is ticked/.test(${row('tick-box')}?.textContent ?? '')`);
  await open('tick-box');
  const boxes = `[...${row('tick-box')}.querySelectorAll('.machine-lends label')]`;
  assert.deepEqual(await page.eval<string[]>(`${boxes}.map((l) => l.textContent + ':' + l.querySelector('input').checked)`), ["godot-ai · from Claude Code's config:false", 'vault:false']);
  assert.doesNotMatch(await page.eval<string>('document.body.textContent'), /sk-secret-123/);
  const saved = ['(l) => l?.server === "godot-ai"', '(l) => !!l?.workspaces.includes("vault")'];
  for (const n of [0, 1]) {
    await page.eval(`${boxes}[${n}].querySelector('input').click()`);
    await wait(`tick ${n} to show`, `${boxes}[${n}]?.querySelector('input').checked === true`);
    // The box ticks at once and its save goes behind (optimistic): wait for the server to hold it, not the box.
    await wait(`tick ${n} to save`, `fetch('api/machines').then((r) => r.json()).then((l) => (${saved[n]})(l.find((m) => m.name === 'tick-box').lend))`);
  }
  for (const end = Date.now() + 20_000; (await machine('tick-box')).status !== 'ready'; ) {
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
  startMachineAgent({ base: srv.base, token });
  for (const end = Date.now() + 20_000; !(await machine('old-box')).online; ) {
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
  await wait("old-box's install line", `document.querySelector('#machine-setup strong')?.textContent === 'Connect old-box'`);
  assert.match((await shown())[0], /--config machine-agent\.json --install old-box$/);
  assert.equal((await machine('old-box')).id, old.id, 'reinstalling kept the same machine');
});

test('a CI runner host is added from its own button and gets its own install line', { skip }, async () => {
  await openMachines();
  await add('runner-pc', '.machine-add.runners');
  // Windows first, whatever this browser runs on: the Windows agent is the usual one; Linux in WSL is a second host (#510).
  assert.deepEqual(await page.eval<string[]>('[...document.querySelectorAll("#machine-setup .chip")].map((b) => b.textContent)'), ['Windows', 'Linux in WSL', 'Linux']);
  assert.equal(await pressed(), 'Windows');
  const [line] = await shown();
  assert.ok(line.startsWith("$u = 'https://citadel.zip';"), line); // the setup line names Citadel's public address, not the host it was made on (#1635)
  assert.match(line, /-MachineToken 'ccm_\d+_[\w-]+'$/);
  await page.eval('[...document.querySelectorAll("#machine-setup .chip")].find((b) => b.textContent === "Linux in WSL").click()');
  await wait('the Linux line', 'document.querySelector("#machine-setup [aria-pressed=true]")?.textContent === "Linux in WSL"');
  const [linux] = await shown();
  await page.eval('[...document.querySelectorAll("#machine-setup .chip")].find((b) => b.textContent === "Linux").click()');
  await wait('the plain Linux line', 'document.querySelector("#machine-setup [aria-pressed=true]")?.textContent === "Linux"');
  assert.deepEqual(await shown(), [linux], 'plain Linux takes the same line');
  assert.equal(linux, line.replace(/^\$u = '([^']+)'.*'(ccm_[^']+)'$/, `u='$1'; f=$$(mktemp) && curl -fsSL "$u/ci-runner/install-runner-agent.sh" -o "$f" && CC_MACHINE_TOKEN='$2' bash "$f" "$u"`), 'the same address and token');
  // It sits under CI runners from the start, before its agent has ever connected.
  assert.equal((await machine('runner-pc')).runners, true);
  await wait('its line under CI runners', `!!${row('runner-pc')}`);
  assert.match(await page.eval<string>(`${row('runner-pc')}.closest('.machine-group, section, div[class*=group]')?.textContent ?? document.querySelector('#machine-list').textContent`), /CI runners[\s\S]*runner-pc/);
});

test("Who gets it is a list of scheme chips on each role's card: a click adds or takes one at once, and it is saved (#438, Build 7 M3)", { skip }, async () => {
  const other = (await srv.call('/api/projects', { name: 'Other scheme' })).data;
  const { machine } = (await srv.call('/api/machines', { name: 'chip-box' })).data;
  await openMachines();
  await wait('the machine list', '!!document.querySelector(".machine-row")');
  const row = `[...document.querySelectorAll('.machine-row')].find((r) => r.querySelector('.settings-row-title').textContent === 'chip-box')`;
  await page.eval(`${row}.open = true`);
  await wait("chip-box's body", `!!${row}.querySelector('.machine-body')`);
  const card = `${row}.querySelector('.role-card[data-role=tools]')`;
  const chips = () => page.eval<string[]>(`[...${card}.querySelectorAll('.role-schemes .chip[aria-pressed=true]')].map((c) => c.textContent)`);
  const chip = (name: string) => `[...${card}.querySelectorAll('.role-schemes .chip')].find((c) => c.textContent === ${JSON.stringify(name)})`;
  const saved = async () => (await srv.call(`/api/machines/${machine.id}/roles`)).data.roles.find((r: { role: string }) => r.role === 'tools').projects;
  const savedIs = (n: number) => `fetch('api/machines/${machine.id}/roles').then((r) => r.json()).then((d) => d.roles.find((r) => r.role === 'tools').projects.length === ${n})`;
  // A new machine's Tools and folders is on, lent to no scheme yet: every scheme shows as a chip, none of them on.
  assert.equal(await page.eval(`${card}.querySelector('.rules-switch').getAttribute('aria-checked')`), 'true');
  assert.deepEqual(await page.eval<string[]>(`[...${card}.querySelectorAll('.role-schemes .chip')].map((c) => c.textContent)`), ['Other scheme', 'P'], "the schemes in the page's order");
  assert.deepEqual(await chips(), []);
  assert.deepEqual(await saved(), []);
  assert.equal(await page.eval(`!!${row}.querySelector('input[type=radio]')`), false, 'no "every scheme an admin owns" radio');
  // Two picks in a row both count, before either answer is back.
  await page.eval(`${chip('P')}.click(); ${chip('Other scheme')}.click()`);
  assert.deepEqual(await chips(), ['Other scheme', 'P'], 'at once');
  await wait('both to be saved', savedIs(2));
  // The first answer's broadcast can show the list without the second pick for a moment; it comes back with its own.
  await wait('both chips', `${card}.querySelectorAll('.role-schemes .chip[aria-pressed=true]').length === 2`);
  assert.deepEqual(await chips(), ['Other scheme', 'P']);
  await page.eval(`${chip('P')}.click()`);
  assert.deepEqual(await chips(), ['Other scheme']);
  await wait('the removal to be saved', savedIs(1));
  assert.deepEqual(await saved(), [other.id]);
});

test("a member who is no admin adds their own PC as a CI runner host and lends it to their scheme, not another's (#1933)", { skip }, async () => {
  // Signed in as a member of a scheme of their own: no admin, and not in Citadel's (scheme 2, whose members count as one).
  await srv.call('/api/projects', { name: 'Filler' });
  const made = (await srv.call('/api/people', { name: 'Mira' })).data;
  const invited = await fetch(`${srv.base}/api/invite/${made.token}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'a-long-password' }) });
  const srvCookie = invited.headers.get('set-cookie')!.split(';')[0];
  await page.send('Network.clearBrowserCookies');
  const [name, value] = srvCookie.split('=');
  await page.send('Network.setCookie', { name, value, url: srv.base });
  try {
    const mira = srv.as({ cookie: srvCookie });
    const mine = (await mira('/api/projects', { name: "Mira's" })).data;
    await page.send('Page.navigate', { url: `${srv.base}/#/p/${mine.id}/machines` });
    await wait('the Machines page', '!!document.querySelector(".machine-add-toggle") && !!document.querySelector("#machine-list")');
    assert.equal(await page.eval('[...document.querySelectorAll("button")].some((b) => b.textContent === "Add a CI runner host")'), true);
    await add('mira-pc', '.machine-add.runners');
    await open('mira-pc');
    // A runner host's row is its CI runners card alone (Build 7 M3): on, and lent to nothing until its owner picks.
    const card = `${row('mira-pc')}.querySelector('.role-card[data-role=ci]')`;
    assert.deepEqual(await page.eval(`[...${row('mira-pc')}.querySelectorAll('.role-card')].map((c) => c.dataset.role)`), ['ci']);
    assert.equal(await page.eval(`${card}.querySelector('.rules-switch').getAttribute('aria-checked')`), 'true');
    const chips = (sel = '') => page.eval<string[]>(`[...${card}.querySelectorAll('.role-schemes .chip${sel}')].map((c) => c.textContent)`);
    assert.deepEqual(await chips('[aria-pressed=true]'), [], 'lent to nothing until its owner picks');
    assert.deepEqual(await chips(), ["Mira's"], 'only the schemes she is in');
    await page.eval(`${card}.querySelector('.role-schemes .chip').click()`);
    await wait('the lend', `${card}.querySelectorAll('.role-schemes .chip[aria-pressed=true]').length === 1`);
    await wait('the lend to be saved', `fetch('api/machines').then((r) => r.json()).then((l) => l.length === 1 && l[0].projects.length === 1 && l[0].roles.find((r) => r.role === 'ci').projects.length === 1)`);
    assert.deepEqual((await machine('mira-pc')).roles.find((r: { role: string }) => r.role === 'ci').projects, [mine.id]);
    // Another member's machine isn't hers to see or change.
    assert.equal((await machine('mira-pc')).owner_id !== null, true);
    assert.equal((await mira(`/api/machines/${(await machine('runner-pc')).id}`, { projects: [] }, 'PATCH')).status, 404);
  } finally {
    await page.send('Network.clearBrowserCookies');
    const [n, v] = srv.cookie.split('=');
    await page.send('Network.setCookie', { name: n, value: v, url: srv.base });
  }
});
