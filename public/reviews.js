// A scheme's Reviewers and critics page (Build 4, #1051): its review set from the store (src/review-set.ts), in
// columns by when each one runs (layout take A, Josh 2026-11-19). A card's switch saves at once; the detail shows what
// it reviews, its context, and Edit by hand and History. Every save is a new version; New starts on trial (Q12).
// Phase 2 (#1052): the kit's own reviewers and audits are on it too, switched per scheme; Block or Advise is locked
// while an entry is on trial; and a describe box asks an agent for edits, shown as before and after with Apply.
import { ago, api, h, icon, view } from './base.js';
import { collapseRuns, diffLines } from './plan-diff.js';
import { optimistic } from './ui/optimistic.js';
import { toast } from './ui/status.js';

const COLUMNS = [['work', 'While working'], ['ship', 'Before ship'], ['ask', 'On ask'], ['schedule', 'On a schedule']];
const KINDS = ['critic', 'reviewer', 'checker', 'referee', 'teacher', 'audit'];
const pacific = (ms) => new Date(ms).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });

let pageEl = null;
let state = null; // { projectId, entries, starters, audits, selected, mode: 'view'|'edit'|'history'|'new', versions, ask }

const url = (slug = '') => `api/projects/${state.projectId}/reviews${slug ? `/${encodeURIComponent(slug)}` : ''}`;
const entry = (slug) => state.entries.find((e) => e.slug === slug);
// An audit's key on the page: audits are schedules, not entries, so their slugs live apart.
const audit = (key) => key?.startsWith('audit:') ? state.audits.find((a) => `audit:${a.slug}` === key) : undefined;

/** Who gives the risk label (as labelGiver in src/review-set.ts): the pre-ship review, else an enabled, calibrated entry marked to. */
function labelGiver() {
  const pre = entry('pre-ship-review');
  if (!pre?.kit || pre.enabled) return pre?.kit ? pre : { name: 'Pre-ship review' };
  return state.entries.find((e) => e.enabled && !e.trial && e.gives_label) ?? null;
}

export function reviewsPage() {
  const projectId = view.projectId;
  if (state?.projectId !== projectId) state = { projectId, entries: null, starters: [], audits: [], selected: null, mode: 'view', versions: null, ask: null };
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
    const { entries, starters, audits } = await api(url());
    if (state !== at) return;
    Object.assign(state, { entries, starters, audits: audits ?? [] });
    if (state.selected && !entry(state.selected) && !audit(state.selected)) state.selected = null;
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
  pageEl.replaceChildren(head, state.entries ? describeBox() : '', h('div', { class: 'rv-body' }, ...body));
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
  if (!state.entries.length && !state.audits.length) {
    return h('div', { class: 'rv-board rv-empty' },
      h('p', {}, 'Nothing reviews work in this scheme yet.'),
      h('p', { class: 'muted' }, 'Add a critic from a kit starter (like the UI screenshots critic) or write one from scratch. A new one starts on trial: it advises, and blocks nothing, until you take it off trial.'),
      h('button', { type: 'button', class: 'cui-btn cui-primary', onclick: () => select(null, 'new') }, '+ New'));
  }
  return h('div', { class: 'rv-board' }, ...cols.map(([stage, label]) => {
    const here = state.entries.filter((e) => e.stage === stage);
    const lenses = here.filter(isLens);
    const list = here.filter((e) => !isLens(e)).map(card);
    if (lenses.length) list.splice(here.findIndex(isLens), 0, lensesCard(lenses));
    if (stage === 'schedule') list.push(...state.audits.map(auditCard));
    return h('section', { class: 'rv-col', 'aria-label': label },
      h('h3', {}, label),
      list.length ? list : h('p', { class: 'muted rv-none' }, 'None'));
  }));
}

function card(e) {
  const sw = onSwitch(e);
  return h('div', { class: `rv-card${e.slug === state.selected ? ' on' : ''}${e.enabled ? '' : ' off'}`, role: 'button', tabindex: 0, 'aria-pressed': String(e.slug === state.selected),
    onclick: () => select(e.slug), onkeydown: (ev) => { if (ev.target === ev.currentTarget && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); select(e.slug); } } },
  h('div', { class: 'rv-card-top' }, h('span', { class: 'rv-card-name' }, e.name), sw),
  h('div', { class: 'rv-card-when' }, e.kit ? e.when : whenLine(e)),
  chips(e));
}

