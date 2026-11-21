// The CI page (#968, Cara 2026-11-18: "maybe mandate could link to a ci status/issues page within citadel"; layout B,
// "Scheme list on the left, detail on the right", with "the CI box performance page from machines" in it): every
// scheme with CI. Overview: its open problems with what, why and the fix, each workflow's verdict on main, its runners and
// what they run, the queue, and the CI desktop's load (collapsed); History: recent runs (#1019). It reads /api/ci
// (src/ci-health.ts snapshot) and changes nothing. The CI chip beside Releases (and the top bar's) opens it, its dot the worst it shows.
import { ago, api, h, icon, view, pacificStamp } from './base.js';
import { hostLoadBlock } from './ci-host.js';
import { emptyCard, hueRow, showFirst, statTiles, toneChip } from './look.js';
import { settingsRow } from './settings.js';
import { pcCard, pcWord, trouble, troubleLine } from './ci-desktop.js';
import { readHealth, testHealth } from './ci-health.js';
import { numbersTab, readNumbers } from './ci-numbers.js';
import { shortSpan } from './releasemath.js';
import { LAST_SCHEME } from './sidebar.js';
import { scopedPageHash } from './page-scope.js';
import { usage } from './core.js';
import { rowBar, rowState } from './threadstate.js';
import { progressTrack, waitBar } from './wait.js';
import { loadingLine, tabs as uiTabs } from './ui/state.js';
import { canBack, canForward, goBack, goForward } from './navstack.js';
import { allSchemes, closeReleases, opening, onReleasesRedraw, releasesLoaded, releasesPage, releaseTrouble, setReleasesPage, targetNames } from './releases.js';
import { DOT as STATUS_DOT, RANK as STATUS_RANK, statusPane, WORD as STATUS_WORD } from './status.js';

const REFRESH_MS = 30_000;
const when = pacificStamp;
const ext = (href, text) => h('a', { href, target: '_blank', rel: 'noopener' }, text);

/** A scheme's state: down (something rings), fix (quiet items), ready (all clear), asleep (no read for 20 min). */
function stateOf(s, now) {
  if (s.problems.some((x) => !x.quiet)) return 'down';
  if (s.problems.length) return 'fix';
  return now - s.view.at > 20 * 60_000 ? 'asleep' : 'ready';
}
const DOT_OF = { ok: 'ready', warn: 'fix', danger: 'down', neutral: 'asleep' };
const STATE_WORDS = { down: 'needs a person', fix: 'being handled', ready: 'all clear', asleep: 'not read lately' };
const RANK = { down: 3, fix: 2, asleep: 1, ready: 0 };

/**
 * The fix minion, the first thing a red's card shows (#1078; Josh, 2026-11-19: "CI errors should very obviously show the minion
 * that is fixing the issue and maybe even a progress report"): the minions list's row (its number, title, state chip and plan track),
 * its latest line and how long it has been on it, the re-run that tests its fix, all linking to its chat; or a toned notice that none
 * has started and when that rings. Its lines are always there and its bar keeps its height, so a live read moves nothing.
 */
export function fixBox(x, now = Date.now()) {
  const t = x.fixTicket;
  if (!t) {
    const n = x.noFix;
    return h('div', { class: `ci-fix none${n.late ? ' late' : ''}` },
      h('b', {}, n.late ? 'No fix minion started' : 'No fix minion yet'),
      h('div', { class: 'muted' }, n.late ? 'This is ringing now: ask the Taskmaster to start one.' : `If none starts, this rings at ${when(n.ringsAt)}.`));
  }
  const st = rowState(t, usage, now);
  const barOf = rowBar(t, st);
  // The bar's and the re-run's room are kept whether or not they show, so a read that adds or drops one moves nothing.
  const bar = (barOf && (progressTrack(barOf) || waitBar(barOf))) || h('div', { class: 'ci-fix-gap' });
  const closed = t.status === 'closed';
  const line = (closed ? t.note : t.status === 'running' ? t.last_activity : t.note || t.last_activity) || (st.rank === 1 ? 'Working…' : st.label);
  const on = closed ? `closed ${ago(t.closed_at ?? t.updated_at)}` : `on it for ${shortSpan(now - t.created_at)}`;
  const re = x.rerun;
  return h('div', { class: `ci-fix f-${st.fam || 'none'}${closed ? ' closed' : ''}`, title: st.label },
    h('div', { class: 'ci-fix-top' },
      h('a', { class: 'ci-fix-link', href: `#/p/${t.project_id}/t/${t.number}` }, h('span', { class: 'num' }, `#${t.number}`), ' ', t.title),
      h('span', { class: `state${st.quiet ? ' quiet' : ''}` }, st.pulse ? h('i', { class: 'pulse' }) : st.quiet ? h('i', { class: 'still' }) : '', st.cell || st.label)),
    h('div', { class: 'ci-fix-line muted' }, `${line} · ${on}`),
    bar,
    h('div', { class: 'ci-fix-rerun' }, !re ? '' : re.state === 'running' ? `Re-running on ${re.sha}` : re.state === 'failed' ? `The re-run on ${re.sha} failed` : `Waiting for a person to re-run on ${re.sha}`,
      re?.url ? [' · ', ext(re.url, 'the run')] : ''));
}

