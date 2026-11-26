// A cabal lead's hands (#2091): the forming card approves the roster (who and when), cabal_start starts only approved
// rows with the cabal, build, Goal, parent and the row's tier and chain, the width holds the rest as next up until a
// member closes, cabal_member acts on the lead's own members only, and a start waits for a worker like any minion's.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { agentToken, bootServer, type Booted, fakeClaude, tempRoot, until } from './helpers.ts';
import { json } from './typed.ts';

type Ev = { id: number; kind: string; data: string };
type Row = { id: number; number: number; title: string; parent: number | null; model: string; effort: string; build: number | null; state: string | null; status: string };
type CabalRow = { id: number; label: string; ticket_id: number | null; approved_by: string | null; approved_at: number | null; next_at: number | null };
type Held = { items: { text: string }[] } | null;

const tmp = tempRoot('cabal-start-');
let s: Booted;
let p: { id: number };
let lead: { id: number; number: number };
let db: DatabaseSync;
let handoffs: string;

before(async () => {
  s = await bootServer({ root: tmp.dir, env: { CLAUDE_BIN: fakeClaude(tmp.dir) } });
  p = (await s.call('/api/projects', { name: 'Delve' })).data;
  lead = (await s.call(`/api/projects/${p.id}/tickets`, { title: 'Docs lead', message: 'Lead the docs sweep.', model: 'claude-opus-5-5', effort: 'high', build: 7, properties: { type: 'chore', effortName: 'Docs sweep' } })).data;
  handoffs = join(s.data, 'projects', String(p.id), 'shared', 'project', 'handoffs');
  mkdirSync(handoffs, { recursive: true });
  for (const n of ['a', 'b', 'c', 'd']) writeFileSync(join(handoffs, `${n}.md`), `# Handoff ${n}\n\n## Goal\nDo ${n}.\n\nExpected cost: ~$${n === 'a' ? 40 : 5}\n`);
  db = new DatabaseSync(join(s.data, 'coordinator.db'), { readOnly: true, timeout: 30_000 });
});
after(async () => {
  db?.close();
  await s?.stop();
  await tmp.teardown();
});

