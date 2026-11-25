// One way to do it (#1790): a helper with a home (.claude/rules/one-home.md) has no second copy. Each family's
// pattern finds a copy by its shape, whatever it is called; `kept` names the copies that truly differ, with why.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

interface Family {
  /** What a new copy should use instead. */
  use: string;
  copy: RegExp;
  /** A copy the pattern must find (the old code's shape), so a pattern that stops matching goes red. */
  planted: string;
  /** Files that keep copies: how many, and why. */
  kept: Record<string, { copies: number; why: string }>;
}

const FAMILIES: Record<string, Family> = {
  wait: {
    use: "import { setTimeout as sleep } from 'node:timers/promises' (sleep(ms, undefined, { ref: false }) to not hold the process open)",
    copy: /new Promise(?:<[^>]*>)?\(\s*\(?(\w+)\)?\s*=>\s*(?:void\s+)?setTimeout\(\s*\1\s*,/g,
    planted: 'const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));',
    kept: {
      'tools/ui-sweep.ts': { copies: 1, why: 'runs in the browser page, inside a string' },
      'tools/ui-shot.ts': { copies: 2, why: 'runs in the browser page, inside a string' },
      'tools/citadel-android-mic.ts': { copies: 1, why: 'runs in the browser page, inside a string' },
      // Ship pipeline files: they change only with the pipeline lane.
      'src/land.ts': { copies: 1, why: 'pipeline lane; not converted yet' },
      'tools/boot-check.ts': { copies: 4, why: 'pipeline lane; not converted yet' },
      'tools/heavy-ci.ts': { copies: 1, why: 'pipeline lane; not converted yet, and it takes seconds' },
    },
  },
};

const root = join(import.meta.dirname, '..');
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'server.ts', 'src', 'tools'], { cwd: root, encoding: 'utf8' })
  .split('\n')
  .filter((f) => /\.(ts|mjs|js)$/.test(f) && existsSync(join(root, f)));

const linesOf = (text: string, copy: RegExp) => [...text.matchAll(copy)].map((m) => text.slice(0, m.index).split('\n').length);

for (const [name, family] of Object.entries(FAMILIES)) {
  test(`${name}: no copy outside its home`, () => {
    const extra: string[] = [];
    for (const f of files) {
      const lines = linesOf(readFileSync(join(root, f), 'utf8'), family.copy);
      const kept = family.kept[f]?.copies ?? 0;
      if (lines.length > kept) extra.push(`${f}:${lines.join(',')}${kept ? ` (${kept} kept: ${family.kept[f].why})` : ''}`);
      else if (lines.length < kept) extra.push(`${f}: ${lines.length} left of ${kept}; lower its count in test/one-home.test.ts`);
    }
    assert.deepEqual(extra, [], `Use ${family.use}. See .claude/rules/one-home.md.`);
  });

  test(`${name}: a planted copy is found`, () => {
    assert.equal(linesOf(family.planted, family.copy).length, 1);
  });
}