const verdictClass = (c) => (c === 'success' ? 'ready' : c === 'failure' ? 'down' : c ? 'asleep' : 'running');

/** The minion a run or queued job tests (#1019): its chat, or what the run is when no minion's change is in it (a schedule, main itself). An older view has no `who`: its branch. */
const whoCell = (x) => x.who?.href ? h('a', { class: 'ci-run-who', href: x.who.href, title: x.who.label }, x.who.label)
  : h('span', { class: 'ci-run-who muted' }, x.who?.label ?? x.branch ?? '');

/** A run's row; `quiet` (a workflow in the scheme's quiet list, TWIReader #990) greys it and tags it, its result kept. */
function runRow(r, quiet = false) {
  const word = r.status === 'completed' ? r.conclusion ?? 'done' : r.status.replace('_', ' ');
  return h('div', { class: `ci-run${quiet ? ' ci-quiet' : ''}`, title: `${r.name} on ${r.branch}: ${word}, ${when(r.at)}${quiet ? ". Quiet: in the scheme's quiet CI workflows, so its red rings no one" : ''}` },
    h('span', { class: `dot ${quiet ? 'asleep' : verdictClass(r.status === 'completed' ? r.conclusion : null)}` }),
    h('span', { class: `ci-run-word${quiet ? ' muted' : ''}` }, word),
    ext(r.url, r.name),
    quiet ? h('span', { class: 'ci-run-who' }, h('span', { class: 'ci-tag' }, 'quiet'), ' ', whoCell(r)) : whoCell(r),
    h('span', { class: 'ci-run-age muted' }, ago(Date.parse(r.at))));
}

const GENERIC = /^(self-hosted|windows|linux|macos|x64|arm64)$/i;
const labelName = (ls) => ls.filter((l) => !GENERIC.test(l)).join(', ') || ls.join(', ');
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;


/** A block of the overview in Citadel's look (#1068): a heading in its hue over a box of rows that open, as Host load is. */
const block = (title, hue, cls, ...rows) => h('section', { class: `ci-block ${cls}` }, h('h3', { class: 'settings-section', 'data-hue': hue }, title), h('div', { class: 'settings-rows' }, ...rows));
const tones = (...cs) => cs.filter(Boolean);
/** Who a run or job tests, as plain text beside its name (a link when it is a minion's chat). */
const whoText = (x) => x.who?.href ? h('a', { href: x.who.href, title: x.who.label }, x.who.label) : h('span', { class: 'muted' }, x.who?.label ?? x.branch ?? '');
const age = (t) => ago(typeof t === 'number' ? t : Date.parse(t));

/** Open problems: what happened, why, the fix, and whether it rings. */
function problemsBlock(s) {
  const ring = s.problems.filter((x) => !x.quiet).length, quiet = s.problems.length - ring;
  const [row] = settingsRow({ key: `ci-problems-${s.id}`, icon: 'shield', hue: ring ? 'danger' : quiet ? 'held' : 'done', title: 'Open problems', open: ring > 0,
    summary: s.problems.length ? tones(ring && toneChip('danger', `${ring} ring${ring === 1 ? 's' : ''}`), quiet && toneChip('warn', `${quiet} quiet`)) : [toneChip('ok', 'None'), 'nothing needs fixing'] },
  s.problems.length ? statTiles([String(ring), 'ring a person', ring ? 'danger' : 'done'], [String(quiet), 'being handled', quiet ? 'held' : 'done']) : null,
  s.problems.length ? h('div', { class: 'hue-rows' }, ...s.problems.map((x) => hueRow({ hue: x.quiet ? 'held' : 'danger', lead: x.quiet ? 'quiet' : 'rings' },
    h('strong', {}, x.title.replace(/^CI(, [^:]+)?: /, '')),
    x.fixTicket || x.noFix ? fixBox(x) : '',
    x.why ? h('span', { class: 'ci-detail-line' }, h('span', { class: 'muted' }, 'Why: '), x.why) : '',
    x.fix ? h('span', { class: 'ci-detail-line' }, h('span', { class: 'muted' }, 'Fix: '), x.fix) : '',
    // The line is always there, so a link arriving moves nothing (#992).
    x.fixTicket || x.noFix ? '' : h('span', { class: 'ci-detail-line ci-problem-link' }, x.link ? [h('span', { class: 'muted' }, x.link.kind === 'minion' ? 'Fix minion: ' : 'Heard by: '),
      h('a', { href: x.link.href }, x.link.label), x.link.closed ? h('span', { class: 'muted' }, ' (closed)') : ''] : '')))) 
    : emptyCard('Nothing needs fixing', 'A red run or a stuck runner shows here with why and the fix.'));
  return block('Open problems', ring ? 'danger' : quiet ? 'held' : 'done', 'ci-problems', row);
}

