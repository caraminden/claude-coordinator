// The Overlord (#921, Build 3): the shared jobs of a scheme split into per-person Taskmasters
// (specs/per-person-taskmasters-overlord.md). Here: it hears of every start and flags one that reads
// like another person's open minion with a card.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Auth } from '../src/auth.ts';
import { Store } from '../src/db.ts';
import { Runner } from '../src/runner.ts';
import { until } from './wait.ts';
import { agentToken, bootServer, PASSWORD, SECRET, type Booted } from './helpers.ts';

const root = mkdtempSync(join(tmpdir(), 'overlord-'));
const data = join(root, 'data');
mkdirSync(data, { recursive: true });

/** The memory test's stand-in model: words hashed into 64 buckets, so texts that share words score high. */
function fakeVec(text: string): number[] {
  const v = new Array(64).fill(0);
  for (const w of text.toLowerCase().match(/[a-z]+/g) ?? []) v[[...w].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 64] += 1;
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}
const embedder = createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  const { input } = JSON.parse(body) as { input: string[] };
  res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: input.map((t, index) => ({ index, embedding: fakeVec(t.replace(/^Instruct:[\s\S]*?\nQuery: /, '')) })) }));
});

const store = new Store(join(data, 'coordinator.db'));
const Cara = store.createUser({ name: 'Cara', login: 'cara', admin: true });
const Josh = store.createUser({ name: 'Josh', login: 'josh' });
const Shared = store.createProject('Shared', null, Cara.id);
const Solo = store.createProject('Solo', null, Cara.id);
store.addMember(Shared.id, Josh.id);
for (const p of [Shared, Solo]) store.setTicketDir(store.createTicket({ project_id: p.id, kind: 'coordinator', title: 'Coordinator', permission_mode: 'default', created_by: 'Taskmaster' }).id, root, null);
store.splitScheme(Shared.id, Josh.id);
const overlord = store.getOverlord(Shared.id)!;
const soloTm = store.getCoordinator(Solo.id)!;
const joshWork = store.createTicket({ project_id: Shared.id, title: 'Retry loop in land.sh after a refused push', permission_mode: 'default', created_by: 'Josh' });
store.props.set('minion', joshWork.id, Shared.id, { assigned: 'Josh' }, 'Josh');
store.db.close();

const cookie = new Auth(PASSWORD, SECRET).issueCookie(Cara, false).split(';')[0];
let srv: Booted;
let db: Store;
before(async () => {
  await new Promise<void>((r) => embedder.listen(0, '127.0.0.1', r));
  const embedUrl = `http://127.0.0.1:${(embedder.address() as { port: number }).port}`;
  srv = await bootServer({ root, env: { CITADEL_EMBED_URL: embedUrl, CITADEL_MEMORY_SCHEMES: `${Shared.id},${Solo.id}`, CITADEL_MEMORY_EVERY_MS: '100' } });
  db = new Store(join(data, 'coordinator.db'));
});
after(async () => {
  await srv?.stop();
  embedder.close();
  rmSync(root, { recursive: true, force: true });
});

const start = async (projectId: number, title: string) => {
  const res = await fetch(`${srv.base}/api/projects/${projectId}/tickets`, {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ title, message: title, properties: { type: 'chore' } }),
  });
  assert.equal(res.status, 201);
  return (await res.json()) as { id: number; number: number };
};
const events = (ticketId: number) => db.listEvents(ticketId).map((e) => ({ kind: e.kind, data: JSON.parse(e.data) }));
const mail = (ticketId: number) => events(ticketId).filter((e) => e.kind === 'user_message' && e.data.mail).map((e) => String(e.data.text));
const cards = (ticketId: number) => events(ticketId).filter((e) => e.kind === 'question').map((e) => e.data);

