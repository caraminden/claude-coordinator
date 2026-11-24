// A scheme's Reviewers and critics page (Build 4, #1051): its review set from the store (src/review-set.ts), in
// columns by when each one runs (layout take A, Josh 2026-11-19). A card's switch saves at once; the detail shows what
// it reviews, its context, and Edit by hand and History. Every save is a new version; New starts on trial (Q12).
// Phase 2 (#1052): the kit's own reviewers and audits are on it too, switched per scheme; Block or Advise is locked
// while an entry is on trial; and a describe box asks an agent for edits, shown as before and after with Apply.
// Phase 3 (#1054): run order ("↓ then"), panels as one dashed box with their referee, hand-offs on a fail, each entry's
// last runs as dots with its first-round pass rate, and the verdicts minions recorded (read-only; Edit by hand removes).
// At a glance (#1094, Josh's picks 2026-11-19): a headline you read, ghost cards for folders nobody watches, the lenses
// as one row, the scheme's own repo files in a group, and an Every scheme tab with a row per scheme.
import { ago, api, h, icon, view, pacificStamp } from './base.js';
import { meter, schemeTag, toneChip } from './look.js';
import { collapseRuns, diffLines } from './plan-diff.js';
import { optimistic } from './ui/optimistic.js';
import { markdownElement } from './ui/markdown.js';
import { toast } from './ui/status.js';
import { loadingLine } from './ui/state.js';

const COLUMNS = [
  ['work', 'While working'],
  ['ship', 'Before ship'],
  ['ask', 'On ask'],
  ['schedule', 'On a schedule'],
];
const KINDS = ['critic', 'reviewer', 'checker', 'referee', 'teacher', 'audit'];
const pacific = pacificStamp;

let pageEl = null;
let state = null; // { projectId, entries, starters, audits, glance, selected, mode: 'view'|'edit'|'history'|'new', versions, ask, lenses, newWhen }
// The tab ('scheme' or 'all') and the Every scheme rows outlive a scheme switch: the table is the same on every scheme.
const every = { tab: 'scheme', rows: null, error: null };

const url = (slug = '') => `api/projects/${state.projectId}/reviews${slug ? `/${encodeURIComponent(slug)}` : ''}`;
const entry = (slug) => state.entries.find((e) => e.slug === slug);
// An audit's key on the page: audits are schedules, not entries, so their slugs live apart.
const audit = (key) => (key?.startsWith('audit:') ? state.audits.find((a) => `audit:${a.slug}` === key) : undefined);

/** Who gives the risk label (as labelGiver in src/review-set.ts): the pre-ship review, else an enabled, calibrated entry marked to. */
function labelGiver() {
  const pre = entry('pre-ship-review');
  if (!pre?.kit || pre.enabled) return pre?.kit ? pre : { name: 'Pre-ship review' };
  return state.entries.find((e) => e.enabled && !e.trial && e.gives_label) ?? null;
}

export function reviewsPage() {
  const projectId = view.projectId;
  if (state?.projectId !== projectId) state = { projectId, entries: null, starters: [], audits: [], glance: null, selected: null, mode: 'view', versions: null, ask: null, lenses: false, newWhen: '' };
  pageEl = h('section', {
    class: 'reviews-main',
    onkeydown: (e) => {
      if (e.key === 'Escape' && state.mode === 'view') closePage();
    },
  });
  draw();
  load();
  if (every.tab === 'all') loadEvery();
  return pageEl;
}

function closePage() {
  location.hash = `#/p/${view.projectId}/settings`;
}

