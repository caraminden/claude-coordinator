// A scheme's Skills page (#1062, H7 and X3 from #1047's sweep): the kit's skills, the scheme's own and the Grunt types,
// each with its trigger in plain words and how it ran in the last two weeks (Josh, 2026-11-19: "give info on
// when/where/how these skills are being used, not just what they do"). Kit skills are on by default and recommended;
// any member can turn one off for the scheme, after one confirm that says what it loses ("a scheme should be able to do
// whatever it wants"). "New skill" starts a minion with a brief the person edits first; a kit skill only for the
// Citadel scheme's members, and their Start is the go.
import { ago, api, h, icon, threadHref, view, me } from './base.js';
import { gloss } from './help-words.js';
import { emptyCard, hueRow, meter, schemeHue, schemeTag, showFirst, statTiles, toneChip } from './look.js';
import { settingsTabs, settingsTitle } from './settings.js';
import { openDialog } from './ui/dialog.js';
import { optimistic } from './ui/optimistic.js';

const TABS = [['kit', 'Kit skills'], ['scheme', "This scheme's own"], ['agents', 'Grunt types']];
const PHASES = ['before any edit', 'after edits', 'after an error', 'before a ship'];
let tab = 'kit';
let scope = 'scheme';
let data = null;
let pageEl = null;
let token = 0;
// Rows are ordered by their runs only when the counts were there at the first draw; counts that fill in later keep the order
// the person is looking at (no reflow without input) until they switch tab or scope.
let ranked = false;
const placed = new Map(); // a row's group, fixed while `ranked` holds: a skill someone else switches off keeps its place until this person moves

export function skillsPage() {
  pageEl = h('section', { class: 'artifacts-main skills-main' });
  data = null;
  details.clear(); // an opened row fetches fresh each visit
  draw();
  load();
  return pageEl;
}

/** The scheme's settings changed (someone switched a skill): redraw from view.project's skills_off. */
export function onSkillsChanged() {
  if (!pageEl?.isConnected || !data) return;
  data.off = (view.project?.skills_off ?? '').split(' ').filter(Boolean);
  draw();
}

/** The list comes at once, with the counts if the server has a report; else the counts follow in a second request. */
async function load() {
  const mine = ++token;
  const q = scope === 'all' ? '?all=1' : '';
  try {
    const got = await api(`api/projects/${view.projectId}/skills${q}`);
    if (mine !== token) return;
    data = got;
    ranked = !!got.usage;
    placed.clear();
  } catch (err) {
    if (mine !== token) return;
    data = { error: err.message };
  }
  draw();
  if (data.error || data.usage) return;
  try {
    const got = await api(`api/projects/${view.projectId}/skills/usage${q}`);
    if (mine !== token) return;
    data.usage = got.usage;
    data.since = got.since;
  } catch (err) {
    if (mine !== token) return;
    data.usageError = err.message;
  }
  draw();
}

function draw() {
  if (!pageEl) return;
  const head = h('div', { class: 'ticket-head' },
    h('div', { class: 'row' }, ...settingsTitle(), h('span', { class: 'spacer' }),
      h('a', { class: 'close-view', href: `#/p/${view.projectId}`, title: 'Back to the Taskmaster', 'aria-label': 'Close' }, icon('close'))),
    settingsTabs(),
    h('div', { class: 'meta' }, 'What minions and Grunts know how to do, when each skill is meant to run, and how it ran here in the last two weeks.'));
  if (!data) return pageEl.replaceChildren(head, h('p', { class: 'muted' }, 'Loading…'));
  if (data.error) return pageEl.replaceChildren(head, h('p', { class: 'error' }, data.error));
  const counts = { kit: data.items.filter((i) => i.source === 'kit' && i.kind === 'skill').length, scheme: data.items.filter((i) => i.source === 'scheme').length, agents: data.items.filter((i) => i.source === 'kit' && i.kind === 'agent').length };
  const bar = h('div', { class: 'sk-bar' },
    h('div', { class: 'rules-seg sk-tabs', role: 'group', 'aria-label': 'Show' },
      TABS.map(([k, l]) => h('button', { type: 'button', 'aria-pressed': String(tab === k), onclick: () => { tab = k; ranked = !!data.usage; placed.clear(); draw(); } }, l, h('span', { class: 'sk-count' }, String(counts[k]))))),
    data.canKit ? h('div', { class: 'rules-seg sk-scope', role: 'group', 'aria-label': 'Counts from' },
      [['scheme', 'This scheme'], ['all', 'Every scheme']].map(([k, l]) => h('button', { type: 'button', 'aria-pressed': String(scope === k), onclick: () => { if (scope === k) return; scope = k; data.usage = null; data.usageError = null; load(); } }, l))) : null,
    h('span', { class: 'spacer' }),
    h('button', { type: 'button', class: 'cui-btn cui-primary', onclick: newSkill }, '+ New skill'));
  pageEl.replaceChildren(head, bar, ...list().filter(Boolean));
}

