// A cabal as one card in the minions list (#2092; Josh, 2026-11-25, picked "B · One crew card"): the Overseer's tag and
// title, a meter with a segment a member, the counts, and the open asks in red. A click shows its members under it with
// no request: the cards come with the scheme (src/cabal-cards.ts) and the rows are the page's own.
import { h, me, phase, threadHref } from './base.js';
import { money } from './cabal.js';
import { cardFor, cardsYours } from './threadstate.js';
/** @import { BuildHeader, CabalCard, ListedTicket as Row } from './types/list.js' */

/** The cards open on this page, by lead id: they stay open across redraws. A card starts shut (Cara, 2026-11-26). */
export const openCabals = /** @type {Set<number>} */ (new Set());
/** The card just opened by a click: only its next draw fades its members in, or every redraw would replay it (#2181). */
let opening = /** @type {number | null} */ (null);

/**
 * The Overseer with its members' cards waiting on people as its own, for the header's chip: a click opens the oldest of them all.
 * @param {Row} lead @param {Row[]} mine
 * @returns {Row}
 */
export function overseerRow(lead, mine) {
  // A card open to anyone stays yours to answer, not the lead's assignee's.
  const theirs = mine.filter((t) => t.id !== lead.id).flatMap((t) => (t.open_cards ?? []).map((c) => ({ ...c, to: cardFor(c, t) || me || undefined })));
  // Event ids grow with time, so ordering by the one in each link keeps the chip's "open the oldest" true across rows.
  const age = (/** @type {{ href: string }} */ c) => Number(/[?&]e=(\d+)/.exec(c.href)?.[1] ?? 0);
  return theirs.length ? { ...lead, open_cards: [...(lead.open_cards ?? []), ...theirs].sort((a, b) => age(a) - age(b)) } : lead;
}

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
 * @param {(cards: NonNullable<Row['open_cards']>, theirs: boolean) => Node | string} o.badge the list's chip for waiting cards, grey-violet when none is yours: a click opens the oldest
 * @param {() => void} o.redraw
 */
