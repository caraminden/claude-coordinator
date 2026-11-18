// Whose Claude plan a minion's turns run on (#219, take A): a line over the composer only when your
// message would switch it, or the payer's limit is hit. The head's chip went (Josh, 2026-11-13).
import { account, api, h, me } from './base.js';
import { usage } from './core.js';
import { optimistic } from './ui/optimistic.js';

/** What re-reading the minion's context costs a new payer, at $8 per million tokens (the handoff's rate). */
const loadCost = (t) => (t.context_tokens ? `~$${((t.context_tokens * 8) / 1e6).toFixed(2)}` : null);
/** "4:03 PM" today, "Sun 4:03 PM" on another day, with the date too six days or more out (a weekly limit). */
const time = (ms, now = Date.now()) => {
  const at = new Date(ms);
  const clock = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (at.toDateString() === new Date(now).toDateString()) return clock;
  return `${at.toLocaleDateString([], { weekday: 'short', ...(ms - now >= 6 * 86_400_000 && { month: 'short', day: 'numeric' }) })} ${clock}`;
};
const mine = (t) => !!t.payer && !!account && t.payer.id === account.payer;
/** Your own week, as your meter shows it; only your own plan's is shown to you. */
const myWeek = () => (usage?.weekly ? `wk ${Math.round(Math.min(1, Math.max(0, usage.weekly.utilization)) * 100)}%` : null);

/** Whom the minion belongs to (`assigned`, #690) when that's someone other than you; null for yours, nobody's or the Taskmaster. */
export function otherOwner(t) {
  const owner = t.kind === 'ticket' ? String(t.properties?.assigned ?? '') : '';
  return owner && owner.toLowerCase() !== me?.toLowerCase() ? owner : null;
}

/** Make the minion yours: shown at once, put back if the server refuses. Its notes say so in both chats. */
export function takeOver(t, shown = () => {}) {
  const was = t.properties?.assigned ?? null;
  return optimistic({
    sets: `assign:${t.id}`,
    apply: () => { t.properties = { ...t.properties, assigned: me }; shown(true); },
    send: () => api(`api/tickets/${t.id}/properties`, { method: 'PUT', body: { properties: { assigned: me } } }),
    undo: () => { t.properties = { ...t.properties, assigned: was }; shown(false); },
    label: 'take it over',
  });
}

/**
 * The visit line (#690): in a minion someone else owns, who owns it and a way to take it over, so a visitor who keeps
 * working there stops switching its login (sender pays stays). Appended to `line`, or a line of its own.
 */
function withVisit(t, line, own) {
  const owner = account?.turns && t.status !== 'closed' && otherOwner(t);
  if (!owner) return line;
  const part = h('span', { class: 'visit' }, own ? 'Runs on your login; ' : ' ', `${owner} owns this one. `,
    h('button', { type: 'button', class: 'small', onclick: () => takeOver(t, (done) => { part.hidden = done; if (!line) el.hidden = done; }) }, 'Take it over'));
  const el = line ?? h('div', { class: 'payer-line' });
  el.append(part);
  return el;
}

/** Over the composer: the payer's limit is hit, you haven't linked a plan, or your message would switch the payer; and the visit line. Null when none applies. */
export function payerLine(t, sendText) {
  const line = basePayerLine(t, sendText);
  return withVisit(t, line, !line);
}

function basePayerLine(t, sendText) {
  if (!account || t.status === 'closed') return coldLine(t);
  const cost = loadCost(t);
  if (t.state === 'limited' && t.payer) {
    const other = account.turns && !mine(t);
    // Sends the box (and any attachments) the usual way, with a plain "Carry on." when the box is empty.
    const go = other && h('button', { type: 'button', class: 'small', onclick: (e) => {
      const form = e.target.closest('.composer');
      const box = form?.querySelector('textarea');
      if (!form || !box) return sendText('Carry on.');
      if (!box.value.trim()) box.value = 'Carry on.';
      form.requestSubmit();
    } }, 'Continue on my plan');
    // Sender pays: any message from another plan carries on now, so the cost is said for Send too.
    // Several accounts, all limited (#819): say which one is out until when, not one plan "hit its limit".
    const accs = t.limit_accounts?.length > 1 && t.limit_resume_at ? t.limit_accounts : null;
    const owner = mine(t) ? 'Your' : `${t.payer.name}'s`;
    const lead = accs
      ? `${owner} Claude accounts are all at their limit: ${[...accs].sort((a, b) => a.until - b.until).map((a) => `${a.label}${a.here ? ' (this one)' : ''} until ${time(a.until)}${a.kind ? ` (${a.kind})` : ''}`).join(', ')}. `
      : `${owner} plan hit its usage limit; `;
    return h('div', { class: 'payer-line warn' },
      lead,
      t.limit_resume_at ? `${accs ? 'This minion' : 'this minion'} carries on at ${time(t.limit_resume_at)}${mine(t) ? ', or sooner if you reset it: a message tries now' : ''}.` : 'this minion stopped retrying and waits for a message.',
      go ? h('span', { class: 'row' }, go, h('span', { class: 'muted' }, `${cost ? `${cost} of your usage to load it. ` : ''}Any message you send carries on too.`)) : '');
  }
  if (!account.turns) {
    return h('div', { class: 'payer-line' }, 'You haven\'t linked a Claude plan yet: messages wait until you do. ',
      h('a', { href: `#/p/${t.project_id}/account` }, 'Link it'));
  }
  if (t.payer && !mine(t)) {
    const week = myWeek();
    return h('div', { class: 'payer-line' }, 'Sends on ', h('b', {}, 'your plan'), week ? ` (${week})` : '',
      `. This minion last ran on ${t.payer.name}'s: the first turn re-reads it${cost ? `, ${cost} of usage` : ''}.`);
  }
  return coldLine(t);
}

/** Idle this long, its prompt cache (1 hour) has lapsed and the next turn re-reads its whole context. */
const COLD_MS = 60 * 60_000;
const idleText = (ms) => (ms < 2 * 3_600_000 ? `${Math.round(ms / 60_000)} min` : ms < 48 * 3_600_000 ? `${Math.round(ms / 3_600_000)}h` : `${Math.round(ms / 86_400_000)} days`);

/** A quiet hint on a cold minion or Taskmaster (#413), so people can batch what they say. Only a hint: it never blocks the send. */
export function coldLine(t, now = Date.now()) {
  const idle = t.last_turn_end ? now - t.last_turn_end : 0;
  if (t.status === 'running' || !t.session_id || !t.context_tokens || idle <= COLD_MS) return null;
  return h('div', { class: 'payer-line cold', title: 'Its prompt cache lasts an hour, so the next turn re-reads its whole context. Held mail rides along with your message.' },
    `Cold, idle ${idleText(idle)}: replying re-reads its ${Math.round(t.context_tokens / 1000)}k context, about ${loadCost(t).replace('~', '')}. Say it all in one message.`);
}

/**
 * What a side question (#932) costs to load when its copy can't read the minion's prompt cache: the minion is idle past
 * the cache's hour, or last ran on someone else's plan (the copy runs on yours). Null when it is warm for you.
 */
export function sideColdCost(t, now = Date.now()) {
  if (!t.session_id || !t.context_tokens) return null;
  const idle = t.status !== 'running' && t.last_turn_end && now - t.last_turn_end > COLD_MS;
  return idle || (t.payer && !mine(t)) ? { cost: loadCost(t).replace('~', ''), k: Math.round(t.context_tokens / 1000), idle: !!idle } : null;
}
