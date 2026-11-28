// The CI page (#968, Cara 2026-11-18: "maybe mandate could link to a ci status/issues page within citadel"; layout B,
// "Scheme list on the left, detail on the right", with "the CI box performance page from machines" in it): every
// scheme with CI. Overview: its open problems with what, why and the fix, each workflow's verdict on main, its runners and
// what they run, the queue, and the CI desktop's load (collapsed); History: recent runs (#1019). It reads /api/ci
// (src/ci-health.ts snapshot) and changes nothing. The CI chip beside Releases (and the top bar's) opens it, its dot the worst it shows.
/** @import { CiPool, CiPoolJob, CiRead, CiScheme, CiProblem, CiRun, CiFallback, CiViewData, CiWho, CiWaitingJob, CiRunningJob, CiQueue, CiWorkflow, PcView, HostLoad, ReadFailed, TestHealth, CiNumbersView } from './types/ci.js' */
/** @import { ListedTicket } from './types/list.js' */
/** @import { View, Scheme } from './types.js' */
/** @import { StatusData } from './types/status.js' */
/** @import { Child } from './base.js' */
import { ago, api, h, icon, keepView, view, pacificClockBare, pacificStamp, poller } from './base.js';
import { hostLoadBlock } from './ci-host.js';
import { emptyCard, hueRow, meter, showFirst, statTiles, toneChip } from './look.js';
import { settingsRow } from './settings.js';
import { pcCard, pcWord, runsOnWord, trouble, troubleLine } from './ci-desktop.js';
import { readHealth, testHealth } from './ci-health.js';
import { numbersTab, readNumbers } from './ci-numbers.js';
import { codeTab, readCode } from './code-map.js';
import { flowTab, readFlow } from './work-flow.js';
import { shortSpan } from './releasemath.js';
import { LAST_SCHEME } from './sidebar.js';
import { scopedPageHash } from './page-scope.js';
import { usage } from './core.js';
import { rowBar, rowState, spokenCell } from './threadstate.js';
import { progressTrack, waitBar } from './wait.js';
import { loadingLine, tabs as uiTabs } from './ui/state.js';
import { optimistic } from './ui/optimistic.js';
import { canBack, canForward, goBack, goForward } from './navstack.js';
import { allSchemes, closeReleases, opening, serverScheme, onReleasesRedraw, releasesLoaded, releasesPage, releaseTrouble, setReleasesPage } from './releases.js';
import { DOT as STATUS_DOT, RANK as STATUS_RANK, statusPane, WORD as STATUS_WORD } from './status.js';

/**
 * What the Overview's blocks need of the open page: its Host load read, and the opened queue groups and runners row.
 * @typedef {{ host: HostLoad | null; queueOpen: Set<string>; toggleQueue: (id: string) => void; hostedOpen: boolean; toggleHosted: () => void; openPc: (host: string) => void; pool: CiPool | null }} CiUi
 */

/** @typedef {number | 'all'} Scope */
/** @typedef {{ projectId: number; scope: Scope; tab: string; hl?: number | null; target?: string | null }} Pending */

const REFRESH_MS = 30_000;
const when = pacificStamp;
/**
 * @param {string} href
 * @param {string} text
 */
const ext = (href, text) => h('a', { href, target: '_blank', rel: 'noopener' }, text);

/** A scheme's state: down (something rings), fix (quiet items), ready (all clear), asleep (no read for 20 min). */
/**
 * @param {Pick<CiScheme, 'problems' | 'view'>} s
 * @param {number} now
 */
function stateOf(s, now) {
  if (s.problems.some((x) => !x.quiet)) return 'down';
  if (s.problems.length) return 'fix';
  return now - s.view.at > 20 * 60_000 ? 'asleep' : 'ready';
}
/** @type {Record<string, string>} */
const STATE_HUE = { running: 'running', ok: 'done', bad: 'danger' };
/** @type {Record<string, string>} */
const DOT_OF = { ok: 'ready', warn: 'fix', danger: 'down', neutral: 'asleep' };
/** @type {Record<string, string>} */
const STATE_WORDS = { down: 'needs a person', fix: 'being handled', ready: 'all clear', asleep: 'not read lately' };
/** @type {Record<string, number>} */
const RANK = { down: 3, fix: 2, asleep: 1, ready: 0 };

/**
 * The fix minion, the first thing a red's card shows (#1078; Josh, 2026-11-19: "CI errors should very obviously show the minion
 * that is fixing the issue and maybe even a progress report"): the minions list's row (its number, title, state chip and plan track),
 * its latest line and how long it has been on it, the re-run that tests its fix, all linking to its chat; or a toned notice that none
 * has started and when that rings. Its lines are always there and its bar keeps its height, so a live read moves nothing.
 */
/**
 * @param {CiProblem} x
 * @param {number} [now]
 */
export function fixBox(x, now = Date.now()) {
  const t = x.fixTicket;
  if (!t) {
    const n = /** @type {NonNullable<CiProblem['noFix']>} */ (x.noFix);
    return h('div', { class: `ci-fix none${n.late ? ' late' : ''}` }, h('b', {}, n.late ? 'No fix minion started' : 'No fix minion yet'), h('div', { class: 'muted' }, n.late ? 'This is ringing now: press Investigate to start one.' : `If none starts, this rings at ${when(n.ringsAt)}.`));
  }
  const row = /** @type {ListedTicket} */ (t); // the minions list's row (src/routes/machines.ts fixTicket), drawn as the list draws one
  const st = rowState(row, usage, now);
  const barOf = rowBar(row, st);
  // The bar's and the re-run's room are kept whether or not they show, so a read that adds or drops one moves nothing.
  const bar = (barOf && (progressTrack(barOf) || waitBar(barOf))) || h('div', { class: 'ci-fix-gap' });
  const closed = t.status === 'closed';
  const line = (closed ? t.note : t.status === 'running' ? t.last_activity : t.note || t.last_activity) || (st.rank === 1 ? 'Working…' : st.label);
  const on = closed ? `closed ${ago(t.closed_at ?? t.updated_at)}` : `on it for ${shortSpan(now - t.created_at)}`;
  const re = x.rerun;
  return h(
    'div',
    { class: `ci-fix f-${st.fam || 'none'}${closed ? ' closed' : ''}`, title: st.label },
    h(
      'div',
      { class: 'ci-fix-top' },
      h('a', { class: 'ci-fix-link', href: `#/p/${t.project_id}/t/${t.number}` }, h('span', { class: 'num' }, `#${t.number}`), ' ', t.title),
      h('span', { class: `state${st.quiet ? ' quiet' : ''}`, role: st.cell ? 'img' : null, 'aria-label': st.cell ? spokenCell(st) : null }, st.pulse ? h('i', { class: 'pulse' }) : st.quiet ? h('i', { class: 'still' }) : '', st.cell || st.label),
    ),
    h('div', { class: 'ci-fix-line muted' }, `${line} · ${on}`),
    bar,
    h('div', { class: 'ci-fix-rerun' }, !re ? '' : re.state === 'running' ? `Re-running on ${re.sha}` : re.state === 'failed' ? `The re-run on ${re.sha} failed` : `Waiting for a person to re-run on ${re.sha}`, re?.url ? [' · ', ext(re.url, 'the run')] : ''),
  );
}

/** @param {string | null} c */
const verdictClass = (c) => (c === 'success' ? 'ready' : c === 'failure' ? 'down' : c ? 'asleep' : 'running');

/** The minion a run or queued job tests (#1019): its chat, or what the run is when no minion's change is in it (a schedule, main itself). An older view has no `who`: its branch. */
/** @param {{ who?: CiWho; branch?: string }} x */
const whoCell = (x) => (x.who?.href ? h('a', { class: 'ci-run-who', href: x.who.href, title: x.who.label }, x.who.label) : h('span', { class: 'ci-run-who muted' }, x.who?.label ?? x.branch ?? ''));

/** A run's row; `quiet` (a workflow in the scheme's quiet list, TWIReader #990) greys it and tags it, its result kept. */
/**
 * @param {CiRun} r
 * @param {boolean} [quiet]
 */
function runRow(r, quiet = false) {
  const word = r.status === 'completed' ? (r.conclusion ?? 'done') : r.status.replace('_', ' ');
  return h(
    'div',
    { class: `ci-run${quiet ? ' ci-quiet' : ''}`, title: `${r.name} on ${r.branch}: ${word}, ${when(r.at)}${quiet ? ". Quiet: in the scheme's quiet CI workflows, so its red rings no one" : ''}` },
    h('span', { class: `dot ${quiet ? 'asleep' : verdictClass(r.status === 'completed' ? r.conclusion : null)}` }),
    h('span', { class: `ci-run-word${quiet ? ' muted' : ''}` }, word),
    ext(r.url, r.name),
    quiet ? h('span', { class: 'ci-run-who' }, h('span', { class: 'ci-tag' }, 'quiet'), ' ', whoCell(r)) : whoCell(r),
    h('span', { class: 'ci-run-age muted' }, ago(Date.parse(r.at))),
  );
}