async function load() {
  const at = state;
  try {
    const { entries, starters, audits, glance } = await api(url());
    if (state !== at) return;
    Object.assign(state, { entries, starters, audits: audits ?? [], glance: glance ?? null });
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
  if (every.tab === 'all') loadEvery();
  if (state.mode === 'history') loadVersions();
}

function draw() {
  if (!pageEl) return;
  const close = (cls, name) => h('button', { type: 'button', class: `close-view ${cls}`, 'aria-label': 'Close', title: 'Close', onclick: closePage }, icon(name));
  const head = h(
    'div',
    { class: 'ticket-head rv-head' },
    h(
      'div',
      { class: 'row' },
      close('narrow-only', 'back'),
      h('h2', {}, h('span', { class: 'rv-title-long' }, 'Reviewers and critics'), h('span', { class: 'rv-title-short' }, 'Reviewers'), h('span', { class: 'muted rv-scheme' }, ` · ${view.project?.name ?? ''}`)),
      h('span', { class: 'spacer' }),
      h('a', { class: 'muted small rv-skills-link', href: `#/p/${view.projectId}/skills` }, 'Skills'),
      every.tab === 'scheme' ? h('button', { type: 'button', class: 'cui-btn rv-new', onclick: () => select(null, 'new') }, '+ New') : null,
      close('wide-only', 'close'),
    ),
    h(
      'div',
      { class: 'rv-seg rv-tabs', role: 'group', 'aria-label': 'Which schemes' },
      ...[
        ['scheme', 'This scheme'],
        ['all', 'Every scheme'],
      ].map(([k, label]) => h('button', { type: 'button', 'aria-pressed': String(every.tab === k), onclick: () => setTab(k) }, label)),
    ),
  );
  if (every.tab === 'all') return pageEl.replaceChildren(head, everyTable());
  const body = state.error ? [h('p', { class: 'error' }, state.error)] : !state.entries ? [loadingLine('Loading…')] : [h('div', { class: 'rv-boardbox' }, board(), repoGroup()), detail()];
  pageEl.replaceChildren(head, state.entries ? headline() : '', state.entries ? describeBox() : '', h('div', { class: 'rv-body' }, ...body));
}

function setTab(k) {
  every.tab = k;
  draw();
  if (k === 'all') loadEvery();
}

/** The headline and ghost cards again after a save: the broadcast's reload is skipped while a form is open. */
async function glanceAgain() {
  const at = state;
  const fresh = await api(url()).catch(() => null);
  if (fresh && state === at) state.glance = fresh.glance ?? null;
}

async function loadEvery() {
  try {
    every.rows = (await api('api/reviews/schemes')).schemes;
    every.error = null;
  } catch (err) {
    every.error = err.message;
  }
  if (every.tab === 'all' && pageEl?.isConnected) draw();
}

// What the headline's phrases light up on hover (#1094): the cards each phrase counts.
const isOwn = (e) => e.enabled && !e.kit && !e.file && e.kind !== 'teacher' && e.kind !== 'audit';
const isNever = (e) => e.enabled && !e.kit && !e.runs?.length;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The summary first (#1094, take A): two sentences a newcomer reads, built from the set. Each key phrase lights up the
 * cards it counts while it's hovered or focused; the unwatched share points at the ghost cards.
 */
function headline() {
  const name = view.project?.name ?? 'This scheme';
  const own = state.entries.filter(isOwn);
  const files = state.entries.filter((e) => e.enabled && e.file && e.kind !== 'teacher');
  const pre = entry('pre-ship-review');
  const trial = state.entries.filter((e) => e.enabled && e.trial && !e.kit);
  const never = state.entries.filter(isNever);
  const g = state.glance;
  const cov = g?.coverage;
  const hl = (key, tone, text) =>
    h(
      'button',
      {
        type: 'button',
        class: 'rv-hl',
        'data-tone': tone,
        'data-hi': key,
        onmouseenter: () => {
          pageEl.dataset.hi = key;
        },
        onmouseleave: () => {
          delete pageEl.dataset.hi;
        },
        onfocus: () => {
          pageEl.dataset.hi = key;
        },
        onblur: () => {
          delete pageEl.dataset.hi;
        },
        onclick: () => pageEl.querySelector(`.is-${key}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }),
      },
      text,
    );
  const preOn = !pre?.kit || pre.enabled;
  const preText = preOn ? ["the kit's ", hl('preship', 'info', 'pre-ship review'), ' before it ships'] : [hl('preship', 'danger', 'nothing before it ships'), ": the kit's pre-ship review is off"];
  const first = own.length
    ? [`${name}'s work is judged by `, hl('own', 'ok', `${plural(own.length, 'critic')} of its own`), " while it's built, ", ...(files.length ? ['its ', hl('repo', 'ok', plural(files.length, 'repo agent')), ' when a minion calls them, '] : []), 'and ', ...preText, '.']
    : [`${name} has `, hl('own', 'warn', 'no critics of its own'), ' yet', ...(files.length ? [', ', hl('repo', 'ok', plural(files.length, 'repo agent')), ' a minion can call'] : []), preOn ? [': ', ...preText.slice(0, 2), ' judges its work before it ships.'] : ['; ', ...preText, '.']];
  const unwatched = cov?.changes ? Math.round((100 * (cov.changes - cov.watched)) / cov.changes) : null;
  const second = [
    trial.length ? hl('trial', 'warn', `${trial.length} on trial`) : 'Nothing is on trial',
    trial.length ? ' (advising, blocking nothing)' : '',
    ', ',
    never.length ? hl('never', 'warn', `${plural(never.length, 'judge')} never run`) : own.length || files.length ? 'every judge of its own has a run on record' : 'none of its own to run',
    unwatched === null ? '.' : [', and ', hl('gap', unwatched > 50 ? 'danger' : unwatched > 20 ? 'warn' : 'ok', `${unwatched}% of this month's changes`), ' fall where no critic of its own looks.'],
  ];
  const foot = g
    ? [
        g.closed ? toneChip(g.judged === g.closed ? 'ok' : g.judged ? 'warn' : 'danger', `Judged ${g.judged} of ${plural(g.closed, 'minion')} closed this week`) : toneChip('neutral', 'No minions closed this week'),
        toneChip(g.last ? 'neutral' : 'warn', g.last ? `Last run ${ago(g.last)}` : 'No run recorded yet'),
        cov ? toneChip('neutral', `${cov.changes.toLocaleString()} changes in ${g.days} days, tests and docs left out`) : null,
      ]
    : [];
  return h('div', { class: 'rv-glance' }, h('p', { class: 'rv-headline' }, ...first.flat(), ' ', ...second.flat()), h('div', { class: 'rv-chips rv-glance-foot' }, ...foot));
}

/** The folders this month's changes hit that no critic of the scheme's own watches, as dashed cards at the foot of While working (take B). */
function ghostCards() {
  const gaps = (state.glance?.coverage?.gaps ?? []).filter((x) => x.folder !== '(top)').slice(0, 3);
  return gaps.map((x) =>
    h(
      'div',
      { class: 'rv-ghost is-gap' },
      h('div', {}, 'Nothing watches ', h('code', {}, `${x.folder}/**`)),
      h('div', { class: 'muted' }, `${plural(x.changes, 'change')} in ${state.glance.days} days`),
      h(
        'button',
        {
          type: 'button',
          class: 'rv-link',
          onclick: () => {
            state.newWhen = `diff: ${x.folder}/**`;
            select(null, 'new');
          },
        },
        '+ Add a critic',
      ),
    ),
  );
}

/** The scheme's own repo files (#1094): its reviewing agent files as cards, and its review skills read-only, with the Skills page a click away. */
function repoGroup() {
  const files = state.entries.filter((e) => e.file && e.kind !== 'teacher');
  const skills = state.glance?.skills ?? [];
  if (!files.length && !skills.length) return '';
  return h(
    'section',
    { class: 'rv-repo is-repo', 'aria-label': "From this scheme's repo" },
    h('div', { class: 'rv-repo-head' }, h('h3', {}, "From this scheme's repo"), h('a', { class: 'small', href: `#/p/${view.projectId}/skills` }, 'See them on Skills')),
    h(
      'div',
      { class: 'rv-repo-items' },
      ...files.map(withTeachers),
      ...skills.map((k) =>
        h(
          'div',
          { class: 'rv-card rv-skill', title: 'A review skill in the repo: read-only here, a minion loads it when its work needs it' },
          h('div', { class: 'rv-card-top' }, h('span', { class: 'rv-card-name' }, k.name)),
          k.what ? h('div', { class: 'rv-card-when' }, k.what) : null,
          h('div', { class: 'rv-chips' }, toneChip('ok', 'skill'), toneChip('neutral', 'read-only')),
        ),
      ),
    ),
  );
}

/** "4 hours ago", or a dash for never: a cell that's empty reads as missing data, so it says so. */
const none = (text = '—') => h('span', { class: 'muted' }, text);

/** The Every scheme tab (#1094, take A "But with more color"): a row a scheme, each opening its own page. */
function everyTable() {
  if (every.error) return h('p', { class: 'error' }, every.error);
  if (!every.rows) return loadingLine('Loading…');
  if (!every.rows.length) return h('p', { class: 'muted' }, "You aren't a member of any scheme yet.");
  const rows = [...every.rows].sort((a, b) => (b.last ?? 0) - (a.last ?? 0) || a.name.localeCompare(b.name));
  const open = (r) => {
    every.tab = 'scheme';
    if (r.id === state.projectId) draw();
    else location.hash = `#/p/${r.id}/reviews`;
  };
  const judges = (r) => {
    const parts = [
      [r.critics, 'ok', 'critic'],
      [r.trial, 'warn', 'on trial'],
      [r.teachers, 'violet', 'teacher'],
      [r.repo, 'info', 'repo agent'],
    ]
      .filter(([v]) => v)
      .map(([v, tone, word]) => toneChip(tone, word === 'on trial' ? `${v} on trial` : plural(v, word)));
    return parts.length ? h('span', { class: 'rv-mx-judges' }, ...parts) : none();
  };
  const watched = (r) => {
    if (!r.coverage?.changes) return none(r.coverage ? 'no changes' : 'no repo');
    const f = r.coverage.watched / r.coverage.changes;
    return h('span', { 'data-hue': f >= 0.7 ? 'done' : f >= 0.4 ? 'waiting' : 'danger' }, meter(f, `${Math.round(100 * f)}%`));
  };
  const cells = (r) => [
    ['Scheme', h('span', { class: 'rv-mx-name' }, schemeTag(r.name), r.opened ? null : toneChip('neutral', 'never opened'), r.preship ? null : toneChip('danger', 'pre-ship off'))],
    ['Judges', judges(r)],
    ['Last run', r.last ? h('span', { class: 'rv-mx-when' }, ago(r.last)) : toneChip('warn', 'never')],
    ['Passed', r.rate === null ? none() : toneChip(r.rate >= 70 ? 'ok' : r.rate >= 40 ? 'warn' : 'danger', `${r.rate}%`)],
    ['Judged this week', r.closed ? toneChip(r.judged === r.closed ? 'ok' : r.judged ? 'warn' : 'danger', `${r.judged} of ${r.closed}`) : none()],
    ['Watched', watched(r)],
    ['Biggest gap', r.coverage?.gap ? h('span', {}, h('code', {}, `${r.coverage.gap.folder}/`), h('span', { class: 'muted' }, ` ${r.coverage.gap.changes}`)) : none()],
  ];
  return h(
    'div',
    { class: 'rv-every' },
    h('p', { class: 'muted rv-every-note' }, `Every scheme you're a member of. The kit's pre-ship review runs in each unless it says off; Watched is the share of the last 30 days of changes a critic of the scheme's own looks at, tests and docs left out.`),
    h(
      'table',
      { class: 'rv-mx' },
      h('thead', {}, h('tr', {}, ...cells(rows[0]).map(([k]) => h('th', { scope: 'col' }, k)))),
      h(
        'tbody',
        {},
        ...rows.map((r) =>
          h(
            'tr',
            {
              tabindex: 0,
              onclick: () => open(r),
              onkeydown: (ev) => {
                if (ev.key === 'Enter') open(r);
              },
            },
            ...cells(r).map(([k, v]) => h('td', { 'data-label': k }, v)),
          ),
        ),
      ),
    ),
  );
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
  const cols = COLUMNS.filter(([stage]) => stage !== 'ask' || state.entries.some((e) => e.stage === 'ask' && !e.file && e.kind !== 'teacher'));
  if (!state.entries.length && !state.audits.length) {
    return h(
      'div',
      { class: 'rv-board rv-empty' },
      h('p', {}, 'Nothing reviews work in this scheme yet.'),
      h('p', { class: 'muted' }, 'Add a critic from a kit starter (like the UI screenshots critic) or write one from scratch. A new one starts on trial: it advises, and blocks nothing, until you take it off trial.'),
      h('button', { type: 'button', class: 'cui-btn cui-primary', onclick: () => select(null, 'new') }, '+ New'),
    );
  }
  return h(
    'div',
    { class: 'rv-board', 'data-cols': cols.length },
    ...cols.map(([stage, label]) => {
      // A teacher runs only when a critic hands it work (#1089): it hangs under those critics, not in a column. The repo's own
      // agent files sit in their own group under the columns (#1094).
      const list = columnUnits(state.entries.filter((e) => e.stage === stage && e.kind !== 'teacher' && !e.file));
      if (stage === 'work') list.push(...state.entries.filter((t) => t.kind === 'teacher' && !handsTo(t).length).map(looseTeacher), ...ghostCards());
      if (stage === 'schedule') list.push(...state.audits.map(auditCard));
      return h('section', { class: `rv-col is-${stage}`, 'aria-label': label }, h('h3', {}, label), list.length ? list : h('p', { class: 'muted rv-none' }, 'None'));
    }),
  );
}

/**
 * A column in run order: the lenses as one card, a panel as one box, and "↓ then" between two of the scheme's own that
 * run, as the turn's run order says (orderLine in src/review-set.ts). The kit's own keep their own flow.
 */
function columnUnits(here) {
  const out = [];
  const seen = new Set();
  for (const e of here) {
    const key = isLens(e) ? 'lens' : e.panel && !e.kit && !e.file ? `panel:${e.panel}` : null;
    if (key && seen.has(key)) continue;
    // A panel sits where its first member that's on runs (orderLine), not at a switched-off one above it.
    if (key !== 'lens' && key && !e.enabled && here.some((x) => x.panel === e.panel && !x.kit && !x.file && x.enabled)) continue;
    if (key) seen.add(key);
    if (key === 'lens') out.push({ node: lensesCard(here.filter(isLens)) });
    else if (key) {
      const members = here.filter((x) => x.panel === e.panel && !x.kit && !x.file);
      out.push({ node: panelBox(e.panel, members), runs: members.some((x) => x.enabled) });
    } else out.push({ node: withTeachers(e), runs: !e.kit && !e.file && e.enabled });
  }
  return out.flatMap((u, i) => (i && u.runs && out[i - 1].runs ? [h('div', { class: 'rv-then', 'aria-hidden': 'true' }, '↓ then'), u.node] : [u.node]));
}

/** A panel (Q7): its judges look at the same work at once and its referee merges their verdicts into one. */
function panelBox(name, members) {
  const judges = members.filter((x) => x.kind !== 'referee');
  const refs = members.filter((x) => x.kind === 'referee');
  const on = judges.filter((x) => x.enabled).length;
  const ref = refs.some((x) => x.enabled);
  return h(
    'div',
    { class: 'rv-panel', role: 'group', 'aria-label': `Panel ${name}` },
    h('div', { class: 'rv-panel-head' }, h('b', {}, name), h('span', { class: 'muted' }, ref ? ': judge together, referee merges' : ': judge together')),
    ...judges.map(withTeachers),
    ...refs.map(withTeachers),
    ref
      ? h('p', { class: 'muted rv-panel-cost' }, `${on} judge${on === 1 ? '' : 's'} + referee: ${on + 1} model calls a run`)
      : h('p', { class: 'rv-warn rv-panel-cost', role: 'note' }, `No referee on: each judge's verdict stands on its own (${on} model call${on === 1 ? '' : 's'} a run). Add a referee to the panel to merge them.`),
  );
}

/** Its last runs, oldest first: green pass, red fail, amber where a person disagreed, grey where it asked a person. */
function dots(runs) {
  return h(
    'span',
    { class: 'rv-dots', role: 'img', 'aria-label': `Last ${runs.length} runs: ${runs.map((r) => (r.disagreed ? 'disagreed' : r.verdict)).join(', ')}` },
    runs.map((r) => h('i', { class: `is-${r.disagreed ? 'disagreed' : r.verdict}`, title: `${r.minion}, round ${r.round}: ${r.verdict}${r.disagreed ? ', and a person disagreed' : ''} · ${pacific(r.at)}` })),
  );
}

function card(e) {
  const sw = onSwitch(e);
  const marks = [isOwn(e) && 'is-own', e.enabled && e.trial && !e.kit && 'is-trial', isNever(e) && 'is-never', e.file && 'is-repo', e.slug === 'pre-ship-review' && 'is-preship']
    .filter(Boolean)
    .map((c) => ` ${c}`)
    .join('');
  return h(
    'div',
    {
      class: `rv-card${marks}${e.slug === state.selected ? ' on' : ''}${e.enabled ? '' : ' off'}`,
      role: 'button',
      tabindex: 0,
      'aria-pressed': String(e.slug === state.selected),
      onclick: () => select(e.slug),
      onkeydown: (ev) => {
        if (ev.target === ev.currentTarget && (ev.key === 'Enter' || ev.key === ' ')) {
          ev.preventDefault();
          select(e.slug);
        }
      },
    },
    h('div', { class: 'rv-card-top' }, h('span', { class: 'rv-card-name' }, e.name), sw),
    h('div', { class: 'rv-card-when' }, e.kit || e.file ? e.when : whenLine(e)),
    chips(e, true),
    e.runs?.length ? h('div', { class: 'rv-card-rec' }, dots(e.runs), e.rate === null ? null : h('span', { class: 'muted' }, `${e.rate}%`)) : null,
  );
}

const isLens = (e) => e.kit && e.slug.startsWith('lens-');

/** The teachers an entry hands its stubborn fails to, with after how many fails: its hand-offs, or a critic's default (professor after 2). */
function teachersOf(e) {
  const steps = e.on_fail ?? (e.kind === 'critic' ? [{ after: 2, to: 'professor' }] : []);
  return steps.map((st) => ({ after: st.after, t: entry(st.to) })).filter((x) => x.t?.kind === 'teacher');
}
/** The entries that hand off to a teacher, with after how many fails. */
const handsTo = (t) =>
  state.entries.flatMap((e) =>
    teachersOf(e)
      .filter((x) => x.t.slug === t.slug)
      .map((x) => ({ e, after: x.after })),
  );
/** "fix held 3 of 4", or that it has none yet: a teacher's record is whether the critic passed the work after its fix. */
const heldText = (t) => (t.firsts ? `fix held ${t.passes} of ${t.firsts === 20 ? 'the last 20' : t.firsts}` : 'no fixes yet');

/** A card with a strip under it per teacher it hands off to, so the chain reads top to bottom (take A, #1089). */
function withTeachers(e) {
  const ts = teachersOf(e);
  if (!ts.length) return card(e);
  return h(
    'div',
    { class: 'rv-chain' },
    card(e),
    ...ts.map(({ t, after }) =>
      h(
        'button',
        {
          type: 'button',
          class: `rv-teach${t.slug === state.selected ? ' on' : ''}${t.enabled ? '' : ' off'}`,
          'aria-pressed': String(t.slug === state.selected),
          title: `${e.name} hands an item to ${t.name} after ${after} failed round${after === 1 ? '' : 's'}${t.enabled ? '' : ` (${t.name} is off)`}`,
          onclick: () => select(t.slug),
        },
        h('span', { class: 'rv-teach-after' }, `↳ after ${after} fail${after === 1 ? '' : 's'}`),
        h('span', { class: 'rv-teach-name' }, t.name),
        h('span', { class: 'rv-teach-rec' }, t.runs?.length ? dots(t.runs) : null, h('span', { class: 'muted' }, t.enabled ? heldText(t) : 'off')),
      ),
    ),
  );
}

/** A teacher no critic here hands off to: at the foot of While working, quiet, still openable. */
function looseTeacher(t) {
  return h(
    'button',
    { type: 'button', class: `rv-teach rv-teach-loose${t.slug === state.selected ? ' on' : ''}${t.enabled ? '' : ' off'}`, 'aria-pressed': String(t.slug === state.selected), onclick: () => select(t.slug) },
    h('span', { class: 'rv-teach-name' }, t.name),
    h('span', { class: 'muted' }, `${t.kit ? "The kit's teacher" : 'A teacher'}: no critic here hands off to it${t.enabled ? '' : ', and it is off'}. ${heldText(t)}.`),
  );
}

/** The pre-ship review's lenses as one row that opens to a switch a lens (#1094), so nine of them don't bury the column. */
function lensesCard(lenses) {
  const on = lenses.filter((e) => e.enabled).length;
  const open = state.lenses || lenses.some((e) => e.slug === state.selected);
  return h(
    'div',
    { class: `rv-card rv-lenses${open ? ' open' : ''}` },
    h(
      'button',
      {
        type: 'button',
        class: 'rv-lens-row',
        'aria-expanded': String(open),
        onclick: () => {
          state.lenses = !open;
          if (!state.lenses && lenses.some((e) => e.slug === state.selected)) state.selected = null;
          draw();
        },
      },
      h('span', { class: 'rv-card-name' }, h('span', { class: 'rv-caret', 'aria-hidden': 'true' }, '▸'), " The pre-ship review's lenses"),
      h('span', { class: 'rv-lens-count' }, toneChip(on ? 'info' : 'neutral', `${on} on`), on < lenses.length ? toneChip('neutral', `${lenses.length - on} off`) : null),
    ),
    open ? h('div', { class: 'rv-card-when' }, 'Each read when the diff has its kind of change') : null,
    open
      ? h(
          'ul',
          { class: 'rv-lens-list' },
          lenses.map((e) => h('li', { class: `${e.slug === state.selected ? 'on' : ''}${e.enabled ? '' : ' off'}` }, h('button', { type: 'button', class: 'rv-lens-name', 'aria-pressed': String(e.slug === state.selected), onclick: () => select(e.slug) }, e.name.replace(/^Lens: /, '')), onSwitch(e))),
        )
      : null,
  );
}

function chips(e, onCard = false) {
  return h(
    'div',
    { class: 'rv-chips' },
    e.kind !== 'critic' ? h('span', { class: 'cui-chip', 'data-tone': e.kind === 'teacher' ? 'violet' : 'neutral' }, e.kind) : null,
    e.trial ? h('span', { class: 'cui-chip', 'data-tone': 'warn', title: "On trial: it advises and blocks nothing until it's calibrated" }, 'trial') : null,
    onCard && isNever(e) ? h('span', { class: 'cui-chip', 'data-tone': 'warn', title: 'On, with no run on record yet' }, 'never run') : null,
    e.gate === 'block' ? h('span', { class: 'cui-chip', 'data-tone': 'info', title: 'Its fail blocks the ship' }, 'blocks') : null,
    e.stuck ? h('span', { class: 'cui-chip', 'data-tone': 'warn', title: `Its last ${e.firsts} first rounds all ${e.stuck === 'pass' ? 'passed: it may be too easy' : 'failed: it may be too strict, or the work keeps missing it'}` }, e.stuck === 'pass' ? 'always passes' : 'always fails') : null,
    labelGiver()?.slug === e.slug ? h('span', { class: 'cui-chip', 'data-tone': 'info', title: "Gives the risk label that decides whether a ship waits for a person's go" }, 'risk label') : null,
    e.kit
      ? h('span', { class: 'cui-chip', 'data-tone': 'info', title: "The kit's own: its text stays in the kit, and this scheme switches it and adds to it" }, 'kit')
      : e.file
        ? h('span', { class: 'cui-chip', 'data-tone': 'ok', title: `This scheme's own agent file, ${e.file}: its text stays in the repo, and this page switches it and adds to it` }, 'repo')
        : e.extends
          ? h('span', { class: 'cui-chip', 'data-tone': 'info', title: `On top of the kit's ${e.extends} starter, so kit fixes reach it` }, `on the kit's ${e.extends}`)
          : null,
    e.file && !e.agent ? h('span', { class: 'cui-chip', 'data-tone': 'danger', title: `${e.file} is gone from the repo` }, 'file gone') : null,
    e.enabled ? null : h('span', { class: 'cui-chip', 'data-tone': 'neutral' }, 'off'),
  );
}

/** A standard audit (kit/schedules/): its switch is its schedule's pause, so the page and Schedules never disagree. */
function auditCard(a) {
  const key = `audit:${a.slug}`;
  return h(
    'div',
    {
      class: `rv-card${key === state.selected ? ' on' : ''}${a.on ? '' : ' off'}`,
      role: 'button',
      tabindex: 0,
      'aria-pressed': String(key === state.selected),
      onclick: () => select(key),
      onkeydown: (ev) => {
        if (ev.target === ev.currentTarget && (ev.key === 'Enter' || ev.key === ' ')) {
          ev.preventDefault();
          select(key);
        }
      },
    },
    h('div', { class: 'rv-card-top' }, h('span', { class: 'rv-card-name' }, a.name), auditSwitch(a)),
    h('div', { class: 'rv-card-when' }, a.when),
    auditChips(a),
  );
}

const auditChips = (a) => h('div', { class: 'rv-chips' }, h('span', { class: 'cui-chip', 'data-tone': 'neutral' }, 'audit'), h('span', { class: 'cui-chip', 'data-tone': 'info', title: "One of the kit's standard audits" }, 'kit'), a.on ? null : h('span', { class: 'cui-chip', 'data-tone': 'neutral' }, 'off'));

function auditSwitch(a) {
  return h('button', {
    type: 'button',
    class: 'rules-switch',
    'data-slug': `audit:${a.slug}`,
    role: 'switch',
    'aria-checked': String(a.on),
    'aria-label': `${a.name}: ${a.on ? 'on' : 'off'}`,
    onclick: (ev) => {
      ev.stopPropagation();
      setAudit(a.slug, !a.on);
    },
  });
}

function setAudit(slug, on) {
  const s = state;
  const path = url(`audits/${slug}`);
  const redraw = () => {
    if (state === s && s.mode !== 'edit' && s.mode !== 'new') draw();
  };
  const flip = (v) => {
    const a = s.audits.find((x) => x.slug === slug);
    if (a) a.on = v;
    redraw();
  };
  optimistic({
    key: `reviews:${s.projectId}:audit:${slug}`,
    apply: () => flip(on),
    send: () => api(path, { method: 'POST', body: { enabled: on } }),
    undo: () => flip(!on),
    label: `turn ${on ? 'on' : 'off'} the ${s.audits.find((x) => x.slug === slug)?.name ?? slug}`,
  }).then(
    (saved) => {
      const i = s.audits.findIndex((x) => x.slug === slug);
      if (i >= 0 && saved?.slug) s.audits[i] = saved;
      redraw();
    },
    () => {},
  );
}

/** The trigger in words: "Changes in public/**", "Monthly", "When a person asks". */
function whenLine(e) {
  const t = e.triggers ?? {};
  const parts = [];
  if (t.diff?.length) parts.push(`Changes in ${t.diff.join(', ')}${t.lines ? ` (${t.lines}+ lines)` : ''}`);
  if (t.types?.length) parts.push(`${t.types.join(' or ')} minions`);
  if (t.creative) parts.push(t.creative);
  if (t.in_app) parts.push(`In the app: ${t.in_app}`);
  if (t.schedule) parts.push(t.schedule);
  if (t.ask || !parts.length) parts.push('When a person asks');
  return parts.join('; ');
}

/** Its on/off switch: Minion rules' switch (settings.css .rules-switch). */
function onSwitch(e) {
  return h('button', {
    type: 'button',
    class: 'rules-switch',
    'data-slug': e.slug,
    role: 'switch',
    'aria-checked': String(e.enabled),
    'aria-label': `${e.name}: ${e.enabled ? 'on' : 'off'}`,
    onclick: (ev) => {
      ev.stopPropagation();
      setSwitch(e.slug, { enabled: !e.enabled });
    },
  });
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
  }).then(
    (saved) => {
      const i = s.entries.findIndex((x) => x.slug === slug);
      if (i >= 0 && saved?.slug) s.entries[i] = saved;
      redraw();
    },
    () => {},
  );
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
  return h(
    'aside',
    { class: 'rv-detail' },
    h(
      'div',
      { class: 'rv-detail-head' },
      h(
        'button',
        {
          type: 'button',
          class: 'close-view narrow-only',
          'aria-label': 'Back to the columns',
          title: 'Back',
          onclick: () => {
            state.selected = null;
            draw();
            pageEl.scrollIntoView({ block: 'start' });
          },
        },
        icon('back'),
      ),
      h('h3', {}, e.name),
      chips(e),
    ),
    h('div', { class: 'rv-switch-row' }, sw, h('span', {}, e.enabled ? 'On' : 'Off')),
    e.slug === 'pre-ship-review' ? preShipNote(e) : null,
    e.kit || e.file || e.kind === 'teacher' ? null : judging(e),
    e.kit || (e.agent && e.file) ? section('What it does', h('p', {}, e.what || 'Its file has no description: add a description line to its frontmatter.')) : null,
    e.kind === 'teacher' ? section('When it runs', h('p', {}, e.kit || e.file ? e.when : 'When a critic hands it a stubborn fail'), handOffs(e)) : section('Reviews', h('p', {}, e.kit || e.file ? e.when : whenLine(e)), e.kit || e.file ? null : h('p', { class: 'muted rv-when' }, h('code', {}, `when: ${e.when}`))),
    e.agent
      ? section(
          'Its text',
          h('p', { class: 'muted' }, 'From ', h('code', {}, e.agent.path), e.kit ? " in the kit: every scheme's minions read the same." : e.file ? " in this scheme's repo: change it there, and the page reads it as it is." : ` in this scheme's repo: this entry runs as that agent, with its rubric below.`),
          h('details', { class: 'rv-agent' }, h('summary', {}, 'Show its text'), markdownElement(e.agent.text, { headingBase: 4 })),
        )
      : e.file
        ? section('Its text', h('p', { class: 'error' }, h('code', {}, e.file), ' is gone from the repo, or its kind: line now says none, so nothing runs it. Put the file back, or switch this off.'))
        : null,
    e.kit || e.file
      ? section("This scheme's additions", e.body.trim() ? h('pre', { class: 'rv-added' }, e.body) : h('p', { class: 'muted' }, `None: it reads ${e.kit ? "the kit's text" : 'its file'} alone. Edit by hand or describe a change to add to it.`))
      : section('Context', contextItems.length ? h('ul', { class: 'rv-ctx' }, contextItems) : h('p', { class: 'muted' }, 'Only the work itself and its rubric.')),
    e.kit ? null : e.file ? (e.kind === 'teacher' ? null : section('With the others', onFailEditor(e))) : section('With the others', ...withOthers(e)),
    section('Record', e.calibrated ? h('p', {}, `Calibrated ${e.calibrated}`) : null, ...record(e)),
    e.verdicts?.length ? section('Verdicts', verdictList(e, false)) : null,
    e.lessons ? section('Lessons', ...lessonList(e, false)) : null,
    h(
      'div',
      { class: 'rv-actions' },
      h('button', { type: 'button', class: 'cui-btn', onclick: () => select(e.slug, 'edit') }, 'Edit by hand'),
      h('button', { type: 'button', class: 'cui-btn', 'aria-pressed': String(state.mode === 'history'), onclick: () => select(e.slug, state.mode === 'history' ? 'view' : 'history') }, 'History'),
    ),
    state.mode === 'history' ? history(e) : null,
    h('p', { class: 'muted rv-ver' }, `Version ${e.version}, saved by ${e.updated_by} ${ago(e.updated_at)}`),
  );
}

/** Who hands work to a teacher, and after how many fails; none says how to wire one. */
function handOffs(t) {
  const from = handsTo(t);
  if (!from.length) return h('p', { class: 'muted' }, "No critic here hands off to it yet. A critic's hand-offs (Edit by hand on the critic) name it.");
  return h(
    'ul',
    { class: 'rv-ctx' },
    from.map(({ e, after }) => h('li', {}, h('button', { type: 'button', class: 'rv-link', onclick: () => select(e.slug) }, e.name), ` after ${after} failed round${after === 1 ? '' : 's'}`)),
  );
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
    e.stuck
      ? h(
          'p',
          { class: 'rv-warn', role: 'note' },
          e.stuck === 'pass' ? `Its last ${e.firsts} first rounds all passed. A critic that never fails may be too easy: calibrate it, or tighten what fails.` : `Its last ${e.firsts} first rounds all failed. It may be too strict, or the work keeps missing the same thing: read its findings.`,
        )
      : null,
  ].filter(Boolean);
}

/** What people said when they disagreed with it (Q13): only a minion records one; Edit by hand can remove one. */
function verdictList(e, removable) {
  return h(
    'ul',
    { class: 'rv-verdicts' },
    e.verdicts.map((v) => h('li', {}, h('q', {}, v.words), h('span', { class: 'muted' }, ` ${v.person}, `, h('time', { title: pacific(v.at) }, ago(v.at)), `, on ${v.minion}`), removable ? h('button', { type: 'button', class: 'cui-btn cui-small cui-ghost', onclick: () => removeVerdict(e, v) }, 'Remove') : null)),
  );
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
  const panel = h('input', {
    class: 'cui-input',
    value: e.panel ?? '',
    placeholder: 'None',
    maxlength: 40,
    list: 'rv-panels',
    'aria-label': 'Panel',
    onchange: (ev) => {
      const v = ev.target.value.trim() || null;
      if (v !== (e.panel ?? null)) setSwitch(e.slug, { panel: v });
    },
  });
  return [
    h('div', { class: 'rv-order' }, h('span', {}, `Runs ${i + 1} of ${col.length} ${label.toLowerCase()}`), moveBtn('up', '↑', i > 0), moveBtn('down', '↓', i < col.length - 1)),
    h(
      'label',
      { class: 'rv-field' },
      h('span', { class: 'rv-label' }, 'Panel'),
      panel,
      h(
        'datalist',
        { id: 'rv-panels' },
        names.map((n) => h('option', { value: n })),
      ),
      h('span', { class: 'muted rv-hint' }, e.kind === 'referee' ? "As the panel's referee it merges the judges' verdicts into one." : 'Entries with the same panel judge the same work at once, and its referee merges their verdicts.'),
    ),
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
    const a = s.entries.indexOf(e),
      b = s.entries.indexOf(other);
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
  }).then(
    () => load(),
    () => {},
  );
}

/** Hand off on a fail: after n failed rounds the work goes to the professor, a person or another entry. */
function onFailEditor(e) {
  const fallback = e.kind === 'critic' ? 'professor after 2 fails, person after 3' : null;
  const steps = (e.on_fail ?? []).map((x) => ({ ...x }));
  const targets = [['professor', 'the professor'], ['person', 'a person'], ...state.entries.filter((x) => x.slug !== e.slug && !x.kit).map((x) => [x.slug, x.name])];
  const box = h('div', { class: 'rv-onfail' });
  const save = h('button', { type: 'button', class: 'cui-btn cui-small cui-primary', hidden: true, onclick: () => setSwitch(e.slug, { on_fail: steps.length ? steps : null }) }, 'Save hand-offs');
  const changed = () => {
    save.hidden = JSON.stringify(steps) === JSON.stringify(e.on_fail ?? []);
  };
  const rows = () =>
    box.replaceChildren(
      ...steps.map((st, k) =>
        h(
          'div',
          { class: 'rv-onfail-row' },
          h('span', {}, 'After'),
          h('input', {
            class: 'cui-input',
            type: 'number',
            min: 1,
            max: 10,
            value: st.after,
            'aria-label': 'Failed rounds',
            oninput: (ev) => {
              st.after = Number(ev.target.value);
              changed();
            },
          }),
          h('span', {}, 'fails, to'),
          h(
            'select',
            {
              class: 'cui-input',
              'aria-label': 'Hand it to',
              onchange: (ev) => {
                st.to = ev.target.value;
                changed();
              },
            },
            targets.map(([v, l]) => h('option', { value: v, selected: v === st.to }, l)),
          ),
          h(
            'button',
            {
              type: 'button',
              class: 'cui-btn cui-small cui-ghost',
              'aria-label': 'Remove this step',
              onclick: () => {
                steps.splice(k, 1);
                rows();
                changed();
              },
            },
            '×',
          ),
        ),
      ),
      h(
        'div',
        { class: 'rv-actions' },
        steps.length < 4
          ? h(
              'button',
              {
                type: 'button',
                class: 'cui-btn cui-small',
                onclick: () => {
                  const last = steps.at(-1);
                  steps.push({ after: Math.min(10, (last?.after ?? 1) + 1), to: last ? 'person' : 'professor' });
                  rows();
                  changed();
                },
              },
              '+ Step',
            )
          : null,
        save,
      ),
    );
  rows();
  return h('div', { class: 'rv-field' }, h('span', { class: 'rv-label' }, 'Hand off on a fail'), h('span', { class: 'muted rv-hint' }, e.on_fail?.length ? 'Each step takes over from the one before.' : fallback ? `None set: as every critic, ${fallback}.` : 'None set: its fails go back to the author.'), box);
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
  const gate = (v, label) =>
    h(
      'button',
      {
        type: 'button',
        'aria-pressed': String((e.gate ?? 'advise') === v),
        disabled: e.trial,
        title: lock,
        onclick: () => {
          if ((e.gate ?? 'advise') !== v) setSwitch(e.slug, { gate: v === 'block' ? 'block' : null });
        },
      },
      label,
    );
  return h(
    'div',
    { class: 'rv-judging' },
    h(
      'div',
      { class: 'rv-trial' },
      e.trial ? h('span', { class: 'muted' }, "On trial: it advises and blocks nothing until it's calibrated.") : h('span', { class: 'muted' }, e.calibrated ? `Off trial: calibrated ${e.calibrated}.` : 'Off trial.'),
      h('button', { type: 'button', class: 'cui-btn cui-small', onclick: () => setSwitch(e.slug, { trial: !e.trial }) }, e.trial ? 'Mark it good' : 'Put on trial'),
    ),
    h('div', { class: 'rv-seg', role: 'group', 'aria-label': 'When it fails' }, gate('block', 'Block the ship'), gate('advise', 'Advise')),
    h('label', { class: 'rv-check', title: lock }, h('input', { type: 'checkbox', checked: e.gives_label, disabled: e.trial, onchange: (ev) => setSwitch(e.slug, { gives_label: ev.target.checked }) }), h('span', {}, 'Gives the risk label when the pre-ship review is off')),
  );
}

/** A standard audit's detail: its switch, when it runs and what it's for. */
function auditDetail(a) {
  return h(
    'aside',
    { class: 'rv-detail' },
    h(
      'div',
      { class: 'rv-detail-head' },
      h(
        'button',
        {
          type: 'button',
          class: 'close-view narrow-only',
          'aria-label': 'Back to the columns',
          title: 'Back',
          onclick: () => {
            state.selected = null;
            draw();
            pageEl.scrollIntoView({ block: 'start' });
          },
        },
        icon('back'),
      ),
      h('h3', {}, a.name),
      auditChips(a),
    ),
    h('div', { class: 'rv-switch-row' }, auditSwitch(a), h('span', {}, a.on ? 'On' : 'Off')),
    h('section', { class: 'rv-sec' }, h('h4', {}, 'Runs'), h('p', {}, `${a.when}, as one of this scheme's scheduled minions (Orders → Schedules). Its switch here is that schedule's pause.`)),
    h('section', { class: 'rv-sec' }, h('h4', {}, 'For a scheme where'), h('p', {}, a.applies)),
  );
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
  if (!state.versions) return loadingLine('Loading its history…');
  return h(
    'ol',
    { class: 'rv-history' },
    state.versions.map((v) =>
      h(
        'li',
        {},
        h('span', { class: 'rv-hv' }, `v${v.version}`),
        h('span', { class: 'rv-hnote' }, v.note, h('span', { class: 'muted' }, ` · ${v.by} · `, h('time', { title: pacific(v.at) }, ago(v.at)))),
        v.version === e.version ? h('span', { class: 'muted' }, 'current') : h('button', { type: 'button', class: 'cui-btn cui-small', onclick: () => restore(e, v.version) }, 'Restore'),
      ),
    ),
  );
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
  if (e.kit || e.file) return kitForm(e);
  const name = h('input', { class: 'cui-input', value: e.name, required: true });
  const kind = h(
    'select',
    { class: 'cui-input' },
    KINDS.map((k) => h('option', { value: k, selected: k === e.kind }, k)),
  );
  const when = h('input', { class: 'cui-input', value: e.when === 'ask' ? '' : e.when, placeholder: 'ask' });
  const stage = h(
    'select',
    { class: 'cui-input' },
    COLUMNS.map(([v, l]) => h('option', { value: v, selected: v === e.stage }, l)),
  );
  const model = h('input', { class: 'cui-input', value: e.model ?? '', placeholder: "The kit's pick" });
  const effort = h(
    'select',
    { class: 'cui-input' },
    [
      ['', "The kit's pick"],
      ['low', 'Low'],
      ['medium', 'Medium'],
      ['high', 'High'],
    ].map(([v, l]) => h('option', { value: v, selected: v === (e.effort ?? '') }, l)),
  );
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
      const saved = await api(url(e.slug), { method: 'PATCH', body: { context, name: name.value, kind: kind.value, when: when.value.trim() || 'ask', stage: stage.value, model: model.value.trim() || null, effort: effort.value || null, body: body.value, note: note.value, version: e.version } });
      state.entries[state.entries.findIndex((x) => x.slug === e.slug)] = saved;
      toast(saved.version === e.version ? 'Nothing changed' : `Saved as version ${saved.version}`);
      state.mode = 'view';
      draw();
      glanceAgain().then(() => {
        if (state.mode === 'view') draw();
      });
    } catch (x) {
      err.textContent = x.message;
      err.hidden = false;
      save.disabled = false;
    }
  };
  return h(
    'form',
    { class: 'rv-form', onsubmit: submit },
    h('h3', {}, `Edit ${e.name}`),
    field('Name', name),
    h('div', { class: 'rv-pair' }, field('Kind', kind), field('Column', stage)),
    field('When it runs', when, 'Like diff: public/**, schedule: monthly, or ask. Parts join with |'),
    h('div', { class: 'rv-pair' }, field('Model', model), field('Effort', effort)),
    field(e.extends ? `Its own lines, under the kit's ${e.extends}` : 'The rubric', body, 'Markdown with ## sections: what it checks, what passes, what fails.'),
    h(
      'fieldset',
      { class: 'rv-ctx-switches' },
      h('legend', { class: 'rv-label' }, 'Its context also has'),
      h('label', { class: 'rv-check' }, verdicts, h('span', {}, 'Your verdicts: what people said when they disagreed with it')),
      h('label', { class: 'rv-check' }, requester, h('span', {}, "The requester's words: the minion's first message")),
    ),
    e.verdicts?.length ? h('div', { class: 'rv-field' }, h('span', { class: 'rv-label' }, 'Recorded verdicts'), verdictList(e, true)) : null,
    field('What changed', note),
    err,
    h('div', { class: 'rv-actions' }, save, h('button', { type: 'button', class: 'cui-btn cui-ghost', onclick: () => select(e.slug) }, 'Cancel')),
  );
}

