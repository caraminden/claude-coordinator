// A scheme's settings: notifications, the Settings page's instructions and approvals tabs, and the Machines page.
import { account, ago, api, h, icon, listGroupsOf, openHash, schemeIcon, view } from './core.js';
import { DEFAULT_CLAUDE_MCP, machineSetup, machineSetupWindows, workspaceName } from './machine-setup.js';
import { openNewScheme, renderSidebar, toggleSchemeMenu } from './sidebar.js';

// ---------- push notifications ----------

// Web Push reaches this device with the app closed, for decisions, blockers and results only
// (question cards, failed turns, threads set ready, try or blocked); see src/push.ts.
const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

async function pushSubscription() {
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

/** The browser's VAPID key as pushManager.subscribe wants it. */
function keyBytes(b64) {
  const bin = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** Ask for permission (only ever from a click), subscribe this browser and register it for you. */
async function pushOn() {
  if (await Notification.requestPermission() !== 'granted') throw new Error('Notifications are blocked for this site in the browser settings');
  const { publicKey } = await api('api/push/key');
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  // A subscription made with another key (an older data dir) can't be used; start over.
  const key = sub?.options?.applicationServerKey;
  if (sub && key && btoa(String.fromCharCode(...new Uint8Array(key))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') !== publicKey) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
  return api('api/push/subscription', { method: 'PUT', body: { subscription: sub.toJSON() } });
}

export async function pushOff() {
  if (!pushSupported) return;
  const sub = await pushSubscription();
  if (!sub) return;
  await api('api/push/subscription', { method: 'DELETE', body: { endpoint: sub.endpoint } });
  await sub.unsubscribe();
}

/** "Notify me on this device", and once on, pinned-only and a mute for this project; in the account box. */
export function pushControls(project) {
  if (!pushSupported) return null;
  const on = h('input', { type: 'checkbox' });
  const mute = h('input', { type: 'checkbox' });
  const pinned = h('input', { type: 'checkbox' });
  const hint = h('span', { class: 'hint', hidden: true });
  const muteRow = h('label', { class: 'toggle', hidden: true, title: 'Stop notifications from this scheme on this device' }, mute, `Mute ${project.name} here`);
  const pinnedRow = h('label', { class: 'toggle', hidden: true, title: 'On this device, notify only about minions you pinned (other people\'s too) and the Taskmaster' }, pinned, 'Only my pinned minions');
  const el = h('div', { class: 'push' },
    h('label', { class: 'toggle', title: 'Questions for you, failed turns, and minions that are ready or blocked' }, on, 'Notify me on this device'),
    pinnedRow, muteRow, hint);
  const show = (state, err) => {
    on.checked = state.subscribed;
    mute.checked = state.muted.includes(project.id);
    pinned.checked = !!state.onlyPinned;
    muteRow.hidden = pinnedRow.hidden = !state.subscribed;
    const denied = Notification.permission === 'denied';
    on.disabled = denied && !state.subscribed;
    hint.textContent = err ?? (denied && !state.subscribed ? 'Blocked for this site in the browser settings' : '');
    hint.hidden = !hint.textContent;
  };
  const busy = async (fn) => {
    on.disabled = mute.disabled = pinned.disabled = true;
    try {
      show(await fn());
    } catch (ex) {
      await refresh(ex.message);
    } finally {
      mute.disabled = pinned.disabled = false;
      if (Notification.permission !== 'denied') on.disabled = false;
    }
  };
  /** Show where this browser stands (and `err`, if a change just failed). */
  async function refresh(err) {
    const sub = await pushSubscription().catch(() => null);
    const state = sub && await api('api/push/subscription', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => null);
    show(state ?? { subscribed: false, muted: [] }, err);
  }
  on.addEventListener('change', () => busy(async () => {
    if (!on.checked) {
      await pushOff();
      return { subscribed: false, muted: [] };
    }
    return pushOn();
  }));
  mute.addEventListener('change', () => busy(async () => {
    const sub = await pushSubscription();
    return api('api/push/subscription', { method: 'PATCH', body: { endpoint: sub.endpoint, projectId: project.id, muted: mute.checked } });
  }));
  pinned.addEventListener('change', () => busy(async () => {
    const sub = await pushSubscription();
    return api('api/push/subscription', { method: 'PATCH', body: { endpoint: sub.endpoint, onlyPinned: pinned.checked } });
  }));
  refresh();
  return el;
}

// Clicking a notification while the app is open: the service worker asks this tab to show the thread.
if (pushSupported) {
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type !== 'open' || typeof e.data.url !== 'string') return;
    const hash = new URL(e.data.url, location.href).hash;
    if (hash) openHash(hash);
  });
}

// A link into the installed app while it's open (the rail's way back from a contraption, a thread link
// opened elsewhere) focuses the open window instead of opening another (manifest launch_handler,
// focus-existing), and lands here: show a thread or view it names; a bare /c/ leaves you where you were.
if ('launchQueue' in window) {
  window.launchQueue.setConsumer(({ targetURL }) => {
    const hash = targetURL && new URL(targetURL).hash;
    if (hash) openHash(hash);
  });
}

// ---------- project instructions ----------

const MAX_INSTRUCTIONS = 16000;
const count = (n) => n.toLocaleString('en');

export function onProjectUpdate(project) {
  for (const el of document.querySelectorAll(`[data-project-name="${project.id}"]`)) el.textContent = project.name;
  for (const el of document.querySelectorAll(`[data-taskmaster-name="${project.id}"]`)) el.textContent = `${project.name} Taskmaster`;
  if (view?.kind !== 'project') return;
  view.projects = view.projects.map((p) => (p.id === project.id ? { ...p, name: project.name } : p));
  if (view.projectId !== project.id) return;
  view.project = project;
  for (const [id, key] of [['approval-rules', 'approval_rules'], ['plugin-dirs', 'plugin_dirs'], ['list-groups', 'list_groups']]) {
    const el = document.getElementById(id);
    if (el && !el.hasAttribute('data-draft')) el.value = settingText(project, key);
  }
  renderSidebar(); // its promoted groups may have changed
  const text = document.getElementById('instructions-text');
  // Someone else saved: show their text unless this tab has edits of its own.
  if (text && !text.hasAttribute('data-draft')) text.value = project.instructions;
  renderInstructionsHead();
  document.getElementById('onboarding-strip')?.replaceWith(onboardingStrip(project));
  renderGithubStrip();
  for (const b of document.querySelectorAll('.ticket-head button.tune-up')) b.replaceWith(tuneUpButton());
}

/** Each onboarding step's place in the four (1, creating the scheme, is done by the time this shows). */
const ONBOARDING_STEPS = { interview: [2, 'interview'], planned: [3, 'plan'], 'setting-up': [4, 'setup'] };

/**
 * "Setting up · interview (2 of 4) · Skip" on the Taskmaster's chat head while the scheme is being
 * set up (#172); an empty placeholder once it's done or skipped, so a live update can swap it in.
 */
export function onboardingStrip(project) {
  const step = ONBOARDING_STEPS[project.onboarding];
  if (!step) return h('span', { id: 'onboarding-strip', hidden: true });
  const skip = h('button', { type: 'button', class: 'link', title: 'Stop the guided setup; the Taskmaster carries on as usual' }, 'Skip');
  skip.onclick = () => {
    skip.disabled = true;
    api(`api/projects/${project.id}`, { method: 'PATCH', body: { onboarding: 'skipped' } }).catch((e) => {
      skip.disabled = false;
      alert(e.message);
    });
  };
  return h('div', { id: 'onboarding-strip', class: 'onboarding-strip' },
    h('span', {}, project.onboarding_mode === 'tune-up' ? 'Tuning up' : 'Setting up'), ' · ',
    h('span', {}, `${step[1]} (${step[0]} of 4)`), ' · ', skip);
}

/** "GitHub repo not created: <error> · Retry" in the minions panel while a new scheme's repo isn't on GitHub (#173). */
export function renderGithubStrip() {
  const el = document.getElementById('github-strip');
  if (!el) return;
  const p = view.project;
  el.hidden = !p.github_error;
  if (!p.github_error) return el.replaceChildren();
  const retry = h('button', { type: 'button', class: 'secondary small' }, 'Retry');
  retry.onclick = async () => {
    retry.disabled = true;
    retry.textContent = 'Retrying…';
    try {
      onProjectUpdate(await api(`api/projects/${p.id}/github`, { method: 'POST' }));
    } catch (err) {
      // The server saved the new error and broadcast it; show it now in case the stream is slow.
      onProjectUpdate({ ...view.project, github_error: err.message.replace(/^GitHub repo not created: /, '') });
    }
  };
  el.replaceChildren(h('span', { class: 'error' }, `GitHub repo not created: ${p.github_error}`), retry);
}

/**
 * The overview's header: the project name with a ✎ that turns it into a text field in place.
 * Enter or ✓ saves; Esc or tapping away cancels. It sits in the panel's <summary>, so its own
 * clicks and keys must not fold the panel or close the phone drawer.
 */
export function projectTitle(project) {
  const wrap = h('span', { class: 'project-title' });
  const err = h('p', { class: 'error small rename-error', role: 'alert', hidden: true });
  const show = () => {
    err.hidden = true;
    err.remove();
    wrap.replaceChildren(
      schemeIcon(view.projects?.find((p) => p.id === project.id) ?? project),
      h('span', { class: 'label', 'data-project-name': project.id }, view.project.name),
      h('button', { type: 'button', class: 'rename', 'aria-label': 'Rename scheme', title: 'Rename scheme (its repo stays as it is)', onclick: edit }, '✎'),
      h('span', { class: 'spacer' }),
      h('button', { type: 'button', class: 'rename switch', 'aria-label': 'Switch scheme', title: 'Switch scheme', 'aria-haspopup': 'menu', 'aria-expanded': 'false', onclick: (e) => toggleSchemeMenu(e.currentTarget) }, '⇅'),
      h('button', { type: 'button', class: 'rename add', 'aria-label': 'New scheme', title: 'New scheme', onclick: openNewScheme }, '+'));
  };
  const edit = () => {
    let saving = false;
    const input = h('input', { class: 'rename-input', value: view.project.name, maxlength: '80', 'aria-label': 'Scheme name' });
    const save = async () => {
      if (saving) return;
      if (input.value.trim() === view.project.name) return show();
      saving = true;
      try {
        onProjectUpdate(await api(`api/projects/${project.id}`, { method: 'PATCH', body: { name: input.value } }));
        show();
      } catch (ex) {
        err.textContent = ex.message;
        err.hidden = false;
        wrap.closest('summary').after(err);
        input.focus();
      }
      saving = false;
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); save(); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); show(); }
    });
    // A space let through to the <summary> would fold the panel in some browsers.
    input.addEventListener('keyup', (e) => { if (e.key === ' ') e.preventDefault(); });
    input.addEventListener('blur', () => { if (!saving) show(); });
    wrap.replaceChildren(input,
      // mousedown kept from blurring the field, so the tap reaches save instead of cancelling.
      h('button', { type: 'button', class: 'rename', 'aria-label': 'Save name', onmousedown: (e) => e.preventDefault(), onclick: save }, '✓'));
    input.focus();
    input.select();
  };
  wrap.addEventListener('click', (e) => {
    // Clicks inside the title edit it; they don't fold the panel or close the drawer.
    if (e.target.closest('button, input')) { e.preventDefault(); e.stopPropagation(); }
  });
  show();
  return wrap;
}