const usageOf = (item) => (item.kind === 'agent' ? data.usage?.agents : data.usage?.skills)?.[item.name];
const isOff = (item) => item.source === 'kit' && item.kind === 'skill' && data.off.includes(item.slug);

function list() {
  const items = data.items.filter((i) => (tab === 'agents' ? i.source === 'kit' && i.kind === 'agent' : tab === 'kit' ? i.source === 'kit' && i.kind === 'skill' : i.source === 'scheme'));
  const byRuns = (a, b) => (ranked ? (usageOf(b)?.runs ?? 0) - (usageOf(a)?.runs ?? 0) : 0) || a.name.localeCompare(b.name);
  if (tab === 'scheme' && !items.length) {
    return [emptyCard(`${view.project?.name ?? 'This scheme'} has no skills or Grunt types of its own yet`, 'They live in its repo\'s .claude/skills and .claude/agents. + New skill starts a minion that writes one.', { mark: '+', hue: 'accent' })];
  }
  const intro = tab === 'kit' ? h('p', { class: 'muted small sk-intro' }, 'Every scheme gets these by default, and they are recommended. A scheme can turn any of them off; its minions stop seeing it from their next turn. What judges work (critics and reviewers) lives on ', h('a', { href: `#/p/${view.projectId}/reviews` }, 'Reviewers and critics'), '.')
    : tab === 'agents' ? h('p', { class: 'muted small sk-intro' }, [gloss('grunt', 'Grunts'), ' are the helpers a minion starts for a side job. These types come with the kit; they have no switch.']) : null;
  const max = Math.max(1, ...items.map((i) => usageOf(i)?.runs ?? 0));
  // Grouped by health only when the counts were there at the first draw: counts that fill in later keep one list in the
  // order the person is looking at (no reflow without input) until they switch tab or scope.
  if (!ranked) return [intro, h('div', { class: 'settings-rows sk-rows' }, ...items.sort(byRuns).map((i) => row(i, max)))];
  const group = (i) => {
    if (!placed.has(keyOf(i))) placed.set(keyOf(i), { Off: 'off', Busy: 'busy' }[health(i)[1]] ?? 'look');
    return placed.get(keyOf(i));
  };
  const groups = [['Needs a look', 'waiting', 'look'], ['Busy', 'done', 'busy'], [`Off in ${view.project?.name ?? 'this scheme'}`, 'muted', 'off']];
  return [intro, ...groups.flatMap(([title, hue, g]) => {
    const xs = items.filter((i) => group(i) === g).sort(byRuns);
    return xs.length ? [h('h3', { class: 'settings-section', 'data-hue': hue }, title, h('span', { class: 'sk-count' }, String(xs.length))), h('div', { class: 'settings-rows sk-rows' }, ...xs.map((i) => row(i, max)))] : [];
  })];
}

const pct = (n, of) => (of ? Math.round((100 * n) / of) : 0);
const top = (counts, n = 4) => Object.entries(counts ?? {}).sort((a, b) => b[1] - a[1]).slice(0, n);
const short = (name) => name.replace(/^citadel:/, '');
const k = (n) => (n >= 10000 ? `${Math.floor(n / 1000)}k` : n >= 1000 ? `${Math.floor(n / 100) / 10}k` : String(n)); // a count never wraps the line on a phone: 5.6k, 99k
const HUE = { ok: 'done', warn: 'waiting', danger: 'danger', neutral: 'muted' };
const PHASE_TONE = { 'before any edit': 'info', 'after edits': 'violet', 'after an error': 'danger', 'before a ship': 'ok' };
const minionLink = (r) => h('a', { href: threadHref({ kind: r.number == null ? 'coordinator' : 'ticket', project_id: r.project_id, number: r.number, id: 0 }) }, r.number == null ? 'Taskmaster' : `#${r.number}`, r.number == null ? null : h('span', { class: 'sk-title' }, ` ${r.title}`));

