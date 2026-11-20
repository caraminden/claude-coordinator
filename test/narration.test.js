import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLAMP_OVER, isBookkeeping, isNarration, narrationSorter, NARRATION_MAX } from '../public/narration.js';

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
  for (const name of ['mcp__thread__set_thread_status', 'TaskUpdate', 'TaskCreate', 'ToolSearch', 'mcp__thread__close_self', 'mcp__thread__plan']) assert.ok(isBookkeeping(name), name);
  for (const name of ['Bash', 'Read', 'Agent', 'mcp__thread__message_coordinator', 'mcp__thread__start_preview']) assert.ok(!isBookkeeping(name), name);
});

/** Each text's fate over a whole turn, in order: strings are words, { tool } is a call; null = never settled. */
function sortTurn(items) {
  const sorter = narrationSorter();
  const texts = [];
  for (const it of items) {
    const settled = typeof it === 'string' ? sorter.text(texts[texts.push({ text: it, fate: null }) - 1]) : sorter.tool(it.tool);
    for (const { text, fate } of settled) text.fate = fate;
  }
  return texts.map((t) => t.fate);
}

const answer = `Here are the rules.\n\n1. Who can strike\n2. Whose words`;
const long = 'word '.repeat(CLAMP_OVER / 4);

test('short remarks before work collapse; the last words never settle', () => {
  assert.deepEqual(sortTurn(['Checking the tests.', { tool: 'Bash' }, 'Merging.', { tool: 'Bash' }, 'Done.']), ['fold', 'fold', null]);
});

test('an answer followed by a status call and a status line stays (#127)', () => {
  assert.deepEqual(sortTurn([answer, { tool: 'mcp__thread__set_thread_status' }, 'Nothing has changed on the branch.']), ['keep', null]);
  // Even a short one: nothing but bookkeeping came after it before the next words.
  assert.deepEqual(sortTurn(['Yes, it landed as abc123.', { tool: 'TaskUpdate' }, { tool: 'mcp__thread__set_thread_status' }, 'Ready to close.']), ['keep', null]);
});

test('bookkeeping and then work still collapses a remark', () => {
  assert.deepEqual(sortTurn(['Tests pass. Next, screenshots.', { tool: 'TaskUpdate' }, { tool: 'Bash' }, 'Done.']), ['fold', null]);
});

test('substantial words followed by work stay; long ones clamp', () => {
  assert.deepEqual(sortTurn([answer, { tool: 'Bash' }, long, { tool: 'Write' }, long]), ['keep', 'clamp', null]);
});

test('words leading into a card stay', () => {
  assert.deepEqual(sortTurn(['One fork left, so a card.', { tool: 'mcp__thread__ask_question' }, 'Asked.']), ['keep', null]);
});