/** A minion's call, once its turn is over (a wake mints a new token). */
async function as(id: number, path: string, body: object) {
  await until(`#${id} idle`, async () => (await s.call(`/api/tickets/${id}`)).data.ticket.status !== 'running');
  const r = await fetch(`${s.base}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${agentToken(s.data, id)}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, data: await json<Record<string, unknown> & { error?: string }>(r) };
}
const board = (id: number, body: object) => as(id, `/api/tickets/${id}/cabal`, body);
const start = (row: string) => as(lead.id, `/api/tickets/${lead.id}/cabal/start`, { row });
const minion = (title: string) => db.prepare('SELECT * FROM tickets WHERE title = ? AND project_id = ?').get(title, p.id) as unknown as Row | undefined;
const rowOf = (label: string) => db.prepare('SELECT * FROM cabal_rows WHERE lead_id = ? AND label = ?').get(lead.id, label) as unknown as CabalRow;
const events = async (id: number) => (await s.call(`/api/tickets/${id}/events?after=0`)).data as Ev[];
const held = async (id: number) => ((await s.call(`/api/tickets/${id}`)).data.ticket.held_mail as Held)?.items ?? [];

/** Post the forming card and answer it as the signed-in person; returns the lead's answer message. */
async function form(pick: string, width?: number, between?: () => Promise<unknown>) {
  const r = await board(lead.id, { action: 'form', ...(width ? { width } : {}) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const card = (await events(lead.id)).filter((e) => e.kind === 'question').at(-1)!;
  const data = JSON.parse(card.data);
  assert.ok(data.cabalForm, 'a forming card carries its rows');
  assert.equal(data.to, undefined, 'open to the scheme');
  await between?.();
  assert.equal((await s.call(`/api/tickets/${lead.id}/answer`, { questionId: data.id, answers: [{ selected: [pick] }] })).status, 202);
  return { data, answer: (await events(lead.id)).find((e) => e.kind === 'user_message' && JSON.parse(e.data).answer?.questionId === data.id)! };
}

test('the forming card approves the roster with who and when; an unapproved row is refused with "add it with a card"', async () => {
  for (const [label, after] of [
    ['A', ''],
    ['B', 'A'],
  ])
    assert.equal((await board(lead.id, { action: 'row', label, title: `Do ${label.toLowerCase()}`, handoff: `handoffs/${label.toLowerCase()}.md`, model: 'claude-sonnet-5-5', effort: 'medium', after })).status, 200);
  const early = await start('A');
  assert.equal(early.status, 403);
  assert.match(String(early.data.error), /add it with a card/);
  assert.equal((await board(lead.id, { action: 'row', label: 'X', title: 'Gone', handoff: 'handoffs/nope.md' })).status, 400, 'a handoff must exist');

  const { data, answer } = await form('Not yet');
  assert.match(data.questions[0].question, /Do a · handoffs\/a\.md · Sonnet[^\n]*· ~\$40/, "each row with its handoff, its tier and its handoff's cost");
  assert.equal(rowOf('A').approved_at, null, 'Not yet approves nothing');
  assert.ok(answer);

  const { answer: go } = await form('Start the cabal', 1);
  assert.match(JSON.parse(go.data).text, /Approved: A, B; width 1\./, 'the lead reads what its go approved');
  const a = rowOf('A');
  assert.equal(a.approved_by, 'Cara');
  assert.ok(a.approved_at! > 0);
  const text = String((await s.call(`/api/tickets/${lead.id}/cabal?text=1`)).data.text);
  assert.match(text, /Cara: Approved on the forming card: A, B; width 1/, "the lead's log keeps who said go");
  assert.match(text, /A roster Do a \| approved \|.*handoffs\/a\.md · Sonnet 5\.5 medium · \$40\.00 · approved by Cara/, text);

  // A row added after the go isn't approved; changing an approved row's tier takes its go back.
  assert.equal((await board(lead.id, { action: 'row', label: 'C', title: 'Do c', handoff: 'handoffs/c.md', model: 'claude-sonnet-5-5', effort: 'medium' })).status, 200);
  assert.match(String((await start('C')).data.error), /add it with a card/);
  assert.equal((await board(lead.id, { action: 'row', row: rowOf('B').id, effort: 'high' })).status, 200);
  assert.equal(rowOf('B').approved_at, null, 'a changed row needs a new card');
  await form('Start the cabal', 1);
  assert.ok(rowOf('B').approved_at && rowOf('C').approved_at);

  // A row changed between the card and its go isn't approved: people said go to what the card showed.
  assert.equal((await board(lead.id, { action: 'row', label: 'E', title: 'Do e', handoff: 'handoffs/d.md', model: 'claude-sonnet-5-5', effort: 'low' })).status, 200);
  const { answer: stale } = await form('Start the cabal', 1, () => board(lead.id, { action: 'row', row: rowOf('E').id, model: 'claude-opus-5-5' }));
  assert.match(JSON.parse(stale.data).text, /Not approved, changed after the card was posted: E/);
  assert.equal(rowOf('E').approved_at, null);
  assert.equal((await board(lead.id, { action: 'row', row: rowOf('E').id, remove: true })).status, 200);
});

test('cabal_start starts an approved row in the build and Goal, with the lead as parent and cabal; past the width it is next up until a member closes', async () => {
  const r = await start('A');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const a = minion('Do a')!;
  assert.equal(r.data.started, a.number);
  assert.equal(a.parent, lead.number);
  assert.equal(a.build, 7, "the lead's build");
  assert.deepEqual([a.model, a.effort], ['claude-sonnet-5-5', 'medium'], "the row's tier");
  assert.equal(rowOf('A').ticket_id, a.id, 'on its own row');
  const props = (await s.call(`/api/tickets/${a.id}`)).data.ticket.properties ?? {};
  assert.equal(String(props.effortName ?? ''), 'Docs sweep', "the lead's Goal");
  assert.ok(!(await s.call(`/api/tickets/${a.id}`)).data.ticket.note?.includes('start card'), 'its approved cost needs no start card');
  const brief = JSON.parse((await events(a.id)).find((e) => e.kind === 'user_message')!.data).text;
  assert.ok(brief.includes(join(handoffs, 'a.md')));
  const tm = (await s.call(`/api/projects/${p.id}`)).data.coordinator;
  assert.ok(
    (await held(tm.id)).some((m) => m.text.includes(`started #${a.number} Do a`)),
    'the Taskmaster gets one held line',
  );

  assert.equal((await start('A')).status, 409, 'started already');
  // Width 1: B waits as next up, and starts by itself once A closes (as a member does once merged into its build).
  const b = await start('B');
  assert.equal(b.status, 200);
  assert.equal(b.data.next, 1);
  assert.ok(rowOf('B').next_at && !minion('Do b'));
  assert.match(String((await s.call(`/api/tickets/${lead.id}/cabal?text=1`)).data.text), /B roster Do b \| next up \|/, 'the board shows it next up');
  await until(`#${a.number} idle`, async () => (await s.call(`/api/tickets/${a.id}`)).data.ticket.status !== 'running');
  const closed = await s.call(`/api/tickets/${a.id}/status`, { status: 'closed' });
  assert.equal(closed.status, 200, JSON.stringify(closed.data));
  await until('B starts from next up', () => !!minion('Do b') && rowOf('B').ticket_id != null);
  assert.equal(rowOf('B').next_at, null);
  assert.ok(!(await events(minion('Do b')!.id)).some((e) => e.kind === 'note' && /held until/.test(JSON.parse(e.data).text)), 'A is closed, so nothing to wait on');
});

