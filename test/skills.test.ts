import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Store } from '../src/db.ts';
import type { TicketKind } from '../src/db.ts';
import { KIT_DIR, listSkills, skillTimeline, refreshUsage, cachedUsage, scanSkills, reportFor, forgetUsage, skillDetail, sentenceAround, offSkills, pruneKit, skillDenies, splitDescription, usageFrom } from '../src/skills.ts';
import { bootServer, stopProcs, stopTurns, until, type Booted } from './helpers.ts';

// The Skills page (#1062): the list, the usage walk over a scheme's events, and the per-scheme Off switch.
const root = mkdtempSync(join(tmpdir(), 'skills-'));
const procs: ChildProcess[] = [];
after(async () => {
  await stopProcs(procs);
  await stopTurns(root); // its server's turn supervisor runs in a unit of its own, outliving the server (#1763)
  rmSync(root, { recursive: true, force: true });
});

test('a description splits into what it does and its trigger sentences', () => {
  assert.deepEqual(splitDescription('Reviews a diff. Use when shipping. Also for "how risky is this".'), { what: 'Reviews a diff.', trigger: 'Use when shipping. Also for "how risky is this".' });
  assert.deepEqual(splitDescription('Only when a person asks.'), { what: '', trigger: 'Only when a person asks.' });
  assert.deepEqual(splitDescription('Before shipping your branch: a Grunt reviews the diff. Also for "how risky".'), { what: 'A Grunt reviews the diff.', trigger: 'Before shipping your branch. Also for "how risky".' });
});

test("the list has every kit skill and Grunt type, and a scheme repo's own", () => {
  const repo = join(root, 'repo');
  mkdirSync(join(repo, '.claude', 'skills', 'release-notes'), { recursive: true });
  writeFileSync(join(repo, '.claude', 'skills', 'release-notes', 'SKILL.md'), '---\nname: release-notes\ndescription: Writes notes. Use before a release.\n---\nBody');
  const items = listSkills(KIT_DIR, repo);
  const self = items.find((i) => i.name === 'citadel:self-review')!;
  assert.equal(self.source, 'kit');
  assert.ok(self.trigger.startsWith('Before shipping'), self.trigger);
  assert.ok(items.some((i) => i.kind === 'agent' && i.name === 'citadel:reviewer'));
  assert.deepEqual(
    items.filter((i) => i.source === 'scheme'),
    [{ name: 'release-notes', kind: 'skill', source: 'scheme', slug: 'release-notes', what: 'Writes notes.', trigger: 'Use before a release.' }],
  );
});

test('off names are checked before they reach a path or a rule', async () => {
  assert.deepEqual(offSkills({ skills_off: 'grilling ../etc  self-review' }), ['grilling', 'self-review']);
  assert.deepEqual(skillDenies(['grilling', '../x', 'a b']), ['Skill(citadel:grilling)']);
  const kit = join(root, 'kit');
  for (const s of ['grilling', 'bug-fixing']) mkdirSync(join(kit, 'skills', s), { recursive: true });
  writeFileSync(join(root, 'keep'), '');
  await pruneKit(kit, ['grilling', '../../keep']);
  assert.ok(!existsSync(join(kit, 'skills', 'grilling')));
  assert.ok(existsSync(join(kit, 'skills', 'bug-fixing')));
  assert.ok(existsSync(join(root, 'keep')));
});

// One minion's events as skillTimeline returns them: flags per row, in id order.
const ev = (id: number, over: Partial<{ ticket_id: number; skills: string; agents: string; edit: number; error: number; ship: number; result: number; grunt: number }>) => ({ id, ticket_id: 1, at: id * 1000, skills: null, agents: null, edit: 0, error: 0, ship: 0, result: 0, grunt: 0, ...over });