/** Each workflow's verdict on the branch. */
function verdictsBlock(v) {
  const ws = v.workflows;
  const state = (w) => (!w.verdict ? 'none' : w.verdict.status !== 'completed' ? 'running' : w.verdict.conclusion === 'success' ? 'ok' : w.verdict.conclusion === 'failure' ? 'bad' : 'other');
  const bad = ws.filter((w) => state(w) === 'bad' && !w.quiet).length, going = ws.filter((w) => state(w) === 'running').length, ok = ws.filter((w) => state(w) === 'ok').length;
  const item = (w) => {
    if (!w.verdict) return hueRow({ hue: 'held', lead: 'none' }, w.name, ' ', h('span', { class: 'muted' }, 'no verdict'));
    const r = w.verdict, st = state(w);
    const word = r.status === 'completed' ? r.conclusion ?? 'done' : r.status.replace('_', ' ');
    return hueRow({ hue: w.quiet ? 'held' : { running: 'running', ok: 'done', bad: 'danger' }[st] ?? 'held', lead: word, meta: age(r.at) },
      ext(r.url, w.name), w.quiet ? [' ', toneChip('neutral', 'quiet')] : '', ' · ', whoText(r),
      w.skipped.length ? h('span', { class: 'ci-detail-line muted' }, `Green, but skipped ${w.skipped.join(', ')}, which ran in the verdict before it.`) : '');
  };
  const [tone, word] = bad ? ['danger', `${bad} failing`] : going ? ['info', `${going} running`] : ok ? ['ok', 'Green'] : ['neutral', 'No verdict'];
  const [row] = settingsRow({ key: `ci-verdicts-${v.slug}`, icon: 'check', hue: bad ? 'danger' : going ? 'running' : 'done', title: `Verdicts on ${v.branch}`,
    summary: [toneChip(tone, word), `${ok} of ${ws.length} workflows green`] },
  statTiles([String(ok), 'green', 'done'], bad && [String(bad), 'failing', 'danger'], going && [String(going), 'running', 'running']),
  ws.length ? showFirst({ key: `ci-verdicts-${v.slug}`, items: ws.map(item), n: 6, noun: 'workflows' }) : emptyCard('No workflows', 'This repo has none that report here.', { mark: '·', hue: 'muted' }));
  return block('Verdicts', bad ? 'danger' : 'done', 'ci-verdicts', row);
}

/** The queue per set of labels, for Running now's header: "peek-auras-ci: 1 runner, 9 queued". */
const queueWords = (q) => `${labelName(q.labels)}: ${q.runners ? `${plural(q.runners, 'runner')}, `
  : q.runners === 0 && q.labels.some((l) => /^self-hosted$/i.test(l)) ? 'no runner online, ' : ''}${q.jobs} queued`;

/**
 * Running now (Cara, 2026-11-18: "Could we make this page show what is running on the CI?"): a row per self-hosted runner, busy
 * with which job for which minion and for how long, idle or offline, then one row for GitHub's own runners that opens to a row per
 * job. Rows are per runner, not per job, so the section keeps its height as jobs come and go between reads.
 */
function runningBlock(s, now, ui) {
  const v = s.view;
  const running = v.running ?? [];
  const own = v.runners ?? [];
  const names = new Set(own.map((r) => r.name));
  const jobCell = (j) => [ext(`https://github.com/${v.slug}/actions/runs/${j.run}`, j.name), ' · ', whoText(j)];
  const since = (j) => (j ? shortSpan(now - Date.parse(j.since)) : null);
  const rows = own.map((r) => {
    const j = running.find((x) => x.runner === r.name);
    const word = r.status === 'offline' ? 'offline' : j || r.busy || r.job ? 'busy' : 'idle';
    return { word, el: hueRow({ hue: { offline: 'danger', busy: 'running', idle: 'done' }[word], lead: word, meta: since(j) },
      h('strong', { title: `${r.name}: ${r.labels.join(', ')}` }, r.name), ' ',
      j ? jobCell(j) : h('span', { class: 'muted' }, word === 'offline' ? (r.offlineSince ? `since ${when(r.offlineSince)}` : 'offline')
        : r.job ?? (word === 'busy' ? 'a job from an older run' : 'waiting for work'))) };
  });
  const count = (w) => rows.filter((r) => r.word === w).length;
  // GitHub's own runners (and every runner, when the repo's can't be listed): one row, opened by a click to a row per job.
  const theirs = running.filter((j) => !names.has(j.runner));
  const where = v.runners === null ? 'Runners' : "GitHub's runners";
  const items = rows.map((r) => r.el);
  items.push([hueRow({ hue: theirs.length ? 'running' : 'done', lead: theirs.length ? `${theirs.length} running` : 'none',
    meta: theirs.length ? h('button', { type: 'button', class: 'secondary small ci-now-more', 'aria-expanded': String(ui.hostedOpen), onclick: ui.toggleHosted }, ui.hostedOpen ? 'Hide jobs' : 'Show jobs') : null },
  h('strong', {}, where), ' ', h('span', { class: 'muted' }, theirs.length ? (ui.hostedOpen ? '' : theirs.map((j) => j.name).join(', ')) : 'nothing running')),
  // Its opened jobs are part of the same item, so "Show all" never cuts them off the row that opened them.
  ...(ui.hostedOpen ? theirs.map((j) => hueRow({ hue: 'running', lead: 'running', meta: since(j) }, h('strong', { title: j.runner }, j.runner), ' ', jobCell(j))) : [])]);
  const queues = v.queues ?? [];
  const head = queues.length ? queues.map(queueWords).join(' · ') : 'nothing queued';
  // The Runners tab's notes (#1019: runners moved onto Overview), for a repo whose runners can't be listed or that has none.
  const note = v.runners === null ? "CI health can't list this repo's runners: it needs a repo admin's linked GitHub."
    : !own.length ? "No self-hosted runners; jobs run on GitHub's." : '';
  const busy = count('busy') + theirs.length, off = count('offline');
  const [tone, word] = off ? ['warn', `${off} offline`] : busy ? ['info', `${busy} busy`] : ['ok', 'Idle'];
  const [row] = settingsRow({ key: `ci-running-${s.id}`, icon: 'box', hue: busy ? 'running' : 'done', title: 'Runners and what they run', summary: [toneChip(tone, word), head] },
    statTiles([String(busy), 'busy', 'running'], [String(count('idle')), 'idle', 'done'], off && [String(off), 'offline', 'danger']),
    showFirst({ key: `ci-running-${s.id}`, items, n: 6, noun: 'runners' }),
    note ? h('p', { class: 'look-prose' }, note) : null);
  return block('Running now', 'running', 'ci-running', row);
}