const isLens = (e) => e.kit && e.slug.startsWith('lens-');

/** The pre-ship review's lenses as one card, a switch a row, so nine of them don't bury the column. */
function lensesCard(lenses) {
  return h('div', { class: 'rv-card rv-lenses' },
    h('div', { class: 'rv-card-top' }, h('span', { class: 'rv-card-name' }, "The pre-ship review's lenses")),
    h('div', { class: 'rv-card-when' }, 'Each read when the diff has its kind of change'),
    h('ul', { class: 'rv-lens-list' }, lenses.map((e) => h('li', { class: `${e.slug === state.selected ? 'on' : ''}${e.enabled ? '' : ' off'}` },
      h('button', { type: 'button', class: 'rv-lens-name', 'aria-pressed': String(e.slug === state.selected), onclick: () => select(e.slug) }, e.name.replace(/^Lens: /, '')),
      onSwitch(e)))));
}

function chips(e) {
  return h('div', { class: 'rv-chips' },
    e.kind !== 'critic' ? h('span', { class: 'cui-chip', 'data-tone': 'neutral' }, e.kind) : null,
    e.trial ? h('span', { class: 'cui-chip', 'data-tone': 'warn', title: "On trial: it advises and blocks nothing until it's calibrated" }, 'trial') : null,
    e.gate === 'block' ? h('span', { class: 'cui-chip', 'data-tone': 'info', title: 'Its fail blocks the ship' }, 'blocks') : null,
    labelGiver()?.slug === e.slug ? h('span', { class: 'cui-chip', 'data-tone': 'info', title: "Gives the risk label that decides whether a ship waits for a person's go" }, 'risk label') : null,
    e.kit ? h('span', { class: 'cui-chip', 'data-tone': 'info', title: "The kit's own: its text stays in the kit, and this scheme switches it and adds to it" }, 'kit')
      : e.extends ? h('span', { class: 'cui-chip', 'data-tone': 'info', title: `On top of the kit's ${e.extends} starter, so kit fixes reach it` }, 'kit') : null,
    e.enabled ? null : h('span', { class: 'cui-chip', 'data-tone': 'neutral' }, 'off'));
}

/** A standard audit (kit/schedules/): its switch is its schedule's pause, so the page and Schedules never disagree. */
function auditCard(a) {
  const key = `audit:${a.slug}`;
  return h('div', { class: `rv-card${key === state.selected ? ' on' : ''}${a.on ? '' : ' off'}`, role: 'button', tabindex: 0, 'aria-pressed': String(key === state.selected),
    onclick: () => select(key), onkeydown: (ev) => { if (ev.target === ev.currentTarget && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); select(key); } } },
  h('div', { class: 'rv-card-top' }, h('span', { class: 'rv-card-name' }, a.name), auditSwitch(a)),
  h('div', { class: 'rv-card-when' }, a.when),
  auditChips(a));
}

const auditChips = (a) => h('div', { class: 'rv-chips' }, h('span', { class: 'cui-chip', 'data-tone': 'neutral' }, 'audit'),
  h('span', { class: 'cui-chip', 'data-tone': 'info', title: "One of the kit's standard audits" }, 'kit'), a.on ? null : h('span', { class: 'cui-chip', 'data-tone': 'neutral' }, 'off'));

function auditSwitch(a) {
  return h('button', { type: 'button', class: 'rules-switch', 'data-slug': `audit:${a.slug}`, role: 'switch', 'aria-checked': String(a.on), 'aria-label': `${a.name}: ${a.on ? 'on' : 'off'}`,
    onclick: (ev) => { ev.stopPropagation(); setAudit(a.slug, !a.on); } });
}

function setAudit(slug, on) {
  const s = state;
  const path = url(`audits/${slug}`);
  const redraw = () => { if (state === s && s.mode !== 'edit' && s.mode !== 'new') draw(); };
  const flip = (v) => { const a = s.audits.find((x) => x.slug === slug); if (a) a.on = v; redraw(); };
  optimistic({
    key: `reviews:${s.projectId}:audit:${slug}`,
    apply: () => flip(on),
    send: () => api(path, { method: 'POST', body: { enabled: on } }),
    undo: () => flip(!on),
    label: `turn ${on ? 'on' : 'off'} the ${s.audits.find((x) => x.slug === slug)?.name ?? slug}`,
  }).then((saved) => {
    const i = s.audits.findIndex((x) => x.slug === slug);
    if (i >= 0 && saved?.slug) s.audits[i] = saved;
    redraw();
  }, () => {});
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
  return h('button', { type: 'button', class: 'rules-switch', 'data-slug': e.slug, role: 'switch', 'aria-checked': String(e.enabled), 'aria-label': `${e.name}: ${e.enabled ? 'on' : 'off'}`,
    onclick: (ev) => { ev.stopPropagation(); setSwitch(e.slug, { enabled: !e.enabled }); } });
}