/** A kit entry's or an agent file's edit: only this scheme's additions, read with the kit's text or the file's (which stay where they are). */
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
      const saved = await api(url(e.slug), { method: 'PATCH', body: { body: body.value, note: note.value, version: e.version } });
      state.entries[state.entries.findIndex((x) => x.slug === e.slug)] = saved;
      toast(saved.version === e.version ? 'Nothing changed' : `Saved as version ${saved.version}`);
      state.mode = 'view';
      draw();
      glanceAgain().then(() => {
        if (state.mode === 'view') draw();
      });
    } catch (x) {
      err.textContent = x.message;
      err.hidden = false;
      save.disabled = false;
    }
  };
  return h(
    'form',
    { class: 'rv-form', onsubmit: submit },
    h('h3', {}, `Edit ${e.name}`),
    h('p', { class: 'muted' }, e.what),
    field("This scheme's additions", body, `Read with ${e.kit ? "the kit's own text" : `its file, ${e.file},`} and handed to its Grunt: what to look for here, what to let pass.`),
    e.verdicts?.length ? h('div', { class: 'rv-field' }, h('span', { class: 'rv-label' }, 'Recorded verdicts'), verdictList(e, true)) : null,
    e.lessons?.length ? h('div', { class: 'rv-field' }, h('span', { class: 'rv-label' }, 'Lessons'), ...lessonList(e, true)) : null,
    field('What changed', note),
    err,
    h('div', { class: 'rv-actions' }, save, h('button', { type: 'button', class: 'cui-btn cui-ghost', onclick: () => select(e.slug) }, 'Cancel')),
  );
}

