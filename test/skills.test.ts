import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Store } from '../src/db.ts';
import { KIT_DIR, listSkills, skillTimeline, skillUsage, offSkills, pruneKit, skillDenies, splitDescription, usageFrom } from '../src/skills.ts';
import { bootServer, stopProcs } from './helpers.ts';

// The Skills page (#1062): the list, the usage walk over a scheme's events, and the per-scheme Off switch.
const root = mkdtempSync(join(tmpdir(), 'skills-'));
const procs: ChildProcess[] = [];
after(async () => {
  await stopProcs(procs);
  rmSync(root, { recursive: true, force: true });
});

test('a description splits into what it does and its trigger sentences', () => {
  assert.deepEqual(splitDescription('Reviews a diff. Use when shipping. Also for "how risky is this".'), { what: 'Reviews a diff.', trigger: 'Use when shipping. Also for "how risky is this".' });
  assert.deepEqual(splitDescription('Only when a person asks.'), { what: '', trigger: 'Only when a person asks.' });
});

test('the list has every kit skill and Grunt type, and a scheme repo\'s own', () => {
  const repo = join(root, 'repo');
  mkdirSync(join(repo, '.claude', 'skills', 'release-notes'), { recursive: true });
  writeFileSync(join(repo, '.claude', 'skills', 'release-notes', 'SKILL.md'), '---\nname: release-notes\ndescription: Writes notes. Use before a release.\n---\nBody');
  const items = listSkills(KIT_DIR, repo);
  const self = items.find((i) => i.name === 'citadel:self-review')!;
  assert.equal(self.source, 'kit');
  assert.ok(self.trigger.startsWith('Use') || self.trigger.startsWith('Also'), self.trigger);
  assert.ok(items.some((i) => i.kind === 'agent' && i.name === 'citadel:reviewer'));
  assert.deepEqual(items.filter((i) => i.source === 'scheme'), [{ name: 'release-notes', kind: 'skill', source: 'scheme', slug: 'release-notes', what: 'Writes notes.', trigger: 'Use before a release.' }]);
});

test('off names are checked before they reach a path or a rule', () => {
  assert.deepEqual(offSkills({ skills_off: 'grilling ../etc  self-review' }), ['grilling', 'self-review']);
  assert.deepEqual(skillDenies(['grilling', '../x', 'a b']), ['Skill(citadel:grilling)']);
  const kit = join(root, 'kit');
  for (const s of ['grilling', 'bug-fixing']) mkdirSync(join(kit, 'skills', s), { recursive: true });
  writeFileSync(join(root, 'keep'), '');
  pruneKit(kit, ['grilling', '../../keep']);
  assert.ok(!existsSync(join(kit, 'skills', 'grilling')));
  assert.ok(existsSync(join(kit, 'skills', 'bug-fixing')));
  assert.ok(existsSync(join(root, 'keep')));
});

// One minion's events as skillTimeline returns them: flags per row, in id order.
const ev = (id: number, over: Partial<{ ticket_id: number; skills: string; agents: string; edit: number; error: number; ship: number; result: number; grunt: number }>) =>
  ({ id, ticket_id: 1, at: id * 1000, skills: null, agents: null, edit: 0, error: 0, ship: 0, result: 0, grunt: 0, ...over });

test('the walk: each run\'s step of the turn, the Grunts it started, its minion type, and whether the minion shipped after', () => {
  const r = usageFrom({
    events: [
      // Turn 1: a skill before any edit, which starts a Grunt; then an edit, a skill after it, and a ship.
      ev(1, { skills: 'citadel:bug-fixing' }), ev(2, { agents: 'citadel:reviewer' }), ev(3, { edit: 1 }),
      ev(4, { skills: 'citadel:self-review' }), ev(5, { ship: 1 }), ev(6, { result: 1 }),
      // Turn 2: an error, then a skill; a Grunt's own error and result don't end or mark the minion's turn.
      ev(7, { error: 1 }), ev(8, { skills: 'citadel:diagnosing-bugs' }), ev(9, { error: 1, grunt: 1 }), ev(10, { result: 1, grunt: 1 }),
      ev(11, { skills: 'citadel:self-review' }), ev(12, { result: 1 }),
      // Another minion, no type, never shipped.
      ev(13, { ticket_id: 2, edit: 1 }), ev(14, { ticket_id: 2, skills: 'citadel:self-review' }), ev(15, { ticket_id: 2, result: 1 }),
    ],
    tickets: [
      { id: 1, project_id: 3, number: 40, title: 'Fix it', kind: 'ticket', type: 'bug', shipped: 5 },
      { id: 2, project_id: 3, number: 41, title: 'Other', kind: 'ticket', type: null, shipped: null },
    ],
  }, 0);
  const self = r.skills['citadel:self-review'];
  assert.equal(self.runs, 3);
  assert.equal(self.minions, 2);
  // Run 4 shipped in its turn; run 11 came after the ship (no ship after it), and so did #41's.
  assert.deepEqual(self.phases, { 'before a ship': 1, 'before any edit': 1, 'after edits': 1 });
  assert.equal(self.shipped, 1);
  assert.deepEqual(self.types, { bug: 2, none: 1 });
  assert.deepEqual(self.last.map((l) => l.number), [41, 40, 40]);
  assert.deepEqual(r.skills['citadel:bug-fixing'].phases, { 'before any edit': 1 });
  assert.deepEqual(r.skills['citadel:bug-fixing'].with, { 'citadel:reviewer': 1 });
  assert.deepEqual(r.agents['citadel:reviewer'].with, { 'citadel:bug-fixing': 1 });
  assert.deepEqual(r.skills['citadel:diagnosing-bugs'].phases, { 'after an error': 1 });
});

