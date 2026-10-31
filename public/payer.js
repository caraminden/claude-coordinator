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
  const text = [who, limited ? `limit${t.limit_resume_at ? `, ${time(t.limit_resume_at)}` : ''}` : mine(t) && myWeek()].filter(Boolean).join(' · ');
  return h('span', { class: `link-chip payer-chip ${limited ? 'warn' : 'ok'}`, title: `Its last turn ran on ${mine(t) ? 'your' : `${t.payer.name}'s`} Claude plan` }, text);
}

/** Over the composer: the payer's limit is hit, you haven't linked a plan, or your message would switch the payer. Null when none applies. */
export function payerLine(t, sendText) {
  if (!account || t.status === 'closed') return null;
  const cost = loadCost(t);
  if (t.state === 'limited' && t.payer) {
    const other = account.turns && !mine(t);
    // Sends what's in the box the usual way (clearing it), or a plain "Carry on." when it's empty.
    const go = other && h('button', { type: 'button', class: 'small', onclick: (e) => {
      const form = e.target.closest('.composer');
      if (form?.querySelector('textarea')?.value.trim()) form.requestSubmit();
      else sendText('Carry on.');
    } }, 'Continue on my plan');
    return h('div', { class: 'payer-line warn' },
      `${mine(t) ? 'Your' : `${t.payer.name}'s`} plan hit its usage limit; this minion carries on${t.limit_resume_at ? ` at ${time(t.limit_resume_at)}` : ' once it resets'}.`,
      go ? h('span', { class: 'row' }, go, cost ? h('span', { class: 'muted' }, `${cost} of your usage to load it`) : '') : '');
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
