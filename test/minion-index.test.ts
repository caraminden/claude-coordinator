// Search over past minions (#1156): what a closed minion leaves in the index, when it gets there, and that a
// search never crosses schemes.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { ftsQuery, heredocTargets, shortPath } from '../src/minion-index.ts';
import { projectSharedDir } from '../src/workspace.ts';
import { agentToken, bootServer, until } from './helpers.ts';

const root = mkdtempSync(join(tmpdir(), 'minion-index-'));
after(() => rmSync(root, { recursive: true, force: true }));

const text = (t: string, extra: object = {}) => ({ type: 'assistant', message: { content: [{ type: 'text', text: t }] }, ...extra });
const tool = (name: string, input: object) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_x', name, input }] } });

/** A minion that seeds a dev copy with a heredoc script and edits a repo file, then closes. */
function seeder(store: Store, project: number, title: string, close = true) {
  const t = store.createTicket({ project_id: project, title, permission_mode: 'default', created_by: 'Cara' });
  const wt = `/home/x/.local/share/claude-coordinator/projects/${project}/tickets/${t.id}`;
  const tmp = `/home/x/.local/share/claude-coordinator/projects/${project}/tmp/${t.id}`;
  store.addEvent(t.id, 'user_message', { author: 'Cara', text: 'Show the waiting card on the phone page' });
  store.addEvent(t.id, 'claude', tool('Bash', { command: `cat > $TMPDIR/seed.ts <<'EOF'\nimport { Store } from './db.ts'\nEOF\nnode $TMPDIR/seed.ts` }));
  store.addEvent(t.id, 'claude', tool('Bash', { command: 'grep -n seed src/db.ts' }));
  store.addEvent(t.id, 'claude', tool('Write', { file_path: `${tmp}/drive.mjs`, content: 'x' }));
  store.addEvent(t.id, 'claude', tool('Edit', { file_path: `${wt}/public/phone.js`, old_string: 'a', new_string: 'b' }));
  store.addEvent(t.id, 'claude', text('A Grunt mumbles pineapples', { parent_tool_use_id: 'toolu_x' }));
  store.addEvent(t.id, 'claude', text('Wrote a seed script for the dev copy; the card shows now.'));
  if (close) store.updateTicket(t.id, { status: 'closed' });
  return store.getTicket(t.id)!;
}

test('paths, heredocs and queries', () => {
  assert.equal(shortPath('/h/.local/share/claude-coordinator/projects/2/tickets/99/src/db.ts'), 'src/db.ts');
  assert.equal(shortPath('/h/.local/share/claude-coordinator/projects/2/tmp/99/seed.ts'), '$TMPDIR/seed.ts');
  assert.equal(shortPath('/h/.local/share/claude-coordinator/projects/2/shared/project/handoffs/h.md'), 'shared/handoffs/h.md');
  assert.equal(shortPath('"$TMPDIR/seed.ts"'), '$TMPDIR/seed.ts');
  assert.deepEqual(heredocTargets(`cat > "$TMPDIR/a.ts" <<'EOF'\nx\nEOF\ntee -a b.sh <<EOF\ncat >> c.md<<X\ncat a.ts > d.ts`), ['$TMPDIR/a.ts', 'b.sh', 'c.md']);
  assert.equal(ftsQuery('Seed  script seed'), '"seed" "script"');
  assert.equal(ftsQuery('a b', true), '"a" OR "b"');
  assert.equal(ftsQuery('NEAR( * " OR -'), '"near" "or"', 'operators and quotes never reach MATCH');
});

