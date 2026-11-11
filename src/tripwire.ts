// The tripwire: a PreToolUse hook the runner adds to every turn (tripwireHooks in runner.ts), for
// Taskmasters and minions in every scheme. It stops the known accidents (writes to the live database,
// the live checkout, the service's config and units, other schemes' folders; restarting or stopping
// the app's services; reading SSH keys, the Claude, Codex or GitHub login, the service's env file or any
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
// It is a tripwire, NOT a security boundary. It reads the command text: it follows variables the
// command sets and the turn's environment ($TMPDIR), loop variables, `$(mktemp)`, globs and braces
// in folder names and symlinked folders, and a destructive write (rm, mv, cp onto, >, truncate,
// find -delete, sqlite3 SQL that writes) whose path it still can't pin down is blocked if it could
// land in the live data dir (#251: `D=<data dir>; rm -f $D/state.db` got through). Reads and other
// writes it can't pin down go through. A script file or an interpreter (`python -c`, `node -e`)
// still hides what it does.
//
// Run as a hook: node tripwire.ts '<config json>' < hook input; exits 2 with the reason on stderr, or
// prints a PreToolUse "ask" decision for the approval card.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
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
  /** The turn's environment, for paths like "$TMPDIR/x"; the hook's own (the turn's) when left out. */
  env?: Record<string, string | undefined>;
  /** The turn's own folder (its pinned tripwire and hook config), read-only to the turn; Codex turns set it (#337). */
  turnDir?: string;
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
  if (cfg.turnDir && under(p, cfg.turnDir)) return `${cfg.turnDir} is this turn's own folder: its pinned tripwire and the config its hooks read. Nothing in a turn changes it.`;
  if (under(p, cfg.checkout)) return `${cfg.checkout} is the live checkout the service runs from. Change code in your own worktree and merge to main. ${deployNote(cfg)}`;
  const projects = join(cfg.data, 'projects');
  if (under(p, projects) && p !== projects) {
    const id = p.slice(projects.length + 1).split('/')[0];
    if (id === String(cfg.project)) return null;
    if (/^\d+$/.test(id)) return `${join(projects, id)} belongs to another scheme (${id}; yours is ${cfg.project}). Read it if you need to, but leave changes there to that scheme's minions: ask your Taskmaster to pass it on.`;
  }
  if (under(p, cfg.data)) return `${cfg.data} is the live data dir: the database, its backups and every scheme's folders. ${SCRATCH} Change data through the app, or ask a person.`;
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
  if (p === join(cfg.home, CODEX_LOGIN)) return "That file is this person's Codex login (ChatGPT); codex uses it on its own, and nothing here needs to read it.";
  if (under(p, join(cfg.home, '.config/claude-coordinator'))) return `${join(cfg.home, '.config/claude-coordinator')} holds the live service's password and session secret, which let anyone act as a person. To try the API, log in to a dev copy or a preview with its own password; ask Cara to change the env file.`;
  if (ENVIRON.test(p)) return ENVIRON_WHY;
  if (p === join(cfg.home, '.config/gh/hosts.yml')) return GH_TOKEN_WHY;
  return runnerReason(p, cfg);
}

/** Why a read or write of this path is blocked as another person's (their home, their runner's sign-in), or null. */
function runnerReason(p: string, cfg: TripwireConfig): string | null {
  const homes = dirname(cfg.home);
  if (homes !== '/' && under(p, homes) && p !== homes && !under(p, cfg.home)) return `${p} is in another person's home folder, where their Claude runner and sign-in live. Leave it to them.`;
  // Each person's Claude container keeps its sign-in in a podman volume (#213): podman's storage holds every one of them.
  if (under(p, join(cfg.home, CONTAINER_STORAGE)) || PODMAN_RUNTIME.test(p)) return `${p} is podman's storage or socket, which holds every person's Claude container and sign-in. Use the podman command for your own containers; Citadel runs the Claude ones.`;
  if (p.split('/').includes('citadel-claude') || RUNNER_SOCKET.test(basename(p))) return `${p} belongs to a Claude runner: its sign-in or its socket. Turns never touch a runner directly; Citadel talks to it.`;
  return null;
}
const CODEX_LOGIN = '.codex/auth.json';
const RUNNER_SOCKET = /^(citadel|claude)-runner.*\.sock$/;
const CONTAINER_STORAGE = '.local/share/containers/storage';
// The rootless podman socket and registry logins, in $XDG_RUNTIME_DIR.
const PODMAN_RUNTIME = /^\/run\/user\/\d+\/(podman|containers)(\/|$)/;
// Podman subcommands that take or remove every container or volume at once, people's Claude ones included.
const PODMAN_ALL = /^(stop|rm|kill|pause|restart)$/;
const CLAUDE_CONTAINERS_WHY = "Each person's Claude container (citadel-claude-*) holds their sign-in and runs their turns; only Citadel's server drives them. Use podman for your own containers by name.";
// A runner's endpoints in Citadel's API (pairing, connecting): only the runner itself calls them.
const RUNNER_API = /\/api\/(claude-)?runners?\b/;
const NETWORK = new Set(['curl', 'wget', 'http', 'https', 'xh', 'websocat', 'socat', 'nc', 'ncat']);

// A process's environment holds whatever secrets it started with (the service's password and session secret).
const ENVIRON = /^\/proc\/[^/]+(\/task\/[^/]+)?\/environ$/;
const ULTRAREVIEW_WHY = "An ultra review is billed to a person's Claude account (a free run, then about $5-25 in usage credits), so only a person starts one: the Ultra review button at the top of a chat. Ask them to run it.";
/** `claude ultrareview`, or a `/ultrareview` or `/code-review ultra` prompt handed to claude. */
const ULTRAREVIEW_ARG = /^ultrareview$|(^|\s)\/(ultrareview|code-review\s+ultra)\b/;
const ENVIRON_WHY = "A process's environment can hold the live service's password and session secret. To find your dev server, take the pid from `ss -ltnp 'sport = :<your port>'` (or `$!` when you start it) and check `readlink /proc/<pid>/cwd`.";
const GH_TOKEN_WHY = "That is Cara's GitHub login; gh and git use it on their own.";
// Each turn gets its person's GitHub token, or none (#182); these would reach another account's login.
const GH_VARS = /^(GH_TOKEN|GITHUB_TOKEN|GH_CONFIG_DIR|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|GH_HOST)$/;
const GH_ENV_WHY = "Each turn's GitHub login is set for the person it runs for (GH_TOKEN, with an empty GH_CONFIG_DIR so no other login is in reach), so pushes and pull requests go out under their name. Leave it as it is: if this turn's person hasn't linked GitHub, commit on your branch and tell them they can link it in Settings → Your account.";
// The same read with the pid in a variable or a $(…), where the lexer leaves an unknown `/proc//environ`.
const ENVIRON_HIDDEN = /^\/proc\/[^/]*(\/task\/[^/]*)?\/environ$/;

