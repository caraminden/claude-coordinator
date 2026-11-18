// The CI page (#968, Cara 2026-11-18: "maybe mandate could link to a ci status/issues page within citadel"; layout B,
// "Scheme list on the left, detail on the right", with "the CI box performance page from machines" in it): every
// scheme with CI, its open problems with what, why and the fix, each workflow's verdict on main, the queue, recent runs
// and its runners, plus the CI desktop's load. It reads /api/ci (src/ci-health.ts snapshot) and changes nothing.
// The CI chip by the usage meter ("Chip by the usage meter") opens it, its dot the worst of what the page shows.
import { ago, api, h, view } from './base.js';
import { pcCard, trouble } from './ci-desktop.js';
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
    x.fix ? h('p', {}, h('span', { class: 'muted' }, 'Fix: '), x.fix) : '');
}

const verdictClass = (c) => (c === 'success' ? 'ready' : c === 'failure' ? 'down' : c ? 'asleep' : 'running');

function runRow(r) {
  const word = r.status === 'completed' ? r.conclusion ?? 'done' : r.status.replace('_', ' ');
  return h('a', { class: 'ci-run', href: r.url, target: '_blank', rel: 'noopener', title: `${r.name} on ${r.branch}: ${word}, ${when(r.at)}` },
    h('span', { class: `dot ${verdictClass(r.status === 'completed' ? r.conclusion : null)}` }),
    h('span', { class: 'ci-run-word' }, word),
    h('span', { class: 'ci-run-name' }, r.name),
    h('span', { class: 'ci-run-branch muted' }, r.branch),
    h('span', { class: 'ci-run-age muted' }, ago(Date.parse(r.at))));
}

function overview(s) {
  const v = s.view;
  return [
    h('section', { class: 'ci-block' }, h('h4', {}, 'Open problems'),
      s.problems.length ? h('div', { class: 'ci-problems' }, ...s.problems.map(problemCard)) : h('p', { class: 'muted' }, 'Nothing needs fixing.')),
    h('section', { class: 'ci-block' }, h('h4', {}, `Verdicts on ${v.branch}`),
      h('div', { class: 'ci-runs' }, ...v.workflows.map((w) => w.verdict
        ? h('div', { class: 'ci-verdict-row' }, runRow({ ...w.verdict, name: w.name }),
          w.skipped.length ? h('p', { class: 'muted small ci-skipped' }, `Green, but skipped ${w.skipped.join(', ')}, which ran in the verdict before it.`) : '')
        : h('div', { class: 'ci-run' }, h('span', { class: 'dot asleep' }), h('span', { class: 'ci-run-word muted' }, 'no verdict'), h('span', { class: 'ci-run-name' }, w.name))))),
    h('section', { class: 'ci-block' }, h('h4', {}, 'Waiting for a runner'),
      v.waiting.length ? h('div', { class: 'ci-runs' }, ...v.waiting.map((j) => h('a', { class: 'ci-run', href: `https://github.com/${v.slug}/actions/runs/${j.run}`, target: '_blank', rel: 'noopener' },
        h('span', { class: 'dot fix' }), h('span', { class: 'ci-run-word' }, 'queued'), h('span', { class: 'ci-run-name' }, j.name),
        h('span', { class: 'ci-run-branch muted' }, j.labels.join(', ')), h('span', { class: 'ci-run-age muted' }, ago(Date.parse(j.since))))))
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
      ...(tab === 'overview' ? overview(s)
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
    for (const c of chips) {
      c.hidden = !schemes.length;
      c.dataset.placed = '1';
      c.title = title;
      c.setAttribute('aria-label', title || 'CI');
      c.querySelector('.dot').className = `dot ${worst}`;
    }
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
  if (projectId === null) c.dataset.placed = '1';
  if (chipTimer) clearTimeout(chipTimer);
  chipTimer = setTimeout(readChips, 0);
  return c;
}
