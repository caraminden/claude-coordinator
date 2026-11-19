// The CI page (#968, Cara 2026-11-18: "maybe mandate could link to a ci status/issues page within citadel"; layout B,
// "Scheme list on the left, detail on the right", with "the CI box performance page from machines" in it): every
// scheme with CI, its open problems with what, why and the fix, each workflow's verdict on main, the queue, recent runs
// and its runners, plus the CI desktop's load. It reads /api/ci (src/ci-health.ts snapshot) and changes nothing.
// The CI chip by the usage meter ("Chip by the usage meter") opens it, its dot the worst of what the page shows.
import { ago, api, h, view } from './base.js';
import { pcCard, trouble } from './ci-desktop.js';
import { shortSpan } from './releasemath.js';
import { LAST_SCHEME } from './sidebar.js';

const REFRESH_MS = 30_000;
const LA = { timeZone: 'America/Los_Angeles', timeZoneName: 'short' };
const when = (t) => new Date(t).toLocaleString('en-US', { ...LA, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const ext = (href, text) => h('a', { href, target: '_blank', rel: 'noopener' }, text);

/** A scheme's state: down (something rings), fix (quiet items), ready (all clear), asleep (no read for 20 min). */
function stateOf(s, now) {
  if (s.problems.some((x) => !x.quiet)) return 'down';
  if (s.problems.length) return 'fix';
  return now - s.view.at > 20 * 60_000 ? 'asleep' : 'ready';
}
const STATE_WORDS = { down: 'needs a person', fix: 'being handled', ready: 'all clear', asleep: 'not read lately' };
const RANK = { down: 3, fix: 2, asleep: 1, ready: 0 };

/** One open problem: what happened, why, the fix, and whether it rings. */
function problemCard(x) {
  return h('div', { class: `ci-problem${x.quiet ? '' : ' rings'}` },
    h('div', { class: 'ci-problem-head' },
      h('span', { class: `dot ${x.quiet ? 'fix' : 'down'}` }),
      h('strong', {}, x.title.replace(/^CI(, [^:]+)?: /, '')),
      h('span', { class: 'ci-tag' }, x.quiet ? 'quiet' : 'rings')),
    x.why ? h('p', {}, h('span', { class: 'muted' }, 'Why: '), x.why) : '',
    x.fix ? h('p', {}, h('span', { class: 'muted' }, 'Fix: '), x.fix) : '',
    problemLink(x.link));
}

/** Who is on it (#992): the fix minion's chat, else the Taskmaster's at its wake. The row is always there, so a link arriving moves nothing. */
function problemLink(l) {
  return h('p', { class: 'ci-problem-link' }, l ? [
    h('span', { class: 'muted' }, l.kind === 'minion' ? 'Fix minion: ' : 'Heard by: '),
    h('a', { href: l.href }, l.label),
    l.closed ? h('span', { class: 'muted' }, ' (closed)') : ''] : '');
}

const verdictClass = (c) => (c === 'success' ? 'ready' : c === 'failure' ? 'down' : c ? 'asleep' : 'running');

/** The minion a run or queued job tests (#1019): its chat, or what the run is when no minion's change is in it (a schedule, main itself). An older view has no `who`: its branch. */
const whoCell = (x) => x.who?.href ? h('a', { class: 'ci-run-who', href: x.who.href, title: x.who.label }, x.who.label)
  : h('span', { class: 'ci-run-who muted' }, x.who?.label ?? x.branch ?? '');

function runRow(r) {
  const word = r.status === 'completed' ? r.conclusion ?? 'done' : r.status.replace('_', ' ');
  return h('div', { class: 'ci-run', title: `${r.name} on ${r.branch}: ${word}, ${when(r.at)}` },
    h('span', { class: `dot ${verdictClass(r.status === 'completed' ? r.conclusion : null)}` }),
    h('span', { class: 'ci-run-word' }, word),
    ext(r.url, r.name),
    whoCell(r),
    h('span', { class: 'ci-run-age muted' }, ago(Date.parse(r.at))));
}

const GENERIC = /^(self-hosted|windows|linux|macos|x64|arm64)$/i;
const labelName = (ls) => ls.filter((l) => !GENERIC.test(l)).join(', ') || ls.join(', ');
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** The queue per set of labels, for Running now's header: "peek-auras-ci: 1 runner, 9 queued". */
const queueWords = (q) => `${labelName(q.labels)}: ${q.runners ? `${plural(q.runners, 'runner')}, `
  : q.runners === 0 && q.labels.some((l) => /^self-hosted$/i.test(l)) ? 'no runner online, ' : ''}${q.jobs} queued`;

/**
 * Running now (Cara, 2026-11-18: "Could we make this page show what is running on the CI?"): a row per self-hosted runner, busy
 * with which job for which minion and for how long, idle or offline, then one row for GitHub's own runners that opens to a row per
 * job. Rows are per runner, not per job, so the section keeps its height as jobs come and go between reads.
 */
function runningNow(s, now, ui) {
  const v = s.view;
  const running = v.running ?? [];
  const own = v.runners ?? [];
  const names = new Set(own.map((r) => r.name));
  const jobLink = (j) => ext(`https://github.com/${v.slug}/actions/runs/${j.run}`, j.name);
  const jobCell = (j) => h('span', { class: 'ci-run-who', title: `${j.name} · ${j.who?.label ?? j.branch ?? ''}` }, jobLink(j), ' · ', j.who?.href ? h('a', { href: j.who.href }, j.who.label) : h('span', { class: 'muted' }, j.who?.label ?? j.branch ?? ''));
  const age = (j) => h('span', { class: 'ci-run-age muted' }, j ? shortSpan(now - Date.parse(j.since)) : '');
  const rows = own.map((r) => {
    const j = running.find((x) => x.runner === r.name);
    const word = r.status === 'offline' ? 'offline' : j || r.busy || r.job ? 'busy' : 'idle';
    return h('div', { class: 'ci-run ci-now' },
      h('span', { class: `dot ${{ offline: 'down', busy: 'running', idle: 'ready' }[word]}` }),
      h('span', { class: 'ci-run-word' }, word),
      h('span', { class: 'ci-run-name', title: r.name }, r.name),
      j ? jobCell(j) : h('span', { class: 'ci-run-who muted' }, word === 'offline' ? (r.offlineSince ? `since ${when(r.offlineSince)}` : 'offline')
        : r.job ?? (word === 'busy' ? 'a job from an older run' : 'waiting for work')),
      age(j));
  });
  // GitHub's own runners (and every runner, when the repo's can't be listed): one row, opened by a click to a row per job.
  const theirs = running.filter((j) => !names.has(j.runner));
  const where = v.runners === null ? 'Runners' : "GitHub's runners";
  rows.push(h('button', { type: 'button', class: 'ci-run ci-now ci-now-more', 'aria-expanded': String(ui.hostedOpen), disabled: !theirs.length, onclick: ui.toggleHosted },
    h('span', { class: `dot ${theirs.length ? 'running' : 'ready'}` }),
    h('span', { class: 'ci-run-word' }, theirs.length ? `${theirs.length} running` : 'none'),
    h('span', { class: 'ci-run-name' }, where),
    h('span', { class: 'ci-run-who muted' }, theirs.length ? (ui.hostedOpen ? 'hide jobs' : theirs.map((j) => j.name).join(', ')) : 'nothing running'),
    h('span', { class: 'ci-run-age muted' }, theirs.length ? (ui.hostedOpen ? '▴' : '▾') : '')));
  if (ui.hostedOpen) rows.push(...theirs.map((j) => h('div', { class: 'ci-run ci-now' },
    h('span', { class: 'dot running' }), h('span', { class: 'ci-run-word' }, 'running'), h('span', { class: 'ci-run-name', title: j.runner }, j.runner), jobCell(j), age(j))));
  const queues = v.queues ?? [];
  const head = queues.length ? queues.map(queueWords).join(' · ') : 'nothing queued';
  return h('section', { class: 'ci-block' },
    h('div', { class: 'ci-block-head' }, h('h4', {}, 'Running now'), h('span', { class: 'muted small ci-queues', title: head }, head)),
    h('div', { class: 'ci-runs' }, ...rows));
}

function overview(s, now, ui) {
  const v = s.view;
  return [
    h('section', { class: 'ci-block' }, h('h4', {}, 'Open problems'),
      s.problems.length ? h('div', { class: 'ci-problems' }, ...s.problems.map(problemCard)) : h('p', { class: 'muted' }, 'Nothing needs fixing.')),
    h('section', { class: 'ci-block' }, h('h4', {}, `Verdicts on ${v.branch}`),
      h('div', { class: 'ci-runs' }, ...v.workflows.map((w) => w.verdict
        ? h('div', { class: 'ci-verdict-row' }, runRow({ ...w.verdict, name: w.name }),
          w.skipped.length ? h('p', { class: 'muted small ci-skipped' }, `Green, but skipped ${w.skipped.join(', ')}, which ran in the verdict before it.`) : '')
        : h('div', { class: 'ci-run' }, h('span', { class: 'dot asleep' }), h('span', { class: 'ci-run-word muted' }, 'no verdict'), h('span', { class: 'ci-run-name' }, w.name))))),
    runningNow(s, now, ui),
    h('section', { class: 'ci-block' }, h('h4', {}, 'Waiting for a runner'),
      v.waiting.length ? h('div', { class: 'ci-runs' }, ...v.waiting.map((j) => h('div', { class: 'ci-run', title: `${j.name}, for a runner with ${j.labels.join(', ')}, queued ${when(j.since)}` },
        h('span', { class: 'dot fix' }), h('span', { class: 'ci-run-word' }, 'queued'), ext(`https://github.com/${v.slug}/actions/runs/${j.run}`, j.name),
        whoCell(j), h('span', { class: 'ci-run-age muted' }, ago(Date.parse(j.since))))))
        : h('p', { class: 'muted' }, 'No job is waiting.')),
  ];
}

function runners(s, pcs) {
  const list = s.view.runners;
  return [
    h('section', { class: 'ci-block' }, h('h4', {}, `${s.name}'s runners`),
      list === null ? h('p', { class: 'muted' }, "CI health can't list this repo's runners: it needs a repo admin's linked GitHub.")
        : !list.length ? h('p', { class: 'muted' }, 'No self-hosted runners; jobs run on GitHub\'s.')
          : h('div', { class: 'ci-runs' }, ...list.map((r) => h('div', { class: 'ci-run' },
            h('span', { class: `dot ${r.status === 'offline' ? 'down' : r.busy || r.job ? 'running' : 'ready'}` }),
            h('span', { class: 'ci-run-word' }, r.status === 'offline' ? 'offline' : r.busy || r.job ? 'busy' : 'idle'),
            h('span', { class: 'ci-run-name' }, r.name),
            h('span', { class: 'ci-run-branch muted' }, r.status === 'offline' ? (r.offlineSince ? `since ${when(r.offlineSince)}` : '') : r.job ?? ''),
            h('span', { class: 'ci-run-age muted' }, r.labels.filter((l) => !/^(self-hosted|windows|linux|x64|arm64)$/i.test(l)).join(', ')))))),
    pcs.length ? h('section', { class: 'ci-block ci-desktops' }, h('h4', {}, 'CI desktop load'), ...pcs.map(pcCard)) : '',
  ];
}

/** The page: `projectId` is the scheme it opened from, selected first. */
export function ciPage(projectId) {
  let picked = projectId;
  let tab = 'overview';
  let greensOpen = false; // phones: the all-clear schemes sit behind a toggle row
  let data = null;
  let hostedOpen = false; // Running now's row for GitHub's runners opens to a row per job, on a click only
  const list = h('nav', { class: 'ci-list', 'aria-label': 'Schemes with CI' });
  const detail = h('div', { class: 'ci-detail' }, h('p', { class: 'muted' }, 'Reading CI…'));
  const el = h('section', { class: 'ci-page' }, h('div', { class: 'ci-split' }, list, detail));
  const draw = () => {
    const now = data.now;
    const schemes = data.schemes;
    if (!schemes.length) {
      list.replaceChildren();
      detail.replaceChildren(h('p', { class: 'muted' }, 'No scheme you can see has CI on GitHub yet.'));
      return;
    }
    const s = schemes.find((x) => x.id === picked) ?? schemes[0];
    const rows = schemes.map((x) => {
      const st = stateOf(x, now);
      const n = x.problems.length;
      return h('button', { type: 'button', class: `ci-li${x === s ? ' on' : ''}`, 'data-state': st, 'aria-current': x === s ? 'true' : null, onclick: () => { picked = x.id; draw(); } },
        h('span', { class: `dot ${st}` }), h('span', { class: 'ci-li-name' }, x.name),
        h('span', { class: 'ci-li-state muted' }, n ? `${n} problem${n === 1 ? '' : 's'}, ${STATE_WORDS[st]}` : STATE_WORDS[st]));
    });
    // The toggle (phones only, by CSS) lists the hidden all-clear names, so every scheme stays in view.
    const hidden = schemes.filter((x) => x !== s && stateOf(x, now) === 'ready');
    list.classList.toggle('greens-open', greensOpen);
    list.replaceChildren(...rows, hidden.length ? h('button', { type: 'button', class: 'ci-more', 'aria-expanded': String(greensOpen), onclick: () => { greensOpen = !greensOpen; draw(); list.querySelector('.ci-more')?.focus(); } },
      h('span', { class: 'dot ready' }), h('span', { class: 'ci-li-name' }, greensOpen ? 'Hide all clear' : `${hidden.length} all clear`),
      h('span', { class: 'ci-li-state muted' }, greensOpen ? '' : hidden.map((x) => x.name).join(', '))) : '');
    const tabs = [['overview', 'Overview'], ['runs', 'Runs'], ['runners', 'Runners']];
    detail.replaceChildren(
      h('div', { class: 'ci-head' }, h('h3', {}, s.name), ext(`https://github.com/${s.view.slug}/actions`, `${s.view.slug} on GitHub`),
        h('span', { class: 'muted small' }, `read ${ago(s.view.at)}`)),
      h('div', { class: 'ci-tabs', role: 'tablist' }, ...tabs.map(([k, label]) =>
        h('button', { type: 'button', role: 'tab', 'aria-selected': String(tab === k), class: tab === k ? 'on' : '', onclick: () => { tab = k; draw(); } }, label))),
      ...(tab === 'overview' ? overview(s, Date.now(), { hostedOpen, toggleHosted: () => { hostedOpen = !hostedOpen; draw(); detail.querySelector('.ci-now-more')?.focus(); } })
        : tab === 'runs' ? [h('section', { class: 'ci-block' }, h('h4', {}, 'Recent runs'), s.view.runs.length ? h('div', { class: 'ci-runs' }, ...s.view.runs.map(runRow)) : h('p', { class: 'muted' }, 'No runs in the last day.'))]
          : runners(s, data.pcs)));
  };
  let tried = false;
  const load = async () => {
    if (tried && !el.isConnected) return;
    tried = true;
    try {
      data = await api('api/ci');
      draw();
    } catch (err) {
      if (!data) detail.replaceChildren(h('p', { class: 'error' }, `Couldn't read CI: ${err.message}`));
    }
    setTimeout(load, REFRESH_MS);
  };
  load();
  return el;
}

// The chips (the overview's and the top bar's) share one read a minute.
const chips = new Set();
let chipTimer = null;
// What the last read said, drawn on a new chip at once: a chip that waits for its own read pops in beside the usage bar (#989).
let chipRead = null;
const paintChip = (c, { hidden, title, worst }) => {
  c.hidden = hidden;
  c.dataset.placed = '1';
  c.title = title;
  c.setAttribute('aria-label', title || 'CI');
  c.querySelector('.dot').className = `dot ${worst}`;
};
async function readChips() {
  chipTimer = null;
  for (const c of chips) if (c.dataset.placed && !c.isConnected) chips.delete(c);
  if (!chips.size) return;
  try {
    const { schemes, pcs, now } = await api('api/ci');
    const worst = schemes.reduce((w, s) => (RANK[stateOf(s, now)] > RANK[w] ? stateOf(s, now) : w), pcs.some(trouble) ? 'fix' : 'ready');
    const ringing = schemes.reduce((n, s) => n + s.problems.filter((x) => !x.quiet).length, 0);
    const quiet = schemes.reduce((n, s) => n + s.problems.filter((x) => x.quiet).length, 0);
    const title = schemes.length ? `CI: ${ringing ? `${ringing} need${ringing === 1 ? 's' : ''} a person` : 'nothing needs a person'}${quiet ? `, ${quiet} being handled` : ''}${pcs.some(trouble) ? `; ${pcs.filter(trouble).map(trouble).join('; ')}` : ''}` : '';
    chipRead = { hidden: !schemes.length, title, worst };
    for (const c of chips) paintChip(c, chipRead);
  } catch {
    // The last colour stays: the next minute asks again.
  }
  chipTimer = setTimeout(readChips, 60_000);
}

/** The CI chip: a dot and "CI", opening the page for the scheme on screen (or `projectId`). Hidden until a scheme with CI is there. */
export function ciChip(projectId = null) {
  const c = h('a', { class: 'ci-chip', hidden: true, href: projectId ? `#/p/${projectId}/ci` : '#/',
    onclick: () => { const id = projectId ?? view?.projectId ?? localStorage.getItem(LAST_SCHEME); c.href = id ? `#/p/${id}/ci` : '#/'; } },
  h('span', { class: 'dot asleep' }), h('span', { class: 'label' }, 'CI'));
  chips.add(c);
  if (chipRead) paintChip(c, chipRead);
  if (projectId === null) c.dataset.placed = '1';
  if (chipTimer) clearTimeout(chipTimer);
  chipTimer = setTimeout(readChips, 0);
  return c;
}