const GENERIC = /^(self-hosted|windows|linux|macos|x64|arm64)$/i;
/** @param {string[]} ls */
const labelName = (ls) => ls.filter((l) => !GENERIC.test(l)).join(', ') || ls.join(', ');
/**
 * @param {number} n
 * @param {string} w
 */
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** A block of the overview in Citadel's look (#1068): a heading in its hue over a box of rows that open, as Host load is. */
// No title: the one row under it already says it (a heading that repeats its row is wasted height).
/**
 * @param {string | null} title
 * @param {string} hue
 * @param {string} cls
 * @param {Child[]} rows
 */
const block = (title, hue, cls, ...rows) => h('section', { class: `ci-block ${cls}${title ? '' : ' ci-bare'}` }, title ? h('h3', { class: 'settings-section', 'data-hue': hue }, title) : '', h('div', { class: 'settings-rows' }, ...rows));
/** @param {Child[]} cs */
const tones = (...cs) => cs.filter(Boolean);
/** Who a run or job tests, as plain text beside its name (a link when it is a minion's chat). */
/** @param {{ who?: CiWho; branch?: string }} x */
const whoText = (x) => (x.who?.href ? h('a', { href: x.who.href, title: x.who.label }, x.who.label) : h('span', { class: 'muted' }, x.who?.label ?? x.branch ?? ''));
/** @param {number | string} t */
const age = (t) => ago(typeof t === 'number' ? t : Date.parse(t));

/**
 * Investigate on a CI red (#1491; Cara, 2026-11-21, picked "Investigate button"): one press starts a fix minion for the red in its
 * scheme (POST …/ci/investigate). The red names it at once and keeps it (`pressed`) until a read shows it, so a read in between drops
 * nothing; a refusal rolls it back with a toast and Retry. Shown while no open minion is on it: none yet, or the last one closed.
 */
const pressed = new Map();
/** The fix part drawn last per red, so an answer paints the one on screen. */
const parts = new Map();
/** @param {CiProblem} x */
const openFix = (x) => x.fixTicket && x.fixTicket.status !== 'closed';
/**
 * @param {{ id: number }} s
 * @param {CiProblem} x
 * @returns {HTMLElement | string}
 */
function fixPart(s, x) {
  const k = `${s.id}:${x.key}`;
  const mine = pressed.get(k);
  // Shown by the server (open, or already closed), or five minutes stale (a red that cleared and came back): the read wins.
  if (mine && ((openFix(x) && (mine.number == null || x.fixTicket?.number === mine.number)) || (mine.number != null && x.fixTicket?.number === mine.number) || Date.now() - mine.at > 5 * 60_000)) pressed.delete(k);
  const p = pressed.get(k);
  const shown = p ? { ...x, fixTicket: { project_id: s.id, number: p.number ?? '…', title: p.title, status: 'running', created_at: p.at, last_activity: p.number ? 'Starting its first turn' : 'Starting a fix minion' } } : x;
  const box = shown.fixTicket || shown.noFix ? fixBox(shown) : '';
  if (!x.key.startsWith('red:')) return box;
  const btn = h('button', { type: 'button', class: 'secondary ci-investigate-btn' }, 'Investigate');
  const el = h('div', { class: 'ci-fix-part' }, box, openFix(shown) ? '' : h('div', { class: 'ci-investigate' }, btn, h('span', { class: 'muted' }, "Starts a fix minion with this red's failing tests")));
  parts.set(k, { el, s, x });
  const paint = () => {
    const at = parts.get(k);
    if (at?.el.isConnected) at.el.replaceWith(fixPart(at.s, at.x));
  };
  btn.onclick = () =>
    optimistic({
      label: 'start a fix minion for this red',
      key: `ci-investigate:${k}`,
      apply: () => {
        pressed.set(k, { at: Date.now(), title: 'Starting a fix minion…' });
        paint();
      },
      send: () => api(`api/projects/${s.id}/ci/investigate`, { method: 'POST', body: { workflow: Number(x.key.slice(4)) } }),
      undo: () => {
        pressed.delete(k);
        paint();
      },
    }).then(
      (r) => {
        pressed.set(k, { at: pressed.get(k)?.at ?? Date.now(), number: r.number, title: r.title });
        paint();
      },
      () => {},
    );
  return el;
}

/** Open problems: what happened, why, the fix, and whether it rings. */
/** @param {Pick<CiScheme, 'id' | 'problems'>} s */
function problemsBlock(s) {
  const ring = s.problems.filter((x) => !x.quiet).length,
    quiet = s.problems.length - ring;
  const [row] = settingsRow(
    {
      key: `ci-problems-${s.id}`,
      icon: 'shield',
      hue: ring ? 'danger' : quiet ? 'held' : 'done',
      title: 'Open problems',
      open: ring > 0,
      summary: s.problems.length ? tones(ring && toneChip('danger', `${ring} ring${ring === 1 ? 's' : ''}`), quiet && toneChip('warn', `${quiet} quiet`)) : [toneChip('ok', 'None'), 'nothing needs fixing'],
    },
    s.problems.length ? statTiles([String(ring), 'ring a person', ring ? 'danger' : 'done'], [String(quiet), 'being handled', quiet ? 'held' : 'done']) : null,
    s.problems.length
      ? h(
          'div',
          { class: 'hue-rows' },
          ...s.problems.map((x) =>
            hueRow(
              { hue: x.quiet ? 'held' : 'danger', lead: x.quiet ? 'quiet' : 'rings' },
              h('strong', {}, x.title.replace(/^CI(, [^:]+)?: /, '')),
              fixPart(s, x),
              x.why ? h('span', { class: 'ci-detail-line' }, h('span', { class: 'muted' }, 'Why: '), x.why) : '',
              x.fix ? h('span', { class: 'ci-detail-line' }, h('span', { class: 'muted' }, 'Fix: '), x.fix) : '',
              // The line is always there, so a link arriving moves nothing (#992).
              x.fixTicket || x.noFix ? '' : h('span', { class: 'ci-detail-line ci-problem-link' }, x.link ? [h('span', { class: 'muted' }, x.link.kind === 'minion' ? 'Fix minion: ' : 'Heard by: '), h('a', { href: x.link.href }, x.link.label), x.link.closed ? h('span', { class: 'muted' }, ' (closed)') : ''] : ''),
            ),
          ),
        )
      : emptyCard('Nothing needs fixing', 'A red run or a stuck runner shows here with why and the fix.'),
  );
  return block(null, ring ? 'danger' : quiet ? 'held' : 'done', 'ci-problems', row);
}

/** Each workflow's verdict on the branch. */
/** @param {CiViewData} v */
function verdictsBlock(v) {
  const ws = v.workflows;
  const state = (/** @type {CiWorkflow} */ w) => (!w.verdict ? 'none' : w.verdict.status !== 'completed' ? 'running' : w.verdict.conclusion === 'success' ? 'ok' : w.verdict.conclusion === 'failure' ? 'bad' : 'other');
  const bad = ws.filter((w) => state(w) === 'bad' && !w.quiet).length,
    going = ws.filter((w) => state(w) === 'running').length,
    ok = ws.filter((w) => state(w) === 'ok').length;
  const item = (/** @type {CiWorkflow} */ w) => {
    if (!w.verdict) return hueRow({ hue: 'held', lead: 'none' }, w.name, ' ', h('span', { class: 'muted' }, 'no verdict'));
    const r = w.verdict,
      st = state(w);
    const word = r.status === 'completed' ? (r.conclusion ?? 'done') : r.status.replace('_', ' ');
    return hueRow(
      { hue: w.quiet ? 'held' : (STATE_HUE[st] ?? 'held'), lead: word, meta: age(r.at) },
      ext(r.url, w.name),
      w.quiet ? [' ', toneChip('neutral', 'quiet')] : '',
      ' · ',
      whoText(r),
      w.skipped.length ? h('span', { class: 'ci-detail-line muted' }, `Green, but skipped ${w.skipped.join(', ')}, which ran in the verdict before it.`) : '',
    );
  };
  const [tone, word] = bad ? ['danger', `${bad} failing`] : going ? ['info', `${going} running`] : ok ? ['ok', 'Green'] : ['neutral', 'No verdict'];
  const [row] = settingsRow(
    { key: `ci-verdicts-${v.slug}`, icon: 'check', hue: bad ? 'danger' : going ? 'running' : 'done', title: `Verdicts on ${v.branch}`, summary: [toneChip(tone, word), `${ok} of ${ws.length} workflows green`] },
    statTiles([String(ok), 'green', 'done'], bad && [String(bad), 'failing', 'danger'], going && [String(going), 'running', 'running']),
    ws.length ? showFirst({ key: `ci-verdicts-${v.slug}`, items: ws.map(item), n: 6, noun: 'workflows' }) : emptyCard('No workflows', 'This repo has none that report here.', { mark: '·', hue: 'muted' }),
  );
  return block(null, bad ? 'danger' : 'done', 'ci-verdicts', row);
}

