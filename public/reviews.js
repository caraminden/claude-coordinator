// A scheme's Reviewers and critics page (Build 4, #1051): its review set from the store (src/review-set.ts), in
// columns by when each one runs (layout take A, Josh 2026-11-19). A card's switch saves at once; the detail shows what
// it reviews, its context, and Edit by hand and History. Every save is a new version; New starts on trial (Q12).
import { ago, api, h, icon, view } from './base.js';
import { optimistic } from './ui/optimistic.js';
import { toast } from './ui/status.js';

const COLUMNS = [['work', 'While working'], ['ship', 'Before ship'], ['ask', 'On ask'], ['schedule', 'On a schedule']];
const KINDS = ['critic', 'reviewer', 'checker', 'referee', 'teacher', 'audit'];
const pacific = (ms) => new Date(ms).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });

let pageEl = null;
let state = null; // { projectId, entries, starters, selected, mode: 'view'|'edit'|'history'|'new', versions }

const url = (slug = '') => `api/projects/${state.projectId}/reviews${slug ? `/${encodeURIComponent(slug)}` : ''}`;
const entry = (slug) => state.entries.find((e) => e.slug === slug);

export function reviewsPage() {
  const projectId = view.projectId;
  if (state?.projectId !== projectId) state = { projectId, entries: null, starters: [], selected: null, mode: 'view', versions: null };
  pageEl = h('section', { class: 'reviews-main', onkeydown: (e) => { if (e.key === 'Escape' && state.mode === 'view') closePage(); } });
  draw();
  load();
  return pageEl;
}

function closePage() {
  location.hash = `#/p/${view.projectId}/settings`;
}

async function load() {
  const at = state;
  try {
    const { entries, starters } = await api(url());
    if (state !== at) return;
    Object.assign(state, { entries, starters });
    if (state.selected && !entry(state.selected)) state.selected = null;
    if (!state.selected && entries.length && matchMedia('(min-width: 801px)').matches) state.selected = entries[0].slug;
  } catch (err) {
    if (state === at && !state.entries) state.error = err.message;
  }
  draw();
}

/** The server said the set changed: reload it, unless an edit is open (its save would then say it's stale). */
export function onReviewsChanged(projectId) {
  if (!pageEl?.isConnected || state?.projectId !== projectId) return;
  if (state.mode === 'edit' || state.mode === 'new') return;
  load();
  if (state.mode === 'history') loadVersions();
}

function draw() {
  if (!pageEl) return;
  const close = (cls, name) => h('button', { type: 'button', class: `close-view ${cls}`, 'aria-label': 'Close', title: 'Close', onclick: closePage }, icon(name));
  const head = h('div', { class: 'ticket-head rv-head' },
    h('div', { class: 'row' }, close('narrow-only', 'back'),
      h('h2', {}, 'Reviewers and critics', h('span', { class: 'muted rv-scheme' }, ` · ${view.project?.name ?? ''}`)),
      h('span', { class: 'spacer' }),
      h('button', { type: 'button', class: 'cui-btn rv-new', onclick: () => select(null, 'new') }, '+ New'),
      close('wide-only', 'close')));
  const body = state.error ? [h('p', { class: 'error' }, state.error)]
    : !state.entries ? [h('p', { class: 'muted' }, 'Loading…')]
      : [board(), detail()];
  pageEl.replaceChildren(head, h('div', { class: 'rv-body' }, ...body));
}

function select(slug, mode = 'view') {
  state.selected = slug;
  state.mode = mode;
  state.versions = null;
  draw();
  if (mode === 'history') loadVersions();
  // On a phone the detail sits under the columns.
  if (matchMedia('(max-width: 800px)').matches) pageEl.querySelector('.rv-detail')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

function board() {
  const cols = COLUMNS.filter(([stage]) => stage !== 'ask' || state.entries.some((e) => e.stage === 'ask'));
  if (!state.entries.length) {
    return h('div', { class: 'rv-board rv-empty' },
      h('p', {}, 'Nothing reviews work in this scheme yet.'),
      h('p', { class: 'muted' }, 'Add a critic from a kit starter (like the UI screenshots critic) or write one from scratch. A new one starts on trial: it advises, and blocks nothing, until you take it off trial.'),
      h('button', { type: 'button', class: 'cui-btn cui-primary', onclick: () => select(null, 'new') }, '+ New'));
  }
  return h('div', { class: 'rv-board' }, ...cols.map(([stage, label]) => {
    const list = state.entries.filter((e) => e.stage === stage);
    return h('section', { class: 'rv-col', 'aria-label': label },
      h('h3', {}, label),
      list.length ? list.map(card) : h('p', { class: 'muted rv-none' }, 'None'));
  }));
}

function card(e) {
  const sw = onSwitch(e);
  return h('div', { class: `rv-card${e.slug === state.selected ? ' on' : ''}${e.enabled ? '' : ' off'}`, role: 'button', tabindex: 0, 'aria-pressed': String(e.slug === state.selected),
    onclick: () => select(e.slug), onkeydown: (ev) => { if (ev.target === ev.currentTarget && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); select(e.slug); } } },
  h('div', { class: 'rv-card-top' }, h('span', { class: 'rv-card-name' }, e.name), sw),
  h('div', { class: 'rv-card-when' }, whenLine(e)),
  chips(e));
}

