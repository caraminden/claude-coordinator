// The ideas ledger (#1150): a choices page's Later-style picks, the handoffs in the shared folder and the minions
// started from them fold into one row per idea, per scheme; a ship marks it built, and hand edits stick.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { projectSharedDir } from '../src/workspace.ts';
import { bootServer } from './helpers.ts';
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
  assert.equal(handoffIn(`Read ${shared}/../../../etc/handoff-x.md`, shared), null, 'a path that climbs out of the shared folder is no handoff');
});

test('derive: a link beats the pick, a ship makes it built', () => {
  assert.equal(derive({ pick: null, ticket_id: null }, false), 'proposed');
  assert.equal(derive({ pick: 'go', ticket_id: null }, false), 'picked');
  assert.equal(derive({ pick: 'later', ticket_id: null }, false), 'later');
  assert.equal(derive({ pick: 'now', ticket_id: null }, false), 'picked', 'a pick that only starts with no is not a skip (ME4)');
  assert.equal(derive({ pick: 'Notes first', ticket_id: null }, false), 'picked');
  for (const p of ['skipped', 'dropped', 'no_thanks', 'skip_it', 'Cut it', 'not now']) assert.equal(derive({ pick: p, ticket_id: null }, false), 'skipped', p);
  assert.equal(derive({ pick: 'no, later', ticket_id: null }, false), 'skipped');
  assert.equal(derive({ pick: 'cut', ticket_id: null }, false), 'skipped');
  assert.equal(derive({ pick: 'later', ticket_id: 4 }, false), 'started');
  assert.equal(derive({ pick: 'go', ticket_id: 4 }, true), 'built');
});

