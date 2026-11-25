// GPU jobs on a person's machine (#859): the live job card in a minion's chat and on the Machines page, and the go
// card's recipe. Design: shared/project/specs/desktop-gpu-jobs.md. Cara's picks (2026-11-17, the choices page
// mockups/desktop-gpu-jobs/gpu-jobs-views-takes.html): the card follows the bottom of the chat, its log shows
// nothing until opened, and the Machines page lists jobs as compact rows that open into the card, with a progress
// bar on the running one. The server's routes are in src/routes/jobs.ts; live views come as `machine_job` events.
import { account, api, formatSize, h, sharedHref, pacificClock, pacificStamp, pacificZone, pacificMinutes } from './base.js';
import { optimistic } from './ui/optimistic.js';

/** The newest view of each job this page has seen. */
const known = new Map();
/** Each job's cards on the page: element → its redraw. */
const drawn = new Map();
/** Jobs whose log someone opened, so a redraw keeps it open. */
const openLogs = new Set();
/** Whoever else wants every job update (the Machines page's list). */
const listeners = new Set();

const ACTIVE = ['starting', 'running', 'paused', 'uploading'];
const PILL = { 'needs-go': 'needs go', queued: 'queued', starting: 'starting', running: 'running', paused: 'paused', uploading: 'uploading', done: 'done', failed: 'failed', stopped: 'stopped', refused: 'refused' };

/** The machine owner or an admin: the only people with buttons on a job (spec, "who decides"); the go itself is the owner's alone. */
export const mayAct = (v) => !!account && (account.admin || (v.decider_id != null && account.id === v.decider_id));

/** The machine's owner alone: the go, Run now, Always allow and job hours are theirs (spec, "who decides"); an admin only pauses, resumes and stops. */
const isOwner = (v) => !!account && v.decider_id != null && account.id === v.decider_id;

/** A clock time people read: always Pacific, labelled (Citadel-wide rule), with the day once it's over 12 hours ago. */
export function pacific(ms) {
  if (!ms) return '';
  if (Math.abs(Date.now() - ms) > 12 * 3600e3) return pacificDay(ms);
  return pacificClock(ms);
}
/** A day and time, for a job list row: "Nov 16, 11:00 PM PST". */
export function pacificDay(ms) {
  return ms ? pacificStamp(ms) : '';
}
export function duration(s) {
  s = Math.max(0, Math.round(s ?? 0));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} m`;
  const m = Math.floor((s % 3600) / 60);
  return `${Math.floor(s / 3600)} h${m ? ` ${m} m` : ''}`;
}
const limitText = (s) => (s % 3600 ? `${Math.round(s / 60)} min` : `${s / 3600} h`);
const gb = (mb) => `${(mb / 1024).toFixed(1)} GB`;

/** How long it has run: the server's count, plus the time since the agent last reported while it runs. */
export function elapsed(v, now = Date.now()) {
  const live = v.state === 'running' && v.live_at ? Math.max(0, (now - v.live_at) / 1000) : 0;
  return Math.min(v.run_s + live, v.limit_s);
}

/** The colour a state draws in, as a class: the card's left edge, its pill and a list row's dot. */
export function tone(state) {
  if (state === 'needs-go') return 'jt-held';
  if (state === 'queued' || state === 'starting' || state === 'paused') return 'jt-waiting';
  if (state === 'running' || state === 'uploading') return 'jt-running';
  if (state === 'done') return 'jt-done';
  return state === 'failed' ? 'jt-failed' : 'jt-ended';
}

/** Keep a view this page fetched or was sent. */
export function rememberJob(v) {
  known.set(v.id, v);
  return v;
}
export const jobView = (id) => known.get(id);

/** A `machine_job` event: redraw every card of that job, and tell the Machines page. */
export function onJobUpdate(v) {
  known.set(v.id, v);
  redraw(v.id);
  for (const fn of listeners) fn(v);
}
export function onJobs(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function redraw(id) {
  for (const [el, draw] of drawn.get(id) ?? []) {
    // A card that was on the page and has left it (another chat opened, the list redrawn) is forgotten.
    if (!el.isConnected && el.wasShown) drawn.get(id).delete(el);
    else draw();
  }
}

/**
 * Cards of finished jobs never redraw, so each new card also lets go of the ones that left the page (#1760). A task
 * later, so a list being rebuilt (the Machines page moves its open cards into new rows) has put them back first.
 */
let forgetting = false;
function forgetSoon() {
  if (forgetting) return;
  forgetting = true;
  setTimeout(() => {
    forgetting = false;
    forgetLeft();
  });
}
function forgetLeft() {
  for (const [id, cards] of drawn) {
    for (const el of cards.keys()) if (!el.isConnected && el.wasShown) cards.delete(el);
    if (!cards.size) drawn.delete(id);
  }
}

// Running cards tick their time between the agent's reports: one timer for the page, only while one runs.
let ticker = null;
function tick() {
  if (ticker) return;
  ticker = setInterval(() => {
    const running = [...known.values()].filter((v) => v.state === 'running' && drawn.get(v.id)?.size);
    if (!running.length) {
      clearInterval(ticker);
      ticker = null;
      return;
    }
    for (const v of running) redraw(v.id);
  }, 30_000);
}

/**
 * The live job card. `where` is 'chat' (the minion's chat: names the machine) or 'machines' (the Machines page:
 * names who asked). It redraws itself on every update of the job.
 */
export function jobCard(id, first, where = 'chat') {
  // A chat's history replays its job events oldest first, so the view an event carries is the newest it knew;
  // one that hasn't ended is fetched again, since it may have moved on since.
  if (first) rememberJob(first);
  const el = h('div', { class: 'jobcard', 'data-job-card': id });
  const draw = () => {
    const v = known.get(id);
    if (!v) {
      el.replaceChildren(h('div', { class: 'jc-top' }, h('span', { class: 'jc-kind' }, `Job #${id}`), h('span', { class: 'muted' }, 'loading…')));
      return;
    }
    el.className = `jobcard ${tone(v.state)}`;
    el.replaceChildren(...cardParts(v, where));
    if (v.state === 'running') tick();
  };
  forgetSoon();
  if (!drawn.has(id)) drawn.set(id, new Map());
  drawn.get(id).set(el, draw);
  draw();
  // By the next task it's on the page; once it leaves, redraw() lets it go.
  setTimeout(() => {
    el.wasShown = true;
  });
  if (!known.has(id) || ['needs-go', 'queued', 'starting', ...ACTIVE].includes(known.get(id).state))
    api(`api/jobs/${id}`).then(
      (v) => {
        rememberJob(v);
        redraw(id);
      },
      () => {},
    );
  return el;
}