/** The type it opened in most (by minions) out of that type's minions at work in the window: "12 of 300 feature minions". */
function rateOf(u) {
  const active = data.usage?.active ?? {};
  const [type, did] = top(u?.typeMinions, 99).find(([t]) => active[t]) ?? [];
  return type ? { type, did, of: active[type] } : null;
}

/** A row's health (Josh picked take B, "Health first", on #1082's choices page, 2026-11-19): [tone, word]. */
function health(item) {
  if (isOff(item)) return ['neutral', 'Off'];
  if (!data.usage) return null;
  const u = usageOf(item);
  if (!u) return ['danger', 'Unused'];
  const r = rateOf(u);
  if (r && pct(r.did, r.of) < 40) return ['warn', 'Quiet'];
  if (u.runs < 10) return ['warn', 'Rare'];
  return ['ok', 'Busy'];
}

const details = new Map(); // `${scope}|${kind}|${name}` → the opened row's data, or a promise of it
const opened = new Map(); // the same key → the tab a person picked in it
const openRows = new Set();
const bodies = new Map(); // the same key → the body on screen, which a late answer fills (a redraw replaces it)
const drafts = new Map(); // the same key → a Tune brief the person edited
const keyOf = (item) => `${scope}|${item.kind}|${item.name}`;

/** One line per skill: its health, name and trigger, calls in the window on a bar, and the last call; it opens in place. */
function row(item, max) {
  const u = usageOf(item);
  const hl = health(item);
  const key = keyOf(item);
  const body = h('div', { class: 'settings-row-body sk-body' });
  const el = h('details', { class: 'settings-row sk-row', 'data-hue': hl ? HUE[hl[0]] : 'muted', open: openRows.has(key),
    ontoggle: (e) => { if (e.currentTarget.open) { openRows.add(key); fill(item, body); } else openRows.delete(key); } },
    h('summary', {},
      h('span', { class: 'sk-health' }, hl ? toneChip(hl[0], hl[1]) : h('span', { class: 'sk-ghost', 'aria-label': 'Loading counts' })),
      h('span', { class: 'settings-row-text' }, h('span', { class: 'settings-row-title sk-name' }, short(item.name), item.source === 'scheme' ? h('i', { class: 'muted' }, ' · own') : null),
        h('span', { class: 'settings-row-sum' }, item.trigger || item.what)),
      h('span', { class: 'sk-calls', 'data-hue': 'running', 'data-tip': `Calls in the last ${data.days} days` },
        !data.usage ? (data.usageError ? h('span', { class: 'muted', title: data.usageError }, '?') : h('span', { class: 'sk-ghost' })) : meter(Math.sqrt(u?.runs ?? 0) / Math.sqrt(max), k(u?.runs ?? 0))),
      h('span', { class: 'sk-last muted', title: u?.last[0] ? pacific(u.last[0].at) : '' }, !data.usage ? '' : u?.last[0] ? ago(u.last[0].at) : 'never'),
      h('span', { class: 'settings-row-chev' }, icon('forward'))),
    body);
  if (el.open) fill(item, body);
  return el;
}

const pacific = (ms) => new Date(ms).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });

/** The opened row: what a session sees, three tabs (where it ran, why not more, tune), and the off switch. */
function fill(item, body) {
  const key = keyOf(item);
  const u = usageOf(item);
  const r = rateOf(u);
  const hl = health(item);
  bodies.set(key, body);
  let d = details.get(key);
  if (!d) {
    // A scheme's own skill counts only its own scheme: another scheme's skill of the same name is another skill.
    const q = new URLSearchParams({ name: item.name, kind: item.kind, ...(scope === 'all' && item.source === 'kit' ? { all: '1' } : {}) });
    d = api(`api/projects/${view.projectId}/skills/detail?${q}`).then((got) => details.set(key, got), (err) => details.set(key, { error: err.message })).then(() => {
      const on = bodies.get(key);
      if (on?.isConnected) fill(item, on);
      if (details.get(key)?.error) details.delete(key); // shown once; the next open asks again
    });
    details.set(key, d);
  }
  const ready = d instanceof Promise ? null : d;
  const tab = opened.get(key) ?? (hl?.[1] === 'Busy' ? 'where' : 'why');
  const tabs = h('div', { class: 'rules-seg sk-itabs', role: 'group', 'aria-label': 'Show' },
    [['where', 'Where it ran', u?.minions ?? 0], ['why', 'Why not more', r ? r.of - r.did : null], ['tune', 'Tune', null]].map(([t, l, n]) =>
      h('button', { type: 'button', 'aria-pressed': String(tab === t), onclick: () => { opened.set(key, t); fill(item, body); } }, l, n != null ? h('span', { class: 'sk-count' }, k(n)) : null)));
  const pane = !ready ? h('div', { class: 'sk-pane sk-loading', 'aria-busy': 'true' }, h('span', { class: 'sk-ghost' }), h('span', { class: 'sk-ghost' }))
    : ready.error ? h('p', { class: 'error' }, ready.error)
      : tab === 'where' ? where(item, u, r, ready) : tab === 'why' ? whyNot(item, u, ready) : tune(item, u, r, ready);
  const off = isOff(item);
  const foot = h('div', { class: 'sk-foot' },
    tab === 'tune' ? null : h('button', { type: 'button', class: 'cui-btn', onclick: () => { opened.set(key, 'tune'); fill(item, body); } }, '✦ Tune with a minion'),
    h('span', { class: 'spacer' }),
    item.source === 'kit' && item.kind === 'skill' ? h('label', { class: 'sk-switch' }, off ? `Off in ${view.project?.name ?? 'this scheme'}` : `On in ${view.project?.name ?? 'this scheme'}`,
      h('button', { type: 'button', class: 'rules-switch', role: 'switch', 'aria-checked': String(!off), 'aria-label': `${item.name}: ${off ? 'off' : 'on'} in this scheme`, onclick: () => (off ? setOff(item, false) : confirmOff(item)) }))
      : h('span', { class: 'muted small' }, item.source === 'scheme' ? 'This scheme\'s own' : 'A kit Grunt type: no switch'));
  body.replaceChildren(...[ // replaceChildren writes a null as "null"
    item.what ? h('p', { class: 'look-prose' }, item.what) : null,
    item.trigger ? h('p', { class: 'look-prose' }, h('b', {}, 'When it runs: '), item.trigger) : null,
    tabs, pane, foot].filter(Boolean));
}

function where(item, u, r, d) {
  if (!u) return h('div', { class: 'sk-pane' }, emptyCard(`Not opened ${scope === 'all' ? 'in any scheme' : 'here'} in ${data.days} days`, isOff(item) ? 'It\'s off in this scheme, so minions can\'t see it.' : 'No minion, Taskmaster or Grunt opened it.', { mark: '–', hue: 'waiting' }));
  const withs = top(u.with).map(([n, c]) => `${n === 'none' ? 'no skill first' : short(n)} ${c}`).join(' · ');
  return h('div', { class: 'sk-pane' },
    statTiles([k(u.runs), u.runs === 1 ? 'call' : 'calls'], [k(u.minions), u.minions === 1 ? 'minion' : 'minions', 'teal'], [k(u.shipped), 'later shipped', 'done'],
      r && [`${pct(r.did, r.of)}%`, `of ${r.type} minions`, pct(r.did, r.of) < 40 ? 'waiting' : 'done']),
    h('div', { class: 'sk-tags' }, ...top(u.types, 6).map(([t, n]) => schemeTag(t, `${t} ${n}`)),
      ...(item.kind === 'skill' ? PHASES.filter((p) => u.phases[p]).map((p) => toneChip(PHASE_TONE[p], `${p} ${pct(u.phases[p], u.runs)}%`)) : [])),
    withs ? h('p', { class: 'look-prose' }, item.kind === 'skill' ? 'Grunts it started: ' : 'Started after: ', withs) : null,
    showFirst({ key: `${keyOf(item)}|used`, noun: 'minions', items: d.used.map((m) => hueRow({ cat: schemeHue(m.type), lead: m.runs, meta: `${Object.keys(m.phases)[0] ? `${Object.keys(m.phases)[0]} · ` : ''}${ago(m.at)}` }, minionLink(m))) }),
    d.used.length < u.minions ? h('p', { class: 'look-prose' }, `The newest ${d.used.length} of ${u.minions}.`) : null);
}

