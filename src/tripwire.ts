// The tripwire: a PreToolUse hook the runner adds to every turn (tripwireHooks in runner.ts), for
// Taskmasters and minions in every scheme. It stops the known accidents (writes to the live database,
// the live checkout, the service's config and units, other schemes' folders; restarting or stopping
// the app's services; reading SSH keys, the Claude or GitHub login, the service's env file or any
// process's environment, or printing the turn's own; state.db opened writable and the credentials
// table; other people's homes and Claude runners; signing Claude in; running server.ts against the
// live data) and the git habits every scheme shares (no path checkout, restore or stash; no checkout,
// merge or reset over uncommitted changes; no push to main or plain force push from a minion's
// worktree), and says why and what to do instead.
//
// Two tiers. Real dangers are hard blocks. Things a person may reasonably want once (deleting or
// changing files in the data dir other than the live database, installing or enabling a user unit)
// "ask" instead: in a minion's turn, a Bash call with a description that explains it goes to an
// Approve / Deny card for that exact call (Approvals.ask in approvals.ts). Nothing a minion does
// switches a tier off; only a person's click lets one call through.
//
// It is a tripwire, NOT a security boundary. It reads the command text, so anything that hides the
// path from that text gets past it: a script file, an interpreter (`python -c`, `node -e`), a path
// held in a variable, a symlink, `$(…)` inside double quotes, `xargs`, a glob in the middle of a path.
// It aims to never block normal work; where it can't tell, it lets the command through.
//
// Run as a hook: node tripwire.ts '<config json>' < hook input; exits 2 with the reason on stderr, or
// prints a PreToolUse "ask" decision for the approval card.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface TripwireConfig {
  home: string;
  /** The live data dir (DATA_DIR of the server that started the turn). */
  data: string;
  /** The checkout that server runs from. */
  checkout: string;
  /** The turn's own scheme (project id); its folder under data/projects is the one writable part. */
  project: number;
  claudeConfig: string;
  /** Whether tools/deploy.sh exists in the checkout; read from disk when left out. */
  deployScript?: boolean;
  /** Whether this turn can show an approval card (minions can; Taskmasters can't), so ask-tier calls ask. */
  ask?: boolean;
}

/** Why a call is stopped, and whether a person may approve it once on a card instead. */
export interface Verdict { reason: string; ask: boolean }
const hard = (reason: string): Verdict => ({ reason, ask: false });

/** The shortest Bash description that counts as the explanation an approval card needs. */
export const MIN_EXPLANATION = 20;

const ASK = 'If a person really wants this, they can run it themselves.';

const under = (p: string, root: string) => p === root || p.startsWith(root.endsWith('/') ? root : root + '/');

function deployNote(cfg: TripwireConfig): string {
  return hasDeployScript(cfg)
    ? 'Deploys go through tools/deploy.sh: run it from your worktree once your change is on main.'
    : `Deploy with \`git pull --ff-only\` there (the one change allowed until tools/deploy.sh lands) and the cc-restart-when-idle unit.`;
}
function hasDeployScript(cfg: TripwireConfig): boolean {
  return cfg.deployScript ?? existsSync(join(cfg.checkout, 'tools/deploy.sh'));
}

/** Why a write to this absolute path is blocked, or null. */
function writeReason(p: string, cfg: TripwireConfig): string | null {
  const configDir = join(cfg.home, '.config');
  if (under(p, cfg.checkout)) return `${cfg.checkout} is the live checkout the service runs from. Change code in your own worktree and merge to main. ${deployNote(cfg)}`;
  const projects = join(cfg.data, 'projects');
  if (under(p, projects) && p !== projects) {
    const id = p.slice(projects.length + 1).split('/')[0];
    if (id === String(cfg.project)) return null;
    if (/^\d+$/.test(id)) return `${join(projects, id)} belongs to another scheme (${id}; yours is ${cfg.project}). Read it if you need to, but leave changes there to that scheme's minions: ask your Taskmaster to pass it on.`;
  }
  if (under(p, cfg.data)) return `${cfg.data} is the live data dir: the database, its backups and every scheme's folders. Read the database with \`sqlite3 -readonly\`; change data through the app, or ask a person.`;
  if (under(p, join(configDir, 'claude-coordinator'))) return `${join(configDir, 'claude-coordinator')} holds the live service's env file. Ask Cara to change it.`;
  for (const units of [join(configDir, 'systemd/user'), join(configDir, 'containers/systemd')]) {
    if (under(p, units)) return `${units} holds the box's service units. Put unit files in the repo (deploy/) and ask Cara to install them.`;
  }
  return runnerReason(p, cfg);
}

/** Why reading this absolute path is blocked, or null. */
function readReason(p: string, cfg: TripwireConfig): string | null {
  if (under(p, join(cfg.home, '.ssh'))) return `${join(cfg.home, '.ssh')} holds SSH keys; nothing here needs to read them (ssh and git use them on their own).`;
  if (p === join(cfg.claudeConfig, '.credentials.json') || p === join(cfg.home, '.claude/.credentials.json')) return 'That file is the Claude login; nothing here needs to read it.';
  if (under(p, join(cfg.home, '.config/claude-coordinator'))) return `${join(cfg.home, '.config/claude-coordinator')} holds the live service's password and session secret, which let anyone act as a person. To try the API, log in to a dev copy or a preview with its own password; ask Cara to change the env file.`;
  if (ENVIRON.test(p)) return ENVIRON_WHY;
  if (p === join(cfg.home, '.config/gh/hosts.yml')) return GH_TOKEN_WHY;
  return runnerReason(p, cfg);
}

/** Why a read or write of this path is blocked as another person's (their home, their runner's sign-in), or null. */
function runnerReason(p: string, cfg: TripwireConfig): string | null {
  const homes = dirname(cfg.home);
  if (homes !== '/' && under(p, homes) && p !== homes && !under(p, cfg.home)) return `${p} is in another person's home folder, where their Claude runner and sign-in live. Leave it to them.`;
  if (p.split('/').includes('citadel-claude') || RUNNER_SOCKET.test(basename(p))) return `${p} belongs to a Claude runner: its sign-in or its socket. Turns never touch a runner directly; Citadel talks to it.`;
  return null;
}
const RUNNER_SOCKET = /^(citadel|claude)-runner.*\.sock$/;
// A runner's endpoints in Citadel's API (pairing, connecting): only the runner itself calls them.
const RUNNER_API = /\/api\/(claude-)?runners?\b/;
const NETWORK = new Set(['curl', 'wget', 'http', 'https', 'xh', 'websocat', 'socat', 'nc', 'ncat']);

