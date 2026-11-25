import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ClaudeEvent } from '../src/claude-events.ts';
import { CutOffs, cutOffOf, jobCutOff } from '../src/cut-offs.ts';
import type { CutOff } from '../src/db/wait-records.ts';

// The commands a time limit cut off (#1992; Josh, 2026-11-25, "Record the missing waits too?: The three that matter").

test('each limit is named from the output of the command it cut off', () => {
  const cases: [string, string, boolean, ReturnType<typeof cutOffOf>][] = [
    ['citadel-test test/a.test.ts', 'Exit code 124\n✖ stopped at the time limit, 300 s', true, { limit: 'citadel-test', seconds: 300 }],
    ['citadel-test --timeout 60 test/a.test.ts 2>&1 | tail -5', '✖ stopped at the time limit, 60 s', false, { limit: 'citadel-test', seconds: 60 }],
    ['citadel-test --timeout 90 test/a.test.ts', `Exit code 124\n${'x'.repeat(200)}`, true, { limit: 'citadel-test', seconds: 90 }],
    ['tools/run-tests.sh', 'Exit code 1\nrun-tests: the tests ran past 1500s and were stopped', true, { limit: 'run-tests', seconds: 1500 }],
    ['timeout 30 node x.ts', 'Exit code 124', true, { limit: 'timeout', seconds: 30 }],
    ['cd /tmp && timeout -k 5 --foreground -s INT 2m make', 'Exit code 124\nhalf', true, { limit: 'timeout', seconds: 120 }],
    ['timeout 30 a; timeout 60 b', 'Exit code 124', true, { limit: 'timeout' }],
    ['timeout 30 a; timeout 30 b', 'Exit code 124', true, { limit: 'timeout', seconds: 30 }],
    ['./slow.sh', 'Exit code 124', true, { limit: null }],
  ];
  for (const [command, output, isError, want] of cases) assert.deepEqual(cutOffOf(command, output, isError), want, command);
});

test('a command that only moved to the background, a wait that ran out and a log that quotes the words are not cut off', () => {
  const none: [string, string, boolean][] = [
    ['timeout 600 npm test', 'Command did not complete within its 120s timeout and was moved to the background (ID: b1).', false],
    ['timeout 600 citadel-wait pid 12', 'Exit code 124\ncitadel-wait: still waiting for pid 12 after 590 s', true],
    ['cat "$TMPDIR/citadel-test.log"', '✖ stopped at the time limit, 300 s', false],
    ['citadel-job --watch ab12cd-1234abcd', 'Exit code 124\ncitadel-job: still running; run it again to keep waiting (output so far: /x)', true],
    ['cat "$TMPDIR/x.log"', '✖ stopped at the time limit, 300 s', false],
    ['rg -n "ran past" .', 'run-tests: the tests ran past 1500s and were stopped', false],
    ['timeout 30 grep x y', 'Exit code 1', true],
    ['echo "Exit code 124"', 'Exit code 124', false],
    ['timeout 5 true', '', false],
  ];
  for (const [command, output, isError] of none) assert.equal(cutOffOf(command, output, isError), null, command);
});

const call = (id: string, command: string, parent: string | null = null) => ({ type: 'assistant', parent_tool_use_id: parent, message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } }) as ClaudeEvent;
const result = (id: string, content: unknown, is_error = true) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error }] } }) as ClaudeEvent;
const stopped = (id: string) => ({ type: 'system', subtype: 'task_notification', tool_use_id: id, status: 'stopped', summary: 'Background command "Run the long one" was stopped after reaching its background time limit' }) as ClaudeEvent;

function watch() {
  const got: [number, CutOff][] = [];
  const cuts = new CutOffs(
    (id, cut) => got.push([id, cut]),
    () => 1000,
  );
  return { got, feed: (id: number, ...evs: ClaudeEvent[]) => evs.forEach((e) => cuts.observe(id, e)) };
}

test('a cut-off keeps its command, its call and the Grunt it ran in, by minion', () => {
  const w = watch();
  w.feed(1, call('a', 'timeout 5 one'), call('b', 'timeout 9 two', 'grunt'));
  w.feed(2, result('a', 'Exit code 124')); // another minion's id
  w.feed(1, result('b', [{ type: 'text', text: 'Exit code 124' }]), result('a', 'Exit code 124'));
  assert.deepEqual(w.got, [
    [1, { at: 1000, limit: 'timeout', seconds: 9, command: 'timeout 9 two', tool_use_id: 'b', parent: 'grunt' }],
    [1, { at: 1000, limit: 'timeout', seconds: 5, command: 'timeout 5 one', tool_use_id: 'a' }],
  ]);
});

test('a background command stopped at its limit is one cut-off, named by its call; one that ended by itself is none', () => {
  const w = watch();
  w.feed(1, call('a', 'sleep 9999'), result('a', 'Command running in background with ID: x', false), stopped('a'));
  assert.deepEqual(w.got, [[1, { at: 1000, limit: 'background', command: 'sleep 9999', tool_use_id: 'a' }]]);
  w.feed(1, { type: 'result' } as ClaudeEvent, stopped('a'));
  assert.equal(w.got[1][1].command, 'Run the long one', 'its call was in an earlier turn: the name it was run under');
  w.feed(1, { ...stopped('a'), summary: 'Background command "x" completed (exit code 0)' } as ClaudeEvent);
  assert.equal(w.got.length, 2);
});

test('a long command is cut short, a job at its limit names citadel-job', () => {
  const w = watch();
  w.feed(1, call('a', `timeout 5 ${'x'.repeat(900)}`), result('a', 'Exit code 124'));
  assert.equal(w.got[0][1].command!.length, 300);
  assert.deepEqual(jobCutOff({ what: 'npm test', limitMs: 1_800_000, ended: 77 }), { at: 77, limit: 'citadel-job', seconds: 1800, command: 'npm test' });
});