test('a closed minion is indexed with its brief, last words and the files it wrote; open ones and other schemes are not', () => {
  const store = new Store(join(root, 'one.db'));
  const A = store.createProject('A', null);
  const B = store.createProject('B', null);
  const done = seeder(store, A.id, 'Waiting card on phones');
  store.props.set('minion', done.id, A.id, { type: 'feature' }, 'Cara');
  const open = seeder(store, A.id, 'Still seeding', false);
  const other = seeder(store, B.id, 'B seeds too');
  const unrelated = store.createTicket({ project_id: A.id, title: 'Usage bar colours', permission_mode: 'default', created_by: 'Cara' });
  store.updateTicket(unrelated.id, { status: 'closed' });

  assert.equal(store.minionIndex.indexClosed(A.id), 2);
  assert.equal(store.minionIndex.indexClosed(A.id), 0, 'nothing new: no rebuild');
  const hits = store.minionIndex.search(A.id, 'seed script') as any[];
  assert.deepEqual(hits.map((h) => h.number), [done.number], 'not the open minion, not B\'s');
  assert.equal(hits[0].type, 'feature');
  assert.deepEqual(hits[0].files.split('\n'), ['$TMPDIR/seed.ts', '$TMPDIR/drive.mjs', 'public/phone.js']);
  assert.ok(!JSON.stringify(store.db.prepare('SELECT * FROM minion_index').all()).includes('pineapples'), 'a Grunt\'s words stay out');
  // A path finds it, and so does the brief.
  assert.equal((store.minionIndex.search(A.id, 'public/phone.js') as any[])[0]?.number, done.number);
  assert.equal((store.minionIndex.search(A.id, 'waiting card phone page') as any[])[0]?.number, done.number);
  // Any word fills up after every word: "usage" alone finds the other.
  assert.deepEqual((store.minionIndex.search(A.id, 'seed usage') as any[]).map((h) => h.number).sort(), [done.number, unrelated.number].sort());
  // Empty: the newest closed first.
  assert.deepEqual((store.minionIndex.search(A.id, '') as any[]).map((h) => h.number), [unrelated.number, done.number]);

  // Closing the open one indexes it on the next call; reopening and closing again replaces its row.
  store.updateTicket(open.id, { status: 'closed' });
  assert.equal(store.minionIndex.indexClosed(A.id), 1);
  store.updateTicket(open.id, { status: 'idle' });
  store.updateTicket(open.id, { title: 'Seeding, renamed' });
  store.updateTicket(open.id, { status: 'closed' });
  assert.equal(store.minionIndex.indexClosed(A.id), 1);
  assert.deepEqual((store.minionIndex.search(A.id, 'renamed') as any[]).map((h) => h.title), ['Seeding, renamed']);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM minion_index WHERE rowid = ?').get(open.id)!.n, 1);

  // A transcript that breaks the indexer is skipped; the next closed minion still gets in.
  const bad = store.createTicket({ project_id: A.id, title: 'Broken transcript', permission_mode: 'default', created_by: 'Cara' });
  store.updateTicket(bad.id, { status: 'closed' });
  const after = seeder(store, A.id, 'Closed after the broken one');
  const index = store.minionIndex as any;
  const real = index.indexTicket;
  index.indexTicket = function (p: number, t: { id: number }) {
    if (t.id === bad.id) throw new Error('bad json');
    return real.call(this, p, t);
  };
  const quiet = console.error;
  console.error = () => {};
  try {
    assert.equal(store.minionIndex.indexClosed(A.id), 2);
  } finally {
    console.error = quiet;
    index.indexTicket = real;
  }
  assert.equal(store.minionIndex.indexClosed(A.id), 0, 'the broken one is not retried');
  assert.ok((store.minionIndex.search(A.id, 'closed after broken') as any[]).some((h) => h.ticket_id === after.id));

  // since: only minions closed on or after it.
  assert.deepEqual(store.minionIndex.search(A.id, 'seed', { since: Date.now() + 60_000 }), []);

  // B's own search sees B's.
  store.minionIndex.indexClosed(B.id);
  assert.deepEqual((store.minionIndex.search(B.id, 'seed script') as any[]).map((h) => h.ticket_id), [other.id]);

  store.deleteTicket(done.id);
  assert.ok(!(store.minionIndex.search(A.id, 'phone') as any[]).some((h) => h.ticket_id === done.id), 'a deleted minion leaves the index');
  store.db.close();
});

