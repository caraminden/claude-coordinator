// Work-progress tracking shared by the server (board summaries) and the browser (ticket readout).
// Replays a ticket's stored events to rebuild Claude's task list (TaskCreate/TaskUpdate, or
// TodoWrite) and to sort every other tool call under the step that was in progress when it ran.

/** Tools that manage the task list itself; they are progress, not work, so they are never shown as actions. */
export const TASK_TOOLS = new Set(['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'TodoWrite']);
/** Housekeeping tools (loading other tools' schemas) that are not shown as actions either. */
const HIDDEN_TOOLS = new Set(['ToolSearch']);

/** Whether a tool call is real work to show, rather than plan bookkeeping or housekeeping. */
export const isWorkTool = (name) => !TASK_TOOLS.has(name) && !HIDDEN_TOOLS.has(name);

export function createProgress() {
  return {
    tasks: [], // { id, subject, activeForm, description, outcome, note, status: 'pending' | 'in_progress' | 'completed', actions }
    pendingCreates: new Map(), // tool_use_id -> TaskCreate input, until its result tells us the task id
    turnActions: 0,
    lastAction: null,
  };
}

const basename = (path) => String(path ?? '').split('/').filter(Boolean).pop() || String(path ?? '');

function clip(text, max = 90) {
  const line = String(text ?? '').trim().split('\n')[0].trim();
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
  status: 'Checked what changed', diff: 'Looked at code changes', log: 'Looked at commit history', show: 'Looked at a commit',
  add: 'Staged changes', commit: 'Committed changes', merge: 'Merged branches', rebase: 'Rebased the branch',
  push: 'Pushed to the remote', pull: 'Pulled from the remote', fetch: 'Fetched from the remote', checkout: 'Switched branches',
  switch: 'Switched branches', branch: 'Looked at branches', stash: 'Stashed changes', clone: 'Cloned a repo',
  worktree: 'Managed worktrees', reset: 'Reset changes', restore: 'Restored files', 'ls-files': 'Listed tracked files',
  grep: 'Searched the code', blame: 'Looked at who changed what', remote: 'Looked at remotes', 'rev-parse': 'Looked up a commit',
};

const TEST_RE = /^(npm|pnpm|yarn|bun) (run )?test|^(pytest|jest|vitest|go test|cargo test|make test|node --test)/;

/** A raw shell command in words, for when Claude gave it no description. Null if nothing fits. */
function describeOne(cmd) {
  let c = cmd.trim().replace(/^(sudo|timeout \S+|env|time|nice|setsid)\s+/g, '').replace(/^(\w+=\S*\s+)+/, '');
  const [prog, ...rest] = c.split(/\s+/);
  const args = rest.filter((a) => !a.startsWith('-'));
  const file = args.find((a) => /[./]/.test(a) && !/[|<>$]/.test(a));
  if (!prog || prog === 'cd' || prog === 'true' || prog === 'echo' && /^echo\s*$/.test(c)) return null;
  if (TEST_RE.test(c)) return 'Ran the tests';
  if (prog === 'git') return GIT_WORDS[args[0]] ?? `Ran git ${args[0] ?? ''}`.trim();
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
  if (/^(cat|head|tail|less|bat)$/.test(prog) || prog === 'sed' && rest.includes('-n')) return file ? `Looked at ${basename(file)}` : 'Looked at a file';
  if (prog === 'sed' || prog === 'perl' && rest.includes('-i')) return file ? `Edited ${basename(file)}` : 'Edited a file';
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
    const verb = words?.match(/^(Looked at|Edited|Ran) (\S+\.\w+)$/);
    const prev = verb && parts.findIndex((t) => t.startsWith(`${verb[1]} `) && /\.\w+$/.test(t));
    if (verb && prev >= 0) parts[prev] = `${parts[prev].replace(' and ', ', ')} and ${verb[2]}`;
    else if (words && !parts.includes(words)) parts.push(words);
    if (/<<\s*'?(\w+)/.test(seg)) break; // a heredoc body follows; it is not more commands
  }
  if (!parts.length) return `Ran \`${clip(command, 60)}\``;
  // Filler like `echo done` only matters when it is all the command did.
  const filler = ['Printed some text', 'Waited', 'Listed files'];
  if (parts.some((t) => !filler.includes(t))) parts.splice(0, parts.length, ...parts.filter((t) => !filler.includes(t)));
  const shown = parts.slice(0, 2).map((t, n) => (n ? t.charAt(0).toLowerCase() + t.slice(1) : t)).join(', ');
  return parts.length > 2 ? `${shown} and more` : shown;
}

/**
 * What kind of work a shell command is, as a phase of the job: looking around, changing things,
 * checking they work, or saving them to git. Uses the command itself, then Claude's description.
 */
function commandPhase(command, description = '') {
  const c = String(command ?? '');
  if (/\bgit (commit|merge|push|pull|rebase|cherry-pick)\b|\bgh pr\b/.test(c)) return 'save';
  if (/\bsed -i|\bperl -i|\.write\(|writeFile|\bgit (add|checkout|restore|stash)\b|\b(mv|cp|rm|mkdir|touch|ln)\s|(^|[^2&])>\s*[\w./~-]+\.\w+|\b(npm|pnpm|yarn|pip3?|uv) (i|install|add)\b/.test(c)) return 'change';
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
  Read: 'explore', Grep: 'explore', Glob: 'explore', LS: 'explore',
  Edit: 'change', MultiEdit: 'change', NotebookEdit: 'change', Write: 'change',
  WebFetch: 'research', WebSearch: 'research', Task: 'delegate', Agent: 'delegate', Workflow: 'delegate',
};

/** Which phase of the work a tool call belongs to (see PHASES). */
export function actionPhase(block) {
  const i = block.input || {};
  if (block.name === 'Bash') return commandPhase(i.command, i.description);
  if (block.name.startsWith('mcp__coordinator__')) return 'coordinate';
  return TOOL_PHASE[block.name] ?? 'other';
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

function allDone(p) {
  return p.tasks.every((t) => t.status === 'completed');
}

/**
 * Apply one stored event. Returns the tool calls in it that count as work, each tagged with the id
 * of the step it belongs to (null when no step was in progress).
 */
export function applyEvent(p, kind, data) {
  const actions = [];
  if (kind !== 'claude' || !data) return actions;

  if (data.type === 'system' && data.subtype === 'init') {
    p.turnActions = 0;
    p.lastAction = null;
    // A plan finished in an earlier turn belongs to that chunk of work, not this one.
    if (p.tasks.length && allDone(p)) p.tasks = [];
  } else if (data.type === 'assistant') {
    for (const block of data.message?.content ?? []) {
      if (block.type === 'text' && block.text?.trim()) {
        // What Claude said while a step was underway is the best plain summary of that step; a
        // Grunt's report (a subagent's words) is not.
        const task = !data.parent_tool_use_id && p.tasks.find((t) => t.status === 'in_progress');
        if (task) task.note = block.text.trim();
        continue;
      }
      if (block.type !== 'tool_use') continue;
      const input = block.input || {};
      if (block.name === 'TaskCreate') {
        p.pendingCreates.set(block.id, input);
      } else if (block.name === 'TaskUpdate') {
        const idx = p.tasks.findIndex((t) => t.id === String(input.taskId));
        if (idx < 0) continue;
        const task = p.tasks[idx];
        if (input.status === 'deleted') p.tasks.splice(idx, 1);
        else if (input.status) task.status = input.status;
        if (input.subject) task.subject = input.subject;
        if (input.activeForm) task.activeForm = input.activeForm;
        if (input.description) task.description = input.description;
        // Claude records what a finished step found or decided as metadata.outcome.
        if (typeof input.metadata?.outcome === 'string') task.outcome = input.metadata.outcome;
      } else if (block.name === 'TodoWrite' && Array.isArray(input.todos)) {
        p.tasks = input.todos.map((t, n) => ({
          id: `todo-${n}`, subject: t.content, activeForm: t.activeForm, status: t.status, actions: 0,
        }));
      } else if (isWorkTool(block.name)) {
        const task = p.tasks.find((t) => t.status === 'in_progress');
        if (task) task.actions++;
        p.turnActions++;
        p.lastAction = activityLabel(block);
        actions.push({ block, taskId: task?.id ?? null });
      }
    }
  } else if (data.type === 'user') {
    for (const block of data.message?.content ?? []) {
      if (block.type !== 'tool_result' || !p.pendingCreates.has(block.tool_use_id)) continue;
      const input = p.pendingCreates.get(block.tool_use_id);
      p.pendingCreates.delete(block.tool_use_id);
      const id = resultText(block).match(/#(\d+)/)?.[1];
      if (block.is_error || !id) continue;
      // A new plan starts once the previous one is finished; old finished steps drop off.
      if (p.tasks.length && allDone(p)) p.tasks = [];
      p.tasks.push({ id, subject: input.subject || `Task ${id}`, activeForm: input.activeForm, description: input.description, status: 'pending', actions: 0 });
    }
  }
  return actions;
}

/** Counts for the readout: which step is underway out of how many. */
export function stepInfo(p) {
  const total = p.tasks.length;
  const done = p.tasks.filter((t) => t.status === 'completed').length;
  const currentIdx = p.tasks.findIndex((t) => t.status === 'in_progress');
  const current = currentIdx >= 0 ? p.tasks[currentIdx] : null;
  return { total, done, current, step: current ? currentIdx + 1 : done };
}

/**
 * Summary line, e.g. "Step 3 of 7: Running the test suite…". Every count is worded ("step 3 of 7",
 * "2 of 7 done"), so it can't be read as the steps-done badge some views show beside it.
 */
export function progressLine(p, running) {
  const { total, done, current, step } = stepInfo(p);
  // A finished plan from an earlier turn says nothing about a turn that is running now.
  if (total && !(running && !current && done === total)) {
    if (current) return running ? `Step ${step} of ${total}: ${current.activeForm || current.subject}…` : `Paused at step ${step} of ${total}: ${current.subject}`;
    if (done === total) return `Done · ${total}/${total} steps`;
    return `${!running ? 'Paused' : done ? 'Working' : 'Planning'}… ${done} of ${total} done`;
  }
  if (!running) return p.turnActions ? `Finished · ${p.turnActions} action${p.turnActions === 1 ? '' : 's'}` : '';
  return p.lastAction ? `Working… ${p.lastAction}` : 'Working…';
}

/**
 * A progressLine without its count, for a row whose badge already shows steps done. Also strips the
 * older "Running tests… 3/7" form, which stored last_activity may still hold.
 */
export function withoutCount(line) {
  return line
    .replace(/^(?:Step|(Paused at) step) \d+ of \d+: /, (_, paused) => (paused ? 'Paused at: ' : ''))
    .replace(/(?: · | )\d+(?:\/| of )\d+(?: steps| done)?$/, '');
}
