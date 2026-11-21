// Host load on the CI page (#1060): citadel-heavy's slots and line, the CPU-pressure gate and a week of waits per
// scheme (src/host-load.ts). Read-only: the slot count is a file, and more slots made every suite slower (Nov 10).
// Three rows that open, in Citadel's look (#1068): each says its state on its closed line; the detail is inside.
import { h } from './base.js';
import { emptyCard, hueRow, meter, pips, schemeHue, schemeTag, showFirst, statTiles, toneChip } from './look.js';
import { settingsRow } from './settings.js';
import { threadNumberHref } from './threadrefs.js';

const span = (s) => (s < 60 ? `${Math.round(s)} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);
const held = (j, now) => span((now - j.since) / 1000);
const WHY = { load: 'free slot, box busy', first: 'a deploy goes first', line: 'in line behind another job' };
const KIND = { deploy: 'app deploy', apk: 'APK build', app: 'app step', turn: 'minions' };
const opened = new Set(); // schemes whose parts a click opened in the waits table

export function hostLoadBlock(l) {
  if (!l) return '';
  const busy = l.holders.length, waiting = l.waiters.length;
  const hot = l.pressure != null && l.pressure >= l.maxPressure;
  const [tone, word] = waiting ? ['warn', `${waiting} waiting`] : hot ? ['warn', 'Box busy'] : busy ? ['info', 'Busy'] : ['ok', 'Quiet'];
  const gate = l.pressure == null ? 'No CPU pressure reading on this host, so jobs go by slots alone.'
    : `A free slot still waits while CPU pressure is ${l.maxPressure}% or more, for at most ${span(l.loadWaitS)}, then the job starts anyway.`;

  const [slots] = settingsRow({ key: 'host-slots', icon: 'box', hue: 'running', title: 'Heavy slots',
    summary: [toneChip(tone, word), pips(busy, l.slots), `${busy} of ${l.slots} busy${l.pressure == null ? '' : ` · CPU ${l.pressure}%`}`] },
    statTiles([`${busy} of ${l.slots}`, 'slots busy', 'running'], l.pressure != null && [`${l.pressure}%`, `CPU pressure (gate at ${l.maxPressure}%)`, hot ? 'waiting' : 'done'],
      [String(waiting), 'in line', waiting ? 'waiting' : 'done']),
    h('div', { class: 'hue-rows' }, ...Array.from({ length: l.slots }, (_, i) => {
      const j = l.holders.find((x) => x.slot === i + 1);
      return j ? hueRow({ cat: schemeHue(j.scheme), lead: i + 1, meta: held(j, l.now) }, schemeTag(j.scheme, j.who), j.what)
        : hueRow({ free: true, lead: i + 1 }, 'free');
    })),
    h('p', { class: 'look-prose' }, `${gate} The slot count is a file on perigee: raising it slows every suite, so it stays.`));

  const [line] = settingsRow({ key: 'host-line', icon: 'users', hue: waiting ? 'waiting' : 'done', title: 'Waiting for a slot',
    summary: waiting ? [toneChip('warn', `${waiting} waiting`), `longest ${held(l.waiters[0], l.now)}`] : [toneChip('ok', 'Nobody'), 'a heavy job gets a slot at once'] },
    waiting ? h('div', { class: 'hue-rows' }, ...l.waiters.map((w, i) => hueRow({ hue: 'waiting', lead: i + 1, meta: held(w, l.now) },
      schemeTag(w.scheme, w.who), `${w.what} · `, h('span', { class: 'muted' }, WHY[w.reason] ?? 'all slots busy'))))
      : emptyCard('Nobody in line', `Jobs wait here when all ${l.slots} slots are busy or the box is.`));

  const total = l.week.reduce((a, w) => a + w.jobs, 0);
  const worst = l.week[0];
  const [week] = settingsRow({ key: 'host-week', icon: 'chart', hue: 'accent', title: 'Waits this week',
    summary: worst ? [`${total.toLocaleString()} jobs · longest`, ' ', schemeTag(worst.scheme), span(worst.longestS)] : 'No heavy jobs ran this week' },
    worst ? showFirst({ key: 'host-week', items: l.week, n: 5, noun: 'schemes', wrap: (ws) => h('table', { class: 'look-table host-week' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Scheme'), h('th', { class: 'num' }, 'Jobs'), h('th', { class: 'num host-median' }, 'Median'), h('th', {}, 'Longest wait'))),
      h('tbody', {}, ...weekRows(ws, l.week))) })
      : emptyCard('No heavy jobs this week', 'Builds and test runs that take a slot show here with how long they waited.', { mark: '·', hue: 'muted' }));

  return h('section', { class: 'ci-block ci-host' }, h('h3', { class: 'settings-section', 'data-hue': 'running' }, 'Host load'),
    h('div', { class: 'settings-rows' }, slots, line, longRow(l), week, minionsRow(l)));
}

const minionLink = (m) => h('a', { href: threadNumberHref(m.schemeId ?? m.scheme, m.number) }, `#${m.number}`);

/** What runs from which minion's folders, and what closed minions left that was stopped this week (#1365, src/reaper.ts). */
function minionsRow(l) {
  const minions = l.minions ?? [], reaped = l.reaped ?? [];
  const procs = minions.reduce((a, m) => a + m.procs.length, 0);
  const leftovers = minions.filter((m) => m.status === 'closed').length;
  const [row] = settingsRow({ key: 'host-minions', icon: 'box', hue: leftovers ? 'waiting' : 'accent', title: 'Running from minions',
    summary: [leftovers ? toneChip('warn', `${leftovers} closed`) : toneChip('ok', procs ? `${procs} running` : 'Nothing'),
      `${minions.length} minions · ${reaped.length} stopped this week`] },
    minions.length ? showFirst({ key: 'host-minions', items: minions, n: 5, noun: 'minions', wrap: (ms) => h('div', { class: 'hue-rows' }, ...ms.flatMap((m) => [
      hueRow({ cat: schemeHue(m.scheme), meta: m.status === 'closed' ? 'closed: stops within the hour' : `${m.procs.length} running` }, schemeTag(m.scheme), ' ', minionLink(m), ` ${m.title}`),
      ...m.procs.map((p) => hueRow({ hue: 'muted', lead: p.pid, meta: `${span(p.cpuS)} CPU · up ${span(p.ageS)}` }, h('code', {}, p.command))),
    ])) })
      : emptyCard('Nothing runs from a minion\'s folders', 'Dev servers and other processes a minion starts show here, with their CPU time.', { mark: '·', hue: 'muted' }),
    h('h4', { class: 'machine-group' }, 'Stopped after their minion closed'),
    reaped.length ? showFirst({ key: 'host-reaped', items: reaped, n: 5, noun: 'processes', wrap: (rs) => h('div', { class: 'hue-rows' }, ...rs.map((r) =>
      hueRow({ cat: schemeHue(r.schemeName), meta: `${span(r.cpuS)} CPU · ${new Date(r.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` },
        schemeTag(r.schemeName), ' ', minionLink({ ...r, schemeId: r.scheme }), ' ', h('code', {}, r.command)))) })
      : emptyCard('None this week', 'A closed minion\'s leftover processes are stopped at its close or within the hour, and each shows here.'),
    h('p', { class: 'look-prose' }, 'Closing a minion stops what runs from its worktree and temp folder (TERM, then KILL), by pid, never by name. An open minion\'s processes, a person\'s own shell, ships and deploys are never touched.'));
  return row;
}

// Long jobs (#1363): `citadel-heavy --long` queues them for the scheme's CI at night, from 2am (src/long-jobs.ts).
const LONG = { queued: 'waits for 2am', dispatched: 'sent to CI, waiting for a runner', running: 'running on CI', done: 'passed' };
const LONG_HUE = { queued: 'waiting', dispatched: 'running', running: 'running', done: 'done', failed: 'danger', lost: 'danger' };
function longRow(l) {
  const jobs = l.long ?? [];
  const running = jobs.filter((j) => j.state === 'running' || j.state === 'dispatched').length, queued = jobs.filter((j) => j.state === 'queued').length;
  const summary = running || queued ? [running && toneChip('info', `${running} running`), queued && toneChip('warn', `${queued} queued`)].filter(Boolean)
    : [toneChip('ok', 'None queued'), jobs.length ? `${jobs.length} ended today` : 'run at night, from 2am'];
  const [row] = settingsRow({ key: 'host-long', icon: 'rows', hue: running ? 'running' : queued ? 'waiting' : 'done', title: 'Long jobs', summary },
    jobs.length ? h('div', { class: 'hue-rows' }, ...jobs.map((j) => hueRow({ hue: LONG_HUE[j.state], meta: held(j, l.now) },
      schemeTag(j.scheme, j.who), `${j.what} · `,
      h('span', { class: 'muted' }, LONG[j.state] ?? (j.state === 'failed' ? `failed, exit ${j.code}` : `lost: ${j.why ?? 'no result'}`)),
      j.url ? [' · ', h('a', { href: j.url, target: '_blank', rel: 'noopener' }, 'CI run')] : '')))
      : emptyCard('No long jobs', 'A minion queues a test run of an hour or more with citadel-heavy --long; it starts at 2am, in the CI machine\'s job hours, and the minion is woken with the result.'));
  return row;
}

/** The shown schemes' rows in the waits table, each with its parts (its minions, each app's builds) under it once opened, built
 * from `opened` on every draw so "Show all" keeps what a click opened. Bars are against the longest wait of the whole `week`. */
function weekRows(shown, week) {
  const max = Math.max(...week.map((w) => w.longestS), 1);
  return shown.flatMap((w) => {
    const cat = schemeHue(w.scheme);
    const name = w.parts
      ? h('button', { type: 'button', class: 'parts-toggle', 'aria-expanded': String(opened.has(w.scheme)), onclick: (e) => {
        if (opened.has(w.scheme)) opened.delete(w.scheme); else opened.add(w.scheme);
        const tr = e.currentTarget.closest('tr');
        e.currentTarget.setAttribute('aria-expanded', String(opened.has(w.scheme)));
        while (tr.nextElementSibling?.classList.contains('sub')) tr.nextElementSibling.remove();
        if (opened.has(w.scheme)) tr.after(...partRows(w, cat));
      } }, schemeTag(w.scheme))
      : h('span', { class: 'no-parts' }, schemeTag(w.scheme));
    const row = h('tr', { 'data-cat': cat }, h('td', {}, name), h('td', { class: 'num' }, String(w.jobs)), h('td', { class: 'num host-median' }, span(w.medianS)),
      h('td', {}, meter(w.longestS / max, span(w.longestS))));
    return [row, ...(w.parts && opened.has(w.scheme) ? partRows(w, cat) : [])];
  });
}

const partRows = (w, cat) => w.parts.map((p) => h('tr', { class: 'sub', 'data-cat': cat },
  h('td', { title: p.label }, KIND[p.kind]), h('td', { class: 'num' }, String(p.jobs)),
  h('td', { class: 'num host-median' }, span(p.medianS)), h('td', {}, span(p.longestS))));