function cardParts(v, where) {
  const parts = [h('div', { class: 'jc-top' }, h('span', { class: 'jc-kind' }, `Job #${v.id} · ${v.kind.name}`), h('span', { class: 'jc-pill' }, PILL[v.state] ?? v.state), h('span', { class: 'jc-where' }, where === 'chat' ? machineLink(v) : askerLink(v)))];
  parts.push(...body(v));
  if (!['needs-go', 'queued', 'refused'].includes(v.state)) parts.push(logPart(v));
  const acts = actions(v, where);
  if (acts) parts.push(acts);
  return parts;
}

/** The machine, linked to the Machines page of the scheme the job runs for. */
const machineLink = (v) => h('a', { href: `#/p/${v.project_id}/machines` }, v.machine ?? `machine #${v.machine_id}`);
/** Who queued it: the minion's chat, or the app by name. */
function askerLink(v) {
  if (v.ticket_id !== null && v.ticket_number != null) return h('span', {}, 'from ', h('a', { href: `#/p/${v.project_id}/t/${v.ticket_number}` }, v.asked_by));
  return `from ${v.asked_by}`;
}

function body(v) {
  const out = [];
  const facts = (...items) => h('div', { class: 'jc-facts' }, ...items.filter(Boolean));
  const b = (text) => h('b', {}, text);
  const goText = v.go === 'now' ? 'run now' : v.go === 'standing' ? 'always allowed' : 'run in job hours';
  if (v.state === 'needs-go') {
    out.push(h('p', { class: 'jc-why' }, v.when === 'now' ? `Asks to run now: ${v.reason}` : 'Asks to run in job hours'));
    out.push(h('p', { class: 'jc-why muted' }, `Asked ${pacific(v.created_at)} · limit ${limitText(v.limit_s)} · reads ${v.kind.reads.join(', ') || 'none of your folders'} · GPU ${v.kind.gpu ? 'on' : 'off'}, network ${v.kind.network ? 'on' : 'off'}`));
  } else if (v.state === 'queued' || v.state === 'starting') {
    out.push(h('p', { class: 'jc-why' }, v.state === 'starting' ? `Starting on ${v.machine}` : `Waiting: ${v.waits ?? 'next in line'}`));
    out.push(h('p', { class: 'jc-why muted' }, `${v.go_by ? `${v.go_by}'s go` : 'Go'}: ${goText} · limit ${limitText(v.limit_s)}`));
  } else if (ACTIVE.includes(v.state)) {
    const run = elapsed(v);
    const pct = Math.min(100, (run / v.limit_s) * 100);
    out.push(bar(pct));
    out.push(
      facts(
        h('span', {}, b(duration(run)), ` of ${limitText(v.limit_s)}`),
        v.state === 'running' && v.gpu_pct != null ? h('span', {}, 'GPU ', b(`${Math.round(v.gpu_pct)}%`), v.vram_mb != null ? [' · VRAM ', b(gb(v.vram_mb))] : '') : null,
        h('span', {}, 'GPU busy ', b(duration(v.gpu_busy_s))),
        v.started_at ? h('span', { class: 'muted' }, `started ${pacific(v.started_at)}`) : null,
      ),
    );
    // A Stop the agent hasn't acted on yet: the server keeps the state until the agent reports it ended.
    if (v.error) out.push(h('p', { class: 'jc-why' }, `Stopping, waiting for the machine (${v.error})`));
    else if (v.state === 'uploading') out.push(h('p', { class: 'jc-why' }, 'Sending its results back'));
    else if (v.state === 'running' && v.pause_failed) out.push(h('div', { class: 'jc-warn' }, h('b', {}, "Pause didn't take, so it is still running."), ` ${v.pause_failed}`));
    if (v.state === 'paused') out.push(...pausedParts(v));
  } else {
    const run = v.run_s;
    if (v.state === 'done') out.push(facts(h('span', {}, 'Done in ', b(duration(run))), h('span', {}, 'GPU busy ', b(duration(v.gpu_busy_s))), h('span', { class: 'muted' }, `finished ${pacific(v.ended_at)}`)));
    else if (v.state === 'refused') out.push(facts(h('span', {}, `Refused${v.go_by ? ` by ${v.go_by}` : ''}`), h('span', { class: 'muted' }, pacific(v.ended_at))));
    else out.push(facts(h('span', {}, v.state === 'failed' ? 'Failed after ' : 'Stopped after ', b(duration(run))), v.exit_code != null ? h('span', {}, `exit ${v.exit_code}`) : null, h('span', { class: 'muted' }, `ended ${pacific(v.ended_at)}`)));
    if (v.error) out.push(h('p', { class: 'jc-why' }, v.error));
    if (v.state === 'done') out.push(results(v));
  }
  return out;
}

function bar(pct) {
  const fill = h('span', {});
  fill.style.width = `${pct.toFixed(1)}%`;
  return h('span', { class: 'jc-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(pct)) }, fill);
}
export { bar as jobBar };

/** Pause tells the truth: a resumable kind freed its VRAM; one that can't resume is frozen and still holds it. */
function pausedParts(v) {
  const by = v.paused_by === 'hours' ? 'Paused: its job hours closed, and it resumes when they open.' : v.paused_by === 'machine' ? `Paused: ${v.machine} is paused for jobs.` : 'Paused by its owner.';
  if (v.kind.resumable) return [h('p', { class: 'jc-why' }, `${by} All its VRAM is freed, and Resume picks up from its files. Paused time doesn't count against the limit.`)];
  const held = v.held_vram_mb ?? v.vram_mb;
  return [h('p', { class: 'jc-why' }, by), h('div', { class: 'jc-warn' }, 'Frozen, not stopped: it still holds ', h('b', {}, held != null ? gb(held) : 'its'), " of VRAM. This kind can't resume from its files, so Stop frees the GPU but loses the run.")];
}

/** The result files, linked where people can open them: the scheme's shared folder's jobs/<id>/. */
function results(v) {
  const files = (v.outputs ?? []).filter((o) => o.uploaded);
  if (!files.length) return h('p', { class: 'jc-why muted' }, v.swept ? 'Its results were cleared after 14 days.' : 'No result files.');
  const shown = files.slice(0, 8);
  const link = (o) => (v.ticket_id !== null && !v.swept ? h('a', { href: sharedHref(v.project_id, `jobs/${v.id}/${o.path}`) }, `jobs/${v.id}/${o.path}`) : h('span', {}, o.path));
  return h('ul', { class: 'jc-files' }, ...shown.map((o) => h('li', {}, link(o), h('span', { class: 'muted' }, ` ${formatSize(o.size)}`))), files.length > shown.length ? h('li', { class: 'muted' }, `and ${files.length - shown.length} more (${formatSize(files.reduce((n, o) => n + o.size, 0))} in all)`) : '');
}

/** The log's last lines: nothing until opened (Cara's pick), then in place. */
function logPart(v) {
  const open = openLogs.has(v.id);
  const toggle = h(
    'button',
    {
      type: 'button',
      class: 'jc-logbtn',
      'aria-expanded': String(open),
      onclick: () => {
        if (openLogs.has(v.id)) openLogs.delete(v.id);
        else openLogs.add(v.id);
        redraw(v.id);
      },
    },
    open ? '▾ Log' : '▸ Log',
  );
  if (!open) return h('div', { class: 'jc-log' }, toggle);
  const pre = h('pre', {}, v.log_tail || 'Nothing logged yet.');
  // The newest lines are what you opened it for.
  requestAnimationFrame(() => {
    pre.scrollTop = pre.scrollHeight;
  });
  return h('div', { class: 'jc-log' }, toggle, pre);
}

/** The owner's buttons; others see none. */
function actions(v, where) {
  if (!mayAct(v) || (ACTIVE.includes(v.state) && v.error)) return null;
  const btn = (label, action, cls = 'small') => h('button', { type: 'button', class: cls, onclick: () => act(v, action) }, label);
  let items = [];
  if (v.state === 'needs-go') {
    if (!isOwner(v)) items = [btn('Stop', 'stop', 'small secondary')];
    else if (where === 'chat') {
      const goCard = document.querySelector(`[data-go-job="${v.id}"]`);
      items = goCard
        ? [
            h(
              'a',
              {
                href: '#',
                onclick: (e) => {
                  e.preventDefault();
                  goCard.scrollIntoView({ block: 'center', behavior: 'smooth' });
                },
              },
              'Answer on the go card',
            ),
          ]
        : [];
    } else {
      items = [btn('Run in job hours', 'go:hours'), btn('Run now', 'go:now', 'small secondary'), btn('Always allow this kind', 'go:always', 'small secondary'), btn('No', 'go:no', 'small secondary')];
    }
  } else if (v.state === 'queued') items = [...(isOwner(v) ? [btn('Run now', 'run-now')] : []), btn('Stop', 'stop', 'small secondary')];
  else if (v.state === 'starting' || v.state === 'uploading') items = [btn('Stop', 'stop', 'small secondary')];
  else if (v.state === 'running') items = [btn('Pause', 'pause'), btn('Stop', 'stop', 'small secondary')];
  else if (v.state === 'paused') {
    const held = v.held_vram_mb ?? v.vram_mb;
    items = v.kind.resumable ? [btn('Resume', 'resume'), btn('Stop', 'stop', 'small secondary')] : [btn(held != null ? `Stop and free ${gb(held)}` : 'Stop and free the GPU', 'stop'), btn('Resume', 'resume', 'small secondary')];
  }
  return items.length ? h('div', { class: 'jc-acts' }, ...items) : null;
}

/** What a click shows at once, before the server answers. */
const GUESS = {
  pause: () => ({ state: 'paused', paused_by: 'owner' }),
  resume: () => ({ state: 'running', paused_by: null, live_at: Date.now() }),
  stop: (v) => (v.state === 'queued' || v.state === 'needs-go' ? { state: 'stopped', ended_at: Date.now(), error: `Stopped by ${account?.name}` } : { error: `Stopped by ${account?.name}` }),
  'run-now': () => ({ state: 'queued', go: 'now', waits: null }),
  'go:hours': () => ({ state: 'queued', go: 'hours', go_by: account?.name }),
  'go:now': () => ({ state: 'queued', go: 'now', go_by: account?.name }),
  'go:always': () => ({ state: 'queued', go: 'standing', go_by: account?.name }),
  'go:no': () => ({ state: 'refused', go_by: account?.name, ended_at: Date.now() }),
};
const LABEL = { pause: 'pause', resume: 'resume', stop: 'stop', 'run-now': 'run now', 'go:hours': 'give the go', 'go:now': 'give the go', 'go:always': 'give the go', 'go:no': 'refuse' };

/** A button's action, shown at once and rolled back with a toast if the server refuses. */
export function act(v, action) {
  const before = known.get(v.id) ?? v;
  return optimistic({
    key: `job:${v.id}`,
    label: `${LABEL[action]} job #${v.id}`,
    apply: () => {
      known.set(v.id, { ...before, ...GUESS[action](before) });
      redraw(v.id);
      for (const fn of listeners) fn(known.get(v.id));
    },
    send: async () => {
      const [path, choice] = action.split(':');
      const out = await api(`api/jobs/${v.id}/${path}`, { method: 'POST', body: choice ? { choice } : {} });
      known.set(v.id, out);
      redraw(v.id);
      for (const fn of listeners) fn(out);
      return out;
    },
    undo: () => {
      known.set(v.id, before);
      redraw(v.id);
      for (const fn of listeners) fn(before);
    },
  });
}

/** The one-line note a card leaves where it was, when it moves to the bottom of the chat. */
export function jobMovedNote(data, href) {
  const what = { waiting: 'was queued', running: 'started', paused: 'paused', ended: 'ended' }[data.stage] ?? 'changed';
  const name = data.view?.kind?.name ? ` (${data.view.kind.name})` : '';
  return h('div', { class: 'note jc-moved' }, `Job #${data.job}${name} ${what}: its card moved `, h('a', { href }, 'further down'));
}

/** The go card's question, laid out: what runs, what it reads, GPU and network, the limit, inputs and why now. */
export function jobRecipe(r) {
  const row = (label, ...value) => [h('dt', {}, label), h('dd', {}, ...value)];
  const code = (t) => h('code', {}, t);
  return h(
    'dl',
    { class: 'jc-recipe' },
    row('Asked by', r.asked_by),
    row('Kind', r.kind.name, h('span', { class: 'muted' }, r.kind.resumable ? ' · can pause and resume' : " · can't resume: a pause freezes it")),
    row('Image', code(r.kind.image)),
    row('Command', code(r.kind.command.join(' '))),
    row('Reads', r.kind.reads.length ? r.kind.reads.join(', ') : 'none of your folders'),
    row('GPU · network', `${r.kind.gpu ? 'GPU on' : 'GPU off'} · ${r.kind.network ? 'network on' : 'network off'}`),
    row('Limit', limitText(r.limit_s)),
    row('Inputs', r.inputs.length ? r.inputs.map((i, n) => h('span', {}, n ? ', ' : '', i.name, h('span', { class: 'muted' }, ` (${formatSize(i.size)})`))) : 'none'),
    row('When', r.when === 'now' ? h('span', {}, h('b', {}, 'Now'), `: ${r.reason}`) : 'In job hours'),
  );
}

/** Every job of a minion, for its chat: one fetch fills the cards that came without a view. */
export async function loadTicketJobs(ticketId) {
  const { jobs } = await api(`api/tickets/${ticketId}/jobs`);
  for (const v of jobs) {
    known.set(v.id, v);
    redraw(v.id);
  }
  return jobs;
}

// ---- The Machines page: a machine's Jobs section (its owner and admins only; the read API says 404 to others). ----

/** Each machine's section, kept across the machine list's redraws so open rows and a typed time survive them. */
const sections = new Map();
/** The next time the Pacific clock reads hh:mm. shortcut: off by an hour across a DST change, which lands at 2 AM. */
export function nextPacific(hhmm, now = Date.now()) {
  const want = Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
  const ahead = (want - pacificMinutes(now) + 1440) % 1440 || 1440;
  return Math.floor(now / 60000) * 60000 + ahead * 60000;
}

/** The Jobs section of an opened machine on the Machines page; `m` is its newest machine view. */
export function machineJobsSection(m) {
  let s = sections.get(m.id);
  if (!s) {
    s = newSection(m.id);
    sections.set(m.id, s);
  }
  s.setMachine(m);
  return s.el;
}

function newSection(machineId) {
  const el = h('div', { class: 'mjobs', hidden: true });
  const st = { machine: null, jobs: [], kinds: [], settings: null, open: new Set(), cards: new Map(), allowed: false };
  const head = h('div', { class: 'mjobs-head' });
  const settingsEl = h('div', { class: 'mjobs-settings' });
  const kindsEl = h('div', { class: 'mjobs-kinds' });
  const listEl = h('div', { class: 'mjobs-list' });
  el.append(head, settingsEl, kindsEl, listEl);

  const load = () =>
    api(`api/machines/${machineId}/jobs`).then(
      (r) => {
        st.allowed = true;
        st.jobs = r.jobs;
        st.kinds = r.kinds;
        st.settings = r.settings;
        for (const v of r.jobs) rememberJob(v);
        el.hidden = false;
        drawAll();
      },
      (e) => {
        if (e.status !== 404) {
          el.hidden = false;
          el.replaceChildren(h('p', { class: 'muted' }, `Couldn't load its jobs: ${e.message}`));
        }
      },
    );

  onJobs((v) => {
    if (v.machine_id !== machineId || !st.allowed) return;
    const i = st.jobs.findIndex((j) => j.id === v.id);
    if (i >= 0) st.jobs[i] = v;
    else st.jobs.unshift(v);
    drawHead();
    drawList();
  });

  const active = () => st.jobs.find((j) => ACTIVE.includes(j.state));
  function drawHead() {
    const a = active();
    const gpu =
      a && a.state === 'running' && a.gpu_pct != null ? h('span', { class: 'mjobs-gpu' }, meter(a.gpu_pct), h('span', {}, `GPU ${Math.round(a.gpu_pct)}%`, a.vram_mb != null ? ` · VRAM ${gb(a.vram_mb)}` : '', ` · job #${a.id}`)) : h('span', { class: 'muted' }, a ? `Job #${a.id} is ${a.state}` : 'No job running');
    head.replaceChildren(h('b', {}, 'Jobs'), gpu);
  }
  function drawSettings(force = false) {
    // Someone typing a time keeps what they typed; the next redraw after they leave the field catches up.
    const typing = document.activeElement;
    if (typing?.type === 'time' && settingsEl.contains(typing) && !force) return;
    const set = st.settings;
    const zone = pacificZone();
    const time = (key) => {
      const input = h('input', { type: 'time', value: set[key], 'aria-label': key === 'start' ? 'Job hours start' : 'Job hours end' });
      input.onchange = () => input.value && input.value !== st.settings[key] && patch({ [key]: input.value }, 'change its job hours');
      return input;
    };
    const untilOn = set.until && set.until > Date.now();
    const untilInput = h('input', { type: 'time', 'aria-label': 'Jobs may run until' });
    const untilBtn = h('button', { type: 'button', class: 'small secondary', onclick: () => untilInput.value && patch({ until: nextPacific(untilInput.value) }, 'open a window for jobs') }, 'Set');
    const pause = h('input', { type: 'checkbox', checked: set.paused });
    pause.onchange = () => patch({ paused: pause.checked }, pause.checked ? 'pause jobs on this machine' : 'let jobs run again');
    settingsEl.replaceChildren(
      h('span', { class: 'muted' }, 'Job hours'),
      h('div', { class: 'row' }, time('start'), h('span', {}, 'to'), time('end'), h('span', { class: 'muted' }, zone)),
      h('span', { class: 'muted' }, 'One-off window'),
      untilOn ? h('div', { class: 'row' }, h('span', {}, `Jobs may run until ${pacific(set.until)}`), h('button', { type: 'button', class: 'small secondary', onclick: () => patch({ until: null }, 'end the window') }, 'End it')) : h('div', { class: 'row' }, h('span', {}, 'Jobs may run until'), untilInput, untilBtn),
      h('span', { class: 'muted' }, 'Pause'),
      h('label', { class: 'row mjobs-pause' }, pause, h('span', {}, set.paused ? 'Paused: the running job is paused and nothing new starts' : 'Pause every job on this machine')),
    );
  }
  function patch(fields, label) {
    const was = { ...st.settings };
    optimistic({
      key: `jobsettings:${machineId}`,
      label,
      apply: () => {
        st.settings = { ...st.settings, ...fields };
        drawSettings();
      },
      send: async () => {
        st.settings = await api(`api/machines/${machineId}/job-settings`, { method: 'PATCH', body: fields });
        drawSettings();
      },
      undo: () => {
        st.settings = was;
        drawSettings();
      },
    });
  }
  function drawKinds() {
    if (!st.kinds.length) {
      kindsEl.replaceChildren();
      return;
    }
    kindsEl.replaceChildren(
      h('span', { class: 'muted' }, 'Always allowed'),
      h('div', { class: 'mjobs-chips' }, ...st.kinds.map((k) => h('span', { class: 'mjobs-chip', title: `Allowed by ${k.allowed_by}, ${pacificDay(k.at)}` }, k.name, h('button', { type: 'button', class: 'small secondary', onclick: () => removeKind(k) }, 'Remove')))),
    );
  }
  function removeKind(k) {
    const was = st.kinds;
    optimistic({
      key: `jobkind:${machineId}:${k.hash}`,
      label: `remove ${k.name} from always allowed`,
      apply: () => {
        st.kinds = st.kinds.filter((x) => x.hash !== k.hash);
        drawKinds();
      },
      send: () => api(`api/machines/${machineId}/job-kinds/${encodeURIComponent(k.hash)}`, { method: 'DELETE' }),
      undo: () => {
        st.kinds = was;
        drawKinds();
      },
    });
  }
  function drawList() {
    if (!st.jobs.length) {
      listEl.replaceChildren(h('p', { class: 'muted' }, 'No jobs yet.'));
      return;
    }
    // The one running or paused on top, then newest first.
    const rows = [...st.jobs].sort((a, b) => ACTIVE.includes(b.state) - ACTIVE.includes(a.state) || b.created_at - a.created_at);
    listEl.replaceChildren(...rows.map((v) => jobRow(v)));
  }
  function jobRow(v) {
    const isOpen = st.open.has(v.id);
    const toggle = () => {
      if (isOpen) st.open.delete(v.id);
      else st.open.add(v.id);
      drawList();
    };
    const run = ACTIVE.includes(v.state) ? elapsed(v) : v.run_s;
    const when = v.ended_at ? `ended ${pacificDay(v.ended_at)}` : v.started_at ? `started ${pacificDay(v.started_at)}` : `asked ${pacificDay(v.created_at)}`;
    const sub = [PILL[v.state], v.state === 'queued' && v.waits ? v.waits : '', when, `from ${v.asked_by}`].filter(Boolean).join(' · ');
    const right = run ? `${duration(run)}${v.gpu_busy_s ? ` · GPU ${duration(v.gpu_busy_s)}` : ''}` : '';
    const btn = h(
      'button',
      { type: 'button', class: 'mjobs-row', 'aria-expanded': String(isOpen), onclick: toggle },
      h('span', { class: 'jc-dot' }),
      h('span', { class: 'text' }, h('span', { class: 'name' }, `Job #${v.id} · ${v.kind.name}`), h('span', { class: 'meta' }, sub)),
      h('span', { class: 'meta right' }, right),
      // Cara's note on her pick (2026-11-17): "with a simple progress bar on the currently running job".
      v.state === 'running' || v.state === 'paused' ? bar(Math.min(100, (run / v.limit_s) * 100)) : '',
    );
    let card = '';
    if (isOpen) {
      // Kept while it stays live; one redraw() let go of (closed, or the page left) is built again.
      card = st.cards.get(v.id);
      if (!card || !drawn.get(v.id)?.has(card)) st.cards.set(v.id, (card = jobCard(v.id, v, 'machines')));
    }
    return h('div', { class: `mjobs-item ${tone(v.state)}${isOpen ? ' open' : ''}` }, btn, card);
  }
  function drawAll() {
    drawHead();
    drawSettings();
    drawKinds();
    drawList();
  }

  return {
    el,
    setMachine(m) {
      const first = !st.machine;
      st.machine = m;
      if (!m.jobs) {
        el.hidden = true;
        return;
      }
      if (first) load();
      else if (st.allowed && m.job_settings && JSON.stringify(m.job_settings) !== JSON.stringify(st.settings)) {
        st.settings = m.job_settings;
        drawSettings();
      }
    },
  };
}

function meter(pct) {
  const fill = h('span', {});
  fill.style.width = `${Math.max(0, Math.min(100, pct)).toFixed(0)}%`;
  return h('span', { class: 'mjobs-meter', 'aria-hidden': 'true' }, fill);
}
