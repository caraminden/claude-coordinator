// The CI page's Test health tab (#1063, Josh 2026-11-19: "Add a button to start a minion to fix up flaky tests"): fast mode's state and
// its known reds for the scheme, and its flakiest test files of the last 14 days (src/flakes.ts counts them from the events land.sh
// and fast mode's runs leave). Each file offers "Start a minion to fix it", which shows the brief first and starts a bug minion.
/** @import { FastModeView, FlakeFile, FlakeFix, LandReds, LandRedCause, SweepNight, TestHealth, ReadFailed } from './types/ci.js' */
import { ago, api, h, pacificStamp } from './base.js';
import { emptyCard, hueRow, meter, showFirst, statTiles, toneChip } from './look.js';
import { settingsRow } from './settings.js';
import { openDialog } from './ui/dialog.js';

const when = pacificStamp;
// state -> [tone, closed word, hue, why]
/** @type {Record<string, [string, string, string, string]>} */
const FAST = {
  running: ['info', 'Running', 'running', 'The full check is running on main now.'],
  pinning: ['info', 'Finding the culprit', 'running', 'A red covers several ships; each commit is being checked oldest first to find whose change broke it.'],
  verified: ['ok', 'Verified', 'done', "Main's newest commit has a verdict: green, or red only on the known reds below."],
  stuck: ['warn', 'Stuck', 'waiting', "The last run gave no verdict (CI never answered); it isn't retried until main moves."],
  idle: ['neutral', 'Waiting', 'held', 'Fast mode has not run its check on main yet.'],
};
/**
 * @param {string} title
 * @param {string} hue
 * @param {Node} row
 */
const block = (title, hue, row) => h('section', { class: 'ci-block' }, h('h3', { class: 'settings-section', 'data-hue': hue }, title), h('div', { class: 'settings-rows' }, row));

/**
 * @param {{ id: number }} s
 * @param {FastModeView | null} fast
 * @param {number} now
 */
function fastBlock(s, fast, now) {
  if (!fast) {
    const [row] = settingsRow({ key: `health-fast-${s.id}`, icon: 'spark', hue: 'held', title: 'Fast mode', summary: [toneChip('neutral', 'Off'), 'every ship waits for the full tests'] }, h('p', { class: 'look-prose' }, 'Fast mode is off here: every ship waits for the full tests before it goes live.'));
    return block('Fast mode', 'held', row);
  }
  const [tone, word, hue, why] = FAST[fast.state] ?? FAST.idle;
  const reds = fast.reds.map((r) => {
    const left = r.escalateAt - now;
    const timer = r.escalated ? 'the Taskmaster has it' : left > 0 ? `reaches the Taskmaster in ${Math.ceil(left / 60_000)} min` : 'reaches the Taskmaster now';
    return hueRow({ hue: 'danger', lead: 'red', meta: ago(r.at) }, h('strong', { title: r.ids.join(', ') }, r.ids.join(', ')), h('span', { class: 'ci-detail-line muted' }, `since ${r.sha.slice(0, 9)} · ${r.n ? `#${r.n} is fixing it` : 'no minion pinned'} · ${timer}`));
  });
  const nReds = reds.length;
  const [row] = settingsRow(
    { key: `health-fast-${s.id}`, icon: 'spark', hue: nReds ? 'danger' : hue, title: 'Fast mode', summary: [toneChip(tone, word), nReds ? toneChip('danger', `${nReds} known red${nReds === 1 ? '' : 's'}`) : 'no known reds'] },
    statTiles([word, 'full check on main', hue], [String(nReds), 'known reds', nReds ? 'danger' : 'done'], fast.verified && [fast.verified.slice(0, 9), 'last verified commit', 'done']),
    h(
      'div',
      { class: 'hue-rows' },
      hueRow({ hue, lead: word.toLowerCase(), meta: fast.verified ? fast.verified.slice(0, 9) : null }, h('strong', {}, 'Full check on main'), h('span', { class: 'ci-detail-line muted' }, why)),
      ...reds,
      ...(fast.pin ? [hueRow({ hue: 'waiting', lead: 'pinning' }, h('strong', {}, fast.pin.ids.join(', ')), h('span', { class: 'ci-detail-line muted' }, 'failing ids not yet blamed on a commit'))] : []),
    ),
    nReds || fast.pin ? null : emptyCard('No known reds', 'Nothing is failing on main.'),
  );
  return block('Fast mode', nReds ? 'danger' : hue, row);
}

/** The brief, read first, then a Start button: a person confirms before the minion exists. */
/**
 * @param {number} projectId
 * @param {FlakeFile} f
 * @param {() => void} refresh
 */
async function startFix(projectId, f, refresh) {
  const err = h('p', { class: 'error', hidden: true });
  let brief;
  try {
    brief = await api(`api/projects/${projectId}/flake-brief?file=${encodeURIComponent(f.file)}`);
  } catch (ex) {
    alert(/** @type {Error} */ (ex).message);
    return;
  }
  const btn = h('button', { type: 'submit' }, 'Start minion');
  const form = h(
    'form',
    { class: 'start-brief-form' },
    h('p', { class: 'muted small' }, 'A bug minion starts in this scheme with this first message.'),
    h('label', {}, 'Title', h('input', { name: 'title', value: brief.title, readonly: true })),
    h('pre', { class: 'artifact-text' }, brief.message),
    err,
    h('div', { class: 'row sheet-actions' }, h('span', { class: 'spacer' }), h('button', { type: 'button', class: 'secondary', onclick: () => dialog.close() }, 'Cancel'), btn),
  );
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
      err.textContent = /** @type {Error} */ (ex).message;
      err.hidden = false;
      btn.disabled = false;
      btn.textContent = 'Start minion';
    }
  });
}

