// A contraption reads its home scheme's membership and minions (#421; the kit's contraption-ui
// references/api.md, "Your home scheme and its minions"): only its own server with its key, for a person
// it is enabled for; minions for members only, with the minions list's progress and no chat text.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Contraptions } from '../src/contraptions.ts';
import { Store } from '../src/db.ts';
import { bootServer, SECRET, stopTurns } from './helpers.ts';

const root = mkdtempSync(join(tmpdir(), 'contraption-minions-'));
const data = join(root, 'data');
mkdirSync(data, { recursive: true });
after(async () => {
  await stopTurns(root); // turns are detached: end them before deleting their folders (#271)
  rmSync(root, { recursive: true, force: true });
});

const store = new Store(join(data, 'coordinator.db'));
const Cara = store.createUser({ name: 'Cara', login: 'cara', admin: true });
const Josh = store.createUser({ name: 'Josh', login: 'josh' });
const Rachel = store.createUser({ name: 'Rachel', login: 'rachel' });
const Dana = store.createUser({ name: 'Dana', login: 'dana' });
const ToC = store.createProject('Theory of Crafting', null, Cara.id);
const Peek = store.createProject('Peek Auras', null, Cara.id);
store.addMember(ToC.id, Rachel.id);
const keys = new Contraptions(store, SECRET, join(data, 'contraptions'));
const toc = keys.register({ name: 'toc', title: 'ToC', port: 9103, icon: null, home_scheme: ToC.id, open_paths: '[]', default_model: null, turn_cap: null });
const homeless = keys.register({ name: 'homeless', title: 'Homeless', port: 9104, icon: null, home_scheme: null, open_paths: '[]', default_model: null, turn_cap: null });
for (const u of [Cara, Josh, Rachel]) store.setContraptionUser(toc.id, u.id, true, Cara.id);
store.setContraptionUser(homeless.id, Rachel.id, true, Cara.id);
const KEY = readFileSync(join(data, 'contraptions', 'toc', 'contraption.key'), 'utf8');
const HOMELESS_KEY = readFileSync(join(data, 'contraptions', 'homeless', 'contraption.key'), 'utf8');

const minion = (title: string, project_id = ToC.id) => store.createTicket({ project_id, title, permission_mode: 'bypassPermissions', created_by: 'Cara' });
// #1: two steps planned, the second under way, a reply line (chat text) as last_activity, and a question card waiting.
const acolyte = minion('Rune tooltips');
store.addEvent(acolyte.id, 'claude', {
  type: 'assistant',
  message: {
    content: [
      {
        type: 'tool_use',
        id: 't1',
        name: 'TodoWrite',
        input: {
          todos: [
            { content: 'Read the tooltip code', activeForm: 'Reading the tooltip code', status: 'completed' },
            { content: 'Show the rune cost', activeForm: 'Showing the rune cost', status: 'in_progress' },
          ],
        },
      },
    ],
  },
});
store.updateTicket(acolyte.id, { status: 'idle', state: 'try', note: 'ready to try', last_activity: 'Secret words from my reply' });
store.addEvent(acolyte.id, 'question', { id: 'q1', questions: [{ question: 'Tabs or list?', options: [] }] });
// #2: dismissed, no plan.
const gone = minion('Old idea');
store.updateTicket(gone.id, { status: 'closed' });
// #3 exists only in Peek Auras.
for (let i = 0; i < 3; i++) minion(`Peek ${i}`, Peek.id);

