// Cabals across schemes (#2094): a lead's row in another scheme is approved only by that scheme's people (on their own
// copy of the forming card), started by that scheme's Taskmaster when the lead asks with message_taskmaster, joined with
// cabal "<scheme>#<lead>", and shown on the board with its scheme's name. The lead's message_taskmaster does nothing else.
// Who sees the row is src/access.ts's cabalBoardFor: members of either scheme, its chat only for its own scheme's.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { agentToken, bootServer, type Booted, type Caller, fakeClaude, tempRoot, until } from './helpers.ts';
import { GLOBAL_OWNER } from '../src/properties.ts';
import { json } from './typed.ts';

type Ev = { id: number; kind: string; data: string };
type CabalRow = { id: number; label: string; ticket_id: number | null; approved_by: string | null; approved_at: number | null; asked_at: number | null; next_at: number | null; project_id: number | null };
type Member = { row: number; label: string; number: number | null; project_id: number | null; scheme: string | null; open: boolean; state: string; word: string; note: string };
type BoardView = { lead: { open: boolean }; members: Member[]; asks: { scheme: string | null; text: string }[]; log: unknown[] };

const tmp = tempRoot('cabal-cross-');
let s: Booted;
let a: { id: number };
let b: { id: number };
let lead: { id: number; number: number };
let db: DatabaseSync;
let sam: Caller; // in A only
let josh: Caller; // in B only

async function person(name: string, scheme: number): Promise<Caller> {
  const made = (await s.call('/api/people', { name })).data as { person: { id: number }; token: string };
  const res = await fetch(`${s.base}/api/invite/${made.token}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: `${name}-password-1` }) });
  assert.equal((await s.call(`/api/projects/${scheme}/members`, { person: made.person.id })).status < 300, true);
  return s.as({ cookie: res.headers.get('set-cookie')!.split(';')[0] });
}

before(async () => {
  s = await bootServer({ root: tmp.dir, env: { CLAUDE_BIN: fakeClaude(tmp.dir) } });
  // Scheme 2 is Citadel's, whose members see every scheme: these two come after it.
  while (((await s.call('/api/projects', { name: `Spare ${Date.now()}` })).data as { id: number }).id < GLOBAL_OWNER);
  a = (await s.call('/api/projects', { name: 'Atlas' })).data;
  b = (await s.call('/api/projects', { name: 'Delve' })).data;
  lead = (await s.call(`/api/projects/${a.id}/tickets`, { title: 'Map lead', message: 'Lead the map work.', model: 'claude-opus-5-5', effort: 'high', build: 7, properties: { type: 'feature', effortName: 'Maps' } })).data;
  const handoffs = join(s.data, 'projects', String(a.id), 'shared', 'project', 'handoffs');
  mkdirSync(handoffs, { recursive: true });
  for (const n of ['here', 'there']) writeFileSync(join(handoffs, `${n}.md`), `# Handoff ${n}\n\nExpected cost: ~$6\n`);
  db = new DatabaseSync(join(s.data, 'coordinator.db'), { readOnly: true, timeout: 30_000 });
  sam = await person('Sam', a.id);
  josh = await person('Josh', b.id);
});
after(async () => {
  db?.close();
  await s?.stop();
  await tmp.teardown();
});

