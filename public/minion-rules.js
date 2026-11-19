// The Minion rules page's pickers (#1041, Cara 2026-11-19: "make as much of it as possible into toggles and buttons and
// pickers, with manual text entry as a fallback"). Each row reads the same stored text the old text box did and writes it
// back at once (settings.js's saveProject: optimistic, a toast with Retry on a refusal); typed entry stays as "Add by hand".
import { toast } from './ui/status.js';
import { account, h, icon, listGroupsOf, view } from './base.js';

export const lines = (text) => (text ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
const text = (list) => [...new Set(list)].join('\n');

/** Actions a person can tick to be asked first, each the permission rules it stands for (Claude Code's rule syntax). */
export const APPROVALS = [
  { id: 'merge', what: 'Merge a pull request', rules: ['Bash(gh pr merge:*)', 'mcp__*__merge_pull_request'] },
  { id: 'automerge', what: 'Turn on auto-merge', rules: ['mcp__*__enable_pr_auto_merge'] },
  { id: 'release', what: 'Publish a GitHub release', rules: ['Bash(gh release create:*)'] },
  { id: 'workflow', what: 'Run a CI workflow by hand', rules: ['Bash(gh workflow run:*)'] },
  { id: 'tags', what: 'Push tags', rules: ['Bash(git push --tags:*)'] },
  { id: 'docs', what: 'Edit CLAUDE.md, skills or rules', rules: ['Edit(CLAUDE.md)', 'Edit(.claude/**)'] },
  { id: 'close', what: 'Close a pull request or issue', rules: ['Bash(gh pr close:*)', 'Bash(gh issue close:*)'] },
];
/** A box is ticked when all its rules are stored. */
export const ticked = (stored) => APPROVALS.filter((a) => a.rules.every((r) => stored.includes(r)));
/** Tick or untick one box in a stored rule list; returns the new stored text. */
export function toggleApproval(stored, id, on) {
  const rules = APPROVALS.find((a) => a.id === id).rules;
  const kept = lines(stored).filter((r) => !rules.includes(r));
  return text(on ? [...lines(stored), ...rules] : kept);
}
/** The stored rules no ticked box owns: what "Add by hand" shows. */
export const handRules = (stored) => { const owned = new Set(ticked(lines(stored)).flatMap((a) => a.rules)); return lines(stored).filter((r) => !owned.has(r)); };

/** Where a plugin folder is stored: 'off', 'picked' (optional_plugin_dirs) or 'every' (plugin_dirs). */
export const pluginMode = (p, dir) => (lines(p.plugin_dirs).includes(dir) ? 'every' : lines(p.optional_plugin_dirs).includes(dir) ? 'picked' : 'off');
/** The two stored lists after moving `dir` to `mode`. */
export function setPluginMode(p, dir, mode) {
  const drop = (s) => lines(s).filter((d) => d !== dir);
  return {
    plugin_dirs: text(mode === 'every' ? [...lines(p.plugin_dirs), dir] : drop(p.plugin_dirs)),
    optional_plugin_dirs: text(mode === 'picked' ? [...lines(p.optional_plugin_dirs), dir] : drop(p.optional_plugin_dirs)),
  };
}

/** A workflow is on (wakes the Taskmaster) unless it is quiet and not also watched, as ci-health's snapshot reads it. */
export const ciOn = (p, file) => !lines(p.ci_quiet).includes(file) || lines(p.ci_watch).includes(file);
/** The two stored lists after switching `file`: on leaves the quiet list, off joins it and leaves the watch list. */
export function setCi(p, file, on) {
  const quiet = lines(p.ci_quiet).filter((f) => f !== file), watch = lines(p.ci_watch).filter((f) => f !== file);
  return on ? { ci_quiet: text(quiet), ci_watch: text(lines(p.ci_watch)) } : { ci_quiet: text([...quiet, file]), ci_watch: text(watch) };
}

const verdictClass = (c) => (c === 'success' ? 'ready' : c === 'failure' ? 'down' : c ? 'asleep' : 'running');

/**
 * The rows, built with the page's own parts: settingsRow and settingsHelp (settings.js) and saveProject, which sends a
 * PATCH of `body` behind an optimistic `mine` (what view.project then holds).
 */
const SHOT_WIDTHS = [[1440, 'Desktop 1440'], [1024, 'Laptop 1024'], [768, 'Tablet 768'], [390, 'Phone 390']];
const shotList = (text) => (text ?? '').split(',').map(Number).filter((w) => w > 0);

export function pickers({ settingsRow, settingsHelp, saveProject }) {
  const p = view.project;
  const stored = () => view.project;
  // Read once the page opens (settings.js), then every row redraws.
  const data = { found: [], registry: [], workflows: [], failed: {} };
  /** A row that redraws its body from view.project whenever the project changes (onProjectUpdate dispatches settings-refresh). */
  const live = (meta, help, draw, ...after) => {
    const mount = h('div', { class: 'rules-body' });
    const [row, sum] = settingsRow(meta, help, mount, ...after);
    const paint = () => { const s = draw(mount); sum.textContent = s; };
    row.dataset.rulesRow = '';
    row.addEventListener('settings-refresh', paint);
    paint();
    return row;
  };
  const refreshAll = () => { for (const el of document.querySelectorAll('[data-rules-row]')) el.dispatchEvent(new Event('settings-refresh')); };
  /** Save these fields at once. `fields` are the stored strings; list_groups goes as a list. */
  const save = (fields, label) => {
    const body = { ...fields };
    if ('list_groups' in fields) body.list_groups = JSON.parse(fields.list_groups);
    return saveProject(p, fields, body, label, refreshAll);
  };
  const seg = (opts, cur, onPick, disabled = false, label = '') => h('div', { class: 'rules-seg', role: 'group', 'aria-label': label },
    opts.map(([v, l]) => h('button', { type: 'button', 'aria-pressed': String(cur === v), disabled, onclick: () => cur !== v && onPick(v) }, l)));
  /** "Add by hand": a button that opens one line to type in; Enter or Add sends it. */
  const handLine = (placeholder, onAdd, label = 'Add by hand') => {
    const input = h('input', { type: 'text', class: 'rules-hand-input', placeholder, spellcheck: 'false', 'aria-label': label, hidden: true });
    const add = h('button', { type: 'button', hidden: true, onclick: () => go() }, 'Add');
    const open = h('button', { type: 'button', class: 'rules-hand', onclick: () => { input.hidden = add.hidden = false; open.hidden = true; input.focus(); } }, label);
    const go = () => { const v = input.value.trim(); if (!v) return; onAdd(v); input.value = ''; };
    input.addEventListener('keydown', (e) => e.key === 'Enter' && (e.preventDefault(), go()));
    return h('div', { class: 'rules-pick' }, open, input, add);
  };

  const approvals = () => {
    const key = 'approval_rules';
    const area = h('textarea', { class: 'instructions-text settings-list', id: 'approval-rules', rows: 3, spellcheck: 'false', placeholder: 'Bash(tools/deploy.sh:*)', 'aria-label': 'Rules added by hand', hidden: true });
    const saveBtn = h('button', { type: 'button' }, 'Save'), discardBtn = h('button', { type: 'button', class: 'secondary' }, 'Discard');
    const handOpen = h('button', { type: 'button', class: 'rules-hand', onclick: () => { area.hidden = false; actions.hidden = false; handOpen.hidden = true; area.focus(); } }, 'Add by hand');
    const actions = h('div', { class: 'settings-row-actions', hidden: true }, saveBtn, discardBtn);
    const dirty = () => lines(area.value).join('\n') !== handRules(stored()[key]).join('\n');
    const sync = () => { area.toggleAttribute('data-draft', dirty()); saveBtn.disabled = discardBtn.disabled = !dirty(); };
    area.addEventListener('input', sync);
    saveBtn.onclick = () => save({ [key]: text([...ticked(lines(stored()[key])).flatMap((a) => a.rules), ...lines(area.value)]) }, 'save approval rules');
    discardBtn.onclick = () => { area.value = handRules(stored()[key]).join('\n'); sync(); };
    return live({ icon: 'shield', hue: 'waiting', title: 'Needs approval' },
      settingsHelp('Tool calls that wait for Approve or Deny in the minion\'s chat.', 'Tick an action to be asked before a minion does it; everything else runs without asking.'),
      (mount) => {
        const rules = lines(stored()[key]);
        const on = ticked(rules);
        mount.replaceChildren(h('div', { class: 'rules-checks' },
          APPROVALS.map((a) => h('label', { class: 'rules-check' },
            h('input', { type: 'checkbox', checked: on.includes(a), onchange: (e) => save({ [key]: toggleApproval(stored()[key], a.id, e.target.checked) }, `${e.target.checked ? 'ask before' : 'stop asking before'}: ${a.what.toLowerCase()}`) }),
            h('span', { class: 'rules-what' }, h('span', {}, a.what), h('code', {}, a.rules.join('  '))))),
          h('div', { class: 'rules-check locked' }, h('input', { type: 'checkbox', checked: true, disabled: true }),
            h('span', { class: 'rules-what' }, h('span', {}, 'Push to main, force-push, reset over work'), h('code', {}, 'always blocked by the tripwire, in every scheme')))),
          h('p', { class: 'cui-notice small' }, 'Bash rules match how a command starts: they catch mistakes, not a determined workaround.'));
        if (!area.hasAttribute('data-draft')) area.value = handRules(stored()[key]).join('\n');
        if (area.value && area.hidden) handOpen.click();
        sync();
        const n = handRules(stored()[key]).length;
        return on.length || n ? `Asks before: ${[...on.map((a) => a.what), ...(n ? [`${n} by hand`] : [])].join(', ')}` : 'Nothing asks first';
      }, handOpen, area, actions);
  };

  const plugins = () => {
    const hand = handLine('tools/mods/my-plugin', (dir) => save(setPluginMode(stored(), dir.replace(/\/+$/, '').replace(/^\.\//, ''), 'picked'), 'add a plugin folder'));
    return live({ icon: 'plug', hue: 'held', title: 'Plugins' },
    settingsHelp('Plugin folders found in this scheme\'s repo.', 'Picked loads one only for minions that pick it (the Plugins picker beside Send); Every minion loads it on every turn. Only an admin changes these.'),
    (mount) => {
      const s = stored(), admin = !!account?.admin;
      const found = data.found, known = new Set(found.map((f) => f.dir));
      const stray = [...new Set([...lines(s.plugin_dirs), ...lines(s.optional_plugin_dirs)])].filter((d) => !known.has(d)).map((dir) => ({ dir, name: dir.split('/').pop(), description: '', missing: true }));
      const all = [...found, ...stray];
      mount.replaceChildren(
        ...all.map((f) => h('div', { class: 'rules-item' },
          h('span', { class: 'rules-what' }, h('b', {}, f.name), h('code', {}, f.dir), f.missing ? h('span', { class: 'muted small' }, 'not found in the repo') : f.description ? h('span', { class: 'muted small' }, f.description) : ''),
          seg([['off', 'Off'], ['picked', 'Picked'], ['every', 'Every minion']], pluginMode(s, f.dir), (mode) => save(setPluginMode(stored(), f.dir, mode), `set ${f.name} to ${mode}`), !admin, f.name))),
        all.length ? '' : h('p', { class: 'muted small' }, 'No plugin folders in this scheme\'s repo yet.'),
        data.failed.plugins ? h('p', { class: 'error small' }, 'Couldn\'t read the repo\'s plugin folders: reload to retry.') : '',
        admin ? hand : h('p', { class: 'muted small' }, 'Only an admin changes these.'));
      const on = all.filter((f) => pluginMode(s, f.dir) !== 'off');
      return on.length ? `${on.length} on: ${on.map((f) => f.name).join(', ')}` : 'None on';
    });
  };

  const listGroups = () => {
    let key = '';
    const hand = handLine('area: balance', (line) => { const groups = listGroupsOf(stored()); save({ list_groups: JSON.stringify([...groups.filter((g) => g !== line), line]) }, `add the group ${line}`); });
    return live({ icon: 'rows', hue: 'teal', title: 'List groups' },
      settingsHelp('Minions outside a build that carry one of these get their own group at the top of the minions list.', 'A minion that matches two sits in the first.'),
      (mount) => {
        const registry = data.registry;
        if (!registry.some((k) => k.key === key)) key = registry[0]?.key ?? '';
        const groups = listGroupsOf(stored());
        const values = registry.find((k) => k.key === key)?.values ?? [];
        const commit = (next, label) => save({ list_groups: JSON.stringify(next) }, label);
        const select = h('select', { 'aria-label': 'Property', onchange: (e) => { key = e.target.value; refreshAll(); } },
          registry.map((k) => h('option', { value: k.key, selected: k.key === key }, k.key)));
        mount.replaceChildren(
          registry.length ? h('div', { class: 'rules-pick' }, select, h('span', { class: 'muted small' }, 'tap a value to add it')) : '',
          h('div', { class: 'rules-chips' }, values.map((v) => {
            const line = `${key}: ${v}`, on = groups.includes(line);
            return h('button', { type: 'button', class: 'rules-chip', 'aria-pressed': String(on),
              onclick: () => commit(on ? groups.filter((g) => g !== line) : [...groups, line], `${on ? 'remove' : 'add'} the group ${line}`) }, on ? icon('check') : '+', ' ', v);
          })),
          groups.length ? h('div', { class: 'rules-order' }, groups.map((g, i) => h('div', { class: 'rules-ord' }, h('span', {}, `${i + 1}. ${g}`),
            h('button', { type: 'button', class: 'rules-mini', disabled: !i, 'aria-label': `Move ${g} up`, onclick: () => commit(groups.map((g2, j) => (j === i - 1 ? groups[i] : j === i ? groups[i - 1] : g2)), `move ${g} up`) }, '↑'),
            h('button', { type: 'button', class: 'rules-mini', 'aria-label': `Remove ${g}`, onclick: () => commit(groups.filter((_, j) => j !== i), `remove the group ${g}`) }, '✕'))))
            : h('p', { class: 'muted small' }, 'No groups yet.'),
          hand);
        return groups.length ? `${groups.length} group${groups.length > 1 ? 's' : ''}: ${groups.join(', ')}` : 'No groups yet';
      });
  };

  const ci = () => {
    const hand = handLine('nightly.yml', (file) => { const f = file.replace(/^\.?\/?\.github\/workflows\//, ''); save(setCi({ ...stored(), ci_watch: text([...lines(stored().ci_watch), f]) }, f, true), 'watch a workflow'); });
    return live({ icon: 'belloff', hue: 'running', title: 'CI alerts' },
    settingsHelp('This scheme\'s workflows, from the CI page. On wakes the Taskmaster when one goes red on the default branch; Off keeps it quiet (the CI page still shows it).',
      'A red run starts a fix and says when it is green again. A minion that dispatched a run on its own branch still hears its result.'),
    (mount) => {
      const s = stored(), workflows = data.workflows;
      const files = new Set(workflows.map((w) => w.file));
      const all = [...workflows, ...[...lines(s.ci_quiet), ...lines(s.ci_watch)].filter((f, i, a) => !files.has(f) && a.indexOf(f) === i).map((file) => ({ file, name: file, verdict: null }))];
      mount.replaceChildren(
        ...all.map((w) => {
          const on = ciOn(s, w.file);
          return h('div', { class: 'rules-item' },
            h('span', { class: 'rules-what' }, h('b', {}, h('span', { class: `dot ${verdictClass(w.verdict?.status === 'completed' ? w.verdict.conclusion : null)}` }), w.name), h('span', { class: 'muted small' }, w.file, w.verdict ? ` · last run ${w.verdict.conclusion ?? w.verdict.status}` : '')),
            h('button', { type: 'button', class: 'rules-switch', role: 'switch', 'aria-checked': String(on), 'aria-label': `Wakes the Taskmaster: ${w.name}`, onclick: () => save(setCi(stored(), w.file, !on), `${on ? 'quiet' : 'watch'} ${w.name}`) }));
        }),
        all.length ? '' : h('p', { class: 'muted small' }, 'No workflows seen yet.'),
        data.failed.ci ? h('p', { class: 'error small' }, 'Couldn\'t read CI\'s workflows: reload to retry.') : '',
        hand);
      const quiet = all.filter((w) => !ciOn(s, w.file)).length;
      return all.length ? `${all.length - quiet} of ${all.length} wake the Taskmaster` : 'No workflows seen yet';
    });
  };

  const effort = () => live({ icon: 'spark', hue: 'running', title: 'Default effort' },
    settingsHelp('How hard minions think when they have no effort of their own.', 'Claude default leaves it to Claude Code. The Taskmaster is not affected.'),
    (mount) => {
      const cur = stored().default_effort ?? '';
      mount.replaceChildren(seg([['', 'Claude default'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ...(['', 'low', 'medium', 'high'].includes(cur) ? [] : [[cur, cur]])], cur, (v) => save({ default_effort: v }, 'set the default effort'), false, 'Default effort'));
      return cur ? cur[0].toUpperCase() + cur.slice(1) : 'Claude default';
    });

  /** A row that is one pick of a few, saved at once (#1045): `pick` is the project field, `opts` its [value, label] choices. */
  const choice = (meta, help, field, opts, fallback, label) => live(meta, help, (mount) => {
    const cur = stored()[field] ?? fallback;
    mount.replaceChildren(seg(opts, cur, (v) => save({ [field]: v }, `set ${label}`), false, label));
    return opts.find(([v]) => v === cur)?.[1] ?? cur;
  });
  const fable = () => choice({ icon: 'spark', hue: 'running', title: 'Fable' },
    settingsHelp('Whether Fable can be used in this scheme, for a minion or a Grunt.', 'Off takes it out of the Taskmaster\'s model table, greys it in the model picker and tells every minion not to use it. A minion already on Fable keeps its model until you change it.'),
    'fable_ok', [['on', 'On'], ['off', 'Off']], 'on', 'Fable');
  const builds = () => choice({ icon: 'spark', hue: 'running', title: 'Major builds' },
    settingsHelp('Whether the Taskmaster may suggest a numbered build for a big multi-minion feature.', 'Off leaves the builds line out of its prompt. Builds already running carry on.'),
    'builds', [['suggest', 'Suggest'], ['off', 'Off']], 'suggest', 'Major builds');
  const grill = () => choice({ icon: 'spark', hue: 'running', title: 'Grill before code' },
    settingsHelp('How much a feature minion questions its requester, as cards, before it writes code.', 'Design is the Citadel-wide rule: only features that need design. All grills every feature; Never skips it. Bugs and chores skip it either way.'),
    'grill', [['design', 'Design only'], ['all', 'Every feature'], ['never', 'Never']], 'design', 'Grill before code');
  const ghRunners = () => choice({ icon: 'spark', hue: 'running', title: 'GitHub\'s own runners' },
    settingsHelp('CI on GitHub\'s runners (CI_RUNNER=github) costs Actions minutes.', 'Ask makes a minion get a person\'s go first; OK lets it use them; Never keeps CI on this scheme\'s own runners.'),
    'gh_runners', [['ask', 'Ask first'], ['ok', 'OK'], ['never', 'Never']], 'ask', 'GitHub runners');

  /**
   * Screenshots (#1044): the widths and themes a UI change is shot at (tools/ui-shot.ts's defaults), whether the ready note
   * must carry them, and a free-text note, the one typed field, which keeps Save and Discard.
   */
  const shots = () => {
    const note = h('input', { type: 'text', class: 'rules-hand-input', id: 'shot-note', maxlength: 200, spellcheck: 'false', placeholder: '1x in her window (1600×900)', 'aria-label': 'Screenshot note', hidden: true });
    const saveBtn = h('button', { type: 'button' }, 'Save'), discardBtn = h('button', { type: 'button', class: 'secondary' }, 'Discard');
    const actions = h('div', { class: 'settings-row-actions', hidden: true }, saveBtn, discardBtn);
    const open = h('button', { type: 'button', class: 'rules-hand', onclick: () => { note.hidden = false; actions.hidden = false; open.hidden = true; note.focus(); } }, 'Add by hand');
    const dirty = () => note.value.trim() !== (stored().shot_note ?? '');
    const sync = () => { note.toggleAttribute('data-draft', dirty()); saveBtn.disabled = discardBtn.disabled = !dirty(); };
    note.addEventListener('input', sync);
    saveBtn.onclick = () => save({ shot_note: note.value.trim() }, 'save the screenshot note');
    discardBtn.onclick = () => { note.value = stored().shot_note ?? ''; sync(); };
    const custom = handLine('1920', (w) => {
      if (!/^\d{3,4}$/.test(w) || +w < 200) return toast('A width is a number of pixels, like 1920');
      const cur = shotList(stored().shot_widths);
      if (!cur.includes(+w)) save({ shot_widths: [...cur, +w].sort((a, b) => b - a).join(',') }, `shoot at ${w}`);
    }, 'Custom width');
    return live({ icon: 'monitor', hue: 'teal', title: 'Screenshots' },
      settingsHelp('The widths and themes a minion shoots a UI change at, and whether its ready note needs them.',
        'tools/ui-shot.ts uses these when a minion passes no --widths or --themes, and the minion\'s prompt states them. Keep at least one of each.'),
      (mount) => {
        const s = stored(), widths = shotList(s.shot_widths), themes = (s.shot_themes ?? '').split(',').filter(Boolean);
        const all = [...new Set([...SHOT_WIDTHS.map(([w]) => w), ...widths])].sort((a, b) => b - a);
        const label = (w) => SHOT_WIDTHS.find(([x]) => x === w)?.[1] ?? `${w}`;
        const chip = (on, text, onclick, disabled) => h('button', { type: 'button', class: 'rules-chip', 'aria-pressed': String(on), disabled, onclick }, on ? icon('check') : '+', ' ', text);
        mount.replaceChildren(
          h('div', { class: 'rules-chips' }, all.map((w) => { const on = widths.includes(w); return chip(on, label(w), () => save({ shot_widths: (on ? widths.filter((x) => x !== w) : [...widths, w]).sort((a, b) => b - a).join(',') }, `${on ? 'stop shooting' : 'shoot'} at ${w}`), on && widths.length === 1); })),
          h('div', { class: 'rules-chips' }, [['light', 'Light'], ['dark', 'Dark']].map(([t, l]) => { const on = themes.includes(t); return chip(on, l, () => save({ shot_themes: ['light', 'dark'].filter((x) => (x === t ? !on : themes.includes(x))).join(',') }, `${on ? 'stop shooting' : 'shoot'} in ${t}`), on && themes.length === 1); })),
          h('div', { class: 'rules-item' }, h('span', { class: 'rules-what' }, h('b', {}, 'Shots in the ready note'), h('span', { class: 'muted small' }, 'a UI change isn\'t ready without them')),
            h('button', { type: 'button', class: 'rules-switch', role: 'switch', 'aria-checked': String(!!s.shots_required), 'aria-label': 'Screenshots required in the ready note', onclick: () => save({ shots_required: !s.shots_required }, `turn required screenshots ${s.shots_required ? 'off' : 'on'}`) })),
          h('div', { class: 'rules-pick' }, custom, ''));
        if (!note.hasAttribute('data-draft')) note.value = s.shot_note ?? '';
        if (note.value && note.hidden) open.click();
        sync();
        return `${widths.join(' and ')}, ${themes.join(' and ')}${s.shots_required ? ', required' : ''}`;
      }, open, note, actions);
  };

  return { approvals, plugins, listGroups, ci, effort, fable, builds, grill, ghRunners, shots, data, refreshAll };
}

/** Link rows to pages that live elsewhere (N9); Schedules opens the sidebar's list. */
export function elsewhereRows(scheduleCount) {
  const id = view.projectId;
  const link = (ic, hue, title, sum, href, onclick) => h('a', { class: 'settings-row settings-page-link', 'data-hue': hue, href, onclick },
    h('span', { class: 'settings-tile' }, icon(ic)),
    h('span', { class: 'settings-row-text' }, h('span', { class: 'settings-row-title' }, title), h('span', { class: 'settings-row-sum' }, sum)),
    h('span', { class: 'settings-row-chev' }, icon('forward')));
  return [
    link('rows', 'teal', 'Schedules', scheduleCount == null ? 'Minions that start on a timer' : `${scheduleCount} active`, `#/p/${id}`, () => setTimeout(() => { const b = document.querySelector('.schedules-btn'); if (b && b.getAttribute('aria-pressed') !== 'true') b.click(); }, 300)),
    link('spark', 'running', 'Releases', 'What shipped and what is live', `#/p/${id}/releases/all`),
    link('users', 'running', 'Members', 'Who works in this scheme', `#/p/${id}/members`),
    link('bell', 'held', 'Notifications', 'You: push, and what pings you', `#/p/${id}/notifications`),
  ];
}