test('a page, its handoff, a start and a ship fill one row, in a scheme that is not Citadel; hand edits stick', async () => {
  const store = newStore();
  const p = store.createProject('Peek Auras', null);
  const other = store.createProject('Mandate', null);
  const shared = join(root, 'peek-shared');
  mkdirSync(join(shared, 'mockups', 'ideas'), { recursive: true });
  mkdirSync(join(shared, 'handoffs'), { recursive: true });
  const page = join(shared, 'mockups', 'ideas', 'ideas.html');
  writeFileSync(page, "<script>mock.picks({ collection: 'ideas', options: ['go', 'later', 'skip'] });\nmock.picks({ collection: 'takes', options: ['pick'] });</script>");
  const old = new Date(Date.now() - LATER_STALE_MS - 86_400_000).toISOString();
  store.writeArtifactData(
    p.id,
    page,
    [
      { key: 'db/ideas/G3', value: JSON.stringify({ v: 'go', by: 'Josh', at: '2026-11-19T20:00:00Z', note: 'one view of everything' }) },
      { key: 'db/ideas/F7', value: JSON.stringify({ v: 'later', by: 'Josh', at: old }) },
      { key: 'db/takes/A', value: JSON.stringify({ v: 'pick', by: 'Josh', at: old }) },
    ],
    'Josh',
  );
  writeFileSync(join(shared, 'handoffs', 'handoff-ledger.md'), `# Handoff: one ledger (G3)\n\nFrom #12's ideas page, card G3: \`${page}\`.\n`);
  writeFileSync(join(shared, 'handoffs', 'loose.md'), '# Handoff: something with no page\n\nFrom #40.\n');

  store.ideas.readPage(p.id, page, 12, [], 'Picks on "Ideas":\n- G3 One ledger: Build it. "one view of everything"\n- F7 Pick bars: Later');
  await store.ideas.sync(p.id, shared);
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
  await store.ideas.sync(p.id, shared);
  assert.equal(store.ideas.get(g3.id)!.status, 'started');
  assert.equal(store.ideas.get(g3.id)!.ticket_id, t.id);
  store.addEvent(t.id, 'note', { text: 'Shipped abc "x": y. Risk low: z. Live now.' });
  store.ideas.restatus(p.id);
  assert.equal(store.ideas.get(g3.id)!.status, 'built');

  // Hand edits: a status and an unlink stick through later scans.
  const f7 = rows.find((r) => r.card === 'F7')!;
  assert.deepEqual(
    store.ideas.staleLater(p.id).map((r) => r.id),
    [f7.id],
  );
  const note = store.ideas.laterNote(p.id)!;
  assert.match(note, /F7 Pick bars \(from #12\): Later since/);
  assert.equal(store.ideas.laterNote(p.id), null, 'once a week');
  store.ideas.edit(f7.id, 'Josh', { status: 'declined' });
  store.ideas.edit(g3.id, 'Josh', { ticket: null });
  await store.ideas.sync(p.id, shared);
  rows = store.ideas.list(p.id);
  assert.equal(rows.find((r) => r.id === f7.id)!.status, 'declined');
  assert.equal(rows.find((r) => r.id === g3.id)!.ticket_id, null);
  assert.equal(rows.find((r) => r.id === g3.id)!.status, 'picked');
  store.ideas.edit(g3.id, 'Josh', { ticket: 'auto' });
  store.ideas.linkHandoff(p.id, shared, 'handoffs/handoff-ledger.md', t);
  assert.equal(store.ideas.get(g3.id)!.status, 'built');
});

test("a minion merged into a build is built once the build's own minion ships", async () => {
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
  await store.ideas.now(p.id, shared); // the server's first ship scan, paced (#1414); restatus scans by itself after it
  store.addEvent(owner.id, 'note', { text: 'Shipped def "Build 3": done.' });
  store.ideas.restatus(p.id);
  assert.equal(store.ideas.byHandoff(p.id, 'handoffs/feeder.md')!.status, 'built');
});

test('a handoff deleted after its minion started still joins its card, from the copy the minion read', async () => {
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
  await store.ideas.sync(p.id, shared);
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

test('starting a minion through the API from a handoff marks its idea started at once', async () => {
  const s = await bootServer();
  try {
    const { data: p } = await s.call('/api/projects', { name: 'Peek Auras' });
    const shared = projectSharedDir(s.data, p.id);
    mkdirSync(join(shared, 'handoffs'), { recursive: true });
    const abs = join(shared, 'handoffs', 'handoff-footsteps.md');
    writeFileSync(abs, '# Handoff: quieter footsteps\n\nFrom #3.\n');
    assert.equal((await s.call(`/api/projects/${p.id}/ideas`)).data.ideas[0].status, 'proposed');
    const t = await s.call(`/api/projects/${p.id}/tickets`, { title: 'Footsteps', message: `Start from the handoff \`${abs}\`.`, properties: { type: 'feature' } });
    assert.equal(t.status, 201);
    const row = (await s.call(`/api/projects/${p.id}/ideas`)).data.ideas[0];
    assert.equal(row.status, 'started');
    assert.equal(row.minion.number, t.data.number);
  } finally {
    await s.stop();
  }
});

test("a handoff naming its card and source minion, but not the page's path, joins that page's card; one climbing out is refused", async () => {
  const store = newStore();
  const p = store.createProject('Mandate', null);
  const shared = join(root, 'src-shared');
  mkdirSync(join(shared, 'handoffs'), { recursive: true });
  const page = join(shared, 'mockups', 'platform.html');
  store.ideas.readPage(p.id, page, 1093, [], 'Picks on "Platform":\n- A1 Nightly backups: Build it');
  store.ideas.upsert(p.id, page, 'A1', { pick: 'go', decided_by: 'Josh', decided_at: 1, source_number: 1093 });
  writeFileSync(join(shared, 'handoffs', 'apps-nightly-backups.md'), "# Apps write nightly backups\n\nFrom #1093's platform ideas, idea A1. Josh picked Build it.\n");
  await store.ideas.sync(p.id, shared);
  assert.equal(store.ideas.find(p.id, page, 'A1')!.handoff, 'handoffs/apps-nightly-backups.md');
  const t = store.createTicket({ project_id: p.id, title: 'x', permission_mode: 'default', created_by: 'Josh' });
  assert.equal(store.ideas.linkHandoff(p.id, shared, '../outside/handoff.md', t), null);
});

// Loop-lag stalls (#1215): a scan of every message or minion's events per page or per pass froze the server for 30 s.
const counting = (store: Store) => {
  const db = (store.ideas as unknown as { db: { prepare: (s: string) => unknown } }).db;
  const real = db.prepare.bind(db);
  const seen: string[] = [];
  db.prepare = (sql: string) => {
    const st = real(sql) as Record<string, unknown>;
    for (const m of ['get', 'all', 'run']) {
      const f = (st[m] as (...a: unknown[]) => unknown).bind(st);
      st[m] = (...a: unknown[]) => {
        seen.push(sql);
        return f(...a);
      };
    }
    return st;
  };
  return seen;
};

test("a sync reads the scheme's Send messages once, however many untitled pages it has", async () => {
  const store = newStore();
  const p = store.createProject('Mandate', null);
  const shared = join(root, 'once-shared');
  mkdirSync(shared, { recursive: true });
  const t = store.createTicket({ project_id: p.id, title: 'ideas', permission_mode: 'default', created_by: 'Josh' });
  for (const page of ['a.html', 'b.html', 'c.html']) {
    store.addEvent(t.id, 'user_message', { author: 'Josh', text: 'Picks on "X":\n- A1 One: Go', comment: { path: join(shared, 'mockups', page), about: 'X' } });
    store.writeArtifactData(p.id, join(shared, 'mockups', page), [{ key: 'db/ideas', value: '{}' }], 'Josh');
  }
  const seen = counting(store);
  await store.ideas.sync(p.id, shared);
  assert.ok(seen.filter((s) => s.includes('Picks on')).length <= 1, 'one scan of the messages, not one per page');
});

test("restatus rescans a minion's events only when it has new ones, and never once it shipped", async () => {
  const store = newStore();
  const p = store.createProject('Mandate', null);
  const shared = join(root, 'ship-shared');
  mkdirSync(join(shared, 'handoffs'), { recursive: true });
  writeFileSync(join(shared, 'handoffs', 'handoff-x.md'), '# Handoff: x\n');
  const t = store.createTicket({ project_id: p.id, title: 'x', permission_mode: 'default', created_by: 'Josh' });
  store.addEvent(t.id, 'user_message', { author: 'Taskmaster', text: `Start from the handoff \`${shared}/handoffs/handoff-x.md\`.` });
  await store.ideas.sync(p.id, shared);
  const seen = counting(store);
  store.ideas.shippedTickets(p.id);
  const first = seen.filter((s) => s.includes('LIKE')).length;
  store.ideas.shippedTickets(p.id);
  assert.equal(seen.filter((s) => s.includes('LIKE')).length, first, 'no new events, no new LIKE scan');
  store.addEvent(t.id, 'note', { text: 'Shipped abc "x": y.' });
  assert.ok(store.ideas.shippedTickets(p.id).has(t.id));
  const after = seen.filter((s) => s.includes('LIKE')).length;
  store.ideas.shippedTickets(p.id);
  assert.equal(seen.filter((s) => s.includes('LIKE')).length, after, 'a shipped minion is never scanned again');
});

// #1415's stalls (#1414): on today's 2 GB database, one read of every Send held the loop 4-18 s on a cold page cache, and
// the first restatus after a restart read every linked minion's events at once (30.3 s at 01:34 PST, Nov 20).
test('the first Send read goes in ranges of event ids, then only past the last one read', async () => {
  const store = newStore();
  const p = store.createProject('Mandate', null);
  const shared = join(root, 'range-shared');
  mkdirSync(shared, { recursive: true });
  const t = store.createTicket({ project_id: p.id, title: 'ideas', permission_mode: 'default', created_by: 'Josh' });
  mkdirSync(join(shared, 'mockups'), { recursive: true });
  const page = join(shared, 'mockups', 'a.html');
  writeFileSync(page, "<script>mock.picks({ collection: 'ideas', options: ['go', 'later'] });</script>");
  store.addEvent(t.id, 'user_message', { author: 'Josh', text: 'Picks on "X":\n- A1 One: Go', comment: { path: page, about: 'X' } });
  // A database with 65k events already, without writing them all.
  const db = (store.ideas as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => unknown } } }).db;
  db.prepare("INSERT INTO events (id, ticket_id, kind, data, created_at) VALUES (65000, ?, 'note', '{}', ?)").run(t.id, Date.now());
  store.addEvent(t.id, 'user_message', { author: 'Josh', text: 'Picks on "X":\n- A2 Two: Go', comment: { path: page, about: 'X' } });
  store.writeArtifactData(
    p.id,
    page,
    ['A1', 'A2', 'A3'].map((c) => ({ key: `db/ideas/${c}`, value: JSON.stringify({ v: 'go', by: 'Josh', at: '2026-11-20T20:00:00Z' }) })),
    'Josh',
  );
  const ranges: unknown[][] = [];
  const real = (db.prepare as Function).bind(db);
  db.prepare = (sql: string) => {
    const st = real(sql);
    if (!sql.includes('Picks on')) return st;
    const all = st.all.bind(st);
    st.all = (...a: unknown[]) => {
      ranges.push(a);
      return all(...a);
    };
    return st;
  };
  await store.ideas.sync(p.id, shared);
  assert.ok(ranges.length >= 4, `read in ranges, not in one statement: ${JSON.stringify(ranges)}`);
  for (const [lo, hi] of ranges) assert.ok(Number(hi) - Number(lo) <= 20_000, `a range of at most 20k ids: ${lo}..${hi}`);
  assert.deepEqual(
    store.ideas
      .list(p.id)
      .map((r) => r.title)
      .sort(),
    ['A1 One', 'A2 Two', 'A3'],
    'both Sends read; A3 had none yet',
  );
  ranges.length = 0;
  store.addEvent(t.id, 'user_message', { author: 'Josh', text: 'Picks on "X":\n- A3 Three: Go', comment: { path: page, about: 'X' } });
  assert.match(store.ideas.sendsOf(p.id, page).text, /Three[\s\S]*Two[\s\S]*One/, 'newest first, the new one included');
  assert.equal(ranges.length, 1, 'only the events past the last read');
  const moved = store.createProject('Elsewhere', null);
  store.db.prepare('UPDATE tickets SET project_id = ? WHERE id = ?').run(moved.id, t.id);
  assert.equal(store.ideas.sendsOf(p.id, page).text, '', 'a minion moved to another scheme takes its Sends along');
});

test('after a restart, restatus leaves the ship scan to a paced pass instead of reading every linked minion at once', async () => {
  const file = join(root, `db-${++n}.sqlite`);
  const store = new Store(file);
  const p = store.createProject('Mandate', null);
  const shared = join(root, 'restart-shared');
  mkdirSync(join(shared, 'handoffs'), { recursive: true });
  writeFileSync(join(shared, 'handoffs', 'handoff-x.md'), '# Handoff: x\n');
  const t = store.createTicket({ project_id: p.id, title: 'x', permission_mode: 'default', created_by: 'Josh' });
  store.addEvent(t.id, 'user_message', { author: 'Taskmaster', text: `Start from the handoff \`${shared}/handoffs/handoff-x.md\`.` });
  await store.ideas.sync(p.id, shared);
  store.addEvent(t.id, 'note', { text: 'Shipped abc "x": y.' });
  const next = new Store(file);
  const seen = counting(next);
  next.ideas.restatus(p.id);
  assert.equal(seen.filter((s) => s.includes('Shipped')).length, 0, "no ship scan on the request's own turn");
  assert.notEqual(next.ideas.list(p.id)[0].status, 'built', 'not yet');
  await next.ideas.now(p.id, shared);
  assert.equal(next.ideas.list(p.id)[0].status, 'built', 'the paced pass marks it built');
});
