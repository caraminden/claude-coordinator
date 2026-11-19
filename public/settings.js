// A scheme's settings: notifications, the Settings page's instructions and approvals tabs, and the Machines page.
import { account, ago, api, h, icon, listGroupsOf, me, schemeIcon, view } from './base.js';
import { openHash } from './core.js';
import { firefoxAvailable, firefoxOn, setFirefoxOn } from './extlinks.js';
import { agentLog, machineSetupPosix, machineSetupRunnerAgent, machineSetupRunnerAgentLinux, machineSetupWindows } from './machine-setup.js';
import { renderSidebar } from './sidebar.js';
import { copyText } from './ui/markdown.js';
import { optimistic } from './ui/optimistic.js';
import { toast } from './ui/status.js';
import { instructionCost } from './prompt-cost.js';
import { machineJobsSection } from './jobs.js';

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

// What this browser last said of its push state, drawn at once on the next scheme so the box keeps its height while it asks again.
let pushState = { subscribed: false, muted: [] };

/**
 * "Open links in Firefox" (#988): this device sends external links to Firefox through Windows (extlinks.js), for an
 * installed Chrome or Edge app that would open them in its own browser. Off until turned on; null where it can't work
 * (anything but a Windows desktop).
 */
export function firefoxControls() {
  if (!firefoxAvailable()) return null;
  const on = h('input', { type: 'checkbox', checked: firefoxOn() });
  on.addEventListener('change', () => { setFirefoxOn(on.checked); hint.hidden = !on.checked; });
  const hint = h('span', { class: 'hint', hidden: !on.checked }, 'Needs a one-time setup on this PC: ',
    h('a', { href: 'citadel-firefox-link.ps1', download: '' }, 'download the setup script'), ', run it in PowerShell, and tick "Always allow" when the browser asks.');
  return h('div', { class: 'account-card' }, h('h3', {}, 'Links on this device'),
    h('label', { class: 'toggle', title: 'Send links to other websites to Firefox, not this browser. Needs a one-time setup on this PC' }, on, 'Open links in Firefox'), hint);
}

