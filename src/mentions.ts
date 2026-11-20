// @mentions (#1149): a person types @Name in a chat box and that member of the scheme is pinged, with the message in
// their Needs you until they open its chat (Josh, 2026-11-20: "Needs you, and counted", "Opening that chat",
// "Members only", "People only for now"). A mention never changes whose turn runs: the message is the sender's.
import type { Store } from './db.ts';

/** One mention waiting on its person: the chat, the message (event) and who wrote it. */
export interface Mention {
  ticketId: number;
  projectId: number;
  eventId: number;
  at: number;
  by: string;
  text: string;
}

/** Each person keeps at most this many unseen mentions; the oldest go first. */
export const MAX_MENTIONS = 100;
/** How much of the message a mention keeps, for its notification and Needs-you popover. */
const MAX_TEXT = 300;

const key = (person: string) => `mentions:${person.toLowerCase()}`;

/**
 * The members `text` mentions, by name: "@" then a member's name (any case), at the start or after a space or opening
 * mark, and not followed by more of a word. Names only, not logins: the picker writes names, and the chip draws them. The longest name wins, so "@Cara Lee" beats "@Cara". The sender
 * isn't mentioned by their own message. Names come back once each, in the members' order.
 */
export function mentionedIn(text: string, members: { name: string; login: string }[], sender: string): string[] {
  const out = new Set<string>();
  const lower = text.toLowerCase();
  // Longest first, so a name that starts another name's loses to it.
  const handles = members.map((m) => ({ h: m.name.toLowerCase(), name: m.name })).sort((a, b) => b.h.length - a.h.length);
  for (let i = lower.indexOf('@'); i >= 0; i = lower.indexOf('@', i + 1)) {
    if (i > 0 && !/[\s([{"'“‘]/.test(lower[i - 1])) continue; // an email address, not a mention
    const hit = handles.find(({ h }) => lower.startsWith(h, i + 1) && !/[\p{L}\p{N}_-]/u.test(lower[i + 1 + h.length] ?? ''));
    if (hit) out.add(hit.name);
  }
  out.delete(members.find((m) => m.name.toLowerCase() === sender.toLowerCase() || m.login.toLowerCase() === sender.toLowerCase())?.name ?? '');
  return members.map((m) => m.name).filter((n) => out.has(n));
}

/** Keep a mention for `person` until they open its chat. */
export function addMention(store: Store, person: string, m: Mention) {
  const list = (store.getSetting<Mention[]>(key(person)) ?? []).filter((x) => x.eventId !== m.eventId);
  list.push({ ...m, text: m.text.slice(0, MAX_TEXT) });
  store.setSetting(key(person), list.slice(-MAX_MENTIONS));
}

/**
 * `person`'s mentions in a scheme they haven't seen yet: they last opened the chat before the mention. The caller drops
 * dismissed minions'. `seen` is their ticket id -> seen time, as Store.seenTimes gives it.
 */
export function openMentions(store: Store, projectId: number, person: string, seen: Record<number, number>): Mention[] {
  const list = store.getSetting<Mention[]>(key(person)) ?? [];
  return list.filter((m) => m.projectId === projectId && (seen[m.ticketId] ?? 0) < m.at);
}

/** `person` opened a chat: its mentions of them are done with (the inbox also checks the seen time, so this only tidies). */
export function clearMentions(store: Store, person: string, ticketId: number) {
  const list = store.getSetting<Mention[]>(key(person));
  if (!list?.some((m) => m.ticketId === ticketId)) return;
  store.setSetting(key(person), list.filter((m) => m.ticketId !== ticketId));
}