/** A scheme's one line about the desktops its runners are on, linking to each one's row in the list (Josh, 2026-11-19: the load lives at the list's bottom, not in each scheme). */
function runsOn(s, pcs, ui) {
  const mine = pcs.filter((pc) => pc.projects.includes(s.id));
  if (!mine.length) return '';
  return h('p', { class: 'ci-runs-on muted' }, 'Runs on ', ...mine.flatMap((pc, i) => [i ? ', ' : '', h('button', { type: 'button', class: 'link', onclick: () => ui.openPc(pc.host) }, pc.host), ` · ${pcWord(pc)[1]}`]));
}

const waitItem = (j, slug) => hueRow({ hue: 'waiting', lead: 'queued', meta: age(j.since) },
  h('span', { title: `${j.name}, for a runner with ${j.labels.join(', ')}, queued ${when(j.since)}` }, ext(`https://github.com/${slug}/actions/runs/${j.run}`, j.name)), ' · ', whoText(j));

/** The queue in its order, adjacent jobs for one minion (or, with none, one kind of run) as one group (#1019, Cara: "sequential queued jobs for the same minion could be grouped"). */
function queueGroups(waiting) {
  const groups = [];
  for (const j of waiting) {
    const key = j.who?.href ?? j.who?.label ?? j.branch ?? '';
    if (groups.at(-1)?.key === key) groups.at(-1).jobs.push(j);
    else groups.push({ key, jobs: [j] });
  }
  return groups;
}

/** A group's rows: one job as it is; several as one row (count, minion, labels, oldest wait) that opens to each job on a click. */
function queueRows(g, slug, ui) {
  const [first] = g.jobs;
  if (g.jobs.length === 1) return [waitItem(first, slug)];
  const id = `${g.key}:${first.run}:${first.name}`, open = ui.queueOpen.has(id);
  const labels = [...new Set(g.jobs.flatMap((j) => j.labels))].join(', ');
  const oldest = Math.min(...g.jobs.map((j) => Date.parse(j.since)));
  const row = hueRow({ hue: 'waiting', lead: 'queued', meta: ago(oldest) },
    h('button', { type: 'button', class: 'secondary small queue-toggle', 'aria-expanded': String(open), 'data-group': id, onclick: () => ui.toggleQueue(id),
      title: `${g.jobs.length} jobs for a runner with ${labels}, the oldest queued ${when(new Date(oldest).toISOString())}` }, `${g.jobs.length} jobs ${open ? '▴' : '▾'}`),
    ' ', whoText(first), h('span', { class: 'ci-detail-line muted' }, `${g.jobs.map((j) => j.name).join(', ')} · on ${labels}`));
  return [row, ...(open ? g.jobs.map((j) => h('div', { class: 'queue-sub' }, waitItem(j, slug))) : [])];
}

function waitingBlock(s, now, ui) {
  const v = s.view, n = v.waiting.length;
  const oldest = n ? Math.min(...v.waiting.map((j) => Date.parse(j.since))) : 0;
  const groups = queueGroups(v.waiting);
  const [row] = settingsRow({ key: `ci-waiting-${s.id}`, icon: 'rows', hue: n ? 'waiting' : 'done', title: 'Waiting for a runner',
    summary: n ? [toneChip('warn', `${n} waiting`), `oldest ${shortSpan(now - oldest)}`] : [toneChip('ok', 'Nobody'), 'no job is waiting'] },
  n ? statTiles([String(n), 'jobs queued', 'waiting'], [shortSpan(now - oldest), 'oldest wait', 'waiting']) : null,
  n ? showFirst({ key: `ci-waiting-${s.id}`, items: groups.map((g) => queueRows(g, v.slug, ui)), n: 5, noun: 'groups', wrap: (rows) => h('div', { class: 'hue-rows' }, ...rows.flat()) })
    : emptyCard('No job is waiting', 'Jobs queue here when every runner is busy.'));
  return block('Waiting for a runner', n ? 'waiting' : 'done', 'ci-waiting', row);
}