/** Josh's picks (#1082's grilling, 2026-11-19): the type's rate with the misses, and named but never opened. Only what happened. */
function whyNot(item, u, d) {
  const what = item.kind === 'skill' ? 'opened it' : 'started one';
  const types = d.types.filter((t) => t.active).slice(0, 3);
  const parts = [];
  if (types.length) parts.push(h('div', { class: 'sk-rates' }, ...types.map((t) => h('div', { class: 'sk-rate', 'data-hue': pct(t.opened, t.active) < 40 ? 'waiting' : 'done' },
    meter(t.opened / t.active, [h('b', {}, `${k(t.opened)} of ${k(t.active)}`), ` ${t.type} minions ${what}`])))));
  if (d.misses?.total) {
    parts.push(h('h4', { class: 'sk-h', 'data-hue': 'waiting' }, `${d.misses.type} minions that didn't`, h('span', { class: 'sk-count' }, k(d.misses.total))),
      showFirst({ key: `${keyOf(item)}|miss`, noun: 'shown', items: d.misses.rows.map((m) => hueRow({ hue: 'waiting', meta: m.opened.length ? `opened ${m.opened.slice(0, 2).map(short).join(', ')}${m.opened.length > 2 ? ` +${m.opened.length - 2}` : ''}` : item.kind === 'skill' ? 'opened no skill' : 'started no Grunt' }, minionLink(m))) }));
    if (d.misses.total > d.misses.rows.length) parts.push(h('p', { class: 'look-prose' }, `The newest ${d.misses.rows.length} of ${d.misses.total}.`));
  }
  if (d.named.total) {
    parts.push(h('h4', { class: 'sk-h', 'data-hue': 'held' }, 'Named, never opened', h('span', { class: 'sk-count' }, k(d.named.total))),
      showFirst({ key: `${keyOf(item)}|named`, n: 3, noun: 'shown', items: d.named.rows.map((m) => hueRow({ hue: 'held', meta: ago(m.at) }, minionLink(m), h('q', { class: 'sk-quote' }, ...quote(m.quote, item.name)))) }),
      h('p', { class: 'look-prose' }, `A message to these minions named ${item.name} and they never opened it. A minion can still do the work without opening the skill (a grilling round asked as cards), so read the chat before calling it a miss.`));
  }
  if (!parts.length) parts.push(u ? emptyCard('No misses to show', item.source === 'kit' ? 'Every minion of the type that uses it most did, and none was sent its name and didn\'t.' : 'Every minion of the type that uses it most did.')
    : item.source === 'kit' ? emptyCard('Nothing named it either', `No minion opened it or was sent a message naming ${item.name} in ${data.days} days.`, { mark: '0', hue: 'muted' })
      : emptyCard('No minion opened it', `Not in ${data.days} days. Messages are checked only for kit names (citadel:…), so one that asked for it by its bare name doesn't show here.`, { mark: '0', hue: 'muted' }));
  else parts.push(h('p', { class: 'look-prose' }, 'These say what happened, not what should have: a minion can be right not to use it.'));
  return h('div', { class: 'sk-pane' }, ...parts);
}

/** The quote with the skill's name marked. */
function quote(text, name) {
  const i = text.indexOf(name);
  return i < 0 ? [text] : [text.slice(0, i), h('mark', {}, name), text.slice(i + name.length)];
}

/** "Tune with a minion": a brief the person can edit, then Start. A kit skill or Grunt type goes to the Citadel scheme, for its members (canKit). */
function tune(item, u, r, d) {
  const kit = item.source === 'kit';
  if (kit && !data.canKit) return h('div', { class: 'sk-pane' }, emptyCard('Tuning a kit skill is for Citadel scheme members', 'A kit change reaches every scheme. Ask one of them, with what you see on this page.', { mark: 'i', hue: 'muted' }));
  const text = h('textarea', { class: 'cui-input sk-brief', rows: 12, 'aria-label': 'Brief' });
  text.value = drafts.get(keyOf(item)) ?? tuneBrief(item, u, r, d);
  text.addEventListener('input', () => drafts.set(keyOf(item), text.value));
  const err = h('p', { class: 'error', hidden: true });
  const start = h('button', { type: 'button', class: 'cui-btn cui-primary', onclick: async () => {
    start.disabled = true;
    try {
      const t = await api(`api/projects/${kit ? data.kitScheme : view.projectId}/tickets`, { method: 'POST', body: { title: `Tune ${item.kind === 'agent' ? 'Grunt type' : 'skill'}: ${short(item.name)}`, message: text.value, properties: { type: 'chore' } } });
      drafts.delete(keyOf(item));
      location.hash = threadHref(t);
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
      start.disabled = false;
    }
  } }, 'Start the minion');
  return h('div', { class: 'sk-pane' },
    h('p', { class: 'look-prose' }, `A minion reads these chats, works out why it ran or didn't, and proposes a change on a card. It ships only on your go.${kit ? ' It starts in the Citadel scheme, since the kit is every scheme\'s.' : ''}`),
    text, err, h('div', { class: 'sk-actions' }, start));
}

