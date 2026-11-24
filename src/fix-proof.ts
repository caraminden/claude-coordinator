// A bug fix at or above the go threshold that proves itself ships with no go (#1398; Cara, 2026-11-20, picked "Fixes ship;
// data still asks": "the thing we are trying to protect is already broken, shouldnt we just fix it?"). The how-to and the
// four conditions live in the self-review skill, `references/ship.md` "The fix route"; this is the hand-off gate's half: what it can
// check from git and the minion's properties, so the route never takes the minion's word for what it can see itself.
import { execFile } from 'node:child_process';
import { isAbsolute, normalize } from 'node:path';

/** The one line a fix shipped without a go shows (#1398): in its shipped line, through the hand-off's reason, and on its Releases row. */
export const fixLine = (f: { test: string; redOn: string }) => `Shipped as a fix without a go: ${f.test} (red on ${f.redOn.slice(0, 7)})`;
/** That line, out of a shipped line, or null. */
export const fixLineIn = (shipped: string) => /Shipped as a fix without a go: [^]*? \(red on [0-9a-f]{7}\)/.exec(shipped)?.[0] ?? null;

/** What hand_off_land's fix_proof carries: the test that went red on main and green on the branch, and the deep review's verdict. */
export interface FixProof {
  /** The test file, relative to the worktree. */
  test: string;
  /** The main commit the test ran red on (sha, 7 to 40 hex). */
  redOn: string;
  /** The red run's failing lines, as the test runner printed them. */
  redOutput: string;
  /** The deep review's verdict, starting with "clean". */
  review: string;
}

/** The fields as hand_off_land sends them, checked for shape; throws with what was wrong. */
export function parseFixProof(raw: unknown): FixProof {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('fix_proof is an object: { test, red_on, red_output, review }');
  const o = raw as Record<string, unknown>;
  const text = (k: string, max: number) => {
    const v = o[k];
    if (typeof v !== 'string' || !v.trim()) throw new Error(`fix_proof.${k} is required`);
    if (v.length > max) throw new Error(`fix_proof.${k} is at most ${max} characters`);
    return v.trim();
  };
  const test = text('test', 300);
  if (isAbsolute(test) || normalize(test).startsWith('..')) throw new Error('fix_proof.test is a path inside your worktree, relative to it');
  const redOn = text('red_on', 40);
  if (!/^[0-9a-f]{7,40}$/i.test(redOn)) throw new Error("fix_proof.red_on is the main commit the test ran red on, as a sha");
  const redOutput = text('red_output', 2000);
  const review = text('review', 200);
  if (!/^clean\b/i.test(review)) throw new Error('fix_proof.review starts with "clean": a deep review with findings left takes the go route');
  return { test, redOn, redOutput, review };
}

/** Test files: their SQL is fixtures, not a migration. */
const TEST_PATH = /(^|\/)(tests?|__tests__|spec)\/|[._-](test|spec)\.[a-z]+$/i;
/** A path that is auth by a name in it (auth.ts, oauth.py, authz/policy.ts), in any scheme. */
const AUTH_PATH = /(^|[^a-z])(o?auth[nz]?)([^a-z]|$)/i;
/** A migration by its path. */
const MIGRATION_PATH = /migrat/i;
/** Added lines that rewrite or delete data or schema. */
const DATA_SQL = /\b(DELETE\s+FROM|DROP\s+(TABLE|COLUMN|INDEX)|TRUNCATE\s|UPDATE\s+[`"\w.]+\s+SET\b|ALTER\s+TABLE\s+[`"\w.]+\s+(DROP|RENAME|ALTER)\b)/i;

/**
 * Why this diff can't take the fix route on the gate's own reading, or null. It catches the plain cases from the diff
 * alone: a path named for auth, a migration, or added SQL that rewrites or deletes rows or schema, a statement split
 * over lines too (tests and their fixtures aside). Anything subtler (a delete in code, an auth file only the scheme's
 * Project facts name) is the minion's word, as the skill says: the gate doesn't parse each scheme's CLAUDE.md.
 */
export function dataOrAuth(files: string[], addedByFile: Map<string, string[]>): string | null {
  const auth = files.find((f) => !TEST_PATH.test(f) && AUTH_PATH.test(f));
  if (auth) return `it changes ${auth}, an auth file`;
  const migration = files.find((f) => !TEST_PATH.test(f) && MIGRATION_PATH.test(f));
  if (migration) return `it changes ${migration}, a migration`;
  for (const [file, lines] of addedByFile) {
    if (TEST_PATH.test(file)) continue;
    const text = lines.join('\n');
    const hit = DATA_SQL.exec(text);
    if (!hit) continue;
    const from = text.lastIndexOf('\n', hit.index) + 1;
    return `${file} adds \`${text.slice(from, from + 160).replace(/\s+/g, ' ').trim().slice(0, 80)}\`, which rewrites or deletes data`;
  }
  return null;
}

/** Each file's added lines in a unified diff with -U0. */
export function addedLines(diff: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let file = '';
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      file = line.replace(/^\+\+\+ (b\/)?/, '');
      continue;
    }
    if (line.startsWith('+') && file && file !== '/dev/null') out.set(file, [...(out.get(file) ?? []), line.slice(1)]);
  }
  return out;
}