/** A file's top error messages with counts and class (#1438); sightings that kept none say so. */
/** @param {FlakeFile} f */
function errorLines(f) {
  const lines = (f.messages ?? []).map((m) => h('span', { class: 'ci-detail-line muted', title: m.message }, `${m.count}× ${m.cls || 'other'}: ${m.message.split('\n')[0].slice(0, 140)}`));
  if (f.none) lines.push(h('span', { class: 'ci-detail-line muted' }, `${f.none} no message kept`));
  return lines;
}

/**
 * @param {{ id: number }} s
 * @param {FlakeFile[]} flakes
 * @param {() => void} refresh
 */
function flakeBlock(s, flakes, refresh) {
  const total = flakes.reduce((n, f) => n + f.count, 0);
  // The fix (#1120): owner and age, and the clean runs of the 50 (5 batches of 10 copies at once, #1443) the desktop needs before it counts as held.
  /** @param {FlakeFix} fx */
  const fixLine = (fx) => {
    const owner = fx.owner ? `${fx.owner}'s ` : '';
    const age = ago(fx.startedAt);
    if (fx.state === 'held' && !fx.cleanRuns) return `fix held before the desktop proof existed, ${ago(fx.heldAt)}`;
    if (fx.state === 'held') return `fix held: ${fx.cleanRuns}/${fx.need} clean runs on the desktop, ${ago(fx.heldAt)}`;
    return `${fx.reopened ? 'reopened, ' : ''}${owner}fix started ${age}: ${fx.cleanRuns}/${fx.need} clean runs on the desktop`;
  };
  /** @param {FlakeFile} f */
  const item = (f) =>
    hueRow(
      {
        hue: f.fix?.state === 'held' ? 'done' : 'waiting',
        lead: `${f.count}×`,
        meta: f.minion ? h('a', { href: `#/p/${s.id}/t/${f.minion}` }, `#${f.minion} ${f.fix?.state === 'held' ? 'fixed it' : 'is on it'}`) : h('button', { type: 'button', class: 'secondary small', onclick: () => startFix(s.id, f, refresh) }, 'Start a minion to fix it'),
      },
      h('span', {}, h('strong', { title: f.file }, f.file), f.cloud && f.cloud === f.count ? [' ', toneChip('violet', 'cloud only')] : null),
      f.cloud && f.cloud === f.count ? h('span', { class: 'ci-detail-line muted' }, 'Seen only by the nightly cloud sweep, on a 4-vCPU VM: it starts no fix minion and refuses no ship.') : null,
      h(
        'span',
        { class: 'ci-detail-line muted' },
        `last ${when(f.last)}`,
        f.cloud && f.cloud < f.count ? ` · ${f.cloud} in the cloud sweep` : '',
        f.before ? ` · ${f.before} before the file's last change` : '',
        f.lastMinion ? [' · ', h('a', { href: `#/p/${s.id}/t/${f.lastMinion}` }, `#${f.lastMinion}'s land`)] : ' · fast mode',
      ),
      ...errorLines(f),
      f.fix ? h('span', { class: 'ci-detail-line muted flake-fix' }, fixLine(f.fix)) : null,
    );
  const [row] = settingsRow(
    {
      key: `health-flakes-${s.id}`,
      icon: 'chart',
      hue: flakes.length ? 'waiting' : 'done',
      title: 'Flaky tests, last 14 days',
      summary: flakes.length ? [toneChip('warn', `${flakes.length} file${flakes.length === 1 ? '' : 's'}`), `${total} flake${total === 1 ? '' : 's'}`] : [toneChip('ok', 'None'), 'no flaky test file reported'],
    },
    flakes.length ? statTiles([String(flakes.length), 'flaky files', 'waiting'], [String(total), 'flakes in 14 days', 'waiting']) : null,
    flakes.length ? showFirst({ key: `health-flakes-${s.id}`, items: flakes.map(item), n: 5, noun: 'files' }) : emptyCard('No flaky test file', 'Only schemes whose land script prints flake lines report them.'),
  );
  return block('Flaky tests', flakes.length ? 'waiting' : 'done', row);
}

