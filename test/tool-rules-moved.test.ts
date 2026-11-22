import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { after, before, test } from 'node:test';
import { Auth } from '../src/auth.ts';
import { Store } from '../src/db.ts';
import { closeSelfResult, handOffResult } from '../src/mcp.ts';
import { untaggedFence } from '../src/routes/tickets.ts';
import { bootServer, PASSWORD, REPO, SECRET, tempRoot, type Booted } from './helpers.ts';

// #1575 (moves 9 to 12 of #1277's prompt ablation; Cara, 2026-11-22, "Moving"): ask_question, message_coordinator,
// hand_off_land and close_self keep only their first sentence up front, and each other rule moved to the result or
// refusal where the job meets it. These pin every moved rule in its new home, so none is lost in a later edit.
const tmp = tempRoot('tool-rules-moved-');
const data = join(tmp.dir, 'data');
mkdirSync(data, { recursive: true });
const store = new Store(join(data, 'coordinator.db'));
const Citadel = store.createProject('Citadel', null);
store.createTicket({ project_id: Citadel.id, kind: 'coordinator', title: 'Taskmaster', permission_mode: 'default', created_by: 'Cara' });
const newMinion = (title: string) => store.createTicket({ project_id: Citadel.id, kind: 'ticket', title, permission_mode: 'default', created_by: 'Cara' });
const Minion = newMinion('Some work');

const tokens = new Auth(PASSWORD, SECRET);
let srv: Booted;
before(async () => {
  srv = await bootServer({ root: tmp.dir });
});
after(async () => {
  await srv?.stop();
  await tmp.teardown();
});

async function tool(ticket: { id: number }, name: string, args: object): Promise<{ isError?: boolean; text: string }> {
  const child = tmp.spawn(process.execPath, [join(REPO, 'src', 'mcp.ts')], {
    env: {
      ...process.env, COORDINATOR_API: srv.base, COORDINATOR_TOKEN: tokens.agentToken(ticket.id),
      COORDINATOR_PROJECT: String(Citadel.id), COORDINATOR_TICKET: String(ticket.id), COORDINATOR_ROLE: 'thread', COORDINATOR_APP_INSTRUCTIONS: '1',
    },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  try {
    const reply = new Promise<any>((resolve) => createInterface({ input: child.stdout }).once('line', (l) => resolve(JSON.parse(l))));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) + '\n');
    const r = (await reply).result;
    return { isError: r.isError, text: r.content[0].text };
  } finally {
    child.kill();
  }
}

const refused = (r: { isError?: boolean; text: string }, re: RegExp) => {
  assert.equal(r.isError, true, r.text);
  assert.match(r.text, re);
};
const ok = (r: { isError?: boolean; text: string }) => {
  assert.ok(!r.isError, r.text);
  return r.text;
};
const opts = [{ label: 'Tabs' }, { label: 'List', recommended: true }];