const git = (cwd: string, args: string[]) => new Promise<{ ok: boolean; out: string }>((done) => execFile('git', args, { cwd, timeout: 15_000, maxBuffer: 32 * 1024 * 1024 }, (err, out) => done({ ok: !err, out: String(out ?? '') })));

/**
 * Why the gate refuses this fix route, or null when it holds: the minion is a bug (type bug), the test is a file the
 * branch commits (one it changed, or a test file already there that main had red), red_on is a commit on main that the
 * branch is built on, and the diff from main touches no data or auth.
 */
export async function fixProofProblem(cwd: string, proof: FixProof, type: unknown, bases: string[] = ['main', 'origin/HEAD', 'origin/main']): Promise<string | null> {
  if (type !== 'bug') return `this minion's type is ${typeof type === 'string' && type ? type : 'unset'}, not bug: only a bug fix ships without a go`;
  const blob = await git(cwd, ['ls-tree', 'HEAD', '--', proof.test]);
  if (!/^\d+ blob /.test(blob.out)) return `fix_proof.test ${proof.test} isn't a file committed in your branch`;
  let base = '';
  for (const b of bases) if (!base && (await git(cwd, ['rev-parse', '--verify', '--quiet', `${b}^{commit}`])).ok) base = b;
  if (!base) return 'no main branch to check fix_proof.red_on against';
  const red = await git(cwd, ['rev-parse', '--verify', '--quiet', `${proof.redOn}^{commit}`]);
  if (!red.ok) return `fix_proof.red_on ${proof.redOn} isn't a commit here`;
  if (!(await git(cwd, ['merge-base', '--is-ancestor', proof.redOn, base])).ok) return `fix_proof.red_on ${proof.redOn} isn't on ${base}`;
  if (!(await git(cwd, ['merge-base', '--is-ancestor', proof.redOn, 'HEAD'])).ok) return `fix_proof.red_on ${proof.redOn} isn't in your branch: run the test on the main your branch is built on`;
  // --no-renames: a rename lists both its paths, so moving an auth file out from under its name still counts as auth.
  const names = await git(cwd, ['diff', '--name-only', '--no-renames', `${base}...HEAD`]);
  const diff = await git(cwd, ['diff', '-U0', '--no-color', '--no-renames', `${base}...HEAD`]);
  if (!names.ok || !diff.ok) return `couldn't read your branch's diff from ${base}`;
  const files = names.out.split('\n').map((f) => f.trim()).filter(Boolean);
  if (!files.includes(proof.test) && !TEST_PATH.test(proof.test)) return `fix_proof.test ${proof.test} is neither changed by your branch nor a test file`;
  const why = dataOrAuth(files, addedLines(diff.out));
  return why ? `${why}: data and auth changes always wait for a person's go` : null;
}
