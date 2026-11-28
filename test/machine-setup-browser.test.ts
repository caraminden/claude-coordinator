// The Machines page in a real browser (headless Chromium, test/browser.ts) against the real server and a real
// agent (#439): Connect a computer is one modal with one paste line (Build 10 H3, take B), and what a machine lends is
// ticked under "Choose what it shares" on its card from what its agent found there.
import assert from 'node:assert/strict';
import { type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { bootServer, stopProcs, type Booted } from './helpers.ts';
import { machineFakes } from './machine-fakes.ts';
import { until } from './wait.ts';
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
const card = (name: string) => `document.querySelector('.mcard[data-name=${JSON.stringify(name)}]')`;
const machine = async (name: string) => (await srv.call('/api/machines')).data.find((m: { name: string }) => m.name === name);

async function openMachines() {
  await page.send('Page.navigate', { url: `${srv.base}/#/p/${projectId}/machines` });
  await wait('the Machines page', '!!document.querySelector("#machine-list") && !!document.querySelector(".machine-connect-toggle, .machine-connect-first")');
}

/** Open a card's "Choose what it shares" and one role's row under it, where its schemes and ticks are. Returns that row. */
async function choose(name: string, role: string) {
  await wait(`${name}'s card`, `!!${card(name)}`);
  const row = `${card(name)}.querySelector('.mcard-choose-row[data-role=${role}]')`;
  await page.eval(`${card(name)}.querySelector('.mcard-choose') || ${card(name)}.querySelector('.mcard-tile.us button.link').click()`);
  await wait(`${name}'s ${role} row`, `!!${row}`);
  await page.eval(`${row}.querySelector('.mcard-choose-more') || ${row}.querySelector(':scope > button.link').click()`);
  await wait(`${name}'s ${role} row to open`, `!!${row}?.querySelector('.mcard-choose-more')`);
  return row;
}

test('Connect a computer is one 3-step modal with one line to paste, and there is no Add machine or Add a CI runner host', { skip }, async () => {
  await openMachines();
  const buttons = await page.eval<string[]>('[...document.querySelectorAll("button")].map((b) => b.textContent)');
  for (const gone of ['Add machine', 'Add a CI runner host']) assert.equal(buttons.includes(gone), false, gone);
  await page.eval('document.querySelector(".machine-connect-toggle, .machine-connect-first").click()');
  await wait('the modal', '!!document.querySelector("dialog.machine-wizard[open]")');
  assert.deepEqual(await page.eval<string[]>('[...document.querySelectorAll(".machine-wizard-steps li")].map((l) => l.dataset.state + " " + l.textContent.replace(/^\\d/, ""))'), ['now Paste one line', "todo What it's for", 'todo Set up']);
  await wait('its line', '[...document.querySelectorAll(".machine-wizard pre")].some((p) => /--join \\w+/.test(p.textContent))');
  assert.equal(await page.eval<number>('[...document.querySelectorAll(".machine-wizard pre")].filter((p) => p.offsetParent).length'), 1, 'one line to paste');
  await page.eval('document.querySelector(".machine-wizard-close").click()');
  await wait('the modal to close', '!document.querySelector("dialog.machine-wizard[open]")');
});

test('a machine lends what is ticked under Choose what it shares from what its agent found, with no new token', { skip }, async () => {
  const { machine: made, token } = (await srv.call('/api/machines', { name: 'tick-box' })).data;
  await srv.call(`/api/machines/${made.id}`, { projects: [projectId] }, 'PATCH');
  mkdirSync(join(dir, 'vault'));
  writeFileSync(join(dir, '.claude.json'), JSON.stringify({ mcpServers: { 'godot-ai': { command: process.execPath, args: [mcpServer], env: { KEY: 'sk-secret-123' } } } }));
  writeFileSync(join(dir, 'machine-agent.json'), JSON.stringify({ workspaces: { vault: { path: join(dir, 'vault') } } }));
  startMachineAgent({ base: srv.base, token, run: ['--config', join(dir, 'machine-agent.json')], env: { CLAUDE_CONFIG_DIR: dir } });
  await until('the agent to report', async () => (await machine('tick-box')).found?.length);
  await openMachines();
  const row = await choose('tick-box', 'tools');
  const boxes = `[...${row}.querySelectorAll('.machine-lends label')]`;
  await wait('its ticks', `${boxes}.length === 2`);
  assert.deepEqual(await page.eval<string[]>(`${boxes}.map((l) => l.textContent + ':' + l.querySelector('input').checked)`), ["godot-ai · from Claude Code's config:false", 'vault:false']);
  assert.doesNotMatch(await page.eval<string>('document.body.textContent'), /sk-secret-123/);
  const saved = ['(l) => l?.server === "godot-ai"', '(l) => !!l?.workspaces.includes("vault")'];
  for (const n of [0, 1]) {
    await page.eval(`${boxes}[${n}].querySelector('input').click()`);
    await wait(`tick ${n} to show`, `${boxes}[${n}]?.querySelector('input').checked === true`);
    // The box ticks at once and its save goes behind (optimistic): wait for the server to hold it, not the box.
    await wait(`tick ${n} to save`, `fetch('api/machines').then((r) => r.json()).then((l) => (${saved[n]})(l.find((m) => m.name === 'tick-box').lend))`);
  }
  await until('tick-box Ready', async () => (await machine('tick-box')).status === 'ready');
  const m = await machine('tick-box');
  assert.deepEqual(m.lend, { server: 'godot-ai', workspaces: ['vault'] });
  assert.equal(await page.eval<boolean>('!!document.querySelector("#machine-setup strong")'), false, 'ticking made no new token to paste');
  assert.equal(m.online, true, 'the agent it was installed with still serves it');
});

test('a machine set up before ticks shows what it lends as set on that computer, with a way to reinstall', { skip }, async () => {
  const { machine: old, token } = (await srv.call('/api/machines', { name: 'old-box' })).data;
  startMachineAgent({ base: srv.base, token });
  await until('the old agent to connect', async () => (await machine('old-box')).online);
  assert.equal((await machine('old-box')).managed, false);
  await openMachines();
  const row = await choose('old-box', 'tools');
  await wait('what it lends', `!!${row}.querySelector('.machine-lends')`);
  const text = await page.eval<string>(`${row}.querySelector('.machine-lends').textContent`);
  assert.match(text, /MCP server: .* · set on that computer/);
  assert.match(text, /Reinstall to manage from here/);
  assert.equal(await page.eval<number>(`${row}.querySelectorAll('.machine-lends input').length`), 0, 'nothing to tick on an agent that takes no ticks');
  // Reinstalling is a new token and the one install line; the confirm says what changes.
  const asked = await page.eval<string>(`(() => { let said = ''; window.confirm = (t) => { said = t; return true; }; [...${row}.querySelectorAll('.machine-lends button')].find((b) => b.textContent === 'Reinstall to manage from here').click(); return said; })()`);
  assert.match(asked, /servers/);
  await wait("old-box's install line", `document.querySelector('#machine-setup strong')?.textContent === 'Connect old-box'`);
  assert.match((await shown())[0], /--config machine-agent\.json --install old-box$/);
  assert.equal((await machine('old-box')).id, old.id, 'reinstalling kept the same machine');
});

test("Who gets it is a list of scheme chips on each role's row under Choose what it shares: a click adds or takes one at once, and it is saved (#438, Build 7 M3)", { skip }, async () => {
  const other = (await srv.call('/api/projects', { name: 'Other scheme' })).data;
  const { machine } = (await srv.call('/api/machines', { name: 'chip-box' })).data;
  await openMachines();
  const tools = await choose('chip-box', 'tools');
  const chips = () => page.eval<string[]>(`[...${tools}.querySelectorAll('.role-schemes .chip[aria-pressed=true]')].map((c) => c.textContent)`);
  const chip = (name: string) => `[...${tools}.querySelectorAll('.role-schemes .chip')].find((c) => c.textContent === ${JSON.stringify(name)})`;
  const saved = async () => (await srv.call(`/api/machines/${machine.id}/roles`)).data.roles.find((r: { role: string }) => r.role === 'tools').projects;
  const savedIs = (n: number) => `fetch('api/machines/${machine.id}/roles').then((r) => r.json()).then((d) => d.roles.find((r) => r.role === 'tools').projects.length === ${n})`;
  // A new machine's Tools and folders is on, lent to no scheme yet: every scheme shows as a chip, none of them on.
  assert.equal(await page.eval(`${tools}.querySelector('.mcard-tick input').checked`), true);
  assert.deepEqual(await page.eval<string[]>(`[...${tools}.querySelectorAll('.role-schemes .chip')].map((c) => c.textContent)`), ['Other scheme', 'P'], "the schemes in the page's order");
  assert.deepEqual(await chips(), []);
  assert.deepEqual(await saved(), []);
  assert.equal(await page.eval(`!!${tools}.querySelector('input[type=radio]')`), false, 'no "every scheme an admin owns" radio');
  // Two picks in a row both count, before either answer is back.
  await page.eval(`${chip('P')}.click(); ${chip('Other scheme')}.click()`);
  assert.deepEqual(await chips(), ['Other scheme', 'P'], 'at once');
  await wait('both to be saved', savedIs(2));
  // The first answer's broadcast can show the list without the second pick for a moment; it comes back with its own.
  await wait('both chips', `${tools}.querySelectorAll('.role-schemes .chip[aria-pressed=true]').length === 2`);
  assert.deepEqual(await chips(), ['Other scheme', 'P']);
  await page.eval(`${chip('P')}.click()`);
  assert.deepEqual(await chips(), ['Other scheme']);
  await wait('the removal to be saved', savedIs(1));
  assert.deepEqual(await saved(), [other.id]);
});

test("its owner renames a computer under Details, so a VM's row can take its Hyper-V VM's name (Build 10 H6)", { skip }, async () => {
  const { machine: m } = (await srv.call('/api/machines', { name: 'rename-box' })).data;
  await openMachines();
  await wait("rename-box's card", `!!${card('rename-box')}`);
  await page.eval(`(() => { const d = ${card('rename-box')}.querySelector('.mcard-details'); d.open = true; d.dispatchEvent(new Event('toggle')); })()`);
  await wait('its Name row', `!!${card('rename-box')}.querySelector('input.machine-rename')`);
  await page.eval(`(() => { const i = ${card('rename-box')}.querySelector('input.machine-rename'); i.value = 'Cara-Desktop'; i.nextElementSibling.click(); })()`);
  await wait('the new name at once', `!!${card('cara-desktop')}`);
  await wait('it to be saved', `fetch('api/machines').then((r) => r.json()).then((l) => l.some((x) => x.id === ${m.id} && x.name === 'cara-desktop'))`);
});

test("a member who is no admin lends their own PC's CI runners to their scheme, not another's (#1933)", { skip }, async () => {
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
    const pc = (await mira('/api/machines', { name: 'mira-pc' })).data.machine;
    await mira(`/api/machines/${pc.id}/roles`, { role: 'ci', on: true, projects: [] }, 'PATCH');
    await page.send('Page.navigate', { url: `${srv.base}/#/p/${mine.id}/machines` });
    await wait('the Machines page', '!!document.querySelector("#machine-list")');
    // Her PC's CI runners are on, and lent to nothing until its owner picks (Build 7 M3).
    const ci = await choose('mira-pc', 'ci');
    assert.equal(await page.eval(`${ci}.querySelector('.mcard-tick input').checked`), true);
    const chips = (sel = '') => page.eval<string[]>(`[...${ci}.querySelectorAll('.role-schemes .chip${sel}')].map((c) => c.textContent)`);
    assert.deepEqual(await chips('[aria-pressed=true]'), [], 'lent to nothing until its owner picks');
    assert.deepEqual(await chips(), ["Mira's"], 'only the schemes she is in');
    await page.eval(`${ci}.querySelector('.role-schemes .chip').click()`);
    await wait('the lend', `${ci}.querySelectorAll('.role-schemes .chip[aria-pressed=true]').length === 1`);
    await wait('the lend to be saved', `fetch('api/machines').then((r) => r.json()).then((l) => l.length === 1 && l[0].projects.length === 1 && l[0].roles.find((r) => r.role === 'ci').projects.length === 1)`);
    assert.deepEqual((await machine('mira-pc')).roles.find((r: { role: string }) => r.role === 'ci').projects, [mine.id]);
    // Another member's machine isn't hers to see or change.
    assert.equal((await machine('mira-pc')).owner_id !== null, true);
    assert.equal((await mira(`/api/machines/${(await machine('chip-box')).id}`, { projects: [] }, 'PATCH')).status, 404);
  } finally {
    await page.send('Network.clearBrowserCookies');
    const [n, v] = srv.cookie.split('=');
    await page.send('Network.setCookie', { name: n, value: v, url: srv.base });
  }
});
