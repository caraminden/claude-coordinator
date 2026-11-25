import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { answerCheck, answerHook, liveClaimCheck, liveClaims, placeholderInCommand, processLine, proposalLine, readTurn, shipReviewCheck, statusLineCheck, titleCheck } from '../kit/hooks/answer-check.ts';

// Fixture transcripts in Claude Code's JSONL shape: the prompt carries promptId, assistant entries don't.
const prompt = (text: string, promptId = 'p1') => ({ type: 'user', promptId, message: { role: 'user', content: [{ type: 'text', text }] } });
const call = (name: string, i: number) => [
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name, input: {} }] } },
  { type: 'user', promptId: 'p1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: 'ok' }] } },
];
const say = (text: string) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const calls = (names: string[]) => names.flatMap((n, i) => call(n, i));
const jsonl = (...entries: unknown[]) =>
  entries
    .flat()
    .map((e) => JSON.stringify(e))
    .join('\n') + '\n';
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

test("a turn a person steered mid-turn is not a hit; a Grunt's finish notice is no steer", () => {
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
  const limited = readTurn(jsonl(prompt('go'), calls(FIVE), { type: 'assistant', isApiErrorMessage: true, message: { model: '<synthetic>', content: [{ type: 'text', text: "You've hit your 5-hour limit" }] } }), 'p1');
  assert.deepEqual(answerCheck(limited), [], 'a usage limit cut it short');
  const stopped = readTurn(jsonl(prompt('go'), calls(FIVE), { type: 'user', promptId: 'p1', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } }), 'p1');
  assert.deepEqual(answerCheck(stopped), []);
});

test("a turn resuming a killed one starts at its prompt, past the interrupted call's result and Claude Code's own filler", () => {
  const filler = { type: 'assistant', isApiErrorMessage: false, message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'No response requested.' }] } };
  const cut = { type: 'user', promptId: 'p2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't0', is_error: true, content: "[Tool call interrupted: the session ended before this call's result was recorded]" }] } };
  const turn = readTurn(jsonl(prompt('first'), call('Edit', 0)[0], cut, filler, prompt('[System]: your last turn was killed', 'p2'), call('mcp__thread__hand_off_land', 1), say(ANSWER)), 'p2');
  assert.equal(turn.steered, false);
  assert.equal(turn.prompt, '[System]: your last turn was killed');
  assert.equal(shipReviewCheck(turn, '').length, 1, 'its unreviewed ship is logged');
});

test("only this prompt's turn counts: earlier turns' tool calls and a compaction summary don't", () => {
  const t = jsonl(prompt('first'), calls(FIVE), say(ANSWER), prompt('[Cara]: and the colour?', 'p2'), call('Bash', 9), { type: 'user', promptId: 'p2', isCompactSummary: true, message: { content: 'This session is being continued…' } }, say('Done: it is teal now.'));
  assert.deepEqual(readTurn(t, 'p2').toolCalls, ['Bash']);
  assert.deepEqual(readTurn(t).toolCalls, ['Bash'], 'without a prompt id it starts at the last real prompt');
  assert.equal(readTurn(t, 'p2').steered, false);
});

test('proposal without a card: a proposing heading or lead-in with no card or message is a hit', () => {
  const bare = readTurn(jsonl(prompt('audit the hooks'), calls(FIVE), say(PROPOSAL)), 'p1');
  assert.deepEqual(answerCheck(bare), [
    `proposal without a card · matched "${PROPOSAL.split('\n')
      .map((l) => l.trim())
      .find((l) => proposalLine(l))}" · "${PROPOSAL.replace(/\s+/g, ' ').slice(0, 120)}"`,
  ]);
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
  assert.equal(proposalLine("Worth a follow-up minion (I didn't do it here): the old run-back text."), "Worth a follow-up minion (I didn't do it here): the old run-back text.");
});

test('proposalLine skips only an anchored none, nothing or no after the colon', () => {
  for (const t of ['Follow-ups: none.', 'Follow-ups: none', '- Next steps: nothing', '**Follow-ups:** none', 'Recommendation: no.']) assert.equal(proposalLine(t), null, t);
  for (const t of ['No objections, proposal: ship it', 'Follow-ups: nothing blocks the rest, but do X', 'Next steps: none of these are done', 'Proposal: no more than three']) assert.notEqual(proposalLine(t), null, t);
});

