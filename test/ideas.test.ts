// The ideas ledger (#1150): a choices page's Later-style picks, the handoffs in the shared folder and the minions
// started from them fold into one row per idea, per scheme; a ship marks it built, and hand edits stick.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { derive, handoffIn, laterCollections, LATER_STALE_MS, parseHandoff, sendTitles } from '../src/ideas.ts';

const root = mkdtempSync(join(tmpdir(), 'ideas-'));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const newStore = () => new Store(join(root, `db-${++n}.sqlite`));

test('laterCollections finds the pick bars with a Later option, inline or through a named const', () => {
  const html = `<script>
const opts = [{ v: 'go', label: 'Build it' }, { v: 'later', label: 'Later' }, { v: 'skip', label: 'Cut' }];
mock.picks({ collection: 'ideas', options: opts, root: a });
mock.picks({ collection: 'cuts', options: [{ v: 'skip', label: 'Cut' }, { v: 'go', label: 'Build it anyway' }], root: b });
mock.picks({ collection: 'side', options: ['yes', 'later', 'no'] });
mock.picks({ options: ['go', 'later'] });
mock.picks({ collection: \`q-\${id}\`, options: ['later'] });
mock.picks({ collection: 'takes', one: true });
</script>`;
  assert.deepEqual(laterCollections(html).sort(), ['ideas', 'picks', 'side']);
});

test('sendTitles reads titles from a Send, colons and notes included, and skips a line with no title', () => {
  const text = 'Picks on "Ideas":\n- C1 Mechanism first: from rule to hook: Go\n- A5 A scout Grunt: Go. "Is there a way: to cache?"\n- B5 : Skip\n- C10 Ten: Later';
  const t = sendTitles(text, ['C1', 'A5', 'B5', 'C10']);
  assert.equal(t.get('C1'), 'C1 Mechanism first: from rule to hook');
  assert.equal(t.get('A5'), 'A5 A scout Grunt');
  assert.equal(t.get('C10'), 'C10 Ten', 'C1 does not take C10');
  assert.equal(t.has('B5'), false);
});

test('parseHandoff reads the three headers the Nov 19 idea minions wrote', () => {
  const shared = '/data/projects/7/shared/project';
  const a = parseHandoff(`# Handoff: an investigator Grunt (D4)\n\nFrom #1092's ideas page, "How minions work", card D4: \`${shared}/mockups/ideas/ideas.html\`.\n**Pick (Josh, 2026-11-19):** Go on D4.`, shared);
  assert.deepEqual(a, { title: 'an investigator Grunt (D4)', page: `${shared}/mockups/ideas/ideas.html`, card: 'D4', source: 1092 });
  const b = parseHandoff(`# Ship train\n\nHandoff from #1093 (platform ideas). Josh picked "Build it" on the choices page \`mockups/platform-ideas/platform-ideas.html\` (idea S1).`, shared);
  assert.deepEqual(b, { title: 'Ship train', page: `${shared}/mockups/platform-ideas/platform-ideas.html`, card: 'S1', source: 1093 });
  const c = parseHandoff('# Home for all schemes\n\n**Pick (Josh, 2026-11-19 12:38 PST):** H4 "Build it".', shared);
  assert.deepEqual(c, { title: 'Home for all schemes', page: null, card: 'H4', source: null });
});

test('handoffIn finds the handoff a first message starts from, in any of the shapes briefs use', () => {
  const shared = '/data/projects/7/shared/project';
  assert.equal(handoffIn(`Start from the handoff \`${shared}/handoffs/handoff-x.md\`. Read it first.`, shared), 'handoffs/handoff-x.md');
  assert.equal(handoffIn(`**The handoff:** ${shared}/inbox/Peek/thing.md. Relayed.`, shared), 'inbox/Peek/thing.md');
  assert.equal(handoffIn('Build handoffs/platform-ship-train.md plus reports/x.md.', shared), 'handoffs/platform-ship-train.md');
  assert.equal(handoffIn(`Evidence in ${shared}/reports/r.md only.`, shared), null);
  assert.equal(handoffIn('Read /data/projects/9/shared/project/handoffs/theirs.md', shared), null, "another scheme's folder is not ours");
});

test('derive: a link beats the pick, a ship makes it built', () => {
  assert.equal(derive({ pick: null, ticket_id: null }, false), 'proposed');
  assert.equal(derive({ pick: 'go', ticket_id: null }, false), 'picked');
  assert.equal(derive({ pick: 'later', ticket_id: null }, false), 'later');
  assert.equal(derive({ pick: 'cut', ticket_id: null }, false), 'skipped');
  assert.equal(derive({ pick: 'later', ticket_id: 4 }, false), 'started');
  assert.equal(derive({ pick: 'go', ticket_id: 4 }, true), 'built');
});

