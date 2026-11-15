import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { takeStatus } from '../src/status-trailer.ts';
import { bootServer, until, type Booted } from './helpers.ts';

// The status trailer (#711): the final reply's last line sets state, note and replies, in place of a lone set_thread_status call.

test('takes the trailer off the end and reads its fields', () => {
  const r = takeStatus('Shipped abc123.\n\n<!-- status: {"state":"ready","note":"merge it","replies":["Merge it"]} -->\n');
  assert.equal(r.text, 'Shipped abc123.');
  assert.deepEqual(r.status, { state: 'ready', note: 'merge it', replies: ['Merge it'] });
  assert.equal(r.bad, null);
});

test('a reply without a trailer comes back untouched', () => {
  const text = 'Done.\n<!-- an ordinary comment -->\n';
  assert.deepEqual(takeStatus(text), { text, status: null, bad: null });
});

test('the last trailer wins, title and build are left to the tool, and backticks around it go too', () => {
  const r = takeStatus('A\n<!-- status: {"state":"blocked"} -->\nB\n`<!-- status: {"state":null,"note":"waiting","title":"X","build":3} -->`');
  assert.equal(r.text, 'A\nB');
  assert.deepEqual(r.status, { state: null, note: 'waiting' });
});

test('a malformed trailer is still hidden, and says why it was ignored', () => {
  const r = takeStatus('Done.\n<!-- status: {state: ready} -->');
  assert.equal(r.text, 'Done.');
  assert.equal(r.status, null);
  assert.match(r.bad!, /not JSON/);
  assert.match(takeStatus('<!-- status: {"colour":"red"} -->').bad!, /no state, note or replies/);
});

// Through the server: a stand-in claude replies with whatever reply.txt holds, as one message, then ends the turn.
const root = mkdtempSync(join(tmpdir(), 'status-trailer-'));
const replyFile = join(root, 'reply.txt');
const fake = join(root, 'claude-fake');
writeFileSync(fake, `#!${process.execPath}
const text = require('node:fs').readFileSync(${JSON.stringify(replyFile)}, 'utf8');
process.stdin.once('data', () => {
  console.log(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }));
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text }));
  process.exit(0);
});
`);
chmodSync(fake, 0o755);

let srv: Booted;
let ticketId = 0;
before(async () => {
  srv = await bootServer({ root, env: { CLAUDE_BIN: fake, NODE_NO_WARNINGS: '1' } });
  const project = (await srv.call('/api/projects', { name: 'Scheme' })).data;
  writeFileSync(replyFile, 'Hello.');
  const created = (await srv.call(`/api/projects/${project.id}/tickets`, { message: 'start' })).data;
  ticketId = (created.ticket ?? created).id;
  await idle();
});
after(async () => {
  await srv?.stop();
  rmSync(root, { recursive: true, force: true });
});

const ticket = async () => (await srv.call(`/api/tickets/${ticketId}`)).data.ticket;
const events = async () => (await srv.call(`/api/tickets/${ticketId}/events?after=0`)).data as any[];
const replies = async () => (await events()).filter((e) => e.kind === 'claude' && JSON.parse(e.data).type === 'assistant').map((e) => JSON.parse(e.data).message.content.map((b: any) => b.text).join(''));
const notes = async () => (await events()).filter((e) => e.kind === 'note').map((e) => JSON.parse(e.data).text as string);
const idle = () => until('the turn to end', async () => (await ticket()).status === 'idle');

async function turn(reply: string) {
  writeFileSync(replyFile, reply);
  const before = (await events()).filter((e) => e.kind === 'claude' && JSON.parse(e.data).type === 'result').length;
  await srv.call(`/api/tickets/${ticketId}/messages`, { text: 'go on' });
  await until('the turn to end', async () => (await ticket()).status === 'idle'
    && (await events()).filter((e) => e.kind === 'claude' && JSON.parse(e.data).type === 'result').length > before);
}

test('the reply is shown without its trailer, and the state, note and replies are set as the tool would', async () => {
  await turn('Shipped it.\n<!-- status: {"state":"ready","note":"merge when you like","replies":["Merge it"]} -->');
  assert.equal((await replies()).at(-1), 'Shipped it.');
  const t = await ticket();
  assert.equal(t.state, 'ready');
  assert.equal(t.note, 'merge when you like');
  assert.deepEqual(t.replies, ['Merge it']);
  assert.ok(!(await events()).some((e) => e.data.includes('<!-- status')), 'no stored event keeps the trailer');
});

test('a turn without a trailer leaves the state cleared, as every turn start does', async () => {
  await turn('Just an answer.');
  assert.equal((await replies()).at(-1), 'Just an answer.');
  assert.equal((await ticket()).state, null);
});

test('a trailer the checks refuse is noted, and the state stays cleared', async () => {
  await turn('All done.\n<!-- status: {"state":"complete"} -->');
  assert.equal((await replies()).at(-1), 'All done.');
  assert.equal((await ticket()).state, null);
  assert.ok((await notes()).some((n) => /status line was refused: State complete needs a note/.test(n)));
});