test('every propose_ tool counts as a card', () => {
  for (const tool of ['propose_machine_lend', 'mcp__thread__propose_host_tool', 'mcp__thread__propose_memory', 'mcp__thread__propose_machine_notes']) {
    assert.deepEqual(answerCheck(readTurn(jsonl(prompt('audit'), calls([...FIVE, tool]), say(PROPOSAL)), 'p1')), [], tool);
  }
  assert.notDeepEqual(answerCheck(readTurn(jsonl(prompt('audit'), calls([...FIVE, 'mcp__thread__reproposed_x']), say(PROPOSAL)), 'p1')), []);
});

test('answer hook: logs each hit as a would-refuse line and refuses nothing; the job check runs it only on a stop it lets through', () => {
  const shared = mkdtempSync(join(tmpdir(), 'answer-shared-'));
  const path = join(mkdtempSync(join(tmpdir(), 'answer-t-')), 't.jsonl');
  writeFileSync(path, jsonl(prompt('go'), calls(FIVE), say(PROPOSAL)));
  const input = { hook_event_name: 'Stop', session_id: 's1', prompt_id: 'p1', transcript_path: path, last_assistant_message: 'Now the tests.' };
  const env = { COORDINATOR_ROLE: 'thread', COORDINATOR_SHARED_DIR: shared };
  const lines = () => {
    try {
      return readdirSync(join(shared, 'retro-log'), { recursive: true })
        .filter((f) => String(f).endsWith('.md'))
        .flatMap((f) =>
          readFileSync(join(shared, 'retro-log', String(f)), 'utf8')
            .split('\n')
            .filter((l) => l.includes('would refuse')),
        );
    } catch {
      return [];
    }
  };
  // Claude Code's last_assistant_message wins over the transcript.
  // A minion's reply with no status line is a hit too (#1154).
  assert.deepEqual(answerHook(input, env), ['thin last message · 5 tool calls · "Now the tests."', 'no status line · "…Now the tests."']);
  assert.equal(lines().length, 2);
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
  assert.equal(lines().length, before + 2, 'the stop that ends the turn is judged');
  const plain = script({});
  assert.equal(plain.stdout, '');
  assert.equal(lines().length, before + 4);
  // #1031: a stop with a Grunt still running goes through, but the Grunt's result wakes the turn: not its end yet.
  const grunt = script({ prompt_id: 'p9', background_tasks: [{ id: 'a7', status: 'running', type: 'subagent', description: 'review' }] });
  assert.equal(grunt.stdout, '', 'a Grunt never blocks the stop');
  assert.equal(lines().length, before + 4, 'and its interim reply is not judged');
  assert.equal(script({ transcript_path: '/nonexistent/t.jsonl', last_assistant_message: undefined }).status, 0, 'fails open');
});

