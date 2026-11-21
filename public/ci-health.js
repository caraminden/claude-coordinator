// The CI page's Test health tab (#1063, Josh 2026-11-19: "Add a button to start a minion to fix up flaky tests"): fast mode's state and
// its known reds for the scheme, and its flakiest test files of the last 14 days (src/flakes.ts counts them from the events land.sh
// and fast mode's runs leave). Each file offers "Start a minion to fix it", which shows the brief first and starts a bug minion.
import { ago, api, h, pacificStamp } from './base.js';
import { emptyCard, hueRow, showFirst, statTiles, toneChip } from './look.js';
import { settingsRow } from './settings.js';
import { openDialog } from './ui/dialog.js';

const when = pacificStamp;
// state -> [tone, closed word, hue, why]
const FAST = {
  running: ['info', 'Running', 'running', 'The full check is running on main now.'],
  pinning: ['info', 'Finding the culprit', 'running', "A red covers several ships; each commit is being checked oldest first to find whose change broke it."],
  verified: ['ok', 'Verified', 'done', "Main's newest commit has a verdict: green, or red only on the known reds below."],
  stuck: ['warn', 'Stuck', 'waiting', "The last run gave no verdict (CI never answered); it isn't retried until main moves."],
  idle: ['neutral', 'Waiting', 'held', 'Fast mode has not run its check on main yet.'],
};
const block = (title, hue, row) => h('section', { class: 'ci-block' }, h('h3', { class: 'settings-section', 'data-hue': hue }, title), h('div', { class: 'settings-rows' }, row));

