// The Needs-you inbox's answers arriving out of order and a refused answer's undo (public/inbox.js, #1858).
// Drawing needs a page, so the draw throws here after the items are kept; what is kept is read through answerNow.
// A hit's redraw would import the page's code, so the answer here is one that must hit nothing.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newsArrived, setView } from '../public/base.js';
import { answerNow, forgetOtherSchemes, refreshInbox } from '../public/inbox.js';

globalThis.window ??= { addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) }; // sidebar.js's import (the redraw after an answer) reads it
const taskmaster = { id: 1, kind: 'coordinator', project_id: 2, status: 'idle' };
const item = (id) => ({ key: `k${id}`, ticketId: 900, eventId: id, card: { id } });
const cardOf = (id) => ({ href: `#/p/2/t/12?e=${id}` });
const ignore = async (p) => {
  try {
    await p;
  } catch {}
};

const tick = () => new Promise((r) => setImmediate(r));

function page(t, minion) {
  const realFetch = globalThis.fetch;
  const open = [];
  globalThis.fetch = () => new Promise((resolve) => open.push((items) => resolve({ ok: true, status: 200, json: async () => ({ items }) })));
  setView({ kind: 'project', projectId: 2, coordinator: taskmaster, tickets: new Map([[minion.id, minion]]) });
  t.after(() => {
    globalThis.fetch = realFetch;
    setView(null);
    forgetOtherSchemes();
  });
  return open;
}

test('an older list landing after a newer one is not drawn (WP10)', async (t) => {
  const minion = { id: 900, number: 12, project_id: 2, kind: 'ticket', status: 'idle', state: null, replies: [], open_cards: [cardOf(5)] };
  const open = page(t, minion);
  const older = refreshInbox();
  newsArrived(); // as the stream does with each message: the next fetch isn't shared with the one in flight
  const newer = refreshInbox();
  await tick();
  open[1]([]); // the newer answer: card 5 is gone
  await ignore(newer);
  open[0]([item(5)]); // the older, landing last, still lists it
  await ignore(older);
  answerNow(900, 5);
  assert.equal(minion.open_cards.length, 1, 'card 5 is not in the drawn list, so answering it holds nothing back');
});