/** The queue per set of labels, for Running now's header: "peek-auras-ci: 1 runner, 9 queued". */
/** @param {CiQueue} q */
const queueWords = (q) => `${labelName(q.labels)}: ${q.runners ? `${plural(q.runners, 'runner')}, ` : q.runners === 0 && q.labels.some((l) => /^self-hosted$/i.test(l)) ? 'no runner online, ' : ''}${q.jobs} queued`;

/**
 * Running now (Cara, 2026-11-18: "Could we make this page show what is running on the CI?"): a row per self-hosted runner, busy
 * with which job for which minion and for how long, idle or offline, then one row for GitHub's own runners that opens to a row per
 * job. Rows are per runner, not per job, so the section keeps its height as jobs come and go between reads.
 */
/**
 * @param {CiScheme} s
 * @param {number} now
 * @param {CiUi} ui
 */
function runningBlock(s, now, ui) {
  const v = s.view;
  const ships = shipRunIds(v);
  const running = (v.running ?? []).filter((j) => !ships.has(j.run));
  const own = v.runners ?? [];
  const names = new Set(own.map((r) => r.name));
  const jobCell = (/** @type {CiRunningJob} */ j) => [ext(`https://github.com/${v.slug}/actions/runs/${j.run}`, j.name), ' · ', whoText(j)];
  const since = (/** @type {CiRunningJob | undefined} */ j) => (j ? shortSpan(now - Date.parse(j.since)) : null);
  const rows = own.map((r) => {
    const j = running.find((x) => x.runner === r.name);
    // Asleep (#2239): its PC's agent stopped it on Citadel's plan, to give the room to minion turns; it wakes when work comes.
    const word = r.status === 'offline' ? (r.asleep ? 'asleep' : 'offline') : j || r.busy || r.job ? 'busy' : 'idle';
    return {
      word,
      el: hueRow(
        { hue: { offline: 'danger', asleep: 'muted', busy: 'running', idle: 'done' }[word], lead: word, meta: since(j) },
        h('strong', { title: `${r.name}: ${r.labels.join(', ')}` }, r.name),
        ' ',
        j
          ? jobCell(j)
          : h(
              'span',
              { class: 'muted', title: word === 'asleep' ? 'Its PC stopped it to make room for minion turns (Citadel balances the PC between them); it wakes when work comes' : null },
              word === 'asleep' ? 'wakes when work comes' : word === 'offline' ? (r.offlineSince ? `since ${when(r.offlineSince)}` : 'offline') : (r.job ?? (word === 'busy' ? 'a job from an older run' : 'waiting for work')),
            ),
      ),
    };
  });
  const count = (/** @type {string} */ w) => rows.filter((r) => r.word === w).length;
  // GitHub's own runners (and every runner, when the repo's can't be listed): one row, opened by a click to a row per job.
  const theirs = running.filter((j) => !names.has(j.runner));
  const where = v.runners === null ? 'Runners' : "GitHub's runners";
  /** @type {Child[]} */
  const items = rows.map((r) => r.el);
  items.push([
    hueRow(
      { hue: theirs.length ? 'running' : 'done', lead: theirs.length ? `${theirs.length} running` : 'none', meta: theirs.length ? h('button', { type: 'button', class: 'secondary small ci-now-more', 'aria-expanded': String(ui.hostedOpen), onclick: ui.toggleHosted }, ui.hostedOpen ? 'Hide jobs' : 'Show jobs') : null },
      h('strong', {}, where),
      ' ',
      h('span', { class: 'muted' }, theirs.length ? (ui.hostedOpen ? '' : theirs.map((j) => j.name).join(', ')) : 'nothing running'),
    ),
    // Its opened jobs are part of the same item, so "Show all" never cuts them off the row that opened them.
    ...(ui.hostedOpen ? theirs.map((j) => hueRow({ hue: 'running', lead: 'running', meta: since(j) }, h('strong', { title: j.runner }, j.runner), ' ', jobCell(j))) : []),
  ]);
  const queues = queuesBut(v, ships);
  const head = queues.length ? queues.map(queueWords).join(' · ') : 'nothing queued';
  // The Runners tab's notes (#1019: runners moved onto Overview), for a repo whose runners can't be listed or that has none.
  const note = v.runners === null ? "CI health can't list this repo's runners: it needs a repo admin's linked GitHub." : !own.length ? "No self-hosted runners; jobs run on GitHub's." : v.runs.some(githubShip) ? "Ships don't run here unless GitHub can't take them (see Fallbacks)." : '';
  const busy = count('busy') + theirs.length,
    off = count('offline'),
    asleep = count('asleep');
  const [tone, word] = off ? ['warn', `${off} offline`] : busy ? ['info', `${busy} busy`] : asleep ? ['ok', `${asleep} asleep`] : ['ok', 'Idle'];
  const [row] = settingsRow(
    { key: `ci-running-${s.id}`, icon: 'box', hue: busy ? 'running' : 'done', title: 'Runners and what they run', summary: [toneChip(tone, word), head] },
    statTiles([String(busy), 'busy', 'running'], [String(count('idle')), 'idle', 'done'], asleep && [String(asleep), 'asleep', 'muted'], off && [String(off), 'offline', 'danger']),
    showFirst({ key: `ci-running-${s.id}`, items, n: 6, noun: 'runners' }),
    note ? h('p', { class: 'look-prose' }, note) : null,
  );
  return block(null, 'running', 'ci-running', row);
}

/** A scheme's one line about the desktops its runners are on, linking to each one's row in the list (Josh, 2026-11-19: the load lives at the list's bottom, not in each scheme). */
/**
 * @param {CiScheme} s
 * @param {PcView[]} pcs
 * @param {CiUi} ui
 */
function runsOn(s, pcs, ui) {
  const mine = pcs.filter((pc) => pc.projects.includes(s.id));
  if (!mine.length) return '';
  // #2231: a scheme whose ships run on GitHub's shards uses its PC for the rest and the fallbacks.
  const lead = s.view.runs.some(githubShip) ? "Ships run on GitHub's runners; other runs and fallbacks run on " : 'Runs on ';
  return h('p', { class: 'ci-runs-on muted' }, lead, ...mine.flatMap((pc, i) => [i ? ', ' : '', h('button', { type: 'button', class: 'link', onclick: () => ui.openPc(pc.host) }, pc.host), ` · ${runsOnWord(pc, s.view.runners)[1]}`]));
}

/**
 * @param {CiWaitingJob} j
 * @param {string} slug
 */
const waitItem = (j, slug) => hueRow({ hue: 'waiting', lead: 'queued', meta: age(j.since) }, h('span', { title: `${j.name}, for a runner with ${j.labels.join(', ')}, queued ${when(j.since)}` }, ext(`https://github.com/${slug}/actions/runs/${j.run}`, j.name)), ' · ', whoText(j));

/** The queue in its order, adjacent jobs for one minion (or, with none, one kind of run) as one group (#1019, Cara: "sequential queued jobs for the same minion could be grouped"). */
/** @param {CiWaitingJob[]} waiting */
function queueGroups(waiting) {
  /** @type {{ key: string; jobs: CiWaitingJob[] }[]} */
  const groups = [];
  for (const j of waiting) {
    const key = j.who?.href ?? j.who?.label ?? j.branch ?? '';
    if (groups.at(-1)?.key === key) /** @type {{ jobs: CiWaitingJob[] }} */ (groups.at(-1)).jobs.push(j);
    else groups.push({ key, jobs: [j] });
  }
  return groups;
}

/** A group's rows: one job as it is; several as one row (count, minion, labels, oldest wait) that opens to each job on a click. */
/**
 * @param {{ key: string; jobs: CiWaitingJob[] }} g
 * @param {string} slug
 * @param {CiUi} ui
 */
