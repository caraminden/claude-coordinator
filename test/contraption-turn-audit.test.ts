// The contraption turn audit (#844, src/contraption-turns.ts): every turn's payload and reply, the verdict its app
// posts back, and who may read them: members of the contraption's home scheme, nobody else.
import assert from 'node:assert/strict';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { agentToken, bootServer, mintedAgentToken, tempRoot } from './helpers.ts';
import { agentEnv, mcpAgent } from './mcp-agent.ts';

const tmp = tempRoot('turn-audit-');
const root = tmp.dir;
after(() => tmp.teardown());
// A stand-in for claude: takes the prompt, streams a short reply with a tool call, ends.
const fake = join(root, 'claude-fake');
writeFileSync(
  fake,
  `#!${process.execPath}
const out = (o) => console.log(JSON.stringify(o));
require('node:readline').createInterface({ input: process.stdin }).once('line', (l) => {
  const prompt = JSON.parse(l).message.content.map((b) => b.text ?? '').join('');
  out({ type: 'system', subtype: 'init', session_id: '6f1c0f7e-1111-4222-8333-944445555666', tools: [], model: 'claude-haiku-test' });
  out({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm1' } } });
  out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'You said: ' } } });
  out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: prompt } } });
  out({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'You said: ' + prompt }, { type: 'tool_use', id: 't1', name: 'mcp__app__look', input: {} }] } });
  out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: false, content: 'TOOL RESULT TEXT' }] } });
  out({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', result: '', usage: { input_tokens: 1, output_tokens: 2 } });
  process.exit(0);
});
`,
);
chmodSync(fake, 0o755);

