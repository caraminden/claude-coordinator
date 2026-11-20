// A scheme's Reviewers and critics page (Build 4, #1051): its review set from the store (src/review-set.ts), in
// columns by when each one runs (layout take A, Josh 2026-11-19). A card's switch saves at once; the detail shows what
// it reviews, its context, and Edit by hand and History. Every save is a new version; New starts on trial (Q12).
// Phase 2 (#1052): the kit's own reviewers and audits are on it too, switched per scheme; Block or Advise is locked
// while an entry is on trial; and a describe box asks an agent for edits, shown as before and after with Apply.
// Phase 3 (#1054): run order ("↓ then"), panels as one dashed box with their referee, hand-offs on a fail, each entry's
// last runs as dots with its first-round pass rate, and the verdicts minions recorded (read-only; Edit by hand removes).
import { ago, api, h, icon, view } from './base.js';
import { collapseRuns, diffLines } from './plan-diff.js';
import { optimistic } from './ui/optimistic.js';
import { markdownElement } from './ui/markdown.js';
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
      h('a', { class: 'muted small', href: `#/p/${view.projectId}/skills` }, 'Skills'),
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
    // A teacher runs only when a critic hands it work (#1089): it hangs under those critics, not in a column.
    const list = columnUnits(state.entries.filter((e) => e.stage === stage && e.kind !== 'teacher'));
    if (stage === 'work') list.push(...state.entries.filter((t) => t.kind === 'teacher' && !handsTo(t).length).map(looseTeacher));
    if (stage === 'schedule') list.push(...state.audits.map(auditCard));
    return h('section', { class: 'rv-col', 'aria-label': label },
      h('h3', {}, label),
      list.length ? list : h('p', { class: 'muted rv-none' }, 'None'));
  }));
}

/**
 * A column in run order: the lenses as one card, a panel as one box, and "↓ then" between two of the scheme's own that
 * run, as the turn's run order says (orderLine in src/review-set.ts). The kit's own keep their own flow.
 */
function columnUnits(here) {
  const out = [];
  const seen = new Set();
  for (const e of here) {
    const key = isLens(e) ? 'lens' : e.panel && !e.kit ? `panel:${e.panel}` : null;
    if (key && seen.has(key)) continue;
    // A panel sits where its first member that's on runs (orderLine), not at a switched-off one above it.
    if (key !== 'lens' && key && !e.enabled && here.some((x) => x.panel === e.panel && !x.kit && x.enabled)) continue;
    if (key) seen.add(key);
    if (key === 'lens') out.push({ node: lensesCard(here.filter(isLens)) });
    else if (key) {
      const members = here.filter((x) => x.panel === e.panel && !x.kit);
      out.push({ node: panelBox(e.panel, members), runs: members.some((x) => x.enabled) });
    } else out.push({ node: withTeachers(e), runs: !e.kit && e.enabled });
  }
  return out.flatMap((u, i) => i && u.runs && out[i - 1].runs ? [h('div', { class: 'rv-then', 'aria-hidden': 'true' }, '↓ then'), u.node] : [u.node]);
}

/** A panel (Q7): its judges look at the same work at once and its referee merges their verdicts into one. */
function panelBox(name, members) {
  const judges = members.filter((x) => x.kind !== 'referee');
  const refs = members.filter((x) => x.kind === 'referee');
  const on = judges.filter((x) => x.enabled).length;
  const ref = refs.some((x) => x.enabled);
  return h('div', { class: 'rv-panel', role: 'group', 'aria-label': `Panel ${name}` },
    h('div', { class: 'rv-panel-head' }, h('b', {}, name), h('span', { class: 'muted' }, ref ? ': judge together, referee merges' : ': judge together')),
    ...judges.map(withTeachers), ...refs.map(card),
    ref ? h('p', { class: 'muted rv-panel-cost' }, `${on} judge${on === 1 ? '' : 's'} + referee: ${on + 1} model calls a run`)
      : h('p', { class: 'rv-warn rv-panel-cost', role: 'note' }, `No referee on: each judge's verdict stands on its own (${on} model call${on === 1 ? '' : 's'} a run). Add a referee to the panel to merge them.`));
}

