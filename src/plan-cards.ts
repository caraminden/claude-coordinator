// Plan cards (propose_plan and the cards built on it): posted here, decided by /api/tickets/:ticket/verdict
// (src/routes/tickets.ts). Its own module so any route can post one without importing the tickets routes.
import { randomBytes } from 'node:crypto';
import type { App } from './http.ts';

/**
 * Post a plan card that waits, across restarts, for a person. A new one replaces any earlier one of its kind still open
 * (waiting, or sent back for changes): a plan replaces plans, a machine's notes card (#617) that machine's earlier ones,
 * a release key card (#837) that app's, and a held instructions edit (#1162) the earlier held edits.
 */
export function postPlan(app: App, id: number, card: Record<string, unknown> & { summary: string; plan: string; machine?: { id: number }; releaseKey?: { app: string }; memory?: object; instructions?: object }) {
  const { store, runner } = app;
  const kind = (c: typeof card) => (c.machine ? `machine:${c.machine.id}` : c.releaseKey ? `key:${c.releaseKey.app}` : c.memory ? 'memory' : c.instructions ? 'instructions' : 'plan');
  for (const e of store.eventsOfKinds(id, ['plan'])) {
    const old = JSON.parse(e.data);
    if (old?.status !== 'pending' && old?.status !== 'revising') continue;
    if (kind(old) !== kind(card)) continue;
    store.setEventData(e.id, { ...old, status: 'superseded' });
    runner.emit(id, 'plan_result', { id: old.id, status: 'superseded' });
  }
  const event = runner.emit(id, 'plan', { id: randomBytes(6).toString('hex'), ...card, status: 'pending' });
  runner.broadcastTicket(id);
  app.notify(id, { kind: 'plan', summary: card.summary, eventId: event.id, ...(typeof card.to === 'string' ? { to: card.to } : {}) });
  return event;
}
