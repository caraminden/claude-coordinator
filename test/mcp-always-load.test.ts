// The tools every turn uses are never deferred behind ToolSearch (#710): the MCP server marks exactly these
// `anthropic/alwaysLoad`. Each 1k tokens of prefix costs about $27 a week (#699, measured by #1263), so growing the list is a decision.
// Four of them (ask_question, message_coordinator, hand_off_land, close_self) carry only their first sentence up front since #1575;
// their other rules are in their results and refusals (test/tool-rules-moved.test.ts), and test/prompt-budget.test.ts holds the size.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { planError } from '../public/progress.js';
import { planResult } from '../src/mcp.ts';

// The plan tool's check and the readout's are twins (#1275: the pinned server can't import public/): a call one refuses, the other ignores.
test('the plan tool refuses exactly the calls the readout ignores, with the same words', () => {
  const calls = [
    null,
    {},
    { steps: [] },
    { steps: [{ n: 1 }] },
    { steps: [{ n: 0 }] },
    { steps: [{ n: 1.5 }] },
    { steps: [{ step: 'x' }] },
    { steps: [{ n: 1, step: 'A', doing: 'B', why: 'C', outcome: 'D', minutes: 3, status: 'doing' }] },
    { steps: [{ n: 1, doing: 42 }] },
    { steps: [{ n: 1, minutes: 'soon' }] },
    { steps: [{ n: 1, minutes: -1 }] },
    { steps: [{ n: 1, status: 'started' }] },
    { steps: [{ n: 1, status: 'toString' }] },
    { steps: [{ n: 1, status: 'dropped' }, { step: 'no number' }] },
  ];
  for (const call of calls) {
    let refused = '';
    try {
      planResult(call);
    } catch (e: any) {
      refused = e.message;
    }
    assert.equal(refused, planError(call), JSON.stringify(call));
  }
});