/** For a recursive search: a secret readReason guards that lies inside this folder, or null. */
function secretInside(root: string, cfg: TripwireConfig): string | null {
  const secrets = [join(cfg.home, '.ssh'), join(cfg.claudeConfig, '.credentials.json'), join(cfg.home, '.claude/.credentials.json'), join(cfg.home, CODEX_LOGIN), join(cfg.home, '.config/claude-coordinator'), join(cfg.home, '.config/gh/hosts.yml'), join(cfg.home, '.config/citadel-claude'), join(cfg.home, CONTAINER_STORAGE)];
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
  const glob = globRe(base);
  return !LIVE_DB.some((f) => glob.test(f));
}

/** For rm and mv: deleting or moving a folder that contains a protected one. */
function containsProtected(p: string, cfg: TripwireConfig): boolean {
  return protectedRoots(cfg).some((r) => r !== p && under(r, p));
}

// ---------- reading shell commands ----------

/**
 * A word of the command. `unknown` when it holds an expansion the lexer can't see through; then `tmpl`
 * is its text with each expansion marked: \0NAME\0 for a variable, \0\0 for anything else ($(…),
 * $1, ${x%/*}), so a variable the command sets, or the turn's environment, can fill it in later.
 */
interface Word { text: string; unknown: boolean; tmpl?: string }
type Tok = { kind: 'word'; word: Word } | { kind: 'op'; text: string } | { kind: 'redir'; op: string };

/**
 * Splits a bash command into words, redirects and operators (; && || | & newline ( ) $( ). A command
 * substitution's inner command comes out between `$(` and `)`, and the word it sits in comes after,
 * marked unknown. Expands ~, $HOME and ${HOME}; other expansions are marked (see Word). Heredoc bodies
 * are skipped, so a commit message can mention any path.
 */
export function lex(s: string, home: string): Tok[] {
  const toks: Tok[] = [];
  const heredocs: { delim: string; strip: boolean; body: Word }[] = [];
  let text = '';
  let tmpl = '';
  let unknown = false;
  let inWord = false;
  let quotedStart = false;
  // Inside "…": a $( … ) or `…` in it is lexed as a command all the same (#468 S01-1), and the quotes pick up after it.
  let dq = false;
  const put = (x: string) => {
    text += x;
    tmpl += x;
  };
  const flush = () => {
    if (inWord) toks.push({ kind: 'word', word: unknown ? { text, unknown, tmpl } : { text, unknown } });
    text = '';
    tmpl = '';
    unknown = false;
    inWord = false;
    quotedStart = false;
  };
  // Open parens: null for a plain ( … ), or the word a $( … ) or `…` sits in, to pick up again after it.
  type Saved = { text: string; tmpl: string; unknown: boolean; quotedStart: boolean; backtick: boolean; start: number; dq: boolean };
  const parens: (Saved | null)[] = [];
  const open = (backtick: boolean, start: number) => {
    parens.push({ text, tmpl, unknown, quotedStart, backtick, start, dq });
    text = tmpl = '';
    unknown = inWord = quotedStart = dq = false;
    toks.push({ kind: 'op', text: '$(' });
  };
  const close = (end: number) => {
    flush();
    toks.push({ kind: 'op', text: ')' });
    const w = parens.pop();
    if (!w) return;
    ({ text, tmpl, quotedStart, dq } = w);
    tmpl += mktempPath(s.slice(w.start, end), home) ?? '\0\0';
    unknown = inWord = true;
  };
  const n = s.length;
  // Reads a $ expansion at s[i] ('$', not '$('); returns the next index.
  const dollar = (i: number): number => {
    const c = s[i + 1];
    let name = '';
    let j = i + 1;
    if (c === '{') {
      const end = s.indexOf('}', j);
      if (end < 0) return n;
      // ${NAME:?…}, ${NAME:-…} and the like are NAME when it's set; other forms can't be followed.
      const m = /^([A-Za-z_]\w*)(:?[-=?].*)?$/.exec(s.slice(j + 1, end));
      name = m ? m[1] : '';
      j = end + 1;
    } else {
      const m = /^([A-Za-z_]\w*|[0-9@*#?$!-])/.exec(s.slice(j));
      if (!m) {
        put('$');
        inWord = true;
        return i + 1;
      }
      name = /^[A-Za-z_]/.test(m[1]) ? m[1] : '';
      j += m[1].length;
    }
    if (name === 'HOME') put(home);
    else {
      unknown = true;
      tmpl += `\0${name}\0`;
    }
    inWord = true;
    return j;
  };
  let i = 0;
  while (i < n) {
    const c = s[i];
    if (dq) {
      // $( … ) and `…` open a command here as they do outside quotes. A heredoc in one (the usual
      // `git commit -m "$(cat <<'EOF' … EOF\n)"`) is skipped at its line's end, so its message may hold quotes and parens.
      if (c === '"') dq = false;
      else if (c === '\\' && i + 1 < n && '"\\$`\n'.includes(s[i + 1])) {
        if (s[i + 1] !== '\n') put(s[i + 1]);
        i++;
      } else if (c === '$' && s[i + 1] === '(') {
        open(false, i + 2);
        i++;
      } else if (c === '`') open(true, i + 1);
      else if (c === '$') {
        i = dollar(i);
        continue;
      } else put(c);
      i++;
      continue;
    }
    if (c === "'") {
      const end = s.indexOf("'", i + 1);
      put(s.slice(i + 1, end < 0 ? n : end));
      if (!inWord) quotedStart = true;
      inWord = true;
      i = end < 0 ? n : end + 1;
      continue;
    }
    if (c === '$' && s[i + 1] === "'") {
      // ANSI-C quoting: rare enough to take literally.
      const end = s.indexOf("'", i + 2);
      put(s.slice(i + 2, end < 0 ? n : end));
      inWord = true;
      i = end < 0 ? n : end + 1;
      continue;
    }
    if (c === '"') {
      if (!inWord) quotedStart = true;
      inWord = true;
      dq = true;
      i++;
      continue;
    }
    if (c === '\\') {
      if (s[i + 1] !== '\n' && i + 1 < n) {
        put(s[i + 1]);
        inWord = true;
      }
      i += 2;
      continue;
    }
    if (c === '$') {
      if (s[i + 1] === '(') {
        open(false, i + 2);
        i += 2;
        continue;
      }
      i = dollar(i);
      continue;
    }
    if (c === '`') {
      if (parens.at(-1)?.backtick) close(i);
      else open(true, i + 1);
      i++;
      continue;
    }
    if (c === '~' && !inWord && (i + 1 >= n || /[\/\s;&|)]/.test(s[i + 1]))) {
      put(home);
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
      // Step over the bodies of heredocs started on the line that just ended, into their << word.
      for (const h of heredocs.splice(0)) {
        const lines: string[] = [];
        while (i < n) {
          const eol = s.indexOf('\n', i);
          const line = s.slice(i, eol < 0 ? n : eol);
          i = eol < 0 ? n : eol + 1;
          if ((h.strip ? line.replace(/^\t+/, '') : line) === h.delim) break;
          lines.push(line);
        }
        h.body.text = lines.join('\n');
      }
      continue;
    }
    if (c === '<' || c === '>' || (c === '&' && s[i + 1] === '>')) {
      // A bare number right before is the file descriptor, not a word.
      if (inWord && !quotedStart && !unknown && /^\d+$/.test(text)) {
        text = tmpl = '';
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
          // The body is filled in at the end of the line; only a shell reading it as its script looks at it.
          const body: Word = { text: '', unknown: false };
          // `<<\EOF` (or E\OF) quotes the delimiter like `<<'EOF'`: the end line is EOF.
          heredocs.push({ delim: m[2].replace(/\\/g, ''), strip: op === '<<-', body });
          toks.push({ kind: 'redir', op: '<<' }, { kind: 'word', word: body });
          i += m[0].length;
        }
        continue;
      }
      toks.push({ kind: 'redir', op });
      continue;
    }
    if (c === ')') {
      close(i);
      i++;
      continue;
    }
    if (c === ';' || c === '&' || c === '|' || c === '(') {
      flush();
      const two = s.slice(i, i + 2);
      const op = ['&&', '||', '|&', ';;'].includes(two) ? two : c;
      if (op === '(') parens.push(null);
      toks.push({ kind: 'op', text: op });
      i += op.length;
      continue;
    }
    put(c);
    inWord = true;
    i++;
  }
  flush();
  return toks;
}

