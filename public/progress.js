// Work-progress tracking shared by the server (board summaries) and the browser (ticket readout).
// Replays a ticket's stored events to rebuild Claude's task list (TaskCreate/TaskUpdate, or
// TodoWrite) and to sort every other tool call under the step that was in progress when it ran.

/** Tools that manage the task list itself; they are progress, not work, so they are never shown as actions. */
export const TASK_TOOLS = new Set(['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'TodoWrite']);
/** Housekeeping tools (loading other tools' schemas) that are not shown as actions either. */
const HIDDEN_TOOLS = new Set(['ToolSearch']);

export function createProgress() {
  return {
    tasks: [], // { id, subject, activeForm, status: 'pending' | 'in_progress' | 'completed', actions }
    pendingCreates: new Map(), // tool_use_id -> TaskCreate input, until its result tells us the task id
    turnActions: 0,
    lastAction: null,
  };
}

/** One-line description of a tool call, e.g. "Bash: Run the tests". */
export function actionLabel(block) {
  const i = block.input || {};
  const arg = (block.name === 'Bash' && i.description) || i.command || i.file_path || i.path || i.pattern || i.url || i.query || i.description || i.prompt || '';
  const first = String(arg).split('\n')[0].slice(0, 140);
  return first ? `${block.name}: ${first}` : block.name;
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
  } else if (data.type === 'assistant') {
    for (const block of data.message?.content ?? []) {
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
      } else if (block.name === 'TodoWrite' && Array.isArray(input.todos)) {
        p.tasks = input.todos.map((t, n) => ({
          id: `todo-${n}`, subject: t.content, activeForm: t.activeForm, status: t.status, actions: 0,
        }));
      } else if (!TASK_TOOLS.has(block.name) && !HIDDEN_TOOLS.has(block.name)) {
        const task = p.tasks.find((t) => t.status === 'in_progress');
        if (task) task.actions++;
        p.turnActions++;
        p.lastAction = actionLabel(block);
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
      p.tasks.push({ id, subject: input.subject || `Task ${id}`, activeForm: input.activeForm, status: 'pending', actions: 0 });
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

/** Summary line, e.g. "Running the test suite… 3/7". */
export function progressLine(p, running) {
  const { total, done, current, step } = stepInfo(p);
  if (total) {
    if (current) return `${current.activeForm || current.subject}… ${step}/${total}`;
    if (done === total) return `Done · ${total}/${total} steps`;
    return `${!running ? 'Paused' : done ? 'Working' : 'Planning'}… ${done}/${total}`;
  }
  if (!running) return p.turnActions ? `Finished · ${p.turnActions} action${p.turnActions === 1 ? '' : 's'}` : '';
  return p.lastAction ? `Working… ${p.lastAction}` : 'Working…';
}
