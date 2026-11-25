// Who qualifies for the quick train (#1912; Josh, 2026-11-24, on #1910's plan; specs/quick-train.md in the shared
// folder). Judged and logged only: nothing rides on the answer yet. tools/land.sh calls it as a ship joins the line:
//   node tools/quick-train.ts --main <ref> --base <commit> [--risk low|medium|high] [--mode land|build]
// Prints one line: "would qualify", or "not: <why>[; <why>...]". Exits 0, or 2 when it can't judge.
// A ship qualifies when all four hold: its label is low, it touches no sensitive file (the label alone never decides),
// tools/affected.ts knows every changed path, and it picks at most CAP test files. The light lane is asked first: its
// ships run no tests at all, and the map calls their docs unmapped. The pipeline list and the map are main's copies, so
// a branch can't loosen its own and a stale one is judged by today's.
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { affected, parseMap } from './affected.ts';

/** At most this many test files picked (#1910: 20 to no cap at all moves 210 qualifying ships to 226). */
export const CAP = 40;

// Beyond tools/pipeline-files.txt. A pattern ending / covers its folder, one ending * any path that starts so.
const SENSITIVE: [kind: string, paths: string[]][] = [
  ['pipeline', ['tools/pipeline-files.txt', 'deploy/', '.github/', '.githooks/']],
  ['saved data', ['src/db.ts', 'src/db/', 'src/db-schema.ts', 'src/db-rows.ts', 'src/db-keys.ts', 'src/db-writer.ts', 'src/db-copy.ts', 'src/turn-row.ts', 'src/events-db.ts']],
  ['sign-in and access', ['src/auth.ts', 'src/access.ts', 'src/db-view.ts']],
  // The processes that load and run it on each tool call count as the tripwire.
  ['tripwire', ['src/tripwire*', 'src/hook-run.ts', 'src/hook-matchers.ts', 'src/pre-tool-hook.ts', 'src/side-guard.ts', 'tools/guard.sh']],
  ['kit templates', ['kit/skills/scheme-setup/templates/']],
  [
    'turn start',
    [
      'server.ts',
      'src/runner.ts',
      'src/turn-launch.ts',
      'src/turn-line.ts',
      'src/turn-keys.ts',
      'src/turn-messages.ts',
      'src/pool-client.mjs',
      'src/turn-run.mjs',
      'src/turn-supervisor.mjs',
      'src/turn-wrapper.mjs',
      'src/supervisor-client.ts',
      'src/containers.ts',
      'src/claude-link.ts',
      'src/codex-link.ts',
      'src/contraption-turns.ts',
      'src/codex-turn.ts',
    ],
  ],
  ['Citadel UI contract', ['public/ui/', 'test/ui-contract.json']],
];

const hits = (pattern: string, path: string) => (pattern.endsWith('/') ? path.startsWith(pattern) : pattern.endsWith('*') ? path.startsWith(pattern.slice(0, -1)) : path === pattern);

/** The paths of tools/pipeline-files.txt. */
export const pipelinePaths = (text: string) =>
  text
    .split('\n')
    .map((l) => l.replace(/#.*/, '').trim())
    .filter(Boolean);

/** What makes one changed path sensitive, or null. */
export function sensitive(path: string, pipeline: string[]): string | null {
  if (pipeline.some((p) => hits(p, path))) return 'pipeline';
  if (/^(src|tools)\/.*backup/.test(path)) return 'saved data';
  return SENSITIVE.find(([, paths]) => paths.some((p) => hits(p, path)))?.[0] ?? null;
}

export type Ship = { risk?: string; lane?: string; changed: string[]; pipeline: string[]; unmapped: string[]; tests: number };

/** Why the ship doesn't qualify, every failed condition of the four; none: it would. */
export function why(s: Ship): string[] {
  if (s.lane === 'light') return ['light lane (no tests, no CI as today)'];
  if (!s.changed.length) return ['nothing changed'];
  const out: string[] = [];
  if (s.risk !== 'low') out.push(s.risk ? `risk ${s.risk}` : 'no risk label');
  const found = new Map<string, string[]>();
  for (const p of s.changed) {
    const kind = sensitive(p, s.pipeline);
    if (kind) found.set(kind, [...(found.get(kind) ?? []), p]);
  }
  for (const [kind, paths] of found) out.push(`sensitive: ${kind} (${some(paths)})`);
  if (s.unmapped.length) out.push(`not in the test map (${some(s.unmapped)})`);
  if (s.tests > CAP) out.push(`${s.tests} test files picked, over ${CAP}`);
  return out;
}

const some = (paths: string[]) => `${paths.slice(0, 2).join(', ')}${paths.length > 2 ? ` +${paths.length - 2}` : ''}`;

function main(argv: string[]): void {
  const opt = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
  const git = (...args: string[]) => {
    const r = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 64 << 20 });
    if (r.status !== 0) throw new Error(`git ${args[0]}: ${(r.stderr || '').trim() || `exit ${r.status}`}`);
    return r.stdout;
  };
  const rev = opt('--main');
  const base = opt('--base');
  if (!rev || !base) throw new Error('usage: quick-train.ts --main <ref> --base <commit> [--risk <label>] [--mode land|build]');
  const root = git('rev-parse', '--show-toplevel').trim();
  const changed = git('diff', '--name-only', '--no-renames', base, 'HEAD').split('\n').filter(Boolean);
  const a = affected(parseMap(git('show', `${rev}:tools/affected-map.txt`)), changed, git('ls-files').split('\n').filter(Boolean), resolve(root));
  // As tools/land.sh: a build's own ship is always the full lane, and a lane that can't be read is too.
  const lane = opt('--mode') === 'build' ? 'full' : spawnSync(join(import.meta.dirname, 'lane.sh'), [rev], { input: `${changed.join('\n')}\n`, encoding: 'utf8' }).stdout?.split(' ')[0];
  const pipeline = pipelinePaths(git('show', `${rev}:tools/pipeline-files.txt`));
  const no = why({ risk: opt('--risk') || undefined, lane, changed, pipeline, unmapped: a.unmapped, tests: a.run.length });
  console.log(no.length ? `not: ${no.join('; ')}` : 'would qualify');
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(`quick-train: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
}