function chips(e) {
  return h('div', { class: 'rv-chips' },
    e.kind !== 'critic' ? h('span', { class: 'cui-chip', 'data-tone': 'neutral' }, e.kind) : null,
    e.trial ? h('span', { class: 'cui-chip', 'data-tone': 'warn', title: 'On trial: it advises and blocks nothing' }, 'trial') : null,
    e.extends ? h('span', { class: 'cui-chip', 'data-tone': 'info', title: `On top of the kit's ${e.extends} starter, so kit fixes reach it` }, 'kit') : null,
    e.enabled ? null : h('span', { class: 'cui-chip', 'data-tone': 'neutral' }, 'off'));
}

/** The trigger in words: "Changes in public/**", "Monthly", "When a person asks". */
function whenLine(e) {
  const t = e.triggers ?? {};
  const parts = [];
  if (t.diff?.length) parts.push(`Changes in ${t.diff.join(', ')}`);
  if (t.types?.length) parts.push(`${t.types.join(' or ')} minions`);
  if (t.creative) parts.push(t.creative);
  if (t.in_app) parts.push(`In the app: ${t.in_app}`);
  if (t.schedule) parts.push(t.schedule);
  if (t.ask || !parts.length) parts.push('When a person asks');
  return parts.join('; ');
}

/** Its on/off switch: Minion rules' switch (settings.css .rules-switch). */
function onSwitch(e) {
  return h('button', { type: 'button', class: 'rules-switch', role: 'switch', 'aria-checked': String(e.enabled), 'aria-label': `${e.name}: ${e.enabled ? 'on' : 'off'}`,
    onclick: (ev) => { ev.stopPropagation(); setSwitch(e.slug, { enabled: !e.enabled }); } });
}

/** A switch saves at once and rolls back with a toast if the save fails (Cara 2026-11-08). */
function setSwitch(slug, patch) {
  let was;
  optimistic({
    key: `reviews:${state.projectId}:${slug}`,
    apply: () => {
      const e = entry(slug);
      was = { enabled: e.enabled, trial: e.trial };
      Object.assign(e, patch);
      draw();
    },
    send: () => api(url(slug), { method: 'PATCH', body: patch }),
    undo: () => {
      const e = entry(slug);
      if (e) Object.assign(e, was);
      draw();
    },
    label: patch.enabled === undefined ? 'change its trial' : `turn ${patch.enabled ? 'on' : 'off'} ${entry(slug)?.name ?? slug}`,
  }).then((saved) => {
    const i = state.entries.findIndex((x) => x.slug === slug);
    if (i >= 0 && saved?.slug) state.entries[i] = saved;
    if (state.mode !== 'edit') draw();
  }, () => {});
}

