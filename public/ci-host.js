// Host load on the CI page (#1060): citadel-heavy's slots and line, the CPU-pressure gate and a week of waits per
// scheme (src/host-load.ts). Read-only: the slot count is a file, and more slots made every suite slower (Nov 10).
import { h } from './base.js';

const span = (s) => (s < 60 ? `${Math.round(s)} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);
const held = (j, now) => span((now - j.since) / 1000);

export function hostLoadBlock(l) {
  if (!l) return '';
  const free = Math.max(0, l.slots - l.holders.length);
  const gate = l.pressure == null ? 'No CPU pressure reading on this host, so jobs go by slots alone.'
    : `CPU pressure ${l.pressure}% over the last minute. A free slot waits at ${l.maxPressure}% or more, for at most ${span(l.loadWaitS)}, then the job starts anyway.`;
  const slotRows = Array.from({ length: l.slots }, (_, i) => {
    const j = l.holders.find((x) => x.slot === i + 1);
    return h('div', { class: 'ci-host-slot' }, h('b', {}, `Slot ${i + 1}`),
      j ? [h('span', {}, `${j.who}: ${j.what}`), h('span', { class: 'muted' }, `${j.scheme} · running ${held(j, l.now)}`)] : h('span', { class: 'muted' }, 'free'));
  });
  return h('section', { class: 'ci-block ci-host' }, h('h4', {}, 'Host load: heavy slots'),
    h('p', { class: 'muted' }, `${l.holders.length} of ${l.slots} heavy slots in use${free ? `, ${free} free` : ''}. ${gate} Raising the slot count slows every suite, so it stays a file.`),
    ...slotRows,
    l.waiters.length ? h('div', {}, h('h5', {}, `Waiting (${l.waiters.length})`), ...l.waiters.map((w, i) =>
      h('div', { class: 'ci-host-slot' }, h('b', {}, `${i + 1}.`), h('span', {}, `${w.who}: ${w.what}`),
        h('span', { class: 'muted' }, `${w.reason === 'load' ? 'free slot, box busy' : w.reason === 'first' ? 'a deploy goes first' : 'all slots busy'} · waiting ${held(w, l.now)}`)))) : h('p', { class: 'muted' }, 'Nobody is waiting.'),
    h('h5', {}, 'Waits this week'),
    l.week.length ? h('table', { class: 'ci-host-table' }, h('thead', {}, h('tr', {}, ...['Scheme', 'Jobs', 'Median wait', 'Longest wait'].map((t) => h('th', {}, t)))),
      h('tbody', {}, ...l.week.map((w) => h('tr', {}, h('td', {}, w.scheme), h('td', {}, String(w.jobs)), h('td', {}, span(w.medianS)), h('td', {}, span(w.longestS))))))
      : h('p', { class: 'muted' }, 'No heavy jobs ran this week.'));
}
