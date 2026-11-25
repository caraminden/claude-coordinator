// The progress readout under a chat's head: the step line, its meter and the plan's steps. The pure half is progress.js.
import { api, dismissedWhen, h, isCoordinator, statusLabel, view } from './base.js';
import { threadRefs, usage } from './core.js';
import { jobOf, rowState, workingBy } from './threadstate.js';
import { progressTrack, waitClock, waitLate, waitNow, waitTrack } from './wait.js';
import { waitTail } from './wait-tail.js';
import { EMPTY_TRACK } from './threadstate.js';
import { stepMark } from './ui/chat.js';
import { firstSentence, ticketActionRef } from './chattext.js';
import { actionCut } from './eventcut.js';
import { failedLine, loadingLine } from './ui/state.js';
import { drawTimeLog, readLog, timeLogPanel } from './time-log-ui.js';
import { actionLabel, heldStep, nowDoing, planEstimate, planTrack, progressLine, runningFor, stepInfo, stepName, withoutCount, workPhases } from './progress.js';

// ---------- work progress (thread-bar readout) ----------

const STEP_ICON = { completed: '✓', in_progress: '◐', pending: '○' };

function resultString(result) {
  return typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
}

/**
 * One tool call as a plain sentence ("Edited runner.ts", "Run the tests — failed: …"). The raw
 * command and output sit one click deeper and are only built when opened.
 */
function actionEl(action, key) {
  const { block, result } = action;
  const okey = key && block.id ? `${key}|${block.id}` : null;
  const state = !result ? 'pending' : result.is_error ? 'err' : 'ok';
  const why =
    state === 'err'
      ? resultString(result)
          .replace(/<\/?tool_use_error>/g, '')
          .trim()
          .split('\n')[0]
          .slice(0, 120)
      : '';
  const el = h(
    'details',
    { class: `act ${state}`, open: (okey && view.ui.actsOpen.has(okey)) || null },
    h('summary', {}, stepMark({ pending: 'running', err: 'failed', ok: 'done' }[state]), h('span', { class: 'what' }, threadRefs(actionLabel(block))), why ? h('span', { class: 'why' }, ` — failed: ${why}`) : '', ticketActionRef(action) ? [' → ', ...threadRefs(`#${ticketActionRef(action).number}`)] : ''),
  );
  const build = () => {
    if (!el.open || el.querySelector('.body')) return;
    const body = h('div', { class: 'body' });
    el.append(body);
    if (actionCut(action)) fullAction(body, action);
    else actionBody(body, action);
  };
  el.addEventListener('toggle', () => {
    // Kept per action, so a redraw on the next event leaves it open (T2).
    if (okey) el.open ? view.ui.actsOpen.add(okey) : view.ui.actsOpen.delete(okey);
    build();
  });
  build();
  return el;
}

/** An opened action's input and result, with a status line under them while some of it is still cut. */
function actionBody(body, action, status = null) {
  const { block, result } = action;
  const input = block.input || {};
  body.replaceChildren(h('pre', {}, block.name === 'Bash' && input.command ? `$ ${input.command}` : JSON.stringify(input, null, 2)));
  if (result) body.append(h('pre', { class: result.is_error ? 'err' : '' }, threadRefs(resultString(result) || '(no output)')));
  if (status) body.append(status);
}

/**
 * The page sent this action's input or result cut (eventcut.js): show the beginning at once and fetch the events
 * whole. A failed fetch leaves the beginning with a retry, never an empty row.
 */
async function fullAction(body, action) {
  const { block, result } = action;
  actionBody(body, action, loadingLine('Loading the rest…'));
  try {
    const from = [block.cut && action.event, result?.cut && result.event].filter(Boolean);
    const rows = await Promise.all(from.map((e) => api(`api/tickets/${e.ticket}/events/${e.id}`)));
    for (const row of rows) {
      for (const b of JSON.parse(row.data).message?.content ?? []) {
        if (b?.type === 'tool_use' && b.id === block.id) Object.assign(block, { input: b.input, cut: undefined });
        if (b?.type === 'tool_result' && b.tool_use_id === block.id && result) Object.assign(result, { content: b.content, cut: undefined });
      }
    }
    if (actionCut(action)) throw new Error('it was not in its event');
    actionBody(body, action);
  } catch (err) {
    actionBody(body, action, failedLine(`Showing the beginning: couldn't load the rest (${err.message}).`, { retry: () => fullAction(body, action) }));
  }
}

