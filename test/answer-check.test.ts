import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { answerCheck, answerHook, placeholderInCommand, processLine, proposalLine, readTurn } from '../kit/hooks/answer-check.ts';

// Fixture transcripts in Claude Code's JSONL shape: the prompt carries promptId, assistant entries don't.
const prompt = (text: string, promptId = 'p1') => ({ type: 'user', promptId, message: { role: 'user', content: [{ type: 'text', text }] } });
const call = (name: string, i: number) => [
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name, input: {} }] } },
  { type: 'user', promptId: 'p1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: 'ok' }] } },
];
const say = (text: string) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const calls = (names: string[]) => names.flatMap((n, i) => call(n, i));
const jsonl = (...entries: any[]) => entries.flat().map((e) => JSON.stringify(e)).join('\n') + '\n';
const steer = (text: string) => ({ type: 'attachment', attachment: { type: 'queued_command', prompt: [{ type: 'text', text }] } });
const notice = { type: 'attachment', attachment: { type: 'queued_command', prompt: '<task-notification>\n<task-id>a1</task-id>\n</task-notification>' } };

const FIVE = ['Read', 'Bash', 'Edit', 'Bash', 'Bash'];
const ANSWER = 'Shipped 1a2b3c4: the sidebar now shows phases. Tests: npm test green (412 pass). Risk low: front end only, one function. Live now; nothing waits on you, and the minion closes itself at the end of this turn.';
const PROPOSAL = `Audit done: three of the five hooks misfire.\n\n## Proposed fixes\n\n1. Count steers.\n2. Skip Grunts.\n3. Log once per prompt.\n\nThe full report is in reports/hooks.md and covers each hook's misfires with examples from the logs.`;

test('thin last message: five tool calls ending on a short remark or a colon is a hit; a full answer is not', () => {
  const hit = readTurn(jsonl(prompt('[Cara]: fix the sidebar'), calls(FIVE), say('Now the tests.')), 'p1');
  assert.deepEqual(answerCheck(hit), ['thin last message · 5 tool calls · "Now the tests."']);
  const colon = readTurn(jsonl(prompt('go'), calls(FIVE), say(`${ANSWER}\n\nHere is what changed:`)), 'p1');
  assert.match(answerCheck(colon)[0], /^thin last message/, 'a long text ending on a lead-in still hides the answer');
  assert.deepEqual(answerCheck(readTurn(jsonl(prompt('go'), calls(FIVE), say(ANSWER)), 'p1')), []);
  // Text mid-turn doesn't count as the answer: only the last text does.
  const early = readTurn(jsonl(prompt('go'), say(ANSWER), calls(FIVE), say('Landing it.')), 'p1');
  assert.equal(early.finalText, 'Landing it.');
  assert.equal(answerCheck(early).length, 1);
});

test('thin last message: a short answer to a quick question (few tool calls) is not a hit', () => {
  const quick = readTurn(jsonl(prompt('[Cara]: is it live?'), calls(['Bash', 'Bash']), say('Yes, live since 14:02 (c0ffee1).')), 'p1');
  assert.deepEqual(answerCheck(quick), []);
});

test('a turn a person steered mid-turn is not a hit; a Grunt\'s finish notice is no steer', () => {
  const steered = readTurn(jsonl(prompt('go'), calls(FIVE.slice(0, 3)), steer('[Cara]: stop, do the other one'), calls(FIVE.slice(0, 2)), say('Landing it.')), 'p1');
  assert.equal(steered.steered, true);
  assert.deepEqual(answerCheck(steered), []);
  const notified = readTurn(jsonl(prompt('go'), calls(FIVE.slice(0, 3)), notice, calls(FIVE.slice(0, 2)), say('Landing it.')), 'p1');
  assert.equal(notified.steered, false);
  assert.equal(answerCheck(notified).length, 1);
  // A message still queued when the turn stops cut it short too.
  const waiting = readTurn(jsonl(prompt('go'), calls(FIVE), say('Landing it.'), { type: 'queue-operation', operation: 'enqueue' }), 'p1');
  assert.deepEqual(answerCheck(waiting), []);
  const taken = readTurn(jsonl(prompt('go'), calls(FIVE), say('Landing it.'), { type: 'queue-operation', operation: 'enqueue' }, { type: 'queue-operation', operation: 'dequeue' }), 'p1');
  assert.equal(taken.steered, false, 'an enqueue the turn took in at once (its own prompt) is no steer');
  const limited = readTurn(jsonl(prompt('go'), calls(FIVE), { type: 'assistant', isApiErrorMessage: true, message: { model: '<synthetic>', content: [{ type: 'text', text: 'You\'ve hit your 5-hour limit' }] } }), 'p1');
  assert.deepEqual(answerCheck(limited), [], 'a usage limit cut it short');
  const stopped = readTurn(jsonl(prompt('go'), calls(FIVE), { type: 'user', promptId: 'p1', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } }), 'p1');
  assert.deepEqual(answerCheck(stopped), []);
});