function detail() {
  if (state.mode === 'new') return h('aside', { class: 'rv-detail' }, newForm());
  const e = state.selected && entry(state.selected);
  if (!e) return h('aside', { class: 'rv-detail rv-detail-empty' }, h('p', { class: 'muted' }, state.entries.length ? 'Pick one to see what it reviews.' : ''));
  if (state.mode === 'edit') return h('aside', { class: 'rv-detail' }, editForm(e));
  const sw = onSwitch(e);
  const section = (title, ...body) => h('section', { class: 'rv-sec' }, h('h4', {}, title), ...body);
  const ctx = e.context ?? {};
  const guides = ctx.guides ?? [];
  const contextItems = [
    e.extends ? h('li', {}, `The kit's ${e.extends} starter, under this scheme's own lines`) : null,
    ...guides.map((g) => h('li', {}, h('a', { href: g.href, ...(/^https?:/.test(g.href) ? { target: '_blank', rel: 'noopener' } : {}) }, g.label || g.href))),
    ...(ctx.paths ?? []).map((p) => h('li', {}, h('code', {}, p))),
    ctx.verdicts ? h('li', {}, 'Your past verdicts on its work') : null,
    ctx.requester ? h('li', {}, "The requester's own words") : null,
  ].filter(Boolean);
  return h('aside', { class: 'rv-detail' },
    h('div', { class: 'rv-detail-head' },
      h('button', { type: 'button', class: 'close-view narrow-only', 'aria-label': 'Back to the columns', title: 'Back', onclick: () => { state.selected = null; draw(); pageEl.scrollIntoView({ block: 'start' }); } }, icon('back')),
      h('h3', {}, e.name), chips(e)),
    h('div', { class: 'rv-switch-row' }, sw, h('span', {}, e.enabled ? 'On' : 'Off')),
    h('div', { class: 'rv-trial' },
      e.trial ? h('span', { class: 'muted' }, 'On trial: it advises and blocks nothing.') : h('span', { class: 'muted' }, 'Off trial.'),
      h('button', { type: 'button', class: 'cui-btn cui-small', onclick: () => setSwitch(e.slug, { trial: !e.trial }) }, e.trial ? 'Take off trial' : 'Put on trial')),
    section('Reviews', h('p', {}, whenLine(e)), h('p', { class: 'muted rv-when' }, h('code', {}, `when: ${e.when}`))),
    section('Context', contextItems.length ? h('ul', { class: 'rv-ctx' }, contextItems) : h('p', { class: 'muted' }, 'Only the work itself and its rubric.')),
    section('With the others', h('p', { class: 'muted' }, 'Runs on its own: no order, hand-off or panel yet.')),
    section('Record', h('p', { class: 'muted' }, 'No verdicts recorded yet. Once minions record them, the last runs show here.')),
    h('div', { class: 'rv-actions' },
      h('button', { type: 'button', class: 'cui-btn', onclick: () => select(e.slug, 'edit') }, 'Edit by hand'),
      h('button', { type: 'button', class: 'cui-btn', 'aria-pressed': String(state.mode === 'history'), onclick: () => select(e.slug, state.mode === 'history' ? 'view' : 'history') }, 'History')),
    state.mode === 'history' ? history(e) : null,
    h('p', { class: 'muted rv-ver' }, `Version ${e.version}, saved by ${e.updated_by} ${ago(e.updated_at)}`));
}

async function loadVersions() {
  const slug = state.selected;
  try {
    const { versions } = await api(`${url(slug)}/versions`);
    if (state.selected === slug) state.versions = versions;
  } catch (err) {
    toast(`Couldn't load its history: ${err.message}`);
  }
  draw();
}

function history(e) {
  if (!state.versions) return h('p', { class: 'muted' }, 'Loading its history…');
  return h('ol', { class: 'rv-history' }, state.versions.map((v) => h('li', {},
    h('span', { class: 'rv-hv' }, `v${v.version}`),
    h('span', { class: 'rv-hnote' }, v.note, h('span', { class: 'muted' }, ` · ${v.by} · `, h('time', { title: pacific(v.at) }, ago(v.at)))),
    v.version === e.version ? h('span', { class: 'muted' }, 'current')
      : h('button', { type: 'button', class: 'cui-btn cui-small', onclick: () => restore(e, v.version) }, 'Restore'))));
}

async function restore(e, version) {
  try {
    const saved = await api(`${url(e.slug)}/restore`, { method: 'POST', body: { version } });
    state.entries[state.entries.findIndex((x) => x.slug === e.slug)] = saved;
    toast(`Restored version ${version} as version ${saved.version}`);
    await loadVersions();
  } catch (err) {
    toast(`Couldn't restore: ${err.message}`);
  }
}

const field = (label, input, hint) => h('label', { class: 'rv-field' }, h('span', { class: 'rv-label' }, label), input, hint ? h('span', { class: 'muted rv-hint' }, hint) : null);

