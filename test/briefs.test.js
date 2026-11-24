import { test } from 'node:test';
import assert from 'node:assert/strict';
import { briefMessage, findBriefs, matchType } from '../public/briefs.js';
import { renderMarkdown } from '../public/ui/markdown.js';

const retro = `# Citadel retrospective

Intro.

## Summary
### Brief, not a brief
## Ready-to-start minion briefs

### Brief 1: Crash-proof the server (bug, S)
Make it not crash.

- one
- two

### Brief 2: Apply the units in deploy/ (process, S; Cara runs the commands)
Run them.
#### Detail
Still part of Brief 2.
\`\`\`
# not a heading
\`\`\`
### Brief 4: A card before a minion drives a laptop (feature/security, S/M)
Cards.
## Appendix
Not part of Brief 4.
`;

test('a Brief heading runs to the next heading as high or higher', () => {
  const briefs = findBriefs(retro, 'citadel-retro-2026-10.md');
  assert.deepEqual(
    briefs.map((b) => b.heading),
    ['Brief, not a brief', 'Brief 1: Crash-proof the server (bug, S)', 'Brief 2: Apply the units in deploy/ (process, S; Cara runs the commands)', 'Brief 4: A card before a minion drives a laptop (feature/security, S/M)'],
  );
  const [, one, two, four] = briefs;
  assert.equal(one.body, '### Brief 1: Crash-proof the server (bug, S)\nMake it not crash.\n\n- one\n- two');
  assert.match(two.body, /#### Detail\nStill part of Brief 2\.\n```\n# not a heading\n```$/);
  assert.equal(four.body, '### Brief 4: A card before a minion drives a laptop (feature/security, S/M)\nCards.');
  // index counts the top-level headings markdownDoc renders; the one in the code block isn't one.
  assert.deepEqual(
    briefs.map((b) => b.index),
    [2, 4, 5, 7],
  );
});

test('the title drops "Brief N:" and the size; the type is the bracket\'s first word', () => {
  const [plain, one, two, four] = findBriefs(retro, 'r.md');
  assert.deepEqual([one.title, one.typeHint], ['Crash-proof the server', 'bug']);
  assert.deepEqual([two.title, two.typeHint], ['Apply the units in deploy/', 'process']);
  assert.deepEqual([four.title, four.typeHint], ['A card before a minion drives a laptop', 'feature']);
  assert.deepEqual([plain.title, plain.typeHint], ['Brief, not a brief', '']);
  assert.deepEqual(
    findBriefs('## **Brief 9**: `Bold` one\nx').map((b) => [b.heading, b.title]),
    [['Brief 9: Bold one', 'Bold one']],
  );
});

test('"Briefs" and headings that only mention a brief are not briefs', () => {
  assert.deepEqual(findBriefs('## Briefs\n### The brief\n### Debriefing\ntext', 'notes.md'), []);
});

test('a handoff file is a brief as a whole, with its Brief headings as well', () => {
  const src = '# Handoff: a Start button on a brief\n\nWhy.\n\n## Brief 1: Part one (design, S)\nOne.';
  const briefs = findBriefs(src, 'handoff-start-from-brief.md');
  assert.equal(briefs.length, 2);
  assert.deepEqual(briefs[0], { index: -1, heading: '', title: 'a Start button on a brief', typeHint: '', body: src });
  assert.equal(briefs[1].heading, 'Brief 1: Part one (design, S)');
  assert.equal(findBriefs('No heading at all.', 'handoff-tidy-ups.md')[0].title, 'tidy ups');
  assert.deepEqual(
    findBriefs(src, 'start-from-brief.md').map((b) => b.heading),
    ['Brief 1: Part one (design, S)'],
    'only handoff-*.md is one',
  );
});

test('a repeated Brief heading gets a number, as the heading is its key', () => {
  assert.deepEqual(
    findBriefs('## Brief 1: Setup\na\n## Brief 1: Setup\nb', 'x.md').map((b) => [b.heading, b.title, b.body]),
    [
      ['Brief 1: Setup', 'Setup', '## Brief 1: Setup\na'],
      ['Brief 1: Setup (2)', 'Setup', '## Brief 1: Setup\nb'],
    ],
  );
});

test('comments are dropped, as markdownDoc drops them', () => {
  const briefs = findBriefs('<!--\n# Hidden\n-->\n# Top\n## Brief 1: X\nbody', 'x.md');
  assert.deepEqual(
    briefs.map((b) => [b.index, b.body]),
    [[1, '## Brief 1: X\nbody']],
  );
});

test('the type hint maps to a registered type by value or alias', () => {
  const types = [
    { value: 'feature', aliases: ['enhancement'] },
    { value: 'chore', aliases: ['process', 'tooling'] },
    { value: 'bug', aliases: ['fix'] },
  ];
  assert.equal(matchType('feature', types), 'feature');
  assert.equal(matchType('process', types), 'chore');
  assert.equal(matchType('security', types), '');
  assert.equal(matchType('', types), '');
});

test('the first message is the brief verbatim plus where it came from', () => {
  const [, one] = findBriefs(retro, 'r.md');
  assert.equal(briefMessage(one, '/data/shared/project/r.md'), `${one.body}\n\n(Brief from /data/shared/project/r.md; read the whole file for its context.)`);
  const [handoff] = findBriefs('# Handoff: X\nY', 'handoff-x.md');
  assert.equal(briefMessage(handoff, '/s/handoff-x.md'), '# Handoff: X\nY\n\n(Handoff file: /s/handoff-x.md)');
});

test('a fence closes only on its own kind and length, as markdownDoc reads it (#468 S11-4)', () => {
  const nested = '## Brief 1: Nested\n````md\n```sh\n# a comment\n```\n````\nafter\n## Brief 2: Next\nx';
  assert.deepEqual(
    findBriefs(nested, 'x.md').map((b) => [b.index, b.heading, b.body.split('\n').length]),
    [
      [0, 'Brief 1: Nested', 7],
      [1, 'Brief 2: Next', 2],
    ],
  );
  const tilde = '## Brief 1: Tilde\n~~~sh\n# a comment\n~~~\n## Brief 2: Next\nx';
  assert.deepEqual(
    findBriefs(tilde, 'x.md').map((b) => [b.index, b.body]),
    [
      [0, '## Brief 1: Tilde\n~~~sh\n# a comment\n~~~'],
      [1, '## Brief 2: Next\nx'],
    ],
  );
});

test('a one-line ```code``` is inline code, as markdownDoc reads it, and opens no fence (#468 S11-4 review)', () => {
  const src = '## Brief 1: A\n```npm test```\ntext\n## Brief 2: B\nx';
  assert.deepEqual(
    findBriefs(src, 'x.md').map((b) => [b.index, b.body]),
    [
      [0, '## Brief 1: A\n```npm test```\ntext'],
      [1, '## Brief 2: B\nx'],
    ],
  );
  assert.match(renderMarkdown(src), /Brief 2: B<\/h\d>/, 'the renderer shows both headings');
});
