// The Held list (#1059): what the scheme's messaging is holding, at the foot of the minions list. A loop-guard hold waits
// for a person's Continue; cold mail waits for its recipient's next turn, or Deliver now. The server lists it
// (Runner.heldList); this reads it again each time the list redraws, at most every 10 seconds, so it is never stale for long.
import { api, h, view } from './base.js';
import { toast } from './ui/status.js';

const box = h('details', { class: 'thread-group g-held', hidden: true });
let items = [], asked = 0, project = null;

const act = (it) => async () => {
  try {
    await (it.kind === 'loop' ? api(`api/tickets/${it.ticket}/continue`, { method: 'POST' }) : api(`api/tickets/${it.ticket}/deliver-mail`, { method: 'POST' }));
    items = items.filter((x) => (it.kind === 'loop' ? x.kind !== 'loop' || x.ticket !== it.ticket : x.ticket !== it.ticket || x.kind === 'loop'));
    paint();
  } catch (err) { toast(err.message); }
};

/** One held message: what, from whom to whom, why, when it goes, and its button. */
export const heldRow = (it, onAct) => h('div', { class: 'held-row' },
  h('div', { class: 'held-what' }, h('b', {}, `${it.from} → ${it.to}`), ' ', h('span', { class: 'held-text' }, `“${it.text}”`)),
  h('div', { class: 'held-why muted small' }, `Held by ${it.why}; delivers ${it.delivers}.`),
  h('button', { type: 'button', class: 'secondary', onclick: onAct }, it.kind === 'loop' ? 'Continue' : 'Deliver now'));

function paint() {
  box.hidden = !items.length;
  const open = box.open;
  box.replaceChildren(h('summary', {}, `Held (${items.length})`), ...items.map((it) => heldRow(it, act(it))));
  box.open = open;
}

/** The list's Held box; asks the server again if the last look is over 10 s old, or is another scheme's. */
export function heldBox() {
  const id = view.projectId;
  if (project !== id) { project = id; items = []; asked = 0; paint(); }
  if (Date.now() - asked > 10_000) {
    asked = Date.now();
    api(`api/projects/${id}/held`).then((d) => { if (project === id) { items = d.items ?? []; paint(); } }).catch(() => {});
  }
  return box;
}