test('only this prompt\'s turn counts: earlier turns\' tool calls and a compaction summary don\'t', () => {
  const t = jsonl(prompt('first'), calls(FIVE), say(ANSWER), prompt('[Cara]: and the colour?', 'p2'), call('Bash', 9), { type: 'user', promptId: 'p2', isCompactSummary: true, message: { content: 'This session is being continued…' } }, say('Done: it is teal now.'));
  assert.deepEqual(readTurn(t, 'p2').toolCalls, ['Bash']);
  assert.deepEqual(readTurn(t).toolCalls, ['Bash'], 'without a prompt id it starts at the last real prompt');
  assert.equal(readTurn(t, 'p2').steered, false);
});

test('proposal without a card: a proposing heading or lead-in with no card or message is a hit', () => {
  const bare = readTurn(jsonl(prompt('audit the hooks'), calls(FIVE), say(PROPOSAL)), 'p1');
  assert.deepEqual(answerCheck(bare), [`proposal without a card · "${PROPOSAL.replace(/\s+/g, ' ').slice(0, 120)}"`]);
  for (const action of ['mcp__thread__ask_question', 'mcp__thread__propose_plan', 'mcp__thread__message_coordinator', 'mcp__thread__create_ticket']) {
    assert.deepEqual(answerCheck(readTurn(jsonl(prompt('audit'), calls([...FIVE, action]), say(PROPOSAL)), 'p1')), [], action);
  }
  const linked = readTurn(jsonl(prompt('audit'), calls(FIVE), say(`${PROPOSAL}\n\nThe go waits in [the plan card above](#/p/2/t/475?e=399793).`)), 'p1');
  assert.deepEqual(answerCheck(linked), [], 'a card from an earlier turn, linked');
  // A report that sent the Taskmaster a handoff: no hit, few tool calls or many.
  const handedOff = readTurn(jsonl(prompt('audit'), calls(['Write', 'mcp__thread__message_coordinator']), say(PROPOSAL)), 'p1');
  assert.deepEqual(answerCheck(handedOff), []);
});

test('proposalLine reads headings, bold lines and lead-ins, not the words in passing', () => {
  assert.equal(proposalLine('## Next steps\n- a'), '## Next steps');
  assert.equal(proposalLine('**Recommendations**\n- a'), '**Recommendations**');
  assert.equal(proposalLine('Follow-ups I noticed:\n- a'), 'Follow-ups I noticed:');
  assert.equal(proposalLine('- Proposed fix: count steers'), '- Proposed fix: count steers');
  assert.equal(proposalLine('I recommend we leave it; the plan you approved covers it.'), null);
  assert.equal(proposalLine('Shipped the proposal card fix (#427). Risk low.'), null);
  assert.equal(proposalLine('Note: see https://example.com/next-steps'), null);
  assert.equal(proposalLine('[Proposal: account linking](/shared/specs/linking.md): the spec you asked for.'), null);
  assert.equal(proposalLine('Worth a follow-up minion (I didn\'t do it here): the old run-back text.'), 'Worth a follow-up minion (I didn\'t do it here): the old run-back text.');
});

test('answer hook: logs each hit as a would-refuse line and refuses nothing; the job check runs it only on a stop it lets through', () => {
  const shared = mkdtempSync(join(tmpdir(), 'answer-shared-'));
  const path = join(mkdtempSync(join(tmpdir(), 'answer-t-')), 't.jsonl');
  writeFileSync(path, jsonl(prompt('go'), calls(FIVE), say(PROPOSAL)));
  const input = { hook_event_name: 'Stop', session_id: 's1', prompt_id: 'p1', transcript_path: path, last_assistant_message: 'Now the tests.' };
  const env = { COORDINATOR_ROLE: 'thread', COORDINATOR_SHARED_DIR: shared };
  const lines = () => {
    try {
      return readdirSync(join(shared, 'retro-log'), { recursive: true }).filter((f) => String(f).endsWith('.md')).flatMap((f) => readFileSync(join(shared, 'retro-log', String(f)), 'utf8').split('\n').filter((l) => l.includes('would refuse')));
    } catch {
      return [];
    }
  };
  // Claude Code's last_assistant_message wins over the transcript.
  assert.deepEqual(answerHook(input, env), ['thin last message · 5 tool calls · "Now the tests."']);
  assert.equal(lines().length, 1);
  assert.match(lines()[0], / · would refuse · thin last message · 5 tool calls · "Now the tests\."$/);
  assert.deepEqual(answerHook(input, { COORDINATOR_SHARED_DIR: shared }), [], 'not a Citadel turn');
  assert.equal(answerHook(input, { ...env, COORDINATOR_ROLE: 'coordinator' }).length, 1, 'Taskmasters keep the rule too');

  // Through job-check.ts, as hooks.json runs it: a stop it refuses for a running job is no end of turn;
  // the third, which it lets through with the job still running, is.
  const script = (over: object) => spawnSync(process.execPath, [join(import.meta.dirname, '..', 'kit', 'hooks', 'job-check.ts')], { input: JSON.stringify({ ...input, session_id: 's2', ...over }), env: { ...process.env, ...env, TMPDIR: mkdtempSync(join(tmpdir(), 'answer-tmp-')) }, encoding: 'utf8' });
  const tmp = mkdtempSync(join(tmpdir(), 'answer-tmp-'));
  const run = (over: object) => spawnSync(process.execPath, [join(import.meta.dirname, '..', 'kit', 'hooks', 'job-check.ts')], { input: JSON.stringify({ ...input, session_id: 's3', ...over }), env: { ...process.env, ...env, TMPDIR: tmp }, encoding: 'utf8' });
  const job = { background_tasks: [{ id: 'b1', status: 'running', type: 'shell', description: 'tests' }] };
  const before = lines().length;
  assert.match(run(job).stdout, /"decision":"block"/);
  assert.match(run({ ...job, stop_hook_active: true }).stdout, /"decision":"block"/);
  assert.equal(lines().length, before, 'refused stops log nothing');
  const last = run({ ...job, stop_hook_active: true });
  assert.equal(last.status, 0);
  assert.equal(last.stdout, '', 'the trial prints no block');
  assert.equal(lines().length, before + 1, 'the stop that ends the turn is judged');
  const plain = script({});
  assert.equal(plain.stdout, '');
  assert.equal(lines().length, before + 2);
  assert.equal(script({ transcript_path: '/nonexistent/t.jsonl', last_assistant_message: undefined }).status, 0, 'fails open');
});

