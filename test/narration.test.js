import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBookkeeping, isNarration, NARRATION_MAX } from '../public/narration.js';

test('a short plain remark is narration', () => {
  assert.ok(isNarration('Checking the merged code boots:'));
  assert.ok(isNarration('Found it: the drawer\'s own click handler closes the drawer. Checking how `onClick` is registered.'));
  assert.ok(isNarration('Line one\nline two of the same paragraph.'));
  assert.ok(isNarration('x'.repeat(NARRATION_MAX - 1)));
});

test('long text, paragraphs and Markdown structure are not', () => {
  assert.ok(!isNarration('x'.repeat(NARRATION_MAX)));
  assert.ok(!isNarration('Done.\n\nIt shipped as abc123.'));
  for (const md of ['## Rules\nOnly a Claude.', 'Two things:\n- one\n- two', 'Steps:\n1. build\n2. test',
    'Steps:\n1) build', '| a | b |\n|---|---|', 'Run:\n```\nnpm test\n```', '> quoted', '* star item']) {
    assert.ok(!isNarration(md), md);
  }
});

test('bookkeeping tools are told from work', () => {
  for (const name of ['mcp__thread__set_thread_status', 'TaskUpdate', 'TaskCreate', 'ToolSearch', 'mcp__thread__close_self']) assert.ok(isBookkeeping(name), name);
  for (const name of ['Bash', 'Read', 'Agent', 'mcp__thread__message_coordinator', 'mcp__thread__start_preview']) assert.ok(!isBookkeeping(name), name);
});