/**
 * The finding checker's lessons for the pre-ship review (#1158): kinds of finding it refuted here, which the reviewer
 * reads once a kind has three refutes. Only a minion adds one; Edit by hand removes one.
 */
function lessonList(e, removable) {
  const read = e.lessons.filter((l) => l.lesson);
  const counting = e.lessons.length - read.length;
  const note = h(
    'p',
    { class: 'muted' },
    read.length
      ? `Findings the finding checker refuted here in 3 minions' reviews or more. The reviewer reads why each was wrong, and still raises one when a change makes that reason untrue.${counting ? ` ${counting} more kind${counting === 1 ? ' is' : 's are'} counting toward 3.` : ''}`
      : counting
        ? `None yet: ${counting} kind${counting === 1 ? '' : 's'} of refuted finding ${counting === 1 ? 'is' : 'are'} counting toward 3, when the reviewer starts reading it.`
        : "None yet. When the finding checker refutes the same kind of finding in 3 minions' reviews here, the reviewer reads why it was wrong.",
  );
  if (!read.length) return [note];
  return [
    note,
    h(
      'ul',
      { class: 'rv-verdicts' },
      read.map((l) =>
        h('li', {}, h('strong', {}, l.kind), ` ${l.why}`, h('span', { class: 'muted' }, ` refuted ${l.count} times, last `, h('time', { title: pacific(l.last) }, ago(l.last))), removable ? h('button', { type: 'button', class: 'cui-btn cui-small cui-ghost', onclick: () => removeLesson(e, l) }, 'Remove') : null),
      ),
    ),
  ];
}