/** Edit by hand: the fields and the body as the critic reads it. A save names the version it started from, so a save over someone else's is refused. */
function editForm(e) {
  const name = h('input', { class: 'cui-input', value: e.name, required: true });
  const kind = h('select', { class: 'cui-input' }, KINDS.map((k) => h('option', { value: k, selected: k === e.kind }, k)));
  const when = h('input', { class: 'cui-input', value: e.when === 'ask' ? '' : e.when, placeholder: 'ask' });
  const stage = h('select', { class: 'cui-input' }, COLUMNS.map(([v, l]) => h('option', { value: v, selected: v === e.stage }, l)));
  const model = h('input', { class: 'cui-input', value: e.model ?? '', placeholder: "The kit's pick" });
  const effort = h('select', { class: 'cui-input' }, [['', "The kit's pick"], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']].map(([v, l]) => h('option', { value: v, selected: v === (e.effort ?? '') }, l)));
  const body = h('textarea', { class: 'cui-input rv-bodytext', rows: 18, spellcheck: false }, e.body);
  const note = h('input', { class: 'cui-input', placeholder: 'Edited by hand' });
  const err = h('p', { class: 'error', hidden: true });
  const save = h('button', { type: 'submit', class: 'cui-btn cui-primary' }, 'Save');
  const submit = async (ev) => {
    ev.preventDefault();
    save.disabled = true;
    err.hidden = true;
    try {
      const saved = await api(url(e.slug), { method: 'PATCH', body: { name: name.value, kind: kind.value, when: when.value.trim() || 'ask', stage: stage.value, model: model.value.trim() || null, effort: effort.value || null, body: body.value, note: note.value, version: e.version } });
      state.entries[state.entries.findIndex((x) => x.slug === e.slug)] = saved;
      toast(saved.version === e.version ? 'Nothing changed' : `Saved as version ${saved.version}`);
      state.mode = 'view';
      draw();
    } catch (x) {
      err.textContent = x.message;
      err.hidden = false;
      save.disabled = false;
    }
  };
  return h('form', { class: 'rv-form', onsubmit: submit },
    h('h3', {}, `Edit ${e.name}`),
    field('Name', name),
    h('div', { class: 'rv-pair' }, field('Kind', kind), field('Column', stage)),
    field('When it runs', when, 'Like diff: public/**, schedule: monthly, or ask. Parts join with ;'),
    h('div', { class: 'rv-pair' }, field('Model', model), field('Effort', effort)),
    field(e.extends ? `Its own lines, under the kit's ${e.extends}` : 'The rubric', body, 'Markdown with ## sections: what it checks, what passes, what fails.'),
    field('What changed', note),
    err,
    h('div', { class: 'rv-actions' }, save, h('button', { type: 'button', class: 'cui-btn cui-ghost', onclick: () => select(e.slug) }, 'Cancel')));
}

/** New: blank, or on top of a kit starter. It always starts on trial. */
function newForm() {
  const slug = h('input', { class: 'cui-input', placeholder: 'ui-screenshots', pattern: '[a-z0-9]+(-[a-z0-9]+)*', title: 'kebab-case, like ui-screenshots' });
  const from = h('select', { class: 'cui-input', onchange: () => { if (from.value && !slug.value) slug.placeholder = from.value; } },
    h('option', { value: '' }, 'Blank'), state.starters.map((s) => h('option', { value: s.slug }, `${s.slug}${s.judges ? `: ${s.judges}` : ''}`)));
  const err = h('p', { class: 'error', hidden: true });
  const add = h('button', { type: 'submit', class: 'cui-btn cui-primary' }, 'Add on trial');
  const submit = async (ev) => {
    ev.preventDefault();
    add.disabled = true;
    err.hidden = true;
    try {
      const body = { ...(from.value ? { extends: from.value } : {}), ...(slug.value.trim() ? { slug: slug.value.trim() } : {}) };
      const made = await api(url(), { method: 'POST', body });
      state.entries.push(made);
      select(made.slug, 'edit');
    } catch (x) {
      err.textContent = x.message;
      err.hidden = false;
      add.disabled = false;
    }
  };
  return h('form', { class: 'rv-form', onsubmit: submit },
    h('h3', {}, 'New reviewer or critic'),
    field('Start from', from, 'A kit starter keeps getting the kit\'s fixes; this scheme\'s lines go on top.'),
    field('Name it', slug, 'Its file name, kebab-case. Leave it empty to use the starter\'s.'),
    h('p', { class: 'muted' }, 'It starts on trial: it advises and blocks nothing until you take it off trial.'),
    err,
    h('div', { class: 'rv-actions' }, add, h('button', { type: 'button', class: 'cui-btn cui-ghost', onclick: () => select(null) }, 'Cancel')));
}