// The nightly cloud sweep (#2187, src/cloud-flakes.ts): each night's files and verdicts beside its sessions, minutes and cost.
// verdict -> [hue, what it means]
/** @type {Record<string, [string, string]>} */
const VERDICT = {
  flaky: ['waiting', 'some copies failed: a cloud sighting'],
  red: ['danger', 'failed alone on the VM too: a plain red or the VM itself'],
  skipped: ['held', 'a test skipped on the VM, so it proves nothing'],
  stopped: ['held', 'over the 25-minute step'],
  clean: ['done', 'every copy passed'],
};
/** @param {number} usd */
const dollars = (usd) => `$${usd.toFixed(2)}`;

/**
 * @param {{ id: number }} s
 * @param {SweepNight[]} sweeps
 */
function sweepBlock(s, sweeps) {
  const key = `health-sweep-${s.id}`;
  const title = 'Nightly cloud sweep';
  const last = sweeps[0];
  if (!last) {
    const [row] = settingsRow(
      { key, icon: 'spark', hue: 'held', title, summary: [toneChip('neutral', 'No runs'), 'no night swept yet'] },
      emptyCard('No night swept yet', "A schedule's minion runs tools/cloud-flake.ts sweep: the flakiest files, about 10 copies each, in a cloud session on main's tip.", { mark: '–', hue: 'held' }),
    );
    return block(title, 'held', row);
  }
  /** @param {SweepNight} n */
  const flakyIn = (n) => n.files.filter((f) => f.verdict === 'flaky').length;
  const flaky = flakyIn(last);
  const order = Object.keys(VERDICT);
  const files = [...last.files]
    .sort((a, b) => order.indexOf(a.verdict) - order.indexOf(b.verdict))
    .map((f) => {
      const [hue, why] = VERDICT[f.verdict] ?? VERDICT.red;
      return hueRow({ hue, lead: f.verdict, meta: `${f.failed}/${f.copies} failed · ${f.seconds} s` }, h('strong', { title: f.file }, f.file), h('span', { class: 'ci-detail-line muted', title: f.detail }, why));
    });
  const nights = sweeps.map((n) =>
    hueRow(
      { hue: n.error ? 'danger' : flakyIn(n) ? 'waiting' : 'done', lead: dollars(n.costUsd), meta: n.minion ? h('a', { href: `#/p/${s.id}/t/${n.minion}` }, `#${n.minion}`) : null },
      h('strong', {}, when(n.at)),
      h('span', { class: 'ci-detail-line muted' }, n.error ? `no results: ${n.error.split('\n')[0].slice(0, 140)}` : `${n.files.length} files, ${flakyIn(n)} flaky · ${n.sessions} session × ${Math.round(n.minutes)} min${n.sha ? ` · ${n.sha.slice(0, 9)}` : ''}`),
    ),
  );
  const hue = last.error ? 'danger' : flaky ? 'waiting' : 'done';
  const [row] = settingsRow(
    { key, icon: 'spark', hue, title, summary: [last.error ? toneChip('danger', 'No results') : flaky ? toneChip('warn', `${flaky} flaky`) : toneChip('ok', 'Clean'), `${when(last.at)} · ${dollars(last.costUsd)}`] },
    statTiles([String(last.files.length), 'files swept', 'running'], [String(flaky), 'flaky in the cloud', flaky ? 'waiting' : 'done'], [`${last.sessions} × ${Math.round(last.minutes)} min`, 'sessions × minutes', 'held'], [dollars(last.costUsd), 'plan usage (est.)', 'held']),
    files.length ? showFirst({ key: `${key}-files`, items: files, n: 5, noun: 'files' }) : null,
    h('h4', { class: 'settings-section' }, 'Last nights'),
    showFirst({ key: `${key}-nights`, items: nights, n: 5, noun: 'nights' }),
    h('p', { class: 'look-prose' }, "Runs on the schedule owner's own plan. A flaky file becomes a cloud sighting under Flaky tests; a cloud VM has 4 vCPU, so those never start a fix minion or refuse a ship."),
  );
  return block(title, hue, row);
}