test('process line: a Process: line at the start of a line is logged as a process line; none and mid-line are not', () => {
  const shared = mkdtempSync(join(tmpdir(), 'answer-proc-'));
  const env = { COORDINATOR_ROLE: 'thread', COORDINATOR_SHARED_DIR: shared };
  const logged = () => {
    try {
      return readdirSync(join(shared, 'retro-log'), { recursive: true }).filter((f) => String(f).endsWith('.md')).flatMap((f) => readFileSync(join(shared, 'retro-log', String(f)), 'utf8').split('\n').filter((l) => l.includes(' · process · ')));
    } catch {
      return [];
    }
  };
  const run = (text: string, sid: string, over: object = {}) => answerHook({ session_id: sid, last_assistant_message: text, ...over }, env);
  run(`${ANSWER}\n\nRisk: low: one line.\nProcess: the X skill said Y`, 'a');
  assert.equal(logged().length, 1);
  assert.match(logged()[0], / · process · the X skill said Y$/);
  run(`${ANSWER}\nProcess: none`, 'b');
  run(`${ANSWER}\nProcess: none.`, 'b2');
  assert.equal(logged().length, 1, 'none logs nothing');
  run(`${ANSWER} The rule says Process: the skill Y is quoted.`, 'c');
  assert.equal(logged().length, 1, 'mid-line logs nothing');
  assert.equal(processLine('Process: none'), null);
  assert.equal(processLine('Process:  the Z doc  '), 'the Z doc');
});

test('placeholder in a command: a <name> in a shell-tagged block is a hit; redirects, heredocs and other blocks are not', () => {
  const block = (tag: string, body: string) => 'Run this:\n\n```' + tag + '\n' + body + '\n```\n';
  assert.equal(placeholderInCommand(block('powershell', "$u = '<the address the Machines page shows>'; iwr $u")), "$u = '<the address the Machines page shows>'; iwr $u");
  assert.ok(placeholderInCommand(block('bash', 'ssh <host> ls')));
  assert.ok(placeholderInCommand(block('powershell-admin', 'wsl --unregister <distro>')));
  assert.equal(placeholderInCommand(block('bash', 'cat <<EOF\nhi\nEOF\nmake 2>&1 | tee log\nsort <in >out\nfoo <in 2>err')), null);
  assert.equal(placeholderInCommand(block('json', '{"a": "<name>"}')), null);
  assert.equal(placeholderInCommand('Say <name> in prose, `<x>` inline.'), null);
  const hits = answerCheck({ toolCalls: [], finalText: block('fish', 'ssh <host>'), steered: false });
  assert.match(hits[0], /^placeholder in a command · "ssh <host>"/);
});

test('placeholder in a command inside an ask_question card counts, in the question and in an option description (#944)', () => {
  const ask = (question: string, description = '') => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__thread__ask_question', input: { questions: [{ question, options: [{ label: 'a', description }] }] } }] } });
  const prompt = JSON.stringify({ type: 'user', message: { content: 'go' } });
  const hit = (q: string, d?: string) => answerCheck(readTurn([prompt, ask(q, d)].join('\n')));
  assert.match(hit('Run this?\n```powershell-admin\nicacls <folder>\n```')[0], /^placeholder in a command · "icacls <folder>"/);
  assert.equal(hit('Run?', '```wsl\nls <dir>\n```').length, 1);
  assert.deepEqual(hit('Run this?\n```wsl\nls /tmp\n```'), []);
});