test("the walk: each run's step of the turn, the Grunts it started, its minion type, and whether the minion shipped after", () => {
  const r = usageFrom(
    {
      events: [
        // Turn 1: a skill before any edit, which starts a Grunt; then an edit, a skill after it, and a ship.
        ev(1, { skills: 'citadel:bug-fixing' }),
        ev(2, { agents: 'citadel:reviewer' }),
        ev(3, { edit: 1 }),
        ev(4, { skills: 'citadel:self-review' }),
        ev(5, { ship: 1 }),
        ev(6, { result: 1 }),
        // Turn 2: an error, then a skill; a Grunt's own error and result don't end or mark the minion's turn.
        ev(7, { error: 1 }),
        ev(8, { skills: 'citadel:diagnosing-bugs' }),
        ev(9, { error: 1, grunt: 1 }),
        ev(10, { result: 1, grunt: 1 }),
        ev(11, { skills: 'citadel:self-review' }),
        ev(12, { result: 1 }),
        // Another minion, no type, never shipped.
        ev(13, { ticket_id: 2, edit: 1 }),
        ev(14, { ticket_id: 2, skills: 'citadel:self-review' }),
        ev(15, { ticket_id: 2, result: 1 }),
      ],
      tickets: [
        { id: 1, project_id: 3, number: 40, title: 'Fix it', kind: 'ticket', type: 'bug', shipped: 5 },
        { id: 2, project_id: 3, number: 41, title: 'Other', kind: 'ticket', type: null, shipped: null },
      ],
    },
    0,
  );
  const self = r.skills['citadel:self-review'];
  assert.equal(self.runs, 3);
  assert.equal(self.minions, 2);
  // Run 4 shipped in its turn; run 11 came after the ship (no ship after it), and so did #41's.
  assert.deepEqual(self.phases, { 'before a ship': 1, 'before any edit': 1, 'after edits': 1 });
  assert.equal(self.shipped, 1);
  assert.deepEqual(self.types, { bug: 2, none: 1 });
  assert.deepEqual(self.typeMinions, { bug: 1, none: 1 }, 'minions, not runs');
  assert.deepEqual(r.active, { bug: 1, none: 1 });
  assert.deepEqual(
    self.last.map((l) => l.number),
    [41, 40, 40],
  );
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
  const use = (name: string, input: object) => ({
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'x' },
        { type: 'tool_use', id: 'tu', name, input },
      ],
    },
  });
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
  assert.deepEqual(
    mine.events.map((e) => [e.skills, e.agents, e.edit, e.error, e.ship, e.result]),
    [
      ['citadel:grilling', null, 0, 0, 0, 0],
      [null, 'general-purpose', 0, 0, 0, 0],
      [null, 'Explore', 0, 0, 0, 0],
      [null, null, 1, 0, 0, 0],
      [null, null, 0, 1, 0, 0],
      [null, null, 0, 0, 1, 0],
      [null, null, 0, 0, 0, 1],
    ],
  );
  assert.equal(mine.tickets.length, 1);
  assert.equal(mine.tickets[0].type, 'feature');
  assert.ok(mine.tickets[0].shipped! > mine.events.at(-1)!.id);
  assert.deepEqual(Object.keys(usageFrom(skillTimeline(store.db, null, 0), 0).skills).sort(), ['citadel:grilling', 'citadel:self-review']);
  assert.equal(skillTimeline(store.db, a.id, Date.now() + 1000).events.length, 0, 'only the window');
  const [one, two] = await Promise.all([refreshUsage(store, a.id), refreshUsage(store, a.id)]);
  assert.equal(one, two, 'one scan for both');
  assert.deepEqual(Object.keys(one.skills), ['citadel:grilling']);
  assert.deepEqual(one.agents['Explore'].types, { feature: 1 });
});

