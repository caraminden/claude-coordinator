// Closing saves one word for why (#1989; Josh, 2026-11-25, "Save one word"): a minion's own close and the Taskmaster's say
// it, a person's one click doesn't and can set it after, and a close that never came leaves none. In a scheme that isn't Citadel.
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { agentToken, type Booted, bootServer, fakeClaude, jsonLines, PROMPT_AND_TOKEN, tempRoot, until } from './helpers.ts';

const tmp = tempRoot('closed-as-');
const log = join(tmp.dir, 'turns.jsonl');
const release = join(tmp.dir, 'release');
const fake = fakeClaude(tmp.dir, { log: { path: log, record: PROMPT_AND_TOKEN }, release });
let srv: Booted;
let project: { id: number };
before(async () => {
  srv = await bootServer({ root: tmp.dir, env: { CLAUDE_BIN: fake, CITADEL_ZONE: 'America/Los_Angeles' } });
  project = (await srv.call('/api/projects', { name: 'Peek Auras' })).data;
});
after(async () => {
  await srv?.stop();
  await tmp.teardown();
});

const get = async (id: number) => (await srv.call(`/api/tickets/${id}`)).data.ticket;
/** A new minion, mid-turn, and its turn's token. */
async function minion() {
  rmSync(release, { force: true });
  const t = (await srv.call(`/api/projects/${project.id}/tickets`, { message: 'hi', properties: { type: 'feature' } })).data as { id: number };
  return { id: t.id, token: await turn(t.id) };
}
const turn = async (id: number) => {
  const mine = () => jsonLines(log).filter((l) => l.token.startsWith(`${id}.`));
  const token = (await until('its turn to start', () => mine().at(-1)?.token)) as string;
  await until('the server to follow it', async () => (await get(id)).status === 'running');
  return token;
};
const end = async (id: number) => {
  writeFileSync(release, '');
  await until('its turn to end', async () => (await get(id)).status !== 'running');
};
const close = (m: { id: number; token: string }, body: object) => srv.as({ token: m.token })(`/api/tickets/${m.id}/close`, body);

test('a minion’s own close says why, and an unknown word refuses the close and saves none', async () => {
  const m = await minion();
  assert.equal((await close(m, { as: 'lost' })).status, 400);
  assert.equal((await get(m.id)).closing ?? false, false);
  assert.equal((await close(m, { reason: 'two others have it', as: 'replaced' })).status, 202);
  await end(m.id);
  const t = await get(m.id);
  assert.deepEqual([t.status, t.properties.closedAs, t.properties.stage], ['closed', 'replaced', 'done']);
  // A message reopens it: it is closed as nothing until it closes again.
  rmSync(release, { force: true });
  await srv.call(`/api/tickets/${m.id}/messages`, { text: 'one more thing' });
  await until('it to run again', async () => (await get(m.id)).status === 'running');
  assert.equal((await get(m.id)).properties.closedAs, undefined);
  await end(m.id);
});

test('a close that its turn’s stop calls off leaves no word for whoever closes it next', async () => {
  const m = await minion();
  assert.equal((await close(m, { as: 'replaced' })).status, 202);
  assert.ok((await srv.call(`/api/tickets/${m.id}/stop`, {})).status < 300);
  await until('it to stop', async () => (await get(m.id)).status !== 'running');
  assert.notEqual((await get(m.id)).status, 'closed');
  assert.equal((await srv.call(`/api/tickets/${m.id}/status`, { status: 'closed' })).status, 200);
  assert.deepEqual([(await get(m.id)).status, (await get(m.id)).properties.closedAs], ['closed', undefined]);
});

test('a close refused because a card waits saves no word', async () => {
  const m = await minion();
  const asked = await srv.as({ token: m.token })(`/api/tickets/${m.id}/questions`, { questions: [{ question: 'Keep it?', options: [{ label: 'A', recommended: true }, { label: 'B' }] }] });
  assert.ok(asked.status < 300, JSON.stringify(asked.data));
  assert.equal((await close(m, { as: 'done' })).status, 409);
  assert.equal((await get(m.id)).properties.closedAs, undefined);
  await end(m.id);
});

test('a person closes in one click with no word, and sets one after; the Taskmaster’s close says it', async () => {
  const m = await minion();
  await end(m.id);
  assert.equal((await srv.call(`/api/tickets/${m.id}/status`, { status: 'closed' })).status, 200);
  assert.equal((await get(m.id)).properties.closedAs, undefined);
  assert.equal((await srv.call(`/api/tickets/${m.id}/properties`, { properties: { closedAs: 'dropped' } }, 'PUT')).status, 200);
  assert.equal((await get(m.id)).properties.closedAs, 'dropped');

  const n = await minion();
  await end(n.id);
  const tm = (await srv.call(`/api/projects/${project.id}`)).data.coordinator.id as number;
  const as = srv.as({ token: agentToken(srv.data, tm) });
  const no = await as(`/api/tickets/${n.id}/status`, { status: 'closed', as: 'nope' });
  assert.equal(no.status, 400, JSON.stringify(no.data));
  assert.equal((await get(n.id)).status, 'idle');
  assert.equal((await as(`/api/tickets/${n.id}/status`, { status: 'closed', as: 'dropped' })).status, 200);
  assert.deepEqual([(await get(n.id)).status, (await get(n.id)).properties.closedAs], ['closed', 'dropped']);
  // Said again on a closed one, it changes the word.
  assert.equal((await as(`/api/tickets/${n.id}/status`, { status: 'closed', as: 'replaced' })).status, 200);
  assert.equal((await get(n.id)).properties.closedAs, 'replaced');
});

test('the Flow tab’s read carries the word', async () => {
  const v = (await srv.call(`/api/projects/${project.id}/flow`)).data as { minions: { end: string; why: string | null }[] };
  assert.ok(v.minions, JSON.stringify(v));
  // Its word is its ending, in a scheme with no repo too.
  assert.deepEqual(
    v.minions
      .map((m) => [m.end, m.why])
      .filter(([, why]) => why)
      .sort(),
    [
      ['why', 'dropped'],
      ['why', 'replaced'],
    ],
  );
});
