// A press of Explain on a running minion (#1994): it runs a one-shot Haiku call on the presser's own login, beside the
// minion, and leaves the minion's session, chat, turn and folder as they were; the reading is kept for everyone.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { agentToken, bootServer, mintedAgentToken, tempRoot } from './helpers.ts';
import { until } from './wait.ts';

const tmp = tempRoot('time-log-explain-route-');
const root = tmp.dir;
const srvP = (async () => {
  // A stand-in Claude. A turn (stream-json) starts, says one line and keeps running; the Explain call writes down how
  // it was run and answers a reading resting on label e1.
  const claude = join(root, 'fake-claude');
  const seen = join(root, 'explain-calls');
  writeFileSync(
    claude,
    `#!/bin/sh
case "$*" in *stream-json*)
  printf '%s\\n' '{"type":"system","subtype":"init","session_id":"turn-session"}'
  printf '%s\\n' '{"type":"assistant","session_id":"turn-session","message":{"content":[{"type":"text","text":"Reading the parser to find the bug now."}]}}'
  exec sleep 600;;
esac
{ printf 'cwd %s\\n' "$PWD"; for a in "$@"; do printf 'arg %s\\n' "$a"; done; } >> ${seen}
cat > ${seen}-stdin
grep -q 'Break the parser' ${seen}-stdin && { echo 'API Error: 529 overloaded' >&2; exit 1; }
printf '%s' '{"type":"result","is_error":false,"total_cost_usd":0.0031,"result":"{\\"parts\\":[{\\"part\\":\\"P1\\",\\"lines\\":[{\\"text\\":\\"It read the parser to find the bug.\\",\\"kind\\":\\"work\\",\\"evidence\\":[\\"e1\\"]},{\\"text\\":\\"It read for 4 minutes.\\",\\"kind\\":\\"work\\",\\"evidence\\":[\\"e1\\"]}]}]}"}'
`,
  );
  chmodSync(claude, 0o755);
  const srv = await bootServer({ root, env: { CLAUDE_BIN: claude } });
  return { srv, seen };
})();
after(async () => {
  await (await srvP).srv.stop();
  await tmp.teardown();
});