function overview(s, pcs, now, ui) {
  return [problemsBlock(s), verdictsBlock(s.view), runningBlock(s, now, ui), waitingBlock(s, now, ui), runsOn(s, pcs, ui), pcs.length ? '' : hostLoadBlock(ui.host)];
}

// ---------- the Releases page (#1423) ----------

/**
 * Which problems hold up deploys (the Releases button's dot) and which are CI's own (the CI button's), Cara 2026-11-21: "the
 * releases status indicator would show if there is an issue with test failures or other things stopping deployments, CI
 * indicates issues with runners being down or overworked". A red on the branch and a still ship line hold up deploys; stuck,
 * hung or unstarted jobs and a ship gate fallen back to perigee are CI's, as is any kind not named here (docs/adr/0023).
 */
export const holdsDeploys = (x) => x.key.startsWith('red:') || x.key === 'land:slow';
const ciSide = (s) => ({ ...s, problems: s.problems.filter((x) => !holdsDeploys(x)) });

const TABS = [['releases', 'Releases'], ['overview', 'Overview'], ['history', 'History'], ['health', 'Test health'], ['numbers', 'Numbers'], ['status', 'Status']];
const CI_TABS = new Set(['overview', 'history', 'health', 'numbers']);
/** The tab an address names: Runs is History and Runners joined Overview (#1019), so their old links land where those now are. */
export const tabOf = (t) => (t === 'runs' ? 'history' : t === 'runners' ? 'overview' : TABS.some(([k]) => k === t) ? t : 'releases');
/** The page's address for `scope` and `tab`: what a click on its list or tabs goes to, so Back steps through them. */
export const releasesHash = (projectId, scope, tab = 'releases') => `#/p/${projectId}/releases/${scope}${tab === 'releases' ? '' : `/${tab}`}`;

let ciRead = null; // the last /api/ci read, the page's or the chips', so a page opened again draws at once
let hostRead = null;
let shell = null; // the open page
let pending = null; // where the next page built opens

/** Point the page at `scope` (a scheme's id or 'all') on `tab`: the open one when it's this scheme's (true), else the next one built. */
export function goReleases(projectId, { scope, tab = 'releases', hl = null }) {
  pending = { projectId, scope, tab, hl };
  setReleasesPage(scope, hl);
  if (!shell?.el.isConnected || shell.projectId !== projectId) return false;
  shell.go(pending);
  return true;
}

/**
 * The Releases page (#1423; Cara, 2026-11-21: "combine Releases and CI into one button ... the all schemes with their CI status on
 * the left ... then the tabs of CI on the right, but the main page would be the page we currently call releases", and Status as a
 * tab too): the list of schemes on the left on every tab, each row's dot that tab's signal; on the right Releases, the CI tabs and
 * Status for the scheme picked. It opens on the scheme it was opened from; only Home's links open All (#1282).
 */
