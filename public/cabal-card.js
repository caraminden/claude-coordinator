// A cabal as one card in the minions list (#2092; Josh, 2026-11-25, picked "B · One crew card"): the Overseer's tag and
// title, a meter with a segment a member, the counts, and the open asks in red. A click shows its members under it with
// no request: the cards come with the scheme (src/cabal-cards.ts) and the rows are the page's own.
import { h } from './base.js';
import { money } from './cabal.js';
/** @import { BuildHeader, CabalCard, ListedTicket as Row } from './types/list.js' */

/** The cards open on this page, by lead id: they stay open across redraws. */
export const openCabals = /** @type {Set<number>} */ (new Set());

/** A member's state now: its row's own news moves it between building and open before the cards are read again. */
/** @param {CabalCard['members'][number]} m @param {Row | undefined} t */
function liveMember(m, t) {
  if (t && m.state === 'idle' && t.status === 'running') return { state: 'running', word: 'building' };
  if (t && m.state === 'running' && t.status !== 'running') return { state: 'idle', word: 'open' };
  return m;
}

/**
 * @param {CabalCard} c
 * @param {object} o
 * @param {Row[]} o.rows its open minions listed under it, the Overseer's first
 * @param {Row[]} o.mine every open minion of the cabal, listed here or not: their waiting cards count
 * @param {Map<number, Row>} o.tickets
 * @param {BuildHeader | undefined} o.build its build branch's standing
 * @param {boolean} o.preview whether the build branch's preview is linked
 * @param {(t: Row) => HTMLElement} o.row
 * @param {() => void} o.redraw
 */
export function cabalCard(c, { rows, mine, tickets, build, preview, row, redraw }) {
  const open = openCabals.has(c.lead);
  const waiting = mine.filter((t) => t.open_cards?.length).length;
  const asks = c.asks + waiting;
  const unstarted = c.members.filter((m) => m.id == null);
  const started = c.members.some((m) => m.state !== 'roster');
  const toggle = () => {
    if (!openCabals.delete(c.lead)) openCabals.add(c.lead);
    redraw();
  };
  const counts = !c.members.length ? [h('span', {}, 'No roster yet')] : !started ? [h('span', {}, `Roster of ${c.members.length}, nobody started yet`)] : [h('span', {}, `${c.finished} of ${c.members.length} ${c.done}`), c.next ? h('span', {}, `${c.next} next up`) : ''];
  return h(
    'div',
    { class: 'cabal-card', 'data-lead': c.lead, 'data-open': open ? '' : null },
    h(
      'button',
      { type: 'button', class: 'cabal-toggle', 'aria-expanded': String(open), onclick: toggle },
      h('span', { class: 'cabal-tag' }, c.overseer),
      h('span', { class: 'cabal-title' }, h('b', {}, c.title), ' ', h('span', { class: 'num' }, `#${c.number}`)),
      c.members.length
        ? h(
            'span',
            { class: 'cabal-meter' },
            ...c.members.map((m) => {
              const now = liveMember(m, m.id == null ? undefined : tickets.get(m.id));
              const name = [m.label, m.number != null ? `#${m.number}` : '', m.title].filter(Boolean).join(' ');
              return h('i', { 'data-s': now.state, title: `${name}: ${now.word}` });
            }),
          )
        : '',
      h('span', { class: 'cabal-foot' }, ...counts, asks ? h('b', { class: 'cabal-asks', title: `${c.asks} to the Overseer on the board, ${waiting} with a card waiting on people` }, `${asks} ask${asks === 1 ? '' : 's'}`) : '', h('span', {}, money(c.spend))),
    ),
    build ? h('p', { class: 'cabal-build' }, `${build.behind} behind main`, preview ? [' · ', h('a', { href: `../preview/build/${build.build}/`, target: '_blank', rel: 'noopener', title: `build/${build.build}'s tip on a copy of the data` }, 'Preview')] : '') : '',
    open
      ? h(
          'div',
          { class: 'cabal-members' },
          rows.map(row),
          unstarted.map((m) => h('p', { class: 'cabal-planned' }, [m.label, m.title].filter(Boolean).join(' '), h('span', { class: 'muted' }, ' not started'))),
        )
      : '',
  );
}