test("cabal_member unseals, stops and reseals only the lead's own members; a member has no lead tools", async () => {
  const b = minion('Do b')!;
  const outsider = (await s.call(`/api/projects/${p.id}/tickets`, { title: 'Not in it', message: 'Other work.', model: 'claude-sonnet-5-5', effort: 'low' })).data;
  const member = (action: string, n: number, from = lead.id) => as(from, `/api/tickets/${from}/cabal/member`, { action, minion: n });
  const refused = await member('stop', outsider.number);
  assert.equal(refused.status, 403);
  assert.match(String(refused.data.error), /only your own members/);
  assert.equal((await member('reseal', outsider.number)).status, 403);
  assert.equal((await member('unseal', outsider.number)).status, 403);
  // Linking a minion to a row doesn't make it the lead's own: only one it started from an approved row is.
  assert.equal((await board(lead.id, { action: 'row', label: 'O', title: 'Linked', minion: outsider.number })).status, 200);
  assert.match(String((await member('stop', outsider.number)).data.error), /only your own members/);
  assert.equal((await board(lead.id, { action: 'row', row: rowOf('O').id, remove: true })).status, 200);
  // A member can't use a lead's tools on anyone.
  assert.equal((await as(b.id, `/api/tickets/${b.id}/cabal/member`, { action: 'stop', minion: b.number })).status, 403);
  assert.equal((await as(b.id, `/api/tickets/${b.id}/cabal/start`, { row: 'C' })).status, 403);

  assert.equal((await member('unseal', b.number)).status, 409, "B isn't sealed");
  assert.equal((await board(lead.id, { action: 'row', row: rowOf('B').id, remove: true })).status, 409, "an open member's row stays: it is what makes B the lead's own");
  assert.equal((await board(lead.id, { action: 'row', row: rowOf('B').id, minion: null })).status, 409);
  assert.equal((await member('reseal', b.number)).status, 200);
  await until('B sealed', () => minion('Do b')!.state === 'parked');
  assert.equal((await member('reseal', b.number)).status, 409, 'sealed already');
  const u = await member('unseal', b.number);
  assert.equal(u.status, 200, JSON.stringify(u.data));
  await until('B unsealed', () => minion('Do b')!.state !== 'parked');
  assert.equal((await member('stop', b.number)).status, 200);
});

test("a started member's turn waits for a worker like any minion's; a row after an open member's label chains on it", async () => {
  // B is open, so C is past width 1: widen it on a new card, with D after B (the answer wakes the lead, so before the pause).
  assert.equal((await board(lead.id, { action: 'row', label: 'D', title: 'Do d', handoff: 'handoffs/d.md', model: 'claude-sonnet-5-5', effort: 'low', after: 'B' })).status, 200);
  await form('Start the cabal', 3);
  const d = await start('D');
  assert.equal(d.status, 200, JSON.stringify(d.data));
  assert.equal(minion('Do d')!.state, 'parked', 'chained on B, which is open');
  assert.match(String((await s.call(`/api/tickets/${minion('Do d')!.id}`)).data.ticket.note), new RegExp(`#${minion('Do b')!.number} is merged into Build 7`), "a build member waits for its leader's merge");
  assert.match(String((await s.call(`/api/tickets/${lead.id}/cabal?text=1`)).data.text), /· 1 at work, up to 3 at once ·/, 'D, sealed on its chain, holds no place: only B is at work');
  assert.equal((await s.call('/api/workers', { pause: true }, 'PUT')).status, 200);
  try {
    const r = await start('C');
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const c = minion('Do c')!;
    await until("C's brief waits for a worker", async () => !!(await s.call(`/api/tickets/${c.id}`)).data.ticket.worker_wait);
    assert.match(String((await s.call(`/api/tickets/${c.id}`)).data.ticket.worker_wait.paused), /Cara/);
  } finally {
    await s.call('/api/workers', { pause: false }, 'PUT');
  }
});