test('ask_question: a plain card says to end the turn, how to link it ("below", "above"), and that later cards join it', async () => {
  const said = ok(await tool(newMinion('Cards'), 'ask_question', { questions: [{ question: 'Tabs or a list?', options: opts }] }));
  assert.match(said, /End your turn now with a short reply; the answers will come as the next message/);
  assert.match(said, /\[the card below\]\(#\/p\/\d+\/t\/\d+\?e=\d+\) \("below" this turn, "above" later\)/);
  assert.match(said, /A plain card you ask later this turn, while this one is still unanswered, joins it \(up to 8 questions in all\), so people see one card with one Send/);
  // A ship card never joins another, so it doesn't say so.
  assert.doesNotMatch(ok(await tool(newMinion('Ship card'), 'ask_question', { questions: [{ question: 'Ship it?', options: [{ label: 'Ship', recommended: true }, { label: 'Wait' }] }], kind: 'ship' })), /joins it/);
});

test('ask_question: doc or secret with questions is refused, saying to pass it alone', async () => {
  const q = [{ question: 'Which look?', options: opts }];
  refused(await tool(Minion, 'ask_question', { questions: q, doc: 'mockups/looks.html' }), /Pass doc or questions, not both: a choices page \(citadel:docs-and-mocks\) asks on its own page, and its Send settles the card/);
  refused(await tool(Minion, 'ask_question', { questions: q, secret: { name: 'KEY' } }), /Pass secret or questions, not both: a secret card is one masked field for a password, API key or token/);
});

test("ask_question: a secret card's answer says the value is used without printing it", async () => {
  const said = ok(await tool(newMinion('Secret'), 'ask_question', { secret: { name: 'SOME_KEY', why: 'To sign in' } }));
  assert.match(said, /\$CITADEL_SECRET_<NAME>: use it in commands without ever printing it/);
});

test('ask_question: a missing recommendation says exactly one, any number on multiSelect', async () => {
  refused(await tool(Minion, 'ask_question', { questions: [{ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }] }), /needs a recommended option: set "recommended": true on the one you would pick \(exactly one; any number on a multiSelect question\)/);
});

test('ask_question: a command block with no shell tag is refused with the tags and the no-placeholder rule; a tagged one posts', async () => {
  const bare = 'Run this?\n```\nsystemctl --user restart x\n```';
  refused(await tool(Minion, 'ask_question', { questions: [{ question: bare, options: opts }] }), /code block with no tag\. A command people run goes in a fenced block tagged with where it runs \(```powershell, ```powershell-admin, ```wsl, ```fish, ```bash, ```cmd\).*Copy button.*no <placeholder> but a secret/);
  refused(await tool(Minion, 'ask_question', { questions: [{ question: 'Which?', options: [{ label: 'A', description: '```\nls\n```', recommended: true }, { label: 'B' }] }] }), /Question 1 has a code block with no tag/);
  ok(await tool(newMinion('Tagged'), 'ask_question', { questions: [{ question: 'Run this?\n```fish\nsystemctl --user restart x\n```', options: opts }] }));
});

test('untaggedFence reads only opening fences', () => {
  assert.equal(untaggedFence('```fish\nls\n```'), false);
  assert.equal(untaggedFence('```fish\nls\n```\nthen\n```bash\npwd\n```'), false);
  assert.equal(untaggedFence('```\nls\n```'), true);
  assert.equal(untaggedFence('```wsl\nls\n```\n```\npwd\n```'), true);
  assert.equal(untaggedFence('no code at all, `inline` only'), false);
  // A longer fence holds shorter ones as its text, tagged or not, until a bare fence as long closes it.
  assert.equal(untaggedFence('````md\n```bash\nx\n```\n````'), false);
  assert.equal(untaggedFence('````md\n```\nx\n```\n````\n```\nls\n```'), true);
});

test("ask_question: a repeat card's refusal says to retry with not_duplicate", async () => {
  const t = newMinion('Twins');
  const q = { questions: [{ question: 'Ship the new rail?', options: opts }] };
  ok(await tool(t, 'ask_question', q));
  refused(await tool(t, 'ask_question', q), /Not posted: a card asking the same is still open.*If it is a different question, call ask_question again with not_duplicate: true/);
});

test('message_coordinator: a fyi says what a fyi is, never shipped or acknowledgements; a start names start_after', async () => {
  const fyi = ok(await tool(newMinion('Fyi'), 'message_coordinator', { need: 'fyi', text: 'Tracking: the CI run is slow today.' }));
  assert.match(fyi, /it shows in the Taskmaster's chat now, and the Taskmaster reads it on its next turn, whoever wakes it/);
  assert.match(fyi, /If you need anything done it is not a fyi, so send it again with the need that fits/);
  assert.match(fyi, /Never send that you shipped or are live \(the server's shipped line already tells it\), nor acknowledgements or progress/);
  const start = ok(await tool(newMinion('Start'), 'message_coordinator', { need: 'start', text: 'Please start the handoff at handoffs/x.md.' }));
  assert.match(start, /create_ticket's start_after when the work is planned/);
  assert.doesNotMatch(start, /not a fyi/);
  const ask = ok(await tool(newMinion('Ask'), 'message_coordinator', { need: 'ask', text: 'Which model for the next step?' }));
  assert.doesNotMatch(ask, /start_after|not a fyi/);
  // Whatever the need, the result says never to report shipping, acknowledgements or progress.
  assert.match(ask, /Never send that you shipped or are live/);
  // A start left as held mail still names start_after.
  assert.match(ok(await tool(newMinion('Held start'), 'message_coordinator', { need: 'start', wake: false, text: 'Please start handoffs/y.md.' })), /Left as held mail.*start_after/);
});

test("hand_off_land's answer says what happens next, never parks, and what to do on a failure", () => {
  const said = handOffResult({}, [], true);
  assert.match(said, /End your turn now with a short reply and set no state \(the server shows you as shipping until it ends\)/);
  assert.match(said, /posts the shipped line and dismisses this minion \(or sets pending-deploy for a restart\) on a clean land; it never seals you/);
  assert.match(said, /If it fails \(a conflict, even once main moves while it waits; a red test; a refusal; a failed deploy\), you are woken with the end of its output: fix it and hand it off again/);
  assert.doesNotMatch(handOffResult({}, [], false), /pending-deploy/);
  assert.match(handOffResult({ stay_open: true }, [], true), /leaves this minion open \(stay_open\)/);
  const app = handOffResult({}, ['peek-auras'], false);
  assert.match(app, /then deploys peek-auras; the shipped line says if it went live, so never call deploy_contraption or ask for a redeploy/);
  assert.doesNotMatch(handOffResult({ deploy: false }, ['peek-auras'], false), /deploys/);
  assert.doesNotMatch(handOffResult({ into: 'build/3' }, ['peek-auras'], false), /deploys/);
});

test("close_self's answer says when it is skipped, what is kept, and to leave the close out of the reply", () => {
  const said = closeSelfResult(false);
  assert.match(said, /unless the turn doesn't finish cleanly or a new message arrives first \(a GitHub notice that needs no action doesn't count\); its worktree and branch are kept, and a message reopens it/);
  assert.match(said, /Leave the close out of your reply, since the server shows the dismissal and a new message can still skip it/);
  assert.match(said, /a state of complete, try or ready there \(or a card posted after this call\) cancels the close/);
  assert.match(said, /Finish your reply now/);
});

test("close_self's refusal with a card open says to leave it open and say why in the reply", async () => {
  const t = newMinion('Close with a card');
  ok(await tool(t, 'ask_question', { questions: [{ question: 'Keep the old menu?', options: opts }] }));
  refused(await tool(t, 'close_self', {}), /Not dismissed: a question card .* is still waiting on people\. Leave the minion open for them;.*If it stays open, say why in your reply/);
});

test('the four descriptions are one sentence each, and "put it first" lives in the recommended flag', () => {
  const input = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n';
  const r = spawnSync(process.execPath, ['src/mcp.ts'], { input, encoding: 'utf8', env: { ...process.env, COORDINATOR_ROLE: 'thread', COORDINATOR_PROJECT: '1', COORDINATOR_TICKET: '1', COORDINATOR_APP_INSTRUCTIONS: '', COORDINATOR_DEPLOYS: '1' } });
  const tools = JSON.parse(r.stdout.split('\n')[0]).result.tools;
  for (const name of ['ask_question', 'message_coordinator', 'hand_off_land', 'close_self']) {
    const d = tools.find((t: any) => t.name === name).description;
    // One sentence: its only full stop ends it (close_self's first sentence carries a parenthesis with a colon).
    assert.equal(d.replace(/\([^)]*\)/g, '').split(/\.(\s|$)/).filter((x: string) => x.trim()).length, 1, `${name}: ${d}`);
  }
  const ask = tools.find((t: any) => t.name === 'ask_question');
  const option = ask.inputSchema.properties.questions.items.properties.options.items.properties;
  assert.match(option.recommended.description, /listed first/);
  assert.match(option.image.description, /pictured options show as a gallery/);
  // A start that waits on a ship must say so in the message itself, so start_after is read before the send (#1573's move10 case).
  assert.match(tools.find((t: any) => t.name === 'message_coordinator').inputSchema.properties.need.description, /start: start a minion \(one that waits on a ship: name it, for create_ticket's start_after\)/);
});
