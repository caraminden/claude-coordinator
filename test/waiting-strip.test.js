// The "N cards wait on you" strip (public/waiting.js) counts only cards for the viewer: a card addressed to
// someone else still shows in the chat but isn't waiting on you (Cara, 2026-11-16).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardsForMe } from '../public/waiting-cards.js';

test('the strip leaves out cards addressed to someone else, and keeps those for everyone or for you', () => {
  const cards = [{ href: '#a' }, { href: '#b', to: 'Josh' }, { href: '#c', to: 'Cara' }];
  assert.deepEqual(cardsForMe(cards, 'Cara').map((c) => c.href), ['#a', '#c']);
  assert.deepEqual(cardsForMe(cards, 'josh').map((c) => c.href), ['#a', '#b'], 'names compare without case');
  assert.deepEqual(cardsForMe(undefined, 'Cara'), []);
});
