// The PR behind a `gh pr merge` approval card (#200): which PR a Bash command merges and how, and the
// PR's title, branches, size and checks, looked up once when the card is posted.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { check, verdict } from './github.ts';

const run = promisify(execFile);
const VIEW_MS = 5_000;
const FIELDS = 'number,title,url,state,isDraft,headRefName,headRefOid,baseRefName,additions,deletions,changedFiles,commits,statusCheckRollup';

export interface MergeCall {
  /** The PR as the command names it: a number, a URL or a branch; null for the current branch's PR. */
  target: string | null;
  /** owner/name from --repo or the PR's URL; null for the repo the command runs in. */
  repo: string | null;
  method: 'squash' | 'merge' | 'rebase' | null;
  /** --auto merges once checks pass rather than now; --admin skips the branch's protections. */
  auto: boolean;
  admin: boolean;
  /** An earlier `cd` or `pushd` in the command, so a PR without a repo may not be the worktree's. */
  moved: boolean;
}

export interface PrInfo {
  number: number;
  title: string;
  url: string;
  state: string;
  draft: boolean;
  head: string;
  /** The head commit; cards from before #1916 have none. */
  oid?: string;
  base: string;
  additions: number;
  deletions: number;
  files: number;
  commits: number;
  checks: 'pending' | 'passed' | 'failed' | null;
}

type Token = { op: string } | { word: string };

/**
 * Shell words, with plain quotes removed, and the operators between commands (| ; & && || ( ) and
 * newlines), or null for anything this can't follow (an open quote or bracket).
 */
function tokenize(cmd: string): Token[] | null {
  const out: Token[] = [];
  let word = '';
  let started = false;
  // The next word is a redirect's target (`> out.txt`, `2>&1`), not an argument.
  let target = false;
  const end = () => {
    if (started && !target) out.push({ word: unquote(word) });
    else if (started) target = false;
    word = '';
    started = false;
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === '\\') {
      if (i + 1 >= cmd.length) return null;
      word += cmd.slice(i, i + 2);
      started = true;
      i++;
    } else if (c === "'") {
      const j = cmd.indexOf("'", i + 1);
      if (j < 0) return null;
      word += cmd.slice(i, j + 1);
      started = true;
      i = j;
    } else if (c === '"' || (c === '$' && (cmd[i + 1] === '(' || cmd[i + 1] === '{')) || c === '`') {
      const j = closing(cmd, i);
      if (j < 0) return null;
      word += cmd.slice(i, j + 1);
      started = true;
      i = j;
    } else if (c === '$') {
      word += c;
      started = true;
    } else if (c === '#' && !started) {
      // A comment runs to the end of the line.
      const j = cmd.indexOf('\n', i);
      if (j < 0) break;
      i = j - 1;
    } else if (/\s/.test(c) && c !== '\n') {
      end();
    } else if (c === '>' || c === '<') {
      // A file descriptor number before it (2>) belongs to the redirect.
      if (/^\d+$/.test(word)) started = false;
      end();
      if (cmd[i + 1] === c || cmd[i + 1] === '&') i++;
      target = true;
    } else if (c === '\n' || c === ';' || c === '|' || c === '&') {
      end();
      if (['&&', '||', ';;'].includes(cmd.slice(i, i + 2))) i++;
      out.push({ op: c });
    } else if (c === '(' || c === ')') {
      end();
      out.push({ op: c });
    } else {
      word += c;
      started = true;
    }
  }
  end();
  return out;
}

/** Where the quote, $( ), ${ } or backtick opening at `i` closes, or -1. */
function closing(s: string, i: number): number {
  if (s[i] === '`') return s.indexOf('`', i + 1);
  if (s[i] === '"') {
    for (let j = i + 1; j < s.length; j++) {
      if (s[j] === '\\') j++;
      else if (s[j] === '"') return j;
      else if (s[j] === '$' && (s[j + 1] === '(' || s[j + 1] === '{')) {
        j = closing(s, j);
        if (j < 0) return -1;
      }
    }
    return -1;
  }
  const open = s[i + 1];
  const shut = open === '(' ? ')' : '}';
  let depth = 0;
  for (let j = i + 1; j < s.length; j++) {
    const c = s[j];
    if (c === '\\') j++;
    else if (c === "'" && open === '(') {
      j = s.indexOf("'", j + 1);
      if (j < 0) return -1;
    } else if (c === '"' || c === '`' || (c === '$' && (s[j + 1] === '(' || s[j + 1] === '{'))) {
      j = closing(s, j);
      if (j < 0) return -1;
    } else if (c === open) depth++;
    else if (c === shut && --depth === 0) return j;
  }
  return -1;
}

/** A word's text with plain quotes removed; a word with $ or a backtick left in it depends on the shell. */
function unquote(w: string): string {
  return w.replace(/'([^']*)'|"((?:[^"\\$`]|\\.)*)"|\\(.)/g, (_m, a, b, c) => a ?? (b !== undefined ? b.replace(/\\(.)/g, '$1') : c));
}

