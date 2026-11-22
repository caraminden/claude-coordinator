// The reply an everyone card belongs to always starts open in a person's Taskmaster chat (#1630); it was collapsed when long (#1581, #1589).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { replyStartsOpen } from '../public/cardreply.js';

const prose = 'Some explanation of what went wrong and why. '.repeat(20);

test('a card reply starts open however long it is, with or without a code block', () => {
  assert.equal(replyStartsOpen(prose), true);
  assert.equal(replyStartsOpen('line\n'.repeat(12)), true);
  assert.equal(replyStartsOpen(`${prose}\n\n\`\`\`powershell\nStart-Service x\n\`\`\``), true);
  assert.equal(replyStartsOpen('Short.'), true);
});

test('thread.js opens the details before it is inserted, so nothing pops open after load', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../public/thread.js', import.meta.url), 'utf8');
  assert.match(src, /el\.open = replyStartsOpen\(text\);\s*return el;/);
});