test('Explain on a running minion: Haiku on the presser login, the minion untouched, the reading kept for everyone', async () => {
  const { srv, seen } = await srvP;
  const { data: p } = await srv.call('/api/projects', { name: 'Other scheme' });
  const { data: m } = await srv.call(`/api/projects/${p.id}/tickets`, { message: 'Fix the parser', properties: { type: 'chore' } });
  const ticket = async () => (await srv.call(`/api/tickets/${m.id}`)).data.ticket;
  const events = async () => {
    const d = (await srv.call(`/api/tickets/${m.id}/events`)).data;
    return (Array.isArray(d) ? d : d.events) as { id: number; kind: string; data: unknown }[];
  };
  await until('the turn running and its line in', async () => (await ticket()).status === 'running' && (await events()).some((e) => JSON.stringify(e.data).includes('Reading the parser')));
  // A message waits in its queue behind the running turn.
  assert.equal((await srv.call(`/api/tickets/${m.id}/messages`, { text: 'and then this', after: true })).status, 202);
  await until('the message queued', async () => (await ticket()).queued === 1);
  const before = { t: await ticket(), events: (await events()).map((e) => e.id) };
  assert.equal(before.t.session_id, 'turn-session');
  const dir = before.t.dir as string | null;
  const files = dir && existsSync(dir) ? readdirSync(dir).sort() : null;

  // Only a person presses it.
  await mintedAgentToken(join(root, 'data'), m.id);
  const asMinion = srv.as({ token: agentToken(join(root, 'data'), m.id) });
  assert.equal((await asMinion(`/api/tickets/${m.id}/time-log/explain`, {}, 'POST')).status, 403);

  const press = await srv.call(`/api/tickets/${m.id}/time-log/explain`, {});
  assert.equal(press.status, 200, JSON.stringify(press.data));
  const lines = Object.values(press.data.explain.parts as Record<string, { text: string; ev: number[] }[]>).flat();
  assert.deepEqual(
    lines.map((l) => l.text),
    ['It read the parser to find the bug.'],
    'the line that states a length is dropped',
  );
  assert.ok(before.events.includes(lines[0].ev[0]), 'its evidence is a real event of the chat');
  assert.deepEqual(
    press.data.explain.presses.map((x: { by: string; cost: number }) => [x.by, x.cost]),
    [['Cara', 0.0031]],
  );

  // How it ran: Haiku, no tools, no settings or MCP, no session kept or resumed, in the presser's scratch folder.
  const calls = readFileSync(seen, 'utf8');
  const args = calls
    .split('\n')
    .filter((l) => l.startsWith('arg '))
    .map((l) => l.slice(4));
  for (const a of ['-p', '--no-session-persistence', '--strict-mcp-config']) assert.ok(args.includes(a), a);
  assert.equal(args[args.indexOf('--model') + 1], 'haiku');
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.equal(args[args.indexOf('--setting-sources') + 1], '');
  assert.ok(!args.some((a) => /^--(resume|continue|session-id|fork-session)$/.test(a)), args.join(' '));
  const cwd = /^cwd (.*)$/m.exec(calls)![1];
  assert.match(cwd, /time-log-explain$/);
  if (dir) assert.ok(!cwd.startsWith(dir), "not in the minion's folder");
  assert.match(readFileSync(`${seen}-stdin`, 'utf8'), /\[e\d+\] .*The minion wrote: "Reading the parser/);

  // The minion as it was: its turn still running on its own session, nothing new in its chat, its folder alone.
  const now = await ticket();
  assert.equal(now.status, 'running');
  assert.equal(now.session_id, 'turn-session');
  assert.equal(now.queued, 1, 'the queued message still waits');
  assert.deepEqual(
    (await events()).map((e) => e.id),
    before.events,
    'no event added to the chat',
  );
  if (files) assert.deepEqual(readdirSync(dir!).sort(), files);

  // Kept for everyone: another member of the scheme reads it with the log. Nothing new since, so a second press asks Haiku nothing.
  const made = (await srv.call('/api/people', { name: 'Josh' })).data;
  const invite = await fetch(`${srv.base}/api/invite/${made.token}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'a-long-password' }) });
  await srv.call(`/api/projects/${p.id}/members`, { person: made.person.id });
  const asJosh = srv.as({ cookie: invite.headers.get('set-cookie')!.split(';')[0] });
  const read = await asJosh(`/api/tickets/${m.id}/time-log`);
  assert.equal(read.status, 200, JSON.stringify(read.data));
  assert.deepEqual(read.data.explain.parts, press.data.explain.parts);
  assert.deepEqual(read.data.explain.presses[0].by, 'Cara');
  const again = await srv.call(`/api/tickets/${m.id}/time-log/explain`, {});
  assert.equal(again.status, 200);
  assert.deepEqual(again.data.explain.fresh, []);
  assert.equal(readFileSync(seen, 'utf8').match(/^cwd /gm)?.length, 1, 'Haiku ran once');

  // A press that fails leaves no reading and no marker behind: the step list stays and Retry can run at once.
  const { data: m2 } = await srv.call(`/api/projects/${p.id}/tickets`, { message: 'Break the parser', properties: { type: 'chore' } });
  await until('the second turn running', async () => (await srv.call(`/api/tickets/${m2.id}`)).data.ticket.status === 'running' && (await srv.call(`/api/tickets/${m2.id}/time-log`)).data.rows?.length > 0);
  const failed = await srv.call(`/api/tickets/${m2.id}/time-log/explain`, {});
  assert.equal(failed.status, 502, JSON.stringify(failed.data));
  const log2 = (await srv.call(`/api/tickets/${m2.id}/time-log`)).data;
  assert.equal(log2.explain.writing, null);
  assert.deepEqual(log2.explain.presses, []);
  assert.ok(log2.rows.length, 'the step list is still there');
});