/** "Created #15 · Messaged #12": links to the threads some work created or messaged, or null. */
function ticketActionLinks(acts) {
  const refs = acts.map(ticketActionRef).filter(Boolean);
  if (!refs.length) return null;
  return h(
    'li',
    { class: 'thread-refs' },
    h('span', { class: 'st' }, '→'),
    refs.flatMap((r, i) => [i ? ' · ' : '', `${r.verb} `, ...threadRefs(`#${r.number}`)]),
  );
}

/** Claude's own words from while a step was underway, shortened to a couple of lines. */
function stepNote(text) {
  const short = text.length > 280 ? `${text.slice(0, 279).replace(/\s+\S*$/, '')}…` : text;
  return h('p', { class: 'step-note' }, short.replace(/[*`#]/g, ''));
}

function actionList(actions, key) {
  return h(
    'div',
    { class: 'actions' },
    actions.map((a) => actionEl(a, key)),
  );
}

/** Which parts of a ticket's readout are expanded; kept per ticket so re-renders and reconnects don't collapse it. */
const progressUiState = new Map();
export function progressUi(ticketId) {
  if (!progressUiState.has(ticketId)) progressUiState.set(ticketId, { open: false, openSteps: new Set(), cmdsOpen: new Set(), actsOpen: new Set() });
  return progressUiState.get(ticketId);
}

/** The phases of some work as rows ("✓ Looked through the code · 4 actions"), plus its commands behind a toggle. */
export function phaseRows(acts, running, key = null) {
  const phases = workPhases(acts, running);
  const cmds = h('details', { class: 'cmds', open: (key && view.ui.cmdsOpen.has(key)) || null }, h('summary', {}, `Show the ${acts.length} individual action${acts.length === 1 ? '' : 's'}`));
  const fill = () => {
    if (cmds.open && !cmds.querySelector('.actions')) cmds.append(actionList(acts, key));
  };
  // Only the readout's own rows pass a key; the turn-end rows share this and are rebuilt closed.
  cmds.addEventListener('toggle', () => {
    if (key) cmds.open ? view.ui.cmdsOpen.add(key) : view.ui.cmdsOpen.delete(key);
    fill();
  });
  fill();
  return [
    h(
      'ul',
      { class: 'phases' },
      phases.map((ph) => h('li', { class: ph.ongoing ? 'ongoing' : '' }, stepMark(ph.ongoing ? 'running' : 'done'), ph.text, h('span', { class: 'muted' }, ` · ${ph.count} action${ph.count === 1 ? '' : 's'}${ph.failed ? `, ${ph.failed} failed along the way` : ''}`))),
      ticketActionLinks(acts),
    ),
    cmds,
  ];
}

/** One step of Claude's plan: its title, one plain line about it, and on opening, how the work went. `held`: built, and being tested (#1923). */
function planStep(t, acts, running, held) {
  const now = t.status === 'in_progress';
  const live = now && running;
  const phases = workPhases(acts, live);
  // The one line: what it achieved once done, where it's at while underway, what it's for before then.
  let line;
  if (t.status === 'completed') line = t.outcome || (t.note && firstSentence(t.note)) || t.description || phases.map((ph) => ph.text).join(', ');
  else if (held) line = 'Done so far, kept open in case a test sends it back';
  else if (now && t.kind && t.stage !== t.id) line = 'Under way together with the step above';
  else if (now) line = live ? (phases.length ? `Now: ${phases[phases.length - 1].text.toLowerCase()}` : 'Just started') : 'Paused here when the turn ended';
  else line = t.description || 'Not started yet';
  const el = h(
    'details',
    { class: `step ${t.status}${now && !running ? ' paused' : ''}${held ? ' held' : ''}`, open: view.ui.openSteps.has(t.id) || null },
    h('summary', {}, h('span', { class: 'icon' }, STEP_ICON[t.status] ?? '○'), h('span', { class: 'subject' }, t.subject), h('span', { class: 'recap' }, firstSentence(line, 220))),
    t.description && line !== t.description ? h('p', { class: 'step-desc' }, h('span', { class: 'muted' }, 'Plan: '), t.description) : '',
    t.note && !t.outcome ? stepNote(t.note) : '',
    acts.length ? phaseRows(acts, live, `step${t.id}`) : '',
  );
  el.addEventListener('toggle', () => (el.open ? view.ui.openSteps.add(t.id) : view.ui.openSteps.delete(t.id)));
  return el;
}

/** Work done outside any plan step, told as phases. */
function looseWork(acts, running, onlyWork) {
  const phases = workPhases(acts, running);
  const el = h(
    'details',
    { class: 'step loose', open: (view.ui.looseOpen ?? onlyWork) || null },
    h('summary', {}, h('span', { class: 'icon' }, '⋯'), h('span', { class: 'subject' }, !onlyWork ? 'Other work this turn' : running ? 'Work so far' : 'Work last turn'), h('span', { class: 'recap' }, phases.map((ph) => ph.text).join(' → '))),
    view.turnNote ? stepNote(view.turnNote) : '',
    phaseRows(acts, running, onlyWork ? 'loose-work' : 'loose-other'),
  );
  el.addEventListener('toggle', () => (view.ui.looseOpen = el.open));
  return el;
}

let progressFrame = 0;
export function scheduleProgress() {
  if (!progressFrame)
    progressFrame = requestAnimationFrame(() => {
      progressFrame = 0;
      renderProgress();
    });
}

export function renderProgress() {
  if (view?.kind !== 'project' || !view.ticket) return;
  const p = view.progress;
  const progressEl = view.progressEl;
  // A new minion not parked on start_after reads as working while its first turn sets up, as its list row does (#696);
  // a Taskmaster that hasn't run yet is only waiting for a message.
  const running = (view.ticket.status === 'running' && !view.ticket.worker_wait) || (view.ticket.status === 'new' && !view.ticket.parked_for && !view.ticket.start_hold && view.ticket.state !== 'parked' && !isCoordinator(view.ticket));
  // A minion that has ever worked always has its line, the way into its time log (Josh, 2026-11-25: "Always show the line").
  const line = progressLine(p, running, view.sawInit && !isCoordinator(view.ticket));
  // One line (#551, Josh's pick): the step › what's happening now · steps done · time. While it waits on
  // something (#544: the land line, a heavy slot, the restart), the wait takes the "now" part and its time,
  // and its bar replaces the meter. A wait shows after the turn has ended too (outside, pending-deploy).
  const w = view.ticket.status !== 'closed' && view.ticket.wait;
  if (!line && !w) {
    progressEl.replaceChildren();
    progressEl.hidden = true;
    return;
  }
  const live = running && initSeen();
  const { total, done, current } = stepInfo(p, running);
  const planned = total && (current || done < total);
  const stripped = withoutCount(line);
  // Phones show this line in place of the state (#492), so an idle chat's line leads with it (and a bare "Finished" adds nothing to it).
  // The server working for it (#727) leads the line in place of the finished plan's step: "Server" and its land stage.
  const server = !running && workingBy(view.ticket) === 'server' && !jobOf(view.ticket);
  const step = server || !line ? '' : view.ticket.worker_wait ? 'Working' : live ? stepName(p, running) : narrow.matches && !running ? (stripped === 'Finished' ? headState(view.ticket) : `${headState(view.ticket)} · ${stripped}`) : stripped;
  const doing = !w && live ? nowDoing(view.turnActions, Date.now()) : '';
  const now = w ? waitNow(w) : doing;
  // The step count sits in its own chip, so a phone's cut-off text never hides it; the turn's action
  // count shows only when no plan is underway.
  const count = stripped !== line ? `${done}/${total}` : !planned && live && p.turnActions ? `${p.turnActions} action${p.turnActions === 1 ? '' : 's'}` : '';
  // The minion's own guesses for its steps (#551, Josh's pick). Only while no wait has a real estimate of its own.
  const est = !w && live ? planEstimate(p, running, Date.now(), view.ticket.step_ratio) : null;
  // The turn's clock is neither the step's time nor the plan's, so it gives way to the captions under the bar (#630).
  const time = w ? waitClock(w, 'time wait-time of-wait') : running && !est && view.ticket.turnStartedAt ? waitClock({ since: view.ticket.turnStartedAt }, 'time wait-time') : '';
  const left = est && h('span', { class: 'left', title: view.ticket.step_ratio && view.ticket.step_ratio !== 1 ? `The minion's guesses for the steps left, times ${view.ticket.step_ratio.toFixed(2)}: what steps have really taken against their guesses` : "The minion's own guess for the steps left" }, leftText(est));

  const bar = h(
    'button',
    {
      class: 'progress-line',
      'aria-expanded': String(view.ui.open),
      onclick: () => {
        view.ui.open = !view.ui.open;
        renderProgress();
      },
      // Read ahead, so the click shows the log at once. A Taskmaster's chat never ends, so it has none.
      onpointerenter: () => isCoordinator(view.ticket) || readLog(),
      onfocus: () => isCoordinator(view.ticket) || readLog(),
      onpointerdown: () => isCoordinator(view.ticket) || readLog(),
    },
    // No dot of its own: the title's dot just above says the same (Josh, 2026-11-13: "we've duplicated the dots").
    h(
      'span',
      { class: 'text' },
      server ? h('span', { class: 'stepname' }, h('b', { class: 'f-work' }, 'Server'), w ? '' : ' · shipping…') : step ? h('span', { class: 'stepname' }, step) : '',
      (step || server) && now ? h('span', { class: 'arrow', 'aria-hidden': 'true' }, ' › ') : '',
      now ? h('span', { class: 'doing', 'data-doing': doing }, now) : '',
    ),
    // Beside the words, not in them, so a phone's cut-off line still shows it.
    h('span', { class: 'ran' }, doing ? runningFor(view.turnActions, Date.now()) : ''),
    count ? h('span', { class: 'count', title: count.includes('/') ? `${done} of ${total} steps done` : '' }, count) : '',
    time,
    h('span', { class: 'chev' }, view.ui.open ? '▴' : '▾'),
  );
  // With no plan the meter keeps its room, hidden, so a plan arriving doesn't push the chat (rule 13); while it works, an
  // empty track shows the line before the plan exists (#696).
  // The plan as a track of its steps (#630), the one underway filling against its guess or by the wait; with no step
  // underway, a landing's stages or the wait's bar; after the turn, a wait drops the plan (as the list row's rowBar does).
  const meter = progressTrack({ track: total && (running || !w) ? planTrack(p) : running && !w ? EMPTY_TRACK : null, since: est?.since, usual: est?.usual, wait: w || null }, 'big') || h('progress', { class: 'meter blank', max: 1, value: 0 });
  // Which time is which (#630, Cara's pick "1"): the step's against its guess under the bar's left, the whole plan's at its end.
  const stepClock = est && waitClock({ since: est.since, usual: est.usual }, `wait-time${waitLate(est) ? ' late' : ''}`);
  const caption = est
    ? h('div', { class: 'progress-cap' }, h('span', { class: 'cap-step' }, 'This step: ', stepClock), h('span', { class: 'cap-plan' }, h('b', {}, h('span', { class: 'wide' }, 'Whole plan:'), h('span', { class: 'narrow' }, 'Plan')), ' ', h('span', { class: 'wide' }, waitClock({ since: est.planSince }), ' in · '), left))
    : // Until a step with a guess is underway, its caption's line is held empty, so the head doesn't grow when it starts (#696).
      running && !w
      ? h('div', { class: 'progress-cap blank', 'aria-hidden': 'true' }, h('span', { class: 'cap-step' }, '\u00a0'))
      : '';

  const prevDetail = progressEl.querySelector('.progress-detail');
  const scrollTop = prevDetail?.scrollTop ?? 0;
  // The wait in full, its words uncut, with a landing's whole track above it.
  const waitLine = w ? h('div', { class: 'wait-line' }, waitTrack(w), h('p', { class: 'wait-full' }, waitNow(w, true), ' · ', waitClock(w))) : '';
  const req = view.turnRequest;
  const request = req?.length
    ? h(
        'p',
        { class: 'request' },
        h('span', { class: 'muted' }, running ? 'Working on ' : 'Last worked on '),
        req.flatMap((m, n) => [n ? ' and ' : '', `${m.author}'s request: `, h('q', {}, firstSentence(m.text, 160))]),
      )
    : '';
  if (view.ui.open && !isCoordinator(view.ticket)) {
    // The log's element stays where it is, so a redraw takes no focus, scroll or half-made click from it.
    const log = timeLogPanel();
    const detail = log.parentElement === prevDetail && prevDetail ? prevDetail : h('div', { class: 'progress-detail timed' }, log);
    for (const c of [...detail.children]) if (c !== log) c.remove();
    detail.prepend(...[waitLine, request].filter(Boolean));
    for (const c of [...progressEl.children]) if (c !== detail) c.remove();
    progressEl.prepend(...[bar, meter, caption, w ? waitTail(view.ticket.id, w) : ''].filter(Boolean));
    if (detail.parentElement !== progressEl) progressEl.append(detail);
    progressEl.hidden = false;
    drawTimeLog();
    return;
  }
  let detail = '';
  if (view.ui.open) {
    const all = [...view.actions.values()];
    const groups = { completed: [], in_progress: [], pending: [] };
    for (const t of p.tasks) (groups[t.status] ?? groups.pending).push(t);
    // A step an earlier turn left underway reads as paused until this turn moves the plan.
    const stepEl = (t) =>
      planStep(
        t,
        // A shared stage's calls are kept under its first step.
        all.filter((a) => a.taskId === t.id),
        running && !!current,
        heldStep(p, t),
      );
    const section = (title, tasks) => (tasks.length ? h('section', { class: 'plan-group' }, h('h4', {}, title), tasks.map(stepEl)) : '');
    const loose = view.turnActions.filter((a) => a.taskId == null || !p.tasks.some((t) => t.id === a.taskId));
    detail = h(
      'div',
      { class: 'progress-detail' },
      waitLine,
      request,
      section('Done', groups.completed),
      section(running && current ? 'Now' : 'Stopped at', groups.in_progress),
      section('Up next', groups.pending),
      loose.length ? looseWork(loose, running, !p.tasks.length) : '',
      !p.tasks.length && !loose.length ? h('p', { class: 'muted empty' }, 'Nothing has run yet.') : '',
    );
  }
  progressEl.replaceChildren(bar, meter, caption, w ? waitTail(view.ticket.id, w) : '', detail);
  if (detail) detail.scrollTop = scrollTop;
  progressEl.hidden = false;
}

/** "~26 min left" of the plan's guesses, "~1h 5m left", or past them. */
export function leftText(est) {
  return est.left ? `~${est.left >= 60 ? `${Math.floor(est.left / 60)}h ${est.left % 60}m` : `${est.left} min`} left` : 'past its guess';
}

/** A chat's state in words, as its head shows it. */
export function headState(t) {
  const label = isCoordinator(t) && !workingBy(t) ? statusLabel(t) : rowState(t, usage).label;
  // A dismissed minion says when (#1072).
  const when = label === 'Dismissed' ? dismissedWhen(t.closed_at) : null;
  return (when ? `Dismissed ${when.short}` : label) + (t.asleep && t.status !== 'closed' ? ' · asleep' : '') + (t.queued ? ` · ${t.queued} queued` : '');
}

/** Whether the running turn's init event has arrived: until then the per-turn state is still the last turn's. */
export function initSeen() {
  return !view.ticket.worker_wait && view.turnInitAt >= view.ticket.turnStartedAt;
}

export const narrow = matchMedia('(max-width: 800px)');
