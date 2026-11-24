// The any nudge (kit/hooks/any-nudge.ts, #1789) over the repo's real commits: for each TypeScript file a commit changed,
// the nudge's own counter (countEscapes, from the type check's template) on the file before and after; a rise is a nudge it
// would have given at least once while that commit was written. It never acted before #1789, so real is empty.
import { execFileSync } from 'node:child_process';
import { countEscapes } from '../../kit/skills/scheme-setup/templates/typecheck.ts';
import type { Act, ReplayCtx, ReplayResult } from './types.ts';

const TS = /\.(?:[cm]?ts|tsx)$/;

export async function replay(ctx: ReplayCtx): Promise<ReplayResult> {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: ctx.repo, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  const show = (rev: string, path: string) => { try { return git('show', `${rev}:${path}`); } catch { return null; } };
  const since = new Date(ctx.now - ctx.days * 86_400_000).toISOString();
  const log = git('log', `--since=${since}`, '--no-merges', '--format=@%H %ct %s', '--name-only', 'HEAD');
  const hits: Act[] = [];
  let commits = 0;
  let files = 0;
  for (const block of log.split('\n@').filter(Boolean)) {
    const [head, ...names] = block.replace(/^@/, '').split('\n');
    const [sha, ct, ...subject] = head.split(' ');
    const changed = names.filter((n) => TS.test(n));
    if (!changed.length) continue;
    commits++;
    for (const path of changed) {
      const now = show(sha, path);
      if (now === null) continue; // deleted
      files++;
      const was = show(`${sha}^`, path) ?? '';
      let [a, b] = [countEscapes(now, path), countEscapes(was, path)];
      if (a.by !== b.by) [a, b] = [countEscapes(now, path, true), countEscapes(was, path, true)]; // as the hook does
      const added = a.n - b.n;
      if (added > 0) hits.push({ at: Number(ct) * 1000, key: `${sha.slice(0, 9)}:${path}`, text: `+${added} in ${path} (${subject.join(' ').slice(0, 80)})` });
    }
  }
  return {
    inputs: `${files} TypeScript file changes in ${commits} commits`,
    hits,
    real: [],
    limits: [
      'it reads commits, not edits: a rise undone before the commit was a nudge too, and one commit with a rise may have been several edits',
      "this repo's commits only, not the other schemes' the kit's hook also runs in",
    ],
  };
}