test('handoffs: in when written, changed when edited, out when deleted', async () => {
  const store = new Store(join(root, 'two.db'));
  const A = store.createProject('A', null);
  const data = join(root, 'data');
  const dir = join(projectSharedDir(data, A.id), 'handoffs');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'handoff-scout.md');
  writeFileSync(file, '# Handoff: a scout Grunt\nSearch past minions.');
  await store.minionIndex.syncHandoffs(A.id, data);
  assert.deepEqual((store.minionIndex.search(A.id, 'scout') as any[]).map((h) => [h.kind, h.name]), [['handoff', 'handoff-scout.md']]);
  writeFileSync(file, '# Handoff: a lookout\nNothing else.');
  const later = new Date(Date.now() + 5000);
  utimesSync(file, later, later);
  await store.minionIndex.syncHandoffs(A.id, data);
  assert.deepEqual(store.minionIndex.search(A.id, 'grunt'), [], 'the old text is gone');
  assert.equal((store.minionIndex.search(A.id, 'lookout') as any[]).length, 1);
  unlinkSync(file);
  await store.minionIndex.syncHandoffs(A.id, data);
  assert.deepEqual(store.minionIndex.search(A.id, 'lookout'), []);
  store.db.close();
});

test('handoffs (#1463): a pass that finds nothing changed touches no table, a file filed into shipped/ is found (in the same mtime tick too, #1483), and a fresh index picks up the rows', async () => {
  const db = join(root, 'three.db');
  const store = new Store(db);
  const A = store.createProject('A', null);
  const data = join(root, 'data-three');
  const dir = join(projectSharedDir(data, A.id), 'handoffs');
  mkdirSync(join(dir, 'shipped'), { recursive: true });
  writeFileSync(join(dir, 'live.md'), '# Handoff: walrus');
  writeFileSync(join(dir, 'shipped', 'old.md'), '# Handoff: narwhal');
  const minuteAgo = new Date(Date.now() - 60_000);
  utimesSync(join(dir, 'shipped'), minuteAgo, minuteAgo); // a folder that settled a while ago: its mtime alone says whether it changed
  const has = await store.minionIndex.syncHandoffs(A.id, data);
  assert.ok(has('handoffs/live.md') && has('handoffs/shipped/old.md') && !has('handoffs/old.md'));
  const prepare = store.db.prepare.bind(store.db);
  let sql = 0;
  (store.db as any).prepare = (q: string) => (sql++, prepare(q));
  await store.minionIndex.syncHandoffs(A.id, data);
  assert.equal(sql, 0, 'nothing changed: no statement prepared');
  // The tidy moves a live handoff into shipped/ (a rename keeps its mtime): the filed folder's own mtime moved, so it is listed again.
  renameSync(join(dir, 'live.md'), join(dir, 'shipped', 'live.md'));
  // That pass looks in the same ms as the rename, whatever pauses a loaded box adds between them (#1483).
  const filedMs = Math.floor(statSync(join(dir, 'shipped')).mtimeMs);
  const realNow = Date.now;
  Date.now = () => filedMs;
  let after: (rel: string) => boolean;
  try {
    after = await store.minionIndex.syncHandoffs(A.id, data);
  } finally {
    Date.now = realNow;
  }
  (store.db as any).prepare = prepare;
  assert.ok(sql > 0);
  assert.ok(after('handoffs/shipped/live.md') && !after('handoffs/live.md'));
  assert.deepEqual((store.minionIndex.search(A.id, 'walrus') as any[]).map((h) => h.name), ['shipped/live.md']);
  assert.deepEqual((store.minionIndex.search(A.id, 'narwhal') as any[]).map((h) => h.name), ['shipped/old.md']);
  // #1483: a second file filed in the same mtime tick as that listing (a coarse clock, a 1 s filesystem) leaves the
  // folder's mtime where the pass saw it; putting it back pins that case. A folder listed moments after a change is listed again.
  writeFileSync(join(dir, 'shipped', 'late.md'), '# Handoff: dugong');
  utimesSync(join(dir, 'shipped'), filedMs / 1000, filedMs / 1000); // seconds from the ms the pass saw (a Date rounds, the pass floors)
  assert.ok((await store.minionIndex.syncHandoffs(A.id, data))('handoffs/shipped/late.md'), 'filed in the same tick, still found');
  // A restart: the new Store reads the rows once and rewrites none of them.
  store.db.close();
  const again = new Store(db);
  await again.minionIndex.syncHandoffs(A.id, data);
  assert.equal((again.db.prepare('SELECT count(*) AS n FROM handoff_index').get() as any).n, 3);
  again.db.close();
});

