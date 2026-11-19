import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseProjectFacts, parseRule, pinFor } from '../src/repo-setup.ts';

// Inline fixtures in the real shapes (CI runners don't have the repos, and a skip is red there): Citadel's
// (bullets wrapped onto indented lines) and Peek Auras' (a long first bullet).
const long = 'npm test (node --test test/ through tools/citadel-node, failing if it leaves processes running); a UI change is also checked in a dev copy';
const fixtures = {
  Citadel: `# CLAUDE.md\n\n## Project facts\n\n- **Check commands:** \`npm test\` (\`node --test test/\` through\n  \`tools/citadel-node\`, so it escapes ananicy's idle rule); a UI change is also checked\n  in a dev copy.\n- **Front end:** \`public/\`, plain JS.\n- **Numbered things:** none.\n\n## Skills\n`,
  'Peek Auras': `# CLAUDE.md\n\n## Project facts\n\n- **Check commands:** ${long}\n- **Front end:** none.\n\n## Other\n`,
};
for (const [name, first, last] of [['Citadel', 'Check commands', 'Numbered things'], ['Peek Auras', 'Check commands', null]] as const) {
  test(`parses ${name}'s Project facts`, () => {
    const facts = parseProjectFacts(fixtures[name])!;
    assert.equal(facts[0].label, first);
    assert.ok(facts[0].value.length > 40, 'continuation lines are folded in');
    if (last) assert.ok(facts.some((f) => f.label === last));
    assert.ok(facts.every((f) => !f.value.startsWith('**')));
  });
}

test('the block ends at the next ## and a missing block is null', () => {
  assert.deepEqual(parseProjectFacts('# T\n## Project facts\n\n- **A:** one\n  two\n- **B:** x\n## Next\n- **C:** no'), [{ label: 'A', value: 'one two' }, { label: 'B', value: 'x' }]);
  assert.equal(parseProjectFacts('# T\n## Other\n'), null);
});

test('rule files: scoped paths, upstream link and pin', () => {
  const r = parseRule('ponytail.md', '---\npaths:\n  - "**/*.ts"\n  - src/**\n---\n# P\n\nFrom [x/y](https://github.com/x/y) (MIT).');
  assert.deepEqual(r.paths, ['**/*.ts', 'src/**']);
  assert.equal(r.upstream, 'https://github.com/x/y');
  assert.equal(pinFor('| a | b | `96608e0` | `.claude/rules/ponytail.md` (x) | MIT |', '.claude/rules/ponytail.md'), '96608e0');
});

// Inline copies of the two real shapes, so CI (which has no other schemes' repos) runs them too.
test('wrapped continuation lines in both shapes', () => {
  const citadel = '## Project facts\n\nThe kit reads this.\n\n- **Check commands:** `npm test` (`node --test test/` through\n  `tools/citadel-node`), then more.\n- **Front end:** `public/`, plain JS.\n\n## Skills';
  const peek = '## Project facts\n\n- **Check commands:** `tools/check.sh` is the full check, and **its cargo steps run on Windows CI**:\n  `cargo fmt --check`.\n- **UI rules:** none.\n';
  assert.deepEqual(parseProjectFacts(citadel)!.map((f) => f.label), ['Check commands', 'Front end']);
  assert.match(parseProjectFacts(citadel)![0].value, /through `tools\/citadel-node`\)/);
  assert.match(parseProjectFacts(peek)![0].value, /Windows CI\*\*: `cargo fmt --check`\.$/);
});