const MKTEMP_DIR = '__mktemp_dir';

/**
 * What `$(pwd)` or `$(mktemp …)` prints, as a word template: for mktemp, the folder it makes the file
 * in (its -p or --tmpdir, the template's own folder, or $TMPDIR) and the template. Null for any other command.
 */
function mktempPath(src: string, home: string): string | null {
  if (src.trim() === 'pwd') return '\0PWD\0';
  if (!/^\s*mktemp\b/.test(src)) return null;
  const toks = lex(src, home);
  if (toks.some((t) => t.kind !== 'word')) return null;
  const words = toks.map((t) => (t as { word: Word }).word);
  if (words[0]?.text !== 'mktemp') return null;
  const tm = (w: Word) => w.tmpl ?? w.text;
  let dir: string | null = null;
  let template = 'tmp.XXXXXXXXXX';
  let inTmp = false;
  for (let k = 1; k < words.length; k++) {
    const x = words[k].text;
    if (x === '-p') (dir = words[k + 1] ? tm(words[k + 1]) : null), k++;
    else if (x.startsWith('--tmpdir=')) dir = tm(words[k]).slice(9);
    else if (/^--?[a-zA-Z]/.test(x)) inTmp ||= /^-[a-zA-Z]*t/.test(x) || x === '--tmpdir';
    else template = tm(words[k]);
  }
  if (dir === null && !inTmp && words.slice(1).some((w) => !w.text.startsWith('-'))) return template;
  return `${dir || `\0${MKTEMP_DIR}\0`}/${template}`;
}

interface Segment { words: Word[]; redirects: { op: string; target: Word }[] }
/** What the command has done so far: its folder, and the variables it set, with the values they can take where known (a loop variable takes several). */
interface State { cwd: string | null; vars: Set<string>; values: Map<string, string[]>; committed?: boolean }

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
const APP_UNITS = /^(claude-coordinator|perigee-godot[\w-]*|citadel-claude[\w-]*)(\.service)?$/;
const STOP_VERBS = new Set(['restart', 'stop', 'kill', 'try-restart', 'reload-or-restart', 'try-reload-or-restart', 'condrestart', 'force-reload', 'freeze']);
const UNIT_FILE_VERBS = new Set(['enable', 'disable', 'reenable', 'mask', 'unmask', 'link', 'edit', 'revert', 'preset', 'add-wants', 'add-requires', 'set-property']);
const GIT_READ = new Set(`status log diff show blame rev-parse rev-list ls-files ls-tree ls-remote cat-file describe shortlog grep fetch help version
whatchanged show-ref for-each-ref merge-base name-rev count-objects check-ignore var cherry range-diff format-patch archive merge-tree`.split(/\s+/));

// The turn's variables never fill in a path when their names suggest a secret.
const SECRET_VAR = /TOKEN|SECRET|PASSW|KEY|COOKIE|CREDENTIAL/i;

