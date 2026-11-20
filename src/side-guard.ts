// The PreToolUse hook a side question's fork runs with (#932, src/side-ask.ts): the fork is a read-only copy of a
// minion's session, so it may look (files, git, gh, the logs, the database read-only) but never change anything.
// The tools stay as the minion's own, so its cached prefix still matches; this hook refuses the writes instead.
// It fails closed: a call it can't read is refused. The tripwire runs beside it, as in every turn.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { lex } from './tripwire.ts';

const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'ToolSearch', 'WebSearch', 'WebFetch', 'Skill', 'TaskList', 'TaskGet', 'TaskOutput', 'BashOutput']);
// Citadel's MCP tools that only read (src/mcp.ts); both servers' names, the minion's and the Taskmaster's.
const READ_MCP = new Set(['read_minion', 'read_ticket', 'list_tickets', 'list_properties', 'list_artifacts', 'artifact_data', 'host_check', 'ci_runners', 'ci_files',
  'usage_split', 'list_schedules', 'list_catalogue', 'list_machines', 'check_machine', 'get_project_instructions', 'get_project_settings', 'read_person_instructions',
  'get_app_instructions', 'list_contraptions', 'contraption_read', 'contraption_turns', 'search_memory', 'search_decisions']);

// Commands that only read, whatever their arguments (a few flags that write are refused in FLAG_WRITES).
const READERS = new Set(['ls', 'cat', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'stat', 'du', 'df', 'ps', 'pgrep', 'ss', 'pwd', 'echo', 'printf',
  'which', 'type', 'file', 'cut', 'tr', 'jq', 'diff', 'cmp', 'comm', 'basename', 'dirname', 'realpath', 'readlink', 'id', 'whoami', 'uptime', 'free', 'nproc',
  'uname', 'true', 'false', 'test', '[', 'column', 'nl', 'tac', 'rev', 'od', 'lsof', 'lsblk', 'findmnt', 'sha256sum', 'sha1sum', 'md5sum', 'cd', 'zcat',
  'journalctl', 'ci-failures', 'sort', 'uniq', 'date', 'find', 'sed', 'git', 'gh', 'sqlite3', 'systemctl', 'curl', 'citadel-wait', 'sleep']);
// Flags that make an otherwise read-only command write or run something. GNU tools take a short flag inside a cluster
// (`-uo`) and a long one cut short (`--out=`), so these match both.
const FLAG_WRITES: Record<string, RegExp> = {
  sort: /^-[^-]*o|^--(o|com)/, date: /^-[^-]*s|^--s/, rg: /^--(pre|hostname)/, journalctl: /^--(v|rot|fl|rel|sy|setup)/,
  find: /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/, file: /^-[^-]*C|^--comp/, ss: /^-[^-]*K|^--k/,
};
// curl prints a GET and nothing else: only these flags, the value ones taking the next word.
const CURL_FLAGS = /^(-[sSLfiIvk]+|--(silent|show-error|location|fail|include|head|compressed|insecure|verbose|no-progress-meter))$/;
const CURL_VALUE = /^(-H|--header|-m|--max-time|--connect-timeout|-A|--user-agent)$/;
// sqlite3 with its SQL as an argument (so it never reads stdin) and only output-format flags; SQL functions that
// write files or load code, and VACUUM INTO, which writes even on a read-only database, are refused.
const SQLITE_FLAGS = /^-(readonly|json|header|noheader|column|csv|line|list|box|markdown|table|tabs|quote|bail|batch)$/;
const SQLITE_WRITES = /\b(writefile|edit|load_extension|vacuum|fts3_tokenizer)\b/i;
const SYSTEMCTL_FLAGS = /^(--user|--no-pager|--full|-l|--all|-a|--plain|--no-legend|--value|--lines=\d+)$/;
const GIT_READS = new Set(['log', 'show', 'diff', 'status', 'rev-parse', 'ls-files', 'ls-tree', 'blame', 'grep', 'merge-base', 'cat-file', 'describe', 'shortlog',
  'rev-list', 'show-ref', 'for-each-ref', 'name-rev', 'whatchanged', 'range-diff', 'cherry', 'count-objects', 'check-ignore', 'var', 'help', 'version']);
const GH_READS: Record<string, Set<string>> = {
  pr: new Set(['view', 'list', 'diff', 'checks', 'status']), run: new Set(['view', 'list']), issue: new Set(['view', 'list', 'status']),
  repo: new Set(['view', 'list']), release: new Set(['view', 'list']), workflow: new Set(['view', 'list']), search: new Set(['prs', 'issues', 'code', 'commits', 'repos']),
};
// Redirects that send output nowhere new: into /dev/null, or one stream into the other; `<` and heredocs only feed stdin.
const SAFE_REDIRECT = new Set(['<', '<<', '<<-', '<<<']);

