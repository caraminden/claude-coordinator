// One scheme's Code tab numbers (#1988), from its git history, as JSON on stdout: node tools/code-counts.ts <repo> <days>,
// with the scheme's bug minions' numbers as a JSON array on stdin. src/code-counts.ts runs it at low priority once a day.
//
// Who changed a file: the first #N in each commit's subject (merges aside). A commit that names no minion belongs to the
// commit before it when both were committed within 2 minutes (a ship rebases its commits together), else it starts an unnamed ship.
//
// How a file's history carries over a split: it stays with the file it was made in, and stops counting there once that
// file is under half the size it was, for that code has moved out. A new file starts at nothing, and the minion
// that made it never counts on it. Renames aren't followed.
import { execFileSync } from 'node:child_process';
import { text } from 'node:stream/consumers';
import type { CodeFile, Counted } from '../src/code-counts.ts';
import { KIT_FILES } from '../src/kit-sync.ts';

const CODE = /\.(c|cc|cjs|cpp|cs|css|dart|ex|exs|fs|gd|gdshader|glsl|go|h|hpp|html|java|js|jsx|kt|kts|lua|m|mjs|mm|php|ps1|py|rb|rs|scala|scss|sh|sql|svelte|swift|ts|tsx|vue|wgsl|zig)$/;
const TEST = /(^|\/)(tests?|__tests__|specs?|e2e|fixtures)\/|[._-](test|spec)\.[^/]+$|(^|\/)test_[^/]+$|Tests?\.(cs|java|kt)$/;
const THEIRS = /(^|\/)(node_modules|vendor|docs|third[_-]party|dist)\/|\.(min|gen|generated|g)\.[^/]+$/;
/** Our own code: what a split could pay on. */
export const counted = (path: string) => CODE.test(path) && !TEST.test(path) && !THEIRS.test(path);

/** Commits committed this close to the one before are one ship. */
const SHIP_S = 120;
const LAST = 6;

interface Commit {
  sha: string;
  at: number;
  subject: string;
  changes: { path: string; added: number; gone: number }[];
  made: Set<string>;
}

/** `git log --numstat --summary --format=%x01%h%x09%ct%x09%s`, newest first. */
export function parseLog(log: string): Commit[] {
  return log
    .split('\x01')
    .slice(1)
    .map((part) => {
      const [head, ...lines] = part.split('\n');
      const [sha, at, ...subject] = head.split('\t');
      const c: Commit = { sha, at: Number(at), subject: subject.join('\t'), changes: [], made: new Set() };
      for (const l of lines) {
        const n = /^(\d+)\t(\d+)\t(.+)$/.exec(l); // a binary file's counts are "-": left out
        if (n) c.changes.push({ path: n[3], added: Number(n[1]), gone: Number(n[2]) });
        else if (l.startsWith(' create mode ')) c.made.add(l.slice(20));
      }
      return c;
    });
}

/** Each file's count. `lines` holds every file on the branch now; `commits` is newest first. */
export function countFiles(commits: Commit[], lines: Map<string, number>, bugs: Set<number>): CodeFile[] {
  const who = new Map<Commit, string>();
  let prev: { at: number; key: string } | null = null;
  for (const c of [...commits].reverse()) {
    const n = /#(\d{1,6})\b/.exec(c.subject)?.[1];
    const key: string = n ?? (prev && Math.abs(c.at - prev.at) <= SHIP_S ? prev.key : `~${c.sha}`);
    who.set(c, key);
    prev = { at: c.at, key };
  }
  const files = new Map<string, { size: number; keys: Set<string>; makers: Set<string> }>();
  for (const c of commits) {
    for (const ch of c.changes) {
      const now = lines.get(ch.path);
      if (!now || !counted(ch.path)) continue;
      let f = files.get(ch.path);
      if (!f) files.set(ch.path, (f = { size: now, keys: new Set(), makers: new Set() }));
      f.size = Math.max(0, f.size - ch.added + ch.gone); // what it was before this commit
      const key = who.get(c)!;
      if (c.made.has(ch.path)) f.makers.add(key);
      else if (f.size <= now * 2) f.keys.add(key); // keys go in newest first
    }
  }
  const out: CodeFile[] = [];
  for (const [path, f] of files) {
    const keys = [...f.keys].filter((k) => !f.makers.has(k));
    const numbers = keys.filter((k) => k[0] !== '~').map(Number);
    if (keys.length) out.push({ path, lines: lines.get(path)!, changed: keys.length, bugs: numbers.filter((n) => bugs.has(n)).length, who: numbers.slice(0, LAST) });
  }
  return out.sort((a, b) => b.changed - a.changed || (a.path < b.path ? -1 : 1));
}

/** Count `repo`'s main branch (or its default's), here or on origin, whichever moved last. */
export function countRepo(repo: string, days: number, bugs: number[], now = Date.now()): Counted {
  const git = (...args: string[]) => execFileSync('git', ['-c', 'core.quotePath=false', ...args], { cwd: repo, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, timeout: 240_000, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const refs = git('for-each-ref', '--sort=-committerdate', '--format=%(refname)', 'refs/heads/main', 'refs/heads/master', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main', 'refs/remotes/origin/master').split('\n').filter(Boolean);
  if (!refs.length) throw new Error('This repo has no main branch yet');
  // Level tips sort by name, so a local branch comes before origin's.
  const ref = refs[0];
  const commit = git('rev-parse', ref).trim();
  const log = git('log', `--since=${Math.floor(now / 1000) - days * 86400}`, '--no-merges', '--no-renames', '--numstat', '--summary', '--format=%x01%h%x09%ct%x09%s', commit);
  const lines = new Map<string, number>();
  for (const l of git('grep', '-I', '-c', '-z', '', commit).split('\n')) {
    const [name, n] = l.split('\0');
    if (n) lines.set(name.slice(commit.length + 1), Number(n));
  }
  // A scheme's copies of the kit's files are the kit's to split: left out, except where the kit itself lives.
  for (const k of KIT_FILES) if (!lines.has(k.template)) lines.delete(k.path);
  return { at: now, branch: ref.replace(/^refs\/(heads|remotes)\//, ''), commit, days, files: countFiles(parseLog(log), lines, new Set(bugs)) };
}

if (import.meta.main) {
  try {
    const [repo, days] = process.argv.slice(2);
    console.log(JSON.stringify(countRepo(repo, Number(days), JSON.parse(await text(process.stdin)) as number[])));
  } catch (err) {
    const e = err as Error & { stderr?: string };
    console.error((e.stderr?.trim() || e.message).split('\n')[0]);
    process.exitCode = 1;
  }
}
