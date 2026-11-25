// The Models section of Settings → Usage (#1061): which model a minion starts on and why (rendered from model-table.js itself),
// and the weekly Fable cap with its meter. Josh, 2026-11-19: the cap is a share of each person's weekly plan (you), or API
// dollars for the whole Citadel; past it, Fable tiers start on Opus high.
import { account, api, costText, h } from './base.js';
import { emptyCard, hueRow, meter, showFirst, statTiles, toneChip } from './look.js';
import { settingsRow } from './settings.js';
import { advisorTrialEnd, BY_TYPE, FALLBACK, tierLabel, tierRows } from './model-table.js';

/** The Fable bar `pct` wide of its cap (capped at 100), in Citadel's meter; red once over. Its width goes through the CSSOM (the CSP refuses style attributes). */
function meterBar(pct, over) {
  const words = `${pct < 10 ? pct.toFixed(1) : Math.round(pct)}% of cap`;
  return h('div', { class: 'fable-bar', 'data-hue': over ? 'danger' : 'running' }, meter(Math.min(1, Math.max(0, pct / 100)), words));
}

const pctText = (n) => (n && n < 0.1 ? '<0.1%' : `${n < 10 ? n.toFixed(1) : Math.round(n)}%`);

const FAMILY_HUE = [
  [/fable/i, 'accent'],
  [/opus/i, 'held'],
  [/sonnet/i, 'running'],
  [/haiku/i, 'teal'],
];

/** The tiers, the step-ups, what each type starts on and the advisor trial, all from the table: a row per tier, then one line. */
export function modelTable() {
  const end = advisorTrialEnd();
  const rows = tierRows().map((r) => hueRow({ hue: FAMILY_HUE.find(([re]) => re.test(r.model))?.[1] ?? 'done' }, h('div', { class: 'tier-name' }, h('b', {}, r.tier)), h('div', { class: 'tier-work' }, r.work), r.then ? h('div', { class: 'tier-then muted' }, `Stalls: ${r.then}`) : ''));
  return h(
    'div',
    { class: 'models-table' },
    showFirst({ key: 'models-tiers', items: rows, n: 6, noun: 'tiers' }),
    h(
      'p',
      { class: 'look-prose foot' },
      `A minion's type picks its start when nobody names a model: ${Object.entries(BY_TYPE)
        .map(([type, p]) => `${type} → ${tierLabel(p.model, p.effort)}`)
        .join(', ')}; anything else → ${tierLabel(FALLBACK.model, FALLBACK.effort)}. `,
      'When unsure between two tiers the Taskmaster takes the higher. ',
      end ? `The advisor trial (Sonnet with an Opus advisor) runs until ${end}. ` : '',
      'Every minion shows why it runs where it does (“Picked because”) beside its model picker.',
    ),
  );
}

/**
 * The Fable meter as a row that opens: you (% of your weekly plan) or the whole Citadel (API dollars), against the cap.
 * Its closed line says where you stand; the chip, tiles and bar redraw with each pick and each saved cap.
 */