function queueRows(g, slug, ui) {
  const [first] = g.jobs;
  if (g.jobs.length === 1) return [waitItem(first, slug)];
  const id = `${g.key}:${first.run}:${first.name}`,
    open = ui.queueOpen.has(id);
  const labels = [...new Set(g.jobs.flatMap((j) => j.labels))].join(', ');
  const oldest = Math.min(...g.jobs.map((j) => Date.parse(j.since)));
  const row = hueRow(
    { hue: 'waiting', lead: 'queued', meta: ago(oldest) },
    h(
      'button',
      { type: 'button', class: 'secondary small queue-toggle', 'aria-expanded': String(open), 'data-group': id, onclick: () => ui.toggleQueue(id), title: `${g.jobs.length} jobs for a runner with ${labels}, the oldest queued ${when(new Date(oldest).toISOString())}` },
      `${g.jobs.length} jobs ${open ? '▴' : '▾'}`,
    ),
    ' ',
    whoText(first),
    h('span', { class: 'ci-detail-line muted' }, `${g.jobs.map((j) => j.name).join(', ')} · on ${labels}`),
  );
  return [row, ...(open ? g.jobs.map((j) => h('div', { class: 'queue-sub' }, waitItem(j, slug))) : [])];
}

/**
 * @param {CiScheme} s
 * @param {number} now
 * @param {CiUi} ui
 */
function waitingBlock(s, now, ui) {
  const v = s.view;
  const ships = shipRunIds(v);
  const waiting = v.waiting.filter((j) => !ships.has(j.run)),
    n = waiting.length;
  const oldest = n ? Math.min(...waiting.map((j) => Date.parse(j.since))) : 0;
  const groups = queueGroups(waiting);
  const [row] = settingsRow(
    { key: `ci-waiting-${s.id}`, icon: 'rows', hue: n ? 'waiting' : 'done', title: 'Waiting for a runner', summary: n ? [toneChip('warn', `${n} waiting`), `oldest ${shortSpan(now - oldest)}`] : [toneChip('ok', 'Nobody'), 'no job is waiting'] },
    n ? statTiles([String(n), 'jobs queued', 'waiting'], [shortSpan(now - oldest), 'oldest wait', 'waiting']) : null,
    n ? showFirst({ key: `ci-waiting-${s.id}`, items: groups.map((g) => queueRows(g, v.slug, ui)), n: 5, noun: 'groups', wrap: (rows) => h('div', { class: 'hue-rows' }, ...rows.flat()) }) : emptyCard('No job is waiting', 'Jobs queue here when every runner is busy.'),
    v.runs.some(githubShip) ? h('p', { class: 'look-prose' }, "Shards waiting for GitHub's slots show with their ship, not here.") : null,
  );
  return block(null, n ? 'waiting' : 'done', 'ci-waiting', row);
}

// ---------- the runner pool's line (Build 11 P1, specs/one-runner-pool.md section 7: watching only) ----------

/** @param {CiPoolJob} j */
const poolItem = (j) =>
  hueRow(
    { hue: j.machine ? 'running' : 'waiting', lead: `${j.place}`, meta: ago(j.since) },
    h('span', { title: `${j.name}: ${j.size} threads, on ${j.labels.filter((l) => l !== 'self-hosted').join(', ')}${j.ship ? ', a ship' : ''}` }, ext(`https://github.com/${j.repo}/actions/runs/${j.run}`, j.name)),
    j.ship ? h('span', { class: 'muted' }, ' · ship') : '',
    ' · ',
    j.machine ? `would start on ${j.machine}` : h('span', { class: 'muted' }, j.why ?? 'waiting'),
  );

/**
 * The scheme's jobs in the pool's one line across every scheme, each with its place and where it would start or why it waits.
 * @param {CiScheme} s
 * @param {CiPool | null} pool
 */
function poolBlock(s, pool) {
  const mine = (pool?.line ?? []).filter((j) => j.scheme === s.id);
  if (!pool || !mine.length) return '';
  const would = mine.filter((j) => j.machine).length;
  const [row] = settingsRow(
    { key: `ci-pool-${s.id}`, icon: 'rows', hue: 'waiting', title: "The runner pool's line", summary: [toneChip('warn', `${mine.length} in line`), `${would} would start · ${pool.total} in all`] },
    h('p', { class: 'look-prose' }, "Watching only: the pool shows where it would start each job and why the rest wait. This scheme's runners still take them."),
    showFirst({ key: `ci-pool-${s.id}`, items: mine.map(poolItem), n: 6, noun: 'jobs', wrap: (rows) => h('div', { class: 'hue-rows' }, ...rows) }),
  );
  return block(null, 'waiting', 'ci-pool', row);
}

// ---------- ship CI on GitHub's runners (#2231; Cara, 2026-11-27, picked "Its own block, with a shard strip" and "Ships on top") ----------

/** A ship's run (a `land/` branch) split into shards on GitHub's runners: a scheme whose ships run whole on GitHub keeps its page as it was. */
/** @param {CiRun} r */
const githubShip = (r) => r.branch.startsWith('land/') && r.where === 'github' && !!r.shards;
/** The GitHub ship runs going now: their jobs show in Ship CI on GitHub, not as runners busy or jobs waiting. */
/** @param {CiViewData} v */
const shipRunIds = (v) => new Set(v.runs.filter((r) => githubShip(r) && r.status !== 'completed').map((r) => r.id));
/**
 * The queue per labels without the GitHub ship runs' waiting jobs.
 * @param {CiViewData} v
 * @param {Set<number>} ships
 */
function queuesBut(v, ships) {
  const key = (/** @type {string[]} */ ls) => [...ls].sort().join(',');
  const less = new Map();
  for (const j of v.waiting) if (ships.has(j.run)) less.set(key(j.labels), (less.get(key(j.labels)) ?? 0) + 1);
  return (v.queues ?? []).map((q) => ({ ...q, jobs: q.jobs - (less.get(key(q.labels)) ?? 0) })).filter((q) => q.jobs > 0);
}
/** "3m 23s": a push to verdict reads to the second. */
/** @param {number} secs */
const mmss = (secs) => (secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, '0')}s`);
/** @param {number[]} xs */
const median = (xs) => {
  const v = [...xs].sort((a, b) => a - b);
  return v.length ? (v.length % 2 ? v[v.length >> 1] : Math.round((v[v.length / 2 - 1] + v[v.length / 2]) / 2)) : null;
};
/** Ship runs with a verdict, their push to verdict. */
/** @param {CiRun[]} runs */
const verdictSecs = (runs) => runs.filter((r) => r.status === 'completed' && (r.conclusion === 'success' || r.conclusion === 'failure') && r.secs != null && !r.moved).map((r) => /** @type {number} */ (r.secs));

/** The 20 cells, green, red, running then waiting for a slot. */
/** @param {import('./types/ci.js').CiShards} sh */
function shardStrip(sh) {
  const running = sh.started - sh.done - sh.red;
  const cells = [...Array(sh.done).fill(['done', 'green']), ...Array(sh.red).fill(['red', 'red']), ...Array(Math.max(0, running)).fill(['run', 'running']), ...Array(Math.max(0, sh.n - sh.started)).fill(['queued', "waiting for one of GitHub's slots"])];
  const strip = h('div', { class: 'ci-shards', role: 'img', 'aria-label': `${sh.n} shards: ${sh.done} green, ${sh.red} red, ${Math.max(0, running)} running, ${sh.n - sh.started} waiting for a slot` }, ...cells.map(([st, word]) => h('span', { class: 'ci-shard', 'data-s': st, title: word })));
  strip.style.setProperty('--n', String(sh.n));
  const key = (/** @type {string} */ st, /** @type {string} */ word) => h('span', {}, h('i', { class: 'ci-shard', 'data-s': st }), word);
  return [strip, h('div', { class: 'ci-shard-key muted' }, key('done', 'green'), key('red', 'red'), key('run', 'running'), key('queued', 'waiting for a GitHub slot'))];
}

/**
 * Ship CI on GitHub (ADR 0043): a ship's tests split over GitHub's runners, as one run with its shards, its time since the push
 * and, while shards wait for a slot, the 60 s rule that sends it to the desktop. Idle, its last ship and the day's median.
 * A scheme whose ships never ran on GitHub has no block.
 * @param {CiScheme} s
 * @param {number} now
 */
function shipBlock(s, now) {
  const ships = s.view.runs.filter(githubShip);
  if (!ships.length) return '';
  const going = ships.filter((r) => r.status !== 'completed');
  const med = median(verdictSecs(ships));
  const usual = med == null ? '' : ` The day's median from push to verdict is ${mmss(med)}.`;
  if (!going.length) {
    const last = ships.find((r) => r.status === 'completed' && !r.moved) ?? ships[0];
    const green = last.conclusion === 'success';
    const [row] = settingsRow(
      { key: `ci-ships-${s.id}`, icon: 'branch', hue: 'done', title: 'Ship CI on GitHub', summary: [toneChip('ok', 'Idle'), `last ${green ? 'green' : (last.conclusion ?? 'ended')}${last.secs != null ? ` in ${mmss(last.secs)}` : ''}, ${age(last.at)}: `, whoText(last)] },
      statTiles([String(ships.length), 'ship runs on GitHub', 'running'], med != null && [mmss(med), 'median push to verdict', 'running']),
      h(
        'div',
        { class: 'ci-history' },
        h(
          'div',
          { class: 'hue-rows' },
          hueRow(
            { hue: green ? 'done' : 'danger', lead: green ? 'green' : (last.conclusion ?? 'ended'), meta: age(last.at) },
            h('span', { class: 'ci-ship-head' }, whoText(last)),
            h('span', { class: 'ci-ship-meta muted' }, h('span', { class: 'ci-tag', 'data-to': 'github' }, `GitHub · ${last.shards?.n ?? 20}`), ext(last.url, 'run'), last.secs != null ? mmss(last.secs) : null),
          ),
        ),
      ),
      h('p', { class: 'look-prose' }, "No ship is in CI. Each ship splits its tests over 20 of GitHub's runners and gets one verdict."),
    );
    return block(null, 'done', 'ci-ships', row);
  }
  const rows = going.map((r) => {
    const sh = /** @type {import('./types/ci.js').CiShards} */ (r.shards);
    const since = now - Date.parse(r.at);
    const waitingSlots = sh.n - sh.started;
    const [tone, word, hue] = sh.red ? ['danger', `${sh.red} red`, 'danger'] : waitingSlots ? (since > 60_000 ? ['violet', 'Moving to the desktop', 'held'] : ['info', `${waitingSlots} waiting for a slot`, 'running']) : ['info', 'Running', 'running'];
    const [row] = settingsRow(
      { key: `ci-ship-${s.id}`, icon: 'branch', hue, title: 'Ship CI on GitHub', summary: [toneChip(tone, word), whoText(r), ` · ${shortSpan(since)}`] },
      statTiles([`${sh.started}/${sh.n}`, 'shards started', 'running'], [String(sh.done), 'green', 'done'], [String(sh.red), 'red', sh.red ? 'danger' : 'done'], [shortSpan(since), 'since the push', 'running']),
      ...shardStrip(sh),
      h(
        'p',
        { class: 'look-prose' },
        waitingSlots ? (since > 60_000 ? 'Past the minute with shards still waiting: the ship script is moving this ship to the desktop.' : "If every shard hasn't started a minute after the push, the ship script cancels this run and sends the ship to the desktop.") : `One verdict: red if any shard is.${usual}`,
        ' ',
        ext(r.url, 'The run on GitHub'),
      ),
    );
    return row;
  });
  return block(null, rows.length ? 'running' : 'done', 'ci-ships', ...rows);
}

