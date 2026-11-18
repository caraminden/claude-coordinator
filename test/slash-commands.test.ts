// Slash commands in the composer (#937): what a turn loaded (runner saveCommands), the line on each
// (src/slash-commands.ts), and the front end's parsing, matching and list (public/slash-commands.js).
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { commandsKey, Runner } from '../src/runner.ts';
import { chatCommands, describe } from '../src/slash-commands.ts';
import { chatCommandList, matchCommands, menuQuery, parseCommand } from '../public/slash-commands.js';

const root = mkdtempSync(join(tmpdir(), 'slash-'));
after(() => rmSync(root, { recursive: true, force: true }));
const store = new Store(join(root, 'test.db'));
const runner = new Runner(store, () => {}, () => ({}), '/bin/false');

test("describe takes a SKILL.md's description up to its first sentence, quoted or folded", () => {
  assert.equal(describe('---\nname: x\ndescription: Grill the user. Use when asked.\n---\nbody'), 'Grill the user.');
  assert.equal(describe('---\ndescription: "Charts: bar, line"\n---\n'), 'Charts: bar, line');
  assert.equal(describe('---\ndescription: >\n  Make a mod: a panel\n  that stays. More.\nname: y\n---\n'), 'Make a mod: a panel that stays.');
  assert.equal(describe('no front matter'), '');
  assert.ok(describe(`---\ndescription: ${'a'.repeat(300)}\n---\n`).length <= 140);
});

test("a turn's init event is kept without terminal and internal commands, and lists each with its line", () => {
  const project = store.createProject('P', null);
  const t = store.createTicket({ project_id: project.id, title: 'M', permission_mode: 'default', created_by: 'Cara' });
  const other = store.createTicket({ project_id: project.id, title: 'N', permission_mode: 'default', created_by: 'Cara' });
  assert.deepEqual(chatCommands(store, t), { loaded: false, commands: [] });
  const kit = join(root, 'kit');
  const cwd = join(root, 'repo');
  mkdirSync(join(kit, 'skills', 'grilling'), { recursive: true });
  writeFileSync(join(kit, 'skills', 'grilling', 'SKILL.md'), '---\ndescription: Grill the user about a plan. More.\n---\n');
  mkdirSync(join(cwd, '.claude', 'skills', 'deploy'), { recursive: true });
  writeFileSync(join(cwd, '.claude', 'skills', 'deploy', 'SKILL.md'), '---\ndescription: Ship it.\n---\n');
  (runner as any).saveCommands(t.id, {
    type: 'system', subtype: 'init', cwd,
    slash_commands: ['citadel:grilling', 'deploy', 'compact', 'statusline', '__remote-workflow', 'mystery', 'citadel:../../etc'],
    terminal_slash_commands: ['statusline'],
    plugins: [{ name: 'citadel', path: kit }, { name: 'builtin-thing', path: 'builtin' }],
  });
  assert.deepEqual(chatCommands(store, t), {
    loaded: true,
    commands: [
      { name: 'citadel:grilling', description: 'Grill the user about a plan.' },
      { name: 'deploy', description: 'Ship it.' },
      { name: 'compact', description: "Compact the session's context to free up room, keeping a summary" },
      { name: 'mystery', description: '' },
      { name: 'citadel:../../etc', description: '' },
    ],
  });
  // A chat with no turn of its own yet takes the scheme's newest list.
  assert.equal(chatCommands(store, other).commands.length, 5);
  assert.deepEqual(store.getSetting<{ plugins: unknown[] }>(commandsKey(t.id))!.plugins, [{ name: 'citadel', path: kit }]);
});

test('parseCommand: a leading /word and the rest; not // nor a path', () => {
  assert.deepEqual(parseCommand('/btw why is it red?'), { name: 'btw', rest: 'why is it red?' });
  assert.deepEqual(parseCommand('/citadel:grilling'), { name: 'citadel:grilling', rest: '' });
  assert.deepEqual(parseCommand('/fresh\n'), { name: 'fresh', rest: '' });
  assert.equal(parseCommand('//btw literal'), null);
  assert.equal(parseCommand('/home/cara/x is broken'), null);
  assert.equal(parseCommand('see /help'), null);
});

test('menuQuery opens only while the box is one /word', () => {
  assert.equal(menuQuery('/'), '');
  assert.equal(menuQuery('/gri'), 'gri');
  assert.equal(menuQuery('/btw '), null);
  assert.equal(menuQuery('hi /x'), null);
  assert.equal(menuQuery('//'), null);
});

test("the list: Citadel's own for the chat's kind lead, matched by name, by the part after plugin:, then anywhere", () => {
  const loaded = [{ name: 'compact', description: '' }, { name: 'citadel:grilling', description: '' }, { name: 'fresh', description: 'theirs' }, { name: 'focus', description: '' }];
  const minion = chatCommandList(loaded, true);
  assert.deepEqual(minion.map((c) => c.name), ['btw', 'fresh', 'help', 'compact', 'citadel:grilling', 'focus']);
  assert.equal(minion.find((c) => c.name === 'fresh')!.citadel, true);
  assert.deepEqual(chatCommandList(loaded, false).map((c) => c.name), ['fresh', 'help', 'compact', 'citadel:grilling', 'focus']);
  assert.deepEqual(matchCommands(minion, 'f').map((c) => c.name), ['fresh', 'focus']);
  assert.deepEqual(matchCommands(minion, 'gri').map((c) => c.name), ['citadel:grilling']);
  assert.deepEqual(matchCommands(minion, 'act').map((c) => c.name), ['compact']);
  assert.equal(matchCommands(minion, '').length, minion.length);
});
