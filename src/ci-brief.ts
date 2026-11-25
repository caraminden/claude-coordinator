// #1974: the run ids a minion's first message names, for CI health's "who is fixing this red" (src/ci-health.ts).
// A first message never changes, and reading them cold off disk held the server, so each is read once.
import type { Store, Ticket } from './db.ts';

const kept = new WeakMap<Store, Map<string, string>>();

/** The long numbers in the minion's first message, space-separated; '' before it has one. */
export function briefNumbers(store: Store, t: Ticket): string {
  let briefs = kept.get(store);
  if (!briefs) kept.set(store, (briefs = new Map()));
  const key = `${t.id}:${t.created_at}`; // a deleted minion's id can come back
  const known = briefs.get(key);
  if (known != null) return known;
  const data = store.firstMessage(t.id);
  if (data == null) return ''; // none yet: look again next time
  const numbers = (data.match(/\d{4,}/g) ?? []).join(' ');
  briefs.set(key, numbers);
  return numbers;
}