/** A switch saves at once and rolls back with a toast if the save fails (Cara 2026-11-08). */
function setSwitch(slug, patch) {
  // Bound to the scheme it started in: a Retry after moving to another scheme still saves this one's entry.
  const s = state;
  const path = url(slug);
  const mine = () => state === s;
  // An open edit or New form keeps what was typed: only the switch itself redraws then (the next draw shows the rest).
  const redraw = () => {
    if (!mine()) return;
    if (s.mode !== 'edit' && s.mode !== 'new') return draw();
    const e = s.entries.find((x) => x.slug === slug);
    for (const b of pageEl.querySelectorAll(`.rules-switch[data-slug="${CSS.escape(slug)}"]`)) b.setAttribute('aria-checked', String(!!e?.enabled));
  };
  let was;
  optimistic({
    key: `reviews:${s.projectId}:${slug}`,
    apply: () => {
      const e = s.entries.find((x) => x.slug === slug);
      if (!e) return;
      was = Object.fromEntries(Object.keys(patch).map((k) => [k, e[k]]));
      Object.assign(e, patch);
      redraw();
    },
    send: () => api(path, { method: 'PATCH', body: patch }),
    undo: () => {
      const e = s.entries.find((x) => x.slug === slug);
      if (e && was) Object.assign(e, was);
      redraw();
    },
    label: patch.enabled !== undefined ? `turn ${patch.enabled ? 'on' : 'off'} ${entry(slug)?.name ?? slug}` : patch.trial !== undefined ? 'change its trial' : `change ${entry(slug)?.name ?? slug}`,
  }).then((saved) => {
    const i = s.entries.findIndex((x) => x.slug === slug);
    if (i >= 0 && saved?.slug) s.entries[i] = saved;
    redraw();
  }, () => {});
}

function detail() {
  if (state.mode === 'new') return h('aside', { class: 'rv-detail' }, newForm());
  const a = audit(state.selected);
  if (a) return auditDetail(a);
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
    e.slug === 'pre-ship-review' ? preShipNote(e) : null,
    e.kit ? null : judging(e),
    e.kit ? section('What it does', h('p', {}, e.what)) : null,
    section('Reviews', h('p', {}, e.kit ? e.when : whenLine(e)), e.kit ? null : h('p', { class: 'muted rv-when' }, h('code', {}, `when: ${e.when}`))),
    e.kit ? section("This scheme's additions", e.body.trim() ? h('pre', { class: 'rv-added' }, e.body) : h('p', { class: 'muted' }, "None: it reads the kit's text alone. Edit by hand or describe a change to add to it."))
      : section('Context', contextItems.length ? h('ul', { class: 'rv-ctx' }, contextItems) : h('p', { class: 'muted' }, 'Only the work itself and its rubric.')),
    e.kit ? null : section('With the others', h('p', { class: 'muted' }, 'Runs on its own: no order, hand-off or panel yet.')),
    section('Record', e.calibrated ? h('p', {}, `Calibrated ${e.calibrated}`) : null,
      h('p', { class: 'muted' }, 'No verdicts recorded yet. Once minions record them, the last runs show here.')),
    h('div', { class: 'rv-actions' },
      h('button', { type: 'button', class: 'cui-btn', onclick: () => select(e.slug, 'edit') }, 'Edit by hand'),
      h('button', { type: 'button', class: 'cui-btn', 'aria-pressed': String(state.mode === 'history'), onclick: () => select(e.slug, state.mode === 'history' ? 'view' : 'history') }, 'History')),
    state.mode === 'history' ? history(e) : null,
    h('p', { class: 'muted rv-ver' }, `Version ${e.version}, saved by ${e.updated_by} ${ago(e.updated_at)}`));
}

/** Beside the pre-ship review's switch, before anyone flips it (Q10): what off means for this scheme's ships. */
function preShipNote(e) {
  const giver = state.entries.find((x) => x.enabled && !x.trial && x.gives_label);
  const off = giver ? `the ${giver.name} gives the risk label instead.` : "no change gets a risk label, so every ship in this scheme waits for a person's go.";
  return h('p', { class: `rv-warn${e.enabled ? '' : ' is-off'}`, role: 'note' }, e.enabled ? `Turned off, ${off}` : `It's off: ${off}`);
}