test('skillTimeline reads Skill and Agent calls, edits, errors, ships and turn ends from the stored stream, one scheme or all, on a worker thread for a database file', async () => {
  const store = new Store(join(root, 'timeline.db'));
  const a = store.createProject('A', null);
  const b = store.createProject('B', null);
  const t = store.createTicket({ project_id: a.id, title: 'T', permission_mode: 'bypassPermissions', created_by: 'Cara', kind: 'ticket' });
  const u = store.createTicket({ project_id: b.id, title: 'U', permission_mode: 'bypassPermissions', created_by: 'Cara', kind: 'ticket' });
  store.props.set('minion', t.id, a.id, { type: 'feature' }, 'Cara');
  const use = (name: string, input: object) => ({ type: 'assistant', message: { content: [{ type: 'text', text: 'x' }, { type: 'tool_use', id: 'tu', name, input }] } });
  store.addEvent(t.id, 'claude', use('Skill', { skill: 'citadel:grilling' }));
  store.addEvent(t.id, 'claude', use('Agent', { description: 'd', prompt: 'p' }));
  store.addEvent(t.id, 'claude', use('Agent', { subagent_type: 'Explore', prompt: 'p' }));
  store.addEvent(t.id, 'claude', { type: 'assistant', message: { content: [{ type: 'text', text: 'chat that names "name":"Edit" is no edit' }] } });
  store.addEvent(t.id, 'claude', use('Edit', { file_path: '/x' }));
  store.addEvent(t.id, 'claude', { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu', is_error: true, content: 'no' }] } });
  store.addEvent(t.id, 'claude', use('mcp__thread__hand_off_land', { summary: 's' }));
  store.addEvent(t.id, 'claude', { type: 'result', subtype: 'success' });
  store.addEvent(t.id, 'note', { text: 'Shipped abc' });
  store.addEvent(u.id, 'claude', use('Skill', { skill: 'citadel:self-review' }));
  const mine = skillTimeline(store.db, a.id, 0);
  assert.deepEqual(mine.events.map((e) => [e.skills, e.agents, e.edit, e.error, e.ship, e.result]), [
    ['citadel:grilling', null, 0, 0, 0, 0], [null, 'general-purpose', 0, 0, 0, 0], [null, 'Explore', 0, 0, 0, 0],
    [null, null, 1, 0, 0, 0], [null, null, 0, 1, 0, 0], [null, null, 0, 0, 1, 0], [null, null, 0, 0, 0, 1]]);
  assert.equal(mine.tickets.length, 1);
  assert.equal(mine.tickets[0].type, 'feature');
  assert.ok(mine.tickets[0].shipped! > mine.events.at(-1)!.id);
  assert.deepEqual(Object.keys(usageFrom(skillTimeline(store.db, null, 0), 0).skills).sort(), ['citadel:grilling', 'citadel:self-review']);
  assert.equal(skillTimeline(store.db, a.id, Date.now() + 1000).events.length, 0, 'only the window');
  const [one, two] = await Promise.all([skillUsage(store, a.id), skillUsage(store, a.id)]);
  assert.equal(one, two, 'one scan for both');
  assert.deepEqual(Object.keys(one.skills), ['citadel:grilling']);
  assert.deepEqual(one.agents['Explore'].types, { feature: 1 });
});

let base = '';
let cookie = '';
async function call(path: string, opts: { method?: string; body?: unknown } = {}) {
  const res = await fetch(base + path, { method: opts.method ?? 'GET', headers: { Cookie: cookie, ...(opts.body ? { 'Content-Type': 'application/json' } : {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  return { status: res.status, data: await res.json() };
}

before(async () => {
  const srv = await bootServer({ root: join(root, 'srv'), stdout: true });
  base = srv.base;
  cookie = srv.cookie;
  procs.push(srv.proc);
});

test('the page lists the skills, and a member turns a kit skill off and on, with a note to the Taskmaster', async () => {
  const { data: p } = await call('/api/projects', { method: 'POST', body: { name: 'Skills scheme' } });
  await call(`/api/projects/${p.id}`); // opening the page makes its Taskmaster
  const page = await call(`/api/projects/${p.id}/skills`);
  assert.equal(page.status, 200);
  assert.ok(page.data.items.some((i: any) => i.name === 'citadel:self-review'));
  assert.deepEqual(page.data.off, []);
  assert.match(page.data.warnings['self-review'], /every ship in this scheme waits for a person's go/);
  assert.equal((await call(`/api/projects/${p.id}`, { method: 'PATCH', body: { skills_off: ['not-a-skill'] } })).status, 400);
  assert.equal((await call(`/api/projects/${p.id}`, { method: 'PATCH', body: { skills_off: 'grilling' } })).status, 400);
  const off = await call(`/api/projects/${p.id}`, { method: 'PATCH', body: { skills_off: ['self-review', 'grilling', 'grilling'] } });
  assert.equal(off.status, 200);
  assert.equal(off.data.skills_off, 'grilling self-review');
  assert.deepEqual((await call(`/api/projects/${p.id}/skills`)).data.off, ['grilling', 'self-review']);
  await call(`/api/projects/${p.id}`, { method: 'PATCH', body: { skills_off: ['grilling'] } });
  const { data: again } = await call(`/api/projects/${p.id}`);
  const notes = (await call(`/api/tickets/${again.coordinator.id}/events?after=0`)).data.map((e: any) => JSON.parse(e.data).text);
  assert.ok(notes.includes('Cara turned off citadel:grilling, citadel:self-review on the Skills page. It applies from each minion\'s next turn.'), notes.join('\n'));
  assert.ok(notes.includes('Cara turned back on citadel:self-review on the Skills page. It applies from each minion\'s next turn.'));
});