// A process's environment holds whatever secrets it started with (the service's password and session secret).
const ENVIRON = /^\/proc\/[^/]+(\/task\/[^/]+)?\/environ$/;
const ENVIRON_WHY = "A process's environment can hold the live service's password and session secret. To find your dev server, take the pid from `ss -ltnp 'sport = :<your port>'` (or `$!` when you start it) and check `readlink /proc/<pid>/cwd`.";
const GH_TOKEN_WHY = "That is Cara's GitHub login; gh and git use it on their own.";
// The same read with the pid in a variable, where the lexer leaves an unknown `/proc//environ`, or in
// `$(…)`, where it splits the path into `/proc/`, the ( … ) and the rest (see commandReason).
const ENVIRON_HIDDEN = /^\/proc\/[^/]*(\/task\/[^/]*)?\/environ$/;
const ENVIRON_REST = /^(\/task\/[^/]*)?\/environ$/;

/** For a recursive search: a secret readReason guards that lies inside this folder, or null. */
function secretInside(root: string, cfg: TripwireConfig): string | null {
  const secrets = [join(cfg.home, '.ssh'), join(cfg.claudeConfig, '.credentials.json'), join(cfg.home, '.claude/.credentials.json'), join(cfg.home, '.config/claude-coordinator'), join(cfg.home, '.config/gh/hosts.yml'), join(cfg.home, '.config/citadel-claude')];
  const homes = dirname(cfg.home);
  if (homes !== '/' && under(homes, root)) return `other people's home folders in ${homes}`;
  return secrets.find((x) => x !== root && under(x, root)) ?? null;
}
const SEARCHERS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag']);
// grep and rg options whose value is the next word (alone, or ending a cluster like -rnA 3).
const SEARCH_VALUE = /^-[a-zA-Z]*[efmABCdDtTgjM]$|^--(regexp|file|max-count|context|before-context|after-context|type|type-not|glob|iglob|threads|max-depth|include|exclude|exclude-dir|max-columns)$/;

/** The folders a grep or rg names to search: its plain words after the pattern, which -e or -f give instead. */
function searchRoots(args: Word[]): Word[] {
  const plain: Word[] = [];
  let given = false;
  for (let k = 0; k < args.length; k++) {
    const t = args[k].text;
    if (t === '--') {
      plain.push(...args.slice(k + 1));
      break;
    }
    if (!t.startsWith('-') || t === '-') plain.push(args[k]);
    else {
      if (/^-[a-zA-Z]*[ef]|^--(regexp|file)\b/.test(t)) given = true;
      if (SEARCH_VALUE.test(t)) k++;
    }
  }
  return given ? plain : plain.slice(1);
}

const LIVE_DB = ['coordinator.db', 'coordinator.db-wal', 'coordinator.db-shm', 'coordinator.db-journal', 'state.db', 'state.db-wal', 'state.db-shm', 'state.db-journal'];

/** Whether a person may approve this write once, rather than it being a hard block. */
function askable(p: string, cmd: string, cfg: TripwireConfig): boolean {
  const configDir = join(cfg.home, '.config');
  // Copying a unit into the folder can ask; deleting the folder itself, or touching the app's own units, can't.
  if ([join(configDir, 'systemd/user'), join(configDir, 'containers/systemd')].some((u) => under(p, u) && (p !== u || !REMOVERS.has(cmd)))) return !APP_UNITS.test(basename(p));
  // Other schemes' folders and the projects folder itself stay off limits, as does the whole data dir.
  if (!under(p, cfg.data) || p === cfg.data || under(p, join(cfg.data, 'projects'))) return false;
  // SQL on the live database can be read on the card (when it's in the command: see sqlShown); clobbering
  // the file (rm, mv, cp over it, a glob) can't.
  if (cmd === 'sqlite3') return true;
  if (dirname(p) !== cfg.data) return true;
  // Brace expansion could name anything; a glob is matched against the live files' names.
  const base = basename(p);
  if (base.includes('{')) return false;
  const glob = new RegExp(`^${base.split(/(\*|\?|\[[^\]]*\])/).map((part, k) => (k % 2 ? (part === '*' ? '.*' : '.') : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('')}$`);
  return !LIVE_DB.some((f) => glob.test(f));
}

/** For rm and mv: deleting or moving a folder that contains a protected one. */
function containsProtected(p: string, cfg: TripwireConfig): boolean {
  const configDir = join(cfg.home, '.config');
  const roots = [cfg.checkout, cfg.data, join(configDir, 'claude-coordinator'), join(configDir, 'systemd/user'), join(configDir, 'containers/systemd'), join(cfg.home, '.ssh')];
  return roots.some((r) => r !== p && under(r, p));
}

// ---------- reading shell commands ----------

interface Word { text: string; unknown: boolean }
type Tok = { kind: 'word'; word: Word } | { kind: 'op'; text: string } | { kind: 'redir'; op: string };

/**
 * Splits a bash command into words, redirects and operators (; && || | & newline ( ) and backticks).
 * Expands ~, $HOME and ${HOME}; a word with any other $-expansion is marked unknown and never treated
 * as a path. Heredoc bodies are skipped, so a commit message can mention any path.
 */