/** A minion's call, once its turn is over (a wake mints a new token). */
async function as(id: number, path: string, body?: object) {
  await until(`#${id} idle`, async () => (await s.call(`/api/tickets/${id}`)).data.ticket.status !== 'running');
  const r = await fetch(`${s.base}${path}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${agentToken(s.data, id)}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, data: await json<Record<string, unknown> & { error?: string }>(r) };
}
const board = (body: object) => as(lead.id, `/api/tickets/${lead.id}/cabal`, body);
const ask = (body: object) => as(lead.id, `/api/tickets/${lead.id}/cabal/taskmaster`, body);
const rowOf = (label: string) => db.prepare('SELECT * FROM cabal_rows WHERE lead_id = ? AND label = ?').get(lead.id, label) as CabalRow;
const events = async (id: number) => (await s.call(`/api/tickets/${id}/events?after=0`)).data as Ev[];
const taskmasterOf = (project: number) => (db.prepare("SELECT id FROM tickets WHERE project_id = ? AND kind = 'coordinator' ORDER BY id").get(project) as { id: number }).id;
/** Everything said to a Taskmaster: its chat lines and its held mail. */
async function heard(id: number): Promise<string> {
  const t = (await s.call(`/api/tickets/${id}`)).data.ticket as { held_mail?: { items: { text: string }[] } | null };
  const chat = (await events(id)).filter((e) => e.kind === 'user_message').map((e) => String(JSON.parse(e.data).text));
  return [...chat, ...(t.held_mail?.items ?? []).map((i) => i.text)].join('\n---\n');
}
async function answer(who: Caller, ticket: number, card: Ev, pick: string) {
  const r = await who(`/api/tickets/${ticket}/answer`, { questionId: JSON.parse(card.data).id, answers: [{ selected: [pick] }] });
  assert.equal(r.status, 202, JSON.stringify(r.data));
}

test("a row in another scheme: its people's go, the Taskmaster's start, the board, and the lead's message_taskmaster limits", async () => {
  // Roster: one row at home, one in Delve.
  assert.equal((await board({ action: 'row', label: 'H', title: 'Home piece', handoff: 'handoffs/here.md', model: 'claude-sonnet-5-5', effort: 'medium' })).status, 200);
  const there = await board({ action: 'row', label: 'D', title: 'Delve piece', handoff: 'handoffs/there.md', model: 'claude-sonnet-5-5', effort: 'medium', scheme: 'Delve' });
  assert.equal(there.status, 200, JSON.stringify(there.data));
  assert.equal(rowOf('D').project_id, b.id);
  assert.equal((await board({ action: 'row', label: 'Z', title: 'Nowhere', scheme: 'Nope' })).status, 404, 'a scheme the lead cannot reach is refused');

  // The lead's message_taskmaster: own rows elsewhere only, approved ones only, and only these four asks.
  assert.match(String((await ask({ row: 'H', action: 'start' })).data.error), /your own scheme/);
  assert.match(String((await ask({ row: 'D', action: 'start' })).data.error), /isn't on the approved roster/);
  const chat = await ask({ row: 'D', action: 'chat', text: 'hello' });
  assert.equal(chat.status, 400);
  assert.match(String(chat.data.error), /only asks a start, unseal, stop or seal/);
  assert.match(String((await as(lead.id, `/api/tickets/${lead.id}/cabal/start`, { row: 'D' })).data.error), /is in Delve: its Taskmaster starts it/);

  // The forming card: the lead's lists the Delve row; Delve's Taskmaster chat gets a card of its own rows.
  const form = await board({ action: 'form', width: 1 });
  assert.equal(form.status, 200, JSON.stringify(form.data));
  const mine = (await events(lead.id)).filter((e) => e.kind === 'question').at(-1)!;
  const mineQ = JSON.parse(mine.data).questions[0];
  assert.match(mineQ.question, /^- \[Delve\] Delve piece · ~\$6 · now$/m);
  assert.equal(mineQ.roster.find((r: { what: string }) => r.what === 'Delve piece').scheme, 'Delve', 'the list draws the other scheme on its row');
  const tmB = taskmasterOf(b.id);
  const theirs = (await events(tmB)).filter((e) => e.kind === 'question').at(-1)!;
  const theirData = JSON.parse(theirs.data);
  assert.equal(theirData.asker, lead.id, 'its answer goes to the lead');
  assert.deepEqual(
    theirData.questions[0].roster.map((r: { what: string }) => r.what),
    ['Delve piece'],
    'their card draws their rows as a list too',
  );
  assert.match(theirData.questions[0].question, /^- Delve piece · ~\$6 · now$/m);
  assert.deepEqual(
    theirData.cabalForm.rows.map((r: { id: number }) => r.id),
    [rowOf('D').id],
    'only Delve rows on Delve’s card',
  );

  // Sam (Atlas only) says go on the lead's card: the home row, not Delve's.
  await answer(sam, lead.id, mine, 'Start the cabal');
  assert.ok(rowOf('H').approved_at);
  assert.equal(rowOf('D').approved_at, null, "Atlas's people don't approve a Delve row");
  // Josh (Delve only) says go on Delve's card: the lead reads it.
  await answer(josh, tmB, theirs, 'Start the cabal');
  assert.equal(rowOf('D').approved_by, 'Josh');
  await until('the lead got the answer', async () => (await events(lead.id)).some((e) => e.kind === 'user_message' && /in Delve's Taskmaster chat/.test(String(JSON.parse(e.data).text))));

  // The ask: Delve's Taskmaster hears it with the handoff copied into its inbox; the row holds its place.
  const started = await ask({ row: 'D', action: 'start' });
  assert.equal(started.status, 200, JSON.stringify(started.data));
  assert.equal(started.data.asked, 'Delve');
  assert.ok(rowOf('D').asked_at);
  // Asked again (Delve's Taskmaster declined, or never heard): the row's own ask doesn't hold its place against it.
  const again = await ask({ row: 'D', action: 'start' });
  assert.equal(again.data.asked, 'Delve', JSON.stringify(again.data));
  assert.equal(rowOf('D').next_at, null, 'not next up behind itself at width 1');
  await until("Delve's Taskmaster heard the ask", async () => /cabal "Atlas#\d+"/.test(await heard(tmB)));
  const said = await heard(tmB);
  assert.match(said, /never merged into Build 7/);
  const copied = /handoff at (\S+inbox\S+there\.md)/.exec(said)?.[1];
  assert.ok(copied && existsSync(copied), `the handoff is in Delve's shared inbox: ${copied}`);

  // Delve starts it: a wrong title is refused, the approved one joins the lead's board.
  const wrong = await s.call(`/api/projects/${b.id}/tickets`, { title: 'Something else', message: 'x', cabal: `Atlas#${lead.number}` });
  assert.equal(wrong.status, 409);
  assert.match(String(wrong.data.error), /"Delve piece"/);
  const member = (await s.call(`/api/projects/${b.id}/tickets`, { title: 'Delve piece', message: `Your brief is ${copied}`, cabal: `Atlas#${lead.number}`, model: 'claude-sonnet-5-5', effort: 'medium' })).data as { id: number; number: number };
  assert.equal(rowOf('D').ticket_id, member.id);
  assert.equal(rowOf('D').asked_at, null);
  await until('the lead heard of the start', async () => /started Delve #\d+ "Delve piece"/.test(await heard(lead.id)));

  // The board: Atlas's people see it with Delve's name, but open its chat only if they are in Delve.
  const samView = (await sam(`/api/projects/${a.id}/cabal/${lead.number}`)).data.board as BoardView;
  const d = samView.members.find((m) => m.label === 'D')!;
  assert.equal(d.scheme, 'Delve');
  assert.equal(d.project_id, b.id);
  assert.equal(d.open, false, "Sam isn't in Delve: no chat link");
  assert.notEqual(d.state, 'merged');
  assert.equal(samView.members.find((m) => m.label === 'H')!.open, true);
  // Josh, in Delve only, sees the board from the member's chat: Delve's rows, no log, no link to the lead.
  const joshView = (await josh(`/api/tickets/${member.id}/cabal`)).data.board as BoardView;
  assert.deepEqual(
    joshView.members.map((m) => m.label),
    ['D'],
  );
  assert.equal(joshView.members[0].open, true);
  assert.equal(joshView.lead.open, false);
  assert.deepEqual(joshView.log, []);
  assert.notEqual((await josh(`/api/projects/${a.id}/cabal/${lead.number}`)).status, 200, "Josh can't open Atlas's board page");

  // The member's note and ask cross back to the lead's board, named with its scheme.
  assert.equal((await as(member.id, `/api/tickets/${member.id}/cabal`, { action: 'note', note: 'built, in review' })).status, 200);
  assert.equal((await as(member.id, `/api/tickets/${member.id}/cabal`, { action: 'ask', text: 'May I touch maps.ts?' })).status, 200);
  const leadText = String((await as(lead.id, `/api/tickets/${lead.id}/cabal?text=1`)).data.text);
  assert.match(leadText, /D \[Delve\] #\d+ Delve piece[^\n]*built, in review/);
  assert.match(leadText, /from D Delve #\d+[^\n]*May I touch maps\.ts\?/);

  // Seal, unseal and stop go to Delve's Taskmaster too; the lead never acts there itself.
  const seal = await ask({ row: 'D', action: 'seal' });
  assert.equal(seal.status, 200, JSON.stringify(seal.data));
  assert.match(String(seal.data.text), /ask again with action unseal/);
  await until("Delve's Taskmaster heard the seal", async () => /seal your #\d+ "Delve piece"[^\n]*Build 7/.test(await heard(tmB)));
  assert.notEqual((await as(lead.id, `/api/tickets/${lead.id}/cabal/member`, { action: 'stop', minion: member.number })).status, 200, "cabal_member reaches only the lead's own scheme: #N there is another minion or none");

  // A home row can't chain on the Delve member: start_after would look for its #N in Atlas.
  const h2 = await board({ action: 'row', label: 'H2', title: 'After Delve', after: 'D', handoff: 'handoffs/here.md', model: 'claude-sonnet-5-5', effort: 'medium' });
  assert.equal(h2.status, 200, JSON.stringify(h2.data));
  assert.equal((await board({ action: 'form' })).status, 200);
  await answer(sam, lead.id, (await events(lead.id)).filter((e) => e.kind === 'question').at(-1)!, 'Start the cabal');
  assert.ok(rowOf('H2').approved_at);
  const chained = await as(lead.id, `/api/tickets/${lead.id}/cabal/start`, { row: 'H2' });
  assert.equal(chained.status, 400);
  assert.match(String(chained.data.error), /runs in Delve/);
  assert.equal(rowOf('H2').ticket_id, null);
});

test("message_taskmaster is a lead's only: a minion leading no cabal is refused", async () => {
  const plain = (await s.call(`/api/projects/${a.id}/tickets`, { title: 'Plain', message: 'Do a thing.' })).data as { id: number };
  const r = await as(plain.id, `/api/tickets/${plain.id}/cabal/taskmaster`, { row: 1, action: 'start' });
  assert.equal(r.status, 403);
  assert.match(String(r.data.error), /you lead no cabal/);
});