/** Its last runs, oldest first: green pass, red fail, amber where a person disagreed, grey where it asked a person. */
function dots(runs) {
  return h('span', { class: 'rv-dots', role: 'img', 'aria-label': `Last ${runs.length} runs: ${runs.map((r) => r.disagreed ? 'disagreed' : r.verdict).join(', ')}` },
    runs.map((r) => h('i', { class: `is-${r.disagreed ? 'disagreed' : r.verdict}`, title: `${r.minion}, round ${r.round}: ${r.verdict}${r.disagreed ? ', and a person disagreed' : ''} · ${pacific(r.at)}` })));
}

function card(e) {
  const sw = onSwitch(e);
  return h('div', { class: `rv-card${e.slug === state.selected ? ' on' : ''}${e.enabled ? '' : ' off'}`, role: 'button', tabindex: 0, 'aria-pressed': String(e.slug === state.selected),
    onclick: () => select(e.slug), onkeydown: (ev) => { if (ev.target === ev.currentTarget && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); select(e.slug); } } },
  h('div', { class: 'rv-card-top' }, h('span', { class: 'rv-card-name' }, e.name), sw),
  h('div', { class: 'rv-card-when' }, e.kit ? e.when : whenLine(e)),
  chips(e),
  e.runs?.length ? h('div', { class: 'rv-card-rec' }, dots(e.runs), e.rate === null ? null : h('span', { class: 'muted' }, `${e.rate}%`)) : null);
}

const isLens = (e) => e.kit && e.slug.startsWith('lens-');

/** The teachers an entry hands its stubborn fails to, with after how many fails: its hand-offs, or a critic's default (professor after 2). */
function teachersOf(e) {
  const steps = e.on_fail ?? (e.kind === 'critic' ? [{ after: 2, to: 'professor' }] : []);
  return steps.map((st) => ({ after: st.after, t: entry(st.to) })).filter((x) => x.t?.kind === 'teacher');
}
/** The entries that hand off to a teacher, with after how many fails. */
const handsTo = (t) => state.entries.flatMap((e) => teachersOf(e).filter((x) => x.t.slug === t.slug).map((x) => ({ e, after: x.after })));
/** "fix held 3 of 4", or that it has none yet: a teacher's record is whether the critic passed the work after its fix. */
const heldText = (t) => (t.firsts ? `fix held ${t.passes} of ${t.firsts}` : 'no fixes yet');

/** A card with a strip under it per teacher it hands off to, so the chain reads top to bottom (take A, #1089). */
function withTeachers(e) {
  const ts = teachersOf(e);
  if (!ts.length) return card(e);
  return h('div', { class: 'rv-chain' }, card(e), ...ts.map(({ t, after }) => h('button', {
    type: 'button', class: `rv-teach${t.slug === state.selected ? ' on' : ''}${t.enabled ? '' : ' off'}`, 'aria-pressed': String(t.slug === state.selected),
    title: `${e.name} hands an item to ${t.name} after ${after} failed round${after === 1 ? '' : 's'}${t.enabled ? '' : ` (${t.name} is off)`}`, onclick: () => select(t.slug) },
  h('span', { class: 'rv-teach-after' }, `↳ after ${after} fail${after === 1 ? '' : 's'}`),
  h('span', { class: 'rv-teach-name' }, t.name),
  h('span', { class: 'rv-teach-rec' }, t.runs?.length ? dots(t.runs) : null, h('span', { class: 'muted' }, t.enabled ? heldText(t) : 'off')))));
}