test('an app posts its verdict on a turn, and only members of its home scheme read the audit', { timeout: 60_000 }, async () => {
  const srv = await bootServer({ env: { CLAUDE_BIN: fake } });
  after(() => srv.stop());
  const me = (await srv.call('/api/me')).data;
  const alpha = (await srv.call('/api/projects', { name: 'Alpha' })).data.id;
  const bravo = (await srv.call('/api/projects', { name: 'Bravo' })).data.id;
  // Josh is in Alpha; Olive in no scheme.
  const person = async (name: string, password: string) => {
    const made = await srv.call('/api/people', { name });
    const invited = await fetch(`${srv.base}/api/invite/${made.data.token}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
    return { id: made.data.person.id as number, cookie: invited.headers.get('set-cookie')!.split(';')[0] };
  };
  const josh = await person('Josh', 'joshs-long-password');
  const olive = await person('Olive', 'olives-long-password');
  assert.equal((await srv.call(`/api/projects/${alpha}/members`, { person: josh.id })).status, 200);
  const as = (who: { cookie: string }, path: string) => fetch(srv.base + path, { headers: { Cookie: who.cookie } }).then(async (r) => ({ status: r.status, data: await r.json() }));

  // Two apps: one at home in Alpha, one in Bravo.
  const keyOf = async (name: string, home: number) => {
    const made = await srv.call('/api/contraptions', { name, title: name, port: name === 'voice' ? 9101 : 9102, default_model: 'haiku', home_scheme: home });
    assert.equal(made.status, 201);
    assert.equal((await srv.call(`/api/contraptions/${name}/people/${me.id}`, { enabled: true }, 'PUT')).status, 200);
    const { readFileSync } = await import('node:fs');
    return readFileSync(join(made.data.keys_dir, 'contraption.key'), 'utf8');
  };
  const voice = await keyOf('voice', alpha);
  const other = await keyOf('other', bravo);
  const api = (key: string, path: string, body: object) => fetch(srv.base + path, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const turnOf = async (key: string, body: object) => {
    const text = await (await api(key, '/api/contraptions/turns', { person: me.id, ...body })).text();
    const start = text.split('\n\n').find((b) => b.startsWith('event: start'))!;
    return JSON.parse(start.split('\n')[1].slice('data: '.length)).turn as number;
  };
  const id = await turnOf(voice, { session: 'ex-1', prompt: 'Read the vowel.', system: 'Word feedback for a voice exercise.', blind: true });
  const elsewhere = await turnOf(other, { session: 'o-1', prompt: 'Bravo words.' });

  // The verdict: pass or fallback with an optional reason, only on the app's own turns.
  const verdict = (key: string, turn: number, body: object) => api(key, `/api/contraptions/turns/${turn}/verdict`, body);
  assert.equal((await verdict(voice, id, { verdict: 'maybe' })).status, 400);
  assert.equal((await verdict(voice, id, { verdict: 'fallback', reason: 'x'.repeat(2001) })).status, 400);
  assert.equal((await verdict(voice, 999_999, { verdict: 'pass' })).status, 404);
  assert.equal((await verdict(voice, elsewhere, { verdict: 'pass' })).status, 404, "another app's turn");
  assert.equal((await verdict(voice, id, { verdict: 'fallback', reason: 'named a person' })).status, 200);

  // Josh, a member of Alpha, reads Alpha's turns: the payload as sent, the reply, blind, the verdict; no tool results.
  const read = await as(josh, `/api/projects/${alpha}/contraption-turns`);
  assert.equal(read.status, 200);
  assert.deepEqual(
    read.data.turns.map((t: any) => t.id),
    [id],
    "only Alpha's apps",
  );
  const row = read.data.turns[0];
  assert.equal(row.contraption, 'voice');
  assert.equal(row.person, 'Cara');
  assert.equal(row.prompt, 'Read the vowel.');
  assert.equal(row.system, 'Word feedback for a voice exercise.', "a blind turn's system text is the app's, whole");
  assert.equal(row.output, 'You said: Read the vowel.');
  assert.equal(row.blind, true);
  assert.deepEqual([row.verdict, row.verdict_reason], ['fallback', 'named a person']);
  assert.ok(!JSON.stringify(read.data).includes('TOOL RESULT TEXT'));
  assert.equal(typeof read.data.keep_days, 'number');

  // Olive is in neither scheme: Alpha's audit answers as if it didn't exist. Nor can an app read it with its key.
  assert.equal((await as(olive, `/api/projects/${alpha}/contraption-turns`)).status, 404);
  const byKey = await fetch(`${srv.base}/api/projects/${alpha}/contraption-turns`, { headers: { Authorization: `Bearer ${voice}` } });
  assert.notEqual(byKey.status, 200);
  // The admin reads Bravo's.
  assert.deepEqual(
    (await srv.call(`/api/projects/${bravo}/contraption-turns`)).data.turns.map((t: any) => t.id),
    [elsewhere],
  );

  // Alpha's Taskmaster reads Alpha's turns (Cara, 2026-11-16: "Taskmaster can read it"), not Bravo's; its minions don't.
  const tmOf = async (project: number) => {
    await srv.call(`/api/projects/${project}`);
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(join(srv.data, 'coordinator.db'), { readOnly: true, timeout: 30_000 });
    const row = db.prepare("SELECT id FROM tickets WHERE project_id = ? AND kind = 'coordinator'").get(project) as { id: number };
    db.close();
    return row.id;
  };
  const tmAlpha = await tmOf(alpha);
  const bearer = (id: number, path: string) => fetch(srv.base + path, { headers: { Authorization: `Bearer ${agentToken(srv.data, id)}` } });
  assert.equal((await bearer(tmAlpha, `/api/projects/${alpha}/contraption-turns`)).status, 200);
  assert.equal((await bearer(tmAlpha, `/api/projects/${bravo}/contraption-turns`)).status, 403, "another scheme's");
  const minion = (await srv.call(`/api/projects/${alpha}/tickets`, { message: 'A minion' })).data.id;
  // Its first turn mints its token after the send returns (#1808): one read sooner is refused as stale, not as a minion.
  await mintedAgentToken(srv.data, minion);
  assert.equal((await bearer(minion, `/api/projects/${alpha}/contraption-turns`)).status, 403, 'a minion');
  // Getting the app gave Alpha its weekly app turns check (#844); that check's current run reads the audit.
  const checks = (await srv.call(`/api/projects/${alpha}/schedules`)).data.schedules.filter((s: any) => s.template === 'app-turns');
  assert.equal(checks.length, 1);
  const { DatabaseSync } = await import('node:sqlite');
  const rw = new DatabaseSync(join(srv.data, 'coordinator.db'), { timeout: 30_000 });
  rw.prepare('UPDATE schedules SET last_ticket_id = ? WHERE id = ?').run(minion, checks[0].id);
  rw.close();
  assert.equal((await bearer(minion, `/api/projects/${alpha}/contraption-turns`)).status, 200, "the check's run");

  // Its contraption_turns tool: the turns as text, with the verdict and the payload.
  const tool = async (args: object) => {
    const agent = mcpAgent(agentEnv(srv.base, agentToken(srv.data, tmAlpha), { id: tmAlpha, project_id: alpha }, 'coordinator', { COORDINATOR_HOME_CONTRAPTIONS: 'voice' }), tmp.track);
    try {
      const r = await agent.rpc('tools/call', { name: 'contraption_turns', arguments: args });
      return r.result?.content?.[0]?.text ?? JSON.stringify(r);
    } finally {
      agent.close();
    }
  };
  const listed = await tool({});
  assert.match(listed, new RegExp(`^Turn ${id} · voice · for Cara · .* · blind · fell back: named a person$`, 'm'));
  assert.match(listed, /^Prompt: Read the vowel\.$/m);
  assert.match(listed, /^Output: You said: Read the vowel\.$/m);
  assert.ok(!listed.includes('Bravo words'));
  assert.match(await tool({ turn: id }), /^System: Word feedback for a voice exercise\.$/m);
  assert.match(await tool({ turn: elsewhere }), /No turn \d+ in this scheme/);
});