export function releasesShell() {
  const o = pending ?? { projectId: view.projectId, scope: view.projectId, tab: 'releases' };
  pending = null;
  const projectId = o.projectId;
  let scope = o.scope, tab = o.tab, pc = null; // pc: a desktop picked in the list, its load in place of the tabs
  const health = new Map(); // scheme id -> its Test health read, kept so the tab doesn't blank on a redraw
  const numbers = new Map(); // scheme id -> its Numbers read (#1369), kept the same way
  const read = (cache, fetch) => async (id) => { try { cache.set(id, await fetch(id)); } catch { cache.set(id, { error: true }); } draw(); };
  const readers = { health: read(health, readHealth), numbers: read(numbers, readNumbers) };
  const readTab = () => typeof scope === 'number' && readers[tab]?.(scope);
  let greensOpen = false; // phones: the all-clear schemes sit behind a toggle row
  let hostedOpen = false; // Running now's row for GitHub's runners opens to a row per job, on a click only
  const queueOpen = new Set(); // the queue's groups opened by a click
  let statusData = null; // the Status tab's last read, for the list's dots on that tab
  const relEl = releasesPage(); // kept: Releases' own redraws fill it, and a drag in its land line survives the list's
  const holdsEl = h('div', { class: 'rel-holds' });
  const statusEl = statusPane((d) => { statusData = d; if (tab === 'status') drawList(); });
  const go = (to, t = tab) => { location.hash = releasesHash(projectId, to, t); };
  const close = (cls, name) => h('button', { type: 'button', class: `close-view ${cls}`, 'aria-label': 'Close', title: 'Close', onclick: closeReleases }, icon(name));
  const title = h('span', { class: 'wide-only' });
  const head = h('div', { class: 'ticket-head rel-head' },
    h('div', { class: 'row' }, close('narrow-only', 'back'), h('h2', {}, 'Releases', title),
      h('span', { class: 'spacer' }),
      h('span', { class: 'head-nav' },
        h('button', { type: 'button', class: 'nav-btn nav-back', title: 'Back', 'aria-label': 'Back', disabled: !canBack(), onclick: goBack }, icon('back')),
        h('button', { type: 'button', class: 'nav-btn nav-forward', title: 'Forward', 'aria-label': 'Forward', disabled: !canForward(), onclick: goForward }, icon('forward')),
        close('wide-only', 'close'))));
  const list = h('nav', { class: 'ci-list', 'aria-label': 'Schemes' });
  const tabsEl = h('div');
  const body = h('div', { class: 'rel-tab' });
  const detail = h('div', { class: 'ci-detail' }, tabsEl, body);
  const el = h('section', { class: 'releases-main', onkeydown: (e) => { if (e.key === 'Escape' && !e.defaultPrevented) closeReleases(); } },
    head, h('div', { class: 'ci-page' }, h('div', { class: 'ci-split' }, list, detail)));

  const nameOf = (id) => ciRead?.schemes.find((x) => x.id === id)?.name ?? view?.projects?.find((p) => p.id === id)?.name ?? `Scheme ${id}`;
  /** Every scheme the list shows: CI's in its order, then any that ships or has an app without CI, and the one opened. */
  const ids = () => {
    const out = (ciRead?.schemes ?? []).map((x) => x.id);
    for (const id of [...allSchemes(), ...(statusData?.apps ?? []).map((a) => a.scheme), projectId]) if (typeof id === 'number' && !out.includes(id)) out.push(id);
    return out;
  };
  /** A row's dot and line on the open tab: Releases' holds, CI's own problems, or the worst of its Status pane. */
  const rowOf = (id) => {
    const s = ciRead?.schemes.find((x) => x.id === id);
    const words = (st, n, noun = 'problem') => (n ? `${n} ${noun}${n === 1 ? '' : 's'}, ${STATE_WORDS[st]}` : STATE_WORDS[st]);
    if (tab === 'status') {
      if (!statusData) return { st: 'none', line: '' };
      const apps = statusData.apps.filter((a) => a.scheme === id);
      const v = [statusData.citadel.verdict, ...apps.map((a) => a.verdict)].reduce((w, x) => (STATUS_RANK[x.tone] > STATUS_RANK[w.tone] ? x : w));
      return { st: STATUS_DOT[v.tone], line: apps.length ? `${apps.length} app${apps.length === 1 ? '' : 's'} · ${STATUS_WORD[v.tone]}` : `no app · ${STATUS_WORD[v.tone]}` };
    }
    if (CI_TABS.has(tab)) {
      if (!s) return { st: 'none', line: 'no CI' };
      const c = ciSide(s), st = stateOf(c, ciRead.now);
      return { st, line: words(st, c.problems.length) };
    }
    const held = s ? s.problems.filter(holdsDeploys) : [];
    const more = releaseTrouble(id);
    const st = held.some((x) => !x.quiet) ? 'down' : held.length || more.length ? 'fix' : 'ready';
    return { st, line: held.length + more.length ? words(st, held.length + more.length, 'hold') : targetNames(id) || 'all clear' };
  };
  const worst = (sts) => sts.reduce((w, x) => (RANK[x] > (RANK[w] ?? -1) ? x : w), 'ready');

  const drawList = () => {
    const shown = ids().map((id) => ({ id, ...rowOf(id) }));
    const pick = (to) => () => { pc = null; if (to === scope) draw(); else go(to, to === 'all' && CI_TABS.has(tab) ? 'releases' : tab); };
    const row = ({ id, st, line }) => h('button', { type: 'button', class: `ci-li${id === scope && !pc ? ' on' : ''}`, 'data-state': st, 'data-scheme': id, 'aria-current': id === scope && !pc ? 'true' : null, onclick: pick(id) },
      h('span', { class: `dot ${st}` }), h('span', { class: 'ci-li-name' }, nameOf(id)), h('span', { class: 'ci-li-state muted' }, line));
    // All (Home's view, #1282): one row at the top, its dot the worst below it.
    const allRow = h('button', { type: 'button', class: `ci-li ci-all${scope === 'all' && !pc ? ' on' : ''}`, 'data-state': worst(shown.map((x) => x.st)), 'aria-current': scope === 'all' && !pc ? 'true' : null, onclick: pick('all') },
      h('span', { class: `dot ${worst(shown.map((x) => x.st))}` }), h('span', { class: 'ci-li-name' }, 'All schemes'), h('span', { class: 'ci-li-state muted' }, `${shown.length} schemes`));
    // Phones: the all-clear schemes and ones with nothing on this tab sit behind a toggle row that names them.
    const hidden = shown.filter((x) => x.id !== scope && (x.st === 'ready' || x.st === 'none'));
    list.classList.toggle('greens-open', greensOpen);
    // A desktop in trouble turns the CI dot yellow: it leads the list, its words the chip tooltip's.
    const pcs = ciRead?.pcs ?? [];
    const why = pcs.filter(trouble).map((x) => h('button', { type: 'button', class: 'ci-li ci-why', 'data-tone': 'warn', title: x.verdict.text, onclick: () => { pc = x.host; draw(); } },
      h('span', { class: 'dot fix' }), h('span', { class: 'ci-li-name' }, troubleLine(x)), h('span', { class: 'ci-li-state ci-why-text' }, x.verdict.text)));
    // The desktops at the list's bottom: a toned word each, the load view in the right pane (Josh, 2026-11-19).
    const pcRows = pcs.length ? [h('div', { class: 'ci-list-head' }, 'Desktops'), ...pcs.map((x) => {
      const [tone, word] = pcWord(x);
      return h('button', { type: 'button', class: `ci-li ci-pc${x.host === pc ? ' on' : ''}`, 'data-host': x.host, 'aria-current': x.host === pc ? 'true' : null, onclick: () => { pc = x.host; draw(); } },
        h('span', { class: `dot ${DOT_OF[tone]}` }), h('span', { class: 'ci-li-name' }, x.host), h('span', { class: 'ci-li-state' }, toneChip(tone, word)));
    })] : [];
    list.replaceChildren(...why, allRow, ...shown.map(row), hidden.length ? h('button', { type: 'button', class: 'ci-more', 'aria-expanded': String(greensOpen), onclick: () => { greensOpen = !greensOpen; drawList(); list.querySelector('.ci-more')?.focus(); } },
      h('span', { class: 'dot ready' }), h('span', { class: 'ci-li-name' }, greensOpen ? 'Hide' : `${hidden.length} more`),
      h('span', { class: 'ci-li-state muted' }, greensOpen ? '' : hidden.map((x) => nameOf(x.id)).join(', '))) : '', ...pcRows);
  };

  /** Releases' own holds above its cards: CI's reds and a still ship line, and changes stuck or failed, so its dot's why is on its tab. */
  const holds = () => {
    const s = typeof scope === 'number' ? ciRead?.schemes.find((x) => x.id === scope) : null;
    const held = s ? s.problems.filter(holdsDeploys) : [];
    const more = typeof scope === 'number' ? releaseTrouble(scope) : [];
    if (!held.length && !more.length) return [];
    return [held.length ? problemsBlock({ ...s, problems: held }) : '',
      more.length ? block('Held up', 'held', 'rel-held', h('div', { class: 'hue-rows' }, ...more.map((t) => hueRow({ hue: 'held', lead: 'held' }, t)))) : ''];
  };

  const draw = () => {
    title.textContent = ` · ${scope === 'all' ? 'All schemes' : nameOf(scope)}`;
    drawList();
    const s = typeof scope === 'number' ? ciRead?.schemes.find((x) => x.id === scope) : null;
    if (pc) {
      const x = ciRead?.pcs.find((y) => y.host === pc);
      tabsEl.replaceChildren();
      body.replaceChildren(h('div', { class: 'ci-head' }, h('h3', {}, pc), h('span', { class: 'muted small' }, 'CI desktop load')),
        x ? h('div', { class: 'ci-block ci-desktops' }, pcCard(x)) : '', hostLoadBlock(hostRead));
      return;
    }
    // All has no one CI: its tabs are Releases' board and every app's Status. A scheme without CI keeps the CI tabs, each saying so.
    const items = scope === 'all' ? TABS.filter(([k]) => !CI_TABS.has(k)) : TABS;
    if (!items.some(([k]) => k === tab)) tab = 'releases';
    tabsEl.replaceChildren(uiTabs({ items, current: tab, className: 'ci-tabs', onSelect: (k) => go(scope, k) }).element);
    if (tab === 'releases') {
      if (body.firstChild !== holdsEl) body.replaceChildren(holdsEl, relEl);
      holdsEl.replaceChildren(...holds());
      return;
    }
    if (tab === 'status') {
      if (body.firstChild !== statusEl) body.replaceChildren(statusEl);
      statusEl.show(scope);
      return;
    }
    if (!ciRead) return void body.replaceChildren(loadingLine('Reading CI…'));
    if (!s) return void body.replaceChildren(emptyCard(`${nameOf(scope)} has no CI here`, 'A scheme whose repo runs GitHub Actions shows its runs, runners and test health here.', { mark: '·', hue: 'muted' }));
    body.replaceChildren(
      h('div', { class: 'ci-head' }, h('h3', {}, s.name), ext(`https://github.com/${s.view.slug}/actions`, `${s.view.slug} on GitHub`),
        h('span', { class: 'muted small' }, `read ${ago(s.view.at)}`)),
      ...(tab === 'overview' ? overview(s, ciRead.pcs, Date.now(), {
        host: hostRead,
        queueOpen, toggleQueue: (id) => { queueOpen.has(id) ? queueOpen.delete(id) : queueOpen.add(id); draw(); body.querySelector(`.queue-toggle[data-group="${CSS.escape(id)}"]`)?.focus(); },
        hostedOpen, toggleHosted: () => { hostedOpen = !hostedOpen; draw(); body.querySelector('.ci-now-more')?.focus(); },
        openPc: (host) => { pc = host; draw(); },
      })
        : tab === 'health' ? testHealth(s, health.get(s.id) ?? null, readTab)
        : tab === 'numbers' ? numbersTab(s, numbers.get(s.id) ?? null, readTab)
        : [h('section', { class: 'ci-block' }, h('h4', {}, 'Recent runs'), s.view.runs.length ? h('div', { class: 'ci-runs' }, ...s.view.runs.map((r) => runRow(r))) : h('p', { class: 'muted' }, 'No runs in the last day.'))]));
  };

  shell = {
    el, projectId, drawList,
    go: (to) => {
      const moved = to.scope !== scope || to.tab !== tab;
      scope = to.scope; tab = to.tab; pc = null;
      draw();
      if (moved) readTab();
    },
  };
  let tried = false;
  const load = async () => {
    if (tried && !el.isConnected) return;
    tried = true;
    try {
      ciRead = await api('api/ci');
      hostRead = await api('api/host-load').catch(() => hostRead);
      paintChips();
      draw();
    } catch (err) {
      if (!ciRead && CI_TABS.has(tab)) body.replaceChildren(h('p', { class: 'error' }, `Couldn't read CI: ${err.message}`));
    }
    setTimeout(load, REFRESH_MS);
  };
  draw();
  readTab();
  load();
  return el;
}