test('an incremental refresh counts exactly what a fresh full scan and the old per-scheme query count', () => {
  forgetUsage();
  const store = new Store(join(root, 'parity.db'));
  const a = store.createProject('PA', null);
  const b = store.createProject('PB', null);
  const mk = (p: number, title: string) => store.createTicket({ project_id: p, title, permission_mode: 'bypassPermissions', created_by: 'Cara', kind: 'ticket' });
  const t = mk(a.id, 'T'),
    u = mk(a.id, 'U'),
    v = mk(b.id, 'V');
  store.props.set('minion', t.id, a.id, { type: 'bug' }, 'Cara');
  const use = (name: string, input: object) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu', name, input }] } });
  const result = { type: 'result', subtype: 'success' };
  const ev = (id: number, d: object) => store.addEvent(id, 'claude', d);
  ev(t.id, use('Skill', { skill: 'citadel:self-review' }));
  ev(t.id, use('Edit', { file_path: '/x' }));
  ev(u.id, use('Skill', { skill: 'citadel:grilling' }));
  ev(v.id, use('Agent', { subagent_type: 'Explore' }));
  const old = ev(v.id, use('Skill', { skill: 'citadel:subagents' }));
  ev(t.id, result);
  const now = Date.now();
  const stamp = () => store.db.prepare('UPDATE events SET created_at = ? + id * 1000 WHERE kind = ?').run(now - 100_000_000, 'claude');
  stamp();
  const first = scanSkills(store.db, 0, null, now);
  const sees = (since: number, scan: ReturnType<typeof scanSkills>, project: number | null) => reportFor(scan.scan, scan.tickets, project, since);
  // Later events: a skill after the edit, then a ship in the same turn turns it (and the earlier run) into "before a ship"; a note of a ship; a new minion.
  ev(t.id, use('Edit', { file_path: '/y' }));
  ev(t.id, use('Skill', { skill: 'citadel:bug-fixing' }));
  ev(t.id, use('mcp__thread__hand_off_land', { summary: 's' }));
  store.addEvent(t.id, 'note', { text: 'Shipped abc' });
  ev(t.id, result);
  ev(u.id, use('Skill', { skill: 'citadel:grilling' }));
  const w = mk(b.id, 'W');
  ev(w.id, use('Skill', { skill: 'citadel:grilling' }));
  stamp();
  const inc = scanSkills(store.db, 0, first.scan, now + 1000);
  const full = scanSkills(store.db, 0, null, now + 1000);
  assert.deepEqual(inc.scan.events, full.scan.events);
  for (const p of [null, a.id, b.id]) {
    assert.deepEqual(sees(0, inc, p), sees(0, full, p));
    assert.deepEqual(sees(0, full, p), usageFrom(skillTimeline(store.db, p, 0), 0), 'the same counts as the per-scheme query');
  }
  assert.equal(sees(0, inc, a.id).skills['citadel:self-review'].phases['before a ship'], undefined, 'self-review ran before the edit, in an earlier turn');
  assert.equal(sees(0, inc, a.id).skills['citadel:bug-fixing'].phases['before a ship'], 1);
  assert.equal(sees(0, inc, a.id).skills['citadel:bug-fixing'].shipped, 1);
  // A window that slides: the run at `old` falls out of it, and the incremental walk drops it as a fresh one never reads it.
  const since = (store.db.prepare('SELECT created_at FROM events WHERE id = ?').get(old.id) as { created_at: number }).created_at;
  const slid = scanSkills(store.db, since, inc.scan, now + 2000);
  const slidFull = scanSkills(store.db, since, null, now + 2000);
  assert.deepEqual(slid.scan.events, slidFull.scan.events);
  assert.deepEqual(sees(since, slid, null), sees(since, slidFull, null));
  assert.equal(sees(since, slid, null).skills['citadel:subagents'], undefined);
  // A full re-read after FULL_SCAN_MS drops what a rewrite or a delete took out of the database.
  store.db.prepare('DELETE FROM events WHERE ticket_id = ? AND kind = ?').run(u.id, 'claude');
  assert.ok(
    scanSkills(store.db, 0, inc.scan, now + 3000).scan.events.some((e) => e.ticket_id === u.id),
    'incremental keeps what it has seen',
  );
  assert.ok(!scanSkills(store.db, 0, inc.scan, now + 7 * 3_600_000).scan.events.some((e) => e.ticket_id === u.id), 'a full re-read does not');
});