/** A teacher no critic here hands off to: at the foot of While working, quiet, still openable. */
function looseTeacher(t) {
  return h('button', { type: 'button', class: `rv-teach rv-teach-loose${t.slug === state.selected ? ' on' : ''}${t.enabled ? '' : ' off'}`, 'aria-pressed': String(t.slug === state.selected), onclick: () => select(t.slug) },
    h('span', { class: 'rv-teach-name' }, t.name),
    h('span', { class: 'muted' }, `${t.kit ? "The kit's teacher" : 'A teacher'}: no critic here hands off to it${t.enabled ? '' : ', and it is off'}. ${heldText(t)}.`));
}

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
    e.kind !== 'critic' ? h('span', { class: 'cui-chip', 'data-tone': e.kind === 'teacher' ? 'violet' : 'neutral' }, e.kind) : null,
    e.trial ? h('span', { class: 'cui-chip', 'data-tone': 'warn', title: "On trial: it advises and blocks nothing until it's calibrated" }, 'trial') : null,
    e.gate === 'block' ? h('span', { class: 'cui-chip', 'data-tone': 'info', title: 'Its fail blocks the ship' }, 'blocks') : null,
    e.stuck ? h('span', { class: 'cui-chip', 'data-tone': 'warn', title: `Its last ${e.firsts} first rounds all ${e.stuck === 'pass' ? 'passed: it may be too easy' : 'failed: it may be too strict, or the work keeps missing it'}` }, e.stuck === 'pass' ? 'always passes' : 'always fails') : null,
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
    ctx.verdicts !== false ? h('li', {}, `Your past verdicts on its work${e.verdicts?.length ? ` (${e.verdicts.length})` : ''}`) : null,
    ctx.requester ? h('li', {}, "The requester's own words") : null,
  ].filter(Boolean);
  return h('aside', { class: 'rv-detail' },
    h('div', { class: 'rv-detail-head' },
      h('button', { type: 'button', class: 'close-view narrow-only', 'aria-label': 'Back to the columns', title: 'Back', onclick: () => { state.selected = null; draw(); pageEl.scrollIntoView({ block: 'start' }); } }, icon('back')),
      h('h3', {}, e.name), chips(e)),
    h('div', { class: 'rv-switch-row' }, sw, h('span', {}, e.enabled ? 'On' : 'Off')),
    e.slug === 'pre-ship-review' ? preShipNote(e) : null,
    e.kit || e.kind === 'teacher' ? null : judging(e),
    e.kit ? section('What it does', h('p', {}, e.what)) : null,
    e.kind === 'teacher' ? section('When it runs', h('p', {}, e.kit ? e.when : 'When a critic hands it a stubborn fail'), handOffs(e))
      : section('Reviews', h('p', {}, e.kit ? e.when : whenLine(e)), e.kit ? null : h('p', { class: 'muted rv-when' }, h('code', {}, `when: ${e.when}`))),
    e.agent ? section('Its text', h('p', { class: 'muted' }, 'From ', h('code', {}, e.agent.path), " in the kit: every scheme's minions read the same."),
      h('details', { class: 'rv-agent' }, h('summary', {}, 'Show its text'), markdownElement(e.agent.text, { headingBase: 4 }))) : null,
    e.kit ? section("This scheme's additions", e.body.trim() ? h('pre', { class: 'rv-added' }, e.body) : h('p', { class: 'muted' }, "None: it reads the kit's text alone. Edit by hand or describe a change to add to it."))
      : section('Context', contextItems.length ? h('ul', { class: 'rv-ctx' }, contextItems) : h('p', { class: 'muted' }, 'Only the work itself and its rubric.')),
    e.kit ? null : section('With the others', ...withOthers(e)),
    section('Record', e.calibrated ? h('p', {}, `Calibrated ${e.calibrated}`) : null, ...record(e)),
    e.verdicts?.length ? section('Verdicts', verdictList(e, false)) : null,
    h('div', { class: 'rv-actions' },
      h('button', { type: 'button', class: 'cui-btn', onclick: () => select(e.slug, 'edit') }, 'Edit by hand'),
      h('button', { type: 'button', class: 'cui-btn', 'aria-pressed': String(state.mode === 'history'), onclick: () => select(e.slug, state.mode === 'history' ? 'view' : 'history') }, 'History')),
    state.mode === 'history' ? history(e) : null,
    h('p', { class: 'muted rv-ver' }, `Version ${e.version}, saved by ${e.updated_by} ${ago(e.updated_at)}`));
}