test("the Overlord hears of every start, and gets a card when one reads like another person's open minion", async () => {
  // Josh's minion has to be indexed before a look-alike can be found.
  const hits = async () => (await (await fetch(`${srv.base}/api/projects/${Shared.id}/memory?q=${encodeURIComponent('retry loop land.sh')}&scope=minions`, { headers: { Cookie: cookie } })).json()).hits ?? [];
  for (let i = 0; i < 100 && !(await hits()).some((h: any) => h.ticket_id === joshWork.id); i++) await new Promise((r) => setTimeout(r, 100));

  const twin = await start(Shared.id, 'Fix the retry loop in land.sh after a refused push');
  const heard = await until(`mail naming #${twin.number}`, () => { const m = mail(overlord.id); return m.some((t) => t.includes(`#${twin.number}`)) && m; });
  assert.ok(heard.some((t) => t.startsWith(`Cara started #${twin.number} `)), heard.join('\n'));
  const [card] = await until('a card for the look-alike', () => { const c = cards(overlord.id); return c.length > 0 && c; });
  assert.ok(card, 'a card for the look-alike');
  const q = card.questions[0];
  assert.match(q.question, new RegExp(`Cara started #${twin.number} .*Josh's #${joshWork.number} `));
  assert.equal(q.options.find((o: any) => o.recommended).label, 'Both stay');
  assert.equal(card.to, undefined, 'any member answers it');

  // A start that reads like nothing still reaches it, with no card.
  const other = await start(Shared.id, 'Paint the rail a calmer blue');
  await until(`mail naming #${other.number}`, () => mail(overlord.id).some((t) => t.includes(`#${other.number}`)));
  // The card search runs after the mail line, so a second look-alike's card is the positive signal that it has had its turn.
  const twin2 = await start(Shared.id, 'Fix the retry loop in land.sh after a refused push, again');
  await until(`a card for #${twin2.number}`, () => cards(overlord.id).some((c) => c.questions[0].question.includes(`#${twin2.number} `)));
  assert.ok(!cards(overlord.id).some((c) => c.questions[0].question.includes(`#${other.number} `)), 'no card for the unrelated start');

  // A scheme nobody else is in has no Overlord apart from its Taskmaster: no line for its own starts.
  const solo = await start(Solo.id, 'Retry loop in land.sh after a refused push');
  // The Overlord's mail line is left before the start's response returns, so there's nothing left to wait for.
  assert.ok(!mail(soloTm.id).some((t) => t.includes(`#${solo.number}`)));
});

