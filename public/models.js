// The Models section of Settings → Usage (#1061): which model a minion starts on and why (rendered from model-table.js itself),
// and the weekly Fable cap with its meter. Josh, 2026-11-19: the cap is a share of each person's weekly plan (you), or API
// dollars for the whole Citadel; past it, Fable tiers start on Opus high.
import { account, api, costText, h } from './base.js';
import { advisorTrialEnd, BY_TYPE, FALLBACK, tierLabel, tierRows } from './model-table.js';

/** A bar `pct` wide (capped at 100); through the CSSOM, since the page's CSP refuses style attributes. */
function meterBar(pct, over) {
  const el = h('span', { class: `bar${over ? ' over' : ''}` });
  el.style.setProperty('--pct', `${Math.min(100, Math.max(pct > 0 ? 2 : 0, pct))}%`);
  return h('span', { class: 'fable-track' }, el);
}

const pctText = (n) => (n && n < 0.1 ? '<0.1%' : `${n < 10 ? n.toFixed(1) : Math.round(n)}%`);

/** The tiers, the step-ups, what each type starts on and the advisor trial, all from the table. */
export function modelTable() {
  const end = advisorTrialEnd();
  return h('div', { class: 'models-table' },
    h('table', { class: 'where-table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Kind of work'), h('th', {}, 'Starts on'), h('th', {}, 'If it stalls'))),
      h('tbody', {}, tierRows().map((r) => h('tr', { class: 'tier-row' },
        h('td', { class: 'work' }, r.work), h('th', { scope: 'row' }, r.tier), h('td', { class: 'then' }, r.then ?? '–'))))),
    h('p', { class: 'foot' },
      `A minion's type picks its start when nobody names a model: ${Object.entries(BY_TYPE).map(([type, p]) => `${type} → ${tierLabel(p.model, p.effort)}`).join(', ')}; anything else → ${tierLabel(FALLBACK.model, FALLBACK.effort)}. `,
      'When unsure between two tiers the Taskmaster takes the higher. ',
      end ? `The advisor trial (Sonnet with an Opus advisor) runs until ${end}. ` : '',
      'Every minion shows why it runs where it does (“Picked because”) beside its model picker.'));
}

/** The Fable meter: you (% of your weekly plan) or the whole Citadel (API dollars), against the cap. */
export function fableMeterView(w) {
  const f = w.fable;
  const slot = h('div', { class: 'fable-slot' });
  let who = 'you';
  const draw = () => {
    const mine = w.models.filter((m) => m.name.startsWith('Fable')).reduce((a, m) => a + m.usd, 0);
    const myPct = w.weekUsd ? (mine / w.weekUsd) * 100 : null;
    const body = who === 'you'
      ? (myPct === null
        ? [h('p', { class: 'key' }, 'No weekly meter has priced your plan yet, so there is no share to show.')]
        : [h('div', { class: 'fable-line' }, h('b', {}, pctText(myPct)), ` of your weekly plan on Fable, cap ${f.capPct}%`, h('span', { class: 'usd' }, costText(mine))), meterBar((myPct / Math.max(f.capPct, 0.1)) * 100, myPct >= f.capPct)])
      : (f.capUsd === null
        ? [h('p', { class: 'key' }, 'No weekly meter has priced any plan yet, so the dollar cap is not known.')]
        : [h('div', { class: 'fable-line' }, h('b', {}, costText(f.usd)), ` of ${costText(f.capUsd)} on Fable in the last 7 days, everyone together`), meterBar((f.usd / Math.max(f.capUsd, 0.01)) * 100, f.over)]);
    slot.replaceChildren(...body);
  };
  const pick = h('div', { class: 'range-pick', role: 'group', 'aria-label': 'Whose Fable use' },
    [['you', 'You'], ['all', 'Whole Citadel']].map(([key, label]) => h('button', { type: 'button', 'data-who': key, 'aria-pressed': String(key === who), onclick: () => {
      who = key;
      for (const b of pick.children) b.setAttribute('aria-pressed', String(b.dataset.who === key));
      draw();
    } }, label)));
  const input = h('input', { type: 'number', min: '0', max: '100', step: '1', value: String(f.capPct), 'aria-label': 'Weekly Fable cap, percent of the weekly plan', class: 'fable-cap-input' });
  const status = h('span', { class: 'key', role: 'status' });
  const save = h('button', { type: 'button', onclick: async () => {
    const pct = Number(input.value);
    status.textContent = 'Saving…';
    try {
      await api('api/costs/fable-cap', { method: 'PUT', body: { pct } });
      status.textContent = 'Saved. It applies from the Taskmaster’s next turn.';
      f.capPct = pct;
      f.capUsd = f.weekUsd === null ? null : (f.weekUsd * pct) / 100;
      f.over = f.capUsd !== null && f.usd >= f.capUsd;
      draw();
    } catch (err) {
      status.textContent = `Couldn't save: ${err.message}`;
    }
  } }, 'Save');
  draw();
  return h('div', { class: 'fable-meter' }, pick, slot,
    account?.admin ? h('div', { class: 'fable-cap-row' }, h('label', {}, 'Weekly cap ', input, ' % of the plan'), save, status) : h('p', { class: 'key' }, `Weekly cap: ${f.capPct}% of the plan (an admin sets it).`),
    h('p', { class: 'foot' }, f.over
      ? 'Over the cap: Taskmasters start Fable-tier minions on Opus high until the last 7 days drop back under it.'
      : 'Past the cap, Taskmasters start Fable-tier minions on Opus high on their own until the last 7 days drop back under it. The cap counts everyone together, in dollars at API prices (the cap % of every weekly plan added up).'));
}

/** The whole Models section: the meter, then the table. */
export async function modelsSection(into) {
  try {
    const w = await api('api/costs/mine');
    into.replaceChildren(fableMeterView(w), h('h4', {}, 'Which model, and why'), modelTable());
  } catch (err) {
    into.replaceChildren(h('p', { class: 'key' }, `Couldn't load the Fable meter: ${err.message}`), h('h4', {}, 'Which model, and why'), modelTable());
  }
  into.classList.remove('loading');
}