/** A variable's values: set earlier in the command, else (unless the command set it to something unknown) the turn's environment. */
function valueOf(name: string, st: State, cfg: TripwireConfig): string[] | undefined {
  if (st.values.has(name)) return st.values.get(name);
  if (st.vars.has(name)) return undefined;
  const env = cfg.env ?? process.env;
  if (name === 'PWD') return st.cwd ? [st.cwd] : undefined;
  // Where a bare mktemp puts its file (see mktempPath).
  if (name === MKTEMP_DIR) return [env.TMPDIR || '/tmp'];
  const v = SECRET_VAR.test(name) ? undefined : env[name];
  return v === undefined ? undefined : [v];
}

/** The word with the variables it can fill in filled in, once per value they take; a word that stays unknown keeps the rest marked. */
function expand(w: Word, st: State, cfg: TripwireConfig): Word[] {
  if (!w.unknown || w.tmpl === undefined) return [w];
  let alts = [''];
  for (const part of w.tmpl.split(/(\0[A-Za-z_]\w*\0)/)) {
    const known = part.length > 2 && part.startsWith('\0') ? valueOf(part.slice(1, -1), st, cfg) : undefined;
    const vals = known ? known.map((v) => v.replace(/\0/g, '')) : [part];
    alts = alts.flatMap((x) => vals.map((v) => x + v)).slice(0, 64);
  }
  return alts.map((t) => (t.includes('\0') ? { text: w.text, unknown: true, tmpl: t } : { text: t, unknown: false }));
}

/** An unknown word as the command wrote it, for a reason: `$D/state.db`. */
const shown = (w: Word) => (w.tmpl ?? w.text).replace(/\0([A-Za-z_]\w*)\0/g, '$$$1').replace(/\0\0/g, '$(…)');

/** Paths a word may name: the word itself, an option's or dd operand's value after `=`, brace and glob expansions, and where symlinks lead. */
function pathsOf(word: Word, st: State, cfg: TripwireConfig): string[] {
  const out: string[] = [];
  for (const w of expand(word, st, cfg)) if (!w.unknown && w.text) out.push(...literalPaths(w.text, st, cfg));
  return [...new Set(out)];
}

function literalPaths(text: string, st: State, cfg: TripwireConfig): string[] {
  const eq = text.indexOf('=');
  const candidates = text.startsWith('-') ? (eq > 0 ? [text.slice(eq + 1)] : []) : eq > 0 ? [text, text.slice(eq + 1)] : [text];
  const out: string[] = [];
  for (let c of candidates.flatMap(braces)) {
    if (c.startsWith('~/') || c === '~') c = cfg.home + c.slice(1);
    // URLs, host:path and the like.
    if (/^[A-Za-z][\w+.@-]*:/.test(c)) continue;
    const p = isAbsolute(c) ? resolve(c) : st.cwd && c ? resolve(st.cwd, c) : null;
    if (p) out.push(p, ...globHits(p, cfg), ...realPath(p));
  }
  return out;
}

/** Bash's brace expansion of a word (`a{b,c}` is ab and ac), capped; braces past the cap stay as they are. */
function braces(s: string): string[] {
  let out = [s];
  for (let round = 0; round < 8; round++) {
    let more = false;
    out = out
      .flatMap((x) => {
        const m = /\{([^{}]*,[^{}]*)\}/.exec(x);
        if (!m) return [x];
        more = true;
        return m[1].split(',').map((alt) => x.slice(0, m.index) + alt + x.slice(m.index + m[0].length));
      })
      .slice(0, 32);
    if (!more) break;
  }
  return out;
}

/** A glob for one path component, as a regex; a [class] it can't read matches any one character. */
function globRe(part: string): RegExp {
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = part.split(/(\*|\?|\[[^\]]*\])/).map((x, k) => (k % 2 === 0 ? esc(x) : x === '*' ? '.*' : x === '?' ? '.' : `[${x.slice(1, -1).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`));
  try {
    return new RegExp(`^${re.join('')}$`);
  } catch {
    return new RegExp(`^${re.map((x, k) => (k % 2 && x.startsWith('[') ? '.' : x)).join('')}$`);
  }
}

/** The folders whose writes are blocked, or that rm and mv mustn't take with them. */
function protectedRoots(cfg: TripwireConfig): string[] {
  const configDir = join(cfg.home, '.config');
  return [cfg.checkout, cfg.data, join(configDir, 'claude-coordinator'), join(configDir, 'systemd/user'), join(configDir, 'containers/systemd'), join(cfg.home, '.ssh')];
}