test("an opened row: where it ran, its type's rate and misses with what they opened instead, and minions that were told to and never did", () => {
  const store = new Store(':memory:');
  const a = store.createProject('DA', null);
  const b = store.createProject('DB', null);
  const mk = (p: number, title: string, type: string | null, kind: TicketKind = 'ticket') => {
    const t = store.createTicket({ project_id: p, title, permission_mode: 'bypassPermissions', created_by: 'Cara', kind });
    if (type) store.props.set('minion', t.id, p, { type }, 'Cara');
    return t;
  };
  const use = (name: string, input: object) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu', name, input }] } });
  const result = { type: 'result', subtype: 'success' };
  const grill = mk(a.id, 'Grilled', 'feature'),
    told = mk(a.id, 'Told', 'feature'),
    quiet = mk(a.id, 'Quiet', 'feature'),
    bug = mk(a.id, 'Bug', 'bug');
  const tm = mk(a.id, 'Taskmaster', null, 'coordinator'),
    other = mk(b.id, 'Elsewhere', 'feature');
  store.addEvent(told.id, 'user_message', { text: 'Build the page.\nThis is design-shaped. Run citadel:grilling rounds with Josh, as cards. Then citadel:grilling again.' });
  const later = store.addEvent(told.id, 'user_message', { text: 'Still no cards. Open citadel:grilling now.' });
  store.db.prepare('UPDATE events SET created_at = created_at + 1000 WHERE id = ?').run(later.id);
  store.addEvent(tm.id, 'user_message', { text: 'Start a minion that runs citadel:grilling.' });
  store.addEvent(grill.id, 'user_message', { text: 'Use citadel:grilling first.' });
  store.addEvent(grill.id, 'claude', use('Skill', { skill: 'citadel:grilling' }));
  store.addEvent(grill.id, 'claude', use('Edit', { file_path: '/x' }));
  store.addEvent(grill.id, 'claude', use('Skill', { skill: 'citadel:grilling' }));
  store.addEvent(grill.id, 'claude', result);
  store.addEvent(told.id, 'claude', use('Skill', { skill: 'citadel:docs-and-mocks' }));
  store.addEvent(told.id, 'claude', result);
  store.addEvent(quiet.id, 'claude', result);
  store.addEvent(bug.id, 'claude', result);
  store.addEvent(tm.id, 'claude', result);
  store.addEvent(other.id, 'claude', use('Skill', { skill: 'citadel:grilling' }));
  store.addEvent(other.id, 'claude', result);
  const { scan, tickets } = scanSkills(store.db, 0, null);
  assert.deepEqual(
    scan.mentions.filter((m) => m.ticket_id === told.id).map((m) => [m.name, m.quote]),
    [
      ['citadel:grilling', 'Run citadel:grilling rounds with Josh, as cards.'],
      ['citadel:grilling', 'Open citadel:grilling now.'],
    ],
    'once per message',
  );
  const d = skillDetail(scan, tickets, a.id, 0, 'citadel:grilling', 'skill');
  assert.deepEqual(
    d.used.map((u) => [u.title, u.runs, u.phases]),
    [['Grilled', 2, { 'before any edit': 1, 'after edits': 1 }]],
    'only this scheme',
  );
  assert.deepEqual(
    d.types,
    [
      { type: 'feature', active: 3, opened: 1 },
      { type: 'bug', active: 1, opened: 0 },
    ],
    'the Taskmaster is no minion of a type',
  );
  assert.equal(d.misses!.type, 'feature');
  assert.equal(d.misses!.total, 2);
  assert.deepEqual(d.misses!.rows.map((r) => [r.title, r.opened]).sort(), [
    ['Quiet', []],
    ['Told', ['citadel:docs-and-mocks']],
  ]);
  assert.deepEqual(
    d.named.rows.map((r) => [r.title, r.quote, r.at]),
    [['Told', 'Open citadel:grilling now.', later.created_at + 1000]],
    'one row a minion, with its newest message; not the Taskmaster, not a minion that opened it',
  );
  const never = skillDetail(scan, tickets, a.id, 0, 'citadel:upstream-check', 'skill');
  assert.equal(never.misses, null, 'no type to miss in when nothing opened it');
  assert.deepEqual(never.used, []);
  assert.equal(skillDetail(scan, tickets, null, 0, 'citadel:grilling', 'skill').used.length, 2, 'every scheme');
  assert.equal(sentenceAround('One. Two citadel:x three. Four.', 9), 'Two citadel:x three.');
});

