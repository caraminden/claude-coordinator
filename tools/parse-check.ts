// Every git-tracked .ts file (but .d.ts, which never runs) parses, checked before the suite by tools/run-tests.sh (#999).
// One that doesn't would hang every test that starts it as a child (#993: src/mcp.ts, about 30 test files) until the
// whole run's limit. Prints "<file> does not parse (<why>)" per bad file and exits 1; under a second for the repo.
// Not a git checkout: nothing to check, exit 0.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

let files: string[];
try {
  files = execFileSync('git', ['ls-files', '-z', '--', '*.ts', ':!:*.d.ts'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    .split('\0')
    .filter(Boolean);
} catch {
  process.exit(0);
}
let bad = 0;
for (const f of files) {
  let src: string;
  try {
    src = readFileSync(f, 'utf8');
  } catch {
    continue; // deleted in the working tree: nothing to run
  }
  try {
    stripTypeScriptTypes(src, { mode: 'strip' });
  } catch (e) {
    bad++;
    console.log(`${f} does not parse (${String((e as Error).message).split('\n')[0]})`);
  }
}
process.exit(bad ? 1 : 0);