/** Who hands work to a teacher, and after how many fails; none says how to wire one. */
function handOffs(t) {
  const from = handsTo(t);
  if (!from.length) return h('p', { class: 'muted' }, "No critic here hands off to it yet. A critic's hand-offs (Edit by hand on the critic) name it.");
  return h('ul', { class: 'rv-ctx' }, from.map(({ e, after }) => h('li', {}, h('button', { type: 'button', class: 'rv-link', onclick: () => select(e.slug) }, e.name), ` after ${after} failed round${after === 1 ? '' : 's'}`)));
}

/** Its runs, the first-round pass rate, and a warning when it always passes or always fails (Q4). */
function record(e) {
  if (e.kind === 'teacher') {
    if (!e.runs?.length) return [h('p', { class: 'muted' }, "No fixes recorded yet. After each fix it gives, the critic's next round shows here as a dot: green when the fix held, red when the work failed again.")];
    return [h('p', { class: 'rv-rec' }, dots(e.runs), h('span', {}, ` ${heldText(e)} `), h('span', { class: 'muted' }, "the critic's next round, after its fix"))];
  }
  if (!e.runs?.length) return [h('p', { class: 'muted' }, 'No runs recorded yet. Each round a minion runs it shows here as a dot.')];
  return [
    h('p', { class: 'rv-rec' }, dots(e.runs), e.rate === null ? null : h('span', {}, ` ${e.rate}% `), h('span', { class: 'muted' }, e.rate === null ? ` last ${e.runs.length} runs` : `first-round pass, last ${e.firsts} first rounds`)),
    e.stuck ? h('p', { class: 'rv-warn', role: 'note' }, e.stuck === 'pass' ? `Its last ${e.firsts} first rounds all passed. A critic that never fails may be too easy: calibrate it, or tighten what fails.` : `Its last ${e.firsts} first rounds all failed. It may be too strict, or the work keeps missing the same thing: read its findings.`) : null,
  ].filter(Boolean);
}

/** What people said when they disagreed with it (Q13): only a minion records one; Edit by hand can remove one. */
function verdictList(e, removable) {
  return h('ul', { class: 'rv-verdicts' }, e.verdicts.map((v) => h('li', {},
    h('q', {}, v.words),
    h('span', { class: 'muted' }, ` ${v.person}, `, h('time', { title: pacific(v.at) }, ago(v.at)), `, on ${v.minion}`),
    removable ? h('button', { type: 'button', class: 'cui-btn cui-small cui-ghost', onclick: () => removeVerdict(e, v) }, 'Remove') : null)));
}

async function removeVerdict(e, v) {
  const s = state;
  try {
    await api(`${url(e.slug)}/verdicts/${v.id}`, { method: 'DELETE' });
    const x = s.entries.find((y) => y.slug === e.slug);
    if (x) x.verdicts = x.verdicts.filter((y) => y.id !== v.id);
    toast('Removed: its next runs no longer read it');
    if (state === s) draw();
  } catch (err) {
    toast(`Couldn't remove it: ${err.message}`);
  }
}