function tuneBrief(item, u, r, d) {
  const slug = item.slug;
  const file = item.source === 'kit' ? (item.kind === 'agent' ? `kit/agents/${slug}.md` : `kit/skills/${slug}/SKILL.md`) : (item.kind === 'agent' ? `.claude/agents/${slug}.md` : `.claude/skills/${slug}/SKILL.md`);
  const target = item.source === 'kit' ? data.kitScheme : view.projectId;
  const where = scope === 'all' ? 'every scheme' : view.project?.name ?? 'this scheme';
  const ref = (m) => {
    const scheme = m.project_id === target ? '' : `${(view.projects ?? []).find((p) => p.id === m.project_id)?.name ?? `scheme ${m.project_id}`} `;
    return m.number == null ? `${scheme}Taskmaster` : `${scheme}#${m.number} (${m.title})`;
  };
  const list = (rows, n, line) => rows.slice(0, n).map((m) => `- ${ref(m)}${line ? `: ${line(m)}` : ''}`);
  return [
    `Tune ${item.kind === 'agent' ? 'the Grunt type' : 'the skill'} \`${item.name}\` (${file}) so sessions use it when they should and not otherwise.`,
    '',
    `What its description says now: ${item.what}${item.trigger ? ` ${item.trigger}` : ''}`,
    '',
    `How it ran in ${where}, last ${data.days} days (from the Skills page):`,
    u ? `- ${u.runs} calls in ${u.minions} minions; ${u.shipped} in minions that later shipped.` : '- Never opened.',
    ...(r ? [`- ${r.did} of ${r.of} ${r.type} minions opened it.`] : []),
    ...(d?.used?.length ? ['', 'Some that opened it:', ...list(d.used, 5)] : []),
    ...(d?.misses?.total ? ['', `${d.misses.type} minions that didn't (${d.misses.total}), with what they opened instead:`, ...list(d.misses.rows, 8, (m) => m.opened.map(short).join(', ') || 'nothing')] : []),
    ...(d?.named?.total ? ['', `Sent a message naming it, never opened it (${d.named.total}):`, ...list(d.named.rows, 6, (m) => `"${m.quote}"`)] : []),
    '',
    'Open `citadel:writing-for-agents` first and follow it. Read a few of those chats and work out why each one used it or didn\'t: the description or trigger didn\'t match the moment, the skill wasn\'t needed there, or the work got done without opening it. The counts say what happened, not what should have.',
    `Then propose the change (the description, the trigger, the body, or no change) as a before and after, with the evidence, on a card for ${me?.name ?? 'the person who started this'}. Ship only on their go.`,
    `Started from the Skills page by ${me?.name ?? 'a member'}.`,
  ].join('\n');
}

function confirmOff(item) {
  const warn = data.warnings[item.slug];
  const u = usageOf(item);
  const dlg = openDialog({
    title: `Turn off ${item.name}?`,
    className: 'sk-confirm',
    body: [
      h('p', {}, `It's a Citadel default and recommended. Off, ${view.project?.name ?? 'this scheme'}'s minions won't see it from their next turn, and steps that name it are skipped.`),
      warn ? h('p', { class: 'cui-notice', 'data-tone': 'warn' }, warn) : null,
      u ? h('p', { class: 'muted small' }, `It ran ${u.runs} times here in the last ${data.days} days.`) : null,
      h('div', { class: 'sk-actions' },
        h('button', { type: 'button', class: 'cui-btn', onclick: () => dlg.close() }, 'Keep it on'),
        h('button', { type: 'button', class: 'cui-btn cui-danger', onclick: () => { dlg.close(); setOff(item, true); } }, 'Turn it off')),
    ],
  });
}