function fastBlock(s, fast, now) {
  if (!fast) {
    const [row] = settingsRow({ key: `health-fast-${s.id}`, icon: 'spark', hue: 'held', title: 'Fast mode', summary: [toneChip('neutral', 'Off'), 'every ship waits for the full tests'] },
      h('p', { class: 'look-prose' }, 'Fast mode is off here: every ship waits for the full tests before it goes live.'));
    return block('Fast mode', 'held', row);
  }
  const [tone, word, hue, why] = FAST[fast.state] ?? FAST.idle;
  const reds = fast.reds.map((r) => {
    const left = r.escalateAt - now;
    const timer = r.escalated ? 'the Taskmaster has it' : left > 0 ? `reaches the Taskmaster in ${Math.ceil(left / 60_000)} min` : 'reaches the Taskmaster now';
    return hueRow({ hue: 'danger', lead: 'red', meta: ago(r.at) }, h('strong', { title: r.ids.join(', ') }, r.ids.join(', ')),
      h('span', { class: 'ci-detail-line muted' }, `since ${r.sha.slice(0, 9)} · ${r.n ? `#${r.n} is fixing it` : 'no minion pinned'} · ${timer}`));
  });
  const nReds = reds.length;
  const [row] = settingsRow({ key: `health-fast-${s.id}`, icon: 'spark', hue: nReds ? 'danger' : hue, title: 'Fast mode',
    summary: [toneChip(tone, word), nReds ? toneChip('danger', `${nReds} known red${nReds === 1 ? '' : 's'}`) : 'no known reds'] },
  statTiles([word, 'full check on main', hue], [String(nReds), 'known reds', nReds ? 'danger' : 'done'], fast.verified && [fast.verified.slice(0, 9), 'last verified commit', 'done']),
  h('div', { class: 'hue-rows' },
    hueRow({ hue, lead: word.toLowerCase(), meta: fast.verified ? fast.verified.slice(0, 9) : null }, h('strong', {}, 'Full check on main'), h('span', { class: 'ci-detail-line muted' }, why)),
    ...reds,
    ...(fast.pin ? [hueRow({ hue: 'waiting', lead: 'pinning' }, h('strong', {}, fast.pin.ids.join(', ')), h('span', { class: 'ci-detail-line muted' }, 'failing ids not yet blamed on a commit'))] : [])),
  nReds || fast.pin ? null : emptyCard('No known reds', 'Nothing is failing on main.'));
  return block('Fast mode', nReds ? 'danger' : hue, row);
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

/** A file's top error messages with counts and class (#1438); sightings that kept none say so. */
function errorLines(f) {
  const lines = (f.messages ?? []).map((m) => h('span', { class: 'ci-detail-line muted', title: m.message }, `${m.count}× ${m.cls || 'other'}: ${m.message.split('\n')[0].slice(0, 140)}`));
  if (f.none) lines.push(h('span', { class: 'ci-detail-line muted' }, `${f.none} no message kept`));
  return lines;
}

function flakeBlock(s, flakes, refresh) {
  const total = flakes.reduce((n, f) => n + f.count, 0);
  // The fix (#1120): owner and age, and the clean runs of the 50 in a row the desktop needs before it counts as held.
  const fixLine = (fx) => {
    const owner = fx.owner ? `${fx.owner}'s ` : '';
    const age = ago(fx.startedAt);
    if (fx.state === 'held' && !fx.cleanRuns) return `fix held before the desktop proof existed, ${ago(fx.heldAt)}`;
    if (fx.state === 'held') return `fix held: ${fx.cleanRuns}/${fx.need} clean runs on the desktop, ${ago(fx.heldAt)}`;
    return `${fx.reopened ? 'reopened, ' : ''}${owner}fix started ${age}: ${fx.cleanRuns}/${fx.need} clean runs on the desktop`;
  };
  const item = (f) => hueRow({ hue: f.fix?.state === 'held' ? 'done' : 'waiting', lead: `${f.count}×`,
    meta: f.minion ? h('a', { href: `#/p/${s.id}/t/${f.minion}` }, `#${f.minion} ${f.fix?.state === 'held' ? 'fixed it' : 'is on it'}`)
      : h('button', { type: 'button', class: 'secondary small', onclick: () => startFix(s.id, f, refresh) }, 'Start a minion to fix it') },
  h('strong', { title: f.file }, f.file),
  h('span', { class: 'ci-detail-line muted' }, `last ${when(f.last)}`, f.before ? ` · ${f.before} before the file's last change` : '', f.lastMinion ? [' · ', h('a', { href: `#/p/${s.id}/t/${f.ticketId}` }, `#${f.lastMinion}'s land`)] : ' · fast mode'),
  ...errorLines(f),
  f.fix ? h('span', { class: 'ci-detail-line muted flake-fix' }, fixLine(f.fix)) : null);
  const [row] = settingsRow({ key: `health-flakes-${s.id}`, icon: 'chart', hue: flakes.length ? 'waiting' : 'done', title: 'Flaky tests, last 14 days',
    summary: flakes.length ? [toneChip('warn', `${flakes.length} file${flakes.length === 1 ? '' : 's'}`), `${total} flake${total === 1 ? '' : 's'}`] : [toneChip('ok', 'None'), 'no flaky test file reported'] },
  flakes.length ? statTiles([String(flakes.length), 'flaky files', 'waiting'], [String(total), 'flakes in 14 days', 'waiting']) : null,
  flakes.length ? showFirst({ key: `health-flakes-${s.id}`, items: flakes.map(item), n: 5, noun: 'files' })
    : emptyCard('No flaky test file', 'Only schemes whose land script prints flake lines report them.'));
  return block('Flaky tests', flakes.length ? 'waiting' : 'done', row);
}

/** The tab's sections for scheme `s`; `data` is its /test-health read, null until it arrives. */
export function testHealth(s, data, refresh) {
  if (data?.error) return [h('p', { class: 'muted' }, "Couldn't read test health. Pick the tab again to retry.")];
  if (!data) return [h('p', { class: 'muted' }, 'Reading test health…')];
  return [fastBlock(s, data.fast, data.now), flakeBlock(s, data.flakes, refresh)];
}

export const readHealth = (id) => api(`api/projects/${id}/test-health`);