/**
 * Fallbacks: each ship whose CI GitHub couldn't take (to the desktop) or that ran its suite on perigee, with the ship script's
 * why, newest first. Two in a row off GitHub ring (src/ci-land-gate.ts ownFallbackProblems), as perigee's do.
 * @param {CiScheme} s
 */
function fallbacksBlock(s) {
  const fb = s.view.fallbacks;
  const onGithub = s.view.runs.filter((r) => githubShip(r) && !r.moved).length;
  if (!fb || (!fb.length && !onGithub)) return '';
  const own = fb.filter((f) => f.to === 'own').length,
    perigee = fb.length - own;
  const ringing = s.problems.some((x) => x.key === 'land:off-github' || x.key === 'land:fallback');
  const newest = [...fb].sort((a, b) => b.at - a.at);
  /** The desktop run that took a fallback over: dispatched on its land branch within 15 minutes of the line, its result. */
  const tookOver = (/** @type {import('./types/ci.js').CiFallback} */ f) => {
    if (f.to !== 'own') return null;
    const r = s.view.runs.findLast((x) => x.branch === `land/${f.branch}` && x.event === 'workflow_dispatch' && Date.parse(x.at) >= f.at - 60_000 && Date.parse(x.at) <= f.at + 15 * 60_000);
    if (!r) return null;
    const [tone, word] = r.status !== 'completed' ? ['info', 'running'] : r.conclusion === 'success' ? ['ok', 'green'] : r.conclusion === 'failure' ? ['danger', 'red'] : ['neutral', r.conclusion ?? 'ended'];
    return h('span', { class: 'ci-took-over' }, 'desktop run ', toneChip(tone, `${word}${r.status === 'completed' && r.secs != null ? ` ${mmss(r.secs)}` : ''}`));
  };
  const items = newest.map((f) =>
    hueRow(
      { hue: f.to === 'own' ? 'held' : 'waiting', meta: h('span', { title: pacificClockBare(f.at) }, age(f.at)) },
      h('span', { class: 'ci-tag', 'data-to': f.to }, f.to === 'own' ? 'Desktop' : 'perigee'),
      ' ',
      f.minion ? h('a', { href: `#/p/${s.id}/t/${f.minion}` }, `#${f.minion}`) : h('span', {}, f.branch),
      h('span', { class: 'ci-detail-line muted' }, f.why || (f.to === 'own' ? 'moved off GitHub' : 'ran the suite on perigee'), tookOver(f)),
    ),
  );
  const [row] = settingsRow(
    { key: `ci-fallbacks-${s.id}`, icon: 'rows', hue: fb.length ? 'held' : 'done', title: 'Fallbacks', summary: fb.length ? [toneChip(ringing ? 'danger' : 'violet', `${fb.length} in a day`), `last ${age(newest[0].at)}`] : [toneChip('ok', 'None'), 'every ship ran on GitHub'] },
    statTiles([String(own), 'to the desktop', own ? 'held' : 'done'], [String(perigee), 'to perigee', perigee ? 'waiting' : 'done'], [String(onGithub), 'ships stayed on GitHub', 'running']),
    items.length ? showFirst({ key: `ci-fallbacks-${s.id}`, items, n: 5, noun: 'fallbacks' }) : emptyCard('No fallbacks', 'Every ship in the last day ran its CI on GitHub.', { mark: '✓', hue: 'done' }),
    h('p', { class: 'look-prose' }, "From the ship script's retro log. Two in a row off GitHub wake the Taskmaster, then ring people after the wait, as fallbacks to perigee do."),
  );
  return block(null, fb.length ? 'held' : 'done', 'ci-fallbacks', row);
}

/**
 * History: one row per ship try (where it ran, push to verdict as a bar, green or red), a run moved off GitHub inside the run that
 * took it over; the other workflows in a row that opens. A scheme with no ship runs keeps the plain list.
 * @param {CiScheme} s
 */
