#!/usr/bin/env node
// node tools/types-only.ts [<base>]: for each file the branch changed since <base> (default main), whether its code is
// the same once types and comments are gone (src/types-only.ts). Prints `same\t<path>` or `differs\t<path>\t<why>`
// per file and exits 0 only when every changed file is the same code (#2143). Self-review reads it: a high-risk-by-file
// file whose change is types-only takes its risk from what the change does.
import { execFileSync } from 'node:child_process';
import { sameCode } from '../src/types-only.ts';

const base = process.argv[2] ?? 'main';
const git = (...a: string[]) => execFileSync('git', a, { encoding: 'utf8', maxBuffer: 64 << 20 });
const show = (rev: string, path: string) => {
  try {
    return git('show', `${rev}:${path}`);
  } catch {
    return null;
  }
};
const from = git('merge-base', base, 'HEAD').trim();
let all = true;
for (const path of git('diff', '--name-only', '--no-renames', `${from}`, 'HEAD').split('\n').filter(Boolean)) {
  const a = show(from, path);
  const b = show('HEAD', path);
  const r = a === null || b === null ? { same: false, why: a === null ? 'new file' : 'deleted' } : sameCode(a, b, path);
  if (!r.same) all = false;
  console.log(r.same ? `same\t${path}` : `differs\t${path}\t${r.why}`);
}
process.exit(all ? 0 : 1);
