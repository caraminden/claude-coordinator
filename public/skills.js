// A scheme's Skills page (#1062, H7 and X3 from #1047's sweep): the kit's skills, the scheme's own and the Grunt types,
// each with its trigger in plain words and how it ran in the last two weeks (Josh, 2026-11-19: "give info on
// when/where/how these skills are being used, not just what they do"). Kit skills are on by default and recommended;
// any member can turn one off for the scheme, after one confirm that says what it loses ("a scheme should be able to do
// whatever it wants"). "New skill" starts a minion with a brief the person edits first; a kit skill only for the
// Citadel scheme's members, and their Start is the go.
import { api, h, icon, threadHref, view, me } from './base.js';
import { settingsJump, settingsTabs, settingsTitle } from './settings.js';
import { openDialog } from './ui/dialog.js';
import { optimistic } from './ui/optimistic.js';

const TABS = [['kit', 'Kit skills'], ['scheme', "This scheme's own"], ['agents', 'Grunt types']];
const PHASES = ['before any edit', 'after edits', 'after an error', 'before a ship'];
let tab = 'kit';
let scope = 'scheme';
let data = null;
let pageEl = null;
let token = 0;

export function skillsPage() {
  pageEl = h('section', { class: 'artifacts-main skills-main' });
  data = null;
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

async function load() {
  const mine = ++token;
  try {
    const got = await api(`api/projects/${view.projectId}/skills${scope === 'all' ? '?all=1' : ''}`);
    if (mine !== token) return;
    data = got;
  } catch (err) {
    if (mine !== token) return;
    data = { error: err.message };
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
      TABS.map(([k, l]) => h('button', { type: 'button', 'aria-pressed': String(tab === k), onclick: () => { tab = k; draw(); } }, l, h('span', { class: 'sk-count' }, String(counts[k]))))),
    data.canKit ? h('div', { class: 'rules-seg sk-scope', role: 'group', 'aria-label': 'Counts from' },
      [['scheme', 'This scheme'], ['all', 'Every scheme']].map(([k, l]) => h('button', { type: 'button', 'aria-pressed': String(scope === k), onclick: () => { if (scope === k) return; scope = k; load(); } }, l))) : null,
    h('span', { class: 'spacer' }),
    h('button', { type: 'button', class: 'cui-btn cui-primary', onclick: newSkill }, '+ New skill'));
  pageEl.replaceChildren(head, bar, ...list());
}

const usageOf = (item) => (item.kind === 'agent' ? data.usage.agents : data.usage.skills)[item.name];

function list() {
  const items = data.items.filter((i) => (tab === 'agents' ? i.source === 'kit' && i.kind === 'agent' : tab === 'kit' ? i.source === 'kit' && i.kind === 'skill' : i.source === 'scheme'));
  const byRuns = (a, b) => (usageOf(b)?.runs ?? 0) - (usageOf(a)?.runs ?? 0) || a.name.localeCompare(b.name);
  if (tab === 'scheme' && !items.length) {
    return [h('p', { class: 'muted sk-empty' }, `${view.project?.name ?? 'This scheme'} has no skills or Grunt types of its own yet (its repo's .claude/skills and .claude/agents). `, h('button', { type: 'button', class: 'cui-btn', onclick: newSkill }, '+ New skill'))];
  }
  const intro = tab === 'kit' ? h('p', { class: 'muted small sk-intro' }, 'Every scheme gets these by default, and they are recommended. A scheme can turn any of them off; its minions stop seeing it from their next turn. Critics and reviewers have their own page, ',
    h('a', { href: `#/p/${view.projectId}/reviews` }, 'Reviewers and critics'), '.')
    : tab === 'agents' ? h('p', { class: 'muted small sk-intro' }, 'Grunts are the helpers a minion starts for a side job. These types come with the kit; they have no switch.') : null;
  const off = tab === 'kit' ? items.filter((i) => data.off.includes(i.slug)).sort(byRuns) : [];
  const on = items.filter((i) => !off.includes(i)).sort(byRuns);
  return [intro,
    off.length ? h('h3', { class: 'settings-section' }, `Off in ${view.project?.name ?? 'this scheme'}`) : null, ...off.map(row),
    off.length ? h('h3', { class: 'settings-section' }, 'On') : null, ...on.map(row)];
}