/** Trial, Block or Advise, and the risk label: an entry on trial only advises until it's calibrated or marked good (Q12). */
function judging(e) {
  const lock = e.trial ? "On trial: it only advises until it's calibrated or marked good" : undefined;
  const gate = (v, label) => h('button', { type: 'button', 'aria-pressed': String((e.gate ?? 'advise') === v), disabled: e.trial, title: lock,
    onclick: () => { if ((e.gate ?? 'advise') !== v) setSwitch(e.slug, { gate: v === 'block' ? 'block' : null }); } }, label);
  return h('div', { class: 'rv-judging' },
    h('div', { class: 'rv-trial' },
      e.trial ? h('span', { class: 'muted' }, "On trial: it advises and blocks nothing until it's calibrated.") : h('span', { class: 'muted' }, e.calibrated ? `Off trial: calibrated ${e.calibrated}.` : 'Off trial.'),
      h('button', { type: 'button', class: 'cui-btn cui-small', onclick: () => setSwitch(e.slug, { trial: !e.trial }) }, e.trial ? 'Mark it good' : 'Put on trial')),
    h('div', { class: 'rv-seg', role: 'group', 'aria-label': 'When it fails' }, gate('block', 'Block the ship'), gate('advise', 'Advise')),
    h('label', { class: 'rv-check', title: lock }, h('input', { type: 'checkbox', checked: e.gives_label, disabled: e.trial, onchange: (ev) => setSwitch(e.slug, { gives_label: ev.target.checked }) }),
      h('span', {}, 'Gives the risk label when the pre-ship review is off')));
}

/** A standard audit's detail: its switch, when it runs and what it's for. */
function auditDetail(a) {
  return h('aside', { class: 'rv-detail' },
    h('div', { class: 'rv-detail-head' },
      h('button', { type: 'button', class: 'close-view narrow-only', 'aria-label': 'Back to the columns', title: 'Back', onclick: () => { state.selected = null; draw(); pageEl.scrollIntoView({ block: 'start' }); } }, icon('back')),
      h('h3', {}, a.name), auditChips(a)),
    h('div', { class: 'rv-switch-row' }, auditSwitch(a), h('span', {}, a.on ? 'On' : 'Off')),
    h('section', { class: 'rv-sec' }, h('h4', {}, 'Runs'), h('p', {}, `${a.when}, as one of this scheme's scheduled minions (◷ beside Minions). Its switch here is that schedule's pause.`)),
    h('section', { class: 'rv-sec' }, h('h4', {}, 'For a scheme where'), h('p', {}, a.applies)));
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
  if (e.kit) return kitForm(e);
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
      const saved = await api(url(e.slug), { method: 'PATCH', body: { name: name.value, kind: kind.value, when: when.value.trim() || 'ask', stage: stage.value, model: model.value.trim() || null, effort: effort.value || null, body: body.value, note: note.value, version: entry(e.slug)?.version ?? e.version } });
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
    field('When it runs', when, 'Like diff: public/**, schedule: monthly, or ask. Parts join with |'),
    h('div', { class: 'rv-pair' }, field('Model', model), field('Effort', effort)),
    field(e.extends ? `Its own lines, under the kit's ${e.extends}` : 'The rubric', body, 'Markdown with ## sections: what it checks, what passes, what fails.'),
    field('What changed', note),
    err,
    h('div', { class: 'rv-actions' }, save, h('button', { type: 'button', class: 'cui-btn cui-ghost', onclick: () => select(e.slug) }, 'Cancel')));
}

