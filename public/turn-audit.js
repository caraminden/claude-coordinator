// Settings → App turns (#844): every model call the scheme's contraptions make, as sent and as answered, with the
// app's own verdict. Text only; members of the scheme see it, and its Taskmaster through contraption_turns (GET api/projects/:id/contraption-turns).
import { api, h, icon, view } from './base.js';
import { settingsTabs } from './settings.js';

const clock = (ms) => new Date(ms).toLocaleString([], { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });

/** One collapsed section of a turn's text: shown whole when opened, as plain text. */
const block = (label, text) => h('details', { class: 'turn-text' },
  h('summary', {}, label, h('span', { class: 'muted' }, ` · ${text.length.toLocaleString()} characters`)),
  h('pre', {}, text || '(empty)'));

function row(t) {
  const [tone, word, tip] = t.verdict === 'pass' ? ['ok', 'Passed', 'The app checked the reply and used it']
    : t.verdict === 'fallback' ? ['warn', 'Fell back', 'The app used its rule text in place of the reply']
    : ['neutral', 'No verdict', 'The app has not posted a verdict for this turn'];
  const ended = t.outcome && t.outcome !== 'end' ? t.outcome : '';
  return h('div', { class: 'turn-row' },
    h('div', { class: 'turn-head' },
      h('span', { class: 'name' }, t.contraption_title || t.contraption),
      h('span', { class: 'meta' }, ['for', t.person ?? 'someone removed', '·', clock(t.at), t.model && `· ${t.model}`, ended && `· ${ended}`].filter(Boolean).join(' ')),
      h('span', { class: 'spacer' }),
      t.blind && h('span', { class: 'cui-chip', 'data-tone': 'info', title: 'A blind turn: no tools, no memory, no Citadel prompt; the model saw only this system text and prompt' }, 'Blind'),
      h('span', { class: 'cui-chip', 'data-tone': tone, title: tip }, word)),
    t.verdict_reason && h('p', { class: 'small turn-reason' }, h('span', { class: 'muted' }, t.verdict === 'pass' ? 'Note: ' : 'Why: '), t.verdict_reason),
    block('System', t.system), block('Prompt', t.prompt), block('Output', t.output),
    t.images ? h('p', { class: 'muted small' }, `${t.images} image${t.images === 1 ? '' : 's'} sent with the prompt (not kept)`) : '');
}

export function turnAuditPage() {
  const p = view.project;
  const list = h('div', { class: 'turn-list' });
  const pick = h('select', { 'aria-label': 'App' }, h('option', { value: '' }, 'All apps'));
  const more = h('button', { type: 'button', class: 'secondary', hidden: true }, 'Older turns');
  const note = h('p', { class: 'muted turn-note' });
  const filter = h('div', { class: 'turn-filter', hidden: true }, pick);
  let before = null;
  const load = async (fresh) => {
    if (fresh) before = null;
    more.disabled = true;
    const q = new URLSearchParams();
    if (before) q.set('before', before);
    if (pick.value) q.set('app', pick.value);
    try {
      const r = await api(`api/projects/${p.id}/contraption-turns?${q}`);
      if (fresh) {
        list.replaceChildren();
        if (pick.options.length === 1) pick.append(...r.apps.map((a) => h('option', { value: a.name }, a.title || a.name)));
        filter.hidden = r.apps.length < 2;
        note.textContent = `Each turn is kept ${r.keep_days} days, then deleted. Deleting a session in the app deletes its turns here too.`;
      }
      list.append(...r.turns.map(row));
      if (!list.children.length) list.append(h('p', { class: 'muted' }, r.apps.length ? 'No turns in the last few days.' : 'This scheme has no apps.'));
      before = r.turns.at(-1)?.id ?? before;
      more.hidden = !r.more;
    } catch (err) {
      list.append(h('p', { class: 'cui-notice', 'data-tone': 'danger' }, `Couldn't load the turns: ${err.message}`));
    } finally {
      more.disabled = false;
    }
  };
  pick.onchange = () => load(true);
  more.onclick = () => load(false);
  load(true);
  return h('section', { class: 'artifacts-main people-main' },
    h('div', { class: 'ticket-head' },
      h('div', { class: 'row' }, h('h2', {}, 'Settings'), h('span', { class: 'spacer' }),
        h('a', { class: 'close-view', href: `#/p/${p.id}`, title: 'Back to the Taskmaster', 'aria-label': 'Close' }, icon('close'))),
      settingsTabs(),
      h('div', { class: 'meta' }, 'Every model call this scheme\'s apps make: what the model was sent, what it answered, and whether the app used it. Only the scheme\'s members see it.')),
    filter, note, list, more);
}