async function removeLesson(e, l) {
  const s = state;
  const x = s.entries.find((y) => y.slug === e.slug);
  const was = x?.lessons;
  if (x) x.lessons = was.filter((y) => y.kind !== l.kind);
  if (state === s) draw();
  try {
    await api(`${url(e.slug)}/lessons`, { method: 'DELETE', body: { kind: l.kind } });
    toast('Removed: its count starts again from nothing');
  } catch (err) {
    if (x) x.lessons = was;
    if (state === s) draw();
    toast(`Couldn't remove it: ${err.message}`);
  }
}

/**
 * Describe a change (Q11): an agent on the asker's own Claude login reads the set and proposes new text for some
 * entries; each shows as before and after. Apply is an ordinary save (a version History can undo); Dismiss drops it.
 */
function describeBox() {
  const ask = state.ask ?? (state.ask = { text: '', busy: false, note: '', proposals: [], applied: [] });
  const input = h('input', {
    class: 'cui-input',
    placeholder: 'Describe a change, like "make the finding checker stricter on migrations"',
    value: ask.text,
    maxlength: 2000,
    'aria-label': 'Describe a change',
    oninput: (ev) => {
      ask.text = ev.target.value;
    },
  });
  const go = h('button', { type: 'submit', class: 'cui-btn cui-primary', disabled: ask.busy }, ask.busy ? 'Asking…' : 'Ask');
  return h(
    'section',
    { class: 'rv-ask', 'aria-label': 'Describe a change' },
    h(
      'form',
      {
        class: 'rv-ask-row',
        onsubmit: (ev) => {
          ev.preventDefault();
          describe(ask);
        },
      },
      input,
      go,
    ),
    ask.busy ? h('p', { class: 'muted rv-ask-note' }, 'The agent is reading the set on your Claude plan. This takes about a minute.') : null,
    ask.note ? h('p', { class: 'muted rv-ask-note' }, ask.note) : null,
    ...ask.applied.map((m) => h('p', { class: 'rv-applied' }, m)),
    ...ask.proposals.map((p) => proposal(ask, p)),
  );
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
  const sets = (o) =>
    Object.entries(o ?? {})
      .map(([k, v]) => `${k}: ${k === 'on_fail' ? (v?.length ? v.map((x) => `${x.to} after ${x.after}`).join(', ') : 'the default') : (v ?? 'none')}`)
      .join('\n');
  const runs = collapseRuns(diffLines(`${sets(p.settings_before)}${p.settings ? '\n\n' : ''}${p.before}`, `${sets(p.settings)}${p.settings ? '\n\n' : ''}${p.after}`)).map((r) =>
    r.gap ? h('details', { class: 'gap' }, h('summary', {}, `${r.gap.length} unchanged line${r.gap.length === 1 ? '' : 's'}`), ...r.gap.map((o) => row(' ', o.text))) : row(r.op, r.text),
  );
  const drop = () => {
    ask.proposals = ask.proposals.filter((x) => x !== p);
    draw();
  };
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
  return h(
    'div',
    { class: 'rv-proposal' },
    h('div', {}, h('b', {}, p.name), p.why ? `: ${p.why}` : ': proposed change'),
    h('div', { class: 'instructions-diff rev-diff' }, ...runs),
    h('div', { class: 'rv-actions' }, h('button', { type: 'button', class: 'cui-btn cui-primary cui-small', onclick: apply }, 'Apply'), h('button', { type: 'button', class: 'cui-btn cui-small', onclick: drop }, 'Dismiss')),
  );
}