/** A kit entry's edit: only this scheme's additions, read with the kit's text (which stays in the kit). */
function kitForm(e) {
  const body = h('textarea', { class: 'cui-input rv-bodytext', rows: 12, spellcheck: false }, e.body);
  const note = h('input', { class: 'cui-input', placeholder: 'Edited by hand' });
  const err = h('p', { class: 'error', hidden: true });
  const save = h('button', { type: 'submit', class: 'cui-btn cui-primary' }, 'Save');
  const submit = async (ev) => {
    ev.preventDefault();
    save.disabled = true;
    err.hidden = true;
    try {
      const saved = await api(url(e.slug), { method: 'PATCH', body: { body: body.value, note: note.value, version: entry(e.slug)?.version ?? e.version } });
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
    h('p', { class: 'muted' }, e.what),
    field("This scheme's additions", body, "Read with the kit's own text and handed to its Grunt: what to look for here, what to let pass."),
    field('What changed', note),
    err,
    h('div', { class: 'rv-actions' }, save, h('button', { type: 'button', class: 'cui-btn cui-ghost', onclick: () => select(e.slug) }, 'Cancel')));
}

/**
 * Describe a change (Q11): an agent on the asker's own Claude login reads the set and proposes new text for some
 * entries; each shows as before and after. Apply is an ordinary save (a version History can undo); Dismiss drops it.
 */
function describeBox() {
  const ask = state.ask ?? (state.ask = { text: '', busy: false, note: '', proposals: [], applied: [] });
  const input = h('input', { class: 'cui-input', placeholder: 'Describe a change, like "make the finding checker stricter on migrations"', value: ask.text, maxlength: 2000, 'aria-label': 'Describe a change',
    oninput: (ev) => { ask.text = ev.target.value; } });
  const go = h('button', { type: 'submit', class: 'cui-btn cui-primary', disabled: ask.busy }, ask.busy ? 'Asking…' : 'Ask');
  return h('section', { class: 'rv-ask', 'aria-label': 'Describe a change' },
    h('form', { class: 'rv-ask-row', onsubmit: (ev) => { ev.preventDefault(); describe(ask); } }, input, go),
    ask.busy ? h('p', { class: 'muted rv-ask-note' }, 'The agent is reading the set on your Claude plan. This takes about a minute.') : null,
    ask.note ? h('p', { class: 'muted rv-ask-note' }, ask.note) : null,
    ...ask.applied.map((m) => h('p', { class: 'rv-applied' }, m)),
    ...ask.proposals.map((p) => proposal(ask, p)));
}

async function describe(ask) {
  const text = ask.text.trim();
  if (!text || ask.busy) return;
  const s = state;
  Object.assign(ask, { busy: true, note: '', proposals: [], applied: [] });
  draw();
  try {
    const r = await api(url('describe'), { method: 'POST', body: { text } });
    Object.assign(ask, { note: r.note || (r.proposals.length ? '' : 'No change proposed.'), proposals: r.proposals.map((p) => ({ ...p, ask: text })) });
  } catch (err) {
    ask.note = `Couldn't ask: ${err.message}`;
  }
  ask.busy = false;
  if (state === s) draw();
}

function proposal(ask, p) {
  const row = (op, text) => h('div', { class: op === '+' ? 'add' : op === '-' ? 'del' : 'same' }, `${op === ' ' ? '\u00a0' : op} ${text}`);
  const runs = collapseRuns(diffLines(p.before, p.after)).map((r) => r.gap
    ? h('details', { class: 'gap' }, h('summary', {}, `${r.gap.length} unchanged line${r.gap.length === 1 ? '' : 's'}`), ...r.gap.map((o) => row(' ', o.text)))
    : row(r.op, r.text));
  const drop = () => { ask.proposals = ask.proposals.filter((x) => x !== p); draw(); };
  const apply = async (ev) => {
    const b = ev.currentTarget;
    b.disabled = true;
    const s = state; // a scheme switch during the save leaves the new scheme's entries alone
    try {
      const saved = await api(url(p.slug), { method: 'PATCH', body: { body: p.after, version: p.version, note: `Described: ${p.ask}`.slice(0, 200) } });
      const i = s.entries?.findIndex((x) => x.slug === p.slug) ?? -1;
      if (i >= 0) s.entries[i] = saved;
      ask.applied.push(`Applied. Version ${saved.version} of ${saved.name}; History can undo it.`);
      ask.proposals = ask.proposals.filter((x) => x !== p);
      if (state === s) draw();
    } catch (err) {
      toast(`Couldn't apply it: ${err.message}`);
      b.disabled = false;
    }
  };
  return h('div', { class: 'rv-proposal' },
    h('div', {}, h('b', {}, p.name), p.why ? `: ${p.why}` : ': proposed change'),
    h('div', { class: 'instructions-diff rev-diff' }, ...runs),
    h('div', { class: 'rv-actions' }, h('button', { type: 'button', class: 'cui-btn cui-primary cui-small', onclick: apply }, 'Apply'),
      h('button', { type: 'button', class: 'cui-btn cui-small', onclick: drop }, 'Dismiss')));
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