/** Order, panel and hand-offs (Q7): where it runs in its column, who it judges with, and where a fail goes. */
function withOthers(e) {
  const col = state.entries.filter((x) => x.stage === e.stage);
  const i = col.findIndex((x) => x.slug === e.slug);
  const label = COLUMNS.find(([v]) => v === e.stage)?.[1] ?? e.stage;
  const moveBtn = (dir, text, at) => h('button', { type: 'button', class: 'cui-btn cui-small', disabled: !at, 'aria-label': `Run ${dir === 'up' ? 'earlier' : 'later'}`, onclick: () => move(e, dir) }, text);
  const names = [...new Set(state.entries.filter((x) => x.panel && !x.kit).map((x) => x.panel))];
  const panel = h('input', { class: 'cui-input', value: e.panel ?? '', placeholder: 'None', maxlength: 40, list: 'rv-panels', 'aria-label': 'Panel',
    onchange: (ev) => { const v = ev.target.value.trim() || null; if (v !== (e.panel ?? null)) setSwitch(e.slug, { panel: v }); } });
  return [
    h('div', { class: 'rv-order' }, h('span', {}, `Runs ${i + 1} of ${col.length} ${label.toLowerCase()}`), moveBtn('up', '↑', i > 0), moveBtn('down', '↓', i < col.length - 1)),
    h('label', { class: 'rv-field' }, h('span', { class: 'rv-label' }, 'Panel'), panel, h('datalist', { id: 'rv-panels' }, names.map((n) => h('option', { value: n }))),
      h('span', { class: 'muted rv-hint' }, e.kind === 'referee' ? "As the panel's referee it merges the judges' verdicts into one." : 'Entries with the same panel judge the same work at once, and its referee merges their verdicts.')),
    onFailEditor(e),
  ];
}

function move(e, dir) {
  const s = state;
  const col = s.entries.filter((x) => x.stage === e.stage);
  const i = col.findIndex((x) => x.slug === e.slug);
  const other = col[dir === 'up' ? i - 1 : i + 1];
  if (!other) return;
  const swap = () => {
    const a = s.entries.indexOf(e), b = s.entries.indexOf(other);
    if (a < 0 || b < 0) return;
    [s.entries[a], s.entries[b]] = [s.entries[b], s.entries[a]];
    if (state === s) draw();
  };
  optimistic({
    key: `reviews:${s.projectId}:move:${e.slug}`,
    apply: swap,
    send: () => api(`${url(e.slug)}/move`, { method: 'POST', body: { dir } }),
    undo: swap,
    label: `move ${e.name}`,
  }).then(() => load(), () => {});
}