test('process line: a Process: line at the start of a line is logged as a process line; none and mid-line are not', () => {
  const shared = mkdtempSync(join(tmpdir(), 'answer-proc-'));
  const env = { COORDINATOR_ROLE: 'thread', COORDINATOR_SHARED_DIR: shared };
  const logged = () => {
    try {
      return readdirSync(join(shared, 'retro-log'), { recursive: true })
        .filter((f) => String(f).endsWith('.md'))
        .flatMap((f) =>
          readFileSync(join(shared, 'retro-log', String(f)), 'utf8')
            .split('\n')
            .filter((l) => l.includes(' · process · ')),
        );
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

test('a proposal without a card is sent back once per prompt; the other shapes only count', () => {
  const shared = mkdtempSync(join(tmpdir(), 'answer-refuse-'));
  const stateDir = mkdtempSync(join(tmpdir(), 'answer-state-'));
  const env = { COORDINATOR_ROLE: 'thread', COORDINATOR_SHARED_DIR: shared };
  const stop = (text: string, over: object = {}) => {
    const out: { block?: string } = {};
    answerHook({ session_id: 'r1', prompt_id: 'p1', last_assistant_message: text, ...over }, env, { stateDir, out });
    return out.block;
  };
  assert.match(stop(PROPOSAL) ?? '', /ask_question card/, 'first stop is sent back');
  assert.equal(stop(PROPOSAL), undefined, 'never twice for one prompt');
  assert.match(stop(PROPOSAL, { prompt_id: 'p2' }) ?? '', /ask_question/, 'a new prompt gets its own');
  assert.equal(stop(`${PROPOSAL}\n\nSee [the card below](#/p/2/t/9?e=4).`, { prompt_id: 'p3' }), undefined, 'a linked card is no hit');
  assert.equal(stop('Done: it is teal now.', { prompt_id: 'p4' }), undefined);
  assert.equal(stop('Run:\n\n```fish\nssh <host>\n```\n', { prompt_id: 'p5' }), undefined, 'a placeholder only counts');
  assert.equal(stop(PROPOSAL, { session_id: 'r2', prompt_id: undefined, stop_hook_active: true }), undefined, 'no prompt id: only a first stop');
});

// The live-claim check (#1113): the live-state sentences struck in the week to 2026-11-19, and look-alikes that aren't.
const STRUCK = [
  "Every land's desktop job waits its turn there, so each one sits queued for minutes.",
  'Its last four lands all failed on the same test, `busy_cara.rs:196`, which needs fixing in Peek itself.',
  "So it's not a flaky runner.",
  "The Windows runner machine (`cara-desktop-ci-runners`) isn't lent to TWIReader.",
  `Citadel's 4:40 PM PST "no login needed" change for Mandate's install file and icons isn't actually taking effect.`,
  "#993's test job never got a runner.",
  'Yes, you can reorder it: #1002 has been live since 20:18 PST.',
  "The runs from landings that already finished shouldn't still be in the queue; the landing tool is meant to cancel them.",
  "Josh's Taskmaster started that build and Build 6 (#1105), so it starts their feeders.",
  "Still waiting on you: [#334's card](#/p/3/t/334?e=1).",
];
const NOT_LIVE = [
  'land.sh comes from the Citadel kit, so the fix belongs to Citadel.',
  "Moving more work to Sonnet wouldn't save much: Sonnet's cache reads cost the same as Opus's.",
  'The overlay is click-through and never takes focus, so the game keeps your mouse.',
  'With a Library this big, I think the 500 cap is the wrong design.',
  '#1002 is probably live by now.',
  'Is #1002 live?',
  'I started #630 for the two bars.',
  'It shows #1073 instead of the closed #1066.',
  'The relay goes out after Build 4 is live.',
  '```bash\ngh run list # the run failed\n```',
  '> #12 is live',
];

test('live claims: the struck live-state sentences are claims; hedges, questions, own acts, code and quotes are not', () => {
  for (const s of STRUCK) assert.equal(liveClaims(s).length, 1, s);
  for (const s of NOT_LIVE) assert.deepEqual(liveClaims(s), [], s);
});

const bash = (command: string) => [
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command } }] } },
  { type: 'user', promptId: 'p1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b1', content: 'ok' }] } },
];

test("live-claim check: a claim in a turn that read nothing is a hit; a read, a run of gh or git, or the prompt's own report grounds it", () => {
  const claim = 'Yes: #1002 has been live since 20:18 PST.';
  const hit = liveClaimCheck(readTurn(jsonl(prompt('[Cara]: is #1002 live yet?'), calls(['Edit']), say(claim)), 'p1'));
  assert.deepEqual(hit, [`live-state claim without a read · "${claim}"`], "a person's question names #1002 but doesn't ground it");
  assert.deepEqual(liveClaimCheck(readTurn(jsonl(prompt('[Cara]: is it live?'), calls(['mcp__coordinator__live_facts']), say(claim)), 'p1')), []);
  assert.deepEqual(liveClaimCheck(readTurn(jsonl(prompt('[Cara]: is it live?'), bash('gh run list --branch main'), say(claim)), 'p1')), []);
  assert.deepEqual(liveClaimCheck(readTurn(jsonl(prompt('[Cara]: is it live?'), bash('npm test'), say(claim)), 'p1')).length, 1, 'a Bash call that reads no live state grounds nothing');
  // A minion's report or Citadel's shipped line in the prompt passes the fact on.
  assert.deepEqual(liveClaimCheck(readTurn(jsonl(prompt('[#1002 Fix the thing]: #1002 is live (abc123).'), say(claim)), 'p1')), []);
  assert.deepEqual(liveClaimCheck(readTurn(jsonl(prompt('[GitHub]: CI passed on d21a82a in PR #241 (6 checks).'), say('CI passed on PR #241, all 6 checks.')), 'p1')), []);
  assert.equal(liveClaimCheck(readTurn(jsonl(prompt('[#1003 Other]: #1003 is live.'), say(claim)), 'p1')).length, 1, "another minion's report doesn't ground #1002");
});