/** "Notify me on this device", and once on, pinned-only and a mute for this project; in the account box. */
export function pushControls(project) {
  if (!pushSupported) return null;
  const on = h('input', { type: 'checkbox' });
  const mute = h('input', { type: 'checkbox' });
  const pinned = h('input', { type: 'checkbox' });
  const all = h('input', { type: 'checkbox' });
  const hint = h('span', { class: 'hint', hidden: true });
  const muteRow = h('label', { class: 'toggle', hidden: true, title: 'Stop notifications from this scheme on this device' }, mute, `Mute ${project.name} here`);
  const pinnedRow = h('label', { class: 'toggle', hidden: true, title: 'On this device, notify only about minions you pinned (other people\'s too) and the Taskmaster' }, pinned, 'Only my pinned minions');
  // #690: a minion's pings go to its owner; this device can still hear every minion in the scheme.
  const allRow = h('label', { class: 'toggle', hidden: true, title: 'On this device, hear about every minion in this scheme, not only yours, the ones you pinned and the unassigned ones' }, all, `Everything in ${project.name}`);
  const el = h('div', { class: 'push' },
    h('label', { class: 'toggle', title: 'Questions for you, failed turns, and your minions that are ready or blocked' }, on, 'Notify me on this device'),
    allRow, pinnedRow, muteRow, hint);
  const show = (state, err) => {
    pushState = state;
    on.checked = state.subscribed;
    mute.checked = state.muted.includes(project.id);
    pinned.checked = !!state.onlyPinned;
    all.checked = !!state.everything?.includes(project.id);
    muteRow.hidden = pinnedRow.hidden = allRow.hidden = !state.subscribed;
    const denied = Notification.permission === 'denied';
    on.disabled = denied && !state.subscribed;
    hint.textContent = err ?? (denied && !state.subscribed ? 'Blocked for this site in the browser settings' : '');
    hint.hidden = !hint.textContent;
  };
  const busy = async (fn) => {
    on.disabled = mute.disabled = pinned.disabled = all.disabled = true;
    try {
      show(await fn());
    } catch (ex) {
      await refresh(ex.message);
    } finally {
      mute.disabled = pinned.disabled = all.disabled = false;
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
  all.addEventListener('change', () => busy(async () => {
    const sub = await pushSubscription();
    return api('api/push/subscription', { method: 'PATCH', body: { endpoint: sub.endpoint, projectId: project.id, everything: all.checked } });
  }));
  pinned.addEventListener('change', () => busy(async () => {
    const sub = await pushSubscription();
    return api('api/push/subscription', { method: 'PATCH', body: { endpoint: sub.endpoint, onlyPinned: pinned.checked } });
  }));
  show(pushState);
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
// A share from the Share sheet (/c/share?…, #375) goes to its route, which reloads an open frame there;
// encoded as the server's redirect does (src/http.ts ownPath), so a fresh launch's own share isn't taken twice.
const shareHash = (url) => {
  const q = new URLSearchParams(url.search).toString();
  return `#/share${q ? `?${q}` : ''}`;
};
if ('launchQueue' in window) {
  window.launchQueue.setConsumer(({ targetURL }) => {
    const url = targetURL && new URL(targetURL);
    const hash = url && (url.pathname.endsWith('/c/share') ? shareHash(url) : url.hash);
    if (hash) openHash(hash);
  });
}

// ---------- project instructions ----------

const MAX_INSTRUCTIONS = 32000;
const count = (n) => n.toLocaleString('en');

export function onProjectUpdate(project) {
  for (const el of document.querySelectorAll(`[data-project-name="${project.id}"]`)) el.textContent = project.name;
  for (const el of document.querySelectorAll(`[data-taskmaster-name="${project.id}"]`)) el.textContent = `${project.name} Taskmaster`;
  if (view?.kind !== 'project') return;
  view.projects = view.projects.map((p) => (p.id === project.id ? { ...p, name: project.name } : p));
  if (view.projectId !== project.id) return;
  view.project = project;
  for (const [id, key] of [['approval-rules', 'approval_rules'], ['plugin-dirs', 'plugin_dirs'], ['optional-plugin-dirs', 'optional_plugin_dirs'], ['list-groups', 'list_groups'], ['ci-quiet', 'ci_quiet'], ['ci-watch', 'ci_watch']]) {
    const el = document.getElementById(id);
    if (el && !el.hasAttribute('data-draft')) el.value = settingText(project, key);
    el?.dispatchEvent(new Event('settings-refresh'));
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
 * The overview's header: the project name, then who is signed in behind a divider. The name is a button
 * that turns it into a text field in place (on a collapsed panel it opens the panel instead). Enter or ✓
 * saves; Esc or tapping away cancels.
 * It sits in the panel's <summary>, so its own clicks and keys must not collapse the panel or close
 * the phone drawer.
 */
export function projectTitle(project) {
  const wrap = h('span', { class: 'project-title' });
  // Settings sits beside the scheme it belongs to (Josh, 2026-11-13); made once so a rename keeps its count.
  const settings = h('a', { class: 'settings-link', href: `#/p/${project.id}/settings`, title: 'Instructions, approvals, properties and machines for this scheme' },
    'Settings', h('span', { id: 'settings-count', class: 'count', hidden: true }));
  const show = () => {
    wrap.replaceChildren(
      schemeIcon(view.projects?.find((p) => p.id === project.id) ?? project),
      h('button', { type: 'button', class: 'label', 'data-project-name': project.id, title: 'Rename scheme (its repo stays as it is)', onclick: edit }, view.project.name),
      h('span', { class: 'divider', 'aria-hidden': 'true' }),
      settings);
  };
  // Every label showing the name changes now; the server's broadcast confirms it, and a refusal puts the old name back.
  const rename = (name) => onProjectUpdate({ ...(view.projectId === project.id ? view.project : project), name });
  const edit = () => {
    const panel = wrap.closest('details');
    if (panel && !panel.open) { panel.open = true; return; }
    const input = h('input', { class: 'rename-input', value: view.project.name, maxlength: '80', 'aria-label': 'Scheme name' });
    const save = () => {
      const name = input.value.trim(); // as the server stores it
      const was = view.project.name;
      show();
      if (!name || name === was) return;
      optimistic({
        key: `scheme-name:${project.id}`,
        apply: () => rename(name),
        send: () => api(`api/projects/${project.id}`, { method: 'PATCH', body: { name } }),
        undo: () => (view.projects?.find((p) => p.id === project.id)?.name ?? view.project?.name) === name && rename(was), // unless a later rename changed it again
        label: `rename the scheme to ${name}`,
      });
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); save(); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); show(); }
    });
    // A space let through to the <summary> would collapse the panel in some browsers.
    input.addEventListener('keyup', (e) => { if (e.key === ' ') e.preventDefault(); });
    input.addEventListener('blur', () => input.isConnected && show());
    wrap.replaceChildren(input,
      // mousedown kept from blurring the field, so the tap reaches save instead of cancelling.
      h('button', { type: 'button', class: 'rename', 'aria-label': 'Save name', onmousedown: (e) => e.preventDefault(), onclick: save }, '✓'));
    input.focus();
    input.select();
  };
  wrap.addEventListener('click', (e) => {
    // Clicks inside the title edit it; they don't collapse the panel or close the drawer.
    if (e.target.closest('button, input')) { e.preventDefault(); e.stopPropagation(); }
    else if (e.target.closest('a')) e.stopPropagation(); // Settings goes there without toggling the panel
  });
  show();
  return wrap;
}

const splitLines = (text) => (text ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
/** A settings field's text: list_groups is stored as a JSON list and edited one per line. */
const settingText = (p, key) => (key === 'list_groups' ? listGroupsOf(p).join('\n') : p[key] ?? '');

/** The Settings page's tabs; each is its own route, so old links to them still work. */
// The side menu (#995, Cara picked "Side menu, rows that open"): three groups, each its own hue, every page with an
// icon. On a phone it is one row of chips that scrolls sideways, the open page scrolled into view.
const SETTINGS_GROUPS = [
  ['Scheme', 'running', [['instructions', 'Instructions', 'doc'], ['approvals', 'Minion rules', 'shield'], ['properties', 'Properties', 'tag'], ['members', 'Members', 'users']]],
  ['You', 'held', [['my-instructions', 'My instructions', 'pen'], ['account', 'Your account', 'user'], ['machines', 'Machines', 'monitor'], ['usage', 'Usage', 'chart']]],
  ['Admin', 'teal', [['app-instructions', 'Citadel-wide', 'globe'], ['people', 'People', 'people'], ['contraptions', 'Contraptions', 'box']], true],
];

export function settingsTabs() {
  const nav = h('nav', { class: 'settings-tabs', 'aria-label': 'Settings' },
    SETTINGS_GROUPS.filter(([, , , admin]) => !admin || account?.admin).map(([label, hue, items]) =>
      h('div', { class: 'settings-group', 'data-hue': hue }, h('span', { class: 'settings-group-label' }, label),
        items.map(([kind, text, ic]) =>
          h('a', { class: view.main === kind ? 'active' : '', href: `#/p/${view.projectId}/${kind}`, 'aria-current': view.main === kind ? 'page' : null },
            icon(ic), h('span', { class: 'label' }, text),
            kind === 'properties' ? h('span', { class: 'count props-count', hidden: true }) : '')))));
  setTimeout(() => { const on = nav.querySelector('a.active'); if (on) nav.scrollLeft += on.getBoundingClientRect().right - nav.getBoundingClientRect().right + 16; });
  return nav;
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

/**
 * Save some of a scheme's settings optimistically: `mine` (the fields as the page shows them saved) goes into
 * view.project at once and shown(true) redraws; the PATCH sends `body` behind it. A refusal puts the old values
 * back, unless a later save changed them again, and shown(false) says so; the page's fields keep what was typed,
 * so they read as drafts again. The server's own copy replaces ours once it answers, unless a later save is pending.
 */
function saveProject(p, mine, body, label, shown) {
  const was = Object.fromEntries(Object.keys(mine).map((k) => [k, view.project?.[k]]));
  const ours = () => view.project?.id === p.id && Object.entries(mine).every(([k, v]) => view.project[k] === v);
  const result = optimistic({
    key: `scheme-settings:${p.id}`,
    apply: () => {
      if (view.project?.id === p.id) Object.assign(view.project, mine);
      renderSidebar();
      shown(true);
    },
    send: () => api(`api/projects/${p.id}`, { method: 'PATCH', body }),
    undo: () => {
      if (!ours()) return; // a later save changed them again
      Object.assign(view.project, was);
      renderSidebar();
      shown(false);
    },
    label,
  });
  result.then((project) => ours() && onProjectUpdate(project), () => {}); // a failure already said so in its toast
  return result;
}

/**
 * A row that opens (#995, Cara picked "Side menu, rows that open"): an icon tile in its own hue, a title, a one-line
 * summary and a chevron; the body (help, field, Save) opens beneath it on a click. Returns the row and its summary
 * line, which its page keeps up to date.
 */
export function settingsRow({ icon: ic, hue, title, summary = '', open = false }, ...body) {
  const sum = h('span', { class: 'settings-row-sum' }, summary);
  const row = h('details', { class: 'settings-row', 'data-hue': hue, open },
    h('summary', {}, h('span', { class: 'settings-tile' }, icon(ic)),
      h('span', { class: 'settings-row-text' }, h('span', { class: 'settings-row-title' }, title), sum),
      h('span', { class: 'settings-row-chev' }, icon('forward'))),
    h('div', { class: 'settings-row-body' }, ...body));
  return [row, sum];
}

/** A group of rows under an uppercase heading. */
export const settingsSection = (title, ...rows) => [h('h3', { class: 'settings-section' }, title), h('div', { class: 'settings-rows' }, ...rows)];

/**
 * A strip of in-page links at the top of a long page (Cara picked "Jump links on long pages"). Plain `#id` links would
 * hit the hash router, so each scrolls its target (an element with that id, which carries .settings-anchor) into view.
 */
export function settingsJump(...links) {
  return h('nav', { class: 'settings-jump', 'aria-label': 'On this page' }, links.map(([id, label]) =>
    h('a', { href: `#/p/${view.projectId}/${view.main}`, onclick: (e) => {
      e.preventDefault();
      document.getElementById(id)?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    } }, label)));
}

/** Help text cut to its first sentence, the rest behind More (Cara picked "Shorter help text"). */
export function settingsHelp(first, ...rest) {
  if (!rest.length) return h('p', { class: 'muted small settings-help' }, first);
  const more = h('span', { class: 'settings-more', hidden: true }, ' ', ...rest);
  const btn = h('button', { type: 'button', class: 'settings-more-btn', 'aria-expanded': 'false', onclick: () => {
    more.hidden = !more.hidden;
    btn.textContent = more.hidden ? 'More' : 'Less';
    btn.setAttribute('aria-expanded', String(!more.hidden));
  } }, 'More');
  return h('p', { class: 'muted small settings-help' }, first, more, ' ', btn);
}

/** Main panel: Minion rules, the scheme's approval rules, plugin folders, list groups and CI lists, a row each. */
export function approvalsEditor() {
  const p = view.project;
  const admin = !!account?.admin;
  const same = (a, b) => splitLines(a).join('\n') === splitLines(b).join('\n');
  // One row per setting, with its own Save and Discard: only what that row holds is sent.
  const setting = ({ id, key, placeholder, rows = 3, title, ic, hue, unit, examples = [], caution = '', readOnly = false, help }) => {
    const t = h('textarea', { id, class: 'instructions-text settings-list', spellcheck: 'false', rows, placeholder, 'aria-label': title });
    t.value = settingText(p, key);
    t.readOnly = readOnly;
    const status = h('span', { class: 'muted small', role: 'status' });
    const save = h('button', { type: 'button' }, 'Save');
    const discard = h('button', { type: 'button', class: 'secondary' }, 'Discard');
    const [row, sum] = settingsRow({ icon: ic, hue, title },
      ...help,
      t,
      examples.length && !readOnly ? h('div', { class: 'settings-examples' }, h('span', { class: 'muted small' }, 'Add an example:'),
        examples.map((x) => h('button', { type: 'button', class: 'chip', title: 'Add this line to the list', onclick: () => {
          if (splitLines(t.value).includes(x)) return t.focus();
          t.value = [t.value.trimEnd(), x].filter(Boolean).join('\n');
          t.dispatchEvent(new Event('input'));
        } }, '+ ', h('code', {}, x)))) : '',
      caution ? h('p', { class: 'cui-notice small' }, caution) : '',
      readOnly ? h('p', { class: 'muted small' }, 'Only an admin changes these.') : h('div', { class: 'settings-row-actions' }, save, discard, status));
    // The summary says what the row holds, or that it has changed and isn't saved; the field is marked as a draft only
    // while it differs, so someone else's save still shows otherwise.
    const sync = () => {
      const dirty = !same(t.value, settingText(view.project, key));
      t.toggleAttribute('data-draft', dirty);
      row.classList.toggle('changed', dirty);
      const n = splitLines(settingText(view.project, key));
      sum.textContent = dirty ? 'Changed, not saved yet' : n.length ? `${n.length} ${unit}${n.length > 1 ? 's' : ''}: ${n.join(', ')}` : `No ${unit}s yet`;
      save.disabled = discard.disabled = !dirty;
    };
    t.addEventListener('input', () => { status.textContent = ''; row.classList.remove('saved'); sync(); });
    t.addEventListener('settings-refresh', sync); // onProjectUpdate: a save, ours or someone else's
    // Saved at once: the field stops counting as a draft; a refusal turns it back into one (the text stays) with a toast to retry.
    save.onclick = () => {
      // list_groups goes as a list; the project keeps it as JSON.
      const body = { [key]: key === 'list_groups' ? splitLines(t.value) : t.value };
      const mine = { [key]: key === 'list_groups' ? JSON.stringify(body[key]) : t.value };
      saveProject(p, mine, body, `save ${title.toLowerCase()}`, (saved) => {
        status.textContent = saved ? 'Saved. Minions pick this up on their next turn.' : 'Not saved.';
        row.classList.toggle('saved', saved);
        sync();
      });
    };
    discard.onclick = () => { t.value = settingText(view.project, key); t.dispatchEvent(new Event('input')); };
    sync();
    return row;
  };
  const section = h('section', { class: 'artifacts-main instructions-main' },
    h('div', { class: 'ticket-head' },
      h('div', { class: 'row' }, h('h2', {}, 'Settings'), h('span', { class: 'spacer' }), tuneUpButton(),
        h('a', { class: 'close-view', href: `#/p/${p.id}`, title: 'Back to the Taskmaster', 'aria-label': 'Close' }, icon('close'))),
      settingsTabs(),
      h('div', { class: 'meta' }, 'Minions in this scheme use these from their next turn. The Taskmaster is not affected.')),
    settingsSection('Approvals',
      setting({ id: 'approval-rules', key: 'approval_rules', rows: 5, placeholder: 'Bash(gh pr merge:*)\nmcp__*__merge_pull_request', title: 'Needs approval', ic: 'shield', hue: 'waiting', unit: 'rule',
        examples: ['Bash(gh pr merge:*)', 'mcp__*__merge_pull_request'], caution: 'Bash rules match how a command starts: they catch mistakes, not a determined workaround.',
        help: [settingsHelp('Tool calls that wait for Approve or Deny in the minion\'s chat.', 'One Claude Code permission rule per line; everything else runs without asking.')] })),
    // Plugins load code from any folder on the server, so only an admin changes them.
    settingsSection('Plugins',
      setting({ id: 'plugin-dirs', key: 'plugin_dirs', placeholder: 'tools/mods/delve', title: 'Plugin folders', ic: 'plug', hue: 'held', unit: 'folder', examples: ['tools/mods/delve'], readOnly: !admin,
        help: [settingsHelp('Claude Code plugins every minion loads.', '(', h('code', {}, '--plugin-dir'), ') One folder per line, relative to the repo root or absolute; a folder that is not there is skipped.')] }),
      setting({ id: 'optional-plugin-dirs', key: 'optional_plugin_dirs', placeholder: 'tools/plugins/devtools', title: 'Optional plugin folders', ic: 'plugplus', hue: 'held', unit: 'folder', examples: ['tools/plugins/devtools'], readOnly: !admin,
        help: [settingsHelp('Plugins too costly for every minion: one loads them only when picked.', 'The Taskmaster picks them when it starts the minion, or you do in the Plugins picker beside Send.')] })),
    settingsSection('Minions list',
      setting({ id: 'list-groups', key: 'list_groups', placeholder: 'area: balance', title: 'List groups', ic: 'rows', hue: 'teal', unit: 'group',
        help: [settingsHelp(['Values of this scheme\'s own properties, one per line, like ', h('code', {}, 'area: balance'), '.'],
          'Minions outside a build that carry one get their own group at the top of the minions list; one that matches two sits in the first.')] })),
    settingsSection('CI',
      setting({ id: 'ci-quiet', key: 'ci_quiet', placeholder: 'drift.yml', title: 'Quiet CI workflows', ic: 'belloff', hue: 'running', unit: 'workflow',
        help: [settingsHelp(['Workflows listed here, like ', h('code', {}, 'drift.yml'), ', are left unwatched.'],
          'Every other workflow that goes red on the default branch wakes the Taskmaster, puts a quiet item in Mandate and rings if no fix minion starts within an hour. One workflow file per line. A minion that dispatched a run on its own branch still hears its result.')] }),
      setting({ id: 'ci-watch', key: 'ci_watch', placeholder: 'desktop.yml', title: 'Watched CI workflows', ic: 'eye', hue: 'running', unit: 'workflow',
        help: [settingsHelp(['Watched even when it is in the quiet list above, like ', h('code', {}, 'desktop.yml'), '.'],
          'When a workflow listed here goes red on the default branch (a land\'s push included), the Taskmaster is woken once for that red streak, with the failing jobs, and told when it\'s back to green. One workflow file per line.')] })));
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
function recentChanges(url, restore) {
  const history = h('div', { class: 'instructions-history' });
  const load = async () => {
    try {
      const { history: saves } = await api(url);
      history.replaceChildren(...(saves.length ? [h('h3', { class: 'settings-label' }, 'Recent changes')] : []),
        ...saves.map((s) => h('details', {},
          h('summary', {}, `${s.by}, ${ago(s.at)} `,
            h('span', { class: 'muted small' }, `+${s.diff.filter((d) => d.op === '+').length} −${s.diff.filter((d) => d.op === '-').length} lines`)),
          h('pre', { class: 'instructions-diff' }, ...s.diff.map((d) => h('div', { class: d.op === '+' ? 'add' : d.op === '-' ? 'del' : 'gap' }, d.op === '…' ? '…' : `${d.op} ${d.text}`))),
          // Fills the field with the text from before this save; nothing is saved until Save.
          ...(restore && s.before !== undefined ? [h('button', { type: 'button', class: 'secondary', onclick: () => restore(s.before) }, 'Put the text from before this change in the field')] : []))));
    } catch (err) {
      history.replaceChildren(h('p', { class: 'muted small' }, `Could not load recent changes: ${err.message}`));
    }
  };
  return [history, load];
}

const MAX_PERSONAL = 4000;

/**
 * Main panel: your own instructions (#688), one text for everywhere and one for this scheme. They load last in the
 * minions assigned to you, never in the Taskmaster's prompt. Each scope keeps its own draft while you switch.
 */
export function myInstructionsEditor() {
  const p = view.project;
  let saved = { everywhere: '', scheme: '' };
  const drafts = {};
  let scope = 'everywhere';
  const textarea = h('textarea', {
    id: 'my-instructions-text', class: 'instructions-text settings-anchor', spellcheck: 'false', disabled: true, 'aria-label': 'My instructions',
    placeholder: 'How you want your minions to work: tone, when to ask and when to go, previews before landing, the model and effort they start on…',
  });
  const counter = h('span', { class: 'muted counter' });
  const status = h('span', { class: 'muted', role: 'status' }, 'Loading…');
  const save = h('button', { type: 'button', disabled: true }, 'Save');
  const discard = h('button', { type: 'button', class: 'secondary', disabled: true }, 'Discard');
  // The other scope's unsaved text, in a hidden field marked as a draft so a front-end reload waits for it too.
  const hidden = h('textarea', { hidden: true, 'aria-hidden': 'true', tabindex: -1 });
  const sync = () => {
    const dirty = !textarea.disabled && textarea.value.trim() !== saved[scope].trim();
    textarea.toggleAttribute('data-draft', dirty);
    hidden.value = Object.entries(drafts).filter(([k, v]) => k !== scope && v.trim() !== saved[k].trim()).map(([, v]) => v).join('\n');
    hidden.toggleAttribute('data-draft', !!hidden.value.trim());
    const n = textarea.value.trim().length;
    counter.textContent = `${count(n)} / ${count(MAX_PERSONAL)}`;
    counter.classList.toggle('over', n > MAX_PERSONAL);
    save.disabled = !dirty || n > MAX_PERSONAL;
    discard.disabled = !dirty;
  };
  textarea.addEventListener('input', () => {
    drafts[scope] = textarea.value;
    status.textContent = '';
    sync();
  });
  const histories = { everywhere: recentChanges(`api/projects/${p.id}/my-instructions/history?scope=everywhere`), scheme: recentChanges(`api/projects/${p.id}/my-instructions/history?scope=scheme`) };
  const historySlot = h('div');
  const scopes = [['everywhere', 'Everywhere'], ['scheme', `${p.name} only`]];
  const switcher = h('div', { class: 'row my-scope', role: 'group', 'aria-label': 'Applies to' });
  const showScope = (next) => {
    scope = next;
    switcher.replaceChildren(...scopes.map(([key, label]) =>
      h('button', { type: 'button', class: `chip${key === scope ? ' on' : ''}`, 'aria-pressed': String(key === scope), onclick: () => showScope(key) }, label)));
    textarea.value = drafts[scope] ?? saved[scope];
    historySlot.replaceChildren(histories[scope][0]);
    histories[scope][1]();
    status.textContent = '';
    sync();
  };
  // Saved at once; a refusal puts the old text back as the saved one, and the field keeps what was typed as a draft.
  save.onclick = () => {
    const at = scope;
    const was = saved[at];
    const text = textarea.value;
    const show = (t, said) => {
      saved = { ...saved, [at]: t };
      if (scope === at) status.textContent = said;
      sync();
    };
    optimistic({
      key: `my-instructions-${at}`,
      apply: () => {
        delete drafts[at];
        show(text.trim(), `Saved. Your minions pick this up on their next turn. ${instructionCost(text)}`);
      },
      send: () => api(`api/projects/${p.id}/my-instructions`, { method: 'PUT', body: { scope: at, text } }),
      undo: () => {
        drafts[at] ??= text; // unless it was edited again since
        show(was, 'Not saved.');
      },
      label: 'save your instructions',
    }).then((r) => {
      histories[at][1]();
      if (saved[at] !== text.trim()) return; // a later save changed it again
      saved = { ...saved, [at]: r[at].text };
      if (scope === at && textarea.value === text) textarea.value = r[at].text; // as the server keeps it
      sync();
    }, () => {});
  };
  discard.onclick = () => {
    delete drafts[scope];
    textarea.value = saved[scope];
    status.textContent = '';
    sync();
  };
  const layer = (name, who, cls) => h('li', { class: cls }, h('strong', {}, name), h('span', { class: 'muted small' }, who));
  const section = h('section', { class: 'artifacts-main instructions-main my-instructions' },
    h('div', { class: 'ticket-head' },
      h('div', { class: 'row' }, h('h2', {}, 'Settings'), h('span', { class: 'spacer' }), tuneUpButton(),
        h('a', { class: 'close-view', href: `#/p/${p.id}`, title: 'Back to the Taskmaster', 'aria-label': 'Close' }, icon('close'))),
      settingsTabs(),
      h('div', { class: 'meta' }, 'Only you edit these. They load into the minions assigned to you, from their next turn.')),
    settingsJump(['my-instructions-text', 'Your text'], ['my-instructions-recent', 'Recent changes'], ['my-instructions-order', 'What a minion reads']),
    h('h3', { class: 'settings-label' }, 'Applies to'),
    switcher,
    textarea, hidden,
    h('div', { class: 'row instructions-actions' }, save, discard, status, h('span', { class: 'spacer' }), counter),
    h('div', { id: 'my-instructions-recent', class: 'settings-anchor' }, historySlot),
    h('div', { class: 'settings-card settings-anchor', id: 'my-instructions-order' },
      h('h3', { class: 'settings-label' }, 'What a minion of yours reads, in order'),
      h('ol', { class: 'my-layers' },
        layer('Citadel-wide', 'everyone, every scheme', 'l-app'),
        layer('Scheme instructions', `everyone in ${p.name}`, 'l-scheme'),
        layer('Yours: everywhere, then this scheme\'s', 'the minions assigned to you', 'l-mine')),
      h('p', { class: 'muted small' }, 'The Taskmaster\'s prompt stays the same for everyone: it reads yours when it starts a minion for you. When someone else writes in your minion, it follows their way for their own asks.')),
    h('div', { class: 'settings-card' },
      h('h3', { class: 'settings-label' }, 'Yours wins over 1 and 2, except'),
      h('ul', { class: 'my-limits' },
        h('li', {}, 'secrets, logins, other people\'s files and deleting data'),
        h('li', {}, 'the tripwire'),
        h('li', {}, 'how a change ships: tests, self-review and risk labels, the land script, the pipeline lane'),
        h('li', {}, 'shared names, the shared folder\'s layout and the decisions log'),
        h('li', {}, 'another person\'s pick or decision'))));
  (async () => {
    try {
      const r = await api(`api/projects/${p.id}/my-instructions`);
      saved = { everywhere: r.everywhere.text, scheme: r.scheme.text };
      textarea.disabled = false;
      // Open on this scheme's text when only it is set.
      showScope(!r.everywhere.text && r.scheme.text ? 'scheme' : 'everywhere');
    } catch (err) {
      status.textContent = `Could not load them: ${err.message}`;
    }
  })();
  showScope('everywhere');
  status.textContent = 'Loading…';
  return section;
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
    // Nothing to save or discard until the GET has filled the field (it stays disabled if that fails).
    const dirty = !textarea.disabled && textarea.value.trim() !== saved().trim();
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
  const [history, loadHistory] = recentChanges('api/app/instructions/history', (t) => { textarea.value = t; textarea.dispatchEvent(new Event('input')); textarea.focus(); });
  // Saved at once; a refusal puts the last saved text back as the saved one, and the field keeps what was typed as a draft.
  save.onclick = () => {
    const was = appInstructions;
    const mine = { ...appInstructions, text: textarea.value, by: me, at: Date.now() };
    const show = (a, said) => {
      appInstructions = a;
      status.textContent = said;
      renderAppInstructionsHead();
      sync();
    };
    optimistic({
      key: 'app-instructions',
      apply: () => show(mine, `Saved. Every scheme picks this up on its next turn. ${instructionCost(mine.text)}`),
      send: () => api('api/app/instructions', { method: 'PUT', body: { text: mine.text } }),
      undo: () => appInstructions === mine && show(was, 'Not saved.'), // unless a later save changed it again
      label: 'save the Citadel-wide instructions',
    }).then((a) => {
      loadHistory(); // even when the broadcast of this save beat the answer and replaced `mine`
      if (appInstructions !== mine) return;
      if (textarea.value === mine.text) textarea.value = a.text; // as the server keeps it
      show(a, status.textContent);
    }, () => {});
  };
  discard.onclick = () => {
    textarea.value = saved();
    status.textContent = '';
    sync();
  };
  const section = h('section', { class: 'artifacts-main instructions-main' },
    h('div', { class: 'ticket-head', id: 'app-instructions-head' }),
    settingsJump(['app-instructions-text', 'Instructions'], ['app-instructions-recent', 'Recent changes'], ['github-owner-section', 'GitHub owner']),
    settingsHelp('Rules for how people like to work in every scheme, read by each minion and Taskmaster from its next turn.',
      'They come right before its scheme instructions, and a scheme instruction overrides one of these only where it names the rule it replaces.'),
    textarea,
    h('div', { class: 'row instructions-actions' }, save, discard, status, h('span', { class: 'spacer' }), counter),
    h('div', { id: 'app-instructions-recent', class: 'settings-anchor' }, history),
    githubOwnerField());
  (async () => {
    try {
      appInstructions = await api('api/app/instructions');
      textarea.value = appInstructions.text;
      textarea.disabled = false;
      status.textContent = '';
      renderAppInstructionsHead();
      if (!matchMedia('(pointer: coarse)').matches) {
        textarea.focus({ preventScroll: true });
        textarea.setSelectionRange(0, 0);
      }
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
    input.value = saved = s.github_owner ?? '';
    input.placeholder = s.github_owner_default ?? 'caraminden';
    input.disabled = false;
  };
  let saved = null; // the owner as last saved, so a refusal can say the field no longer matches it
  save.onclick = () => {
    const was = saved;
    const mine = input.value.trim();
    optimistic({
      key: 'github-owner',
      apply: () => { saved = mine; status.textContent = 'Saved.'; },
      send: () => api('api/app/settings', { method: 'PUT', body: { github_owner: mine } }),
      undo: () => { if (saved === mine) { saved = was; status.textContent = 'Not saved.'; } }, // unless a later save changed it again
      label: `make ${mine || 'the default'} the GitHub owner`,
    });
  };
  input.addEventListener('input', () => { status.textContent = ''; });
  api('api/app/settings').then(show, (err) => { status.textContent = `Could not load it: ${err.message}`; });
  return h('div', { class: 'github-owner settings-anchor', id: 'github-owner-section' },
    h('h3', { class: 'settings-label' }, 'GitHub owner for new schemes'),
    settingsHelp('A scheme started with a new repo gets a private GitHub repo under this account or organisation.', 'Blank uses the owner of Citadel\'s own repo.'),
    h('div', { class: 'row' }, input, save, status));
}

/** Main panel: edit the project's instructions, or import them from Claude Code. */
export function instructionsEditor() {
  const p = view.project;
  const textarea = h('textarea', {
    id: 'instructions-text', class: 'instructions-text settings-anchor', spellcheck: 'false',
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
  save.onclick = () => {
    const instructions = textarea.value;
    saveProject(p, { instructions, instructions_updated_by: me, instructions_updated_at: Date.now() }, { instructions }, 'save the instructions', (saved) => {
      status.textContent = saved ? `Saved. Minions pick this up on their next turn. ${instructionCost(instructions)}` : 'Not saved.';
      renderInstructionsHead();
      sync();
    }).then(() => loadHistory(), () => {});
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

  const [history, loadHistory] = recentChanges(`api/projects/${p.id}/instructions/history`, (t) => { textarea.value = t; textarea.dispatchEvent(new Event('input')); textarea.focus(); });

  const section = h('section', { class: 'artifacts-main instructions-main' },
    h('div', { class: 'ticket-head', id: 'instructions-head' }),
    settingsJump(['instructions-text', 'Instructions'], ['instructions-import', 'Import'], ['instructions-recent', 'Recent changes']),
    h('div', { class: 'instructions-tools', id: 'instructions-import' },
      importButton,
      h('button', { type: 'button', class: 'secondary', onclick: () => fileInput.click() }, 'Import a file…'),
      fileInput,
      h('span', { class: 'muted small' }, 'Or paste: from a Claude Code project at claude.ai/code, copy Project settings › Memory › Project instructions.')),
    picker,
    textarea,
    h('div', { class: 'row instructions-actions' }, save, discard, status, h('span', { class: 'spacer' }), counter),
    h('div', { id: 'instructions-recent', class: 'settings-anchor' }, history));
  sync();
  loadHistory();
  setTimeout(() => {
    renderInstructionsHead();
    // Ready to type, but at the start of the text, and not on touch, where it would raise the keyboard.
    if (!matchMedia('(pointer: coarse)').matches) {
      textarea.focus({ preventScroll: true });
      textarea.setSelectionRange(0, 0);
      textarea.scrollTop = 0;
    }
  });
  return section;
}

// ---------- machines ----------

export function onMachinesUpdate(machines) {
  if (view?.kind !== 'project') return;
  view.machines = machines;
  renderMachineList();
}

/** A machine's status line as the server words it (#437): "Asleep · seen 3h ago". */
function machineStatusText(m) {
  if (!m.when) return m.reason;
  return `${m.reason} · ${m.when.label} ${m.when.label === 'added' ? new Date(m.when.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : ago(m.when.at)}`;
}

/** Whether this scheme's minions get a machine for the viewer: a shared one lent here, or their own (their turns get it). */
const oursHere = (m) => !m.runners && m.gets?.includes(view.projectId) && (m.owner_id === null || m.owner_id === account?.id);

/** The add form (#439): a name, and nothing about what it lends, which is ticked once its agent reports. runners: a CI runner host. */
function machineAddForm(runners, label) {
  const name = h('input', { name: 'name', placeholder: runners ? 'desktop-ci-runners' : 'godot-laptop', required: true, maxlength: 30, autocomplete: 'off', pattern: '[a-z0-9][a-z0-9\\-]*' });
  const alwaysOn = runners ? null : h('input', { type: 'checkbox', name: 'always_on', checked: true });
  // Everyone else's machine is their own (#306); an admin's is shared unless they tick this.
  const mine = !runners && account?.admin ? h('input', { type: 'checkbox', name: 'mine' }) : null;
  const status = h('span', { class: 'muted', role: 'status' });
  const form = h('form', { class: `machine-add${runners ? ' runners' : ''}` },
    h('label', {}, 'Name', name),
    alwaysOn ? h('label', { class: 'check', title: 'On: offline over 5 minutes shows as Down. Off: a laptop that comes and goes shows as Asleep.' }, alwaysOn, h('span', {}, 'Always on (untick for a laptop)')) : '',
    mine ? h('label', { class: 'check', title: 'Off: a shared machine, lent to schemes under Who gets it. On: only turns you ask for get it, in schemes you are in, and your contraptions\' turns.' }, mine, h('span', {}, 'Mine: only my turns use it')) : '',
    h('button', { type: 'submit' }, label),
    status,
    // The steps sit in the form they are about (#492), not in a paragraph under the list.
    runners ? '' : h('ol', { class: 'settings-steps' },
      h('li', {}, h('strong', {}, 'Name it'), ' and press Add machine.'),
      h('li', {}, h('strong', {}, 'Paste the line it shows'), ' on that computer. It needs Node 18 or newer.'),
      h('li', {}, h('strong', {}, 'Open its line and tick what to lend.'), ' It reports the MCP servers set up for Claude Code there, and the servers and folders its owner lists in ', h('code', {}, 'machine-agent.json'), '.')));
  const toggle = h('button', { type: 'button', class: runners ? 'secondary small' : 'machine-add-toggle', 'aria-expanded': 'false' }, runners ? 'Add a CI runner host' : 'Add a machine');
  const show = (on) => {
    form.hidden = !on;
    toggle.setAttribute('aria-expanded', String(on));
    if (on) name.focus();
  };
  toggle.onclick = () => show(form.hidden);
  form.hidden = true;
  form.onsubmit = async (e) => {
    e.preventDefault();
    status.textContent = 'Adding…';
    try {
      const { machine, token, agent_url } = await api('api/machines', { method: 'POST', body: { name: name.value.trim().toLowerCase(), ...(alwaysOn && !alwaysOn.checked ? { always_on: false } : {}), ...(mine?.checked ? { mine: true } : {}), ...(runners ? { runners: true } : {}) } });
      view.machineToken = setupFor(machine, token, agent_url);
      name.value = '';
      status.textContent = '';
      show(false);
      renderMachineSetup();
      document.getElementById('machine-setup')?.scrollIntoView({ block: 'nearest' });
    } catch (err) {
      status.textContent = err.message;
    }
  };
  return { form, toggle, show };
}

/** Settings' Machines tab: add machines, show the line that connects one, tick what each lends, and remove them or replace their token. */
export function machinesPage() {
  view.machineToken = null; // { id, name, token } just made, shown until you leave the page
  const add = machineAddForm(false, 'Add machine');
  // A CI runner host is a different program with a different job, so it has its own add and install line (#439).
  const runners = account?.admin ? machineAddForm(true, 'Add CI runner host') : null;
  const section = h('section', { class: 'artifacts-main machines-main' },
    h('div', { class: 'ticket-head' },
      h('div', { class: 'row' }, h('h2', {}, 'Settings'), h('span', { class: 'spacer' }),
        h('a', { class: 'close-view', href: `#/p/${view.projectId}`, title: 'Back to the Taskmaster', 'aria-label': 'Close' }, icon('close'))),
      settingsTabs(),
      h('div', { class: 'meta' }, account?.admin
        ? settingsHelp('Computers that lend their MCP tools to minions while they are connected, in the schemes listed under Who gets it.', 'They dial out to this app (over the tailnet, where one is set up), so it never has to reach them. Citadel checks each one as it connects and hourly.')
        : settingsHelp('Your computers, lending their MCP tools to the minion turns you ask for, in the schemes you list under Who gets it.', 'They dial out to this app (over the tailnet, where one is set up), so it never has to reach them. Only you and the admins can change them.'))),
    h('div', { class: 'row machines-bar' }, h('h3', {}, 'Machines'), h('span', { class: 'spacer' }), add.toggle),
    add.form,
    h('div', { id: 'machine-setup' }),
    h('div', { id: 'machine-list', class: 'machine-list' }),
    // The CI desktop's load moved to the CI page (#968, Cara: "move the CI box performance page from machines into here").
    h('p', { class: 'muted small' }, 'CI runners, their queue and the CI desktop\'s load are on ', h('a', { href: `#/p/${view.projectId}/ci` }, 'the CI page'), '.'),
    runners ? h('div', { class: 'row machines-bar runners-bar' }, h('span', { class: 'muted small' }, 'A CI runner host adds and removes schemes\' CI runners on its PC (tools/ci-runner/README.md).'), h('span', { class: 'spacer' }), runners.toggle) : '',
    runners ? runners.form : '',
    h('p', { class: 'muted small' }, 'Nothing typed here runs a command on a machine.'),
    h('details', { class: 'small machine-facts' },
      h('summary', {}, 'What a lent machine can and cannot do'),
      h('ul', { class: 'muted' },
        h('li', {}, h('strong', {}, 'One MCP server per machine.'), ' Add another machine for a second one.'),
        h('li', {}, h('strong', {}, 'How minions see it.'), ' Its tools as ', h('code', {}, 'mcp__<name>__…'), ', its ticked folders as ', h('code', {}, 'mcp__<name>-ws__…'), ': git sync and the tasks its owner lists, nothing else.'),
        h('li', {}, h('strong', {}, 'Commands live on that computer.'), ' Commands and tasks are only in ', h('code', {}, 'machine-agent.json'), ' there, beside the agent.'),
        h('li', {}, h('strong', {}, 'A person\'s own machine'), ' goes only to turns they ask for: their minions\' turns in schemes they are in, and their contraptions\' turns.'),
        h('li', {}, h('strong', {}, 'When a minion gets it.'), ' At the start of its turn: the tools of every machine online and lent to its scheme, plus the machine\'s notes.'))));
  setTimeout(() => {
    renderMachineSetup();
    renderMachineList();
    if (!view.machines?.length) add.show(true);
  });
  return section;
}

/** A machine just added or given a new token: what its install line needs. */
function setupFor(machine, token, url) {
  return { id: machine.id, name: machine.name, token, url: url ?? location.origin, runners: machine.runners };
}

function renderMachineSetup() {
  const el = document.getElementById('machine-setup');
  if (!el) return;
  const t = view.machineToken;
  if (!t) return el.replaceChildren();
  const ways = t.runners ? [
    { os: 'runner', tab: 'Windows', label: 'Administrator PowerShell on the Windows PC that hosts the CI runners (tools/ci-runner/README.md): installs the runner agent as a background task.',
      text: machineSetupRunnerAgent(t.url, t.token),
      note: 'It checks Node 18+ and Git for Windows, registers the task Citadel runner agent (SYSTEM, at startup), starts it and waits until this machine shows online. No reboot, and no runner is touched.' },
    { os: 'runner-linux', tab: 'Linux in WSL', label: 'Root shell in the CI runners\' WSL distro on that PC (wsl -d citadel-ci -u root; tools/ci-runner/README.md, "Linux runners in WSL"): installs the Linux runner agent as a systemd service.',
      text: machineSetupRunnerAgentLinux(t.url, t.token),
      note: 'The first time, it sets up /etc/wsl.conf and asks you to restart the distro and paste this again. Then it installs Node, git and the runner\'s libraries, starts the agent and waits until this machine shows online. Use a host of its own for this, not the Windows agent\'s.' },
  ] : [
    { os: 'windows', tab: 'Windows', label: 'Windows PowerShell: runs in the background, also after you close the window, and starts at every logon. No reboot.',
      text: machineSetupWindows(t.url, t.name, t.token), log: agentLog('windows', t.name) },
    { os: 'posix', tab: 'macOS or Linux', label: 'Terminal on macOS or Linux: runs in the background, also after you close the window, and starts at every login. No sudo.',
      text: machineSetupPosix(t.url, t.name, t.token), log: agentLog('posix', t.name) },
    { os: 'jobs', tab: 'GPU jobs (WSL)', label: 'Shell in the citadel-jobs WSL distro on that PC, as you, not root (wsl -d citadel-jobs; tools/jobs-runner/README.md sets the distro up first): runs GPU jobs from contraptions in podman.',
      text: machineSetupPosix(t.url, t.name, t.token),
      note: 'Then add a "jobs" block to ~/coordinator-agent/machine-agent.json in the distro (the README, step 6): the folders jobs may read, the time limit and the disk cap. Without it every job is refused.' },
  ];
  // Picked from this browser; the chips are for adding a computer from another one.
  view.machineSetupOs ??= guessOs();
  const os = t.runners ? view.runnerSetupOs ?? 'runner' : view.machineSetupOs;
  const copy = h('button', { type: 'button', class: 'secondary small' }, 'Copy');
  copy.onclick = async () => {
    copy.textContent = await copyText(ways.find((w) => w.os === os).text) ? 'Copied' : 'Couldn\'t copy';
  };
  const pick = (to) => {
    if (t.runners) view.runnerSetupOs = to;
    else view.machineSetupOs = to;
    renderMachineSetup();
  };
  el.replaceChildren(h('div', { class: 'machine-setup' },
    h('strong', {}, `Connect ${t.name}`),
    h('p', { class: 'small' }, "Don't screenshot this or paste it in a chat: the line holds the token, and anyone who has it can act as this machine."),
    h('p', { class: 'small' }, 'The token is shown only now; if you lose it, make a new one. Paste this on that computer:'),
    h('div', { class: 'row machine-setup-ways' },
      h('div', { class: 'row', role: 'group', 'aria-label': 'Which computer' },
        ways.map((w) => h('button', { type: 'button', class: `chip${w.os === os ? ' on' : ''}`, 'aria-pressed': String(w.os === os), onclick: () => pick(w.os) }, w.tab))),
      h('span', { class: 'spacer' }), copy),
    ways.map((w) => h('div', { class: 'machine-setup-way', 'data-os': w.os, hidden: w.os !== os },
      h('p', { class: 'small' }, w.label),
      h('pre', {}, w.text),
      w.note ? h('p', { class: 'small muted' }, w.note)
        : h('p', { class: 'small muted' }, 'It writes what it prints to ', h('code', {}, w.log), ', and ends by printing how to watch that log, stop it and remove it.'))),
    t.runners ? '' : h('p', { class: 'small' }, `Once it connects, ${t.name}'s line below shows the MCP servers and folders it found there: open it and tick what to lend.`)));
}

/** The setup to show first: the viewer's own kind of computer, as the browser says it (a phone gets Windows). */
function guessOs() {
  const platform = navigator.userAgentData?.platform || navigator.platform || '';
  return /mac|linux|x11|cros/i.test(platform) && !/android/i.test(`${platform} ${navigator.userAgent}`) ? 'posix' : 'windows';
}

function renderMachineList() {
  const el = document.getElementById('machine-list');
  if (!el) return;
  view.machineOpen ??= new Set();
  const scheme = view.project?.name ?? 'This scheme';
  const runners = view.machines.filter((m) => m.runners);
  const ours = view.machines.filter(oursHere);
  const others = view.machines.filter((m) => !m.runners && !ours.includes(m));
  const group = (title, list) => (list.length ? [h('h3', { class: 'settings-section' }, title), h('div', { class: 'settings-rows' }, ...list.map(machineLine))] : []);
  el.replaceChildren(
    ...group(`${scheme}'s minions get`, ours),
    ...group(ours.length ? 'Other machines' : 'Machines', others),
    ...group('CI runners', runners),
    view.machines.length ? '' : h('p', { class: 'muted small' }, 'No machines yet.'));
}

/** Make a new token for a machine and show its install line. */
async function newMachineToken(m) {
  // One set up before #439 runs what its own command line says; the new line makes it report what it finds instead.
  const old = !m.runners && m.managed !== true && !m.lend;
  if (!confirm(`Make a new token for ${m.name}? Its current connection stops and it has to be installed again with the new line.${old
    ? '\n\nAfter that, what it lends is ticked here, from the MCP servers in that computer\'s Claude Code config and its machine-agent.json. If it runs a server from a command of its own, put that under "servers" in machine-agent.json there first.' : ''}`)) return;
  const { machine, token, agent_url } = await api(`api/machines/${m.id}/token`, { method: 'POST' }).catch((err) => alert(err.message) ?? {});
  if (!token) return;
  view.machineToken = setupFor(machine, token, agent_url);
  renderMachineSetup();
  document.getElementById('machine-setup')?.scrollIntoView({ block: 'nearest' });
}

function removeMachine(m) {
  if (!confirm(`Remove ${m.name}? Minions lose its tools and its token stops working.`)) return;
  const at = view.machines.findIndex((x) => x.id === m.id);
  optimistic({
    key: `machine:${m.id}`,
    apply: () => {
      if (view.machineToken?.id === m.id) view.machineToken = null;
      onMachinesUpdate(view.machines.filter((x) => x.id !== m.id));
      renderMachineSetup();
    },
    send: () => api(`api/machines/${m.id}`, { method: 'DELETE' }),
    undo: () => view.machines.some((x) => x.id === m.id) || onMachinesUpdate(view.machines.toSpliced(at, 0, m)),
    label: `remove ${m.name}`,
  });
}

/** Check now (#437): its result can't be guessed, so only its own button shows it is busy. */
function checkMachine(m, button) {
  button.disabled = true;
  button.textContent = 'Checking…';
  api(`api/machines/${m.id}/check`, { method: 'POST' })
    .catch((err) => toast(`Couldn't check ${m.name}: ${err.message}`, { tone: 'error' }))
    // The broadcast has redrawn the row by now; this is for one that didn't.
    .finally(() => { if (button.isConnected) { button.disabled = false; button.textContent = 'Check now'; } });
}

const schemeName = (id) => (view.projects ?? []).find((p) => p.id === id)?.name ?? `scheme ${id}`;

/** The button on a machine's line that fixes what its status says, if one does (#437). */
function fixButton(m, open) {
  const b = (label, onclick, title) => h('button', { type: 'button', class: 'secondary small', title, onclick: (e) => onclick(e.currentTarget) }, label);
  switch (m.fix) {
    case 'check': return m.checking ? h('button', { type: 'button', class: 'secondary small', disabled: true }, 'Checking…') : b('Check now', (btn) => checkMachine(m, btn), 'Start its tools again and list them');
    case 'tick': return b(m.reason.startsWith('Found nothing') ? 'How to add' : 'Tick what it lends', open, 'Open its line: what it found on that computer, and how to add more there');
    case 'workspace_tools': return b('Turn on', () => patchMachine(m, { workspace_tools: true }, `switch workspace tools on for ${m.name}`, renderMachineList), 'Switch its workspace tools on, so minions get its folders');
    case 'lend': return b('Lend it', open, 'Pick the schemes whose minions get it');
    case 'token': return b('New token', () => newMachineToken(m), 'Install it again with the new line: it then reports what it finds there');
    case 'remove': return b('Remove', () => removeMachine(m));
    case 'always_on': return b('Not always on', () => patchMachine(m, { always_on: false }, `mark ${m.name} as not always on`, renderMachineList), 'A laptop that comes and goes: offline shows as Asleep, not Down');
    default: return '';
  }
}

/** What a machine's last check found: "MCP server (godot-ai), 47 tools · workspace tools, 8 tools". */
function machineChecked(m) {
  const results = m.checked?.results ?? [];
  const server = m.lend?.server ?? m.mcp_command;
  if (!results.length) return m.online ? 'Nothing it lends has been checked yet' : 'Shows once it connects and is checked';
  return results.map((r) => `${r.server === 'ws' ? 'workspace tools' : `MCP server${server ? ` (${server})` : ''}`}${r.ok ? `, ${r.tools.length} tool${r.tools.length === 1 ? '' : 's'}` : ': didn\'t start'}`).join(' · ');
}

// What machine-agent.json takes, for the Machines page; the owner writes it beside the agent on that computer.
const CONFIG_EXAMPLE = `{
  "servers": { "godot": { "run": ["uvx", "godot-ai", "attach"] } },
  "workspaces": { "delve": { "path": "C:\\\\Users\\\\you\\\\Projects\\\\delve" } }
}`;
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
    "vault": {
      "path": "%USERPROFILE%\\\\Documents\\\\Vault",
      "git_sync": false,
      "tasks": { "pull": { "run": ["git", "pull", "--ff-only"], "about": "Bring the minion's push into the vault now" } }
    }
  }
}`;

/** How a new server or folder gets onto a machine: in the file on that computer, never from here. */
function machineConfigHelp(open) {
  return h('details', { class: 'small machine-config-help', open },
    h('summary', {}, 'Add a server or a folder: in machine-agent.json on that computer'),
    h('p', { class: 'muted' }, 'The file sits beside the agent, in the coordinator-agent folder of that computer\'s home folder. The agent picks up changes by itself, and what it finds shows here to tick. A server is a program and its arguments (no shell); a folder is a path:'),
    h('pre', {}, CONFIG_EXAMPLE),
    h('details', {}, h('summary', {}, 'Folders with tasks, read folders and a vault that pulls'),
      h('p', { class: 'muted' }, 'In a ticked folder minions can check out pushed branches and run only the tasks listed, with no shell. "git_sync": false keeps them from checking anything out in a folder you keep on a branch yourself (an Obsidian vault with Obsidian Git, say); give that one a pull task instead.'),
      h('pre', {}, WORKSPACE_EXAMPLE)));
}

/** A folder as its agent reports it: its path, what else is readable and its tasks. */
function workspaceDetail(w) {
  return h('div', { class: 'machine-workspace small' },
    h('div', {}, h('code', {}, w.path), w.git_sync === false ? h('span', { class: 'muted' }, ' · git_sync off') : ''),
    w.read.length ? h('div', { class: 'muted' }, 'Also readable: ', w.read.join(', ')) : '',
    w.tasks.length ? h('ul', {}, w.tasks.map((t) => h('li', {}, h('code', {}, t.name), ': ', t.run.join(' '), t.args ? ' …' : '', t.about ? h('span', { class: 'muted' }, ` (${t.about})`) : ''))) : '');
}

/**
 * What a machine lends (#439). One whose agent reports what it found gets a tick per MCP server (one at a time)
 * and per folder; a tick saves at once and reaches the agent, with no new token. One set up before that lends
 * what its own command line says, shown as it is.
 */
function machineLends(m) {
  const problems = (m.problems ?? []).map((p) => h('p', { class: 'error small' }, p));
  const checked = h('p', { class: 'muted small' }, `Last check: ${machineChecked(m)}`);
  const workspaces = m.workspaces ?? [];
  if (m.managed === false) {
    // An agent from before #439: its MCP server is fixed on that computer, and its folders go together behind one switch.
    const all = h('input', { type: 'checkbox', checked: m.workspace_tools });
    all.onchange = () => patchMachine(m, { workspace_tools: all.checked }, `switch workspace tools ${all.checked ? 'on' : 'off'} for ${m.name}`, renderMachineList);
    return h('div', { class: 'machine-lends' },
      m.servers.includes('mcp') ? h('div', { class: 'small' }, 'MCP server: ', h('code', {}, m.command || '?'), h('span', { class: 'muted' }, ' · set on that computer')) : '',
      m.servers.includes('ws') ? h('label', { class: 'row small', title: 'Lets minions check out pushed branches and run the listed tasks in every folder below' }, all, h('span', {}, 'All its folders')) : '',
      ...workspaces.map((w) => h('div', { class: 'machine-found' }, h('strong', { class: 'small' }, w.name), workspaceDetail(w))),
      m.servers.length ? '' : h('p', { class: 'muted small' }, 'Nothing: it runs no MCP server and lists no folder.'),
      h('p', { class: 'muted small' }, 'Set up before ticks: it lends what its own command line says. ',
        h('button', { type: 'button', class: 'link', onclick: () => newMachineToken(m) }, 'Reinstall to manage from here'), '.'),
      ...problems, checked);
  }
  const lend = m.lend ?? { server: null, workspaces: [] };
  const save = (next) => patchMachine(m, { lend: next }, `change what ${m.name} lends`, renderMachineList);
  const tick = (on, change, ...label) => {
    const box = h('input', { type: 'checkbox', checked: on });
    box.onchange = () => change(box.checked);
    return h('label', { class: 'row small' }, box, h('span', {}, ...label));
  };
  const online = m.managed === true;
  const found = m.found ?? [];
  // Ticked but not there now (removed from that computer, or it is offline): still shown, so it can be unticked.
  const servers = [...found, ...(lend.server && !found.some((f) => f.name === lend.server) ? [{ name: lend.server, gone: true }] : [])];
  const folders = [...workspaces, ...lend.workspaces.filter((n) => !workspaces.some((w) => w.name === n)).map((name) => ({ name, gone: true }))];
  const gone = online ? 'not found there now' : 'ticked';
  return h('div', { class: 'machine-lends' },
    servers.length ? h('div', { class: 'machine-found' }, h('div', { class: 'muted small' }, 'MCP server (one at a time)'),
      ...servers.map((f) => tick(lend.server === f.name, (on) => save({ ...lend, server: on ? f.name : null }),
        h('code', {}, f.name), h('span', { class: 'muted' }, f.gone ? ` · ${gone}` : f.from === 'file' ? ' · from machine-agent.json' : ' · from Claude Code\'s config')))) : '',
    folders.length ? h('div', { class: 'machine-found' }, h('div', { class: 'muted small' }, 'Folders'),
      ...folders.map((w) => h('div', {},
        tick(lend.workspaces.includes(w.name), (on) => save({ ...lend, workspaces: on ? [...lend.workspaces, w.name] : lend.workspaces.filter((n) => n !== w.name) }),
          h('strong', {}, w.name), w.gone ? h('span', { class: 'muted' }, ` · ${gone}`) : ''),
        w.gone ? '' : workspaceDetail(w)))) : '',
    online
      ? (servers.length || folders.length ? '' : h('p', { class: 'muted small' }, 'It found no MCP server in Claude Code\'s config there and no machine-agent.json entries.'))
      : h('p', { class: 'muted small' }, m.last_seen_at ? 'Offline: what it finds there shows once it connects.' : 'Once it connects, what it finds on that computer shows here to tick.'),
    servers.length || folders.length ? h('p', { class: 'cui-notice small' }, 'Minions run these tools on this computer, so only tick what you trust them with.') : '',
    online ? machineConfigHelp(!servers.length && !folders.length) : '',
    ...problems, m.checked?.results.length ? checked : '');
}

/** One line of the quiet list (#437, take A): name, reason, status chip (#492), fix button; click it for the rest. */
function machineLine(m) {
  const open = () => {
    view.machineOpen.add(m.id);
    renderMachineList();
  };
  const word = { ready: 'Ready', fix: 'Needs a fix', down: 'Down', asleep: 'Asleep', checking: 'Checking' }[m.status];
  const isOpen = view.machineOpen.has(m.id);
  const fix = fixButton(m, open);
  const [row, sum] = settingsRow({ icon: m.runners ? 'plug' : 'monitor', hue: { ready: 'done', fix: 'waiting', down: 'danger' }[m.status] ?? 'muted', title: m.name, summary: `${word} · ${machineStatusText(m)}`, open: isOpen },
    machineBody(m));
  // The fix stays on the closed line (#437, take A); a button inside a summary doesn't toggle the row.
  if (fix) sum.after(h('span', { class: 'machine-fix' }, fix));
  row.classList.add('machine-row', 'machine-line', m.status);
  row.addEventListener('toggle', () => {
    if (row.open === view.machineOpen.has(m.id)) return;
    view.machineOpen[row.open ? 'add' : 'delete'](m.id);
  });
  return row;
}

/** A machine's line opened: what it lends, who gets it, its computer, notes and its buttons. */
function machineBody(m) {
  const check = h('button', { type: 'button', class: 'secondary small', disabled: !m.online || m.checking, title: m.online ? 'Start its tools and list them, as a minion\'s turn would' : 'It is offline' }, m.checking ? 'Checking…' : 'Check now');
  check.onclick = () => checkMachine(m, check);
  const newToken = h('button', { type: 'button', class: 'secondary small', title: 'Make a new token; the old one stops working and the machine disconnects', onclick: () => newMachineToken(m) }, 'New token');
  const remove = h('button', { type: 'button', class: 'secondary small', onclick: () => removeMachine(m) }, 'Remove');
  const alwaysOn = h('input', { type: 'checkbox', checked: m.always_on });
  alwaysOn.onchange = () => patchMachine(m, { always_on: alwaysOn.checked }, `mark ${m.name} as ${alwaysOn.checked ? '' : 'not '}always on`, renderMachineList);
  const kv = (label, ...value) => [h('span', { class: 'muted' }, label), h('div', {}, ...value)];
  return h('div', { class: 'machine-body' },
    h('div', { class: 'machine-kv' },
      m.runners ? kv('Does', 'Adds, lists and removes CI runners for schemes, when Citadel asks') : kv('Lends', machineLends(m)),
      m.runners ? (m.owner_id === null ? kv('Runs CI for', m.scoped ? machineLending(m) : 'Every scheme an admin owns') : []) : kv('Who gets it',
        m.owner_id === null ? '' : h('div', { class: 'small muted' }, `Only turns ${m.created_by} asks for (and their contraptions), in:`),
        machineLending(m)),
      kv('Computer',
        h('span', {}, [m.host, m.online ? (m.command && !m.runners ? `runs ${m.command}` : '') : m.last_seen_at ? `last seen ${ago(m.last_seen_at)}` : 'never connected', m.sessions ? `${m.sessions} in use` : ''].filter(Boolean).join(' · ') || '—'),
        h('label', { class: 'row small always-on', title: 'On: offline over 5 minutes shows as Down. Off: a laptop that comes and goes shows as Asleep.' }, alwaysOn, h('span', {}, 'Always on'))),
      kv('Notes', machineNotes(m))),
    m.jobs ? machineJobsSection(m) : '',
    h('div', { class: 'row machine-buttons' }, m.runners ? '' : check, newToken, remove));
}

/** A machine's notes for minions: a collapsed editor that keeps an open draft through re-renders. */
function machineNotes(m) {
  const notes = h('textarea', { rows: 4, maxlength: 2000, placeholder: 'What minions should know: never restart it, where the repo is cloned, what to check first…' });
  notes.value = m.notes ?? '';
  const saved = h('span', { class: 'muted small', role: 'status' });
  const summary = h('summary', {});
  const summarize = (text) => { summary.textContent = text ? text.split('\n')[0] : 'Add notes for minions'; };
  summarize(m.notes);
  const save = h('button', { type: 'button', class: 'small' }, 'Save notes');
  // The field keeps what was typed either way; a refusal only says it isn't saved.
  save.onclick = () => patchMachine(m, { notes: notes.value }, `save the notes on ${m.name}`, (ok, x) => {
    summarize(x.notes);
    saved.textContent = ok ? 'Saved; minions get them from their next turn.' : 'Not saved.';
  });
  notes.addEventListener('input', () => { saved.textContent = ''; });
  // Keep an open notes editor open (and its draft) when the list re-renders for a status change.
  const old = document.querySelector(`.machine-notes[data-id="${m.id}"]`);
  const editing = old?.open;
  if (editing) notes.value = old.querySelector('textarea').value;
  return h('details', { class: 'machine-notes', 'data-id': m.id, open: editing },
    summary, notes, h('div', { class: 'row' }, save, saved));
}

/**
 * Change a machine's fields at once and PATCH them behind; shown(ok, machine) redraws what shows them. A refusal
 * puts the old values back, unless a later change replaced them; the server's broadcast then has the last word.
 */
function patchMachine(m, fields, label, shown) {
  const now = () => view.machines?.find((x) => x.id === m.id) ?? m;
  const was = Object.fromEntries(Object.keys(fields).map((k) => [k, now()[k]]));
  const set = (vals, ok) => shown(ok, Object.assign(now(), vals));
  optimistic({
    key: `machine:${m.id}`,
    apply: () => set(fields, true),
    send: () => api(`api/machines/${m.id}`, { method: 'PATCH', body: fields }),
    undo: () => Object.entries(fields).every(([k, v]) => now()[k] === v) && set(was, false), // unless a later change replaced them
    label,
  });
}

/** Which schemes' minions get a machine (#438): its one list, as chips with a remove button each, and "+ scheme". */
function machineLending(m) {
  const now = () => (view.machines?.find((x) => x.id === m.id) ?? m).projects ?? [];
  const save = (projects) => patchMachine(m, { projects }, `change which schemes get ${m.name}`, renderMachineList);
  const chips = now().map((id) => h('span', { class: 'chip scheme-chip' }, h('span', {}, schemeName(id)),
    h('button', { type: 'button', title: `Take ${m.name} from ${schemeName(id)}: its minions lose it now, mid-turn too`, 'aria-label': `Remove ${schemeName(id)}`, onclick: () => save(now().filter((x) => x !== id)) }, '×')));
  const rest = (view.projects ?? []).filter((p) => !now().includes(p.id));
  const add = h('select', { class: 'add-scheme', 'aria-label': `Lend ${m.name} to a scheme`, hidden: !rest.length },
    h('option', { value: '' }, '+ scheme'), rest.map((p) => h('option', { value: p.id }, p.name)));
  add.onchange = () => add.value && save([...now(), Number(add.value)]);
  return h('div', { class: 'machine-lending', 'data-id': m.id }, chips,
    chips.length ? '' : h('span', { class: 'muted small' }, 'No scheme gets it yet.'), add);
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