function historyTab(s) {
  const runs = s.view.runs;
  const ships = runs.filter((r) => r.branch.startsWith('land/'));
  if (!ships.length) return [h('section', { class: 'ci-block' }, h('h4', {}, 'Recent runs'), runs.length ? h('div', { class: 'ci-runs' }, ...runs.map((r) => runRow(r))) : h('p', { class: 'muted' }, 'No runs in the last day.'))];
  // A moved run sits under the next newer run on its branch (runs are newest first): the one that took it over.
  /** @type {Map<number, CiRun>} */
  const under = new Map();
  for (const [i, r] of ships.entries()) {
    if (!r.moved) continue;
    const by = ships.slice(0, i).findLast((x) => x.branch === r.branch);
    if (by && !under.has(by.id)) under.set(by.id, r);
  }
  const nested = new Set([...under.values()].map((r) => r.id));
  const total = (/** @type {CiRun} */ r) => {
    const m = under.get(r.id);
    return r.secs == null ? null : m ? r.secs + Math.round((Date.parse(r.at) - Date.parse(m.at)) / 1000) : r.secs;
  };
  const max = Math.max(1, ...ships.map((r) => total(r) ?? 0));
  const shipItem = (/** @type {CiRun} */ r) => {
    const going = r.status !== 'completed';
    const [hue, word] = going ? ['running', r.status === 'queued' ? 'queued' : 'running'] : r.conclusion === 'success' ? ['done', 'green'] : r.conclusion === 'failure' ? ['danger', 'red'] : ['held', r.moved ? 'moved' : (r.conclusion ?? 'done')];
    const secs = total(r);
    const m = under.get(r.id);
    const red = r.shards?.red ? `${plural(r.shards.red, 'shard')} red` : '';
    return [
      hueRow(
        { hue, lead: word, meta: age(r.at) },
        h('span', { class: 'ci-ship-head' }, whoText(r)),
        h(
          'span',
          { class: 'ci-ship-meta muted' },
          h('span', { class: 'ci-tag', 'data-to': r.where ?? '' }, r.where === 'github' ? `GitHub${r.shards ? ` · ${r.shards.n}` : ''}` : r.where === 'own' ? 'Desktop' : '…'),
          ext(r.url, 'run'),
          secs != null ? meter(secs / max, mmss(secs)) : null,
          r.moved && !nested.has(r.id) ? h('span', {}, `moved to the desktop: ${r.moved}`) : red && !going ? h('span', {}, red) : null,
        ),
      ),
      m
        ? h(
            'div',
            { class: 'queue-sub' },
            hueRow(
              { hue: 'running', lead: 'moved', meta: m.secs != null ? mmss(m.secs) : null },
              h('span', { class: 'ci-ship-head muted' }, m.moved || 'moved off GitHub'),
              h('span', { class: 'ci-ship-meta muted' }, h('span', { class: 'ci-tag', 'data-to': 'github' }, `GitHub${m.shards ? ` · ${m.shards.n}` : ''}`), ext(m.url, 'run')),
            ),
          )
        : null,
    ];
  };
  const shown = ships.filter((r) => !nested.has(r.id));
  const med = median(verdictSecs(ships.filter((r) => r.where === 'github')));
  const done = shown.filter((r) => r.status === 'completed' && (r.conclusion === 'success' || r.conclusion === 'failure'));
  const reds = done.filter((r) => r.conclusion === 'failure').length;
  const moved = ships.filter((r) => r.moved).length;
  const other = runs.filter((r) => !r.branch.startsWith('land/'));
  const otherReds = other.filter((r) => r.status === 'completed' && r.conclusion === 'failure').length;
  const otherOk = other.every((r) => r.status === 'completed' && (r.conclusion === 'success' || r.conclusion === 'skipped'));
  const otherGoing = other.filter((r) => r.status !== 'completed').length;
  const names = [...new Set(other.map((r) => r.name))];
  const [otherRow] = settingsRow(
    {
      key: `ci-other-runs-${s.id}`,
      icon: 'rows',
      hue: otherReds ? 'danger' : 'held',
      title: 'Other runs',
      summary: other.length
        ? [otherReds ? toneChip('danger', `${otherReds} red`) : otherOk ? toneChip('ok', 'All green') : otherGoing ? toneChip('info', `${otherGoing} running`) : toneChip('neutral', 'No reds'), `${plural(other.length, 'run')}: ${names.slice(0, 3).join(', ')}${names.length > 3 ? '…' : ''}`]
        : [toneChip('neutral', 'None'), 'only ships ran'],
    },
    other.length ? h('div', { class: 'ci-runs' }, ...other.map((r) => runRow(r))) : emptyCard('No other runs', 'Runs that are not a ship (a schedule, a cache, a run by hand) list here.'),
  );
  return [
    h(
      'section',
      { class: 'ci-block ci-history' },
      h('h3', { class: 'settings-section', 'data-hue': reds ? 'danger' : 'running' }, 'Ships'),
      statTiles([String(shown.length), 'ship tries, last day', 'running'], med != null && [mmss(med), 'median push to verdict on GitHub', 'running'], [String(moved), 'to the desktop', moved ? 'held' : 'done'], [String(reds), `red of ${done.length}`, reds ? 'danger' : 'done']),
      showFirst({ key: `ci-ships-${s.id}`, items: shown.map(shipItem), n: 6, noun: 'ship runs', wrap: (rows) => h('div', { class: 'hue-rows' }, ...rows.flat()) }),
    ),
    block(null, otherReds ? 'danger' : 'held', 'ci-other', otherRow),
  ];
}

/**
 * @param {CiScheme} s
 * @param {PcView[]} pcs
 * @param {number} now
 * @param {CiUi} ui
 */
function overview(s, pcs, now, ui) {
  return [problemsBlock(s), verdictsBlock(s.view), shipBlock(s, now), runningBlock(s, now, ui), fallbacksBlock(s), waitingBlock(s, now, ui), poolBlock(s, ui.pool), runsOn(s, pcs, ui), pcs.length ? '' : hostLoadBlock(ui.host)];
}

// ---------- the Releases page (#1423) ----------

/**
 * Which problems hold up deploys (the Releases button's dot) and which are CI's own (the CI button's), Cara 2026-11-21: "the
 * releases status indicator would show if there is an issue with test failures or other things stopping deployments, CI
 * indicates issues with runners being down or overworked". A red on the branch and a still ship line hold up deploys; stuck,
 * hung or unstarted jobs and a ship gate fallen back to perigee are CI's, as is any kind not named here (docs/adr/0023).
 */
/** @param {CiProblem} x */
export const holdsDeploys = (x) => x.key.startsWith('red:') || x.key === 'land:slow';
/** @param {CiScheme} s */
const ciSide = (s) => ({ ...s, problems: s.problems.filter((x) => !holdsDeploys(x)) });

/** @type {[string, string][]} */
const TABS = [
  ['releases', 'Releases'],
  ['overview', 'Overview'],
  ['history', 'History'],
  ['health', 'Test health'],
  ['numbers', 'Numbers'],
  ['code', 'Code'],
  ['flow', 'Flow'],
  ['status', 'Status'],
];
const CI_TABS = new Set(['overview', 'history', 'health', 'numbers']);
/** The tab an address names: Runs is History and Runners joined Overview (#1019), so their old links land where those now are. */
/** @param {string} t */
export const tabOf = (t) => (t === 'runs' ? 'history' : t === 'runners' ? 'overview' : TABS.some(([k]) => k === t) ? t : 'releases');
/** The page's address for `scope` and `tab`: what a click on its list or tabs goes to, so Back steps through them. */
/**
 * @param {number} projectId
 * @param {Scope} scope
 * @param {string} [tab]
 */
export const releasesHash = (projectId, scope, tab = 'releases') => `#/p/${projectId}/releases/${scope}${tab === 'releases' ? '' : `/${tab}`}`;

/** GET /api/ci; an answer without its schemes (an old server, a test's stub) counts as a failed read, so nothing reads `.schemes` off it. */
/** @returns {Promise<CiRead>} */
const readCi = async () => {
  // The runner pool's line comes on its own route (Build 11 P1); a failed read of it only leaves the line out.
  const [r, pool] = await Promise.all([api('api/ci'), api('api/ci/pool').catch(() => null)]);
  if (!Array.isArray(r?.schemes)) throw new Error('no CI in the answer');
  return { ...r, pool };
};
/** @type {CiRead | null} */
let ciRead = null; // the last /api/ci read, the page's or the chips', so a page opened again draws at once
/** @type {HostLoad | null} */
let hostRead = null;
/** @type {{ el: HTMLElement; projectId: number; drawList: () => void; go: (to: Pending) => void } | null} */
let shell = null; // the open page
/** @type {Pending | null} */
let pending = null; // where the next page built opens

/** Point the page at `scope` (a scheme's id or 'all') on `tab`: the open one when it's this scheme's (true), else the next one built. */
/**
 * @param {number} projectId
 * @param {{ scope: Scope; tab?: string; hl?: number | null; target?: string | null }} to
 */
