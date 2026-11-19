// The CI page's Test health tab (#1063, Josh 2026-11-19: "Add a button to start a minion to fix up flaky tests"): fast mode's state and
// its known reds for the scheme, and its flakiest test files of the last 14 days (src/flakes.ts counts them from the events land.sh
// and fast mode's runs leave). Each file offers "Start a minion to fix it", which shows the brief first and starts a bug minion.
import { ago, api, h } from './base.js';
import { openDialog } from './ui/dialog.js';

const LA = { timeZone: 'America/Los_Angeles', timeZoneName: 'short' };
const when = (t) => new Date(t).toLocaleString('en-US', { ...LA, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const FAST = {
  running: ['running', 'running', 'The full check is running on main now.'],
  pinning: ['running', 'finding the culprit', "A red covers several ships; each commit is being checked oldest first to find whose change broke it."],
  verified: ['ready', 'verified', "Main's newest commit has a verdict: green, or red only on the known reds below."],
  stuck: ['fix', 'stuck', "The last run gave no verdict (CI never answered); it isn't retried until main moves."],
  idle: ['asleep', 'waiting', 'Fast mode has not run its check on main yet.'],
};

function fastBlock(s, fast, now) {
  if (!fast) return h('section', { class: 'ci-block' }, h('h4', {}, 'Fast mode'), h('p', { class: 'muted' }, 'Fast mode is off here: every ship waits for the full tests before it goes live.'));
  const [dot, word, why] = FAST[fast.state] ?? FAST.idle;
  const reds = fast.reds.map((r) => {
    const left = r.escalateAt - now;
    const timer = r.escalated ? 'the Taskmaster has it' : left > 0 ? `reaches the Taskmaster in ${Math.ceil(left / 60_000)} min` : 'reaches the Taskmaster now';
    return h('div', { class: 'ci-run ci-health-run', title: r.ids.join(', ') },
      h('span', { class: 'dot down' }), h('span', { class: 'ci-run-word' }, 'red'),
      h('span', { class: 'ci-run-name', title: r.ids.join(', ') }, r.ids.join(', ')),
      h('span', { class: 'ci-run-who muted' }, `since ${r.sha.slice(0, 9)} · ${r.n ? `#${r.n} is fixing it` : 'no minion pinned'} · ${timer}`),
      h('span', { class: 'ci-run-age muted' }, ago(r.at)));
  });
  return h('section', { class: 'ci-block' }, h('h4', {}, 'Fast mode'),
    h('div', { class: 'ci-runs' },
      h('div', { class: 'ci-run ci-health-run', title: why }, h('span', { class: `dot ${dot}` }), h('span', { class: 'ci-run-word' }, word),
        h('span', { class: 'ci-run-name' }, 'Full check on main'), h('span', { class: 'ci-run-who muted' }, why), h('span', { class: 'ci-run-age muted' }, fast.verified ? fast.verified.slice(0, 9) : '')),
      ...reds,
      ...(fast.pin ? [h('div', { class: 'ci-run ci-health-run' }, h('span', { class: 'dot fix' }), h('span', { class: 'ci-run-word' }, 'pinning'),
        h('span', { class: 'ci-run-name' }, fast.pin.ids.join(', ')), h('span', { class: 'ci-run-who muted' }, 'failing ids not yet blamed on a commit'), h('span', { class: 'ci-run-age muted' }))] : [])),
    reds.length || fast.pin ? '' : h('p', { class: 'muted small' }, 'No known reds: nothing is failing on main.'));
}

/** The brief, read first, then a Start button: a person confirms before the minion exists. */
async function startFix(projectId, f, refresh) {
  const err = h('p', { class: 'error', hidden: true });
  let brief;
  try { brief = await api(`api/projects/${projectId}/flake-brief?file=${encodeURIComponent(f.file)}`); } catch (ex) { alert(ex.message); return; }
  const btn = h('button', { type: 'submit' }, 'Start minion');
  const form = h('form', { class: 'start-brief-form' },
    h('p', { class: 'muted small' }, 'A bug minion starts in this scheme with this first message.'),
    h('label', {}, 'Title', h('input', { name: 'title', value: brief.title, readonly: true })),
    h('pre', { class: 'artifact-text' }, brief.message), err,
    h('div', { class: 'row sheet-actions' }, h('span', { class: 'spacer' }), h('button', { type: 'button', class: 'secondary', onclick: () => dialog.close() }, 'Cancel'), btn));
  const dialog = openDialog({ title: 'Start a minion to fix it', className: 'new-scheme start-brief', body: [form] });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    btn.disabled = true;
    btn.textContent = 'Starting…';
    try {
      await api(`api/projects/${projectId}/tickets`, { method: 'POST', body: { title: brief.title, message: brief.message, properties: { type: 'bug' } } });
      dialog.close();
      refresh();
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
      btn.disabled = false;
      btn.textContent = 'Start minion';
    }
  });
}

function flakeBlock(s, flakes, refresh) {
  const row = (f) => h('div', { class: 'ci-run ci-health-run' },
    h('span', { class: 'dot fix' }), h('span', { class: 'ci-run-word' }, `${f.count}×`),
    h('span', { class: 'ci-run-name', title: f.file }, f.file),
    h('span', { class: 'ci-run-who muted' }, `last ${when(f.last)}`, f.lastMinion ? [' · ', h('a', { href: `#/p/${s.id}/t/${f.ticketId}` }, `#${f.lastMinion}'s land`)] : ' · fast mode'),
    h('span', { class: 'ci-run-act' }, f.minion ? h('a', { href: `#/p/${s.id}/t/${f.minion}` }, `#${f.minion} is on it`)
      : h('button', { type: 'button', class: 'secondary small', onclick: () => startFix(s.id, f, refresh) }, 'Start a minion to fix it')));
  return h('section', { class: 'ci-block' }, h('h4', {}, 'Flaky tests, last 14 days'),
    flakes.length ? h('div', { class: 'ci-runs' }, ...flakes.map(row)) : h('p', { class: 'muted' }, 'No flaky test file reported in the last 14 days. Only schemes whose land script prints flake lines report them.'));
}

/** The tab's sections for scheme `s`; `data` is its /test-health read, null until it arrives. */
export function testHealth(s, data, refresh) {
  if (data?.error) return [h('p', { class: 'muted' }, "Couldn't read test health. Pick the tab again to retry.")];
  if (!data) return [h('p', { class: 'muted' }, 'Reading test health…')];
  return [fastBlock(s, data.fast, data.now), flakeBlock(s, data.flakes, refresh)];
}

export const readHealth = (id) => api(`api/projects/${id}/test-health`);