test('cachedUsage answers from the last report at once and never waits on a scan', async () => {
  forgetUsage();
  const store = new Store(':memory:');
  const a = store.createProject('CU', null);
  const t = store.createTicket({ project_id: a.id, title: 'T', permission_mode: 'bypassPermissions', created_by: 'Cara', kind: 'ticket' });
  store.addEvent(t.id, 'claude', { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x', name: 'Skill', input: { skill: 'citadel:grilling' } }] } });
  const t0 = Date.now();
  assert.equal(cachedUsage(store, a.id, t0), null, 'no report before the first scan');
  const first = await refreshUsage(store, a.id, t0);
  assert.equal(cachedUsage(store, a.id, t0), first);
  // Stale: the old report is served and a refresh starts behind it.
  assert.equal(cachedUsage(store, a.id, t0 + 11 * 60_000), first);
  const next = await refreshUsage(store, a.id, t0 + 11 * 60_000);
  assert.notEqual(next, first);
  assert.deepEqual(next.skills['citadel:grilling'].runs, 1);
});

let base = '';
let cookie = '';
let srv: Booted;
const call = (path: string, opts: { method?: string; body?: unknown } = {}) => srv.call(path, opts.body || undefined, opts.method ?? 'GET');

before(async () => {
  srv = await bootServer({ root: join(root, 'srv'), stdout: true });
  base = srv.base;
  cookie = srv.cookie;
  procs.push(srv.proc);
});

test('the page lists the skills, and a member turns a kit skill off and on, with a note to the Taskmaster', async () => {
  const { data: p } = await call('/api/projects', { method: 'POST', body: { name: 'Skills scheme' } });
  await call(`/api/projects/${p.id}`); // opening the page makes its Taskmaster
  const page = await call(`/api/projects/${p.id}/skills`);
  assert.equal(page.status, 200);
  assert.ok(page.data.items.some((i: { name: string }) => i.name === 'citadel:self-review'));
  assert.deepEqual(page.data.off, []);
  // The list never carries a scan's wait: its usage is the last report or null, and /skills/usage is where the counts come from.
  assert.ok(page.data.usage === null || typeof page.data.usage.skills === 'object');
  const counts = await call(`/api/projects/${p.id}/skills/usage`);
  assert.equal(counts.status, 200);
  assert.equal(typeof counts.data.usage.skills, 'object');
  assert.equal(typeof counts.data.since, 'number');
  assert.equal(counts.data.all, false);
  const detail = await call(`/api/projects/${p.id}/skills/detail?name=citadel:grilling&kind=skill`);
  assert.equal(detail.status, 200);
  assert.deepEqual([detail.data.used, detail.data.misses, detail.data.named.total], [[], null, 0]);
  assert.equal((await call(`/api/projects/${p.id}/skills/detail?name=../x&kind=skill`)).status, 400);
  assert.equal((await call(`/api/projects/${p.id}/skills/detail?name=citadel:grilling&kind=x`)).status, 400);
  assert.match(page.data.warnings['self-review'], /every ship in this scheme waits for a person's go/);
  assert.equal((await call(`/api/projects/${p.id}`, { method: 'PATCH', body: { skills_off: ['not-a-skill'] } })).status, 400);
  assert.equal((await call(`/api/projects/${p.id}`, { method: 'PATCH', body: { skills_off: 'grilling' } })).status, 400);
  const off = await call(`/api/projects/${p.id}`, { method: 'PATCH', body: { skills_off: ['self-review', 'grilling', 'grilling'] } });
  assert.equal(off.status, 200);
  assert.equal(off.data.skills_off, 'grilling self-review');
  assert.deepEqual((await call(`/api/projects/${p.id}/skills`)).data.off, ['grilling', 'self-review']);
  await call(`/api/projects/${p.id}`, { method: 'PATCH', body: { skills_off: ['grilling'] } });
  const { data: again } = await call(`/api/projects/${p.id}`);
  const notes = (await call(`/api/tickets/${again.coordinator.id}/events?after=0`)).data.map((e: { data: string }) => JSON.parse(e.data).text);
  assert.ok(notes.includes("Cara turned off citadel:grilling, citadel:self-review on the Skills page. It applies from each minion's next turn."), notes.join('\n'));
  assert.ok(notes.includes("Cara turned back on citadel:self-review on the Skills page. It applies from each minion's next turn."));
});

test("+ New skill starts a minion with the edited brief as its first message (the dialog's request)", async () => {
  const { data: p } = await call('/api/projects', { method: 'POST', body: { name: 'New skill scheme' } });
  const brief = "Build a new skill, `weekly-digest`, in this scheme's repo, as .claude/skills/weekly-digest/SKILL.md.\n\nOpen `citadel:writing-for-agents` first and follow it.";
  const made = await call(`/api/projects/${p.id}/tickets`, { method: 'POST', body: { title: 'New skill: weekly-digest', message: brief, properties: { type: 'feature' } } });
  assert.equal(made.status, 201);
  await until('the first turn to end', async () => (await call(`/api/tickets/${made.data.id}`)).data.ticket.status !== 'running');
  const { data } = await call(`/api/tickets/${made.data.id}`);
  assert.equal(data.ticket.title, 'New skill: weekly-digest');
  assert.equal(data.ticket.properties.type, 'feature');
  const events = (await call(`/api/tickets/${made.data.id}/events?after=0`)).data;
  assert.equal(JSON.parse(events.find((e: { kind: string; data: string }) => e.kind === 'user_message').data).text, brief);
});
