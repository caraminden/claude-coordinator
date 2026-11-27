// The Minion rules page's pickers (#1041, Cara 2026-11-19: "make as much of it as possible into toggles and buttons and
// pickers, with manual text entry as a fallback"). Each row reads the same stored text the old text box did and writes it
// back at once (settings.js's saveProject: optimistic, a toast with Retry on a refusal); typed entry stays as "Add by hand".
/** @import { Child } from './base.js' */
/** @import { Scheme, View } from './types.js' */
import { toast } from './ui/status.js';
import { account, h, icon, listGroupsOf, view } from './base.js';
import { kindLabel, NEVER_HOLD_KINDS } from './heldmsg.js';
import { GO_FROM, label, MERGE_RULES, shippingGate, SHIP_PATHS, TRY_FIRST } from './shipping.js';

/** @param {string | null | undefined} text */
export const lines = (text) =>
  (text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
/** @param {Iterable<string>} list */
const text = (list) => [...new Set(list)].join('\n');

/** Actions a person can tick to be asked first, each the permission rules it stands for (Claude Code's rule syntax). */
export const APPROVALS = [
  { id: 'merge', what: 'Merge a pull request', rules: MERGE_RULES },
  { id: 'automerge', what: 'Turn on auto-merge', rules: ['mcp__*__enable_pr_auto_merge'] },
  { id: 'release', what: 'Publish a GitHub release', rules: ['Bash(gh release create:*)'] },
  { id: 'workflow', what: 'Run a CI workflow by hand', rules: ['Bash(gh workflow run:*)'] },
  { id: 'tags', what: 'Push tags', rules: ['Bash(git push --tags:*)'] },
  { id: 'docs', what: 'Edit CLAUDE.md, skills or rules', rules: ['Edit(CLAUDE.md)', 'Edit(.claude/**)'] },
  { id: 'close', what: 'Close a pull request or issue', rules: ['Bash(gh pr close:*)', 'Bash(gh issue close:*)'] },
];
/** A box is ticked when all its rules are stored. */
/** @param {string[]} stored */
export const ticked = (stored) => APPROVALS.filter((a) => a.rules.every((r) => stored.includes(r)));
/** Tick or untick one box in a stored rule list; returns the new stored text. */
/** @param {string} stored @param {string} id @param {boolean} on */
export function toggleApproval(stored, id, on) {
  const rules = /** @type {(typeof APPROVALS)[number]} */ (APPROVALS.find((a) => a.id === id)).rules;
  const kept = lines(stored).filter((r) => !rules.includes(r));
  return text(on ? [...lines(stored), ...rules] : kept);
}
/** The stored rules no ticked box owns: what "Add by hand" shows. */
/** @param {string} stored */
export const handRules = (stored) => {
  const owned = new Set(ticked(lines(stored)).flatMap((a) => a.rules));
  return lines(stored).filter((r) => !owned.has(r));
};

/** Where a plugin folder is stored: 'off', 'picked' (optional_plugin_dirs) or 'every' (plugin_dirs). */
/** @param {Pick<Scheme, 'plugin_dirs' | 'optional_plugin_dirs'>} p @param {string} dir */
export const pluginMode = (p, dir) => (lines(p.plugin_dirs).includes(dir) ? 'every' : lines(p.optional_plugin_dirs).includes(dir) ? 'picked' : 'off');
/** The two stored lists after moving `dir` to `mode`. */
/** @param {Pick<Scheme, 'plugin_dirs' | 'optional_plugin_dirs'>} p @param {string} dir @param {string} mode */
export function setPluginMode(p, dir, mode) {
  /** @param {string} s */
  const drop = (s) => lines(s).filter((d) => d !== dir);
  return {
    plugin_dirs: text(mode === 'every' ? [...lines(p.plugin_dirs), dir] : drop(p.plugin_dirs)),
    optional_plugin_dirs: text(mode === 'picked' ? [...lines(p.optional_plugin_dirs), dir] : drop(p.optional_plugin_dirs)),
  };
}

/** A workflow is on (wakes the Taskmaster) unless it is quiet and not also watched, as ci-health's snapshot reads it. */
/** @param {Pick<Scheme, 'ci_quiet' | 'ci_watch'>} p @param {string} file */
export const ciOn = (p, file) => !lines(p.ci_quiet).includes(file) || lines(p.ci_watch).includes(file);
/** The two stored lists after switching `file`: on leaves the quiet list, off joins it and leaves the watch list. */
/** @param {Pick<Scheme, 'ci_quiet' | 'ci_watch'>} p @param {string} file @param {boolean} on */
export function setCi(p, file, on) {
  const quiet = lines(p.ci_quiet).filter((f) => f !== file),
    watch = lines(p.ci_watch).filter((f) => f !== file);
  return on ? { ci_quiet: text(quiet), ci_watch: text(lines(p.ci_watch)) } : { ci_quiet: text([...quiet, file]), ci_watch: text(watch) };
}

/** @param {string | null | undefined} c */
const verdictClass = (c) => (c === 'success' ? 'ready' : c === 'failure' ? 'down' : c ? 'asleep' : 'running');

/**
 * The rows, built with the page's own parts: settingsRow and settingsHelp (settings.js) and saveProject, which sends a
 * PATCH of `body` behind an optimistic `mine` (what view.project then holds).
 */
/** @type {[number, string][]} */
const SHOT_WIDTHS = [
  [1440, 'Desktop 1440'],
  [1024, 'Laptop 1024'],
  [768, 'Tablet 768'],
  [390, 'Phone 390'],
];
/** src/msg-settings.ts's defaults and bounds; test/held-list.test.ts keeps them equal. */
/** @typedef {'msg_loop_limit' | 'msg_loop_min' | 'msg_cold_min' | 'msg_hold_h'} MsgField */
/** @type {Record<MsgField, number>} */
export const MSG_DEFAULTS = { msg_loop_limit: 6, msg_loop_min: 10, msg_cold_min: 55, msg_hold_h: 3 };
/** @type {Record<MsgField, [number, number]>} */
export const MSG_BOUNDS = { msg_loop_limit: [3, 20], msg_loop_min: [5, 60], msg_cold_min: [10, 55], msg_hold_h: [1, 12] };
/** What a control is called, whichever way it is switched. */
/** @param {Element} el */
const nameOf = (el) => `${el.closest('[role=group]')?.ariaLabel ?? ''}|${el.ariaLabel ?? (el.closest('label') ?? el).textContent.replace(/^\+/, '').trim()}`;
/** @param {string | null | undefined} text */
const shotList = (text) =>
  (text ?? '')
    .split(',')
    .map(Number)
    .filter((w) => w > 0);

/** @typedef {{ icon?: string, hue?: string | null, title: Child, summary?: Child, open?: boolean, key?: string | null, part?: string | null }} RowMeta */
/** @typedef {{ sync: () => boolean, begin: () => { from: string, sent: () => number, answered: () => void, refused: () => void } }} TypedDraft */
/** @typedef {{ dir: string, name: string, description: string, missing?: boolean }} PluginDir */
/** @typedef {{ file: string, name: string, verdict: { status?: string, conclusion?: string | null } | null }} Workflow */
/** @typedef {{ found: PluginDir[], registry: { key: string, values: string[] }[], workflows: Workflow[], failed: { plugins?: boolean, ci?: boolean } }} PickerData */
/**
 * @param {{
 *   settingsRow: (row: RowMeta, ...body: Child[]) => [HTMLDetailsElement, HTMLSpanElement],
 *   settingsHelp: (first: Child, ...rest: Child[]) => HTMLElement,
 *   saveProject: (p: Scheme, mine: Record<string, unknown>, body: Record<string, unknown>, label: string, shown: (ok?: boolean, err?: unknown) => void, draft?: ReturnType<TypedDraft['begin']>) => Promise<unknown>,
 *   typedDraft: (el: HTMLInputElement | HTMLTextAreaElement, saved: () => string, dirty?: () => boolean) => TypedDraft,
 * }} deps
 */
export function pickers({ settingsRow, settingsHelp, saveProject, typedDraft }) {
  const p = /** @type {View} */ (view).project;
  const stored = () => (/** @type {View} */ (view).project?.id === p.id ? /** @type {View} */ (view).project : p); // a save can outlast the page
  // Read once the page opens (settings.js), then every row redraws.
  /** @type {PickerData} */
  const data = { found: [], registry: [], workflows: [], failed: {} };
  /** A row that redraws its body from view.project whenever the project changes (onProjectUpdate dispatches settings-refresh). */
  /** @param {RowMeta} meta @param {Child} help @param {(mount: HTMLDivElement) => string} draw @param {...Child} after */
  const live = (meta, help, draw, ...after) => {
    const mount = h('div', { class: 'rules-body' });
    const [row, sum] = settingsRow(meta, help, mount, ...after);
    // What a redraw would take the focus from keeps it: the same control, or the one drawn in its place.
    /** @param {Element} el */
    const named = (el) => /** @type {HTMLElement[]} */ ([...mount.querySelectorAll(el.tagName)].filter((x) => nameOf(x) === nameOf(el)));
    const paint = () => {
      const at = /** @type {HTMLElement | false | null} */ (mount.contains(document.activeElement) && document.activeElement);
      const nth = at ? named(at).indexOf(at) : -1;
      sum.textContent = draw(mount);
      if (at && document.activeElement !== at) (at.isConnected ? at : named(at)[nth])?.focus({ preventScroll: true });
    };
    row.dataset.rulesRow = '';
    row.addEventListener('settings-refresh', paint);
    paint();
    return row;
  };
  const refreshAll = () => {
    for (const el of document.querySelectorAll('[data-rules-row]')) el.dispatchEvent(new Event('settings-refresh'));
  };
  /** Save these fields at once. `fields` are the stored strings; list_groups goes as a list. */
  /** @param {Record<string, string | number | boolean>} fields @param {string} label @param {Record<string, string>} [was] @param {ReturnType<TypedDraft['begin']>} [draft] */
  const save = (fields, label, was, draft) => {
    /** @type {Record<string, unknown>} */
    const body = { ...fields, ...(was && { was }) };
    if ('list_groups' in fields) body.list_groups = JSON.parse(/** @type {string} */ (fields.list_groups));
    if ('msg_never_hold' in fields) body.msg_never_hold = /** @type {string} */ (fields.msg_never_hold).split(',').filter(Boolean);
    return saveProject(p, fields, body, label, refreshAll, draft);
  };
  /** `disabled` is true, false, or a test of each option's value. */
  /** @param {string[][]} opts @param {string} cur @param {(v: string) => unknown} onPick @param {boolean | ((v: string) => boolean)} [disabled] @param {string} [label] */
  const seg = (opts, cur, onPick, disabled = false, label = '') =>
    h(
      'div',
      { class: 'rules-seg', role: 'group', 'aria-label': label },
      opts.map(([v, l]) => h('button', { type: 'button', 'aria-pressed': String(cur === v), disabled: typeof disabled === 'function' ? disabled(v) : disabled, onclick: () => cur !== v && onPick(v) }, l)),
    );
  /** "Add by hand": a button that opens one line to type in; Enter or Add sends it. */
  /** @param {string} placeholder @param {(v: string) => unknown} onAdd @param {string} [label] */
  const handLine = (placeholder, onAdd, label = 'Add by hand') => {
    const input = h('input', { type: 'text', class: 'rules-hand-input', placeholder, spellcheck: 'false', 'aria-label': label, hidden: true });
    const add = h('button', { type: 'button', hidden: true, onclick: () => go() }, 'Add');
    const open = h(
      'button',
      {
        type: 'button',
        class: 'rules-hand',
        onclick: () => {
          input.hidden = add.hidden = false;
          open.hidden = true;
          input.focus();
        },
      },
      label,
    );
    const go = () => {
      const v = input.value.trim();
      if (!v) return;
      onAdd(v);
      input.value = '';
    };
    input.addEventListener('keydown', (e) => e.key === 'Enter' && (e.preventDefault(), go()));
    return h('div', { class: 'rules-pick' }, open, input, add);
  };

  const approvals = () => {
    const key = 'approval_rules';
    const area = h('textarea', { class: 'instructions-text settings-list', id: 'approval-rules', rows: 3, spellcheck: 'false', placeholder: 'Bash(tools/deploy.sh:*)', 'aria-label': 'Rules added by hand', hidden: true });
    const saveBtn = h('button', { type: 'button' }, 'Save'),
      discardBtn = h('button', { type: 'button', class: 'secondary' }, 'Discard');
    const handOpen = h(
      'button',
      {
        type: 'button',
        class: 'rules-hand',
        onclick: () => {
          showHand();
          area.focus();
        },
      },
      'Add by hand',
    );
    const actions = h('div', { class: 'settings-row-actions', hidden: true }, saveBtn, discardBtn);
    const showHand = () => {
      area.hidden = actions.hidden = false;
      handOpen.hidden = true;
    };
    const hand = () => handRules(stored()[key]).join('\n');
    const draft = typedDraft(area, hand, () => lines(area.value).join('\n') !== hand());
    const sync = () => {
      saveBtn.disabled = discardBtn.disabled = !draft.sync();
    };
    area.addEventListener('input', sync);
    saveBtn.onclick = () => {
      const typed = lines(area.value).join('\n');
      const ticks = ticked(lines(stored()[key])).flatMap((a) => a.rules);
      const sending = draft.begin();
      // A rule typed out that ticks a box is the box's from here on, so it leaves the field once it is saved.
      save({ [key]: text([...ticks, ...lines(typed)]) }, 'save approval rules', { [key]: text([...ticks, ...lines(sending.from)]) }, sending).then(
        () => {
          if (lines(area.value).join('\n') === typed) area.value = hand();
          sync();
        },
        () => {},
      );
    };
    discardBtn.onclick = () => {
      area.value = handRules(stored()[key]).join('\n');
      sync();
    };
    return live(
      { part: 'needs-approval', icon: 'shield', hue: 'waiting', title: 'Needs approval' },
      settingsHelp("Tool calls that wait for Approve or Deny in the minion's chat.", 'Tick an action to be asked before a minion does it; everything else runs without asking.'),
      (mount) => {
        const rules = lines(stored()[key]);
        const on = ticked(rules);
        mount.replaceChildren(
          h(
            'div',
            { class: 'rules-checks' },
            APPROVALS.map((a) => {
              // On a pull-request path Shipping owns the merge box (shipping.js's gate): ticked exactly when every change needs a go.
              const byShipping = a.id === 'merge' && stored().ship_path !== 'citadel';
              return h(
                'label',
                { class: `rules-check${byShipping ? ' locked' : ''}` },
                h('input', {
                  type: 'checkbox',
                  checked: on.includes(a),
                  disabled: byShipping,
                  onchange: (/** @type {Event} */ e) => save({ [key]: toggleApproval(stored()[key], a.id, /** @type {HTMLInputElement} */ (e.target).checked) }, `${/** @type {HTMLInputElement} */ (e.target).checked ? 'ask before' : 'stop asking before'}: ${a.what.toLowerCase()}`),
                }),
                h('span', { class: 'rules-what' }, h('span', {}, a.what), h('code', {}, byShipping ? "set by Shipping: A person's go" : a.rules.join('  '))),
              );
            }),
            h('div', { class: 'rules-check locked' }, h('input', { type: 'checkbox', checked: true, disabled: true }), h('span', { class: 'rules-what' }, h('span', {}, 'Push to main, force-push, reset over work'), h('code', {}, 'always blocked by the tripwire, in every scheme'))),
          ),
          h('p', { class: 'cui-notice small' }, 'Bash rules match how a command starts: they catch mistakes, not a determined workaround.'),
        );
        if (!area.hasAttribute('data-draft')) area.value = handRules(stored()[key]).join('\n');
        if (area.value && area.hidden) showHand();
        sync();
        const n = handRules(stored()[key]).length;
        return on.length || n ? `Asks before: ${[...on.map((a) => a.what), ...(n ? [`${n} by hand`] : [])].join(', ')}` : 'Nothing asks first';
      },
      handOpen,
      area,
      actions,
    );
  };

  const plugins = () => {
    const hand = handLine('tools/mods/my-plugin', (dir) => save(setPluginMode(stored(), dir.replace(/\/+$/, '').replace(/^\.\//, ''), 'picked'), 'add a plugin folder'));
    return live({ part: 'plugins', icon: 'plug', hue: 'held', title: 'Plugins' }, settingsHelp("Plugin folders found in this scheme's repo.", 'Picked loads one only for minions that pick it (the Plugins picker beside Send); Every minion loads it on every turn. Only an admin changes these.'), (mount) => {
      const s = stored(),
        admin = !!account?.admin;
      const found = data.found,
        known = new Set(found.map((f) => f.dir));
      const stray = [...new Set([...lines(s.plugin_dirs), ...lines(s.optional_plugin_dirs)])].filter((d) => !known.has(d)).map((dir) => ({ dir, name: dir.split('/').pop(), description: '', missing: true }));
      const all = [...found, ...stray];
      mount.replaceChildren(
        ...all.map((f) =>
          h(
            'div',
            { class: 'rules-item' },
            h('span', { class: 'rules-what' }, h('b', {}, f.name), h('code', {}, f.dir), f.missing ? h('span', { class: 'muted small' }, 'not found in the repo') : f.description ? h('span', { class: 'muted small' }, f.description) : ''),
            seg(
              [
                ['off', 'Off'],
                ['picked', 'Picked'],
                ['every', 'Every minion'],
              ],
              pluginMode(s, f.dir),
              (mode) => save(setPluginMode(stored(), f.dir, mode), `set ${f.name} to ${mode}`),
              !admin,
              f.name,
            ),
          ),
        ),
        all.length ? '' : h('p', { class: 'muted small' }, "No plugin folders in this scheme's repo yet."),
        data.failed.plugins ? h('p', { class: 'error small' }, "Couldn't read the repo's plugin folders: reload to retry.") : '',
        admin ? hand : h('p', { class: 'muted small' }, 'Only an admin changes these.'),
      );
      const on = all.filter((f) => pluginMode(s, f.dir) !== 'off');
      return on.length ? `${on.length} on: ${on.map((f) => f.name).join(', ')}` : 'None on';
    });
  };

  const listGroups = () => {
    let key = '';
    const hand = handLine('area: balance', (line) => {
      const groups = /** @type {string[]} */ (listGroupsOf(stored()));
      save({ list_groups: JSON.stringify([...groups.filter((g) => g !== line), line]) }, `add the group ${line}`);
    });
    return live({ part: 'list-groups', icon: 'rows', hue: 'teal', title: 'List groups' }, settingsHelp('Minions outside a build that carry one of these get their own group at the top of the minions list.', 'A minion that matches two sits in the first.'), (mount) => {
      const registry = data.registry;
      if (!registry.some((k) => k.key === key)) key = registry[0]?.key ?? '';
      const groups = /** @type {string[]} */ (listGroupsOf(stored()));
      const values = registry.find((k) => k.key === key)?.values ?? [];
      /** @param {string[]} next @param {string} label */
      const commit = (next, label) => save({ list_groups: JSON.stringify(next) }, label);
      const select = h(
        'select',
        {
          'aria-label': 'Property',
          onchange: (/** @type {Event} */ e) => {
            key = /** @type {HTMLSelectElement} */ (e.target).value;
            refreshAll();
          },
        },
        registry.map((k) => h('option', { value: k.key, selected: k.key === key }, k.key)),
      );
      mount.replaceChildren(
        registry.length ? h('div', { class: 'rules-pick' }, select, h('span', { class: 'muted small' }, 'tap a value to add it')) : '',
        h(
          'div',
          { class: 'rules-chips' },
          values.map((v) => {
            const line = `${key}: ${v}`,
              on = groups.includes(line);
            return h('button', { type: 'button', class: 'rules-chip', 'aria-pressed': String(on), onclick: () => commit(on ? groups.filter((g) => g !== line) : [...groups, line], `${on ? 'remove' : 'add'} the group ${line}`) }, on ? icon('check') : '+', ' ', v);
          }),
        ),
        groups.length
          ? h(
              'div',
              { class: 'rules-order' },
              groups.map((g, i) =>
                h(
                  'div',
                  { class: 'rules-ord' },
                  h('span', {}, `${i + 1}. ${g}`),
                  h(
                    'button',
                    {
                      type: 'button',
                      class: 'rules-mini',
                      disabled: !i,
                      'aria-label': `Move ${g} up`,
                      onclick: () =>
                        commit(
                          groups.map((g2, j) => (j === i - 1 ? groups[i] : j === i ? groups[i - 1] : g2)),
                          `move ${g} up`,
                        ),
                    },
                    '↑',
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      class: 'rules-mini',
                      'aria-label': `Remove ${g}`,
                      onclick: () =>
                        commit(
                          groups.filter((_, j) => j !== i),
                          `remove the group ${g}`,
                        ),
                    },
                    '✕',
                  ),
                ),
              ),
            )
          : h('p', { class: 'muted small' }, 'No groups yet.'),
        hand,
      );
      return groups.length ? `${groups.length} group${groups.length > 1 ? 's' : ''}: ${groups.join(', ')}` : 'No groups yet';
    });
  };

  const ci = () => {
    const hand = handLine('nightly.yml', (file) => {
      const f = file.replace(/^\.?\/?\.github\/workflows\//, '');
      save(setCi({ ...stored(), ci_watch: text([...lines(stored().ci_watch), f]) }, f, true), 'watch a workflow');
    });
    return live(
      { part: 'ci-alerts', icon: 'belloff', hue: 'running', title: 'CI alerts' },
      settingsHelp("This scheme's workflows, from the CI page. On wakes the Taskmaster when one goes red on the default branch; Off keeps it quiet (the CI page still shows it).", 'A red run starts a fix and says when it is green again. A minion that dispatched a run on its own branch still hears its result.'),
      (mount) => {
        const s = stored(),
          workflows = data.workflows;
        const files = new Set(workflows.map((w) => w.file));
        const all = [...workflows, ...[...lines(s.ci_quiet), ...lines(s.ci_watch)].filter((f, i, a) => !files.has(f) && a.indexOf(f) === i).map((file) => ({ file, name: file, verdict: null }))];
        mount.replaceChildren(
          ...all.map((w) => {
            const on = ciOn(s, w.file);
            return h(
              'div',
              { class: 'rules-item' },
              h('span', { class: 'rules-what' }, h('b', {}, h('span', { class: `dot ${verdictClass(w.verdict?.status === 'completed' ? w.verdict.conclusion : null)}` }), w.name), h('span', { class: 'muted small' }, w.file, w.verdict ? ` · last run ${w.verdict.conclusion ?? w.verdict.status}` : '')),
              h('button', { type: 'button', class: 'rules-switch', role: 'switch', 'aria-checked': String(on), 'aria-label': `Wakes the Taskmaster: ${w.name}`, onclick: () => save(setCi(stored(), w.file, !on), `${on ? 'quiet' : 'watch'} ${w.name}`) }),
            );
          }),
          all.length ? '' : h('p', { class: 'muted small' }, 'No workflows seen yet.'),
          data.failed.ci ? h('p', { class: 'error small' }, "Couldn't read CI's workflows: reload to retry.") : '',
          hand,
        );
        const quiet = all.filter((w) => !ciOn(s, w.file)).length;
        return all.length ? `${all.length - quiet} of ${all.length} wake the Taskmaster` : 'No workflows seen yet';
      },
    );
  };

  const effort = () =>
    live({ part: 'default-effort', icon: 'spark', hue: 'running', title: 'Default effort' }, settingsHelp('How hard minions think when they have no effort of their own.', 'Claude default leaves it to Claude Code. The Taskmaster is not affected.'), (mount) => {
      const cur = stored().default_effort ?? '';
      mount.replaceChildren(seg([['', 'Claude default'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ...(['', 'low', 'medium', 'high'].includes(cur) ? [] : [[cur, cur]])], cur, (v) => save({ default_effort: v }, 'set the default effort'), false, 'Default effort'));
      return cur ? cur[0].toUpperCase() + cur.slice(1) : 'Claude default';
    });

  /** A row that is one pick of a few, saved at once (#1045): `pick` is the project field, `opts` its [value, label] choices. */
  /** @param {RowMeta} meta @param {Child} help @param {'fable_ok' | 'builds' | 'grill' | 'gh_runners'} field @param {string[][]} opts @param {string} fallback @param {string} label */
  const choice = (meta, help, field, opts, fallback, label) =>
    live(meta, help, (mount) => {
      const cur = stored()[field] ?? fallback;
      mount.replaceChildren(seg(opts, cur, (v) => save({ [field]: v }, `set ${label}`), false, label));
      return opts.find(([v]) => v === cur)?.[1] ?? cur;
    });
  const fable = () =>
    choice(
      { icon: 'spark', hue: 'running', title: 'Fable' },
      settingsHelp('Whether Fable can be used in this scheme, for a minion or a Grunt.', "Off takes it out of the Taskmaster's model table, greys it in the model picker and tells every minion not to use it. A minion already on Fable keeps its model until you change it."),
      'fable_ok',
      [
        ['on', 'On'],
        ['off', 'Off'],
      ],
      'on',
      'Fable',
    );
  const builds = () =>
    choice(
      { icon: 'spark', hue: 'running', title: 'Major builds' },
      settingsHelp('Whether the Taskmaster may suggest a numbered build for a big multi-minion feature.', 'Off leaves the builds line out of its prompt. Builds already running carry on.'),
      'builds',
      [
        ['suggest', 'Suggest'],
        ['off', 'Off'],
      ],
      'suggest',
      'Major builds',
    );
  const grill = () =>
    choice(
      { icon: 'spark', hue: 'running', title: 'Grill before code' },
      settingsHelp(
        'How much a feature minion questions its requester, as cards, before it writes code.',
        'Features that need design, the default, grills only features whose work needs design: a new screen, data model or flow. Each minion judges that from its brief, not from its type property (design-type minions question people as part of their own work anyway). Every feature grills every feature; Never skips it. Whichever you pick, bugs, chores and small features or tweaks with a clear spec skip it.',
      ),
      'grill',
      [
        ['design', 'Features that need design'],
        ['all', 'Every feature'],
        ['never', 'Never'],
      ],
      'design',
      'Grill before code',
    );
  const ghRunners = () =>
    choice(
      { icon: 'spark', hue: 'running', title: "GitHub's own runners" },
      settingsHelp("CI on GitHub's runners (CI_RUNNER=github) is free on a public repo, but may cost Actions minutes (private repo or larger runners).", "Ask makes a minion get a person's go first; OK lets it use them; Never keeps CI on this scheme's own runners."),
      'gh_runners',
      [
        ['ask', 'Ask first'],
        ['ok', 'OK'],
        ['never', 'Never'],
      ],
      'ask',
      'GitHub runners',
    );

  /**
   * Screenshots (#1044): the widths and themes a UI change is shot at (tools/ui-shot.ts's defaults), whether the ready note
   * must carry them, and a free-text note, the one typed field, which keeps Save and Discard.
   */
  const shots = () => {
    const note = h('input', { type: 'text', class: 'rules-hand-input', id: 'shot-note', maxlength: 200, spellcheck: 'false', placeholder: '1x in her window (1600×900)', 'aria-label': 'Screenshot note', hidden: true });
    const saveBtn = h('button', { type: 'button' }, 'Save'),
      discardBtn = h('button', { type: 'button', class: 'secondary' }, 'Discard');
    const actions = h('div', { class: 'settings-row-actions', hidden: true }, saveBtn, discardBtn);
    const open = h(
      'button',
      {
        type: 'button',
        class: 'rules-hand',
        onclick: () => {
          showNote();
          note.focus();
        },
      },
      'Add by hand',
    );
    const showNote = () => {
      note.hidden = actions.hidden = false;
      open.hidden = true;
    };
    const draft = typedDraft(note, () => stored().shot_note ?? '');
    const sync = () => {
      saveBtn.disabled = discardBtn.disabled = !draft.sync();
    };
    note.addEventListener('input', sync);
    saveBtn.onclick = () => {
      const sending = draft.begin();
      save({ shot_note: note.value.trim() }, 'save the screenshot note', { shot_note: sending.from }, sending);
    };
    discardBtn.onclick = () => {
      note.value = stored().shot_note ?? '';
      sync();
    };
    const custom = handLine(
      '1920',
      (w) => {
        if (!/^\d{3,4}$/.test(w) || +w < 200 || +w > 5000) return toast('A width is a number of pixels, like 1920');
        const cur = shotList(stored().shot_widths);
        if (!cur.includes(+w)) save({ shot_widths: [...cur, +w].sort((a, b) => b - a).join(',') }, `shoot at ${w}`);
      },
      'Custom width',
    );
    return live(
      { part: 'screenshots', icon: 'monitor', hue: 'teal', title: 'Screenshots' },
      settingsHelp('The widths and themes a minion shoots a UI change at, and whether its ready note needs them.', "tools/ui-shot.ts uses these when a minion passes no --widths or --themes, and the minion's prompt states them. Keep at least one of each."),
      (mount) => {
        const s = stored(),
          widths = shotList(s.shot_widths),
          themes = (s.shot_themes ?? '').split(',').filter(Boolean);
        const all = [...new Set([...SHOT_WIDTHS.map(([w]) => w), ...widths])].sort((a, b) => b - a);
        /** @param {number} w */
        const label = (w) => SHOT_WIDTHS.find(([x]) => x === w)?.[1] ?? `${w}`;
        /** @param {boolean} on @param {string} text @param {() => unknown} onclick @param {boolean} disabled */
        const chip = (on, text, onclick, disabled) => h('button', { type: 'button', class: 'rules-chip', 'aria-pressed': String(on), disabled, onclick }, on ? icon('check') : '+', ' ', text);
        mount.replaceChildren(
          h(
            'div',
            { class: 'rules-chips' },
            all.map((w) => {
              const on = widths.includes(w);
              return chip(on, label(w), () => save({ shot_widths: (on ? widths.filter((x) => x !== w) : [...widths, w]).sort((a, b) => b - a).join(',') }, `${on ? 'stop shooting' : 'shoot'} at ${w}`), on && widths.length === 1);
            }),
          ),
          h(
            'div',
            { class: 'rules-chips' },
            [
              ['light', 'Light'],
              ['dark', 'Dark'],
            ].map(([t, l]) => {
              const on = themes.includes(t);
              return chip(on, l, () => save({ shot_themes: ['light', 'dark'].filter((x) => (x === t ? !on : themes.includes(x))).join(',') }, `${on ? 'stop shooting' : 'shoot'} in ${t}`), on && themes.length === 1);
            }),
          ),
          h(
            'div',
            { class: 'rules-item' },
            h('span', { class: 'rules-what' }, h('b', {}, 'Shots in the ready note'), h('span', { class: 'muted small' }, "a UI change isn't ready without them")),
            h('button', { type: 'button', class: 'rules-switch', role: 'switch', 'aria-checked': String(!!s.shots_required), 'aria-label': 'Screenshots required in the ready note', onclick: () => save({ shots_required: !s.shots_required }, `turn required screenshots ${s.shots_required ? 'off' : 'on'}`) }),
          ),
          h('div', { class: 'rules-pick' }, custom, ''),
        );
        if (!note.hasAttribute('data-draft')) note.value = s.shot_note ?? '';
        if (note.value && note.hidden) showNote();
        sync();
        return `${widths.join(' and ')}, ${themes.join(' and ')}${s.shots_required ? ', required' : ''}`;
      },
      open,
      note,
      actions,
    );
  };

  /** Save Shipping fields with what the gate makes of them (go_from, the merge approval) shown at once, as the server will store them. */
  /** @param {Partial<Pick<Scheme, 'ship_path' | 'go_from' | 'try_first'>>} fields @param {string} what */
  const saveShipping = (fields, what) => {
    const gate = shippingGate({ ...stored(), ...fields }),
      /** @type {Record<string, unknown>} */
      mine = { ...fields };
    for (const k of /** @type {const} */ (['go_from', 'approval_rules'])) if (gate[k] !== stored()[k]) mine[k] = gate[k];
    return saveProject(p, mine, fields, what, refreshAll);
  };
  const SHIP_HELP = {
    citadel: "The server runs the scheme's land script, rebases onto main and the change goes live.",
    'pr-auto': 'The minion opens a pull request and turns on auto-merge, so it ships once CI is green.',
    'pr-minion': "For a repo GitHub won't auto-merge (a private repo on a free plan): the minion opens a pull request and squash-merges it itself once CI is green and any go is in.",
    'pr-person': 'The minion opens a pull request and waits: merging it needs a person\'s Approve, so every change needs a go and "Merge a pull request" is ticked under Approvals.',
  };
  const ship = () =>
    live(
      { part: 'how-changes-ship', icon: 'branch', hue: 'accent', title: 'How a change ships' },
      settingsHelp('What a minion does with a finished, self-reviewed change.', 'Minions get the steps for the path picked in their prompt; these settings win over any shipping paragraph in the scheme instructions.'),
      (mount) => {
        const cur = stored().ship_path ?? 'citadel';
        mount.replaceChildren(
          seg(
            [
              ['citadel', 'Citadel ships it'],
              ['pr-auto', 'PR, auto-merge'],
              ['pr-minion', 'PR, minion merges'],
              ['pr-person', 'PR, a person merges'],
            ],
            cur,
            (v) => saveShipping({ ship_path: /** @type {Scheme['ship_path']} */ (v) }, 'set how a change ships'),
            false,
            'How a change ships',
          ),
          h('p', { class: 'muted small settings-help' }, SHIP_HELP[cur]),
        );
        return label(SHIP_PATHS, cur);
      },
    );
  const go = () =>
    live(
      { part: 'persons-go', icon: 'users', hue: 'accent', title: "A person's go" },
      settingsHelp("Self-review labels each change low, medium or high. From this label up, the minion asks with a card and waits for a member's go.", 'On a pull-request path, Every change ticks "Merge a pull request" under Approvals; High or Medium leaves it off and the minion asks by label instead.'),
      (mount) => {
        const s = stored(),
          cur = s.go_from ?? 'high',
          person = s.ship_path === 'pr-person';
        mount.replaceChildren(
          seg(
            [
              ['never', 'Never'],
              ['high', 'High'],
              ['medium', 'Medium and up'],
              ['all', 'Every change'],
            ],
            cur,
            (v) => saveShipping({ go_from: /** @type {Scheme['go_from']} */ (v) }, "set when a person's go is needed"),
            (v) => person && v !== 'all',
            "A person's go",
          ),
          person ? h('p', { class: 'muted small settings-help' }, 'A person merges every pull request here, so every change waits for a go.') : '',
        );
        return label(GO_FROM, cur);
      },
    );
  const tryFirst = () =>
    live(
      { part: 'try-it-first', icon: 'eye', hue: 'accent', title: 'Try it first' },
      settingsHelp('Whether a change waits for someone to try it before it ships.', "A minion waiting for a try posts a preview link (or screenshots where the scheme has no previews), sets its state to Try and ships on a member's go. UI changes are ones touching the front-end files the scheme's CLAUDE.md lists."),
      (mount) => {
        const cur = stored().try_first ?? 'never';
        mount.replaceChildren(
          seg(
            [
              ['never', 'Ship when green'],
              ['ui', 'UI waits'],
              ['features', 'Features wait'],
            ],
            cur,
            (v) => saveShipping({ try_first: /** @type {Scheme['try_first']} */ (v) }, 'set what waits for a try'),
            false,
            'Try it first',
          ),
        );
        return label(TRY_FIRST, cur);
      },
    );

  /**
   * Messages (#1059): the loop guard's count and window, and which kinds never wait (the cold hold went in #1603).
   * A number box inside MSG_BOUNDS (the server refuses the rest: src/msg-settings.ts), saved when it changes.
   */
  /** @param {RowMeta} meta @param {Child} help @param {MsgField} field @param {string} label @param {string} unit */
  const number = (meta, help, field, label, unit) => {
    const [min, max] = MSG_BOUNDS[field];
    const now = () => stored()[field] ?? MSG_DEFAULTS[field];
    let shown = ''; // the number the box last showed, so a redraw can tell one being typed
    const input = h('input', {
      type: 'number',
      class: 'rules-number',
      min,
      max,
      step: 1,
      'aria-label': label,
      onchange: () => {
        const v = Number(input.value);
        if (!Number.isInteger(v) || v < min || v > max) {
          input.value = String(now());
          return toast(`${label} is a whole number from ${min} to ${max}`);
        }
        shown = input.value; // sent, no longer being typed: a refusal puts the old number back
        save({ [field]: v }, `set ${label.toLowerCase()}`);
      },
    });
    const line = h('div', { class: 'rules-pick' }, input, h('span', { class: 'muted small' }, `${unit} (${min} to ${max}, default ${MSG_DEFAULTS[field]})`));
    return live(meta, help, (mount) => {
      const cur = now();
      if (!line.parentNode) mount.append(line); // never rebuilt: someone may be typing in it
      if (document.activeElement !== input || input.value === shown) input.value = shown = String(cur);
      return `${cur} ${unit}`;
    });
  };
  const messages = () => [
    number(
      { icon: 'spark', hue: 'running', title: 'Loop guard: messages' },
      settingsHelp('How many messages a minion and its Taskmaster (or two minions) may swap per window before the next is held for a person.', 'Raise it for chatty work; each message wakes a turn, so a runaway exchange costs more before it stops. Lower it to stop loops sooner.'),
      'msg_loop_limit',
      'Loop guard count',
      'messages',
    ),
    number({ icon: 'spark', hue: 'running', title: 'Loop guard: window' }, settingsHelp('How long the loop guard counts messages for.', 'A longer window catches slow loops but also holds steady work; a shorter one forgets sooner.'), 'msg_loop_min', 'Loop guard window', 'minutes'),
    // Cold after and Hold at most went with the cold hold (#1603): a message meant to wake its reader wakes it.
    neverHold(),
  ];
  /** Never hold (#1067; Josh, 2026-11-19, "this kind of message should not wait"): kinds of mail that wake their reader at once. */
  const neverHold = () =>
    live(
      { icon: 'spark', hue: 'running', title: 'Never hold' },
      settingsHelp('Kinds of message that always wake their reader, even a fyi. The held-mail card in a chat sets these too.', "Each wake re-reads the whole context, so turn on only what can't wait. A sealed minion and the loop guard still hold everything."),
      (mount) => {
        const on = new Set((stored().msg_never_hold ?? '').split(',').filter(Boolean));
        mount.replaceChildren(
          h(
            'div',
            { class: 'rules-seg', role: 'group', 'aria-label': 'Never hold' },
            NEVER_HOLD_KINDS.map((k) =>
              h(
                'button',
                {
                  type: 'button',
                  'aria-pressed': String(on.has(k)),
                  onclick: () => {
                    const next = new Set(on);
                    if (!next.delete(k)) next.add(k);
                    save({ msg_never_hold: [...next].sort().join(',') }, `${on.has(k) ? 'hold' : 'never hold'} ${kindLabel(k)}`);
                  },
                },
                kindLabel(k),
              ),
            ),
          ),
        );
        return on.size ? [...on].map(kindLabel).join(', ') : 'None';
      },
    );

  return { approvals, plugins, listGroups, ci, effort, fable, builds, grill, ghRunners, messages, shots, ship, go, tryFirst, data, refreshAll };
}

/** Link rows to pages that live elsewhere (N9). */
/** @param {number | null | undefined} scheduleCount */
export function elsewhereRows(scheduleCount) {
  const id = /** @type {View} */ (view).projectId;
  /** @param {string} ic @param {string} hue @param {Child} title @param {Child} sum @param {string} href @param {(e: MouseEvent) => void} [onclick] */
  const link = (ic, hue, title, sum, href, onclick) =>
    h(
      'a',
      { class: 'settings-row settings-page-link', 'data-hue': hue, href, onclick },
      h('span', { class: 'settings-tile' }, icon(ic)),
      h('span', { class: 'settings-row-text' }, h('span', { class: 'settings-row-title' }, title), h('span', { class: 'settings-row-sum' }, sum)),
      h('span', { class: 'settings-row-chev' }, icon('forward')),
    );
  return [
    link('rows', 'teal', 'Schedules', scheduleCount == null ? 'Minions that start on a timer' : `${scheduleCount} active`, `#/p/${id}/schedules`),
    link('spark', 'running', 'Releases', 'What shipped and what is live', `#/p/${id}/releases/${id}`),
    link('users', 'running', 'Members', 'Who works in this scheme', `#/p/${id}/members`),
    link('bell', 'held', 'Notifications', 'You: push, and what pings you', `#/p/${id}/notifications`),
  ];
}