/** For a path with a glob in it: the protected folders, or paths in them, it could match (`~/.local/*\/claude-coordinator/state.db`). */
function globHits(p: string, cfg: TripwireConfig): string[] {
  const parts = p.split('/');
  if (!parts.some((x) => /[*?[]/.test(x))) return [];
  const out: string[] = [];
  for (const root of protectedRoots(cfg)) {
    const r = root.split('/');
    if (parts.slice(0, r.length).every((x, j) => globRe(x).test(r[j]))) out.push([...r.slice(0, parts.length), ...parts.slice(r.length)].join('/'));
  }
  return out;
}

/** Where a path really is, when a folder on the way is a symlink. */
function realPath(p: string): string[] {
  let head = p;
  let tail = '';
  while (head !== '/' && !existsSync(head)) {
    tail = `/${basename(head)}${tail}`;
    head = dirname(head);
  }
  try {
    const real = join(realpathSync(head), tail);
    return real === p ? [] : [real];
  } catch {
    return [];
  }
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
    case 'find': {
      if (!a.includes('-delete') && !a.some((t, i) => /^-(exec|execdir|ok|okdir)$/.test(t) && REMOVERS.has(basename(a[i + 1] ?? '')))) return [];
      // The folders it starts from: the words before its first option or expression.
      const k = a.findIndex((t) => /^[-(!]/.test(t));
      const roots = args.slice(0, k < 0 ? args.length : k);
      return roots.length ? roots : [{ text: '.', unknown: false }];
    }
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

const SCRATCH = 'Read the live database with `sqlite3 -readonly`; for a copy to work on, copy it in one step to a new file in your TMPDIR (it does not overwrite one): `sqlite3 -readonly <db> "VACUUM INTO \'$TMPDIR/copy.db\'"` (a `.backup` restarts on every live write and can run for minutes).';

/** A NAME=value word: the name, and the values it can take when they can be known. */
function assignment(w: Word, st: State, cfg: TripwireConfig): [string, string[] | undefined] {
  const eq = w.text.indexOf('=');
  if (eq < 0) return [w.text, undefined];
  return [w.text.slice(0, eq), known(expand({ text: w.text.slice(eq + 1), unknown: w.unknown, tmpl: w.tmpl?.slice(eq + 1) }, st, cfg), cfg)];
}

/** The words' texts, when none is unknown; a ~ after the = of an assignment expands too. */
function known(ws: Word[], cfg: TripwireConfig): string[] | undefined {
  if (ws.some((w) => w.unknown)) return undefined;
  return ws.map((w) => (/^~(\/|$)/.test(w.text) ? cfg.home + w.text.slice(1) : w.text));
}

function setVar(st: State, name: string, values: string[] | undefined) {
  st.vars.add(name);
  // A value built up past any real path (A=$A$A …) counts as unknown.
  if (values === undefined || values.join('').length > 10_000) st.values.delete(name);
  else st.values.set(name, values);
}

/**
 * For a destructive write whose path can't be pinned down (a variable that isn't set in the command
 * or the turn's environment, a $(…), a relative path after a cd the tripwire lost track of): a block
 * when it could land in the live data dir, or null. The reason starts with the path as written.
 */
function blindWriteReason(word: Word, st: State, cfg: TripwireConfig, name: string): Verdict | null {
  for (const w of expand(word, st, cfg)) {
    const why = blindReason(w, st, cfg, name);
    if (why) return why;
  }
  return null;
}
function blindReason(w: Word, st: State, cfg: TripwireConfig, name: string): Verdict | null {
  if (w.text.startsWith('-') || /^[A-Za-z_]\w*=/.test(w.text)) return null;
  if (!w.unknown) {
    if (st.cwd || !w.text || isAbsolute(w.text) || w.text.startsWith('~')) return null;
    // Relative to a folder it lost track of: that folder may be the data dir itself, or a folder in it.
    const p = resolve(cfg.data, w.text);
    if (!w.text.split('/').includes('..') && !under(cfg.data, p) && (dirname(p) !== cfg.data || askable(p, name === 'sqlite3' ? '' : name, cfg))) return null;
    return hard(`${w.text} in a folder the tripwire lost track of (a cd to a variable or a $(…)): run from ${cfg.data}, the live data dir, it would hit the database. Use an absolute path. ${SCRATCH}`);
  }
  const tmpl = w.tmpl!;
  const lit = tmpl.slice(0, tmpl.indexOf('\0'));
  const cut = lit.lastIndexOf('/');
  // `$x/…` could be anywhere; `out-$x` is in the current folder; `/a/b/$x` is in /a/b.
  const dirs = cut >= 0 ? pathsOf({ text: lit.slice(0, cut) || '/', unknown: false }, st, cfg) : lit && st.cwd ? [st.cwd] : [];
  const unknowns = [...new Set([...tmpl.matchAll(/\0([A-Za-z_]\w*)?\0/g)].map((m) => (m[1] ? `$${m[1]}` : '$(…)')))].join(' and ');
  if (!dirs.length || dirs.some((d) => under(cfg.data, d))) {
    return hard(`${shown(w)}: the tripwire can't tell what ${unknowns} holds, so this could reach ${cfg.data}, the live data dir (the database, its backups and every scheme's folders). Spell the path out in the command, or keep scratch files under $TMPDIR. ${SCRATCH}`);
  }
  for (const d of dirs) {
    const p = join(d, '…');
    const why = writeReason(p, cfg);
    if (why) return { reason: `${shown(w)}: ${why}`, ask: askable(p, name, cfg) };
  }
  return null;
}

/** Your scheme's folder, or a folder right in it (its repo, tickets, shared, tmp): rm takes every minion's work with it. */
function schemeFolder(p: string, cfg: TripwireConfig): boolean {
  const own = join(cfg.data, 'projects', String(cfg.project));
  return p === own || (under(p, own) && !p.slice(own.length + 1).includes('/'));
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
      dir = p ? (pathsOf(p, st, cfg)[0] ?? null) : null;
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
    for (const p of pathsOf(w, { ...st, cwd: dir }, cfg)) {
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
    if (r.op === '<<<' || r.op === '<<') continue;
    if (r.target.unknown && ENVIRON_HIDDEN.test(r.target.text)) return hard(`The redirect from ${r.target.text} is blocked. ${ENVIRON_WHY}`);
    // Appending (>>) can't wipe a file; the rest can.
    const blind = /^(<|>>|&>>)$/.test(r.op) ? null : blindWriteReason(r.target, st, cfg, '');
    if (blind) return { ...blind, reason: `The redirect to ${blind.reason}` };
    for (const p of pathsOf(r.target, st, cfg)) {
      const read = readReason(p, cfg);
      if (read) return hard(`The redirect to ${p} is blocked. ${read}`);
      const why = r.op === '<' ? null : writeReason(p, cfg);
      if (why) return { reason: `The redirect to ${p} is blocked. ${why}`, ask: askable(p, '', cfg) };
    }
  }
  const words = seg.words;
  const assigned = new Map<string, string | undefined>();
  let i = 0;
  // `env $VARS PORT=1 cmd`: an unknown word after env is most likely more assignments.
  const takeAssignments = (orUnknown = false) => {
    while (i < words.length && (/^[A-Za-z_]\w*=/.test(words[i].text) || (orUnknown && words[i].unknown))) assigned.set(...assignment(words[i++], st, cfg));
  };
  takeAssignments();
  const ghSet = () => [...assigned.keys()].find((v) => GH_VARS.test(v));
  if (ghSet()) return hard(`Setting ${ghSet()} is blocked. ${GH_ENV_WHY}`);
  if (i === words.length) {
    for (const [name, value] of assigned) setVar(st, name, value);
    return null;
  }
  // Step over keywords and wrappers (env VAR=x, timeout 5m, nice -n 5, …) to the real command.
  let viaXargs = false;
  for (;;) {
    const name = basename(words[i]?.text ?? '');
    if (KEYWORDS.has(name)) i++;
    else if (WRAPPERS.has(name)) {
      if (name === 'xargs') viaXargs = true;
      i++;
      while (i < words.length && words[i].text.startsWith('-')) {
        const opt = words[i++].text;
        if (name === 'env' && (/^(-u|--unset)$/.test(opt) ? GH_VARS.test(words[i]?.text ?? '') : GH_VARS.test(opt.replace(/^(-u|--unset=)/, '')))) return hard(`Unsetting ${opt.replace(/^(-u|--unset=?)/, '') || words[i].text} is blocked. ${GH_ENV_WHY}`);
        if (/^-(u|C|n|I|P|d|L|s|E|k|a)$|^--(unset|chdir|adjustment|signal|kill-after|arg-file)$/.test(opt)) i++;
      }
      takeAssignments(name === 'env');
      if (ghSet()) return hard(`Setting ${ghSet()} is blocked. ${GH_ENV_WHY}`);
      if (name === 'env' && i >= words.length) return hard(`\`env\` with no command prints the whole environment. ${ENV_WHY}`);
      if (/^(timeout|nice|ionice|chrt)$/.test(name) && /^[\d.]+[smhd]?$/.test(words[i]?.text ?? '')) i++;
    } else break;
    if (i >= words.length) return null;
  }
  const cmd = words[i];
  const name = basename(cmd.text);
  const args = words.slice(i + 1);
  const vars = new Set([...st.vars, ...assigned.keys()]);

  if (name === 'claude') {
    // Through known variables too (`a=ultrareview; claude "$a"`); a word it can't know might be the subcommand.
    const words = args.flatMap((w) => expand(w, st, cfg));
    if (words.some((w) => ULTRAREVIEW_ARG.test(w.text))) return hard(`\`claude ultrareview\` is blocked. ${ULTRAREVIEW_WHY}`);
    const blind = words.find((w) => w.unknown);
    if (blind) return hard(`\`claude\` with ${shown(blind)}, a word the tripwire can't read, is blocked: it could launch an ultra review. Write the arguments out. ${ULTRAREVIEW_WHY}`);
  }
  if (/^(export|declare|local|readonly|typeset|unset)$/.test(name)) {
    const gh = args.map((w) => w.text.split('=')[0]).find((v) => GH_VARS.test(v));
    if (gh) return hard(`${name === 'unset' ? 'Unsetting' : 'Setting'} ${gh} is blocked. ${GH_ENV_WHY}`);
  }
  if (name === 'export' || name === 'declare' || name === 'local' || name === 'readonly' || name === 'typeset') {
    for (const w of args) if (/^[A-Za-z_]\w*=/.test(w.text)) setVar(st, ...assignment(w, st, cfg));
    return null;
  }
  // Variables set from what the command reads or loops over: their values can't be known.
  if (name === 'for' || name === 'select') {
    // `for f in a b`: f takes each listed value, when they're all known.
    if (/^[A-Za-z_]\w*$/.test(args[0]?.text ?? '')) setVar(st, args[0].text, args[1]?.text === 'in' ? known(args.slice(2).flatMap((w) => expand(w, st, cfg)), cfg)?.flatMap(braces) : undefined);
  } else if (/^(read|mapfile|readarray|getopts)$/.test(name)) {
    const names = name === 'getopts' ? args.slice(1, 2) : args.filter((w, k) => !w.text.startsWith('-') && !/^-[a-zA-Z]*[pdnNtuaC]$/.test(args[k - 1]?.text ?? ''));
    for (const w of names) if (/^[A-Za-z_]\w*$/.test(w.text)) setVar(st, w.text, undefined);
    if (name === 'read' && !names.length) setVar(st, 'REPLY', undefined);
    return null;
  }
  if (name === 'cd' || name === 'pushd') {
    const to = args.find((w) => !w.text.startsWith('-') || w.text === '-');
    if (!to) st.cwd = cfg.home;
    else if (to.text === '-') st.cwd = null;
    else st.cwd = pathsOf(to, st, cfg)[0] ?? null;
    return null;
  }
  if (name === 'popd') {
    st.cwd = null;
    return null;
  }
  if (SHELLS.has(name) || name === 'eval') {
    const k = name === 'eval' ? -1 : args.findIndex((w) => /^-[a-z]*c[a-z]*$/.test(w.text));
    // A shell with no script file reads its script from stdin: a heredoc or here-string shows it.
    const stdin = seg.redirects.filter((r) => r.op === '<<' || r.op === '<<<').map((r) => r.target);
    const script = name === 'eval' ? args : k >= 0 && args[k + 1] ? [args[k + 1]] : args.every((w) => w.text.startsWith('-')) && stdin.length ? stdin.slice(-1) : null;
    if (script) {
      // What the inner shell gets: the words with the variables we know filled in, the rest left for it to expand.
      const text = (w: Word) => (w.unknown ? w.tmpl!.replace(/\0([A-Za-z_]\w*)\0/g, '${$1}').replace(/\0\0/g, '${__unknown}') : w.text);
      const scripts = script.length === 1 ? expand(script[0], st, cfg).map(text) : [script.map((w) => text(expand(w, st, cfg)[0])).join(' ')];
      for (const inner of scripts) {
        const why = commandReason(inner, { cwd: st.cwd, vars: new Set([...st.vars, '__unknown']), values: st.values }, cfg);
        if (why) return why;
      }
      return null;
    }
  }
  if (REMOTE.has(name)) return null;
  // `ps e`, `ps aux e`, `ps auxe`: BSD-style e prints each process's environment. A word after -o, -C,
  // -u and the like is that option's value.
  const bsdE = (w: Word, k: number) => /^[a-zA-Z]*e[a-zA-Z]*$/.test(w.text) && !/^-[a-zA-Z]*[oOpCuUgGtq]$|^--\w+$|^[a-zA-Z]*[oOpUt]$/.test(args[k - 1]?.text ?? '');
  if (name === 'ps' && args.some(bsdE)) return hard(`This \`ps\` prints processes' environments. ${ENVIRON_WHY}`);
  const sub = args.filter((w) => !w.text.startsWith('-')).map((w) => w.text);
  if (name === 'gh' && sub[0] === 'auth' && /^(login|logout|refresh|switch)$/.test(sub[1] ?? '')) return hard(`\`gh auth ${sub[1]}\` would change which GitHub login gh uses. ${GH_ENV_WHY}`);
  // Every turn, Citadel, its contraptions and other people's dev servers run as the one account, so a
  // pattern kill reaches them all: on 2026-11-03 a turn's `pkill -f app/dev/dev.ts` killed two minions'
  // shells (#299; what took Citadel down was a kill fed by grep, see listingKill).
  if (name === 'pkill' || name === 'killall') return hard(`\`${name}\` kills by name across the whole account: other minions' shells and dev servers, Citadel and its contraptions. Stop your own process by pid: \`$!\` when you start it, or the pid from \`ss -ltnp 'sport = :<your port>'\`, checked with \`readlink /proc/<pid>/cwd\`.`);
  if (name === 'printenv') return hard(`\`printenv\` prints the environment. ${ENV_WHY}`);
  // Anywhere among the plain words: an option's value (`--model haiku`) comes before the subcommand.
  const print = args.some((w) => w.text === '-p' || w.text === '--print');
  if (name === 'claude' && (sub.includes('setup-token') || sub.includes('/login') || sub.some((t, k) => t === 'auth' && sub[k + 1] === 'login') || (sub[0] === 'login' && !print))) {
    return hard('Signing Claude in from a turn would make or replace a login token. People sign in themselves, in their own terminal.');
  }
  if (NETWORK.has(name) && args.some((w) => RUNNER_API.test(w.text) || /(citadel|claude)-runner[^/\s]*\.sock/.test(w.text))) return hard("A runner's socket and its endpoints in Citadel's API are for the runner and Citadel; a turn never pairs, connects or sends as one.");
  if (name === 'podman' || name === 'docker') {
    // unshare enters podman's user namespace, where every container's files (and sign-in) are open.
    if (sub[0] === 'unshare') return hard(`\`${name} unshare\` opens podman's storage, which holds every person's Claude container and sign-in. ${CLAUDE_CONTAINERS_WHY}`);
    if (args.some((w) => /citadel-claude/.test(w.text))) return hard(`That \`${name}\` call reaches a person's Claude container or volume. ${CLAUDE_CONTAINERS_WHY}`);
    const all = args.some((w) => /^(-l|--latest|--all|-[a-zA-Z]*a[a-zA-Z]*)$/.test(w.text));
    if ((all && (PODMAN_ALL.test(sub[0] ?? '') || sub[0] === 'exec' || (sub[0] === 'container' && PODMAN_ALL.test(sub[1] ?? '')) || (sub[0] === 'volume' && sub[1] === 'rm'))) || (sub[0] === 'system' && /^(prune|reset|migrate|renumber)$/.test(sub[1] ?? '')) || (sub[0] === 'volume' && sub[1] === 'prune')) {
      return hard(`That \`${name}\` call takes every container or volume at once, people's Claude ones included. ${CLAUDE_CONTAINERS_WHY}`);
    }
  }
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
  // The deploy script is the sanctioned way to touch the live checkout and restart the service: running
  // it (itself, through systemd-run, or as a shell's script) is fine, naming it to rm, cp or git is not (#468 S01-2).
  const deploy = join(cfg.checkout, 'tools/deploy.sh');
  const fromOperand = (ws: Word[]) => ws.slice(Math.max(0, ws.findIndex((w) => !w.text.startsWith('-'))));
  let run = [cmd, ...args];
  if (name === 'systemd-run') run = fromOperand(args);
  if (run[0] && SHELLS.has(basename(run[0].text))) run = fromOperand(run.slice(1));
  if (run[0] && !run[0].text.startsWith('-') && pathsOf(run[0], st, cfg).includes(deploy)) return null;

  const sysctl = words.findIndex((w, k) => k >= i && basename(w.text) === 'systemctl');
  if (sysctl >= 0) {
    const plain = words.slice(sysctl + 1).filter((w) => !w.text.startsWith('-')).map((w) => w.text);
    const [verb, ...units] = plain;
    if (STOP_VERBS.has(verb) && units.some((u) => APP_UNITS.test(u))) {
      return hard(`systemctl ${verb} of ${units.join(' ')} is blocked: it cuts off every running turn (or the shared Godot editor, or a person's Claude container and their turns). Deploy with ${hasDeployScript(cfg) ? 'tools/deploy.sh, which restarts without stopping running turns' : 'the cc-restart-when-idle unit'}, or ask a person.`);
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
  // xargs hands the command paths from stdin, which can't be read here.
  if (viaXargs && (REMOVERS.has(name) || name === 'truncate')) return hard(`\`xargs ${name}\` takes its paths from its input, so the tripwire can't tell whether they reach ${cfg.data}, the live data dir. Name the paths in the command, or use \`find <folder> … -delete\` on a folder outside it. ${SCRATCH}`);
  for (const w of writeTargets(name, args)) {
    if (name !== 'touch' && name !== 'mkdir' && !(name === 'tee' && args.some((x) => /^-[a-zA-Z]*a|^--append$/.test(x.text)))) {
      const blind = blindWriteReason(w, st, cfg, name);
      if (blind) return { ...blind, reason: `\`${name}\` on ${blind.reason}` };
    }
    for (const p of pathsOf(w, st, cfg)) {
      const why = writeReason(p, cfg);
      if (why) return { reason: `\`${name}\` would change ${p}. ${why}`, ask: askable(p, name === 'sqlite3' && !sqlShown(args) ? '' : name, cfg) };
      if ((REMOVERS.has(name) || name === 'find') && containsProtected(p, cfg)) return hard(`\`${name}\` on ${p} would take protected folders with it (the live checkout, data, config or keys). Name the exact path you mean.`);
      if ((REMOVERS.has(name) || name === 'find') && schemeFolder(p, cfg)) return hard(`\`${name}\` on ${p} would take a whole part of your scheme's folder with it (its main checkout, every minion's worktree, the shared folder or every TMPDIR). Name the exact path you mean, one level further down.`);
    }
  }
  return null;
}

/** The command a segment runs and its arguments, past assignments, keywords and wrappers (`xargs -n1 kill` is kill). */
function commandOf(seg: Segment): { name: string; args: Word[] } {
  const w = seg.words;
  let i = 0;
  for (let wrapped = false; i < w.length; i++) {
    const t = w[i].text;
    if (WRAPPERS.has(basename(t))) wrapped = true;
    else if (!/^[A-Za-z_]\w*=/.test(t) && !KEYWORDS.has(t) && !(wrapped && (t.startsWith('-') || /^[\d.]+[smhd]?$/.test(t)))) break;
  }
  return { name: basename(w[i]?.text ?? ''), args: w.slice(i + 1) };
}

/** Every socket on the account, left for grep or awk to narrow down: ss with no port filter, netstat, lsof -i with no port. */
function wholeListing({ name, args }: { name: string; args: Word[] }): boolean {
  if (name === 'netstat') return true;
  if (name === 'ss') return !args.some((w) => /\b([sd]port|src|dst)\b/.test(w.text));
  const inet = (t: string) => /^-[a-zA-Z]*i/.test(t);
  if (name === 'lsof') return args.some((w) => inet(w.text)) && !args.some((w, k) => w.text.includes(':') && (inet(w.text) || /^-[a-zA-Z]*i$/.test(args[k - 1]?.text ?? '')));
  return false;
}

const LISTING_KILL_WHY = "That `kill` takes its pids from the whole socket table narrowed by grep or awk, so a pattern that comes out empty or loose kills every server on the account: on 2026-11-03 `kill $(ss -ltnp | grep \":$P \" …)` with an empty $P took Citadel and every contraption down for 7½ hours (#299). Let ss pick the port, `ss -ltnp 'sport = :<port>'`, or use `$!` from when you started it.";

/** Why this Bash command is blocked, or null. One hard-blocked part makes the whole command a hard block. */
export function commandReason(command: string, st: State, cfg: TripwireConfig): Verdict | null {
  // Open parens: the folder before each, and for a $( … ), the command it sits in, to pick up after it.
  const stack: { cwd: string | null; outer?: Segment; redir: string | null; listed: boolean; anyListed: boolean }[] = [];
  let seg: Segment = { words: [], redirects: [] };
  let redir: string | null = null;
  let asked: Verdict | null = null;
  // A kill whose pids come from a whole listing: through a pipe (`| xargs kill`, `| while read p`), a
  // $( … ) it sits in, or a variable set from one. `listed`: this pipeline so far; `anyListed`: this paren level.
  // shortcut: misses a kill inside `xargs sh -c '…'`, a listing saved to a file or read through <( … ), and
  // a tainted variable echoed into xargs; widen it if a turn trips over one of those.
  const fed = new Set<Segment>();
  const tainted = new Set<string>();
  let listed = false;
  let anyListed = false;
  const listingKill = (s: Segment): Verdict | null => {
    const c = commandOf(s);
    const from = listed || fed.has(s);
    if (c.name === 'kill' && (from || c.args.some((w) => w.unknown && [...tainted].some((v) => w.tmpl!.includes(`\0${v}\0`))))) return hard(LISTING_KILL_WHY);
    if (from) {
      const names = !c.name ? s.words.map((w) => w.text.split('=')[0]) : c.name === 'for' ? c.args.slice(0, 1).map((w) => w.text) : c.name === 'read' ? c.args.filter((w) => !w.text.startsWith('-')).map((w) => w.text) : [];
      for (const n of names) tainted.add(n);
    } else if (!c.name) for (const w of s.words) tainted.delete(w.text.split('=')[0]);
    if (wholeListing(c) || fed.has(s)) listed = anyListed = true;
    return null;
  };
  for (const tok of [...lex(command, cfg.home), { kind: 'op', text: ';' } as Tok]) {
    if (tok.kind === 'word') {
      if (redir) seg.redirects.push({ op: redir, target: tok.word });
      else seg.words.push(tok.word);
      redir = null;
    } else if (tok.kind === 'redir') redir = tok.op;
    else if (tok.text === '$(') {
      stack.push({ cwd: st.cwd, outer: seg, redir, listed, anyListed });
      seg = { words: [], redirects: [] };
      redir = null;
      listed = anyListed = false;
    } else {
      redir = null;
      const why = segmentReason(seg, st, cfg) ?? listingKill(seg);
      seg = { words: [], redirects: [] };
      if (why && !why.ask) return why;
      asked ??= why;
      if (tok.text !== '|' && tok.text !== '|&' && tok.text !== '(') listed = false;
      // A cd inside ( … ) or $( … ) doesn't outlive it.
      // `ss -ltnp | ( grep x | xargs kill )`: the pipe carries on into the subshell.
      if (tok.text === '(') {
        stack.push({ cwd: st.cwd, redir: null, listed, anyListed });
        anyListed = false;
      }
      if (tok.text === ')' && stack.length) {
        const open = stack.pop()!;
        const inner = anyListed;
        st.cwd = open.cwd;
        ({ listed, anyListed } = open);
        if (open.outer) {
          (seg = open.outer), (redir = open.redir);
          if (inner) fed.add(seg);
        } else if (inner) listed = anyListed = true;
      }
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
    const v = typeof ti.command === 'string' ? commandReason(ti.command, { cwd, vars: new Set(), values: new Map() }, cfg) : null;
    if (!v?.ask) return v;
    if (!cfg.ask) return hard(v.reason);
    if (explanation(ti)) return v;
    return hard(`${v.reason} A person can approve this one call on a card, but only with an explanation: if the work really needs it, retry once with a Bash description of at least ${MIN_EXPLANATION} characters that says why (e.g. "Delete the DB copies Cara OK'd in #54").`);
  }
  if (tool === 'Skill') {
    const skill = String(ti.skill ?? '');
    if (/(^|:)ultrareview$/.test(skill) || (/(^|:)code-review$/.test(skill) && /(^|\s)ultra\b/.test(String(ti.args ?? '')))) return hard(`The ${skill} skill's ultra review is blocked. ${ULTRAREVIEW_WHY}`);
    return null;
  }
  const file = ti.file_path ?? ti.notebook_path ?? ti.path;
  if (typeof file !== 'string' || !file) return null;
  const st = { cwd, vars: new Set<string>(), values: new Map<string, string[]>() };
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