const pct = (n, of) => (of ? `${Math.round((100 * n) / of)}%` : '0%');
const top = (counts, n = 4) => Object.entries(counts ?? {}).sort((a, b) => b[1] - a[1]).slice(0, n);
const pacific = (ms) => new Date(ms).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });

function row(item) {
  const off = item.source === 'kit' && item.kind === 'skill' && data.off.includes(item.slug);
  const u = usageOf(item);
  const sw = item.source === 'kit' && item.kind === 'skill'
    ? h('button', { type: 'button', class: 'rules-switch', role: 'switch', 'aria-checked': String(!off), 'aria-label': `${item.name}: ${off ? 'off' : 'on'} in this scheme`, onclick: () => (off ? setOff(item, false) : confirmOff(item)) })
    : null;
  const chip = item.source !== 'kit' ? h('span', { class: 'cui-chip', 'data-tone': 'info' }, 'This scheme\'s')
    : item.kind === 'agent' ? h('span', { class: 'cui-chip', 'data-tone': 'neutral' }, 'Kit Grunt')
      : off ? h('span', { class: 'cui-chip', 'data-tone': 'warn' }, 'Off here') : h('span', { class: 'cui-chip', 'data-tone': 'ok' }, 'Default, recommended');
  const stats = u
    ? `${u.runs} ${u.runs === 1 ? 'run' : 'runs'} in ${u.minions} ${u.minions === 1 ? 'minion' : 'minions'} · ${pct(u.shipped, u.runs)} in minions that shipped after`
    : `Not used ${scope === 'all' ? 'in any scheme' : 'here'} in the last ${data.days} days`;
  return h('article', { class: `sk-row${off ? ' off' : ''}` },
    h('div', { class: 'sk-top' }, h('span', { class: 'sk-name' }, item.name), chip, h('span', { class: 'spacer' }), sw),
    item.trigger ? h('p', { class: 'sk-when' }, h('b', {}, 'When: '), item.trigger) : null,
    item.what ? h('p', { class: 'sk-what muted' }, item.what) : null,
    h('p', { class: 'sk-stats' }, stats),
    u ? detail(item, u) : null);
}

/** When, where and how (Josh's words): the step of the turn, the kinds of minion, the Grunts, and the last few runs. */
function detail(item, u) {
  const phases = item.kind === 'skill' ? PHASES.filter((p) => u.phases[p]).map((p) => `${p} ${pct(u.phases[p], u.runs)}`).join(' · ') : '';
  const types = top(u.types).map(([k, n]) => `${k} ${n}`).join(' · ');
  const withs = top(u.with).map(([k, n]) => `${k === 'none' ? 'no skill first' : k} ${n}`).join(' · ');
  const line = (label, text) => (text ? h('p', {}, h('b', {}, label), text) : null);
  return h('details', { class: 'sk-detail' },
    h('summary', {}, 'When, where and how'),
    line('Step of the turn: ', phases),
    line('Minion types: ', types),
    line(item.kind === 'skill' ? 'Grunts it started: ' : 'Started after: ', withs),
    h('p', {}, h('b', {}, 'Last runs: ')),
    h('ul', { class: 'sk-last' }, u.last.map((r) => h('li', {},
      h('a', { href: threadHref({ kind: 'ticket', project_id: r.project_id, number: r.number, id: 0 }) }, r.number == null ? 'Taskmaster' : `#${r.number} ${r.title}`),
      h('span', { class: 'muted' }, ` · ${pacific(r.at)}`)))));
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