export const READ_ONLY = 'This is a side question: a read-only copy of the minion\'s session. It can look (files, git, gh, logs, the database read-only) but not change anything';

/** Why the fork may not make this call, or null when it is a read. */
export function sideGuard(input: { tool_name?: unknown; tool_input?: any }): string | null {
  const tool = typeof input?.tool_name === 'string' ? input.tool_name : '';
  if (READ_TOOLS.has(tool)) return null;
  const mcp = /^mcp__(thread|coordinator)__([a-z_]+)$/.exec(tool);
  // artifact_data reads, unless it's given entries to set.
  if (mcp && READ_MCP.has(mcp[2]) && !(mcp[2] === 'artifact_data' && input.tool_input?.entries)) return null;
  if (tool === 'Bash') {
    const command = typeof input.tool_input?.command === 'string' ? input.tool_input.command : '';
    if (input.tool_input?.run_in_background) return `${READ_ONLY}, and it runs nothing in the background.`;
    const why = bashWrites(command);
    return why && `${READ_ONLY}: ${why}`;
  }
  return `${READ_ONLY}, so ${tool || 'that tool'} is off. Answer from what you can read, or say what the minion would need to do.`;
}

/** Why this shell command might change something, or null when every part of it is a known read. */
export function bashWrites(command: string): string | null {
  let toks: ReturnType<typeof lex>;
  try {
    toks = lex(command, homedir());
  } catch {
    return 'the command could not be read, so it is refused.';
  }
  let seg: { words: string[]; redirects: { op: string; target: string }[] } = { words: [], redirects: [] };
  const segs = [seg];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.kind === 'op') {
      if (!['|', '&&', '||', ';', '\n'].includes(t.text)) return `\`${t.text}\` is refused here (no subshells, command substitution or background jobs).`;
      segs.push((seg = { words: [], redirects: [] }));
    } else if (t.kind === 'redir') {
      const next = toks[i + 1];
      const target = next?.kind === 'word' ? next.word.text : '';
      if (next?.kind === 'word') i++;
      seg.redirects.push({ op: t.op, target });
    } else {
      if (t.word.unknown && !seg.words.length) return 'a command name built from a variable or substitution is refused.';
      if (t.word.tmpl?.includes('\0\0')) return 'command substitution is refused.';
      seg.words.push(t.word.text);
    }
  }
  for (const s of segs) {
    for (const r of s.redirects) {
      if (SAFE_REDIRECT.has(r.op)) continue;
      if (/^\d*>&?$|^&>$|^>>$/.test(r.op) && r.target === '/dev/null') continue;
      // One stream into another (`2>&1`); `> 1` is a file named 1.
      if (/^\d*>&$/.test(r.op) && /^\d$/.test(r.target)) continue;
      if (/^\d*>&\d$/.test(r.op)) continue;
      return `the redirect \`${r.op} ${r.target}\` would write a file.`;
    }
    if (!s.words.length) continue;
    const why = commandWrites(s.words);
    if (why) return why;
  }
  return null;
}

/** Why one simple command (its words, name first) might write, or null. */
function commandWrites(words: string[]): string | null {
  const [name, ...args] = words;
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(name)) return 'setting variables before a command is refused.';
  if (!READERS.has(name)) return `\`${name}\` isn't on the side question's list of read-only commands.`;
  const flag = FLAG_WRITES[name];
  if (flag && args.some((a) => flag.test(a))) return `\`${name}\` with that flag writes or runs something.`;
  const plain = args.filter((a) => !a.startsWith('-'));
  if (name === 'uniq' && plain.length > 1) return '`uniq` with an output file writes it.';
  if (name === 'sed') return sedWrites(args);
  if (name === 'git') return gitWrites(args);
  if (name === 'gh') return ghWrites(args);
  if (name === 'sqlite3') {
    if (!args.includes('-readonly')) return '`sqlite3` needs `-readonly` here.';
    if (args.some((a) => a.startsWith('-') && !SQLITE_FLAGS.test(a))) return 'that sqlite3 flag is refused here (only -readonly and output formats).';
    if (plain.length !== 2) return '`sqlite3` takes the database and one SQL argument here, never SQL from stdin.';
    if (/^\s*\./m.test(plain[1])) return 'sqlite3 dot-commands are refused here.';
    if (SQLITE_WRITES.test(plain[1])) return 'that SQL writes a file or loads code.';
    return null;
  }
  if (name === 'systemctl') {
    // Every flag known, so the verb is the first plain word and not some flag's value.
    if (args.some((a) => a.startsWith('-') && !SYSTEMCTL_FLAGS.test(a))) return 'that systemctl flag is refused here.';
    return args.includes('--user') && ['status', 'show', 'list-units', 'list-timers', 'is-active', 'is-failed', 'is-enabled', 'cat'].includes(plain[0]) ? null : 'only `systemctl --user status` and other look-ups are allowed.';
  }
  if (name === 'curl') {
    for (let i = 0; i < args.length; i++) {
      if (CURL_VALUE.test(args[i])) i++;
      else if (args[i].startsWith('-') && !CURL_FLAGS.test(args[i])) return '`curl` may only GET and print here (-s, -S, -L, -f, -i, -H and timeouts).';
    }
    return null;
  }
  return null;
}