export function goReleases(projectId, { scope, tab = 'releases', hl = null, target = null }) {
  pending = { projectId, scope, tab, hl, target };
  setReleasesPage(scope, hl, target);
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
  const o = pending ?? { projectId: /** @type {View} */ (view).projectId, scope: /** @type {View} */ (view).projectId, tab: 'releases' };
  pending = null;
  const projectId = o.projectId;
  let scope = o.scope,
    tab = o.tab,
    pc = /** @type {string | null} */ (null); // pc: a desktop picked in the list, its load in place of the tabs
  /** @type {Map<number, TestHealth | ReadFailed>} */
  const health = new Map(); // scheme id -> its Test health read, kept so the tab doesn't blank on a redraw
  /** @type {Map<number, CiNumbersView | ReadFailed>} */
  const numbers = new Map(); // scheme id -> its Numbers read (#1369), kept the same way
  /** @type {Map<number, Awaited<ReturnType<typeof readCode>> | ReadFailed>} */
  const code = new Map(); // scheme id -> its Code read (#1988), kept the same way
  /**
   * @template T
   * @param {Map<number, T | ReadFailed>} cache
   * @param {(id: number) => Promise<T>} fetch
   */
  const read = (cache, fetch) => async (/** @type {number} */ id) => {
    try {
      cache.set(id, await fetch(id));
    } catch {
      cache.set(id, { error: true });
    }
    draw();
  };
  /** @type {Map<number, Awaited<ReturnType<typeof readFlow>> | ReadFailed>} */
  const flow = new Map(); // scheme id -> its Flow read (#1989)
  /** @type {Record<string, (id: number) => Promise<void>>} */
  const readers = { health: read(health, readHealth), numbers: read(numbers, readNumbers), code: read(code, readCode), flow: read(flow, readFlow) };
  const readTab = () => typeof scope === 'number' && readers[tab]?.(scope);
  let greensOpen = false; // phones: the all-clear schemes sit behind a toggle row
  let hostedOpen = false; // Running now's row for GitHub's runners opens to a row per job, on a click only
  const queueOpen = new Set(); // the queue's groups opened by a click
  /** @type {StatusData | null} */
  let statusData = null; // the Status tab's last read, for the list's dots on that tab
  const relEl = releasesPage(); // kept: Releases' own redraws fill it, and a drag in its land line survives the list's
  const holdsEl = h('div', { class: 'rel-holds' });
  const statusEl = statusPane((d) => {
    statusData = d;
    if (tab === 'status') drawList();
  });
  const go = (/** @type {Scope} */ to, t = tab) => {
    location.hash = releasesHash(projectId, to, t);
  };
  const close = (/** @type {string} */ cls, /** @type {string} */ name) => h('button', { type: 'button', class: `close-view ${cls}`, 'aria-label': 'Close', title: 'Close', onclick: closeReleases }, icon(name));
  const title = h('span', { class: 'wide-only' });
  const head = h(
    'div',
    { class: 'ticket-head rel-head' },
    h(
      'div',
      { class: 'row' },
      close('narrow-only', 'back'),
      h('h2', {}, 'Releases', title),
      h('span', { class: 'spacer' }),
      h(
        'span',
        { class: 'head-nav' },
        h('button', { type: 'button', class: 'nav-btn nav-back', title: 'Back', 'aria-label': 'Back', disabled: !canBack(), onclick: goBack }, icon('back')),
        h('button', { type: 'button', class: 'nav-btn nav-forward', title: 'Forward', 'aria-label': 'Forward', disabled: !canForward(), onclick: goForward }, icon('forward')),
        close('wide-only', 'close'),
      ),
    ),
  );
  const list = h('nav', { class: 'ci-list', 'aria-label': 'Schemes' });
  // The page header is sticky too: the list sticks just below it, never under it.
  new ResizeObserver(() => el.style.setProperty('--rel-head-h', `${head.getBoundingClientRect().height}px`)).observe(head);
  const tabsEl = h('div');
  const body = h('div', { class: 'rel-tab' });
  const detail = h('div', { class: 'ci-detail' }, tabsEl, body);
  const el = h(
    'section',
    {
      class: 'releases-main',
      onkeydown: (/** @type {KeyboardEvent} */ e) => {
        if (e.key === 'Escape' && !e.defaultPrevented) closeReleases();
      },
    },
    head,
    h('div', { class: 'ci-page' }, h('div', { class: 'ci-split' }, list, detail)),
  );

  const nameOf = (/** @type {Scope} */ id) => ciRead?.schemes.find((x) => x.id === id)?.name ?? view?.projects?.find((p) => p.id === id)?.name ?? `Scheme ${id}`;
  /** Every scheme the list shows: CI's in its order, then any that ships or has an app without CI, and the one opened. */
  const ids = () => {
    const out = (ciRead?.schemes ?? []).map((x) => x.id);
    for (const id of [...allSchemes(), ...(statusData?.apps ?? []).map((a) => a.scheme), projectId]) if (typeof id === 'number' && !out.includes(id)) out.push(id);
    return out;
  };
  /** A row's dot and line on the open tab: Releases' holds, CI's own problems, or the worst of its Status pane. */
  /** @param {number} id */
  const rowOf = (id) => {
    const s = ciRead?.schemes.find((x) => x.id === id);
    const words = (/** @type {string} */ st, /** @type {number} */ n, noun = 'problem') => (n ? `${n} ${noun}${n === 1 ? '' : 's'}, ${STATE_WORDS[st]}` : STATE_WORDS[st]);
    if (tab === 'status') {
      if (!statusData) return { st: 'none', line: 'reading…' }; // a line now, so the read arriving moves nothing
      // A scheme's dot is its apps'; the server's verdict sits only on the row of the scheme that ships it.
      const apps = statusData.apps.filter((a) => a.scheme === id);
      const verdicts = [...(id === serverScheme() ? [statusData.citadel.verdict] : []), ...apps.map((a) => a.verdict)];
      if (!verdicts.length) return { st: 'none', line: 'no app' };
      const v = verdicts.reduce((w, x) => (STATUS_RANK[x.tone] > STATUS_RANK[w.tone] ? x : w));
      return { st: STATUS_DOT[v.tone], line: `${apps.length ? `${apps.length} app${apps.length === 1 ? '' : 's'}` : 'server'} · ${STATUS_WORD[v.tone]}` };
    }
    if (CI_TABS.has(tab)) {
      if (!s) return { st: 'none', line: 'no CI' };
      const c = ciSide(s),
        st = stateOf(c, /** @type {CiRead} */ (ciRead).now);
      return { st, line: words(st, c.problems.length) };
    }
    const held = s ? s.problems.filter(holdsDeploys) : [];
    const more = releaseTrouble(id);
    const st = held.some((x) => !x.quiet) ? 'down' : held.length || more.length ? 'fix' : 'ready';
    return { st, line: held.length + more.length ? words(st, held.length + more.length, 'hold') : 'all clear' };
  };
  const worst = (/** @type {string[]} */ sts) => sts.reduce((w, x) => (RANK[x] > (RANK[w] ?? -1) ? x : w), 'ready');

  const drawList = () => {
    const shown = ids().map((id) => ({ id, ...rowOf(id) }));
    const pick = (/** @type {Scope} */ to) => () => {
      pc = null;
      if (to === scope) draw();
      else go(to, to === 'all' && CI_TABS.has(tab) ? 'releases' : tab);
    };
    const row = (/** @type {{ id: number; st: string; line: string }} */ { id, st, line }) =>
      h(
        'button',
        { type: 'button', class: `ci-li${id === scope && !pc ? ' on' : ''}`, 'data-state': st, 'data-scheme': id, 'aria-current': id === scope && !pc ? 'true' : null, onclick: pick(id) },
        h('span', { class: `dot ${st}` }),
        h('span', { class: 'ci-li-name' }, nameOf(id)),
        h('span', { class: 'ci-li-state muted' }, line),
      );
    // All (Home's view, #1282): one row at the top, its dot the worst below it.
    const allRow = h(
      'button',
      { type: 'button', class: `ci-li ci-all${scope === 'all' && !pc ? ' on' : ''}`, 'data-state': worst(shown.map((x) => x.st)), 'aria-current': scope === 'all' && !pc ? 'true' : null, onclick: pick('all') },
      h('span', { class: `dot ${worst(shown.map((x) => x.st))}` }),
      h('span', { class: 'ci-li-name' }, 'All schemes'),
      h('span', { class: 'ci-li-state muted' }, `${shown.length} schemes`),
    );
    // Phones: the all-clear schemes and ones with nothing on this tab sit behind a toggle row that names them.
    const hidden = shown.filter((x) => x.id !== scope && (x.st === 'ready' || x.st === 'none'));
    list.classList.toggle('greens-open', greensOpen);
    // A desktop in trouble turns the CI dot yellow: it leads the list, its words the chip tooltip's.
    const pcs = ciRead?.pcs ?? [];
    const why = pcs.filter(trouble).map((x) =>
      h(
        'button',
        {
          type: 'button',
          class: 'ci-li ci-why',
          'data-tone': 'warn',
          title: x.verdict.text,
          onclick: () => {
            pc = x.host;
            draw();
          },
        },
        h('span', { class: 'dot fix' }),
        h('span', { class: 'ci-li-name' }, troubleLine(x)),
        h('span', { class: 'ci-li-state ci-why-text' }, x.verdict.text),
      ),
    );
    // The desktops at the list's bottom: a toned word each, the load view in the right pane (Josh, 2026-11-19).
    const pcRows = pcs.length
      ? [
          h('div', { class: 'ci-list-head' }, 'Desktops'),
          ...pcs.map((x) => {
            // #2239: every scheme's runners named after it, so the list can't say Fine while some are offline for real.
            const [tone, word] = runsOnWord(
              x,
              (ciRead?.schemes ?? []).flatMap((c) => c.view.runners ?? []),
            );
            return h(
              'button',
              {
                type: 'button',
                class: `ci-li ci-pc${x.host === pc ? ' on' : ''}`,
                'data-host': x.host,
                'aria-current': x.host === pc ? 'true' : null,
                onclick: () => {
                  pc = x.host;
                  draw();
                },
              },
              h('span', { class: `dot ${DOT_OF[tone]}` }),
              h('span', { class: 'ci-li-name' }, x.host),
              h('span', { class: 'ci-li-state' }, toneChip(tone, word)),
            );
          }),
        ]
      : [];
    list.replaceChildren(
      ...why,
      allRow,
      ...shown.map(row),
      hidden.length
        ? h(
            'button',
            {
              type: 'button',
              class: 'ci-more',
              'aria-expanded': String(greensOpen),
              onclick: () => {
                greensOpen = !greensOpen;
                drawList();
                /** @type {HTMLElement | null} */ (list.querySelector('.ci-more'))?.focus();
              },
            },
            h('span', { class: 'dot ready' }),
            h('span', { class: 'ci-li-name' }, greensOpen ? 'Hide' : `${hidden.length} more`),
            h('span', { class: 'ci-li-state muted' }, greensOpen ? '' : hidden.map((x) => nameOf(x.id)).join(', ')),
          )
        : '',
      ...pcRows,
    );
  };

  /** Releases' own holds above its cards: CI's reds and a still ship line, and changes stuck or failed, so its dot's why is on its tab. */
  const holds = () => {
    const s = typeof scope === 'number' ? ciRead?.schemes.find((x) => x.id === scope) : null;
    const held = s ? s.problems.filter(holdsDeploys) : [];
    const more = typeof scope === 'number' ? releaseTrouble(scope) : [];
    if (!held.length && !more.length) return [];
    return [held.length ? problemsBlock({ .../** @type {CiScheme} */ (s), problems: held }) : '', more.length ? block('Held up', 'held', 'rel-held', h('div', { class: 'hue-rows' }, ...more.map((t) => hueRow({ hue: 'held', lead: 'held' }, t)))) : ''];
  };

  const draw = () => keepView(el, drawNow);
  const drawNow = () => {
    title.textContent = ` · ${scope === 'all' ? 'All schemes' : nameOf(scope)}`;
    drawList();
    const s = typeof scope === 'number' ? ciRead?.schemes.find((x) => x.id === scope) : null;
    if (pc) {
      const x = ciRead?.pcs.find((y) => y.host === pc);
      tabsEl.replaceChildren();
      body.replaceChildren(h('div', { class: 'ci-head' }, h('h3', {}, pc), h('span', { class: 'muted small' }, 'CI PC load')), x ? h('div', { class: 'ci-block ci-desktops' }, pcCard(x)) : '', hostLoadBlock(hostRead));
      return;
    }
    // All has no one CI: its tabs are Releases' board and every app's Status. A scheme without CI keeps the CI tabs, each saying so.
    const items = scope === 'all' ? TABS.filter(([k]) => !CI_TABS.has(k) && k !== 'code' && k !== 'flow') : TABS;
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
    // The files are the scheme's own, CI or not.
    if (tab === 'code') {
      const id = /** @type {number} */ (scope); // not All: its tabs leave this one out
      const el = codeTab(id, nameOf(id), code.get(id) ?? null, readTab);
      if (body.firstChild !== el || body.childNodes.length > 1) body.replaceChildren(el);
      return;
    }
    if (tab === 'flow') {
      const id = /** @type {number} */ (scope); // not All: its tabs leave this one out
      const el = flowTab(id, nameOf(id), flow.get(id) ?? null, readTab);
      if (body.firstChild !== el || body.childNodes.length > 1) body.replaceChildren(el);
      return;
    }
    if (!ciRead) return void body.replaceChildren(loadingLine('Reading CI…'));
    if (!s) return void body.replaceChildren(emptyCard(`${nameOf(scope)} has no CI here`, 'A scheme whose repo runs GitHub Actions shows its runs, runners and test health here.', { mark: '·', hue: 'muted' }));
    body.replaceChildren(
      h('div', { class: 'ci-head' }, h('h3', {}, s.name), ext(`https://github.com/${s.view.slug}/actions`, `${s.view.slug} on GitHub`), h('span', { class: 'muted small' }, `read ${ago(s.view.at)}`)),
      ...(tab === 'overview'
        ? overview(s, ciRead.pcs, Date.now(), {
            host: hostRead,
            pool: ciRead.pool ?? null,
            queueOpen,
            toggleQueue: (id) => {
              queueOpen.has(id) ? queueOpen.delete(id) : queueOpen.add(id);
              draw();
              /** @type {HTMLElement | null} */ (body.querySelector(`.queue-toggle[data-group="${CSS.escape(id)}"]`))?.focus();
            },
            hostedOpen,
            toggleHosted: () => {
              hostedOpen = !hostedOpen;
              draw();
              /** @type {HTMLElement | null} */ (body.querySelector('.ci-now-more'))?.focus();
            },
            openPc: (host) => {
              pc = host;
              draw();
            },
          })
        : tab === 'health'
          ? testHealth(s, health.get(s.id) ?? null, readTab)
          : tab === 'numbers'
            ? numbersTab(s, numbers.get(s.id) ?? null, readTab, s.view.runs.some(githubShip))
            : historyTab(s)),
    );
  };

  shell = {
    el,
    projectId,
    drawList,
    go: (to) => {
      const moved = to.scope !== scope || to.tab !== tab;
      scope = to.scope;
      tab = to.tab;
      pc = null;
      draw();
      if (moved) readTab();
    },
  };
  let tried = false;
  const refresh = poller(async () => {
    if (tried && !el.isConnected) return false;
    tried = true;
    try {
      ciRead = await readCi();
      hostRead = await api('api/host-load').catch(() => hostRead);
      paintChips();
      draw();
    } catch (err) {
      if (!ciRead && CI_TABS.has(tab)) body.replaceChildren(h('p', { class: 'error' }, `Couldn't read CI: ${/** @type {Error} */ (err).message}`));
    }
  }, REFRESH_MS);
  draw();
  readTab();
  refresh.now();
  return el;
}