/** New: blank, or on top of a kit starter. It always starts on trial. */
function newForm() {
  const slug = h('input', { class: 'cui-input', placeholder: 'ui-screenshots', pattern: '[a-z0-9]+(-[a-z0-9]+)*', title: 'kebab-case, like ui-screenshots' });
  const from = h(
    'select',
    {
      class: 'cui-input',
      onchange: () => {
        if (from.value && !slug.value) slug.placeholder = from.value;
      },
    },
    h('option', { value: '' }, 'Blank'),
    state.starters.map((s) => h('option', { value: s.slug }, `${s.slug}${s.judges ? `: ${s.judges}` : ''}`)),
  );
  const when = h('input', { class: 'cui-input', value: state.newWhen, placeholder: 'diff: src/**' });
  const err = h('p', { class: 'error', hidden: true });
  const add = h('button', { type: 'submit', class: 'cui-btn cui-primary' }, 'Add on trial');
  const submit = async (ev) => {
    ev.preventDefault();
    add.disabled = true;
    err.hidden = true;
    try {
      const body = { ...(from.value ? { extends: from.value } : {}), ...(slug.value.trim() ? { slug: slug.value.trim() } : {}), ...(when.value.trim() ? { when: when.value.trim() } : {}) };
      const made = await api(url(), { method: 'POST', body });
      state.entries.push(made);
      state.newWhen = '';
      await glanceAgain();
      select(made.slug, 'edit');
    } catch (x) {
      err.textContent = x.message;
      err.hidden = false;
      add.disabled = false;
    }
  };
  return h(
    'form',
    { class: 'rv-form', onsubmit: submit },
    h('h3', {}, 'New reviewer or critic'),
    field('Start from', from, "A kit starter keeps getting the kit's fixes; this scheme's lines go on top."),
    field('Name it', slug, "Its file name, kebab-case. Leave it empty to use the starter's."),
    field('Runs when', when, "Like diff: app/server/** for changes there. Leave it empty to use the starter's."),
    h('p', { class: 'muted' }, 'It starts on trial: it advises and blocks nothing until you take it off trial.'),
    err,
    h(
      'div',
      { class: 'rv-actions' },
      add,
      h(
        'button',
        {
          type: 'button',
          class: 'cui-btn cui-ghost',
          onclick: () => {
            state.newWhen = '';
            select(null);
          },
        },
        'Cancel',
      ),
    ),
  );
}