/** Saves at once and rolls back with a toast if the save fails (Cara 2026-11-08). */
function setOff(item, off) {
  const p = view.project;
  const was = data.off;
  const next = off ? [...new Set([...was, item.slug])].sort() : was.filter((s) => s !== item.slug);
  optimistic({
    key: `scheme-settings:${p.id}`,
    apply: () => { data.off = next; if (view.project?.id === p.id) view.project.skills_off = next.join(' '); draw(); },
    send: () => api(`api/projects/${p.id}`, { method: 'PATCH', body: { skills_off: next } }),
    undo: () => { data.off = was; if (view.project?.id === p.id) view.project.skills_off = was.join(' '); draw(); },
    label: `turn ${item.name} ${off ? 'off' : 'on'}`,
  });
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,40}$/;

function brief({ name, what, when, kit }) {
  const n = name || '<name>';
  const where = kit ? `the Citadel kit, as kit/skills/${n}/SKILL.md, so every scheme loads it as \`citadel:${n}\`` : `this scheme's repo, as .claude/skills/${n}/SKILL.md`;
  return [
    `Build a new skill, \`${n}\`, in ${where}.`,
    '',
    `What it does: ${what || '(say what it does)'}`,
    `When it should run: ${when || '(say when a session should open it)'}`,
    '',
    'Open `citadel:writing-for-agents` first and follow it: check the Skills page and the skills already loaded for one that covers this (extend that one instead), write the description so it triggers when it should and not otherwise, keep the body short, and test it on a fresh session before shipping.',
    kit ? 'A kit skill reaches every scheme: read kit/README.md, and check for twins and conflicts in kit/skills and kit/agents first. Starting this from the Skills page is the go to build it (Josh, 2026-11-19).' : '',
    `Started from the Skills page by ${me?.name ?? 'a member'}.`,
  ].filter((l, i, a) => l || a[i - 1]).join('\n');
}

function newSkill() {
  const name = h('input', { type: 'text', class: 'cui-input', placeholder: 'e.g. release-notes', spellcheck: 'false', autocomplete: 'off' });
  const what = h('textarea', { class: 'cui-input', rows: 2, placeholder: 'Writes the release notes from the shipped minions' });
  const when = h('textarea', { class: 'cui-input', rows: 2, placeholder: 'Before a release, or when someone asks for notes' });
  const where = data.canKit ? h('div', { class: 'rules-seg', role: 'group', 'aria-label': 'Where it goes' },
    [['scheme', "This scheme's repo"], ['kit', 'The kit (every scheme)']].map(([k, l]) => h('button', { type: 'button', 'data-k': k, 'aria-pressed': String(k === 'scheme'), onclick: () => { for (const b of where.children) b.setAttribute('aria-pressed', String(b.dataset.k === k)); sync(); } }, l))) : null;
  const text = h('textarea', { class: 'cui-input sk-brief', rows: 10 });
  const err = h('p', { class: 'error', hidden: true });
  let edited = false;
  const kit = () => !!where?.querySelector('[aria-pressed=true][data-k=kit]');
  const sync = () => { if (!edited) text.value = brief({ name: name.value.trim(), what: what.value.trim(), when: when.value.trim(), kit: kit() }); };
  for (const el of [name, what, when]) el.addEventListener('input', sync);
  text.addEventListener('input', () => { edited = true; });
  sync();
  const start = h('button', { type: 'button', class: 'cui-btn cui-primary', onclick: async () => {
    const slug = name.value.trim();
    if (!SLUG.test(slug)) { err.textContent = 'Name it in lowercase letters, digits and dashes, like release-notes.'; err.hidden = false; return name.focus(); }
    start.disabled = true;
    try {
      const scheme = kit() ? data.kitScheme : view.projectId;
      const t = await api(`api/projects/${scheme}/tickets`, { method: 'POST', body: { title: `New ${kit() ? 'kit ' : ''}skill: ${slug}`, message: text.value, properties: { type: 'feature' } } });
      dlg.close();
      location.hash = threadHref(t);
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
      start.disabled = false;
    }
  } }, 'Start the minion');
  const label = (t, el) => h('label', { class: 'sk-field' }, h('span', {}, t), el);
  const dlg = openDialog({
    title: 'New skill',
    className: 'sk-new',
    body: [
      h('p', { class: 'muted small' }, 'A minion writes it from this brief. Edit the brief as you like, then start it.'),
      label('Name', name), label('What it does', what), label('When it should run', when),
      where ? label('Where it goes', where) : null,
      label('Brief', text), err,
      h('div', { class: 'sk-actions' }, h('button', { type: 'button', class: 'cui-btn', onclick: () => dlg.close() }, 'Cancel'), start),
    ],
  });
  name.focus();
}