test('live-claim check only counts: a hit is logged as a would-refuse line and never sends the stop back', () => {
  const shared = mkdtempSync(join(tmpdir(), 'answer-shared-'));
  const path = join(mkdtempSync(join(tmpdir(), 'answer-t-')), 't.jsonl');
  writeFileSync(path, jsonl(prompt('[Josh]: anything for me?'), say("Still waiting on you: [#441's card](#/p/2/t/441?e=3), about citadel.zip.")));
  const out: { block?: string } = {};
  const hits = answerHook({ session_id: 's9', prompt_id: 'p1', transcript_path: path }, { COORDINATOR_ROLE: 'coordinator', COORDINATOR_SHARED_DIR: shared }, { stateDir: mkdtempSync(join(tmpdir(), 'answer-state-')), out });
  assert.deepEqual(hits, ['live-state claim without a read · "Still waiting on you: [#441\'s card](#/p/2/t/441?e=3), about citadel.zip."']);
  assert.equal(out.block, undefined);
  const log = readdirSync(join(shared, 'retro-log'), { recursive: true })
    .filter((f) => String(f).endsWith('.md'))
    .map((f) => readFileSync(join(shared, 'retro-log', String(f)), 'utf8'))
    .join('');
  assert.match(log, /would refuse · live-state claim without a read/);
});

test('a stop sent back for a proposal logs no would-refuse line: the stop that ends the turn is judged', () => {
  const shared = mkdtempSync(join(tmpdir(), 'answer-shared-'));
  const path = join(mkdtempSync(join(tmpdir(), 'answer-t-')), 't.jsonl');
  writeFileSync(path, jsonl(prompt('[Josh]: status?'), say(`${PROPOSAL}\n\nStill waiting on you: #441's card.`)));
  const out: { block?: string } = {};
  answerHook({ session_id: 's10', prompt_id: 'p1', transcript_path: path }, { COORDINATOR_ROLE: 'coordinator', COORDINATOR_SHARED_DIR: shared }, { stateDir: mkdtempSync(join(tmpdir(), 'answer-state-')), out });
  assert.ok(out.block);
  const log = readdirSync(join(shared, 'retro-log'), { recursive: true })
    .filter((f) => String(f).endsWith('.md'))
    .map((f) => readFileSync(join(shared, 'retro-log', String(f)), 'utf8'))
    .join('');
  assert.match(log, /refused stop · proposal without a card/);
  assert.doesNotMatch(log, /would refuse/);
});

// The minion checks (#1154): count only, minions only.
const tool = (name: string, input: object, i: number) => [
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: `u${i}`, name, input }] } },
  { type: 'user', promptId: 'p1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `u${i}`, content: 'ok' }] } },
];

test('status line check: none, or one Citadel would ignore, is a hit; a readable one, plain null included, is not', () => {
  const turn = (text: string) => readTurn(jsonl(prompt('go'), say(text)), 'p1');
  assert.deepEqual(statusLineCheck(turn('Shipped it.')), ['no status line · "…Shipped it."']);
  assert.deepEqual(statusLineCheck(turn('Done.\n<!-- status: {state: ready} -->')), ['unreadable status line · "{state: ready}"']);
  assert.deepEqual(statusLineCheck(turn('Done.\n<!-- status: {"colour":"red"} -->')), ['unreadable status line · "{"colour":"red"}"']);
  assert.deepEqual(statusLineCheck(turn('')), [], "a turn with no closing text is the thin-message check's");
  assert.match(statusLineCheck(turn('Quoted `<!-- status: {"state":"ready"} -->` mid-reply, then more words.'))[0], /^no status line/, 'only a trailer at the very end counts');
  for (const ok of ['Done.\n<!-- status: {"state":"ready","note":"shipped"} -->', 'Card below.\n<!-- status: null -->', 'Done.\n`<!-- status: {"note":"x"} -->`\n']) assert.deepEqual(statusLineCheck(turn(ok)), [], ok);
  assert.deepEqual(statusLineCheck(readTurn(jsonl(prompt('go'), say('Half'), steer('[Cara]: stop')), 'p1')), [], 'a steered turn is skipped');
});

