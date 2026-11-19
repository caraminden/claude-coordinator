// A scheme's settings: notifications, the Settings page's instructions and approvals tabs (the Machines page is settings-machines.js).
import { account, ago, api, h, icon, me, schemeIcon, view } from './base.js';
import { openHash } from './core.js';
import { firefoxAvailable, firefoxOn, setFirefoxOn } from './extlinks.js';
import { renderSidebar } from './sidebar.js';
import { optimistic } from './ui/optimistic.js';
import { toast } from './ui/status.js';
import { instructionCost } from './prompt-cost.js';
import { elsewhereRows, pickers } from './minion-rules.js';

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

/**
 * Settings → Notifications (#1004; these sat in the rail's account box): "Notify me on this device", and once on,
 * pinned-only (this device) and, for the open scheme, a mute and "Everything" (this device). Same calls as before.
 */
export function notificationsPage() {
  const project = view.project;
  const on = h('input', { type: 'checkbox' });
  const mute = h('input', { type: 'checkbox' });
  const pinned = h('input', { type: 'checkbox' });
  const all = h('input', { type: 'checkbox' });
  const hint = h('span', { class: 'hint', hidden: true });
  const toggle = (box, text, title) => h('label', { class: 'toggle', title }, box, text);
  const row = (ic, hue, title, summary, ...body) => settingsRow({ icon: ic, hue, title, summary, open: true }, ...body)[0];
  const onRow = row('bell', 'accent', 'Notify me on this device', 'This device only',
    toggle(on, 'Notify me on this device', 'Questions for you, failed turns, and your minions that are ready or blocked'), hint,
    settingsHelp('Questions for you, failed turns, and your minions that are ready or blocked, as a notification on this browser or app. Other devices are set up on their own.'));
  const pinnedRow = row('pin', 'held', 'Only my pinned minions', 'This device only',
    toggle(pinned, 'Only my pinned minions', 'On this device, notify only about minions you pinned (other people\'s too) and the Taskmaster'),
    settingsHelp('On this device, notify only about minions you pinned (other people\'s too) and the Taskmaster.'));
  // #690: a minion's pings go to its owner; this device can still hear every minion in the scheme.
  const allRow = row('users', 'running', `Everything in ${project.name}`, `This device · scheme ${project.name}`,
    toggle(all, `Everything in ${project.name}`, 'On this device, hear about every minion in this scheme, not only yours, the ones you pinned and the unassigned ones'),
    settingsHelp(`On this device, hear about every minion in ${project.name}, not only yours, the ones you pinned and the unassigned ones.`));
  const muteRow = row('belloff', 'danger', `Mute ${project.name}`, `This device · scheme ${project.name}`,
    toggle(mute, `Mute ${project.name} here`, 'Stop notifications from this scheme on this device'),
    settingsHelp(`Stop notifications from ${project.name} on this device. Other schemes keep notifying.`));
  // The scheme's heading goes with its rows, so a device that isn't subscribed shows no empty heading.
  const schemeBlock = h('div', { class: 'settings-block' }, ...settingsSection(`${project.name} on this device`, allRow, muteRow));
  const show = (state, err) => {
    pushState = state;
    on.checked = state.subscribed;
    mute.checked = state.muted.includes(project.id);
    pinned.checked = !!state.onlyPinned;
    all.checked = !!state.everything?.includes(project.id);
    pinnedRow.hidden = schemeBlock.hidden = !state.subscribed;
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
  if (pushSupported) refresh();
  return h('section', { class: 'artifacts-main people-main' },
    h('div', { class: 'ticket-head' },
      h('div', { class: 'row' }, ...settingsTitle(), h('span', { class: 'spacer' }),
        h('a', { class: 'close-view', href: `#/p/${view.projectId}`, title: 'Back to the Taskmaster', 'aria-label': 'Close' }, icon('close'))),
      settingsTabs(),
      h('div', { class: 'meta' }, 'Notifications are set per browser or app, so each device has its own. Scheme settings say which scheme they are for.')),
    pushSupported
      ? [...settingsSection('This device', onRow, pinnedRow), schemeBlock]
      : h('p', { class: 'muted' }, 'This browser can\'t show notifications. Install Citadel as an app, or use a browser that supports them.'));
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
  for (const el of document.querySelectorAll('[data-rules-row]')) el.dispatchEvent(new Event('settings-refresh'));
  document.getElementById('land-mode')?.dispatchEvent(new Event('settings-refresh'));
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


/** The Settings page's tabs; each is its own route, so old links to them still work. */
// The side menu (#995, Cara picked "Side menu, rows that open"): three groups, each its own hue, every page with an
// icon and a one-line summary for the phone's list (#1018). On a phone the menu hides: Settings opens on that list
// (settingsHome), and each page's bar has a back link to it and the page's own name (Cara picked "A list of pages,
// each opens full screen").
const SETTINGS_GROUPS = [
  ['Scheme', 'running', [['instructions', 'Instructions', 'doc', 'What every minion reads'], ['approvals', 'Minion rules', 'shield', 'Approvals, plugins, list groups and CI'],
    ['properties', 'Properties', 'tag', 'Type, stage and your own keys'], ['members', 'Members', 'users', 'Who works in this scheme']]],
  ['You', 'held', [['my-instructions', 'My instructions', 'pen', 'Yours, in every scheme'], ['account', 'Your account', 'user', 'Password, Claude and GitHub logins'],
    ['machines', 'Machines', 'monitor', 'Computers you lend to minions'], ['notifications', 'Notifications', 'bell', 'Push, and what pings you'], ['usage', 'Usage', 'chart', 'Claude and Codex spend']]],
  ['Admin', 'teal', [['app-instructions', 'Citadel-wide', 'globe', 'Rules every scheme follows'], ['people', 'People', 'people', 'Who can sign in'], ['contraptions', 'Contraptions', 'box', 'Apps that run inside Citadel']], true],
];
const settingsGroups = () => SETTINGS_GROUPS.filter(([, , , admin]) => !admin || account?.admin);
const propsCount = (kind) => (kind === 'properties' ? h('span', { class: 'count props-count', hidden: true }) : '');

export function settingsTabs() {
  const nav = h('nav', { class: 'settings-tabs', 'aria-label': 'Settings' },
    settingsGroups().map(([label, hue, items]) =>
      h('div', { class: 'settings-group', 'data-hue': hue }, h('span', { class: 'settings-group-label' }, label),
        items.map(([kind, text, ic]) =>
          h('a', { class: view.main === kind ? 'active' : '', href: `#/p/${view.projectId}/${kind}`, 'aria-current': view.main === kind ? 'page' : null },
            icon(ic), h('span', { class: 'label' }, text), propsCount(kind))))));
  return nav;
}

/** A settings page's title: "Settings" beside the desktop menu; on a phone a back link to the list and the page's name. */
export function settingsTitle() {
  const page = SETTINGS_GROUPS.flatMap(([, , items]) => items).find(([kind]) => kind === view.main);
  return [h('a', { class: 'settings-back', href: `#/p/${view.projectId}/settings`, title: 'All settings' }, icon('back'), 'Settings'),
    h('h2', {}, h('span', { class: 'settings-title-wide' }, 'Settings'), h('span', { class: 'settings-title-narrow' }, page?.[1] ?? 'Settings'))];
}

/** Settings on a phone (#1018): every page as a row in its group, each opening the page full screen. */
export function settingsHome() {
  return h('section', { class: 'artifacts-main settings-home' },
    h('div', { class: 'ticket-head' },
      h('div', { class: 'row' }, h('h2', {}, 'Settings'), h('span', { class: 'spacer' }), tuneUpButton(),
        h('a', { class: 'close-view', href: `#/p/${view.projectId}`, title: 'Back to the Taskmaster', 'aria-label': 'Close' }, icon('close')))),
    h('nav', { 'aria-label': 'Settings' }, settingsGroups().flatMap(([label, hue, items]) => [
      h('h3', { class: 'settings-section', 'data-hue': hue }, label),
      h('div', { class: 'settings-rows' }, items.map(([kind, text, ic, sum]) =>
        h('a', { class: 'settings-row settings-page-link', 'data-hue': hue, href: `#/p/${view.projectId}/${kind}` },
          h('span', { class: 'settings-tile' }, icon(ic)),
          h('span', { class: 'settings-row-text' }, h('span', { class: 'settings-row-title' }, text, propsCount(kind)), h('span', { class: 'settings-row-sum' }, sum)),
          h('span', { class: 'settings-row-chev' }, icon('forward')))))])));
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
 * Fast mode (#1017): Off or Fast. A low or medium land goes live on the smoke check alone and the full suite runs on
 * main behind it; the server refuses it while the scheme's land.sh is older than the kit's, and the toast says so.
 */
function fastModeRow(p) {
  const on = h('input', { type: 'checkbox', id: 'land-mode', checked: p.land_mode === 'fast' });
  const [row, sum] = settingsRow({ icon: 'spark', hue: 'running', title: 'Fast mode', summary: p.land_mode === 'fast' ? 'On' : 'Off' },
    h('label', { class: 'toggle', title: 'Ship now, test behind' }, on, 'Ship now, test behind'),
    settingsHelp('Low and medium changes ship live on the smoke check alone, and the full suite runs on main behind them.',
      'A red reopens the minion whose change broke it, and goes to the Taskmaster if it isn\'t fixed in 30 minutes. Failures already known on main don\'t hold other changes up. High-risk changes and changes to the ship pipeline keep the full gate, and CI reds on main from fast ships send no Mandate alerts, except from watched workflows.'));
  const shown = () => {
    on.checked = view.project?.land_mode === 'fast';
    sum.textContent = on.checked ? 'On' : 'Off';
  };
  on.addEventListener('settings-refresh', shown);
  on.addEventListener('change', () => {
    const land_mode = on.checked ? 'fast' : 'off';
    saveProject(p, { land_mode }, { land_mode }, `turn fast mode ${on.checked ? 'on' : 'off'}`, shown);
  });
  return row;
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

/** Reads what the pickers list (plugin folders, the property registry, CI's workflows, the schedule count), then redraws them. */
function loadRulesData(rules, elsewhere) {
  const id = view.projectId;
  Promise.allSettled([api(`api/projects/${id}/plugins`), api(`api/projects/${id}/properties`), api('api/ci'), api(`api/projects/${id}/schedules`)]).then(([pl, pr, ci, sc]) => {
    rules.data.failed = { plugins: pl.status === 'rejected', ci: ci.status === 'rejected' };
    if (pl.value) rules.data.found = pl.value.plugins;
    if (pr.value) rules.data.registry = pr.value.keys.filter((k) => k.value_kind === 'enum' && k.status === 'active').map((k) => ({ key: k.key, values: k.values.filter((v) => v.status !== 'proposed' && v.status !== 'archived').map((v) => v.value) }));
    if (ci.value) rules.data.workflows = ci.value.schemes.find((s) => s.id === id)?.view.workflows ?? [];
    if (sc.value && elsewhere[0]?.isConnected) elsewhere[0].replaceWith(...elsewhereRows(sc.value.schedules.filter((x) => !x.paused).length).slice(0, 1));
    rules.refreshAll();
  });
}

/** Main panel: Minion rules, each setting a row of pickers (public/minion-rules.js) with typed entry as the fallback. */
export function approvalsEditor() {
  const p = view.project;
  const rules = pickers({ settingsRow, settingsHelp, saveProject });
  const elsewhere = elsewhereRows(null);
  const section = h('section', { class: 'artifacts-main instructions-main' },
    h('div', { class: 'ticket-head' },
      h('div', { class: 'row' }, ...settingsTitle(), h('span', { class: 'spacer' }), tuneUpButton(),
        h('a', { class: 'close-view', href: `#/p/${p.id}`, title: 'Back to the Taskmaster', 'aria-label': 'Close' }, icon('close'))),
      settingsTabs(),
      h('div', { class: 'meta' }, 'Minions in this scheme use these from their next turn. The Taskmaster reads Shipping too.')),
    settingsSection('Approvals', rules.approvals()),
    settingsSection('Shipping', rules.ship(), rules.go(), fastModeRow(p), rules.tryFirst(), rules.builds(), rules.ghRunners()),
    // Plugins load code from any folder on the server, so only an admin changes them.
    settingsSection('Minions', rules.listGroups(), rules.effort(), rules.fable(), rules.grill()),
    settingsSection('Plugins', rules.plugins()),
    settingsSection('Checks', rules.shots()),
    settingsSection('CI', rules.ci()),
    settingsSection('Elsewhere', ...elsewhere));
  loadRulesData(rules, elsewhere);
  return section;
}

function renderInstructionsHead() {
  const el = document.getElementById('instructions-head');
  if (!el) return;
  const p = view.project;
  el.replaceChildren(
    h('div', { class: 'row' }, ...settingsTitle(), h('span', { class: 'spacer' }), tuneUpButton(),
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
    placeholder: 'How you want your minions to work: tone, when to ask and when to go, previews before shipping, the model and effort they start on…',
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
      h('div', { class: 'row' }, ...settingsTitle(), h('span', { class: 'spacer' }), tuneUpButton(),
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
        h('li', {}, 'how a change ships: tests, self-review and risk labels, the ship script, the pipeline lane'),
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
    h('div', { class: 'row' }, ...settingsTitle(), h('span', { class: 'spacer' }), tuneUpButton(),
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