export function fableMeterView(w) {
  const f = w.fable;
  const slot = h('div', { class: 'fable-slot' });
  const tilesSlot = h('div', { class: 'fable-tiles' });
  let who = 'you';
  let sum = null;
  const draw = () => {
    const mine = w.models.filter((m) => m.name.startsWith('Fable')).reduce((a, m) => a + m.usd, 0);
    const myPct = w.weekUsd ? (mine / w.weekUsd) * 100 : null;
    const [tone, word] = f.over ? ['danger', 'Citadel over cap'] : myPct === null ? ['neutral', 'No meter'] : myPct >= f.capPct ? ['danger', 'Over cap'] : myPct >= f.capPct * 0.8 ? ['warn', 'Near cap'] : ['ok', 'Under cap'];
    sum?.replaceChildren(toneChip(tone, word), myPct === null ? 'no weekly meter has priced your plan yet' : `${pctText(myPct)} of your plan · cap ${f.capPct}%`);
    tilesSlot.replaceChildren(
      statTiles(myPct !== null && [pctText(myPct), 'of your weekly plan on Fable', tone === 'danger' ? 'danger' : tone === 'warn' ? 'waiting' : 'done'], [`${f.capPct}%`, 'weekly cap', 'accent'], [costText(f.usd), f.over ? 'Whole Citadel, 7 days (over)' : 'Whole Citadel, 7 days', f.over ? 'danger' : 'held']),
    );
    const body =
      who === 'you'
        ? myPct === null
          ? [emptyCard('No share to show', 'No weekly meter has priced your plan yet.', { mark: '·', hue: 'muted' })]
          : [h('div', { class: 'fable-line' }, h('b', {}, pctText(myPct)), ` of your weekly plan on Fable, cap ${f.capPct}%`, h('span', { class: 'usd' }, costText(mine))), meterBar((myPct / Math.max(f.capPct, 0.1)) * 100, myPct >= f.capPct)]
        : f.capUsd === null
          ? [emptyCard('Dollar cap not known', 'No weekly meter has priced any plan yet.', { mark: '·', hue: 'muted' })]
          : [h('div', { class: 'fable-line' }, h('b', {}, costText(f.usd)), ` of ${costText(f.capUsd)} on Fable in the last 7 days, everyone together`), meterBar((f.usd / Math.max(f.capUsd, 0.01)) * 100, f.over)];
    slot.replaceChildren(...body);
  };
  const pick = h(
    'div',
    { class: 'range-pick', role: 'group', 'aria-label': 'Whose Fable use' },
    [
      ['you', 'You'],
      ['all', 'Whole Citadel'],
    ].map(([key, label]) =>
      h(
        'button',
        {
          type: 'button',
          'data-who': key,
          'aria-pressed': String(key === who),
          onclick: () => {
            who = key;
            for (const b of pick.children) b.setAttribute('aria-pressed', String(b.dataset.who === key));
            draw();
          },
        },
        label,
      ),
    ),
  );
  const input = h('input', { type: 'number', min: '0', max: '100', step: '1', value: String(f.capPct), 'aria-label': 'Weekly Fable cap, percent of the weekly plan', class: 'fable-cap-input' });
  const status = h('span', { class: 'key', role: 'status' });
  const save = h(
    'button',
    {
      type: 'button',
      onclick: async () => {
        // Number('') is 0: a blank box would switch the cap off for every Fable-tier minion.
        if (!input.value.trim()) return void (status.textContent = 'Type a percent from 0 to 100 first.');
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
      },
    },
    'Save',
  );
  const [row, sumEl] = settingsRow(
    { key: 'models-fable', part: 'fable-cap', icon: 'spark', hue: f.over ? 'danger' : 'accent', title: 'Weekly Fable cap' },
    tilesSlot,
    pick,
    slot,
    account?.admin ? h('div', { class: 'fable-cap-row' }, h('label', {}, 'Weekly cap ', input, ' % of the plan'), save, status) : h('p', { class: 'look-prose' }, `Weekly cap: ${f.capPct}% of the plan (an admin sets it).`),
    h(
      'p',
      { class: 'look-prose foot' },
      f.over
        ? 'Over the cap: Taskmasters start Fable-tier minions on Opus high until the last 7 days drop back under it.'
        : 'Past the cap, Taskmasters start Fable-tier minions on Opus high on their own until the last 7 days drop back under it. The cap counts everyone together, in dollars at API prices (the cap % of every weekly plan added up).',
    ),
  );
  sum = sumEl;
  draw();
  return row;
}

/** The meter's row when its data could not load: a card saying so, in the same box. */
const meterError = (message) => emptyCard('Couldn’t load the Fable meter', message, { mark: '!', hue: 'danger' });

/** The whole Models section: the Fable cap row, then the table's row, in one box of rows. */
export async function modelsSection(into) {
  const [tiers] = settingsRow({ key: 'models-tiers-row', icon: 'branch', hue: 'teal', title: 'Which model, and why', summary: [toneChip('info', `${tierRows().length} tiers`), 'by kind of work, and what each stall steps up to'] }, modelTable());
  let first;
  try {
    first = fableMeterView(await api('api/costs/mine'));
  } catch (err) {
    first = meterError(err.message);
  }
  into.replaceChildren(h('div', { class: 'settings-rows models-rows' }, first, tiers));
  into.classList.remove('loading');
}