function sedWrites(args: string[]): string | null {
  const scripts: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-e' || a === '--expression') scripts.push(args[++i] ?? '');
    else if (a === '-n' || a === '-E' || a === '-r' || a === '--quiet' || a === '--silent' || a === '-s' || a === '-z') continue;
    else if (a.startsWith('-')) return `\`sed ${a}\` is refused here (only -n, -E and -e).`;
    else if (!scripts.length) scripts.push(a);
  }
  const line = /^(\d+|\$|\/[^/]*\/)(,(\d+|\$|\/[^/]*\/|\+\d+))?\s*[pd=]$|^(\d+|\$)?q$/;
  const sub = /^((\d+|\$|\/[^/]*\/)(,(\d+|\$|\/[^/]*\/))?)?s(.)((?:(?!\5).)*)\5((?:(?!\5).)*)\5[gpiI0-9]*$/;
  for (const s of scripts.flatMap((x) => x.split(/[;\n]/)).map((x) => x.trim()).filter(Boolean)) {
    if (!line.test(s) && !sub.test(s)) return `the sed script \`${s}\` isn't a plain print or substitute.`;
  }
  return null;
}

function gitWrites(args: string[]): string | null {
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) {
    if (args[i] === '-C') i += 2;
    else if (args[i] === '--no-pager' || args[i].startsWith('--git-dir=') || args[i].startsWith('--work-tree=')) i++;
    else return `\`git ${args[i]}\` is refused here.`;
  }
  const [sub, ...rest] = args.slice(i);
  // --output, --ext-diff and --exec cut short too; `git grep -O<cmd>` opens its matches in a command.
  if (rest.some((a) => /^--(ou|ext|exe|op)|^-O/.test(a))) return 'that git flag writes or runs something.';
  if (GIT_READS.has(sub)) return null;
  const plain = rest.filter((a) => !a.startsWith('-'));
  if (sub === 'branch' && rest.every((a) => /^(-a|-r|-v|-vv|--list|--all|--remotes|--show-current|--contains|--merged|--no-merged|--sort=.*|--format=.*)$/.test(a) || !a.startsWith('-')) && (rest.includes('--list') || rest.some((a) => /^--(contains|merged|no-merged)$/.test(a)) || !plain.length)) return null;
  if (sub === 'tag' && (!rest.length || rest.includes('-l') || rest.includes('--list'))) return null;
  if (sub === 'worktree' && plain[0] === 'list') return null;
  if (sub === 'stash' && (plain[0] === 'list' || plain[0] === 'show')) return null;
  if (sub === 'remote' && (!plain.length || plain[0] === 'show' || plain[0] === 'get-url')) return null;
  if (sub === 'reflog' && (!plain.length || plain[0] === 'show')) return null;
  if (sub === 'config' && rest.some((a) => /^(--get|--get-all|--get-regexp|--list|-l)$/.test(a))) return null;
  return `\`git ${sub ?? ''}\` changes the repository, or isn't on the read-only list.`;
}

function ghWrites(args: string[]): string | null {
  const [group, verb, ...rest] = args;
  if (group === 'api') {
    const all = [verb, ...rest];
    return all.some((a) => /^(-X|--method|-f|-F|--field|--raw-field|--input)/.test(a ?? '')) ? '`gh api` may only GET here.' : null;
  }
  return GH_READS[group]?.has(verb) ? null : `\`gh ${group ?? ''} ${verb ?? ''}\` isn't a read.`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // Fails closed: a fork that can't be checked can't write either.
  let why: string | null;
  try {
    why = sideGuard(JSON.parse(readFileSync(0, 'utf8')));
  } catch (err: any) {
    why = `${READ_ONLY}, and the guard could not read this call (${err.message}).`;
  }
  if (why) {
    process.stderr.write(`[side question] ${why}\n`);
    process.exit(2);
  }
}
