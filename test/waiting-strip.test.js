// The "N cards wait on you" strip (public/waiting.js) counts only cards for the viewer: a card addressed to
// someone else still shows in the chat but isn't waiting on you (Cara, 2026-11-16).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardsForMe, stripCards } from '../public/waiting-cards.js';

test('the strip leaves out cards addressed to someone else, and keeps those for everyone or for you', () => {
  const cards = [{ href: '#a' }, { href: '#b', to: 'Josh' }, { href: '#c', to: 'Cara' }];
  assert.deepEqual(cardsForMe(cards, 'Cara').map((c) => c.href), ['#a', '#c']);
  assert.deepEqual(cardsForMe(cards, 'josh').map((c) => c.href), ['#a', '#b'], 'names compare without case');
  assert.deepEqual(cardsForMe(undefined, 'Cara'), []);
});

test('a minion chat shows the strip for its open choices cards only; the Taskmaster for every card waiting on you (#821)', () => {
  const open_cards = [{ href: '#q', kind: 'question' }, { href: '#d', kind: 'question', doc: 'takes.html' }, { href: '#j', kind: 'question', doc: 'j.html', to: 'Josh' }];
  assert.deepEqual(stripCards({ kind: 'ticket', open_cards }, 'Cara').map((c) => c.href), ['#d'], 'a question card is answered in the chat; a choices card on its page');
  assert.deepEqual(stripCards({ kind: 'coordinator', open_cards }, 'Cara').map((c) => c.href), ['#q', '#d']);
  assert.deepEqual(stripCards({ kind: 'ticket', open_cards: [{ href: '#q', kind: 'question' }] }, 'Cara'), [], 'nothing once the choices card is settled');
});

test('a minion chat\'s strip also holds an open secret card, which is saved in its own field (Cara, 2026-11-17)', () => {
  const open_cards = [{ href: '#q', kind: 'question', what: 'question' }, { href: '#s', kind: 'question', what: 'secret' }];
  assert.deepEqual(stripCards({ kind: 'ticket', open_cards }, 'Cara').map((c) => c.href), ['#s']);
});