export function cabalCard(c, { rows, mine, tickets, build, preview, row, badge, redraw }) {
  const open = openCabals.has(c.lead);
  const waiting = mine.filter((t) => t.open_cards?.length).length;
  const yours = mine.filter((t) => cardsYours(t).length).length;
  const fresh = open && opening === c.lead;
  if (fresh) opening = null;
  const lead = rows.find((t) => t.id === c.lead);
  const leadTicket = tickets.get(c.lead) ?? lead;
  // The Overseer is the header, not a second row (Cara, 2026-11-27: "probably the header is good enough?"): its state and every waiting card show there.
  const cards = leadTicket ? (overseerRow(leadTicket, mine).open_cards ?? []) : [];
  // Shut: every started member, in its own row; open adds the sealed and not-started ones (Cara, 2026-11-27: "the collapsed version still shows all active minions, and the expanded one shows the not started").
  const sealed = (/** @type {Row} */ t) => c.members.some((m) => m.id === t.id && m.state === 'sealed');
  const members = rows.filter((t) => t.id !== c.lead && (open || !sealed(t)));
  const unstarted = c.members.filter((m) => m.id == null || m.scheme); // another scheme's members aren't in this list: named here
  // Open also lists the members dismissed since, under the not-started ones (Cara, 2026-11-27: "below the not started minions,
  // you also see the dismissed minions from that build"): finished or closed, and no longer open. Read from every minion
  // the page holds, not the rows a filter left: a merged member the filter hides is still open, not dismissed.
  const gone = c.members.filter((m) => m.id != null && !m.scheme && m.id !== c.lead && ['merged', 'shipped', 'closed'].includes(m.state) && (tickets.get(m.id)?.status ?? 'closed') === 'closed');
  const project = leadTicket?.project_id;
  const started = c.members.some((m) => m.state !== 'roster');
  const toggle = () => {
    if (!openCabals.delete(c.lead)) openCabals.add((opening = c.lead));
    redraw();
  };
  const counts = !c.members.length ? [h('span', {}, 'No roster yet')] : !started ? [h('span', {}, `Roster of ${c.members.length}, nobody started yet`)] : [h('span', {}, `${c.finished} of ${c.members.length} ${c.done}`), c.next ? h('span', {}, `${c.next} next up`) : ''];
  return h(
    'div',
    { class: 'cabal-card', 'data-lead': c.lead, 'data-open': open ? '' : null },
    h(
      'div',
      { class: 'cabal-sum' },
      h(
        'div',
        { class: 'cabal-top' },
        // The name opens the Overseer's chat as its row does; only the arrow opens and shuts the box (Cara, 2026-11-27: "Name opens its chat").
        h(leadTicket ? 'a' : 'span', { class: 'cabal-name', ...(leadTicket ? { href: threadHref(leadTicket), title: "Open the Overseer's chat" } : {}) }, h('span', { class: 'cabal-tag' }, 'Overseer'), h('span', { class: 'cabal-title' }, h('b', {}, c.title), ' ', h('span', { class: 'num' }, `#${c.number}`))),
        h('button', { type: 'button', class: 'cabal-toggle', 'aria-expanded': String(open), 'aria-label': open ? 'Shut the box of members' : 'Open the box of members', title: open ? 'Shut the box of members' : 'Open the box of members', onclick: toggle }, h('span', { class: 'cabal-arrow', 'aria-hidden': 'true' })),
      ),
      leadTicket
        ? h(
            'div',
            { class: 'cabal-lead' },
            // The working dot rejoins the shared pulse on a redraw, as a building segment does below (#2280).
            h('span', { class: 'cabal-state', 'data-s': leadTicket.status === 'running' ? 'running' : 'idle' }, leadTicket.status === 'running' ? phase(h('i', { 'aria-hidden': 'true' }), 1600) : h('i', { 'aria-hidden': 'true' }), leadTicket.status === 'running' ? 'Working' : 'Idle'),
            cards.length ? badge(cards, !cardsYours({ ...leadTicket, open_cards: cards }).length) : '',
          )
        : '',
      c.members.length
        ? h(
            'span',
            { class: 'cabal-meter' },
            ...c.members.map((m) => {
              const now = liveMember(m, m.id == null ? undefined : tickets.get(m.id));
              const name = [m.label, m.number != null ? `#${m.number}` : '', m.title].filter(Boolean).join(' ');
              const seg = h('i', { 'data-s': now.state, title: `${name}: ${now.word}` });
              // The list redraws on every bit of news: a building segment rejoins the shared pulse, or each redraw starts it over (#2197).
              return now.state === 'running' ? phase(seg, 1600) : seg;
            }),
          )
        : '',
      h(
        'span',
        { class: 'cabal-foot' },
        ...counts,
        // Only what waits on people, in words: members' questions to the Overseer stay on its board (Cara, 2026-11-26: "Im not
        // sure I care if the minions are asking the overseer questions?").
        yours ? h('b', { class: 'cabal-asks', title: 'Minions of this Plot with a card waiting on you' }, `${yours} waiting on you`) : '',
        waiting > yours ? h('span', { title: 'Minions of this Plot with a card waiting on someone else' }, `${waiting - yours} waiting on others`) : '',
        h('span', {}, money(c.spend)),
      ),
    ),
    build ? h('p', { class: 'cabal-build' }, `${build.behind} behind main`, preview ? [' · ', h('a', { href: `../preview/build/${build.build}/`, target: '_blank', rel: 'noopener', title: `build/${build.build}'s tip on a copy of the data` }, 'Preview')] : '') : '',
    members.length || (open && (unstarted.length || gone.length))
      ? h(
          'div',
          { class: 'cabal-members' },
          members.map(row),
          (open ? unstarted : []).map((m) => h('p', { class: `cabal-planned${fresh ? ' opening' : ''}`, title: 'Planned: not started yet' }, [m.label, m.title].filter(Boolean).join(' '), h('span', { class: 'muted' }, m.scheme ? ` ${m.scheme}${m.number ? ` #${m.number}` : ''} · ${m.word}` : ' not started'))),
          (open ? gone : []).map((m) => {
            const name = h('span', {}, [m.number != null ? `#${m.number}` : '', m.label, m.title].filter(Boolean).join(' '));
            const word = h('span', { class: 'muted' }, m.state === 'closed' ? 'dismissed' : m.word);
            const cls = `cabal-gone${fresh ? ' opening' : ''}`;
            return project != null ? h('a', { class: cls, href: threadHref({ id: /** @type {number} */ (m.id), project_id: project, number: m.number, kind: 'ticket' }), title: 'Dismissed: open its chat' }, name, word) : h('p', { class: cls }, name, word);
          }),
        )
      : '',
  );
}