const literal = (t: { word: string }) => !/[$`]/.test(t.word);

// gh pr merge's flags that take a value (the rest are switches).
const VALUED = new Set(['--repo', '-R', '--match-head-commit', '--body', '-b', '--body-file', '-F', '--subject', '-t', '--author-email', '-A']);
const METHODS: Record<string, MergeCall['method']> = { '--squash': 'squash', '-s': 'squash', '--merge': 'merge', '-m': 'merge', '--rebase': 'rebase', '-r': 'rebase' };
const PR_URL = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/;

/**
 * The one `gh pr merge` a Bash command runs, anywhere in a pipe or a chain, or null: no merge, more
 * than one (counting any inside $( ), quotes or `xargs gh …`), a PR or repo that depends on the
 * shell (a variable or a substitution), or GH_REPO or GH_HOST named anywhere in it. Null keeps the plain card, so a wrong guess never reaches it.
 */
export function parseMerge(command: string): MergeCall | null {
  if (command.match(/\bgh\s+pr\s+merge\b/g)?.length !== 1) return null;
  // GH_REPO or GH_HOST set in the command points gh somewhere the lookup wouldn't follow.
  if (/\bGH_(REPO|HOST)\b/.test(command)) return null;
  const tokens = tokenize(command);
  if (!tokens) return null;
  const commands: { word: string }[][] = [[]];
  for (const t of tokens) 'op' in t ? commands.push([]) : commands.at(-1)!.push(t);
  let moved = false;
  for (const c of commands) {
    const w = c.slice(c.findIndex((t) => !/^[A-Za-z_]\w*=/.test(t.word)));
    if (w[0]?.word === 'cd' || w[0]?.word === 'pushd') moved = true;
    if (w[0]?.word === 'gh' && w[1]?.word === 'pr' && w[2]?.word === 'merge') {
      const call = mergeArgs(w.slice(3));
      return call && { ...call, moved };
    }
  }
  return null;
}

function mergeArgs(args: { word: string }[]): MergeCall | null {
  const call: MergeCall = { target: null, repo: null, method: null, auto: false, admin: false, moved: false };
  const methods = new Set<MergeCall['method']>();
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    let flag = t.word;
    let value: { word: string } | undefined;
    if (flag.startsWith('--') && flag.includes('=')) {
      value = { word: flag.slice(flag.indexOf('=') + 1) };
      flag = flag.slice(0, flag.indexOf('='));
    } else if (/^-[A-Za-z]./.test(flag)) {
      // Bundled switches (-sd); a value flag ends the bundle and takes the rest (-Ro/r, -R=o/r), or the next word.
      const letters = flag.slice(1);
      let k = 0;
      for (; k < letters.length && !VALUED.has(`-${letters[k]}`); k++) {
        if (!/[A-Za-z]/.test(letters[k])) return null;
        const m = METHODS[`-${letters[k]}`];
        if (m) methods.add(m);
      }
      if (k === letters.length) continue;
      flag = `-${letters[k]}`;
      if (k + 1 < letters.length) value = { word: letters.slice(k + 1).replace(/^=/, '') };
    }
    if (flag === '--') return null;
    if (METHODS[flag]) methods.add(METHODS[flag]);
    else if (flag === '--auto') call.auto = true;
    else if (flag === '--admin') call.admin = true;
    else if (VALUED.has(flag)) {
      value ??= args[++i];
      if (!value) return null;
      if (flag === '--repo' || flag === '-R') {
        if (!literal(value) || !/^([\w.-]+\/)?[\w.-]+\/[\w.-]+$/.test(value.word)) return null;
        call.repo = value.word.replace(/^github\.com\//, '');
      }
    } else if (flag.startsWith('-')) {
      if (flag.length < 2) return null;
      // Another switch (--delete-branch, --disable-auto, -d): nothing the card shows.
    } else {
      if (call.target !== null || !literal(t)) return null;
      call.target = t.word.replace(/^#(?=\d+$)/, '');
    }
  }
  if (methods.size > 1) return null;
  call.method = [...methods][0] ?? null;
  const url = call.target?.match(PR_URL);
  if (url) {
    if (call.repo && call.repo.toLowerCase() !== url[1].toLowerCase()) return null;
    call.repo = url[1];
    call.target = url[2];
  }
  return call;
}

/**
 * The PR a merge call names, from one `gh pr view` in the minion's worktree with the turn's own GitHub
 * env, or null if gh fails or takes over five seconds (the card then shows what the command says).
 * A command that moved elsewhere first and names no repo isn't looked up: it might be another repo's PR.
 */
export async function prInfo(call: MergeCall, cwd: string, env: Record<string, string>): Promise<PrInfo | null> {
  if (call.moved && !call.repo) return null;
  const args = ['pr', 'view', ...(call.target ? [call.target] : []), ...(call.repo ? ['--repo', call.repo] : []), '--json', FIELDS];
  try {
    const { stdout } = await run('gh', args, { cwd, env: { ...env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' }, timeout: VIEW_MS, maxBuffer: 4 * 1024 * 1024 });
    return toInfo(JSON.parse(stdout));
  } catch {
    return null;
  }
}

/** gh's JSON for a PR as the card keeps it; null if it isn't one. */
export function toInfo(d: Record<string, unknown>): PrInfo | null {
  if (!d || typeof d.number !== 'number' || typeof d.title !== 'string') return null;
  const n = (v: unknown) => (typeof v === 'number' ? v : 0);
  const s = (v: unknown) => (typeof v === 'string' ? v : '');
  return {
    number: d.number,
    title: d.title.slice(0, 300),
    url: /^https:\/\//.test(s(d.url)) ? s(d.url) : '',
    state: s(d.state),
    draft: d.isDraft === true,
    head: s(d.headRefName).slice(0, 200),
    ...(s(d.headRefOid) ? { oid: s(d.headRefOid).slice(0, 64) } : {}),
    base: s(d.baseRefName).slice(0, 200),
    additions: n(d.additions),
    deletions: n(d.deletions),
    files: n(d.changedFiles),
    commits: Array.isArray(d.commits) ? d.commits.length : 0,
    checks: Array.isArray(d.statusCheckRollup) ? verdict(d.statusCheckRollup.map(check)) : null,
  };
}
