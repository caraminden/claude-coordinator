// Work-progress tracking shared by the server (board summaries) and the browser (ticket readout).
// Replays a ticket's stored events to rebuild Claude's task list (TaskCreate/TaskUpdate, or
// TodoWrite) and to sort every other tool call under the step that was in progress when it ran.

/** Tools that manage the task list itself; they are progress, not work, so they are never shown as actions. */
export const TASK_TOOLS = new Set(['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'TodoWrite', 'mcp__thread__plan']);
/** A minion's always-loaded plan tool (#1275, src/mcp.ts PLAN), read like TaskCreate and TaskUpdate. */
const PLAN_TOOLS = new Set(['mcp__thread__plan']);
/** Housekeeping tools (loading other tools' schemas) that are not shown as actions either. */
const HIDDEN_TOOLS = new Set(['ToolSearch']);

/** Whether a tool call is real work to show, rather than plan bookkeeping or housekeeping. */
export const isWorkTool = (name) => !TASK_TOOLS.has(name) && !HIDDEN_TOOLS.has(name);

export function createProgress() {
  return {
    // work: a step's milliseconds underway inside running turns; workFrom: when the running turn's share began (null between turns).
    tasks: [], // { id, subject, activeForm, description, outcome, note, status: 'pending' | 'in_progress' | 'completed', actions, estimate, startedAt, work, workFrom, kind, own, seen, stage }
    pendingCreates: new Map(), // tool_use_id -> TaskCreate input, until its result tells us the task id
    turnActions: 0,
    turnFailed: false, // the last turn ended in an error event (no init since)
    turnOk: false, // the last turn sent a successful result, so a later error (a deploy report) isn't its failure
    lastAction: null,
    planMoved: true, // the task list changed since the last turn ended; until it does, a step left underway isn't this turn's
    model: null, // the running or last turn's model, from its init
    lastAt: null, // the newest event's time, where a turn that ended with no result stopped counting
    at: null, // the tagged step (#1923) the server last saw worked on, by id: its stage is the one underway
    asked: false, // a card went out this turn, so it isn't answered yet
    planned: false, // this turn made a plan call
    prep: false, // the review skill is open and no reviewer has started
    side: null, // the untagged step the minion said it is on, until the server next sees another stage worked on
    closing: false, // close_self was called this turn, and nothing since says it stays open
    finished: null, // [] collects finished steps for step_times (#571), which the runner drains; null collects nothing
  };
}

/** Where a tagged plan is (#1923), for a page that starts in the middle of one (history.ts). */
export const planPlace = ({ at, asked, planned, prep, side, closing }) => ({ at, asked, planned, prep, side, closing });

const basename = (path) =>
  String(path ?? '')
    .split('/')
    .filter(Boolean)
    .pop() || String(path ?? '');

function clip(text, max = 90) {
  const line = String(text ?? '')
    .trim()
    .split('\n')[0]
    .trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);

function hostname(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return clip(url, 60);
  }
}

const GIT_WORDS = {
  status: 'Checked what changed',
  diff: 'Looked at code changes',
  log: 'Looked at commit history',
  show: 'Looked at a commit',
  add: 'Staged changes',
  commit: 'Committed changes',
  merge: 'Merged branches',
  rebase: 'Rebased the branch',
  push: 'Pushed to the remote',
  pull: 'Pulled from the remote',
  fetch: 'Fetched from the remote',
  checkout: 'Switched branches',
  switch: 'Switched branches',
  branch: 'Looked at branches',
  stash: 'Stashed changes',
  clone: 'Cloned a repo',
  worktree: 'Managed worktrees',
  reset: 'Reset changes',
  restore: 'Restored files',
  'ls-files': 'Listed tracked files',
  grep: 'Searched the code',
  blame: 'Looked at who changed what',
  remote: 'Looked at remotes',
  'rev-parse': 'Looked up a commit',
};

const TEST_RE = /^(npm|pnpm|yarn|bun) (run )?test|^(pytest|jest|vitest|go test|cargo test|make test|node --test)/;
// Output sent to a file with an extension (not stderr's 2> or &>): the command changes that file.
const WRITE_RE = /(?:^|[^2&>])>>?\s*([\w./~-]+\.\w+)/;

/** git with its options before the subcommand (-C <dir>, -c <name=value>, quoted or not) left out. */
function bareGit(command) {
  return command.replace(/\bgit((?: -[Cc] (?:"[^"]*"|'[^']*'|\S+)| --(?:git-dir|work-tree)[= ](?:"[^"]*"|'[^']*'|\S+))+)(?= )/g, 'git');
}

/** A raw shell command in words, for when Claude gave it no description. Null if nothing fits. */
function describeOne(cmd) {
  const c = cmd.trim().replace(/^((sudo|timeout \S+|env|time|nice|setsid|\w+=\S*)\s+)+/, '');
  const [prog, ...rest] = c.split(/\s+/);
  const args = rest.filter((a) => !a.startsWith('-'));
  const file = args.find((a) => /[./]/.test(a) && !/[|<>$]/.test(a));
  if (!prog || prog === 'cd' || prog === 'true' || (prog === 'echo' && /^echo\s*$/.test(c))) return null;
  if (TEST_RE.test(c)) return 'Ran the tests';
  if (prog === 'git') {
    const sub = bareGit(c)
      .split(/\s+/)
      .slice(1)
      .find((a) => !a.startsWith('-'));
    return GIT_WORDS[sub] ?? `Ran git ${sub ?? ''}`.trim();
  }
  if (prog === 'gh') return `Used GitHub (${args.slice(0, 2).join(' ')})`;
  if (/^(npm|pnpm|yarn|bun)$/.test(prog)) return /^(i|install|add|ci)$/.test(args[0]) ? 'Installed dependencies' : `Ran ${prog} ${args.slice(0, 2).join(' ')}`.trim();
  if (/^(pip|pip3|uv)$/.test(prog)) return 'Installed Python packages';
  if (prog === 'node' && rest.includes('--check')) return 'Checked JavaScript syntax';
  if (/^(tsc|eslint|prettier|ruff|mypy)$/.test(prog)) return `Checked the code with ${prog}`;
  if (/^(node|python3?|deno|bun|ruby|bash|sh|zsh)$/.test(prog)) {
    if (args[0] === '-' || /<<|^-[ce]$/.test(rest.join(' ')) || !file) return `Ran a ${/^python/.test(prog) ? 'Python' : prog === 'node' ? 'Node' : prog} script`;
    return `Ran ${basename(file)}`;
  }
  if (/^(ls|tree|find|fd)$/.test(prog)) return 'Listed files';
  const written = /^(cat|echo|printf)$/.test(prog) && c.match(WRITE_RE)?.[1];
  if (written) return `Wrote ${basename(written)}`;
  // sed's and perl's script comes before the file, and may hold slashes and dots itself.
  const target = /^(sed|perl)$/.test(prog) && args.length > 1 ? args.at(-1) : file;
  if (/^(cat|head|tail|less|bat)$/.test(prog) || (prog === 'sed' && rest.includes('-n'))) return target ? `Looked at ${basename(target)}` : 'Looked at a file';
  if (prog === 'sed' || (prog === 'perl' && rest.some((a) => /^-[a-z]*i/.test(a)))) return target ? `Edited ${basename(target)}` : 'Edited a file';
  if (/^(grep|rg|ag)$/.test(prog)) return 'Searched files';
  if (/^(wc|du|df|stat|file)$/.test(prog)) return 'Measured files';
  if (/^(mkdir|touch)$/.test(prog)) return 'Created files';
  if (/^(cp|mv|ln|rsync)$/.test(prog)) return 'Copied or moved files';
  if (/^(rm|rmdir)$/.test(prog)) return 'Deleted files';
  if (/^(curl|wget|http)$/.test(prog)) return `Made a web request${rest.find((a) => /^https?:/.test(a.replace(/^['"]/, ''))) ? ` to ${hostname(rest.find((a) => /^https?:/.test(a.replace(/^['"]/, ''))).replace(/^['"]|['"]$/g, ''))}` : ''}`;
  if (/^(kill|pkill|killall)$/.test(prog)) return 'Stopped a process';
  if (/^(ps|pgrep|top|htop)$/.test(prog)) return 'Checked running processes';
  if (/^(ss|netstat|lsof)$/.test(prog)) return 'Checked open ports';
  if (prog === 'sleep') return 'Waited';
  if (prog === 'systemctl' || prog === 'journalctl') return `Checked the ${args.find((a) => !/^(status|restart|start|stop|is-active|show|cat)$/.test(a)) ?? ''} service`.replace('the  ', 'a ');
  if (/^(podman|docker)$/.test(prog)) return `Ran podman ${args[0] ?? ''}`.trim();
  if (/^(make|cargo|go)$/.test(prog)) return `Ran ${prog} ${args[0] ?? ''}`.trim();
  if (/^(echo|printf)$/.test(prog)) return 'Printed some text';
  if (prog === 'claude') return 'Ran Claude Code';
  if (/^(for|while|if)$/.test(prog)) return 'Ran a shell loop';
  return null;
}

/** "git log …; git diff …" -> "Looked at commit history, looked at code changes". */
function describeCommand(command) {
  const parts = [];
  // Only the first program of each pipeline matters ("git log | head" is still "looked at history").
  for (const seg of String(command ?? '').split(/\n|&&|\|\||;/)) {
    const words = describeOne(seg.split('|')[0]);
    // "Looked at a.ts" then "Looked at b.ts" -> "Looked at a.ts and b.ts".
    const verb = words?.match(/^(Looked at|Edited|Wrote|Ran) (\S+\.\w+)$/);
    const prev = verb && parts.findIndex((t) => t.startsWith(`${verb[1]} `) && /\.\w+$/.test(t));
    if (verb && prev >= 0) parts[prev] = `${parts[prev].replace(' and ', ', ')} and ${verb[2]}`;
    else if (words && !parts.includes(words)) parts.push(words);
    if (/<<\s*'?(\w+)/.test(seg)) break; // a heredoc body follows; it is not more commands
  }
  if (!parts.length) return `Ran \`${clip(command, 60)}\``;
  // Filler like `echo done` only matters when it is all the command did.
  const filler = ['Printed some text', 'Waited', 'Listed files'];
  if (parts.some((t) => !filler.includes(t))) parts.splice(0, parts.length, ...parts.filter((t) => !filler.includes(t)));
  const shown = parts
    .slice(0, 2)
    .map((t, n) => (n ? t.charAt(0).toLowerCase() + t.slice(1) : t))
    .join(', ');
  return parts.length > 2 ? `${shown} and more` : shown;
}

/**
 * What kind of work a shell command is, as a phase of the job: looking around, changing things,
 * checking they work, or saving them to git. Uses the command itself, then Claude's description.
 */
function commandPhase(command, description = '') {
  // git's options before the subcommand don't change which subcommand it is.
  const c = bareGit(String(command ?? ''));
  if (/\bgit (commit|merge|push|pull|rebase|cherry-pick)\b|\bgh pr\b/.test(c)) return 'save';
  if (/\bsed -i|\bperl -[a-z]*i|\.write\(|writeFile|\bgit (add|checkout|restore|stash)\b|\b(mv|cp|rm|mkdir|touch|ln)\s|\b(npm|pnpm|yarn|pip3?|uv) (i|install|add)\b/.test(c) || WRITE_RE.test(c)) return 'change';
  if (/(^|\W)(npm|pnpm|yarn|bun) (run )?test|pytest|jest|vitest|go test|cargo test|node --test|--check\b|\btsc\b|eslint|\bcurl\b|\bwget\b|systemctl|journalctl|screenshot|\b(node|python3?|deno|bun) (?!-e)\S+\.(m?js|ts|py)\b/.test(c)) return 'verify';
  if (/^\s*(cd \S+ && )?(git (status|log|diff|show|branch|blame|grep|ls-files|rev-parse|remote)|ls|cat|head|tail|less|grep|rg|find|tree|wc|sed -n|stat|file)\b/.test(c)) return 'explore';
  const d = description.toLowerCase();
  if (/\b(commit|merge|push|deploy)/.test(d)) return 'save';
  if (/^(run|test|check|verify|start|restart|try|build)/.test(d)) return 'verify';
  if (/^(create|write|edit|update|add|remove|delete|install|fix|rename|move|copy|apply)/.test(d)) return 'change';
  if (/^(read|show|list|look|inspect|find|search|view|see|count|compare|print)/.test(d)) return 'explore';
  return 'other';
}

const TOOL_PHASE = {
  Read: 'explore',
  Grep: 'explore',
  Glob: 'explore',
  LS: 'explore',
  Edit: 'change',
  MultiEdit: 'change',
  NotebookEdit: 'change',
  Write: 'change',
  WebFetch: 'research',
  WebSearch: 'research',
  Task: 'delegate',
  Agent: 'delegate',
  Workflow: 'delegate',
};

/** Which phase of the work a tool call belongs to (see PHASES). */
export function actionPhase(block) {
  const i = block.input || {};
  if (block.name === 'Bash') return commandPhase(i.command, i.description);
  if (block.name.startsWith('mcp__coordinator__')) return 'coordinate';
  return TOOL_PHASE[block.name] ?? 'other';
}

/** The kinds a plan's step can be tagged with (#1923), and how the stage reads while underway. */
export const STEP_KINDS = { read: 'Reading', build: 'Building', test: 'Testing', review: 'Reviewing', ask: 'Asking', ship: 'Shipping' };

const SCRATCH_RE = /TMPDIR|\/tmp\//;
const TESTS_RE =
  /^(?:(?:npm|pnpm|yarn|bun)(?: run)? test|(?:npx |uv run |python3? -m )?(?:pytest|unittest|jest|vitest|playwright test)\b|(?:cargo|go|dotnet|make|mix|swift|flutter) (?:\S+ )?test\b|ctest\b|(?:\S*-)?node (?:-\S+ )*--test\b|citadel-test\b|(?:\.\/)?gradlew\b.*test|node \S*ui-shot\.ts|gh workflow run \S*(?:test|check|proof|ci\b))/i;
// A repo's own check script: tools/burn-in.sh, node tools/shake-check.ts.
const CHECKER_RE = /^(?:(?:node|bash|sh|python3?|npx tsx|bun|deno run)(?: -\S+)* )?(?:[^\s"'=]*[/_.-])?(?:screen|type|self|run|unit)?(?:test|check|shot|burn-in|smoke|e2e)s?\d*(?:[_.-][^\s"'/]*)?\.(?:sh|m?[jt]s|py)\b/i;
// The kit's checks beside a review (self-review's side-check.sh, the Codex second opinion).
const SIDE_RE = /^"?[^\s"]*(?:side-check\.sh|citadel-codex-review)\b/;
// Programs that only run another: timeout 300 npm test, mise exec -- cargo test.
const WRAPPER_RE = /^(?:(?:sudo|time|nice(?: -n ?\S+)?|setsid|xvfb-run(?: -a)?|env|timeout(?: -\S+)* \S+|mise exec --|\w+=(?:"[^"]*"|\S*))\s+)+/;

/** What a shell command shows of the work (#1923): files written outside scratch folders, a test run, a ship, or ''. */
function commandKind(command) {
  const all = String(command ?? '');
  // A heredoc's body is a script or a document: it can write files, but its words run no tests.
  const bodies = [];
  const shell = all.replace(/(<<-?\s*\\?['"]?(\w+)['"]?[^\n]*\n)([\s\S]*?)(?:\n\s*\2(?=\s|$)|$)/g, (_, head, tag, body) => {
    bodies.push(body);
    return head;
  });
  // A script that names a scratch folder counts only by a write whose own path is spelled out.
  const writes = (text) => (text.match(/open\([^)\n]*\)\.write\(|\.write_text\(|write_text\(|writeFile(?:Sync)?\([^,\n]*|\.write\(/g) ?? []).some((w) => !SCRATCH_RE.test(w) && (!SCRATCH_RE.test(text) || /^(?:open|writeFile(?:Sync)?)\(['"]/.test(w)));
  let built = bodies.some(writes);
  let tested = false;
  let reviewed = false;
  let inScratch = false;
  for (const part of shell.split(/\n|&&|\|\||;|\|(?!\|)/)) {
    const seg = part
      .trim()
      .replace(/^[({]\s*|^(?:if|then|do|else|while|!)\s+/, '')
      .replace(WRAPPER_RE, '');
    if (/^cd\s/.test(seg)) inScratch = SCRATCH_RE.test(seg);
    if (/^(?:(?:ba)?sh |\.\/)?(?:\S+\/)?tools\/(?:land|deploy)\.sh\b(?!.*--(?:help|dry))|^gh pr (?:create(?!.* (?:--draft|-d)\b)|merge|ready)\b/.test(seg)) return 'ship';
    if (SIDE_RE.test(seg)) reviewed = true;
    else if (TESTS_RE.test(seg) || (CHECKER_RE.test(seg) && !inScratch && !SCRATCH_RE.test(seg))) tested = true;
    if (inScratch || /^(?:git (?!apply|mv|rm)|rg |grep )/.test(seg)) continue;
    const to = [...seg.matchAll(/(?:^|[^2&>=-])>>?\s*"?([^\s"'|&;<>()]+)|^tee (?:-a )?"?([^\s"]+)/g)].map((m) => m[1] ?? m[2]).filter((f) => /\.\w+$/.test(f) || /^[\w-]+\//.test(f));
    if (to.some((f) => !/^\/dev\//.test(f) && !SCRATCH_RE.test(f) && !/^\$/.test(f))) built = true;
    if (/^(?:sed (?:-\S+ )*-\w*i|perl (?:-\S+ )*-\w*i|git apply|apply_patch|git (?:mv|rm)\b)/.test(seg) && !SCRATCH_RE.test(seg)) built = true;
    if (/^(?:python3?|node|ruby|perl) -\w*[ce]\b/.test(seg) && writes(all)) built = true;
  }
  return built ? 'build' : reviewed ? 'review' : tested ? 'test' : '';
}

/** Grunts whose job is to judge the work. */
const REVIEWER_RE = /(?:^|[:-])(?:reviewer|critic|fresh-eyes|finding-checker)$/;

/**
 * The kind of step a tool call shows being worked on (#1923), or '' when it says nothing: reading, git and talk happen
 * during every step. `grunt` when a Grunt made the call: only its file edits count, as a reviewer runs tests of its own.
 */
export function workKind(block, grunt = false) {
  const i = block.input || {};
  // A page's cut-down copy of a long command carries the kind its whole text had (eventcut.js).
  if (block.work != null) return grunt && block.work !== 'build' ? '' : block.work;
  const tool = String(block.name ?? '');
  if (/^(?:Edit|MultiEdit|NotebookEdit|Write|apply_patch)$/.test(tool)) return /\/tmp\/|\/memory\//.test(String(i.file_path ?? i.notebook_path ?? '')) ? '' : 'build';
  if (grunt) return '';
  if (tool === 'Bash') return commandKind(i.command);
  if (tool === 'Agent' || tool === 'Task') return REVIEWER_RE.test(String(i.subagent_type ?? '')) ? 'review' : '';
  if (tool === 'Skill') return /\bself-review$/.test(String(i.skill ?? '')) ? 'prep' : '';
  const short = tool.replace(/^mcp__.*?__/, '');
  if (short === 'hand_off_land' || tool === 'mcp__thread__land' || tool === 'mcp__thread__publish_desktop') return 'ship';
  if (tool === 'mcp__thread__propose_plan') return 'ask';
  if (tool === 'mcp__thread__ask_question') return i.notice ? '' : ['ship', 'merge', 'land'].includes(i.kind) ? 'shipcard' : 'ask';
  if (/^mcp__.*-ws__run_task$/.test(tool)) return 'test';
  return '';
}

/** How each phase reads once done and while underway; `files` is filled in for changes. */
const PHASES = {
  explore: { done: 'Looked through the code', now: 'Looking through the code' },
  change: { done: (f) => (f ? `Changed ${f}` : 'Made changes'), now: (f) => (f ? `Changing ${f}` : 'Making changes') },
  verify: { done: 'Tried it out and checked it works', now: 'Trying it out' },
  save: { done: 'Saved the work in git', now: 'Saving the work in git' },
  research: { done: 'Looked things up online', now: 'Looking things up online' },
  delegate: { done: 'Had grunts work on parts of it', now: 'Working with grunts' },
  coordinate: { done: 'Updated other minions', now: 'Updating other minions' },
  other: { done: 'Ran some other commands', now: 'Running commands' },
};

/** What a tool call says about the work underway, at the level of its phase: "Changing app.js", "Trying it out". */
export function activityLabel(block) {
  const phase = actionPhase(block);
  return phaseText(phase, phase === 'change' ? describeAction(block).object : '', false);
}

function phaseText(phase, files, done) {
  const t = PHASES[phase][done ? 'done' : 'now'];
  return typeof t === 'function' ? t(files) : t;
}

/**
 * Group a run of tool calls into the phases of the work, e.g. "Looked through the code" →
 * "Changed app.js, style.css" → "Tried it out". Back-to-back calls of the same kind merge, so a
 * long session reads as a few conceptual chunks. The last phase is worded as ongoing when `running`.
 */
export function workPhases(actions, running = false) {
  const phases = [];
  for (const a of actions) {
    const phase = actionPhase(a.block);
    let last = phases[phases.length - 1];
    if (last?.phase !== phase) phases.push((last = { phase, count: 0, failed: 0, files: [], actions: [] }));
    last.count++;
    last.actions.push(a);
    if (a.result?.is_error) last.failed++;
    const file = describeAction(a.block).object;
    if (file && phase === 'change' && !last.files.includes(file)) last.files.push(file);
  }
  return phases.map((ph, n) => {
    const ongoing = running && n === phases.length - 1;
    return { ...ph, text: phaseText(ph.phase, ph.files.length ? listNames(ph.files) : '', !ongoing), ongoing };
  });
}

/**
 * A tool call in plain words: `text` is a short sentence ("Edited runner.ts"), `kind` groups it for
 * a step's roll-up, and `object` is the file it touched, if any.
 */
export function describeAction(block) {
  const i = block.input || {};
  const name = block.name;
  switch (name) {
    case 'Bash':
      // Claude usually gives each command a plain description ("Run the test suite").
      return { kind: 'run', text: i.description ? capitalize(clip(i.description)) : describeCommand(i.command) };
    case 'Read':
      return { kind: 'read', object: basename(i.file_path), text: `Read ${basename(i.file_path)}` };
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return { kind: 'edit', object: basename(i.file_path ?? i.notebook_path), text: `Edited ${basename(i.file_path ?? i.notebook_path)}` };
    case 'Write':
      return { kind: 'edit', object: basename(i.file_path), text: `Wrote ${basename(i.file_path)}` };
    case 'Grep':
      return { kind: 'search', text: `Searched for “${clip(i.pattern, 50)}”${i.path ? ` in ${basename(i.path)}` : ''}` };
    case 'Glob':
      return { kind: 'search', text: `Looked for files matching ${clip(i.pattern, 50)}` };
    case 'WebFetch':
      return { kind: 'web', text: `Read a page on ${hostname(i.url)}` };
    case 'WebSearch':
      return { kind: 'web', text: `Searched the web for “${clip(i.query, 60)}”` };
    case 'Task':
    case 'Agent':
      return { kind: 'agent', text: `Asked a grunt to ${clip(i.description || i.prompt, 70).replace(/^./, (c) => c.toLowerCase())}` };
    case 'Skill':
      return { kind: 'other', text: `Used the ${i.skill} skill` };
    case 'Workflow':
      return { kind: 'agent', text: 'Ran a multi-agent workflow' };
  }
  if (name.startsWith('mcp__coordinator__')) {
    const arg = [i.ticket_id ? `#${i.ticket_id}` : '', clip(i.title || i.text || '', 70)].filter(Boolean).join(': ');
    const verb = capitalize(name.slice('mcp__coordinator__'.length).replace(/_/g, ' '));
    return { kind: 'tickets', text: arg ? `${verb} ${arg}` : verb };
  }
  if (name.startsWith('mcp__')) {
    const [, server, tool = ''] = name.split('__');
    return { kind: 'other', text: `Used ${tool.replace(/_/g, ' ')} (${server.replace(/_/g, ' ')})` };
  }
  return { kind: 'other', text: `Used ${name}` };
}

/** One-line description of a tool call, e.g. "Edited runner.ts". */
export function actionLabel(block) {
  return describeAction(block).text;
}

function listNames(names) {
  const shown = names.slice(0, 3).join(', ');
  return names.length > 3 ? `${shown} and ${names.length - 3} more` : shown;
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Roll a step's tool calls up into one line, e.g. "Edited runner.ts, app.js · ran 3 commands (1 failed) · read 4 files".
 * `actions` are { block, result } with result null while still running.
 */
export function summarizeActions(actions) {
  const by = {};
  let failed = 0;
  for (const a of actions) {
    const d = describeAction(a.block);
    (by[d.kind] ??= []).push(d);
    if (a.result?.is_error) failed++;
  }
  const parts = [];
  const files = (list) => [...new Set(list.map((d) => d.object).filter(Boolean))];
  if (by.edit) parts.push(`changed ${listNames(files(by.edit))}`);
  if (by.run) parts.push(`ran ${plural(by.run.length, 'command')}`);
  if (by.read) parts.push(`read ${plural(files(by.read).length, 'file')}`);
  if (by.search) parts.push(`searched the code ${by.search.length === 1 ? 'once' : `${by.search.length} times`}`);
  if (by.web) parts.push(`checked ${plural(by.web.length, 'web source')}`);
  if (by.agent) parts.push(`used ${plural(by.agent.length, 'grunt')}`);
  if (by.tickets) parts.push(`${plural(by.tickets.length, 'minion action')}`);
  if (by.other) parts.push(`${plural(by.other.length, 'other step')}`);
  if (!parts.length) return '';
  return capitalize(parts.join(' · ')) + (failed ? ` (${failed} failed)` : '');
}

function resultText(block) {
  const c = block.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((x) => x?.text ?? '').join('\n');
  return '';
}

/** The states that say a minion's work is over (set_thread_status). */
const NOTHING_LEFT = new Set(['complete', 'pending-deploy']);

function allDone(p) {
  return p.tasks.every((t) => t.status === 'completed');
}

/**
 * Apply one stored event. Returns the tool calls in it that count as work, each tagged with the id
 * of the step it belongs to (null when no step was in progress). `at` (the event's time) dates a step's start.
 */
export function applyEvent(p, kind, data, at = null) {
  const actions = [];
  // A turn that died says so, rather than the "Done" of a plan an earlier turn finished.
  if (kind === 'error' && !p.turnOk) p.turnFailed = true;
  if (kind !== 'claude' || !data) return actions;
  // A Grunt's own task list isn't the minion's plan (#571).
  if (data.parent_tool_use_id && data.message?.content?.some?.((b) => b.type === 'tool_use' && TASK_TOOLS.has(b.name))) return actions;
  const lastAt = p.lastAt;
  if (at != null) p.lastAt = at;
  // A turn that finished well wasn't failed by an error on the way (its MCP server not connecting).
  if (data.type === 'result') {
    p.turnOk = !data.is_error;
    if (p.turnOk) p.turnFailed = false;
    p.planMoved = false;
    // A close is the end only once its turn is over: an open card refuses it, and the replay sees no results.
    if (p.closing && !p.asked) finishPlan(p, at);
    for (const t of p.tasks) settle(t, at);
  }

  if (data.type === 'system' && data.subtype === 'init') {
    p.turnFailed = false;
    p.turnOk = false;
    p.turnActions = 0;
    p.lastAction = null;
    p.planMoved = false;
    p.asked = false;
    p.planned = false;
    p.closing = false;
    if (typeof data.model === 'string') p.model = data.model;
    // A plan finished in an earlier turn belongs to that chunk of work, not this one.
    if (p.tasks.length && allDone(p)) p.tasks = [];
    // A step underway counts working time again; a turn that died with no result stopped at its last event.
    // shortcut: replays see no tool results (Store.planEvents), so a call running when a turn was cut off counts
    // only to its start; worth a turn-end time from the turns table if cut-off turns start skewing the ratio.
    for (const t of p.tasks) {
      settle(t, lastAt);
      if (t.status === 'in_progress' && at != null && (!t.kind || t.id === stepLead(p))) t.workFrom = at;
    }
  } else if (data.type === 'assistant') {
    for (const block of data.message?.content ?? []) {
      if (block.type === 'text' && block.text?.trim()) {
        // What Claude said while a step was underway is the best plain summary of that step; a
        // Grunt's report (a subagent's words) is not.
        const task = stepInfo(p, true).current;
        if (task && !data.parent_tool_use_id && sharedSteps(p, task).length < 2) task.note = block.text.trim();
        continue;
      }
      if (block.type !== 'tool_use') continue;
      const input = block.input || {};
      if (block.name === 'TaskCreate' || block.name === 'TaskUpdate' || block.name === 'TodoWrite' || PLAN_TOOLS.has(block.name)) p.planMoved = true;
      if (block.name === 'TaskCreate') {
        p.pendingCreates.set(block.id, input);
      } else if (block.name === 'TaskUpdate') {
        updateTask(
          p,
          p.tasks.findIndex((t) => t.id === String(input.taskId)),
          input,
          at,
        );
      } else if (PLAN_TOOLS.has(block.name)) {
        applyPlan(p, block.id, input, at);
      } else if (block.name === 'TodoWrite' && Array.isArray(input.todos)) {
        // A step the plan still has keeps its id, matched by its words; a new step gets a new one (from this
        // call's id), so an earlier plan's actions and open steps don't land under it.
        const old = [...p.tasks];
        p.tasks = input.todos.map((t, n) => {
          const i = old.findIndex((o) => o.subject === t.content);
          const was = i < 0 ? null : old.splice(i, 1)[0];
          const id = was?.id ?? `todo-${block.id}-${n}`;
          const startedAt = t.status !== 'in_progress' ? undefined : was?.status === 'in_progress' ? was.startedAt : at;
          return { id, subject: t.content, activeForm: t.activeForm, status: t.status, actions: 0, startedAt, work: was?.work ?? 0, workFrom: t.status === 'in_progress' ? (was?.workFrom ?? at) : null };
        });
      } else if (isWorkTool(block.name)) {
        const work = workKind(block, !!data.parent_tool_use_id);
        if (work) sawWork(p, work, at);
        const task = stepInfo(p, true).current;
        if (task) task.actions++;
        p.turnActions++;
        p.lastAction = activityLabel(block);
        actions.push({ block, taskId: task?.id ?? null });
      }
    }
    // The state its reply ends on (runner.ts stripStatus), or the call that sets one: nothing is left to do.
    const calls = (name) => data.message?.content?.find?.((b) => b.type === 'tool_use' && b.name === name);
    if (!data.parent_tool_use_id && calls('mcp__thread__close_self')) p.closing = true;
    if (data.turn_state && !NOTHING_LEFT.has(data.turn_state)) p.closing = false; // another state cancels the close
    if (!data.parent_tool_use_id && (NOTHING_LEFT.has(data.turn_state) || NOTHING_LEFT.has(calls('mcp__thread__set_thread_status')?.input?.state))) finishPlan(p, at);
  } else if (data.type === 'user') {
    for (const block of data.message?.content ?? []) {
      if (block.type !== 'tool_result' || !p.pendingCreates.has(block.tool_use_id)) continue;
      const input = p.pendingCreates.get(block.tool_use_id);
      p.pendingCreates.delete(block.tool_use_id);
      const id = resultText(block).match(/#(\d+)/)?.[1];
      if (block.is_error || !id) continue;
      // A new plan starts once the previous one is finished; old finished steps drop off.
      if (p.tasks.length && allDone(p)) p.tasks = [];
      p.tasks.push({ id, subject: input.subject || `Task ${id}`, activeForm: input.activeForm, description: input.description, status: 'pending', actions: 0, estimate: estimateOf(input) });
    }
  }
  return actions;
}

/** One TaskUpdate (or a plan step put in its shape) on the step at `idx` (none when -1). */
function updateTask(p, idx, input, at) {
  if (idx < 0) return;
  const task = p.tasks[idx];
  if (input.status === 'deleted') p.tasks.splice(idx, 1);
  const est = estimateOf(input);
  if (est) task.estimate = est;
  if (input.status && input.status !== 'deleted') {
    // An update comes from a running turn, so a step's working time starts with it.
    if (input.subject) task.subject = input.subject;
    setStatus(p, task, input.status, at);
  }
  if (input.subject) task.subject = input.subject;
  if (input.activeForm) task.activeForm = input.activeForm;
  if (input.description) task.description = input.description;
  // Claude records what a finished step found or decided as metadata.outcome.
  if (typeof input.metadata?.outcome === 'string') task.outcome = input.metadata.outcome;
}

const PLAN_STATUS = { todo: 'pending', doing: 'in_progress', done: 'completed', dropped: 'deleted' };

/** Why a plan call (#1275) is refused, or '' when it is fine. The tool and the readout share it, so a refused call never moves the readout. */
export function planError(input) {
  const steps = input?.steps;
  if (!Array.isArray(steps) || !steps.length) return 'steps is required: a list of { n, … }, one per step to add or change.';
  for (const s of steps) {
    if (!Number.isInteger(s?.n) || s.n < 1) return 'Each step needs n, its number: 1, 2, 3…';
    const bad = ['step', 'doing', 'why', 'outcome'].find((k) => s[k] != null && typeof s[k] !== 'string');
    if (bad) return `Step ${s.n}: ${bad} is text.`;
    if (s.minutes != null && !(Number.isFinite(s.minutes) && s.minutes >= 0)) return `Step ${s.n}: minutes is a number.`;
    if (s.status != null && !(typeof s.status === 'string' && Object.hasOwn(PLAN_STATUS, s.status))) return `Step ${s.n}: status is todo, doing, done or dropped.`;
    if (s.kind != null && !(typeof s.kind === 'string' && Object.hasOwn(STEP_KINDS, s.kind))) return `Step ${s.n}: kind is read, build, test, review, ask or ship.`;
  }
  return '';
}

/** A plan call (#1275): each step by its number n, added when new, else changed as a TaskUpdate would. */
function applyPlan(p, callId, input, at) {
  if (planError(input)) return;
  // Naming step 1 with a title once the plan is finished starts a new one, its ids new; a late step 4 just adds.
  // A tagged plan's last step may never be ticked (its ship ends the turn), so a later turn's new step 1, with others, starts one too.
  const first = p.tasks.find((t) => (t.n ?? Number(t.id)) === 1);
  // More than half the others restated under their own titles are the same plan, its first step retitled.
  const others = input.steps.filter((o) => o.step && o.n !== 1);
  const same = others.filter((o) => p.tasks.some((t) => (t.n ?? Number(t.id)) === o.n && t.subject === o.step)).length;
  const fresh = (s) => s.n === 1 && s.step && (allDone(p) || (p.at && !p.planned && first && s.step !== first.subject && others.length && same * 2 <= others.length));
  if (p.tasks.length && input.steps.some(fresh)) p.tasks = [];
  if (!p.tasks.some((t) => t.id === p.at)) p.at = null;
  p.planned = true;
  for (const s of input.steps) {
    const update = { status: PLAN_STATUS[s.status], subject: s.step, activeForm: s.doing, description: s.why, metadata: { estimate: s.minutes, outcome: s.outcome } };
    // A step TaskCreate made (id "3") is step 3 too, so a minion that started its plan before #1275 carries it on.
    let idx = p.tasks.findIndex((t) => (t.n ?? Number(t.id)) === s.n);
    if (idx < 0) {
      if (update.status === 'deleted') continue;
      idx = p.tasks.push({ id: `${callId}-${s.n}`, n: s.n, subject: s.step || `Step ${s.n}`, status: 'pending', actions: 0 }) - 1;
    }
    const task = p.tasks[idx];
    if (s.kind) task.kind = s.kind;
    updateTask(p, idx, update, at);
    // The minion's own word wins for its step (#1923): done stays done, doing is where the plan is, todo takes it back.
    if (s.status) Object.assign(task, { own: s.status, seen: s.status !== 'todo' });
    if (s.status === 'doing') {
      for (const t of p.tasks) if (t !== task && t.own === 'doing') t.own = undefined;
      p.side = task.kind ? null : task.id;
      if (task.kind) p.at = task.id;
    }
  }
  const stages = stagesOf(p);
  // The step it took back was the one underway: the plan is on the last one it saw before.
  if (leadOf(stages[stageAt(p, stages)] ?? []) === undefined && p.tasks.find((t) => t.id === p.at)?.own === 'todo') p.at = stages.flat().findLast((t) => t.seen)?.id ?? p.at;
  // A step dropped from under the plan leaves it on the step before; a new plan is on its first step.
  if (stages.length && stageAt(p, stages) < 0) {
    const last = stages.flat().findLast((t) => t.seen);
    p.at = (last ?? stages[0][0]).id;
  }
  // On a step with no kind, the tagged ones stay as they are until their work shows.
  if (stageAt(p, stages) >= 0 && !onSide(p)) goTo(p, stages, stageAt(p, stages), at);
}

/** The kinds whose order can't be read from the calls: work goes round them until a card or a ship. */
const ROUND = new Set(['read', 'build', 'test', 'review']);

/**
 * The plan's tagged steps as the stages the server can tell apart (#1923): steps of one kind side by side are one
 * stage, and a kind that comes back (build, test, build) takes in what's between, since an edit can't say which. Cards
 * and ships start a new round, so a build before a card and one after it stay apart. [[step, …], …] in plan order.
 */
function stagesOf(p) {
  const tagged = p.tasks.filter((t) => t.kind);
  const out = [];
  let round = 0; // where this round starts in `out`
  for (const t of tagged) {
    const same = out.findIndex((st, i) => i >= round && st.some((o) => o.kind === t.kind));
    if (ROUND.has(t.kind)) {
      if (same >= 0) out.splice(same, out.length - same, [...out.slice(same).flat(), t]);
      else out.push([t]);
    } else {
      if (out.at(-1)?.[0].kind === t.kind) out.at(-1).push(t);
      else out.push([t]);
      round = out.length;
    }
  }
  return out;
}

/** The minion is on a step with no kind, which only it can tick. */
const onSide = (p) => p.tasks.some((t) => t.id === p.side && t.status === 'in_progress');

const stageAt = (p, stages = stagesOf(p)) => stages.findIndex((st) => st.some((t) => t.id === p.at));

/**
 * Move the plan by what a tool call shows (#1923). It only ever ticks what it saw worked on: a step passed over with no
 * sign of work stays open, and an unsure call moves nothing, since a wrong tick is worse than a late one.
 */
function sawWork(p, work, at) {
  const stages = stagesOf(p);
  const cur = stageAt(p, stages);
  if (cur < 0) return;
  // A step the minion marked done itself is never gone back to.
  const has = (i, kind) => stages[i].some((t) => t.kind === kind && t.own !== 'done');
  const find = (kind, from, to) => stages.findIndex((st, i) => i >= from && i < to && has(i, kind));
  const any = (kind) => stages.some((st) => st.some((t) => t.kind === kind));
  let kind = work;
  if (work === 'shipcard') kind = find('ask', cur, stages.length) >= 0 || !any('ship') ? 'ask' : 'ship';
  // A plan with no step for its review reviews under its tests.
  // Opening the self-review skill is a review only once something is built, and loosely: an edit after it is still the build.
  const prep = kind === 'prep';
  if (prep) {
    if (any('build') && !stages.some((st) => st.some((t) => t.kind === 'build' && t.seen))) return;
    kind = 'review';
  }
  if (kind === 'review' && !any('review')) kind = 'test';
  if (kind === 'ask') p.asked = true;
  let to = -1;
  const ahead = find(kind, cur + 1, stages.length);
  // The round (between cards and ships) the current stage is in.
  const breaks = (i) => !ROUND.has(stages[i][0].kind);
  let start = cur;
  while (start > 0 && !breaks(start - 1)) start--;
  let end = cur + 1;
  while (end < stages.length && !breaks(end)) end++;
  if (has(cur, kind)) to = cur;
  else if (!ROUND.has(kind)) {
    // Posting a card and shipping show for themselves; one behind only counts while it hasn't been done.
    const behind = stages.findLastIndex((st, i) => i < cur && has(i, kind) && !st.some((t) => t.seen));
    to = ahead >= 0 ? ahead : behind;
  } else if (kind === 'review') to = ahead >= 0 && !breaks(cur) ? ahead : stages.findLastIndex((st, i) => i < cur && has(i, kind) && !st.some((t) => t.seen));
  else if (!breaks(cur)) {
    if (has(cur, 'review') && !(p.prep && kind === 'build'))
      to = -1; // fixing and re-testing what the review found is still the review
    else if (kind === 'build' && find(kind, start, cur) >= 0) to = find(kind, start, cur);
    else if (kind === 'build' || !stages.slice(cur + 1, ahead).some((st) => st.some((t) => ['build', 'review'].includes(t.kind) && !t.seen))) {
      // Past the round is past a card not posted yet: noted, not moved to.
      if (ahead >= 0 && ahead < end) to = ahead;
      else if (ahead >= 0 && kind === 'build') for (const t of stages[ahead]) t.seen = true;
    }
  } else if (kind === 'build') {
    // After a card's answer (a later turn) the next build; a card still out, or a ship that failed, is back on
    // the last one; with none, work goes on beside the card.
    const next = find(kind, cur + 1, stages.length);
    const behind = stages.findLastIndex((st, i) => i < cur && has(i, kind));
    to = has(cur, 'ask') && next >= 0 && (!p.asked || behind < 0) ? next : behind;
  }
  // A card mid-work is a question, not the plan's ask: that comes once what's before it was worked on.
  if (kind === 'ask' && work === 'ask' && stages.slice(cur + 1, to).some((st) => !st.some((t) => t.seen))) to = -1;
  if (to < 0 || (to === cur && onSide(p))) return;
  p.side = null;
  p.closing = false;
  // Newer work than the minion's own word: a step it took back is worked on again.
  if (to !== cur) for (const t of p.tasks) if (t.own === 'doing') t.own = undefined;
  if (to !== cur || stages[to].every((t) => t.own === 'todo' || t.own === 'done')) for (const t of stages[to]) if (t.own === 'todo') t.own = undefined;
  if (!prep || to !== cur) p.prep = prep;
  p.planMoved = true;
  goTo(p, stages, to, at);
}

function goTo(p, stages, to, at) {
  p.at = stages[to][0].id;
  for (const t of stages[to]) if (t.own !== 'todo') t.seen = true;
  arrange(p, stages, at);
}

/** Set the tagged steps' statuses from where the plan is (#1923); a step the minion marked done itself stays done. */
function arrange(p, stages, at) {
  const cur = stageAt(p, stages);
  if (cur < 0) return;
  // What was built stays open under its tests, so an edit after a red run never takes a tick back.
  const testing = stages[cur].some((t) => t.kind === 'test') && !stages[cur].some((t) => t.kind === 'build');
  let from = cur; // the first stage held
  if (testing && cur > 0 && stages[cur - 1].some((t) => t.kind === 'build')) from = cur - 1;
  // Nor does the review skill opened ahead of its reviewer.
  if (p.prep && stages[cur].some((t) => t.kind === 'review')) while (from > 0 && stages[from - 1].some((t) => t.kind === 'build' || t.kind === 'test')) from--;
  const held = (i) => i >= from && i < cur;
  for (const [i, st] of stages.entries()) {
    const open = st.filter((t) => t.own !== 'done' && t.own !== 'todo');
    for (const t of st) if (t.own === 'todo') setStatus(p, t, 'pending', at);
    if (!open.length) continue;
    const lead = leadOf(st);
    if (i < cur && !held(i) && lead.seen) {
      for (const t of open) settle(t, at);
      // A shared stage's time, split by the guesses: the steps' own can't be told apart.
      const work = open.reduce((sum, t) => sum + (t.work ?? 0), 0);
      const guess = open.reduce((sum, t) => sum + (t.estimate ?? 0), 0);
      if (open.some((t) => t.status !== 'completed')) for (const t of open) t.work = work * (guess ? (t.estimate ?? 0) / guess : 1 / open.length);
      for (const t of open) setStatus(p, t, 'completed', at);
    } else if (i === cur || (held(i) && lead.seen)) {
      for (const [n, t] of open.entries()) {
        t.stage = lead.id;
        // The minion named one of them: those after it wait.
        setStatus(p, t, lead.own === 'doing' && n > open.indexOf(lead) ? 'pending' : 'in_progress', at);
        if (held(i) || t !== lead) settle(t, at);
      }
    } else {
      // A review that happened stays ticked when a refused ship sends the work back to build.
      for (const t of open) if (!(t.kind === 'review' && t.status === 'completed')) setStatus(p, t, 'pending', at);
    }
  }
}

/** A step's status, with the times that go with it (#571). One that is back underway keeps its start and the work before. */
function setStatus(p, task, status, at) {
  if (status === 'in_progress' && task.status !== 'in_progress') {
    const back = task.kind && task.startedAt != null;
    Object.assign(task, { startedAt: back ? task.startedAt : at, work: back ? task.work : 0, workFrom: at });
  } else if (status === 'in_progress') task.workFrom ??= at;
  else settle(task, at);
  if (status === 'completed' && task.status === 'in_progress' && task.startedAt != null && at != null) {
    p.finished?.push({ id: task.id, subject: task.subject, estimate: task.estimate ?? null, startedAt: task.startedAt, finishedAt: at, work: task.work ?? 0, model: p.model });
  }
  // The order steps finished in, so the plan's track fills left to right (#630).
  if (status === 'completed' && task.status !== 'completed') task.doneN = p.doneCount = (p.doneCount ?? 0) + 1;
  task.status = status;
}

/** The minion says nothing is left (state complete, close_self): the stage underway, and what it held open, are done. */
function finishPlan(p, at) {
  if (!p.at) return;
  for (const t of p.tasks) if (t.kind && t.status === 'in_progress') setStatus(p, t, 'completed', at);
}

/** Close a step's running share of working time at `at` (#571). */
function settle(task, at) {
  if (task.workFrom == null) return;
  if (at != null) task.work = (task.work ?? 0) + Math.max(0, at - task.workFrom);
  task.workFrom = null;
}

/** A step's guessed minutes (metadata.estimate, #551), from Claude's own tool input: a sane number or nothing. */
function estimateOf(input) {
  const n = Number(input.metadata?.estimate);
  return Number.isFinite(n) && n > 0 && n <= 24 * 60 ? n : undefined;
}

/**
 * The plan's segmented track (#630): [estimate, 'c' | 'i' | 'h' | 'p'] per step ('h': built, held open while it's tested, #1923), the done ones first in the order they
 * finished, then the one underway, then the rest in plan order, so a step added late and done early can't sit
 * green after an unfinished one.
 */
export function planTrack(p) {
  const rank = { completed: 0, in_progress: 1 };
  const state = (t) => (t.status === 'completed' ? 'c' : t.status !== 'in_progress' ? 'p' : heldStep(p, t) ? 'h' : 'i');
  return [...p.tasks].sort((a, b) => (rank[a.status] ?? 2) - (rank[b.status] ?? 2) || (a.status === 'completed' ? (a.doneN ?? 0) - (b.doneN ?? 0) : 0)).map((t) => [t.estimate ?? null, state(t)]);
}

/** A stage's step it is timed and shown under: the one the minion said it is on, else its first still open (#1923). */
const leadOf = (st) => st.find((t) => t.own === 'doing') ?? st.find((t) => t.own !== 'done' && t.own !== 'todo');

/** The lead of the stage underway. */
function stepLead(p) {
  const stages = stagesOf(p);
  return leadOf(stages[stageAt(p, stages)] ?? [])?.id ?? null;
}

/** A step that is built and now being tested (#1923): not ticked yet, as a failed test brings the bar back to it. */
export const heldStep = (p, t) => t.status === 'in_progress' && !!t.kind && t.stage !== stepLead(p);

/**
 * What the plan's guesses (#551) say while its step runs: the step's start and guessed seconds, for the
 * bar, and the minutes left of the plan (what's left of this step's guess plus the steps not started).
 * `ratio` is what steps really took against their guesses (#571, Store.stepRatio), so the guesses are
 * scaled by it. The step's time is its working time: `since` is moved on past the gaps between turns.
 * Null when the step underway has no guess or start. Also the whole plan's start and guessed seconds (#630).
 */
export function planEstimate(p, running, now = Date.now(), ratio = 1) {
  const { current } = stepInfo(p, running);
  const shared = sharedSteps(p, current);
  const guess = shared.length > 1 ? shared.reduce((sum, t) => sum + (t.estimate ?? 0), 0) : current?.estimate;
  if (!guess || !current.startedAt) return null;
  const scale = ratio > 0 ? ratio : 1;
  // Whole seconds, so a scaled guess doesn't round up a minute on float noise (20 × 0.3 = 6.000000000000001).
  const usual = Math.round(guess * 60 * scale);
  const pending = Math.round(p.tasks.filter((t) => t.status === 'pending').reduce((s, t) => s + (t.estimate ?? 0), 0) * 60 * scale);
  // A step from before working time was counted (no work yet) falls back to its wall clock.
  const since = current.work == null ? current.startedAt : (current.workFrom ?? now) - current.work;
  const leftS = Math.max(0, usual - (now - since) / 1000) + pending;
  // The whole plan's working time so far (#630) starts at planSince: the steps done, then this one.
  const doneMs = p.tasks.filter((t) => t.status === 'completed' || (t.kind && t.status === 'in_progress' && !shared.includes(t))).reduce((s, t) => s + (t.work ?? (t.estimate ?? 0) * 60_000 * scale), 0);
  const planSince = since - doneMs;
  return { since, usual, left: Math.ceil(leftS / 60), planSince };
}

/**
 * Counts for the readout: which step is underway out of how many. While a turn runs, a step an earlier
 * turn left underway (a card it waited on) isn't this turn's until the plan moves (#518).
 */
export function stepInfo(p, running = false) {
  const total = p.tasks.length;
  const done = p.tasks.filter((t) => t.status === 'completed').length;
  const lead = stepLead(p);
  const on = onSide(p) ? p.side : lead;
  const at = p.tasks.findIndex((t) => t.id === on && t.status === 'in_progress');
  const currentIdx = running && !p.planMoved ? -1 : at >= 0 ? at : p.tasks.findIndex((t) => t.status === 'in_progress');
  const current = currentIdx >= 0 ? p.tasks[currentIdx] : null;
  return { total, done, current, step: current ? currentIdx + 1 : done };
}

/** The steps of the stage underway: more than one when the server can't tell them apart (#1923). */
const sharedSteps = (p, current) => (current ? p.tasks.filter((t) => t === current || (t.kind && current.kind && t.status === 'in_progress' && t.stage === current.stage && current.own !== 'doing')) : []);

/** What the stage underway is called: its step's own words, or the kinds of a shared stage ("Building, 2 steps", #1923). */
function stageWords(p, current, words) {
  const shared = sharedSteps(p, current);
  if (shared.length < 2) return words;
  const kinds = [...new Set(shared.map((t) => STEP_KINDS[t.kind]))].map((k, i) => (i ? k.toLowerCase() : k));
  return `${kinds.length > 1 ? `${kinds.slice(0, -1).join(', ')} and ${kinds.at(-1)}` : kinds[0]}, ${shared.length} steps`;
}

/**
 * Summary line, e.g. "Running the test suite… · 2 of 7 done". Its one count is steps done, the number
 * the list's badge and the readout's meter show, so no two views read differently (#72, #518).
 */
export function progressLine(p, running) {
  const { total, done, current } = stepInfo(p, running);
  // A finished plan from an earlier turn says nothing about a turn that is running now.
  if (!running && p.turnFailed) return 'Last turn failed: see the error below';
  if (total && !(running && !current && done === total)) {
    const count = `${done} of ${total} done`;
    if (current) return running ? `${stageWords(p, current, current.activeForm || current.subject)}… · ${count}` : `Paused at: ${stageWords(p, current, current.subject)} · ${count}`;
    if (done === total) return `Done · ${total}/${total} steps`;
    return `${!running ? 'Paused' : done ? 'Working' : 'Planning'}…${running && p.lastAction ? ` ${p.lastAction} ·` : ''} ${count}`;
  }
  if (!running) return p.turnActions ? `Finished · ${p.turnActions} action${p.turnActions === 1 ? '' : 's'}` : '';
  return p.lastAction ? `Working… ${p.lastAction}` : 'Working…';
}

/**
 * A progressLine without its count, for a row whose badge already shows steps done. Also strips the
 * older "Running tests… 3/7" form, which stored last_activity may still hold.
 */
export function withoutCount(line) {
  return line.replace(/^(?:Step|(Paused at) step) \d+ of \d+: /, (_, paused) => (paused ? 'Paused at: ' : '')).replace(/(?: · | )\d+(?:\/| of )\d+(?: steps| done)?$/, '');
}

/** How long the readout keeps a finished call's label before saying "Thinking…", so the line doesn't blink between two calls (#543). */
export const THINKING_AFTER = 5000;

/**
 * The readout's running call (#551): the newest call still underway (calls can run side by side), or the
 * last one for a few seconds after it finished, then "Thinking…". `actions` are the turn's
 * { block, result, startedAt, doneAt } in order.
 */
export function nowDoing(actions, now) {
  const last = actions.findLast((a) => !a.result) ?? actions.at(-1);
  return last && (!last.result || !(now - last.doneAt >= THINKING_AFTER)) ? actionLabel(last.block) : 'Thinking…';
}

/** How long the readout's running call has run, once it is a minute or more ("5 min", #1923). */
export function runningFor(actions, now) {
  const last = actions.findLast((a) => !a.result);
  const min = last ? Math.floor((now - last.startedAt) / 60_000) : 0;
  return min > 0 ? `${min} min` : '';
}

/**
 * The step side of a running turn's readout line ("Fixing the double alert"), beside the running call,
 * so it leaves out the last action progressLine adds: "Planning" before a step starts, else "Working".
 */
export function stepName(p, running) {
  const { total, done, current } = stepInfo(p, running);
  return current ? stageWords(p, current, current.activeForm || current.subject).replace(/…$/, '') : total && !done ? 'Planning' : 'Working';
}