// Land runs' reds by cause (#1607, src/land-reds.ts): the raw red rate, and the part a ship's own change caused.
// cause -> [hue, word, what it means]
/** @type {Record<string, [string, string, string]>} */
const CAUSE = {
  change: ['danger', 'change', "pinned on a ship's change, or refused at CI"],
  flaky: ['waiting', 'flaky', 'passed alone, a burn-in race or a known flake'],
  main: ['held', "main's red", 'main was red on the same test'],
  unknown: ['muted', 'unknown', 'nothing in the retro log (a time-out)'],
};
/**
 * @param {number} n
 * @param {number} of
 */
const pct = (n, of) => (of ? Math.round((100 * n) / of) : 0);

/**
 * @param {{ id: number }} s
 * @param {LandReds | null} lr
 */
function landRedsBlock(s, lr) {
  const key = `health-landreds-${s.id}`;
  const title = 'Land runs, last 24 hours';
  if (!lr) {
    const [row] = settingsRow({ key, icon: 'chart', hue: 'held', title, summary: [toneChip('neutral', 'Not read'), 'no GitHub runs to count'] }, emptyCard('Not read', 'This scheme has no GitHub repo, or GitHub reads are paused for now.', { mark: '–', hue: 'held' }));
    return block('Land runs', 'held', row);
  }
  const done = lr.green + lr.red;
  const raw = pct(lr.red, done);
  const own = pct(lr.causes.change, done);
  // A scheme whose ship script writes no retro log reads every red as unknown: no rate to claim then.
  const unread = lr.causes.unknown * 2 >= lr.red && lr.red > 0;
  const tone = unread ? 'neutral' : own >= 25 ? 'danger' : own > 0 ? 'warn' : 'ok';
  const hue = { danger: 'danger', warn: 'waiting', ok: 'done', neutral: 'muted' }[tone];
  const causes = /** @type {LandRedCause[]} */ (Object.keys(CAUSE))
    .filter((c) => lr.causes[c])
    .map((c) => {
      const [h2, word, why] = CAUSE[c];
      const n = lr.causes[c];
      return hueRow({ hue: h2, lead: String(n), meta: meter(n / lr.red, `${pct(n, lr.red)}% of reds`) }, h('strong', {}, word), h('span', { class: 'ci-detail-line muted' }, why), c === 'change' && lr.riders ? h('span', { class: 'ci-detail-line muted' }, `${lr.riders} by another ship on the train`) : null);
    });
  const reds = [...lr.reds].reverse().map((r) => {
    const [h2, word] = CAUSE[r.cause] ?? CAUSE.unknown;
    const n = r.branch.match(/^ticket\/(\d+)-/)?.[1];
    return hueRow(
      { hue: h2, meta: r.url ? h('a', { href: r.url, target: '_blank', rel: 'noopener' }, 'run') : null },
      h('span', {}, n ? h('a', { href: `#/p/${s.id}/t/${n}` }, h('strong', {}, `#${n}`)) : h('strong', {}, r.branch), ` · ${word}`),
      h('span', { class: 'ci-detail-line muted' }, `${when(Date.parse(r.at))} · ${r.why}${r.rider ? ' (another ship on its train)' : ''}`),
    );
  });
  const [row] = settingsRow(
    { key, icon: 'chart', hue: lr.red ? hue : 'done', title, summary: done ? [toneChip(tone, unread ? `${lr.causes.unknown} reds unread` : `${own}% from a change`), `${raw}% of ${done} red`] : [toneChip('neutral', 'None'), 'no land runs finished'] },
    done ? statTiles([String(done), lr.other ? `finished runs · ${lr.other} going or cancelled` : 'finished runs', 'running'], [`${raw}%`, 'red', lr.red ? 'waiting' : 'done'], [unread ? '–' : `${own}%`, unread ? 'reds unread' : "red from a ship's change", hue]) : null,
    causes.length ? h('div', { class: 'hue-rows' }, ...causes) : null,
    reds.length ? showFirst({ key, items: reds, n: 5, noun: 'red runs' }) : emptyCard(done ? 'No red land runs' : 'No land runs', done ? 'Every ship that finished its CI run went green.' : 'No ship ran its tests on GitHub in the last 24 hours.'),
    lr.partial ? h('p', { class: 'look-prose' }, `Only the newest ${lr.runs} runs were read: GitHub had more in the day than the tab reads.`) : null,
    h('p', { class: 'look-prose' }, "Each red run counts under one cause, read from the lines the ship script writes to the retro log. The red rate from a change leaves out flaky runs and main's own reds."),
  );
  return block('Land runs', lr.red ? hue : 'done', row);
}

/** The tab's sections for scheme `s`; `data` is its /test-health read, null until it arrives. */
/**
 * @param {{ id: number }} s
 * @param {TestHealth | ReadFailed | null} data
 * @param {() => void} refresh
 */
export function testHealth(s, data, refresh) {
  if (data?.error) return [h('p', { class: 'muted' }, "Couldn't read test health. ", h('button', { type: 'button', class: 'secondary small', onclick: () => refresh() }, 'Try again'))];
  if (!data) return [h('p', { class: 'muted' }, 'Reading test health…')];
  return [fastBlock(s, data.fast, data.now), landRedsBlock(s, data.landReds), flakeBlock(s, data.flakes, refresh), sweepBlock(s, data.sweeps ?? [])];
}

/**
 * @param {number} id
 * @returns {Promise<TestHealth>}
 */
export const readHealth = (id) => api(`api/projects/${id}/test-health`);
