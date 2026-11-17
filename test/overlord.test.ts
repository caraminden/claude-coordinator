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
import { bootServer, PASSWORD, SECRET, type Booted } from './helpers.ts';

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
async function until<T>(get: () => T, ok: (v: T) => boolean): Promise<T> {
  let v = get();
  for (let i = 0; i < 100 && !ok(v); i++) {
    await new Promise((r) => setTimeout(r, 100));
    v = get();
  }
  return v;
}

test("the Overlord hears of every start, and gets a card when one reads like another person's open minion", async () => {
  // Josh's minion has to be indexed before a look-alike can be found.
  const hits = async () => (await (await fetch(`${srv.base}/api/projects/${Shared.id}/memory?q=${encodeURIComponent('retry loop land.sh')}&scope=minions`, { headers: { Cookie: cookie } })).json()).hits ?? [];
  for (let i = 0; i < 100 && !(await hits()).some((h: any) => h.ticket_id === joshWork.id); i++) await new Promise((r) => setTimeout(r, 100));

  const twin = await start(Shared.id, 'Fix the retry loop in land.sh after a refused push');
  const heard = await until(() => mail(overlord.id), (m) => m.some((t) => t.includes(`#${twin.number}`)));
  assert.ok(heard.some((t) => t.startsWith(`Cara started #${twin.number} `)), heard.join('\n'));
  const [card] = await until(() => cards(overlord.id), (c) => c.length > 0);
  assert.ok(card, 'a card for the look-alike');
  const q = card.questions[0];
  assert.match(q.question, new RegExp(`Cara started #${twin.number} .*Josh's #${joshWork.number} `));
  assert.equal(q.options.find((o: any) => o.recommended).label, 'Both stay');
  assert.equal(card.to, undefined, 'any member answers it');

  // A start that reads like nothing still reaches it, with no card.
  const other = await start(Shared.id, 'Paint the rail a calmer blue');
  await until(() => mail(overlord.id), (m) => m.some((t) => t.includes(`#${other.number}`)));
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(cards(overlord.id).length, 1);

  // A scheme nobody else is in has no Overlord apart from its Taskmaster: no line for its own starts.
  const solo = await start(Solo.id, 'Retry loop in land.sh after a refused push');
  await new Promise((r) => setTimeout(r, 500));
  assert.ok(!mail(soloTm.id).some((t) => t.includes(`#${solo.number}`)));
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
