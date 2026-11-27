// Shared setup of land-train.test.ts and its parts (#2208): the file is split so no one test file sets the suite's length.
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { bad } from './land-train-fixture.ts';

// A fixture test that imports <file> once it exists, so it passes on main and red-on-main (#1430) stays out of the
// way (split, so test/pipeline-files.test.ts doesn't read it as this file importing the fixture).
export const importIf = (file: string) => `import { existsSync } from 'node:fs'; if (existsSync(new URL('../${file}', import.meta.url))) await imp` + `ort('../${file}');`;

export const importX = importIf('x.ts');

// #1564 (Cara 2026-11-21, C "Go"): a train with three bad riders refuses all three after its one red run, not one a run.
// #2019: a burn-in race passes alone, so a run alone can't prove it. A case no ship before this one has needs no proof:
// only the ship that adds it can have turned it red.
export const racyCase = "import test from 'node:test';\ntest('a racy case', () => {});\n";

export const burnCase = { FAKE_STEP: 'burn in new and changed tests', FAKE_LOG: 'burn', FAKE_CASE: 'a racy case' };
