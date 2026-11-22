// A card's reply holding a command starts open however long it is (#1589); a long one with none starts collapsed (#1581).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { replyStartsOpen } from '../public/cardreply.js';

const prose = 'Some explanation of what went wrong and why. '.repeat(20);

test('a long reply with a powershell block starts open', () => {
  assert.equal(replyStartsOpen(`${prose}\n\n\`\`\`powershell\nStart-Service x\n\`\`\`\n\nThen tell me.`), true);
  assert.equal(replyStartsOpen(`${'line\n'.repeat(12)}~~~\nrun me\n~~~`), true);
});
test('a long reply with no code block starts collapsed, a short one open', () => {
  assert.equal(replyStartsOpen(prose), false);
  assert.equal(replyStartsOpen('line\n'.repeat(12)), false);
  assert.equal(replyStartsOpen('Short.'), true);
});
test('backticks in the middle of a line are not a code block', () => {
  assert.equal(replyStartsOpen(`${prose} use \`\`\`x\`\`\` inline`), false);
});
test('a line that opens and closes its backticks is inline code, not a block', () => {
  assert.equal(replyStartsOpen(`${prose}\n\`\`\`x\`\`\` is inline`), false);
});