test("a goal cabal's lead is woken once, for its retro, when its last member is dismissed; the timeline has ships, asks, reds and spend (#2096)", async () => {
  const make = async (title: string) => (await s.call(`/api/projects/${p.id}/tickets`, { title, message: 'Go.', model: 'claude-sonnet-5-5', effort: 'medium' })).data as { id: number; number: number };
  const chief = await make('Sweep lead');
  const [one, two] = [await make('Sweep one'), await make('Sweep two')];
  for (const [label, m] of [
    ['M1', one],
    ['M2', two],
  ] as const)
    assert.equal((await board(chief.id, { action: 'row', label, title: label, minion: m.number, cost: 5 })).status, 200);
  assert.equal((await board(chief.id, { action: 'row', label: 'F', title: 'Fixes', role: 'fixer' })).status, 200);
  assert.equal((await board(one.id, { action: 'ask', text: 'May I take x.ts?', blocking: false })).status, 200);
  assert.equal((await board(chief.id, { action: 'red', text: 'full run red' })).status, 200);
  assert.equal((await board(chief.id, { action: 'red', text: null })).status, 200);
  const asked = async () => (await events(chief.id)).filter((e) => e.kind === 'user_message' && /Write the cabal's retro/.test(e.data)).length;
  assert.equal((await s.call(`/api/tickets/${one.id}/status`, { status: 'closed' })).status, 200);
  assert.equal((await s.call(`/api/tickets/${two.id}/status`, { status: 'closed' })).status, 200);
  await until('the lead is asked for the retro', async () => (await asked()) === 1);
  // Dismissed again: no second ask.
  await s.call(`/api/tickets/${two.id}/status`, { status: 'open' });
  await s.call(`/api/tickets/${two.id}/status`, { status: 'closed' });

  const r = await fetch(`${s.base}/api/tickets/${chief.id}/cabal?timeline=1`, { headers: { Authorization: `Bearer ${agentToken(s.data, chief.id)}` } });
  const { text } = await json<{ text: string }>(r);
  assert.match(text, new RegExp(`Board: #/p/${p.id}/cabal/${chief.number}`));
  assert.match(text, new RegExp(`M1 #${one.number} .*started .*dismissed .*of ~\\$5\\.00 expected`));
  assert.match(text, /May I take x\.ts\? \| never answered/);
  assert.match(text, /Red: full run red[\s\S]*Red cleared/);
  assert.equal(await asked(), 1);
  // A member added after that: once it is dismissed too, the lead is asked again.
  const three = await make('Sweep three');
  const added = await board(chief.id, { action: 'row', label: 'M3', title: 'M3', minion: three.number });
  assert.equal(added.status, 200, JSON.stringify(added.data));
  await until('#3 idle', async () => (await s.call(`/api/tickets/${three.id}`)).data.ticket.status !== 'running');
  assert.equal((await s.call(`/api/tickets/${three.id}/status`, { status: 'closed' })).status, 200);
  await until('asked again', async () => (await asked()) === 2);
  // A planned piece dropped after the last member went: removing its row asks too.
  const four = await make('Sweep four');
  assert.equal((await board(chief.id, { action: 'row', label: 'M4', title: 'M4', minion: four.number })).status, 200);
  const planned = await board(chief.id, { action: 'row', label: 'P', title: 'Dropped piece' });
  await until('#4 idle', async () => (await s.call(`/api/tickets/${four.id}`)).data.ticket.status !== 'running');
  assert.equal((await s.call(`/api/tickets/${four.id}/status`, { status: 'closed' })).status, 200);
  assert.equal(await asked(), 2, 'the planned piece still holds it');
  assert.equal((await board(chief.id, { action: 'row', row: planned.data.row, remove: true })).status, 200);
  await until('asked once the piece is dropped', async () => (await asked()) === 3);
});