export function lex(s: string, home: string): Tok[] {
  const toks: Tok[] = [];
  const heredocs: { delim: string; strip: boolean }[] = [];
  let text = '';
  let unknown = false;
  let inWord = false;
  let quotedStart = false;
  const flush = () => {
    if (inWord) toks.push({ kind: 'word', word: { text, unknown } });
    text = '';
    unknown = false;
    inWord = false;
    quotedStart = false;
  };
  const n = s.length;
  // Reads a $ expansion at s[i] ('$'); returns the next index.
  const dollar = (i: number): number => {
    const c = s[i + 1];
    if (c === '(') {
      // Only reached inside double quotes: skip to the matching paren, stepping over heredoc bodies
      // (the usual `git commit -m "$(cat <<'EOF' … EOF)"` message may hold unbalanced parens).
      let depth = 0;
      let j = i + 1;
      for (; j < n; j++) {
        const doc = s[j] === '<' ? /^<<-?[ \t]*(['"]?)([^\s'";&|<>()]+)\1[^\n]*\n/.exec(s.slice(j)) : null;
        if (doc) {
          const end = s.slice(j + doc[0].length).search(new RegExp(`^\\t*${doc[2].replace(/\W/g, '\\$&')}$`, 'm'));
          if (end < 0) return n;
          j += doc[0].length + end + doc[2].length;
        } else if (s[j] === '(') depth++;
        else if (s[j] === ')' && --depth === 0) break;
      }
      unknown = true;
      return j + 1;
    }
    let name = '';
    let j = i + 1;
    if (c === '{') {
      const end = s.indexOf('}', j);
      if (end < 0) return n;
      name = s.slice(j + 1, end);
      j = end + 1;
    } else {
      const m = /^([A-Za-z_]\w*|[0-9@*#?$!-])/.exec(s.slice(j));
      if (!m) {
        text += '$';
        inWord = true;
        return i + 1;
      }
      name = m[1];
      j += name.length;
    }
    if (name === 'HOME') text += home;
    else unknown = true;
    inWord = true;
    return j;
  };
  let i = 0;
  while (i < n) {
    const c = s[i];
    if (c === "'") {
      const end = s.indexOf("'", i + 1);
      text += s.slice(i + 1, end < 0 ? n : end);
      if (!inWord) quotedStart = true;
      inWord = true;
      i = end < 0 ? n : end + 1;
      continue;
    }
    if (c === '$' && s[i + 1] === "'") {
      // ANSI-C quoting: rare enough to take literally.
      const end = s.indexOf("'", i + 2);
      text += s.slice(i + 2, end < 0 ? n : end);
      inWord = true;
      i = end < 0 ? n : end + 1;
      continue;
    }
    if (c === '"') {
      if (!inWord) quotedStart = true;
      inWord = true;
      i++;
      while (i < n && s[i] !== '"') {
        if (s[i] === '\\' && i + 1 < n && '"\\$`\n'.includes(s[i + 1])) {
          if (s[i + 1] !== '\n') text += s[i + 1];
          i += 2;
        } else if (s[i] === '$') i = dollar(i);
        else if (s[i] === '`') {
          const end = s.indexOf('`', i + 1);
          unknown = true;
          i = end < 0 ? n : end + 1;
        } else text += s[i++];
      }
      i++;
      continue;
    }
    if (c === '\\') {
      if (s[i + 1] !== '\n' && i + 1 < n) {
        text += s[i + 1];
        inWord = true;
      }
      i += 2;
      continue;
    }
    if (c === '$') {
      if (s[i + 1] === '(') {
        flush();
        toks.push({ kind: 'op', text: '(' });
        i += 2;
        continue;
      }
      i = dollar(i);
      continue;
    }
    if (c === '~' && !inWord && (i + 1 >= n || /[\/\s;&|)]/.test(s[i + 1]))) {
      text += home;
      inWord = true;
      i++;
      continue;
    }
    if (c === '#' && !inWord) {
      while (i < n && s[i] !== '\n') i++;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      flush();
      i++;
      continue;
    }
    if (c === '\n') {
      flush();
      toks.push({ kind: 'op', text: '\n' });
      i++;
      // Skip the bodies of heredocs started on the line that just ended.
      for (const h of heredocs.splice(0)) {
        while (i < n) {
          const eol = s.indexOf('\n', i);
          const line = s.slice(i, eol < 0 ? n : eol);
          i = eol < 0 ? n : eol + 1;
          if ((h.strip ? line.replace(/^\t+/, '') : line) === h.delim) break;
        }
      }
      continue;
    }
    if (c === '<' || c === '>' || (c === '&' && s[i + 1] === '>')) {
      // A bare number right before is the file descriptor, not a word.
      if (inWord && !quotedStart && !unknown && /^\d+$/.test(text)) {
        text = '';
        inWord = false;
      } else flush();
      const op = /^(&>>|&>|>>|>\||>&|>|<<<|<<-|<<|<>|<&|<)/.exec(s.slice(i))![1];
      i += op.length;
      if (op === '>&' || op === '<&') {
        const dup = /^\s*(\d+|-)/.exec(s.slice(i));
        if (dup) {
          i += dup[0].length;
          continue;
        }
      }
      if (op === '<<' || op === '<<-') {
        const m = /^[ \t]*(['"]?)([^\s'";&|<>()]+)\1/.exec(s.slice(i));
        if (m) {
          heredocs.push({ delim: m[2], strip: op === '<<-' });
          i += m[0].length;
        }
        continue;
      }
      toks.push({ kind: 'redir', op });
      continue;
    }
    if (c === ';' || c === '&' || c === '|' || c === '(' || c === ')' || c === '`') {
      flush();
      const two = s.slice(i, i + 2);
      const op = ['&&', '||', '|&', ';;'].includes(two) ? two : c;
      toks.push({ kind: 'op', text: op === '`' ? ';' : op });
      i += op.length;
      continue;
    }
    text += c;
    inWord = true;
    i++;
  }
  flush();
  return toks;
}

interface Segment { words: Word[]; redirects: { op: string; target: Word }[] }
interface State { cwd: string | null; vars: Set<string>; committed?: boolean }

// Only these commands count as writes. Anything else is taken as a read, so an interpreter or tool
// that names a protected path (`node -e … coordinator.db`, `curl`) goes through: few false alarms,
// at the cost of missing writes this list doesn't know.
const REMOVERS = new Set(['rm', 'rmdir', 'mv', 'unlink', 'shred']);
const SQL_WRITE = /\b(insert|update|delete|drop|alter|create|replace|vacuum|reindex|attach|detach)\b|^\.(import|restore|read|load|shell|system|output|once|save)/im;
// Commands that look at a path without showing what's in it; fine even for keys.
const METADATA = new Set(['ls', 'stat', 'test', '[', '[[', 'du', 'find', 'namei', 'realpath', 'readlink', 'getfacl', 'lsattr', 'chmod', 'chown']);
// Prefixes that run the next word as the command.
const WRAPPERS = new Set(['env', 'command', 'builtin', 'exec', 'nohup', 'nice', 'time', 'timeout', 'stdbuf', 'xargs', 'ionice', 'chrt', 'flock']);
const KEYWORDS = new Set(['!', '{', '}', 'then', 'do', 'else', 'if', 'while', 'until', 'elif', 'fi', 'done', 'esac']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish']);
// ssh and friends take key paths and remote paths; their arguments are not local reads or writes.
const REMOTE = new Set(['ssh', 'scp', 'sftp', 'ssh-add', 'ssh-keygen', 'ssh-copy-id', 'mosh']);
const APP_UNITS = /^(claude-coordinator|perigee-godot[\w-]*)(\.service)?$/;
const STOP_VERBS = new Set(['restart', 'stop', 'kill', 'try-restart', 'reload-or-restart', 'try-reload-or-restart', 'condrestart', 'force-reload', 'freeze']);
const UNIT_FILE_VERBS = new Set(['enable', 'disable', 'reenable', 'mask', 'unmask', 'link', 'edit', 'revert', 'preset', 'add-wants', 'add-requires', 'set-property']);
const GIT_READ = new Set(`status log diff show blame rev-parse rev-list ls-files ls-tree ls-remote cat-file describe shortlog grep fetch help version
whatchanged show-ref for-each-ref merge-base name-rev count-objects check-ignore var cherry range-diff format-patch archive merge-tree`.split(/\s+/));

/** Paths a word may name: the word itself, and an option's or dd operand's value after `=`. */
function pathsOf(w: Word, st: State, cfg: TripwireConfig): string[] {
  if (w.unknown || !w.text) return [];
  const eq = w.text.indexOf('=');
  const candidates = w.text.startsWith('-') ? (eq > 0 ? [w.text.slice(eq + 1)] : []) : eq > 0 ? [w.text, w.text.slice(eq + 1)] : [w.text];
  const out: string[] = [];
  for (let c of candidates) {
    if (c.startsWith('~/') || c === '~') c = cfg.home + c.slice(1);
    // URLs, host:path and the like.
    if (/^[A-Za-z][\w+.@-]*:/.test(c)) continue;
    if (isAbsolute(c)) out.push(resolve(c));
    else if (st.cwd && c) out.push(resolve(st.cwd, c));
  }
  return out;
}

/** The arguments a command writes to; empty for a command that only reads. */
function writeTargets(name: string, args: Word[]): Word[] {
  const a = args.map((w) => w.text);
  const plain = args.filter((w) => !w.text.startsWith('-'));
  switch (name) {
    case 'rm': case 'rmdir': case 'mv': case 'unlink': case 'shred': case 'touch': case 'mkdir': case 'tee': case 'truncate': case 'patch':
      return args;
    case 'cp': case 'rsync': case 'install': case 'ln': {
      const t = a.findIndex((x) => x === '-t' || x === '--target-directory');
      return t >= 0 ? args.slice(t + 1, t + 2) : [...args.filter((w) => w.text.startsWith('--target-directory=')), ...plain.slice(-1)];
    }
    case 'dd':
      return args.filter((w) => w.text.startsWith('of='));
    case 'sed': case 'perl': {
      if (!a.some((t) => /^-[a-zA-Z]*i/.test(t) || t.startsWith('--in-place'))) return [];
      // The files, not the script: that follows -e, or is the first plain word.
      const files: Word[] = [];
      let script = false;
      for (let i = 0; i < args.length; i++) {
        if (/^-[a-zA-Z]*e$|^--expression$/.test(a[i])) (script = true), i++;
        else if (!a[i].startsWith('-')) files.push(args[i]);
      }
      return script ? files : files.slice(1);
    }
    case 'awk': case 'gawk':
      return a.some((t) => t.includes('inplace')) ? args : [];
    case 'sort':
      return a.some((t) => /^-[a-zA-Z]*o/.test(t) || t.startsWith('--output')) ? args : [];
    case 'find':
      return a.includes('-delete') || a.some((t, i) => /^-(exec|execdir|ok|okdir)$/.test(t) && REMOVERS.has(basename(a[i + 1] ?? ''))) ? args : [];
    case 'sqlite3': {
      if (a.some((t) => t === '-readonly' || t === '--readonly' || t.includes('mode=ro'))) return [];
      const [db, ...sql] = sqliteOperands(args);
      // Plain queries are reads; SQL that writes, or SQL fed on stdin where we can't see it, is a write.
      return db && (sql.length === 0 || sql.some((w) => SQL_WRITE.test(w.text))) ? [db] : [];
    }
  }
  return [];
}

/** A sqlite3 call's database and SQL: its plain words, past the options and their values. */
function sqliteOperands(args: Word[]): Word[] {
  const rest: Word[] = [];
  for (let i = 0; i < args.length; i++) {
    if (/^--?(cmd|separator|newline|nullvalue|init|vfs|maxsize|mmap|lookaside|pagecache|heap)$/.test(args[i].text)) i++;
    else if (!args[i].text.startsWith('-')) rest.push(args[i]);
  }
  return rest;
}

const ENV_WHY = "A turn's environment can hold its tokens. Check one variable with `[ -n \"$NAME\" ] && echo set`, or print a harmless one with `echo \"$PATH\"`.";

/**
 * Why a sqlite3 call on the live data is blocked, or null: state.db (every minion's session) opened
 * writable, or SQL that reads the credentials table (people's linked accounts), a whole-file `.dump` included.
 */
function sqliteReason(args: Word[], st: State, cfg: TripwireConfig): string | null {
  const a = args.map((w) => w.text);
  const [db, ...sql] = sqliteOperands(args);
  if (!db) return null;
  const file = db.text.startsWith('file:') ? { ...db, text: db.text.slice(5).replace(/\?.*$/, '') } : db;
  const p = pathsOf(file, st, cfg)[0];
  if (!p || !under(p, cfg.data)) return null;
  const readonly = a.some((t) => t === '-readonly' || t === '--readonly' || t.includes('mode=ro'));
  if (/^state\b/.test(basename(p)) && !readonly) return `${basename(p)} holds every minion's Claude session. Open it with \`sqlite3 -readonly\`.`;
  if (!sqlShown(args)) return "SQL piped in or read from a file can't be checked for the credentials table. Put it in the command: `sqlite3 -readonly <db> 'select …'`.";
  const shown = [...sql, ...args.filter((_, k) => /^--?cmd$/.test(a[k - 1] ?? ''))].map((w) => w.text);
  if (shown.some((t) => /\bcredentials\b/i.test(t) || /^\s*\.dump\s*$/m.test(t))) return "The credentials table holds people's linked accounts; nothing here needs to read it. Name the tables you need (`.dump tickets`).";
  return null;
}

/** Whether a sqlite3 call's SQL is all in the command, rather than on stdin or in a file it reads. */
function sqlShown(args: Word[]): boolean {
  const plain = args.filter((w) => !w.text.startsWith('-'));
  return plain.length > 1 && !args.some((w) => /^\s*\.(read|restore|import|load|shell|system)\b/m.test(w.text));
}

function gitReason(args: Word[], st: State, cfg: TripwireConfig): Verdict | null {
  let dir = st.cwd;
  let j = 0;
  for (; j < args.length; j++) {
    const t = args[j].text;
    if (t === '-C') {
      const p = args[j + 1];
      dir = p && !p.unknown ? (st.cwd ? resolve(st.cwd, p.text) : isAbsolute(p.text) ? p.text : null) : null;
      j++;
    } else if (t === '-c' || t === '--git-dir' || t === '--work-tree' || t === '--namespace') j++;
    else if (!t.startsWith('-')) break;
  }
  const sub = args[j]?.text ?? '';
  const rest = args.slice(j + 1).map((w) => w.text);
  const opts = rest.filter((t) => t.startsWith('-'));
  const plain = rest.filter((t) => !t.startsWith('-'));
  const listing =
    GIT_READ.has(sub) ||
    (sub === 'branch' && !opts.some((t) => /^-[a-zA-Z]*[dDmMcCf]|^--(delete|move|copy|force|set-upstream|unset-upstream|edit)/.test(t)) && (plain.length === 0 || opts.some((t) => ['-a', '-r', '-l', '--list', '--contains', '--merged', '--no-merged', '--points-at'].includes(t)))) ||
    (sub === 'tag' && (plain.length === 0 || opts.some((t) => t === '-l' || t === '--list' || t === '--contains'))) ||
    (sub === 'remote' && (plain.length === 0 || ['show', 'get-url'].includes(plain[0]))) ||
    (sub === 'stash' && ['list', 'show'].includes(plain[0])) ||
    (sub === 'worktree' && plain[0] === 'list') ||
    (sub === 'config' && opts.some((t) => ['--get', '--get-all', '--get-regexp', '--list', '-l'].includes(t))) ||
    (sub === 'reflog' && !['delete', 'expire'].includes(plain[0]));
  if (listing) return null;
  const inDir = dir ? writeReason(dir, cfg) : null;
  if (inDir) {
    // Until tools/deploy.sh exists, a fast-forward of the live checkout is how deploys happen.
    if (dir && under(dir, cfg.checkout) && (sub === 'pull' || sub === 'merge') && rest.includes('--ff-only') && !hasDeployScript(cfg)) return null;
    return hard(`git ${sub} would change ${dir}. ${inDir}`);
  }
  const targets = sub === 'clone' ? args.slice(j + 1).filter((w) => !w.text.startsWith('-')).slice(1) : args.slice(j + 1);
  // Relative paths after -C are relative to that folder.
  for (const w of targets) {
    for (const p of pathsOf(w, { cwd: dir, vars: st.vars }, cfg)) {
      const r = writeReason(p, cfg);
      if (r) return hard(`git ${sub} would change ${p}. ${r}`);
    }
  }
  const committed = st.committed;
  // Commit first, then move: the move's dirty check can't see what the commit will take.
  if (sub === 'commit') st.committed = true;
  return gitHabitReason(sub, args.slice(j + 1), dir, cfg, committed);
}

// CLAUDE.md's "commit before you move", ported from Delve's git guard (tools/mods/delve/hooks, judgeGit).
const NEVER_PATH = 'Never check out, restore or stash a path to look at it: that throws away uncommitted work. Use `git show HEAD:path` or `git diff` to see the old version, and commit (a WIP commit is fine) before undoing anything.';
const STASH_WHY = 'The stash stack is shared by every worktree of the repo, so another session can pop your entry, or you theirs. Commit work in progress instead (a WIP commit is fine), and use `git show HEAD:path` or `git diff` to see the old version.';
const PROTECTED = /^(main|master)$/;
const MAIN_WHY = "main changes only through the scheme's own route (tools/land.sh and tools/deploy.sh, or a merged pull request), never a push from a minion's worktree. Push your minion branch.";

/** Runs git in dir: null when it can't run there (no such folder, not a repo), so the guard lets the call through. */
function git(dir: string, ...args: string[]): { status: number; out: string } | null {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', timeout: 3000 });
  return r.error || r.status === null ? null : { status: r.status, out: r.stdout };
}

/** A minion's worktree: <data>/projects/<id>/tickets/<n>, in any scheme. */
function inWorktree(dir: string, cfg: TripwireConfig): boolean {
  const projects = join(cfg.data, 'projects');
  return under(dir, projects) && /^\d+\/tickets\/[^/]+/.test(dir.slice(projects.length + 1));
}

/**
 * The git habits every scheme shares: no path checkout, restore or stash; no checkout, merge, rebase or
 * reset over uncommitted tracked changes; from a minion's worktree, no push to main and no plain force.
 * With the folder unknown it checks only what the words alone show.
 */
function gitHabitReason(sub: string, args: Word[], dir: string | null, cfg: TripwireConfig, committed = false): Verdict | null {
  const words = args.map((w) => w.text);
  const has = (...flags: string[]) => words.some((a) => flags.includes(a));
  const plain = args.filter((w) => !w.text.startsWith('-'));
  let move: string | null = null;
  switch (sub) {
    case 'stash':
      return ['list', 'show'].includes(words[0]) ? null : hard(`\`git stash\` is blocked. ${STASH_WHY}`);
    case 'restore':
      return has('--staged', '-S') && !has('--worktree', '-W') ? null : hard(`\`git restore\` is blocked. ${NEVER_PATH}`);
    case 'checkout': {
      if (has('--')) return hard(`\`git checkout -- <path>\` is blocked. ${NEVER_PATH}`);
      // A new branch keeps the working tree as it is.
      if (has('-b', '-B', '--orphan') && !has('-f', '--force')) return null;
      if (plain.length > 1) return hard(`\`git checkout <ref> <path>\` is blocked. ${NEVER_PATH}`);
      if (plain.length === 0) {
        if (has('-')) move = 'git checkout -';
        break;
      }
      if (!dir) return null;
      const target = plain[0];
      // git takes a commit's name as a switch, and a file or glob as a path; any other name (a remote
      // branch to set up, a typo) it sorts out itself. Exit 1 is "not a commit"; other codes can't tell.
      const isRef = git(dir, 'rev-parse', '--verify', '--quiet', `${target.text}^{commit}`)?.status !== 1;
      if (!target.unknown && !isRef && (/[*?[]/.test(target.text) || existsSync(resolve(dir, target.text)))) return hard(`\`git checkout ${target.text}\` names a path, not a branch or commit. ${NEVER_PATH}`);
      move = `git checkout ${target.text}`;
      break;
    }
    case 'switch':
      if (!has('-c', '-C', '--create', '--force-create')) move = 'git switch';
      break;
    case 'merge':
      if (!has('--abort', '--continue', '--quit')) move = 'git merge';
      break;
    case 'reset':
      if (has('--hard', '--merge', '--keep')) move = `git reset ${words.find((a) => /^--(hard|merge|keep)$/.test(a))}`;
      break;
    case 'rebase': case 'pull': case 'cherry-pick':
      if (!has('--abort', '--continue', '--quit', '--skip')) move = `git ${sub}`;
      break;
    case 'push':
      return dir && inWorktree(dir, cfg) ? pushReason(args, dir) : null;
  }
  if (!move || !dir || committed) return null;
  const st = git(dir, 'status', '--porcelain', '--untracked-files=no');
  const dirty = st?.status === 0 ? st.out.split('\n').map((l) => l.slice(3)).filter(Boolean) : [];
  if (!dirty.length) return null;
  return hard(`Commit first: \`${move}\` with ${dirty.length} uncommitted tracked file(s) (${dirty.slice(0, 5).join(', ')}${dirty.length > 5 ? ', …' : ''}) can lose them. Commit (a WIP commit is fine) before any checkout, merge, rebase or reset; to see another version of a file, use \`git show <ref>:path\`.`);
}

/** Why a `git push` from a minion's worktree is blocked: it reaches main, or forces without a lease. */
function pushReason(args: Word[], dir: string): Verdict | null {
  const pos: Word[] = [];
  let repo = false;
  let tags = false;
  for (let k = 0; k < args.length; k++) {
    const t = args[k].text;
    if (t === '--') {
      pos.push(...args.slice(k + 1));
      break;
    }
    if (/^--(all|mirror|branches)$/.test(t)) return hard(`\`git push ${t}\` pushes main too. ${MAIN_WHY}`);
    if (t === '--force' || (/^-[A-Za-z0-9]+$/.test(t) && t.includes('f'))) return hard('Plain force pushes are blocked: use `--force-with-lease`, and only on your own branch.');
    if (t === '--tags') tags = true;
    else if (t === '--repo') (repo = true), k++;
    else if (t.startsWith('--repo=')) repo = true;
    else if (/^(-o|--push-option|--receive-pack|--exec)$/.test(t) || /^-[A-Za-z0-9]*o$/.test(t)) k++;
    else if (!t.startsWith('-')) pos.push(args[k]);
  }
  const refspecs = repo ? pos : pos.slice(1);
  let branch: string | undefined;
  const current = () => (branch ??= git(dir, 'symbolic-ref', '--short', '-q', 'HEAD')?.out.trim() ?? '');
  // With no refspec git pushes the current branch (--tags alone pushes only tags).
  if (!refspecs.length && !tags && PROTECTED.test(current())) return hard(`This push names no branch, and the current branch is ${current()}. ${MAIN_WHY}`);
  for (const w of refspecs) {
    if (w.unknown) continue;
    const r = w.text;
    if (r.startsWith('+')) return hard(`\`${r}\` is a force push: use \`--force-with-lease\`, and only on your own branch.`);
    if (r === ':') return hard(`\`git push <remote> :\` pushes every matching branch, main included. ${MAIN_WHY}`);
    const colon = r.indexOf(':');
    let dst = colon < 0 ? r : r.slice(colon + 1) || r.slice(0, colon);
    if (dst === 'HEAD' || dst === '@') dst = current();
    dst = dst.replace(/^refs\/heads\//, '');
    if (PROTECTED.test(dst)) return hard(`Pushing to ${dst} is blocked. ${MAIN_WHY}`);
    if (dst.includes('*')) return hard(`The wildcard refspec \`${r}\` could push main. Push your minion branch by name.`);
  }
  return null;
}

function segmentReason(seg: Segment, st: State, cfg: TripwireConfig): Verdict | null {
  for (const r of seg.redirects) {
    if (r.op === '<<<') continue;
    if (r.target.unknown && ENVIRON_HIDDEN.test(r.target.text)) return hard(`The redirect from ${r.target.text} is blocked. ${ENVIRON_WHY}`);
    for (const p of pathsOf(r.target, st, cfg)) {
      const read = readReason(p, cfg);
      if (read) return hard(`The redirect to ${p} is blocked. ${read}`);
      const why = r.op === '<' ? null : writeReason(p, cfg);
      if (why) return { reason: `The redirect to ${p} is blocked. ${why}`, ask: askable(p, '', cfg) };
    }
  }
  const words = seg.words;
  const assigned = new Set<string>();
  let i = 0;
  // `env $VARS PORT=1 cmd`: an unknown word after env is most likely more assignments.
  const takeAssignments = (orUnknown = false) => {
    while (i < words.length && (/^[A-Za-z_]\w*=/.test(words[i].text) || (orUnknown && words[i].unknown))) assigned.add(words[i++].text.split('=')[0]);
  };
  takeAssignments();
  if (i === words.length) {
    for (const v of assigned) st.vars.add(v);
    return null;
  }
  // Step over keywords and wrappers (env VAR=x, timeout 5m, nice -n 5, …) to the real command.
  for (;;) {
    const name = basename(words[i]?.text ?? '');
    if (KEYWORDS.has(name)) i++;
    else if (WRAPPERS.has(name)) {
      i++;
      while (i < words.length && words[i].text.startsWith('-')) {
        const opt = words[i++].text;
        if (/^-(u|C|n|I|P|d|L|s|E|k)$|^--(unset|chdir|adjustment|signal|kill-after)$/.test(opt)) i++;
      }
      takeAssignments(name === 'env');
      if (name === 'env' && i >= words.length) return hard(`\`env\` with no command prints the whole environment. ${ENV_WHY}`);
      if (/^(timeout|nice|ionice|chrt)$/.test(name) && /^[\d.]+[smhd]?$/.test(words[i]?.text ?? '')) i++;
    } else break;
    if (i >= words.length) return null;
  }
  const cmd = words[i];
  const name = basename(cmd.text);
  const args = words.slice(i + 1);
  const vars = new Set([...st.vars, ...assigned]);

  if (name === 'export' || name === 'declare' || name === 'local' || name === 'readonly' || name === 'typeset') {
    for (const w of args) if (/^[A-Za-z_]\w*=/.test(w.text)) st.vars.add(w.text.split('=')[0]);
    return null;
  }
  if (name === 'cd' || name === 'pushd') {
    const to = args.find((w) => !w.text.startsWith('-') || w.text === '-');
    if (!to) st.cwd = cfg.home;
    else if (to.unknown || to.text === '-') st.cwd = null;
    else st.cwd = pathsOf(to, st, cfg)[0] ?? null;
    return null;
  }
  if (name === 'popd') {
    st.cwd = null;
    return null;
  }
  if (SHELLS.has(name) || name === 'eval') {
    const k = name === 'eval' ? -1 : args.findIndex((w) => /^-[a-z]*c[a-z]*$/.test(w.text));
    const script = name === 'eval' ? args : k >= 0 && args[k + 1] ? [args[k + 1]] : null;
    if (script) {
      if (script.some((w) => w.unknown)) return null;
      return commandReason(script.map((w) => w.text).join(' '), { cwd: st.cwd, vars }, cfg);
    }
  }
  if (REMOTE.has(name)) return null;
  // `ps e`, `ps aux e`, `ps auxe`: BSD-style e prints each process's environment. A word after -o, -C,
  // -u and the like is that option's value.
  const bsdE = (w: Word, k: number) => /^[a-zA-Z]*e[a-zA-Z]*$/.test(w.text) && !/^-[a-zA-Z]*[oOpCuUgGtq]$|^--\w+$|^[a-zA-Z]*[oOpUt]$/.test(args[k - 1]?.text ?? '');
  if (name === 'ps' && args.some(bsdE)) return hard(`This \`ps\` prints processes' environments. ${ENVIRON_WHY}`);
  const sub = args.filter((w) => !w.text.startsWith('-')).map((w) => w.text);
  if (name === 'printenv') return hard(`\`printenv\` prints the environment. ${ENV_WHY}`);
  // Anywhere among the plain words: an option's value (`--model haiku`) comes before the subcommand.
  const print = args.some((w) => w.text === '-p' || w.text === '--print');
  if (name === 'claude' && (sub.includes('setup-token') || sub.includes('/login') || sub.some((t, k) => t === 'auth' && sub[k + 1] === 'login') || (sub[0] === 'login' && !print))) {
    return hard('Signing Claude in from a turn would make or replace a login token. People sign in themselves, in their own terminal.');
  }
  if (NETWORK.has(name) && args.some((w) => RUNNER_API.test(w.text) || /(citadel|claude)-runner[^/\s]*\.sock/.test(w.text))) return hard("A runner's socket and its endpoints in Citadel's API are for the runner and Citadel; a turn never pairs, connects or sends as one.");
  if (name === 'sqlite3') {
    const why = sqliteReason(args, st, cfg);
    if (why) return hard(why);
  }
  if (name === 'gh' && sub[0] === 'auth' && (sub[1] === 'token' || (sub[1] === 'status' && args.some((w) => /^(-t|--show-token)$/.test(w.text))))) return hard(`\`gh auth\` would print the token. ${GH_TOKEN_WHY}`);

  const recursive = name === 'rg' || name === 'ag' || args.some((w) => /^-[a-zA-Z]*[rR]|^--recursive$|^--dereference-recursive$|^--directories=recurse$/.test(w.text));
  if (SEARCHERS.has(name) && recursive) {
    const roots = searchRoots(args);
    for (const p of roots.length ? roots.flatMap((w) => pathsOf(w, st, cfg)) : st.cwd ? [st.cwd] : []) {
      const secret = secretInside(p, cfg);
      if (secret) return hard(`Searching ${p} would read ${secret}. Search a folder that doesn't hold secrets.`);
    }
  }
  for (const w of METADATA.has(name) ? [] : args) {
    if (w.unknown && ENVIRON_HIDDEN.test(w.text)) return hard(`Reading ${w.text.replace('//', '/<pid>/')} is blocked. ${ENVIRON_WHY}`);
    for (const p of pathsOf(w, st, cfg)) {
      const why = readReason(p, cfg);
      if (why) return hard(`Reading ${p} is blocked. ${why}`);
    }
  }

  // --now restarts even when that cuts off running turns (ones not in a unit of their own): a person's call.
  const deployCall = words.findIndex((w, k) => k >= i && /(^|\/)tools\/deploy\.sh$/.test(w.text));
  if (deployCall >= 0 && words.slice(deployCall + 1).some((w) => w.text === '--now')) {
    return { reason: '`tools/deploy.sh --now` restarts the server even if that cuts off running turns. Run plain tools/deploy.sh unless a person has said to force it.', ask: true };
  }
  // The deploy script is the sanctioned way to touch the live checkout and restart the service.
  const deploy = join(cfg.checkout, 'tools/deploy.sh');
  if (words.slice(i).some((w) => pathsOf(w, st, cfg).includes(deploy))) return null;

  const sysctl = words.findIndex((w, k) => k >= i && basename(w.text) === 'systemctl');
  if (sysctl >= 0) {
    const plain = words.slice(sysctl + 1).filter((w) => !w.text.startsWith('-')).map((w) => w.text);
    const [verb, ...units] = plain;
    if (STOP_VERBS.has(verb) && units.some((u) => APP_UNITS.test(u))) {
      return hard(`systemctl ${verb} of ${units.join(' ')} is blocked: it cuts off every running turn (or the shared Godot editor). Deploy with ${hasDeployScript(cfg) ? 'tools/deploy.sh, which restarts without stopping running turns' : 'the cc-restart-when-idle unit'}, or ask a person.`);
    }
    // `systemctl edit` opens an editor, which would hang a headless turn.
    if (UNIT_FILE_VERBS.has(verb)) return { reason: `systemctl ${verb} changes the box's unit files. Put units in the repo (deploy/) and ask Cara to install them.`, ask: verb !== 'edit' };
    if (sysctl === i) return null;
  }

  const runner = words.findIndex((w, k) => k >= i && /^(node|tsx|bun|deno|ts-node)$/.test(basename(w.text)));
  const npmStart = /^(npm|pnpm|yarn)$/.test(name) && (args[0]?.text === 'start' || (args[0]?.text === 'run' && args[1]?.text === 'start'));
  const runsServer =
    (runner >= 0 && !words.slice(runner + 1).some((w) => w.text === '--check' || w.text === '-c') && words.slice(runner + 1).some((w) => basename(w.text) === 'server.ts' || /\b(import|require)\s*\(\s*['"`][^'"`]*server\.ts['"`]/.test(w.text))) ||
    (npmStart && !!st.cwd && existsSync(join(st.cwd, 'package.json')) && readFileSync(join(st.cwd, 'package.json'), 'utf8').includes('server.ts'));
  if (runsServer && !(vars.has('DATA_DIR') && vars.has('PORT'))) {
    return hard('Running server.ts without both DATA_DIR and PORT set points it at the live database and port (its schema changes would run on live data). Use `DATA_DIR=$(mktemp -d) PORT=<free port> node server.ts` (copy the DB in if you need data), or `node --check server.ts` for a syntax check.');
  }

  if (name === 'git') return gitReason(args, st, cfg);
  for (const w of writeTargets(name, args)) {
    for (const p of pathsOf(w, st, cfg)) {
      const why = writeReason(p, cfg);
      if (why) return { reason: `\`${name}\` would change ${p}. ${why}`, ask: askable(p, name === 'sqlite3' && !sqlShown(args) ? '' : name, cfg) };
      if (REMOVERS.has(name) && containsProtected(p, cfg)) return hard(`\`${name}\` on ${p} would take protected folders with it (the live checkout, data, config or keys). Name the exact path you mean.`);
    }
  }
  return null;
}

/** Why this Bash command is blocked, or null. One hard-blocked part makes the whole command a hard block. */
export function commandReason(command: string, st: State, cfg: TripwireConfig): Verdict | null {
  const stack: (string | null)[] = [];
  // For /proc/$(…)/environ: whether each open ( follows a word ending in /proc/, and whether one just closed.
  const procs: boolean[] = [];
  let prev: Tok | null = null;
  let afterProc = false;
  let seg: Segment = { words: [], redirects: [] };
  let redir: string | null = null;
  let asked: Verdict | null = null;
  const end = () => {
    const why = segmentReason(seg, st, cfg);
    seg = { words: [], redirects: [] };
    return why;
  };
  for (const tok of [...lex(command, cfg.home), { kind: 'op', text: ';' } as Tok]) {
    if (tok.kind === 'word' && afterProc && ENVIRON_REST.test(tok.word.text)) return hard(`Reading /proc/<pid>/environ is blocked. ${ENVIRON_WHY}`);
    afterProc = tok.kind === 'op' && tok.text === ')' && !!procs.pop();
    if (tok.kind === 'op' && tok.text === '(') procs.push(prev?.kind === 'word' && prev.word.text.endsWith('/proc/'));
    prev = tok;
    if (tok.kind === 'word') {
      if (redir) seg.redirects.push({ op: redir, target: tok.word });
      else seg.words.push(tok.word);
      redir = null;
    } else if (tok.kind === 'redir') redir = tok.op;
    else {
      redir = null;
      const why = end();
      if (why && !why.ask) return why;
      asked ??= why;
      // A cd inside ( … ) or $( … ) doesn't outlive it.
      if (tok.text === '(') stack.push(st.cwd);
      if (tok.text === ')' && stack.length) st.cwd = stack.pop()!;
    }
  }
  return asked;
}

/**
 * Why this tool call is stopped, or null. `input` is Claude Code's PreToolUse hook input. Only a Bash
 * call in a turn that can show cards may ask, and only with a description that explains it: the
 * card shows the description as the minion's reason.
 */
export function tripwire(input: any, cfg: TripwireConfig): Verdict | null {
  const tool = String(input?.tool_name ?? '');
  const ti = input?.tool_input ?? {};
  const cwd = typeof input?.cwd === 'string' ? input.cwd : null;
  if (tool === 'Bash') {
    const v = typeof ti.command === 'string' ? commandReason(ti.command, { cwd, vars: new Set() }, cfg) : null;
    if (!v?.ask) return v;
    if (!cfg.ask) return hard(v.reason);
    if (explanation(ti)) return v;
    return hard(`${v.reason} A person can approve this one call on a card, but only with an explanation: if the work really needs it, retry once with a Bash description of at least ${MIN_EXPLANATION} characters that says why (e.g. "Delete the DB copies Cara OK'd in #54").`);
  }
  const file = ti.file_path ?? ti.notebook_path ?? ti.path;
  if (typeof file !== 'string' || !file) return null;
  const st = { cwd, vars: new Set<string>() };
  const [p] = pathsOf({ text: file, unknown: false }, st, cfg);
  if (!p) return null;
  const read = readReason(p, cfg);
  if (read) return hard(`${tool} of ${p} is blocked. ${read}`);
  const secret = tool === 'Grep' ? secretInside(p, cfg) : null;
  if (secret) return hard(`Grep of ${p} would read ${secret}. Search a folder that doesn't hold secrets.`);
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tool)) {
    const why = writeReason(p, cfg);
    if (why) return hard(`${tool} of ${p} is blocked. ${why}`);
  }
  return null;
}

/** The minion's explanation for a Bash call (its description), if it is long enough to count. */
export function explanation(toolInput: any): string | null {
  const d = typeof toolInput?.description === 'string' ? toolInput.description.trim() : '';
  return d.length >= MIN_EXPLANATION ? d : null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // Fails open: a broken config or input lets the call through rather than wedging every turn.
  let v: Verdict | null = null;
  try {
    const cfg = JSON.parse(process.argv[2]) as TripwireConfig;
    v = tripwire(JSON.parse(readFileSync(0, 'utf8')), cfg);
  } catch (err: any) {
    process.stderr.write(`[tripwire] skipped: ${err.message}\n`);
  }
  if (v?.ask) {
    // Claude Code sends this call to the turn's permission-prompt tool, which shows the card.
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: `[tripwire] ${v.reason}` } }));
  } else if (v) {
    process.stderr.write(`[tripwire] ${v.reason}\n[tripwire] This guard stops known accidents in Citadel (src/tripwire.ts). ${ASK}\n`);
    process.exit(2);
  }
}