test('GET /api/contraptions/home and /minions (#421): membership, progress, errors and ETags', { timeout: 60_000 }, async () => {
  const srv = await bootServer({ root });
  after(() => srv.stop()); // waits for the server to exit, so it isn't writing when the folder goes (#218)
  const get = async (path: string, headers: Record<string, string> = {}, key = KEY) => {
    const res = await fetch(`${srv.base}/api/contraptions/${path}`, { headers: { Authorization: `Bearer ${key}`, ...headers } });
    return { status: res.status, etag: res.headers.get('etag'), body: res.status === 304 ? null : await res.json() };
  };

  // Home: a member, an admin (who counts as one) and a non-member; Dana hasn't the app enabled.
  assert.deepEqual((await get(`home?person=${Rachel.id}`)).body, { id: ToC.id, name: 'Theory of Crafting', member: true });
  assert.deepEqual((await get(`home?person=${Cara.id}`)).body, { id: ToC.id, name: 'Theory of Crafting', member: true });
  assert.deepEqual((await get(`home?person=${Josh.id}`)).body, { id: ToC.id, name: 'Theory of Crafting', member: false });
  assert.equal((await get(`home?person=${Dana.id}`)).status, 403);
  assert.equal((await get('home?person=x')).status, 400);
  assert.equal((await get(`home?person=${Rachel.id}`, {}, HOMELESS_KEY)).status, 409);
  assert.equal((await get(`home?person=${Rachel.id}`, {}, 'not-a-key')).status, 401);

  // One minion: the list's state and step, never last_activity's chat text.
  let r = await get(`minions/1?person=${Rachel.id}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const card = r.body.card_since;
  assert.equal(typeof card, 'number');
  assert.deepEqual(r.body, {
    number: 1,
    title: 'Rune tooltips',
    status: 'idle',
    state: 'try',
    note: 'ready to try',
    line: 'Paused at: Show the rune cost · 1 of 2 done',
    step: { n: 2, of: 2, done: 1, label: 'Showing the rune cost' },
    activity_at: store.getTicket(acolyte.id)!.updated_at,
    card_waiting: true,
    card_since: card,
    link: `/c/#/p/${ToC.id}/t/1`,
  });
  assert.doesNotMatch(JSON.stringify(r.body), /Secret words/);

  // The ETag: the same answer is a 304 with no body; a change makes a new one.
  const tag = r.etag!;
  assert.match(tag, /^"[\w-]+"$/);
  assert.equal((await get(`minions/1?person=${Rachel.id}`, { 'If-None-Match': tag })).status, 304);
  store.updateTicket(acolyte.id, { status: 'running', state: null });
  r = await get(`minions/1?person=${Rachel.id}`, { 'If-None-Match': tag });
  assert.equal(r.status, 200);
  assert.notEqual(r.etag, tag);
  assert.equal(r.body.line, 'Showing the rune cost… · 1 of 2 done');
  assert.equal(r.body.status, 'running');

  // A dismissed minion still reads, with no card and no steps.
  r = await get(`minions/2?person=${Cara.id}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'closed');
  assert.equal(r.body.step, null);
  assert.equal(r.body.card_waiting, false);

  // Errors: a non-member 403 before anything about the minion; not enabled 403; another scheme's number or the Taskmaster 404.
  r = await get(`minions/1?person=${Josh.id}`);
  assert.equal(r.status, 403);
  assert.match(r.body.error, /isn't a Theory of Crafting member/);
  assert.equal((await get(`minions/99?person=${Josh.id}`)).status, 403);
  assert.equal((await get(`minions/1?person=${Dana.id}`)).status, 403);
  for (const n of [3, 99]) {
    r = await get(`minions/${n}?person=${Rachel.id}`);
    assert.equal(r.status, 404, String(n));
    assert.equal(r.body.error, `No minion #${n} in Theory of Crafting`);
  }
  for (const bad of ['0', 'x', '1.5']) assert.equal((await get(`minions/${bad}?person=${Rachel.id}`)).status, 400, bad);

  // The list form: the numbers that exist, in order asked, deduplicated, with its own ETag.
  r = await get(`minions?person=${Rachel.id}&n=2,1,3,1`);
  assert.equal(r.status, 200);
  assert.deepEqual(
    r.body.minions.map((m: { number: number }) => m.number),
    [2, 1],
  );
  assert.equal((await get(`minions?person=${Rachel.id}&n=2,1,3,1`, { 'If-None-Match': r.etag! })).status, 304);
  assert.equal((await get(`minions?person=${Josh.id}&n=1`)).status, 403);
  for (const bad of ['', '1,x', '0', Array.from({ length: 51 }, (_, i) => i + 1).join(',')]) assert.equal((await get(`minions?person=${Rachel.id}&n=${bad}`)).status, 400, bad);

  // Nothing here for a browser or a person's session: only the app's own server, with its key.
  assert.equal((await get(`home?person=${Rachel.id}`, { 'X-Forwarded-For': '1.2.3.4' })).status, 403);
});
