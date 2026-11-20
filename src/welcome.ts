// A first-day welcome (#1151): five steps above a new person's Taskmaster chat (public/welcome.js), each ticked from
// what the server already knows. Only people who had never written when they first saw it get it (Josh, 2026-11-19,
// "Never-wrote people only"); once every step is done or they dismiss it, it is gone for good. Kept in one setting
// per person, so the database's shape doesn't change.
import type { Store } from './db.ts';

/** The steps, in the order the panel shows them. `password` is always done: the invite link is where it is set. */
export const STEPS = ['password', 'claude', 'phone', 'hi', 'card'] as const;
export type Step = (typeof STEPS)[number];
export type Welcome = { steps: Record<Step, boolean>; card: string | null; done: boolean };

/** shown: when they first got it. end: why it went (veteran: they had written before it ever showed). card: the practice card's answer. */
type Saved = { shown: number; end?: 'done' | 'dismissed' | 'veteran'; card?: string };

const key = (uid: number) => `welcome:${uid}`;

/** The practice card's options (public/welcome.js shows the same three): an answer must be one of them. */
export const CARD_OPTIONS = ['Ask my Taskmaster for something small', 'Read along with a minion', 'Just look around for now'];

/**
 * The person's welcome, or null once it is gone (or never was theirs). The first look decides who gets it, and the look
 * that finds every step done ends it: that answer still comes back once, with done set, so the panel can say so.
 */
export function welcomeView(store: Store, user: { id: number; name: string }, claudeLinked: boolean, now = Date.now()): Welcome | null {
  let saved = store.getSetting<Saved>(key(user.id));
  if (!saved) {
    saved = store.hasActed(user.name) ? { shown: now, end: 'veteran' } : { shown: now };
    store.setSetting(key(user.id), saved);
  }
  if (saved.end) return null;
  const steps: Record<Step, boolean> = {
    password: true,
    claude: claudeLinked,
    phone: store.listPushSubscriptions().some((s) => s.name === user.name),
    hi: store.hasActed(user.name),
    card: !!saved.card,
  };
  const done = STEPS.every((s) => steps[s]);
  if (done) store.setSetting(key(user.id), { ...saved, end: 'done' });
  return { steps, card: saved.card ?? null, done };
}

/** Dismiss it for good, or answer the practice card. Unknown people and a finished welcome change nothing. */
export function welcomeAct(store: Store, uid: number, act: { dismiss: true } | { card: string }) {
  const saved = store.getSetting<Saved>(key(uid));
  if (!saved || saved.end) return;
  store.setSetting(key(uid), 'dismiss' in act ? { ...saved, end: 'dismissed' } : { ...saved, card: act.card });
}