// The chips (the shelf's and the top bar's): Releases and CI share one /api/ci read a minute, each dot its own side of it.
const chips = new Set();
/**
 * @param {number} n
 * @param {string} one
 * @param {string} [many]
 */
const plainCount = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Each chip's dot and words from the last read: CI's runners and desktops, or what holds up deploys (holdsDeploys and the releases' own). */
/** @param {string | undefined} kind */
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
/** @param {HTMLElement} c */
const paintChip = (c) => {
  const look = chipLook(c.dataset.kind);
  if (!look) return;
  c.hidden = look.hidden;
  c.dataset.placed = '1';
  c.title = look.title;
  c.setAttribute('aria-label', look.title || /** @type {string} */ (c.dataset.kind));
  /** @type {Element} */ (c.querySelector('.dot')).className = `dot ${look.worst}`;
};
// Held weakly: a chip in a page left behind would otherwise keep that whole page until the next minute's read (#1747).
function paintChips() {
  for (const r of chips) {
    const c = r.deref();
    if (!c || (c.dataset.placed && !c.isConnected)) chips.delete(r);
    else paintChip(c);
  }
}
// Releases arriving move the Releases dot and the page's list at once, between reads.
onReleasesRedraw(() => {
  paintChips();
  if (shell?.el.isConnected) shell.drawList();
});

const chipPoll = poller(async () => {
  paintChips();
  if (!chips.size) return false;
  try {
    ciRead = await readCi();
    paintChips();
  } catch {
    // The last colour stays: the next minute asks again.
  }
}, 60_000);

/**
 * @param {string} kind
 * @param {string} label
 * @param {string} page
 * @param {number | null} projectId
 */
function chip(kind, label, page, projectId) {
  const c = h(
    'a',
    {
      class: `ci-chip ${kind}-chip`,
      'data-kind': kind,
      hidden: kind === 'ci',
      href: projectId ? `#/p/${projectId}/${page}` : '#/',
      onclick: () => {
        opening();
        c.href = scopedPageHash(page, projectId ?? view?.projectId, localStorage.getItem(LAST_SCHEME) ?? 2);
      },
    },
    h('span', { class: 'dot asleep' }),
    h('span', { class: 'label' }, label),
  );
  chips.add(new WeakRef(c));
  paintChip(c);
  if (projectId === null) c.dataset.placed = '1';
  chipPoll.now();
  return c;
}

/** The CI chip: a dot and "CI", opening the Releases page's Overview for the scheme on screen (or `projectId`). Hidden until a scheme with CI is there. */
export const ciChip = (projectId = null) => chip('ci', 'CI', 'ci', projectId);

/** The Releases chip (#1423): a dot and "Releases", opening the Releases page on its Releases tab; its dot is what holds up deploys. */
export const releasesChip = (projectId = null) => chip('releases', 'Releases', 'releases', projectId);