test('a page, its handoff, a start and a ship fill one row, in a scheme that is not Citadel; hand edits stick', () => {
  const store = newStore();
  const p = store.createProject('Peek Auras', null);
  const other = store.createProject('Mandate', null);
  const shared = join(root, 'peek-shared');
  mkdirSync(join(shared, 'mockups', 'ideas'), { recursive: true });
  mkdirSync(join(shared, 'handoffs'), { recursive: true });
  const page = join(shared, 'mockups', 'ideas', 'ideas.html');
  writeFileSync(page, "<script>mock.picks({ collection: 'ideas', options: ['go', 'later', 'skip'] });\nmock.picks({ collection: 'takes', options: ['pick'] });</script>");
  const old = new Date(Date.now() - LATER_STALE_MS - 86_400_000).toISOString();
  store.writeArtifactData(p.id, page, [
    { key: 'db/ideas/G3', value: JSON.stringify({ v: 'go', by: 'Josh', at: '2026-11-19T20:00:00Z', note: 'one view of everything' }) },
    { key: 'db/ideas/F7', value: JSON.stringify({ v: 'later', by: 'Josh', at: old }) },
    { key: 'db/takes/A', value: JSON.stringify({ v: 'pick', by: 'Josh', at: old }) },
  ], 'Josh');
  writeFileSync(join(shared, 'handoffs', 'handoff-ledger.md'), `# Handoff: one ledger (G3)\n\nFrom #12's ideas page, card G3: \`${page}\`.\n`);
  writeFileSync(join(shared, 'handoffs', 'loose.md'), '# Handoff: something with no page\n\nFrom #40.\n');

  store.ideas.readPage(p.id, page, 12, [], 'Picks on "Ideas":\n- G3 One ledger: Build it. "one view of everything"\n- F7 Pick bars: Later');
  store.ideas.sync(p.id, shared);
  let rows = store.ideas.list(p.id);
  assert.equal(rows.length, 3, 'two picks with Later options and one loose handoff; the takes bar makes none');
  const g3 = rows.find((r) => r.card === 'G3')!;
  assert.equal(g3.title, 'G3 One ledger');
  assert.equal(g3.words, 'one view of everything');
  assert.equal(g3.decided_by, 'Josh');
  assert.equal(g3.handoff, 'handoffs/handoff-ledger.md');
  assert.equal(g3.status, 'picked');
  assert.equal(g3.pick_label, 'Build it');
  assert.equal(rows.find((r) => r.card === 'handoffs/loose.md')?.source_number, 40);
  assert.equal(store.ideas.list(other.id).length, 0, 'per scheme');

  // A minion starts from the handoff: its row is started, then built when it ships.
  const t = store.createTicket({ project_id: p.id, title: 'ledger', permission_mode: 'default', created_by: 'Josh' });
  store.addEvent(t.id, 'user_message', { author: 'Taskmaster', text: `Start from the handoff \`${shared}/handoffs/handoff-ledger.md\`.` });
  store.ideas.sync(p.id, shared);
  assert.equal(store.ideas.get(g3.id)!.status, 'started');
  assert.equal(store.ideas.get(g3.id)!.ticket_id, t.id);
  store.addEvent(t.id, 'note', { text: 'Shipped abc "x": y. Risk low: z. Live now.' });
  store.ideas.restatus(p.id);
  assert.equal(store.ideas.get(g3.id)!.status, 'built');

  // Hand edits: a status and an unlink stick through later scans.
  const f7 = rows.find((r) => r.card === 'F7')!;
  assert.deepEqual(store.ideas.staleLater(p.id).map((r) => r.id), [f7.id]);
  const note = store.ideas.laterNote(p.id)!;
  assert.match(note, /F7 Pick bars \(from #12\): Later since/);
  assert.equal(store.ideas.laterNote(p.id), null, 'once a week');
  store.ideas.edit(f7.id, 'Josh', { status: 'declined' });
  store.ideas.edit(g3.id, 'Josh', { ticket: null });
  store.ideas.sync(p.id, shared);
  rows = store.ideas.list(p.id);
  assert.equal(rows.find((r) => r.id === f7.id)!.status, 'declined');
  assert.equal(rows.find((r) => r.id === g3.id)!.ticket_id, null);
  assert.equal(rows.find((r) => r.id === g3.id)!.status, 'picked');
  store.ideas.edit(g3.id, 'Josh', { ticket: 'auto' });
  store.ideas.linkHandoff(p.id, shared, 'handoffs/handoff-ledger.md', t);
  assert.equal(store.ideas.get(g3.id)!.status, 'built');
});

test("a minion merged into a build is built once the build's own minion ships", () => {
  const store = newStore();
  const p = store.createProject('Mandate', null);
  const shared = join(root, 'mandate-shared');
  mkdirSync(join(shared, 'handoffs'), { recursive: true });
  writeFileSync(join(shared, 'handoffs', 'feeder.md'), '# Handoff: a feeder\n');
  const feeder = store.createTicket({ project_id: p.id, title: 'feeder', permission_mode: 'default', created_by: 'Josh' });
  const owner = store.createTicket({ project_id: p.id, title: 'build 3', permission_mode: 'default', created_by: 'Josh' });
  store.updateTicket(feeder.id, { build: 3 });
  store.setSetting(`build-owner:${p.id}:3`, owner.id);
  store.ideas.linkHandoff(p.id, shared, 'handoffs/feeder.md', feeder);
  store.addEvent(feeder.id, 'note', { text: 'Merged into build/3 …' });
  store.ideas.restatus(p.id);
  assert.equal(store.ideas.byHandoff(p.id, 'handoffs/feeder.md')!.status, 'started');
  store.addEvent(owner.id, 'note', { text: 'Shipped def "Build 3": done.' });
  store.ideas.restatus(p.id);
  assert.equal(store.ideas.byHandoff(p.id, 'handoffs/feeder.md')!.status, 'built');
});

test('a handoff deleted after its minion started still joins its card, from the copy the minion read', () => {
  const store = newStore();
  const p = store.createProject('Peek Auras', null);
  const shared = join(root, 'gone-shared');
  mkdirSync(join(shared, 'handoffs'), { recursive: true });
  const page = join(shared, 'mockups', 'ideas.html');
  store.ideas.readPage(p.id, page, 12, [], 'Picks on "Ideas":\n- B4 Third-fix flag: Go\n- B5 Other: Later');
  store.ideas.upsert(p.id, page, 'B4', { pick: 'go', decided_by: 'Josh', decided_at: 1 });
  const abs = join(shared, 'handoffs', 'handoff-third-fix-flag.md');
  const t = store.createTicket({ project_id: p.id, title: 'Third-fix flag on repeat bug briefs', permission_mode: 'default', created_by: 'Josh' });
  store.addEvent(t.id, 'user_message', { author: 'Taskmaster', text: `Start from the handoff \`${abs}\`.` });
  store.addEvent(t.id, 'claude', { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: abs } }] } });
  store.addEvent(t.id, 'claude', { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: `     1\t# Handoff: third-fix flag (B4)\n     2\t\n     3\tFrom #12's ideas page, card B4: \`${page}\`.` }] } });
  const lone = store.createTicket({ project_id: p.id, title: 'A lost handoff', permission_mode: 'default', created_by: 'Josh' });
  store.addEvent(lone.id, 'user_message', { author: 'Taskmaster', text: `Start from the handoff \`${join(shared, 'handoffs', 'lost.md')}\`.` });
  store.ideas.sync(p.id, shared);
  const b4 = store.ideas.find(p.id, page, 'B4')!;
  assert.equal(b4.handoff, 'handoffs/handoff-third-fix-flag.md');
  assert.equal(b4.ticket_id, t.id);
  assert.equal(b4.status, 'started');
  const lost = store.ideas.byHandoff(p.id, 'handoffs/lost.md')!;
  assert.equal(lost.title, 'A lost handoff');
  assert.equal(lost.ticket_id, lone.id);
});

test('sendsOf finds a Send in any chat of the scheme by the page path, and the minion it went to', () => {
  const store = newStore();
  const p = store.createProject('Mandate', null);
  const page = join(root, 'm-shared', 'mockups', 'ideas.html');
  const t = store.createTicket({ project_id: p.id, title: 'ideas', permission_mode: 'default', created_by: 'Josh' });
  store.addEvent(t.id, 'user_message', { author: 'Josh', text: 'Picks on "Ideas":\n- A1 One: Go', comment: { path: page, about: 'Ideas' } });
  const s = store.ideas.sendsOf(p.id, page);
  assert.match(s.text, /A1 One: Go/);
  assert.equal(s.source, t.number);
});