test("title check: a first turn that ends with the title still its prompt's opening words is a hit; setting a title or a later turn is not", () => {
  const first = '[System]: You are a minion.\n[Josh]: Fix the sidebar so it shows the phases of a turn and the counts';
  const title = 'Fix the sidebar so it shows the phases…';
  assert.deepEqual(titleCheck(readTurn(jsonl(prompt(first), calls(['Read']), say('Done.')), 'p1'), title), [`title still the opening words · "${title}"`]);
  assert.deepEqual(titleCheck(readTurn(jsonl(prompt('Fix the sidebar so it shows the phases of a turn'), say('Done.')), 'p1'), title).length, 1, 'a prompt with no sender tag');
  const renamed = readTurn(jsonl(prompt(first), tool('mcp__thread__set_thread_status', { title: 'Sidebar shows phases' }, 1), say('Done.')), 'p1');
  assert.deepEqual(titleCheck(renamed, title), []);
  assert.deepEqual(titleCheck(readTurn(jsonl(prompt(first), tool('mcp__thread__set_thread_status', { note: 'x' }, 1), say('Done.')), 'p1'), title).length, 1, 'a note alone renames nothing');
  assert.deepEqual(titleCheck(readTurn(jsonl(prompt('[Josh]: looks good, ship it'), say('Done.')), 'p1'), title), [], 'a later turn');
  assert.deepEqual(titleCheck(readTurn(jsonl(prompt(first), say('Done.')), 'p1'), 'Sidebar shows phases'), [], 'a title someone gave');
  assert.deepEqual(titleCheck(readTurn(jsonl(prompt(first), say('Done.')), 'p1'), undefined), [], 'no title in the env (an older server)');
});

test('ship check: a hand-off with no self-review in the session is a hit; a review before, after or in an earlier turn is not', () => {
  const ship = (n: number) => tool('mcp__thread__hand_off_land', { summary: 'x' }, n);
  const skill = (n: number) => tool('Skill', { skill: 'citadel:self-review' }, n);
  const grunt = (n: number) => tool('Agent', { subagent_type: 'citadel:reviewer', prompt: 'review' }, n);
  const check = (...entries: unknown[]) => {
    const t = jsonl(...entries);
    return shipReviewCheck(readTurn(t, 'p1'), t);
  };
  assert.deepEqual(check(prompt('go'), calls(['Edit', 'Bash']), ship(9), say('Handed off.')), ['ship with no self-review']);
  assert.deepEqual(check(prompt('go'), tool('mcp__thread__land', {}, 9), say('Shipped.')), ['ship with no self-review'], 'the land tool too');
  assert.deepEqual(check(prompt('go'), skill(1), ship(9), say('Handed off.')), []);
  assert.deepEqual(check(prompt('go'), ship(9), grunt(2), say('Handed off, reviewed alongside.')), [], 'a low-risk ship reviewed while it ships');
  assert.deepEqual(check(prompt('first', 'p0'), skill(1), say('Reviewed.'), prompt('ship it'), ship(9), say('Handed off.')), [], 'a review in an earlier turn');
  assert.deepEqual(check(prompt('go'), tool('Agent', { subagent_type: 'Explore' }, 1), ship(9), say('x')), ['ship with no self-review'], 'any other Grunt is no review');
  assert.deepEqual(check(prompt('go'), calls(['Edit']), say('No ship.')), [], 'a turn that shipped nothing');
});

test('the minion checks run for minions only, and only count', () => {
  const shared = mkdtempSync(join(tmpdir(), 'answer-shared-'));
  const path = join(mkdtempSync(join(tmpdir(), 'answer-t-')), 't.jsonl');
  writeFileSync(path, jsonl(prompt('[Josh]: Fix the sidebar so it shows the phases of a turn'), tool('mcp__thread__hand_off_land', {}, 1), say('Handed off.')));
  const input = { hook_event_name: 'Stop', session_id: 'm1', prompt_id: 'p1', transcript_path: path };
  const env = { COORDINATOR_ROLE: 'thread', COORDINATOR_SHARED_DIR: shared, CITADEL_MINION_TITLE: 'Fix the sidebar so it shows the phases…' };
  const out = {} as { block?: string };
  assert.deepEqual(answerHook(input, env, { stateDir: mkdtempSync(join(tmpdir(), 'answer-state-')), out }), ['no status line · "…Handed off."', 'title still the opening words · "Fix the sidebar so it shows the phases…"', 'ship with no self-review']);
  assert.equal(out.block, undefined, 'none sends the stop back');
  const logged = readdirSync(join(shared, 'retro-log'), { recursive: true })
    .filter((f) => String(f).endsWith('.md'))
    .map((f) => readFileSync(join(shared, 'retro-log', String(f)), 'utf8'))
    .join('');
  assert.equal(logged.split('\n').filter((l) => l.includes(' · would refuse · ')).length, 3);
  assert.deepEqual(answerHook(input, { ...env, COORDINATOR_ROLE: 'coordinator' }), [], 'a Taskmaster has no status line, title or ship of its own');
});