// The chips (the shelf's and the top bar's): Releases and CI share one /api/ci read a minute, each dot its own side of it.
const chips = new Set();
let chipTimer = null, chipBusy = false; // a chip made while a read runs or is due takes its answer: no second read
const plainCount = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Each chip's dot and words from the last read: CI's runners and desktops, or what holds up deploys (holdsDeploys and the releases' own). */
function chipLook(kind) {
  const r = ciRead;
  if (kind === 'ci') {
    if (!r) return null;
    const { schemes, pcs, now } = r;
    const own = schemes.map(ciSide);
    const worst = own.reduce((w, s) => (RANK[stateOf(s, now)] > RANK[w] ? stateOf(s, now) : w), pcs.some(trouble) ? 'fix' : 'ready');
    const ringing = own.reduce((n, s) => n + s.problems.filter((x) => !x.quiet).length, 0);
    const quiet = own.reduce((n, s) => n + s.problems.filter((x) => x.quiet).length, 0);
    const title = schemes.length ? `CI: ${ringing ? `${ringing} need${ringing === 1 ? 's' : ''} a person` : 'nothing needs a person'}${quiet ? `, ${quiet} being handled` : ''}${pcs.some(trouble) ? `; ${pcs.filter(trouble).map(troubleLine).join('; ')}` : ''}` : '';
    return { hidden: !schemes.length, title, worst };
  }
  if (!r && !releasesLoaded()) return null;
  const held = (r?.schemes ?? []).flatMap((s) => s.problems.filter(holdsDeploys));
  const more = allSchemes().flatMap((id) => releaseTrouble(id));
  const ringing = held.filter((x) => !x.quiet).length;
  const worst = ringing ? 'down' : held.length || more.length ? 'fix' : 'ready';
  const n = held.length + more.length;
  return { hidden: false, worst, title: n ? `Releases: ${plainCount(n, 'thing holds', 'things hold')} up deploys${ringing ? `, ${ringing} need${ringing === 1 ? 's' : ''} a person` : ''}` : 'Releases: nothing holds up deploys' };
}
const paintChip = (c) => {
  const look = chipLook(c.dataset.kind);
  if (!look) return;
  c.hidden = look.hidden;
  c.dataset.placed = '1';
  c.title = look.title;
  c.setAttribute('aria-label', look.title || c.dataset.kind);
  c.querySelector('.dot').className = `dot ${look.worst}`;
};
function paintChips() {
  for (const c of chips) if (c.dataset.placed && !c.isConnected) chips.delete(c);
  for (const c of chips) paintChip(c);
}
// Releases arriving move the Releases dot and the page's list at once, between reads.
onReleasesRedraw(() => { paintChips(); if (shell?.el.isConnected) shell.drawList(); });

async function readChips() {
  chipTimer = null;
  paintChips();
  if (!chips.size) return;
  chipBusy = true;
  try {
    ciRead = await api('api/ci');
    paintChips();
  } catch {
    // The last colour stays: the next minute asks again.
  }
  chipBusy = false;
  chipTimer = setTimeout(readChips, 60_000);
}

function chip(kind, label, page, projectId) {
  const c = h('a', { class: `ci-chip ${kind}-chip`, 'data-kind': kind, hidden: kind === 'ci', href: projectId ? `#/p/${projectId}/${page}` : '#/',
    onclick: () => { opening(); c.href = scopedPageHash(page, projectId ?? view?.projectId, localStorage.getItem(LAST_SCHEME) ?? 2); } },
  h('span', { class: 'dot asleep' }), h('span', { class: 'label' }, label));
  chips.add(c);
  paintChip(c);
  if (projectId === null) c.dataset.placed = '1';
  if (!chipTimer && !chipBusy) chipTimer = setTimeout(readChips, 0);
  return c;
}

/** The CI chip: a dot and "CI", opening the Releases page's Overview for the scheme on screen (or `projectId`). Hidden until a scheme with CI is there. */
export const ciChip = (projectId = null) => chip('ci', 'CI', 'ci', projectId);

/** The Releases chip (#1423): a dot and "Releases", opening the Releases page on its Releases tab; its dot is what holds up deploys. */
export const releasesChip = (projectId = null) => chip('releases', 'Releases', 'releases', projectId);
