import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseProjectFacts, parseRule, pinFor } from '../src/repo-setup.ts';

const home = '/home/cara/.local/share/claude-coordinator/projects';
const real = (id: number) => { try { return readFileSync(`${home}/${id}/repo/CLAUDE.md`, 'utf8'); } catch { return null; } };

// Real shapes: Citadel's (bullets wrapped onto indented lines) and Peek Auras' (a long first bullet).
for (const [name, id, first, last] of [['Citadel', 2, 'Check commands', 'Numbered things'], ['Peek Auras', 3, 'Check commands', null]] as const) {
  test(`parses ${name}'s Project facts`, (t) => {
    const md = real(id);
    if (!md) return t.skip('repo not on this machine');
    const facts = parseProjectFacts(md)!;
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