/** Hand off on a fail: after n failed rounds the work goes to the professor, a person or another entry. */
function onFailEditor(e) {
  const fallback = e.kind === 'critic' ? 'professor after 2 fails, person after 3' : null;
  const steps = (e.on_fail ?? []).map((x) => ({ ...x }));
  const targets = [['professor', 'the professor'], ['person', 'a person'], ...state.entries.filter((x) => x.slug !== e.slug && !x.kit).map((x) => [x.slug, x.name])];
  const box = h('div', { class: 'rv-onfail' });
  const save = h('button', { type: 'button', class: 'cui-btn cui-small cui-primary', hidden: true, onclick: () => setSwitch(e.slug, { on_fail: steps.length ? steps : null }) }, 'Save hand-offs');
  const changed = () => { save.hidden = JSON.stringify(steps) === JSON.stringify(e.on_fail ?? []); };
  const rows = () => box.replaceChildren(
    ...steps.map((st, k) => h('div', { class: 'rv-onfail-row' },
      h('span', {}, 'After'),
      h('input', { class: 'cui-input', type: 'number', min: 1, max: 10, value: st.after, 'aria-label': 'Failed rounds', oninput: (ev) => { st.after = Number(ev.target.value); changed(); } }),
      h('span', {}, 'fails, to'),
      h('select', { class: 'cui-input', 'aria-label': 'Hand it to', onchange: (ev) => { st.to = ev.target.value; changed(); } }, targets.map(([v, l]) => h('option', { value: v, selected: v === st.to }, l))),
      h('button', { type: 'button', class: 'cui-btn cui-small cui-ghost', 'aria-label': 'Remove this step', onclick: () => { steps.splice(k, 1); rows(); changed(); } }, '×'))),
    h('div', { class: 'rv-actions' },
      steps.length < 4 ? h('button', { type: 'button', class: 'cui-btn cui-small', onclick: () => { const last = steps.at(-1); steps.push({ after: Math.min(10, (last?.after ?? 1) + 1), to: last ? 'person' : 'professor' }); rows(); changed(); } }, '+ Step') : null,
      save));
  rows();
  return h('div', { class: 'rv-field' }, h('span', { class: 'rv-label' }, 'Hand off on a fail'),
    h('span', { class: 'muted rv-hint' }, e.on_fail?.length ? 'Each step takes over from the one before.' : fallback ? `None set: as every critic, ${fallback}.` : 'None set: its fails go back to the author.'),
    box);
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
    h('section', { class: 'rv-sec' }, h('h4', {}, 'Runs'), h('p', {}, `${a.when}, as one of this scheme's scheduled minions (Orders → Schedules). Its switch here is that schedule's pause.`)),
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
  const verdicts = h('input', { type: 'checkbox', checked: e.context?.verdicts !== false });
  const requester = h('input', { type: 'checkbox', checked: !!e.context?.requester });
  const err = h('p', { class: 'error', hidden: true });
  const save = h('button', { type: 'submit', class: 'cui-btn cui-primary' }, 'Save');
  const submit = async (ev) => {
    ev.preventDefault();
    save.disabled = true;
    err.hidden = true;
    try {
      const context = { ...e.context, verdicts: verdicts.checked, requester: requester.checked };
      const saved = await api(url(e.slug), { method: 'PATCH', body: { context, name: name.value, kind: kind.value, when: when.value.trim() || 'ask', stage: stage.value, model: model.value.trim() || null, effort: effort.value || null, body: body.value, note: note.value, version: entry(e.slug)?.version ?? e.version } });
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
    h('fieldset', { class: 'rv-ctx-switches' }, h('legend', { class: 'rv-label' }, 'Its context also has'),
      h('label', { class: 'rv-check' }, verdicts, h('span', {}, 'Your verdicts: what people said when they disagreed with it')),
      h('label', { class: 'rv-check' }, requester, h('span', {}, "The requester's words: the minion's first message"))),
    e.verdicts?.length ? h('div', { class: 'rv-field' }, h('span', { class: 'rv-label' }, 'Recorded verdicts'), verdictList(e, true)) : null,
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
    e.verdicts?.length ? h('div', { class: 'rv-field' }, h('span', { class: 'rv-label' }, 'Recorded verdicts'), verdictList(e, true)) : null,
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
  // Settings (phase 3: gate, panel, hand-offs) diff as lines above the body's.
  const sets = (o) => Object.entries(o ?? {}).map(([k, v]) => `${k}: ${k === 'on_fail' ? (v?.length ? v.map((x) => `${x.to} after ${x.after}`).join(', ') : 'the default') : v ?? 'none'}`).join('\n');
  const runs = collapseRuns(diffLines(`${sets(p.settings_before)}${p.settings ? '\n\n' : ''}${p.before}`, `${sets(p.settings)}${p.settings ? '\n\n' : ''}${p.after}`)).map((r) => r.gap
    ? h('details', { class: 'gap' }, h('summary', {}, `${r.gap.length} unchanged line${r.gap.length === 1 ? '' : 's'}`), ...r.gap.map((o) => row(' ', o.text)))
    : row(r.op, r.text));
  const drop = () => { ask.proposals = ask.proposals.filter((x) => x !== p); draw(); };
  const apply = async (ev) => {
    const b = ev.currentTarget;
    b.disabled = true;
    const s = state; // a scheme switch during the save leaves the new scheme's entries alone
    try {
      const saved = await api(url(p.slug), { method: 'PATCH', body: { body: p.after, ...p.settings, version: p.version, note: `Described: ${p.ask}`.slice(0, 200) } });
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
