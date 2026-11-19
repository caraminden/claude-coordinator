// Host load on the CI page (#1060): citadel-heavy's slots and line, the CPU-pressure gate and a week of waits per
// scheme (src/host-load.ts). Read-only: the slot count is a file, and more slots made every suite slower (Nov 10).
// Three rows that open, in Citadel's look (#1068): each says its state on its closed line; the detail is inside.
import { h } from './base.js';
import { emptyCard, hueRow, meter, pips, schemeHue, schemeTag, showFirst, statTiles, toneChip } from './look.js';
import { settingsRow } from './settings.js';

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
    worst ? showFirst({ key: 'host-week', items: weekRows(l.week), n: 5, noun: 'schemes', wrap: (rows) => h('table', { class: 'look-table host-week' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Scheme'), h('th', { class: 'num' }, 'Jobs'), h('th', { class: 'num host-median' }, 'Median'), h('th', {}, 'Longest wait'))),
      h('tbody', {}, ...rows.flat())) })
      : emptyCard('No heavy jobs this week', 'Builds and test runs that take a slot show here with how long they waited.', { mark: '·', hue: 'muted' }));

  return h('section', { class: 'ci-block ci-host' }, h('h3', { class: 'settings-section', 'data-hue': 'running' }, 'Host load'),
    h('div', { class: 'settings-rows' }, slots, line, week));
}

/** A scheme's row in the waits table, with its parts (its minions, each app's builds) under it once opened. */
function weekRows(week) {
  const max = Math.max(...week.map((w) => w.longestS), 1);
  return week.map((w) => {
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