const splitLines = (text) => (text ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
/** A settings field's text: list_groups is stored as a JSON list and edited one per line. */
const settingText = (p, key) => (key === 'list_groups' ? listGroupsOf(p).join('\n') : p[key] ?? '');

/** The Settings page's tabs; each is its own route, so old links to them still work. */
export function settingsTabs() {
  return h('nav', { class: 'settings-tabs' },
    [['instructions', 'Instructions'], account?.admin && ['app-instructions', 'Citadel-wide'], ['approvals', 'Needs approval'], ['properties', 'Properties'],
      ['members', 'Members'], account?.admin && ['people', 'People'], account?.admin && ['contraptions', 'Contraptions'], ['account', 'Your account']].filter(Boolean).map(([kind, label]) =>
      h('a', { class: view.main === kind ? 'active' : '', href: `#/p/${view.projectId}/${kind}`, 'aria-current': view.main === kind ? 'page' : null }, label,
        // The same waiting-review count as the Settings button (renderSettingsCount fills both).
        kind === 'properties' ? h('span', { class: 'count props-count', hidden: true }) : '')));
}

/** "Tune up" (#175): the Taskmaster runs setup again as a diff on what the scheme has, then the chat opens on it. */
export function tuneUpButton() {
  const p = view.project;
  const open = p.onboarding !== 'done' && p.onboarding !== 'skipped';
  const b = h('button', { type: 'button', class: 'secondary tune-up', disabled: open,
    title: open ? 'Setup is under way: see the Taskmaster\'s chat' : 'The Taskmaster asks what changed and posts a plan of edits for you to approve' }, 'Tune up');
  b.onclick = async () => {
    if (!confirm(`Tune up ${p.name}? The Taskmaster starts a turn, asks what changed, and posts a plan of edits; nothing changes until someone approves it.`)) return;
    b.disabled = true;
    try {
      onProjectUpdate(await api(`api/projects/${p.id}/tune-up`, { method: 'POST' }));
      location.hash = `#/p/${p.id}`;
    } catch (err) {
      b.disabled = false;
      alert(err.message);
    }
  };
  return b;
}

/** Main panel: the project's approval rules, plugin folders and list groups. */
export function approvalsEditor() {
  const p = view.project;
  const field = (id, key, placeholder) => {
    const t = h('textarea', { id, class: 'instructions-text settings-list', spellcheck: 'false', rows: 5, placeholder });
    t.value = settingText(p, key);
    return t;
  };
  const rules = field('approval-rules', 'approval_rules', 'Bash(gh pr merge:*)\nmcp__*__merge_pull_request');
  const dirs = field('plugin-dirs', 'plugin_dirs', 'tools/mods/delve');
  const groups = field('list-groups', 'list_groups', 'area: balance');
  groups.rows = 3;
  // Plugins load code from any folder on the server, so only an admin changes them.
  dirs.readOnly = !account?.admin;
  const status = h('span', { class: 'muted', role: 'status' });
  const save = h('button', { type: 'button' }, 'Save');
  const discard = h('button', { type: 'button', class: 'secondary' }, 'Discard');
  const same = (a, b) => splitLines(a).join('\n') === splitLines(b).join('\n');
  const sync = () => {
    let dirty = false;
    for (const [t, key] of [[rules, 'approval_rules'], [dirs, 'plugin_dirs'], [groups, 'list_groups']]) {
      // Marked as a draft only while it differs, so someone else's save still shows otherwise.
      const d = !same(t.value, settingText(view.project, key));
      t.toggleAttribute('data-draft', d);
      dirty ||= d;
    }
    save.disabled = discard.disabled = !dirty;
  };
  for (const t of [rules, dirs, groups]) t.addEventListener('input', () => {
    status.textContent = '';
    sync();
  });
  save.onclick = async () => {
    save.disabled = true;
    status.textContent = 'Saving…';
    try {
      const body = { approval_rules: rules.value, plugin_dirs: dirs.value };
      // Only when edited: a group whose value was archived since mustn't block saving the rules.
      if (!same(groups.value, settingText(view.project, 'list_groups'))) body.list_groups = splitLines(groups.value);
      view.project = await api(`api/projects/${p.id}`, { method: 'PATCH', body });
      rules.value = view.project.approval_rules;
      dirs.value = view.project.plugin_dirs;
      groups.value = settingText(view.project, 'list_groups');
      renderSidebar();
      status.textContent = 'Saved. Minions pick this up on their next turn.';
    } catch (err) {
      status.textContent = err.message;
    }
    sync();
  };
  discard.onclick = () => {
    rules.value = view.project.approval_rules ?? '';
    dirs.value = view.project.plugin_dirs ?? '';
    groups.value = settingText(view.project, 'list_groups');
    status.textContent = '';
    sync();
  };
  const section = h('section', { class: 'artifacts-main instructions-main' },
    h('div', { class: 'ticket-head' },
      h('div', { class: 'row' }, h('h2', {}, 'Settings'), h('span', { class: 'spacer' }), tuneUpButton(),
        h('a', { class: 'close-view', href: `#/p/${p.id}`, title: 'Back to the Taskmaster', 'aria-label': 'Close' }, icon('close'))),
      settingsTabs(),
      h('div', { class: 'meta' }, 'Minions in this scheme use these from their next turn. The Taskmaster is not affected.')),
    h('h3', { class: 'settings-label' }, 'Needs approval'),
    h('p', { class: 'muted small' },
      'Claude Code permission rules, one per line. A minion\'s tool call that matches one waits in its chat with Approve and Deny buttons until someone signed in clicks; everything else runs without asking. ',
      'Examples: ', h('code', {}, 'Bash(gh pr merge:*)'), ', ', h('code', {}, 'mcp__*__merge_pull_request'), '. ',
      'Bash rules match how a command starts, so they catch mistakes rather than a determined workaround.'),
    rules,
    h('h3', { class: 'settings-label' }, 'Plugin folders'),
    h('p', { class: 'muted small' },
      'Folders relative to the repo root, one per line, like ', h('code', {}, 'tools/mods/delve'),
      ', or absolute paths. Each minion loads the ones that exist (relative ones in its worktree) as Claude Code plugins (', h('code', {}, '--plugin-dir'), ').', account?.admin ? '' : ' Only an admin changes these.'),
    dirs,
    h('h3', { class: 'settings-label' }, 'List groups'),
    h('p', { class: 'muted small' },
      'Values of this scheme\'s own properties, one per line, like ', h('code', {}, 'area: balance'),
      '. Minions outside a build that carry one get their own group at the top of the minions list instead of sitting under their type; one that matches two sits in the first.'),
    groups,
    h('div', { class: 'row instructions-actions' }, save, discard, status));
  sync();
  return section;
}

function renderInstructionsHead() {
  const el = document.getElementById('instructions-head');
  if (!el) return;
  const p = view.project;
  el.replaceChildren(
    h('div', { class: 'row' }, h('h2', {}, 'Settings'), h('span', { class: 'spacer' }), tuneUpButton(),
      h('a', { class: 'close-view', href: `#/p/${p.id}`, title: 'Back to the Taskmaster', 'aria-label': 'Close' }, icon('close'))),
    settingsTabs(),
    h('div', { class: 'meta' },
      'The Taskmaster and every minion get these in their system prompt, from their next turn.',
      p.instructions_updated_by ? ` Last changed by ${p.instructions_updated_by} ${ago(p.instructions_updated_at)}.` : ''));
}

/** The last few saves of some instructions, each with what it removed and added, and how to reload them. */
function recentChanges(url) {
  const history = h('div', { class: 'instructions-history' });
  const load = async () => {
    try {
      const { history: saves } = await api(url);
      history.replaceChildren(...(saves.length ? [h('h3', { class: 'settings-label' }, 'Recent changes')] : []),
        ...saves.map((s) => h('details', {},
          h('summary', {}, `${s.by}, ${ago(s.at)} `,
            h('span', { class: 'muted small' }, `+${s.diff.filter((d) => d.op === '+').length} −${s.diff.filter((d) => d.op === '-').length} lines`)),
          h('pre', { class: 'instructions-diff' }, ...s.diff.map((d) => h('div', { class: d.op === '+' ? 'add' : d.op === '-' ? 'del' : 'gap' }, d.op === '…' ? '…' : `${d.op} ${d.text}`))))));
    } catch (err) {
      history.replaceChildren(h('p', { class: 'muted small' }, `Could not load recent changes: ${err.message}`));
    }
  };
  return [history, load];
}

/** The Citadel-wide instructions as last loaded or broadcast, for the tab below. */
let appInstructions = null;

export function onAppInstructionsUpdate(instructions) {
  appInstructions = instructions;
  const text = document.getElementById('app-instructions-text');
  if (text && !text.hasAttribute('data-draft')) text.value = instructions.text;
  renderAppInstructionsHead();
}

function renderAppInstructionsHead() {
  const el = document.getElementById('app-instructions-head');
  if (!el) return;
  const a = appInstructions;
  el.replaceChildren(
    h('div', { class: 'row' }, h('h2', {}, 'Settings'), h('span', { class: 'spacer' }), tuneUpButton(),
      h('a', { class: 'close-view', href: `#/p/${view.projectId}`, title: 'Back to the Taskmaster', 'aria-label': 'Close' }, icon('close'))),
    settingsTabs(),
    h('div', { class: 'meta' },
      'Every scheme\'s minions and Taskmaster get these, before their scheme\'s own.',
      a?.by ? ` Last changed by ${a.by} ${ago(a.at)}.` : ''));
}

/** Main panel: edit the instructions every scheme shares. */
export function appInstructionsEditor() {
  const textarea = h('textarea', {
    id: 'app-instructions-text', class: 'instructions-text', spellcheck: 'false', disabled: true,
    placeholder: 'How people like to work in every scheme: tone, when to ask, how to hand work off…',
  });
  const counter = h('span', { class: 'muted counter' });
  const status = h('span', { class: 'muted', role: 'status' }, 'Loading…');
  const save = h('button', { type: 'button', disabled: true }, 'Save');
  const discard = h('button', { type: 'button', class: 'secondary', disabled: true }, 'Discard');
  const saved = () => appInstructions?.text ?? '';
  const sync = () => {
    const dirty = textarea.value.trim() !== saved().trim();
    textarea.toggleAttribute('data-draft', dirty);
    const n = textarea.value.trim().length;
    counter.textContent = `${count(n)} / ${count(MAX_INSTRUCTIONS)}`;
    counter.classList.toggle('over', n > MAX_INSTRUCTIONS);
    save.disabled = !dirty || n > MAX_INSTRUCTIONS;
    discard.disabled = !dirty;
  };
  textarea.addEventListener('input', () => {
    status.textContent = '';
    sync();
  });
  const [history, loadHistory] = recentChanges('api/app/instructions/history');
  save.onclick = async () => {
    save.disabled = true;
    status.textContent = 'Saving…';
    try {
      appInstructions = await api('api/app/instructions', { method: 'PUT', body: { text: textarea.value } });
      textarea.value = appInstructions.text;
      status.textContent = 'Saved. Every scheme picks this up on its next turn.';
      renderAppInstructionsHead();
      loadHistory();
    } catch (err) {
      status.textContent = err.message;
    }
    sync();
  };
  discard.onclick = () => {
    textarea.value = saved();
    status.textContent = '';
    sync();
  };
  const section = h('section', { class: 'artifacts-main instructions-main' },
    h('div', { class: 'ticket-head', id: 'app-instructions-head' }),
    h('p', { class: 'muted small' },
      'Rules for how people like to work in every scheme. They reach each minion and Taskmaster from its next turn, right before its scheme instructions. ',
      'A scheme instruction overrides one of these only where it names the rule it replaces.'),
    textarea,
    h('div', { class: 'row instructions-actions' }, save, discard, status, h('span', { class: 'spacer' }), counter),
    history,
    githubOwnerField());
  (async () => {
    try {
      appInstructions = await api('api/app/instructions');
      textarea.value = appInstructions.text;
      textarea.disabled = false;
      status.textContent = '';
      renderAppInstructionsHead();
      textarea.focus();
    } catch (err) {
      status.textContent = `Could not load them: ${err.message}`;
    }
    sync();
  })();
  sync();
  loadHistory();
  setTimeout(renderAppInstructionsHead);
  return section;
}

/** The GitHub account new schemes' repos are made under; blank uses the owner of Citadel's own repo. */
function githubOwnerField() {
  const input = h('input', { id: 'github-owner', spellcheck: 'false', autocomplete: 'off', disabled: true });
  const status = h('span', { class: 'muted', role: 'status' });
  const save = h('button', { type: 'button', class: 'secondary' }, 'Save');
  const show = (s) => {
    input.value = s.github_owner ?? '';
    input.placeholder = s.github_owner_default ?? 'caraminden';
    input.disabled = false;
  };
  save.onclick = async () => {
    save.disabled = true;
    try {
      show(await api('api/app/settings', { method: 'PUT', body: { github_owner: input.value } }));
      status.textContent = 'Saved.';
    } catch (err) {
      status.textContent = err.message;
    }
    save.disabled = false;
  };
  api('api/app/settings').then(show, (err) => { status.textContent = `Could not load it: ${err.message}`; });
  return h('div', { class: 'github-owner' },
    h('h3', { class: 'settings-label' }, 'GitHub owner for new schemes'),
    h('p', { class: 'muted small' }, 'A scheme started with a new repo gets a private GitHub repo under this account or organisation. Blank uses the owner of Citadel\'s own repo.'),
    h('div', { class: 'row' }, input, save, status));
}

/** Main panel: edit the project's instructions, or import them from Claude Code. */
export function instructionsEditor() {
  const p = view.project;
  const textarea = h('textarea', {
    id: 'instructions-text', class: 'instructions-text', spellcheck: 'false',
    placeholder: 'What the scheme is for, where the work happens (branches, PR names), how a minion checks its work, what needs a go-ahead first…',
  });
  textarea.value = p.instructions ?? '';
  const counter = h('span', { class: 'muted counter' });
  const status = h('span', { class: 'muted', role: 'status' });
  const save = h('button', { type: 'button' }, 'Save');
  const discard = h('button', { type: 'button', class: 'secondary' }, 'Discard');
  const sync = () => {
    const dirty = textarea.value.trim() !== (view.project.instructions ?? '').trim();
    // Marked as a draft only while it differs, so the app still reloads for an update otherwise.
    textarea.toggleAttribute('data-draft', dirty);
    const n = textarea.value.trim().length;
    counter.textContent = `${count(n)} / ${count(MAX_INSTRUCTIONS)}`;
    counter.classList.toggle('over', n > MAX_INSTRUCTIONS);
    save.disabled = !dirty || n > MAX_INSTRUCTIONS;
    discard.disabled = !dirty;
  };
  textarea.addEventListener('input', () => {
    status.textContent = '';
    sync();
  });
  save.onclick = async () => {
    save.disabled = true;
    status.textContent = 'Saving…';
    try {
      view.project = await api(`api/projects/${p.id}`, { method: 'PATCH', body: { instructions: textarea.value } });
      textarea.value = view.project.instructions;
      status.textContent = 'Saved. Minions pick this up on their next turn.';
      renderInstructionsHead();
      loadHistory();
    } catch (err) {
      status.textContent = err.message;
    }
    sync();
  };
  discard.onclick = () => {
    textarea.value = view.project.instructions ?? '';
    status.textContent = '';
    sync();
  };

  /** Put imported text at the end of what's there (or in place of it), then let people review and save. */
  const insert = (parts, replace) => {
    const add = parts.map((x) => x.trim()).filter(Boolean).join('\n\n');
    if (!add) return;
    textarea.value = replace || !textarea.value.trim() ? add : `${textarea.value.trimEnd()}\n\n${add}`;
    textarea.focus();
    textarea.scrollTop = textarea.scrollHeight;
    status.textContent = 'Imported. Review it, then Save.';
    sync();
  };

  const fileInput = h('input', { type: 'file', accept: '.md,.markdown,.txt,text/markdown,text/plain', multiple: true, hidden: true });
  fileInput.onchange = async () => {
    const files = [...fileInput.files];
    fileInput.value = '';
    insert(await Promise.all(files.map((f) => f.text())), false);
  };
  const picker = h('div', { class: 'import-picker', hidden: true });
  const importButton = h('button', { type: 'button', class: 'secondary' }, 'Import from Claude Code…');
  importButton.onclick = () => {
    if (!picker.hidden) return (picker.hidden = true);
    picker.hidden = false;
    loadInstructionSources(picker, insert);
  };

  const [history, loadHistory] = recentChanges(`api/projects/${p.id}/instructions/history`);

  const section = h('section', { class: 'artifacts-main instructions-main' },
    h('div', { class: 'ticket-head', id: 'instructions-head' }),
    h('div', { class: 'instructions-tools' },
      importButton,
      h('button', { type: 'button', class: 'secondary', onclick: () => fileInput.click() }, 'Import a file…'),
      fileInput,
      h('span', { class: 'muted small' }, 'Or paste: from a Claude Code project at claude.ai/code, copy Project settings › Memory › Project instructions.')),
    picker,
    textarea,
    h('div', { class: 'row instructions-actions' }, save, discard, status, h('span', { class: 'spacer' }), counter),
    history);
  sync();
  loadHistory();
  setTimeout(() => {
    renderInstructionsHead();
    textarea.focus();
  });
  return section;
}

// ---------- machines ----------

export function onMachinesUpdate(machines) {
  if (view?.kind !== 'project') return;
  view.machines = machines;
  renderMachinesShelf();
  renderMachineList();
}

/** "online on cara-laptop · 2 threads using it" or "offline · seen 3h ago". */
function machineStatus(m) {
  if (m.online) return [`online${m.host ? ` on ${m.host}` : ''}`, m.sessions ? `${m.sessions} in use` : ''].filter(Boolean).join(' · ');
  return m.last_seen_at ? `offline · seen ${ago(m.last_seen_at)}` : 'not connected yet';
}

/** Overview panel: people's computers lending threads their MCP tools, with live status. */
export function renderMachinesShelf() {
  const el = document.getElementById('machines-shelf');
  if (!el) return;
  const href = `#/p/${view.projectId}/machines`;
  el.replaceChildren(h('section', { class: 'column' },
    h('h3', {}, 'Machines', h('span', { class: 'spacer' }),
      h('a', { class: `browse${view.main === 'machines' ? ' active' : ''}`, href }, view.machines.length ? 'Manage' : 'Add')),
    view.machines.length
      ? view.machines.map((m) => h('a', { class: `machine-item${m.online ? ' online' : ''}`, href, title: m.command ? `Runs ${m.command}` : '' },
        h('span', { class: `dot${m.online ? ' online' : ''}` }),
        h('span', { class: 'text' }, h('span', { class: 'name' }, m.name), h('span', { class: 'meta' }, machineStatus(m)))))
      : h('p', { class: 'muted small' }, 'Lend minions MCP tools from your own computers, like a Godot editor that runs builds.')));
}

/** Main panel: add machines, show how to connect them, and remove them or replace their token. */
export function machinesPage() {
  view.machineToken = null; // { id, name, token } just made, shown until you leave the page
  const name = h('input', { name: 'name', placeholder: 'godot-laptop', required: true, maxlength: 30, autocomplete: 'off', pattern: '[a-z0-9][a-z0-9\\-]*' });
  const kind = h('select', { name: 'kind' },
    h('option', { value: 'claude' }, 'Claude Code MCP server named'),
    h('option', { value: 'command' }, 'Command'),
    h('option', { value: 'none' }, 'None'));
  const command = h('input', { name: 'command', value: DEFAULT_CLAUDE_MCP, autocomplete: 'off', spellcheck: 'false' });
  kind.onchange = () => {
    command.value = kind.value === 'claude' ? DEFAULT_CLAUDE_MCP : '';
    command.placeholder = kind.value === 'claude' ? DEFAULT_CLAUDE_MCP : 'npx -y some-mcp-server';
    command.hidden = kind.value === 'none';
    renderMachineSetup();
  };
  command.addEventListener('input', renderMachineSetup);
  const folder = h('input', { name: 'folder', placeholder: 'C:\\Users\\you\\Documents\\Vault', autocomplete: 'off', spellcheck: 'false' });
  folder.addEventListener('input', renderMachineSetup);
  const status = h('span', { class: 'muted', role: 'status' });
  const form = h('form', { class: 'machine-add' },
    h('label', {}, 'Name', name),
    h('label', { class: 'wide' }, 'MCP server to run there', h('span', { class: 'row' }, kind, command)),
    h('label', { class: 'wide' }, 'Folder minions can use (optional)', folder),
    h('button', { type: 'submit' }, 'Add machine'),
    status);
  form.onsubmit = async (e) => {
    e.preventDefault();
    status.textContent = 'Adding…';
    try {
      const { machine, token, agent_url } = await api('api/machines', { method: 'POST', body: { name: name.value.trim().toLowerCase(), ...(folder.value.trim() ? { workspace_tools: true } : {}) } });
      view.machineToken = { id: machine.id, name: machine.name, token, url: agent_url ?? location.origin };
      name.value = '';
      status.textContent = '';
      renderMachineSetup();
    } catch (err) {
      status.textContent = err.message;
    }
  };
  const section = h('section', { class: 'artifacts-main machines-main' },
    h('div', { class: 'ticket-head' },
      h('div', { class: 'row' }, h('h2', {}, 'Machines'), h('span', { class: 'spacer' }),
        h('a', { class: 'close-view', href: `#/p/${view.projectId}`, title: 'Back to the Taskmaster', 'aria-label': 'Close' }, icon('close'))),
      h('div', { class: 'meta' }, account?.admin
        ? 'Computers that lend their MCP tools to minions while they are connected: in every scheme an admin owns, or only in the schemes picked under Lend to. They dial out to this app (over the tailnet, where one is set up), so it never has to reach them.'
        : 'Your computers, lending their MCP tools to minions while they are connected, in the schemes you tick under Lend to. They dial out to this app (over the tailnet, where one is set up), so it never has to reach them. Only you and the admins can change them.')),
    form,
    h('div', { id: 'machine-setup' }),
    h('div', { id: 'machine-list', class: 'machine-list' }),
    h('p', { class: 'muted small' },
      'Each machine runs one MCP server, or none; add another machine for a second one. It needs Node 18 or newer. ',
      'A folder typed when adding a machine goes into machine-agent.json by the setup lines, and the machine starts with workspace tools on. ',
      'With workspace tools switched on, minions also get mcp__<name>-ws__…: git sync and the tasks its owner lists in machine-agent.json on that computer, nothing else. ',
      '"Claude Code MCP server" runs one already set up for Claude Code on that computer, like godot-ai after its dock\'s Configure. ',
      'A minion gets the tools of every machine online and lent to its scheme when its turn starts, named mcp__<name>__…, plus the machine\'s notes, and the tools act on that computer, ',
      'so only add servers you trust minions to run.'));
  setTimeout(() => {
    renderMachineSetup();
    renderMachineList();
    name.focus();
  });
  return section;
}

function renderMachineSetup() {
  const el = document.getElementById('machine-setup');
  if (!el) return;
  const t = view.machineToken;
  if (!t) return el.replaceChildren();
  const kind = document.querySelector('.machine-add select[name=kind]')?.value;
  const command = document.querySelector('.machine-add input[name=command]')?.value.trim();
  const folder = document.querySelector('.machine-add input[name=folder]')?.value.trim();
  const block = (label, text) => {
    const copy = h('button', { type: 'button', class: 'secondary small' }, 'Copy');
    copy.onclick = async () => {
      await navigator.clipboard.writeText(text);
      copy.textContent = 'Copied';
    };
    return [h('div', { class: 'row' }, h('span', { class: 'small' }, label), h('span', { class: 'spacer' }), copy), h('pre', {}, text)];
  };
  el.replaceChildren(h('div', { class: 'machine-setup' },
    h('strong', {}, `Connect ${t.name}`),
    h('p', { class: 'small' }, 'The token is shown only now; if you lose it, make a new one. Run one of these on that computer:'),
    folder ? h('p', { class: 'small' }, `It adds ${folder} to machine-agent.json there as workspace ${workspaceName(folder)}, keeping what the file already lists. `,
      'If the folder is a git repo it also gets a pull task (git pull --ff-only) with git sync off; pull uses the git sign-in saved on that computer, so check git pull works there first.',
      view.machines.find((m) => m.id === t.id)?.workspace_tools === false ? ' Workspace tools are off for this machine: switch them on below so minions get the folder.' : '') : false,
    ...block('Windows PowerShell: starts now and at every logon, no reboot', machineSetupWindows(t.url, t.name, t.token, kind, command, folder)),
    ...block('Any computer, in a terminal you leave open', machineSetup(t.url, t.token, kind, command, folder))));
}

function renderMachineList() {
  const el = document.getElementById('machine-list');
  if (!el) return;
  el.replaceChildren(...view.machines.map((m) => {
    const newToken = h('button', { type: 'button', class: 'secondary small', title: 'Make a new token; the old one stops working and the machine disconnects' }, 'New token');
    newToken.onclick = async () => {
      if (!confirm(`Make a new token for ${m.name}? Its current connection stops and it has to be set up again.`)) return;
      const { token, agent_url } = await api(`api/machines/${m.id}/token`, { method: 'POST' }).catch((err) => alert(err.message) ?? {});
      if (!token) return;
      view.machineToken = { id: m.id, name: m.name, token, url: agent_url ?? location.origin };
      renderMachineSetup();
    };
    const remove = h('button', { type: 'button', class: 'secondary small' }, 'Remove');
    remove.onclick = async () => {
      if (!confirm(`Remove ${m.name}? Minions lose its tools and its token stops working.`)) return;
      await api(`api/machines/${m.id}`, { method: 'DELETE' }).catch((err) => alert(err.message));
      if (view.machineToken?.id === m.id) view.machineToken = null;
      renderMachineSetup();
    };
    const notes = h('textarea', { rows: 4, maxlength: 2000, placeholder: 'What minions should know: never restart it, where the repo is cloned, what to check first…' });
    notes.value = m.notes ?? '';
    const saved = h('span', { class: 'muted small', role: 'status' });
    const save = h('button', { type: 'button', class: 'small' }, 'Save notes');
    save.onclick = async () => {
      saved.textContent = 'Saving…';
      try {
        await api(`api/machines/${m.id}`, { method: 'PATCH', body: { notes: notes.value } });
        saved.textContent = 'Saved; minions get them from their next turn.';
      } catch (err) {
        saved.textContent = err.message;
      }
    };
    // Keep an open notes editor open (and its draft) when the list re-renders for a status change.
    const old = document.querySelector(`.machine-notes[data-id="${m.id}"]`);
    const editing = old?.open;
    if (editing) notes.value = old.querySelector('textarea').value;
    return h('div', { class: `machine-row${m.online ? ' online' : ''}` },
      h('div', { class: 'row' },
        h('span', { class: `dot${m.online ? ' online' : ''}` }),
        h('span', { class: 'text' },
          h('span', { class: 'name' }, m.name),
          h('span', { class: 'meta' }, [machineStatus(m), m.command, `added by ${m.created_by}`].filter(Boolean).join(' · '))),
        newToken, remove),
      machineWorkspaces(m),
      machineLending(m),
      h('details', { class: 'machine-notes', 'data-id': m.id, open: editing },
        h('summary', {}, m.notes ? `Notes: ${m.notes.split('\n')[0]}` : 'Add notes for minions'),
        notes, h('div', { class: 'row' }, save, saved)));
  }));
}

// What a machine-agent.json looks like, for the Machines page; the owner writes it beside the agent.
const WORKSPACE_EXAMPLE = `{
  "workspaces": {
    "delve": {
      "path": "C:\\\\Users\\\\you\\\\Projects\\\\delve",
      "read": ["%APPDATA%\\\\Godot\\\\app_userdata\\\\Delve"],
      "tasks": {
        "build": {
          "run": ["dotnet", "build", "Delve.sln"],
          "hints": [{ "match": "MSB3027|used by another process", "say": "Close the game and the editor, then retry." }]
        },
        "import": { "run": ["cmd.exe", "/c", "tools\\\\prepare.cmd"], "about": "imports new art" }
      }
    },
    "vault": { "path": "%USERPROFILE%\\\\Documents\\\\Vault", "git_sync": false }
  }
}`;

/** A machine's workspace tools: the switch, and the workspaces and tasks its agent reports. */
function machineWorkspaces(m) {
  const toggle = h('input', { type: 'checkbox', checked: m.workspace_tools });
  const status = h('span', { class: 'muted small', role: 'status' });
  toggle.onchange = async () => {
    status.textContent = 'Saving…';
    try {
      await api(`api/machines/${m.id}`, { method: 'PATCH', body: { workspace_tools: toggle.checked } });
      status.textContent = '';
    } catch (err) {
      toggle.checked = !toggle.checked;
      status.textContent = err.message;
    }
  };
  const workspaces = m.workspaces ?? [];
  const reported = !m.online
    ? h('p', { class: 'muted small' }, 'Shows the workspaces its agent offers once it connects.')
    : workspaces.length
      ? workspaces.map((w) => h('div', { class: 'machine-workspace small' },
        h('div', {}, h('strong', {}, w.name), ' ', h('code', {}, w.path), w.git_sync === false ? h('span', { class: 'muted' }, ' · git_sync off') : ''),
        w.read.length ? h('div', { class: 'muted' }, 'Also readable: ', w.read.join(', ')) : '',
        h('ul', {}, w.tasks.map((t) => h('li', {}, h('code', {}, t.name), ': ', t.run.join(' '), t.about ? h('span', { class: 'muted' }, ` (${t.about})`) : '')))))
      : h('details', { class: 'small' },
        h('summary', {}, 'No workspaces. Its owner lists them in machine-agent.json beside the agent'),
        h('p', { class: 'muted' }, 'Minions can check out pushed branches there and run only the tasks listed, with no shell. "git_sync": false keeps them from checking anything out in a workspace you keep on a branch yourself (an Obsidian vault with Obsidian Git, say). The agent picks up changes to the file by itself (agents set up before workspaces need setting up again with a new token).'),
        h('pre', {}, WORKSPACE_EXAMPLE));
  return h('div', { class: 'machine-workspaces' },
    h('label', { class: 'row small', title: 'Lets minions in every scheme check out pushed branches and run the listed tasks on this computer' },
      toggle, h('span', {}, 'Workspace tools for minions'), status),
    reported,
    ...(m.problems ?? []).map((p) => h('p', { class: 'error small' }, p)));
}

/** Which schemes' minions get a machine: every admin-owned scheme (an admin's default), or only the ones ticked (#303; always for a person's own, #306). */
function machineLending(m) {
  const status = h('span', { class: 'muted small', role: 'status' });
  const save = async (projects) => {
    status.textContent = 'Saving…';
    try {
      await api(`api/machines/${m.id}`, { method: 'PATCH', body: { projects } });
      status.textContent = '';
    } catch (err) {
      status.textContent = err.message;
      renderMachineList();
    }
  };
  const choice = (scoped, label, title) => {
    const radio = h('input', { type: 'radio', name: `lend-${m.id}`, checked: scoped === (m.projects !== null) });
    // "Only these" starts with none ticked, so grants left from before never come back by themselves.
    radio.onchange = () => save(scoped ? [] : null);
    return h('label', { class: 'row small', title }, radio, h('span', {}, label));
  };
  const schemes = m.projects === null ? [] : (view.projects ?? []).map((p) => {
    const box = h('input', { type: 'checkbox', checked: m.projects.includes(p.id) });
    box.onchange = () => save([...document.querySelectorAll(`.machine-lending[data-id="${m.id}"] .schemes input:checked`)].map((b) => Number(b.value)));
    box.value = p.id;
    return h('label', { class: 'row small' }, box, h('span', {}, p.name));
  });
  return h('div', { class: 'machine-lending', 'data-id': m.id },
    h('div', { class: 'row small' }, h('span', { class: 'muted' }, 'Lend to'), status),
    // A person's own machine only ever goes to ticked schemes (#306), so there is nothing to choose.
    m.personal ? '' : choice(false, 'Every scheme an admin owns', 'Minions in every scheme an admin owns get it, as for every machine before'),
    m.personal ? '' : choice(true, 'Only these schemes', 'Only the ticked schemes\' minions get it, whoever owns the scheme; Taskmasters never do'),
    m.projects === null ? '' : h('div', { class: 'schemes' }, ...schemes,
      m.projects.length ? '' : h('p', { class: 'muted small' }, 'No scheme gets it until you tick one.')));
}

/** The import picker: this app's Claude Code instruction and memory files, to tick and add. */
async function loadInstructionSources(el, insert) {
  el.replaceChildren(h('p', { class: 'muted small' }, 'Looking for Claude Code instructions and memory…'));
  let sources;
  try {
    ({ sources } = await api(`api/projects/${view.projectId}/instructions/sources`));
  } catch (err) {
    el.replaceChildren(h('p', { class: 'error' }, `Could not list Claude Code files: ${err.message}`));
    return;
  }
  if (!sources.length) {
    el.replaceChildren(h('p', { class: 'muted small' }, 'No Claude Code instructions or memory files found for this login. Import a file or paste instead.'));
    return;
  }
  const picked = new Set();
  const add = h('button', { type: 'button', disabled: true }, 'Add to instructions');
  const replace = h('button', { type: 'button', class: 'secondary', disabled: true }, 'Replace instructions');
  const update = () => {
    add.disabled = replace.disabled = !picked.size;
    add.textContent = picked.size > 1 ? `Add ${picked.size} to instructions` : 'Add to instructions';
  };
  const chosen = () => sources.filter((s) => picked.has(s.id)).map((s) => s.content);
  add.onclick = () => insert(chosen(), false);
  replace.onclick = () => insert(chosen(), true);
  const groups = [...new Set(sources.map((s) => s.group))];
  el.replaceChildren(
    ...groups.map((g) => h('div', { class: 'sub' }, h('h4', {}, g),
      sources.filter((s) => s.group === g).map((s) => {
        const box = h('input', { type: 'checkbox', onchange: () => { box.checked ? picked.add(s.id) : picked.delete(s.id); update(); } });
        return h('details', { class: 'import-source' },
          h('summary', {},
            h('label', {}, box, h('span', { class: 'name' }, s.label)),
            h('span', { class: 'meta' }, `${s.path} · ${count(s.content.length)} chars${s.truncated ? ' (cut short)' : ''}`),
            s.note ? h('span', { class: 'meta hint' }, s.note) : ''),
          h('pre', {}, s.content));
      }))),
    h('div', { class: 'row' }, add, replace, h('span', { class: 'muted small' }, 'Click a name to preview it.')));
}