test("the Overlord's cards are for everyone, a person's own Taskmaster's aren't; an answer reaches every other Taskmaster as held mail", async () => {
  const ownCara = db.coordinatorFor(Shared.id, Cara.id)!;
  const ownJosh = db.coordinatorFor(Shared.id, Josh.id)!;
  const ask = async (ticketId: number) => {
    const res = await fetch(`${srv.base}/api/tickets/${ticketId}/questions`, {
      method: 'POST', headers: { Authorization: `Bearer ${agentToken(data, ticketId)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ questions: [{ question: 'Who takes the pipeline lane next?', options: [{ label: 'Josh', recommended: true }, { label: 'Cara' }] }] }),
    });
    assert.equal(res.status, 201);
    return ((await res.json()) as { id: string }).id;
  };
  const card = (ticketId: number, id: string) => cards(ticketId).find((c) => c.id === id);
  const lordCard = await ask(overlord.id);
  assert.equal(card(overlord.id, lordCard).everyone, true);
  const ownCard = await ask(ownJosh.id);
  assert.equal(card(ownJosh.id, ownCard).everyone, undefined);

  const res = await fetch(`${srv.base}/api/tickets/${overlord.id}/answer`, {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ questionId: lordCard, answers: [{ selected: ['Josh'] }] }),
  });
  assert.equal(res.status, 202);
  for (const tm of [ownCara, ownJosh]) {
    const got = await until(`the answer in mail for Taskmaster #${tm.id}`, () => { const m = mail(tm.id); return m.some((t) => t.includes('Who takes the pipeline lane next?')) && m; });
    assert.ok(got.some((t) => /Cara answered the Overlord's card[\s\S]*→ Josh/.test(t)), got.join('\n'));
  }
  assert.ok(!mail(overlord.id).some((t) => t.includes('for your tracking')), 'the Overlord, the card\'s own chat, gets no tracking mail');
});

test("a person's Taskmaster asks for everyone: the card sits with the Overlord, and its answer wakes the asker (Cara: \"Asker acts on it\")", async () => {
  const ownCara = db.coordinatorFor(Shared.id, Cara.id)!;
  const ownJosh = db.coordinatorFor(Shared.id, Josh.id)!;
  const ask = (ticketId: number, extra: object = {}) => fetch(`${srv.base}/api/tickets/${ticketId}/questions`, {
    method: 'POST', headers: { Authorization: `Bearer ${agentToken(data, ticketId)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ questions: [{ question: 'Freeze lands over the weekend?', options: [{ label: 'Yes', recommended: true }, { label: 'No' }] }], for_everyone: true, ...extra }),
  });
  const res = await ask(ownJosh.id);
  assert.equal(res.status, 201);
  const { id, href } = (await res.json()) as { id: string; href: string };
  assert.ok(href.includes(`e=`) && !cards(ownJosh.id).some((c) => c.id === id), "not in Josh's own chat");
  const card = cards(overlord.id).find((c) => c.id === id);
  assert.equal(card.everyone, true);
  assert.equal(card.asker, ownJosh.id);
  assert.equal((await ask(ownJosh.id, { to: 'Cara' })).status, 400, 'a card for everyone has no one addressee');
  assert.equal((await ask(joshWork.id)).status, 400, 'only a Taskmaster asks for everyone');

  const answered = await fetch(`${srv.base}/api/tickets/${overlord.id}/answer`, {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ questionId: id, answers: [{ selected: ['No'] }] }),
  });
  assert.equal(answered.status, 202);
  const told = await until("a plain message with 'Freeze lands' for Josh's Taskmaster", () => { const t = events(ownJosh.id).filter((e) => e.kind === 'user_message' && !e.data.mail).map((e) => String(e.data.text)); return t.some((x) => x.includes('Freeze lands')) && t; });
  assert.ok(told.some((t) => /for everyone[\s\S]*Freeze lands over the weekend\?\n→ No/.test(t)), told.join('\n'));
  const lord = events(overlord.id).filter((e) => e.kind === 'user_message');
  assert.ok(lord.some((e) => e.data.answer?.questionId === id && !e.data.mail), "the answer is in the Overlord's chat, where the card is");
  assert.ok(!lord.some((e) => e.data.mail && String(e.data.text).includes('Freeze lands')), 'the Overlord, where the card is, gets no tracking mail about it');
  assert.ok(mail(ownCara.id).some((t) => t.includes('Freeze lands')), "so does Cara's own");
  assert.ok(!mail(ownJosh.id).some((t) => t.includes('Freeze lands')), 'the asker gets it once, as its wake');
  const again = await fetch(`${srv.base}/api/tickets/${overlord.id}/answer`, {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ questionId: id, answers: [{ selected: ['Yes'] }] }),
  });
  assert.equal(again.status, 409, 'one answer settles it for everyone');
});

test("an Overlord turn runs for whoever started it, else the scheme's owner, never its last person (Cara's R4)", () => {
  const s = new Store(join(root, 'r4.db'));
  const cara = s.createUser({ name: 'Cara', login: 'cara', admin: true });
  const josh = s.createUser({ name: 'Josh', login: 'josh' });
  const p = s.createProject('Shared', null, cara.id);
  s.createTicket({ project_id: p.id, kind: 'coordinator', title: 'Coordinator', permission_mode: 'default', created_by: 'Taskmaster' });
  s.splitScheme(p.id, josh.id);
  const lord = s.getOverlord(p.id)!;
  s.updateTicket(lord.id, { person_id: josh.id }); // Josh answered its last card
  const runner = new Runner(s, () => {}, () => ({}), '/bin/false');
  runner.personOf = (author) => s.findUser('name', author)?.id ?? null;
  const turnPerson = (batch: any[]) => (runner as any).turnPerson(s.getTicket(lord.id), s.getProject(p.id), batch);
  assert.equal(turnPerson([{ author: 'Josh', text: 'Both stay', images: [], own: true }]), josh.id, 'the starter');
  assert.equal(turnPerson([{ author: 'Citadel', text: 'CI went red', images: [] }]), cara.id, 'an alert: the owner, not Josh from last time');
  s.db.close();
});

test("a plain note on the Overlord is one person's; one emitted for everyone is flagged; a third member's Taskmaster isn't titled Overlord", () => {
  const s = new Store(join(root, 'notes.db'));
  const cara = s.createUser({ name: 'Cara', login: 'cara', admin: true });
  const josh = s.createUser({ name: 'Josh', login: 'josh' });
  const p = s.createProject('Shared', null, cara.id);
  const first = s.createTicket({ project_id: p.id, kind: 'coordinator', title: 'Coordinator', permission_mode: 'default', created_by: 'Taskmaster' });
  const runner = new Runner(s, () => {}, () => ({}), '/bin/false');
  const note = (id: number) => JSON.parse(runner.emit(id, 'note', { text: 'CI store is full' }).data);
  assert.equal(note(first.id).everyone, undefined, 'before a split its only Taskmaster is everyone\'s anyway');
  s.splitScheme(p.id, josh.id);
  assert.equal(note(s.getOverlord(p.id)!.id).everyone, undefined, 'a one-person note on the Overlord stays out of everyone\'s Mine');
  const lord = s.getOverlord(p.id)!.id;
  assert.equal(JSON.parse(runner.emit(lord, 'note', { text: 'CI store is full', everyone: true }).data).everyone, true);
  assert.equal(note(s.coordinatorFor(p.id, josh.id)!.id).everyone, undefined);
  assert.equal(JSON.parse(runner.emit(s.coordinatorFor(p.id, josh.id)!.id, 'note', { text: 'x', everyone: true }).data).everyone, undefined, 'only the Overlord can speak for everyone');
  const zed = s.createUser({ name: 'Zed', login: 'zed' });
  s.addMember(p.id, zed.id);
  const zedTm = s.splitScheme(p.id, zed.id);
  assert.equal(zedTm.title, 'Coordinator');
  assert.equal(s.getOverlord(p.id)!.title, 'Overlord');
  s.db.close();
});

test("a dismissed minion is a line in a split scheme's Taskmaster digest (#919: \"claims and closes are yours to add\")", async () => {
  const s = new Store(join(root, 'closes.db'));
  const cara = s.createUser({ name: 'Cara', login: 'cara', admin: true });
  const josh = s.createUser({ name: 'Josh', login: 'josh' });
  const p = s.createProject('Shared', null, cara.id);
  s.createTicket({ project_id: p.id, kind: 'coordinator', title: 'Coordinator', permission_mode: 'default', created_by: 'Taskmaster' });
  const before = s.createTicket({ project_id: p.id, title: 'Before the split', permission_mode: 'default', created_by: 'Cara' });
  const runner = new Runner(s, () => {}, () => ({}), '/bin/false');
  await runner.close(before.id, 'Dismissed.');
  s.splitScheme(p.id, josh.id);
  const m = s.createTicket({ project_id: p.id, title: 'Lairs', permission_mode: 'default', created_by: 'Josh' });
  await runner.close(m.id, 'Dismissed.');
  const lines = s.digestFor(s.coordinatorFor(p.id, cara.id)!.id).join('\n');
  assert.match(lines, new RegExp(`#${m.number} Lairs was dismissed`));
  assert.doesNotMatch(lines, /Before the split/, 'an unsplit scheme has no one to tell');
  s.db.close();
});