test('the route and search_minions: the server fills the index itself, and a minion reads only its own scheme', { timeout: 60_000 }, async () => {
  const boot = mkdtempSync(join(tmpdir(), 'minion-index-boot-'));
  const data = join(boot, 'data');
  mkdirSync(data, { recursive: true });
  const store = new Store(join(data, 'coordinator.db'));
  const A = store.createProject('A', null);
  const B = store.createProject('B', null);
  const done = seeder(store, A.id, 'Waiting card on phones');
  const me = store.createTicket({ project_id: A.id, title: 'Asker', permission_mode: 'default', created_by: 'Cara' });
  const them = store.createTicket({ project_id: B.id, title: 'Other', permission_mode: 'default', created_by: 'Cara' });
  store.db.close();
  const srv = await bootServer({ root: boot, env: { CITADEL_MEMORY_EVERY_MS: '100' } });
  try {
    const get = (project: number, q: string, id: number) => fetch(`${srv.base}/api/projects/${project}/past-minions?q=${encodeURIComponent(q)}`, { headers: { Authorization: `Bearer ${agentToken(data, id)}` } })
      .then(async (r) => ({ status: r.status, data: await r.json() }));
    let r = await get(A.id, 'seed script', me.id);
    await until('the index to hold the minion', async () => {
      if (r.data.hits?.length) return true;
      r = await get(A.id, 'seed script', me.id);
      return r.data.hits?.length > 0;
    }, 10_000);
    assert.equal(r.status, 200);
    assert.deepEqual(r.data.hits.map((h: any) => h.number), [done.number]);
    assert.equal((await get(A.id, 'seed', them.id)).status, 403, "not another scheme's");
    assert.equal((await fetch(`${srv.base}/api/projects/${A.id}/past-minions?since=yesterday`, { headers: { Cookie: srv.cookie } })).status, 400);

    const mcp = async (method: string, params: object = {}) => {
      const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'src', 'mcp.ts')], {
        env: { ...process.env, COORDINATOR_API: srv.base, COORDINATOR_TOKEN: agentToken(data, me.id), COORDINATOR_PROJECT: String(A.id), COORDINATOR_TICKET: String(me.id), COORDINATOR_ROLE: 'thread', COORDINATOR_MEMORY: '' },
        stdio: ['pipe', 'pipe', 'inherit'],
      });
      try {
        const reply = new Promise<any>((resolve) => createInterface({ input: child.stdout }).once('line', (l) => resolve(JSON.parse(l))));
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) + '\n');
        return (await reply).result;
      } finally {
        child.kill();
      }
    };
    assert.ok((await mcp('tools/list')).tools.some((t: any) => t.name === 'search_minions'), 'listed with chat search off too');
    const said = (await mcp('tools/call', { name: 'search_minions', arguments: { query: 'seed script' } })).content[0].text;
    assert.match(said, new RegExp(`^#${done.number} Waiting card on phones · no type · closed \\d{4}-\\d\\d-\\d\\d\\n.*\\[seed\\].*\\nFiles: \\$TMPDIR/seed\\.ts, \\$TMPDIR/drive\\.mjs, public/phone\\.js$`));
  } finally {
    await srv.stop();
    rmSync(boot, { recursive: true, force: true });
  }
});

test('a re-close in the same millisecond as the first close is indexed again', () => {
  const store = new Store(join(root, 'same-ms.db'));
  const p = store.createProject('Same ms', null);
  const t = store.createTicket({ project_id: p.id, title: 'Quick', permission_mode: 'default', created_by: 'Cara' });
  const realNow = Date.now;
  const frozen = realNow();
  Date.now = () => frozen;
  try {
    store.updateTicket(t.id, { status: 'closed' });
    assert.equal(store.minionIndex.indexClosed(p.id), 1);
    store.updateTicket(t.id, { status: 'idle' });
    store.updateTicket(t.id, { status: 'closed' });
    assert.equal(store.minionIndex.indexClosed(p.id), 1);
  } finally {
    Date.now = realNow;
  }
});
