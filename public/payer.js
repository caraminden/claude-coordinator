// Whose Claude plan a minion's turns run on (#219, take A): a chip in its head, and a line over the
// composer only when your message would switch it, or the payer's limit is hit.
import { account, h, usage } from './core.js';

/** What re-reading the minion's context costs a new payer, at $8 per million tokens (the handoff's rate). */
const loadCost = (t) => (t.context_tokens ? `~$${((t.context_tokens * 8) / 1e6).toFixed(2)}` : null);
const time = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const mine = (t) => !!t.payer && !!account && t.payer.id === account.payer;
/** Your own week, as your meter shows it; only your own plan's is shown to you. */
const myWeek = () => (usage?.weekly ? `wk ${Math.round(Math.min(1, Math.max(0, usage.weekly.utilization)) * 100)}%` : null);

/** The head's chip: whose plan the minion last ran on, and the reset time while that plan's limit is hit. */
export function payerChip(t) {
  if (!t.payer) return '';
  const who = mine(t) ? 'Your plan' : `${t.payer.name}'s plan`;
  const limited = t.state === 'limited';
  const text = [who, limited ? (t.limit_resume_at ? `limit, ${time(t.limit_resume_at)}` : 'limit') : mine(t) && myWeek()].filter(Boolean).join(' · ');
  return h('span', { class: `link-chip payer-chip ${limited ? 'warn' : 'ok'}`, title: `Its last turn ran on ${mine(t) ? 'your' : `${t.payer.name}'s`} Claude plan` }, text);
}

/** Over the composer: the payer's limit is hit, you haven't linked a plan, or your message would switch the payer. Null when none applies. */
export function payerLine(t, sendText) {
  if (!account || t.status === 'closed') return null;
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
    return h('div', { class: 'payer-line warn' },
      `${mine(t) ? 'Your' : `${t.payer.name}'s`} plan hit its usage limit; `,
      t.limit_resume_at ? `this minion carries on at ${time(t.limit_resume_at)}.` : 'this minion stopped retrying and waits for a message.',
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
  return null;
}
