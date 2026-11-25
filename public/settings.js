// A scheme's settings: notifications, the Settings page's instructions and approvals tabs (the Machines page is settings-machines.js).
import { account, ago, api, h, icon, me, schemeIcon, view } from './base.js';
import { onSkillsChanged } from './skills.js';
import { openHash } from './core.js';
import { renderSidebar } from './sidebar.js';
import { optimistic } from './ui/optimistic.js';
import { toast } from './ui/status.js';
import { instructionCost } from './prompt-cost.js';
import { hueRow, meter, pips, statTiles, toneChip } from './look.js';
import { elsewhereRows, pickers } from './minion-rules.js';
import { gloss } from './help-words.js';
import { HOME_SCHEME } from './schemes.js';
import { ORDERS_GROUPS, SETTINGS_GROUPS, isOrdersPage } from './settings-pages.js';
import { GO_FROM, SHIP_PATHS, TRY_FIRST, label as optionLabel } from './shipping.js';

// ---------- push notifications ----------

// Web Push reaches this device with the app closed, for decisions, blockers and results only
// (question cards, failed turns, threads set ready, try or blocked); see src/push.ts.
// The desktop app (#1186) has no Web Push: its device is `desktop:<id>`, the id kept under DESKTOP_PUSH, and its pings
// come down the live stream while it runs (core.js shows them).
export const DESKTOP_PUSH = 'citadel-desktop-push';
const desktop = !!window.citadelDesktop;
const pushSupported = desktop ? 'Notification' in window : 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

async function pushSubscription() {
  if (desktop) {
    const id = localStorage.getItem(DESKTOP_PUSH);
    return id && { endpoint: `desktop:${id}`, unsubscribe: async () => localStorage.removeItem(DESKTOP_PUSH) };
  }
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
  if ((await Notification.requestPermission()) !== 'granted') throw new Error('Notifications are blocked for this site in the browser settings');
  if (desktop) {
    const id = localStorage.getItem(DESKTOP_PUSH) ?? crypto.randomUUID();
    const state = await api('api/push/subscription', { method: 'PUT', body: { desktop: id } });
    localStorage.setItem(DESKTOP_PUSH, id);
    return state;
  }
  const { publicKey } = await api('api/push/key');
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  // A subscription made with another key (an older data dir) can't be used; start over.
  const key = sub?.options?.applicationServerKey;
  if (
    sub &&
    key &&
    btoa(String.fromCharCode(...new Uint8Array(key)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '') !== publicKey
  ) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
  return api('api/push/subscription', { method: 'PUT', body: { subscription: sub.toJSON() } });
}

/** Unsubscribe this device: what it had set, for pushBackOn (null: it couldn't be read), or false if it wasn't subscribed. */
export async function pushOff() {
  if (!pushSupported) return false;
  const sub = await pushSubscription();
  if (!sub) return false;
  const was = await api('api/push/subscription', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => null);
  await api('api/push/subscription', { method: 'DELETE', body: { endpoint: sub.endpoint } });
  await sub.unsubscribe();
  return was && !was.subscribed ? false : was;
}

/** Subscribe this device again with what pushOff found set; off if any of it can't be, so a muted scheme never pings. */
export async function pushBackOn(was) {
  await pushOn();
  try {
    const { endpoint } = await pushSubscription();
    const set = (body) => api('api/push/subscription', { method: 'PATCH', body: { endpoint, ...body } });
    if (was.onlyPinned) await set({ onlyPinned: true });
    for (const projectId of was.muted) await set({ projectId, muted: true });
    for (const projectId of was.everything) await set({ projectId, everything: true });
  } catch (err) {
    await pushOff().catch(() => {});
    throw err;
  }
}

// What this browser last said of its push state, drawn at once on the next scheme so the box keeps its height while it asks again.
let pushState = { subscribed: false, muted: [] };

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
  const onRow = row(
    'bell',
    'accent',
    'Notify me on this device',
    'This device only',
    toggle(on, 'Notify me on this device', 'Questions for you, failed turns, and your minions that are ready or blocked'),
    hint,
    settingsHelp('Questions for you, failed turns, and your minions that are ready or blocked, as a notification on this browser or app. Other devices are set up on their own.'),
  );
  onRow.dataset.part = 'notify-this-device';
  const pinnedRow = row(
    'pin',
    'held',
    'Only my pinned minions',
    'This device only',
    toggle(pinned, 'Only my pinned minions', "On this device, notify only about minions you pinned (other people's too) and the Taskmaster"),
    settingsHelp("On this device, notify only about minions you pinned (other people's too) and the Taskmaster."),
  );
  // #690: a minion's pings go to its owner; this device can still hear every minion in the scheme.
  const allRow = row(
    'users',
    'running',
    `Everything in ${project.name}`,
    `This device · scheme ${project.name}`,
    toggle(all, `Everything in ${project.name}`, 'On this device, hear about every minion in this scheme, not only yours, the ones you pinned and the unassigned ones'),
    settingsHelp(`On this device, hear about every minion in ${project.name}, not only yours, the ones you pinned and the unassigned ones.`),
  );
  const muteRow = row('belloff', 'danger', `Mute ${project.name}`, `This device · scheme ${project.name}`, toggle(mute, `Mute ${project.name} here`, 'Stop notifications from this scheme on this device'), settingsHelp(`Stop notifications from ${project.name} on this device. Other schemes keep notifying.`));
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
    const state = sub && (await api('api/push/subscription', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => null));
    show(state ?? { subscribed: false, muted: [] }, err);
  }
  on.addEventListener('change', () =>
    busy(async () => {
      if (!on.checked) {
        await pushOff();
        return { subscribed: false, muted: [] };
      }
      return pushOn();
    }),
  );
  mute.addEventListener('change', () =>
    busy(async () => {
      const sub = await pushSubscription();
      return api('api/push/subscription', { method: 'PATCH', body: { endpoint: sub.endpoint, projectId: project.id, muted: mute.checked } });
    }),
  );
  all.addEventListener('change', () =>
    busy(async () => {
      const sub = await pushSubscription();
      return api('api/push/subscription', { method: 'PATCH', body: { endpoint: sub.endpoint, projectId: project.id, everything: all.checked } });
    }),
  );
  pinned.addEventListener('change', () =>
    busy(async () => {
      const sub = await pushSubscription();
      return api('api/push/subscription', { method: 'PATCH', body: { endpoint: sub.endpoint, onlyPinned: pinned.checked } });
    }),
  );
  show(pushState);
  if (pushSupported) refresh();
  return h(
    'section',
    { class: 'artifacts-main people-main' },
    h(
      'div',
      { class: 'ticket-head' },
      h('div', { class: 'row' }, ...settingsTitle(), h('span', { class: 'spacer' }), h('a', { class: 'close-view', href: `#/p/${view.projectId}`, title: 'Back to the Taskmaster', 'aria-label': 'Close' }, icon('close'))),
      settingsTabs(),
      h('div', { class: 'meta' }, 'Notifications are set per browser or app, so each device has its own. Scheme settings say which scheme they are for.'),
    ),
    pushSupported ? [...settingsSection('This device', onRow, pinnedRow), schemeBlock] : h('p', { class: 'muted' }, "This browser can't show notifications. Install Citadel as an app, or use a browser that supports them."),
  );
}

// Clicking a notification while the app is open: the service worker asks this tab to show the thread.
if (pushSupported && !desktop) {
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

/**
 * Read-only aids under an instructions editor: a size meter against the cap and an outline of its ## sections
 * (each with its character count, a click jumps there). Every turn reads the whole text, so size is cost.
 * Call update() whenever the text may have changed.
 */
function instructionAids(textarea, cap) {
  const gauge = h('div', { class: 'aids-meter', role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': cap, 'aria-label': 'Size against the limit' });
  const list = h('ol', { class: 'aids-outline' });
  const box = h('div', { class: 'aids-box' }, gauge, h('details', {}, h('summary', {}, 'Outline of ## sections'), list));
  const update = () => {
    const text = textarea.value;
    const n = text.trim().length;
    // Size is cost: ok under 80% of the cap, warn near it, danger over it (the meter and the chip share the hue).
    const [tone, hue, word] = n > cap ? ['danger', 'danger', 'Over the limit'] : n > cap * 0.8 ? ['warn', 'waiting', 'Near the limit'] : ['ok', 'done', 'Fits'];
    gauge.setAttribute('aria-valuenow', n);
    gauge.dataset.hue = hue;
    gauge.replaceChildren(toneChip(tone, word), meter(n / cap, `${count(n)} of ${count(cap)} characters (${Math.round((n / cap) * 100)}%)`), h('span', { class: 'muted small' }, 'Every turn reads all of it.'));
    const marks = [...text.matchAll(/^##[ \t]+(.+)$/gm)];
    list.replaceChildren(
      ...(marks.length
        ? marks.map((m, i) => {
            const end = i + 1 < marks.length ? marks[i + 1].index : text.length;
            const jump = h('button', { type: 'button', class: 'linklike' }, m[1].trim());
            jump.onclick = () => {
              textarea.focus();
              textarea.setSelectionRange(m.index, m.index + m[0].length);
            };
            return h('li', {}, jump, h('span', { class: 'muted small' }, ` ${count(end - m.index)}`));
          })
        : [h('li', { class: 'muted small' }, 'No ## sections yet.')]),
    );
  };
  textarea.addEventListener('input', update);
  update();
  return { el: box, update };
}

/** A read-only card: how this scheme's repo is set up, read from its files when the page opens. */
function repoSetupCard() {
  const p = view.project;
  const body = h('div', { class: 'repo-setup' }, h('p', { class: 'muted small' }, 'Reading the repo…'));
  // `code` and **bold** spans as elements; a value past 240 characters shows its start, the rest behind a toggle.
  const inline = (t) =>
    t
      .split(/(`[^`]+`|\*\*[^*]+\*\*)/)
      .filter(Boolean)
      .map((x) => (x[0] === '`' ? h('code', {}, x.slice(1, -1)) : x.startsWith('**') ? h('strong', {}, x.slice(2, -2)) : x));
  const long = (t) => (t.length <= 240 ? inline(t) : h('details', {}, h('summary', {}, ...inline(t.slice(0, 240).replace(/[`*]+[^`*]*$/, '')), '…'), h('div', {}, ...inline(t))));
  const kv = (rows) => h('dl', { class: 'repo-facts' }, ...rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, long(v))]));
  api(`api/projects/${p.id}/repo-setup`).then(
    (r) => {
      const parts = [statTiles([r.facts ? r.facts.length : 0, 'project facts', r.facts ? 'done' : 'waiting'], [r.rules.length, 'rules', 'running'], [r.skills.length, 'own skills', 'teal'])];
      if (!r.facts) parts.push(h('p', {}, toneChip('warn', 'No Project facts'), " The kit's skills fall back to defaults. ", 'Use the Tune up button above to have the Taskmaster write them.'));
      else parts.push(kv(r.facts.map((f) => [f.label, f.value])));
      parts.push(
        h('h4', {}, `Rules (.claude/rules/, ${r.rules.length})`),
        r.rules.length ? kv(r.rules.map((x) => [x.name, `${count(x.size)} chars · ${x.paths.length ? 'scoped to ' + x.paths.join(', ') : 'always loaded'}` + (x.upstream ? ` · copied from ${x.upstream}${x.pin ? ` at ${x.pin}` : ''}` : '')])) : h('p', { class: 'muted small' }, 'None.'),
      );
      parts.push(h('h4', {}, `Its own skills (.claude/skills/, ${r.skills.length})`), r.skills.length ? kv(r.skills.map((x) => [x.name, x.description])) : h('p', { class: 'muted small' }, 'None.'));
      body.replaceChildren(...parts);
    },
    (err) => body.replaceChildren(h('p', { class: 'error' }, `Could not read the repo: ${err.message}`)),
  );
  return h('div', { class: 'settings-card settings-anchor', id: 'repo-setup' }, h('h3', { class: 'settings-label' }, "How this scheme's repo is set up"), h('div', { class: 'muted small' }, 'Read from CLAUDE.md and .claude/ in the repo each time you open this; change it by editing the repo or with a tune-up.'), body);
}

export function onProjectUpdate(project) {
  for (const el of document.querySelectorAll(`[data-project-name="${project.id}"]`)) el.textContent = project.name;
  for (const el of document.querySelectorAll(`[data-taskmaster-name="${project.id}"]`)) el.textContent = `${project.name} Taskmaster`;
  if (view?.kind !== 'project') return;
  view.projects = view.projects.map((p) => (p.id === project.id ? { ...p, name: project.name } : p));
  if (view.projectId !== project.id) return;
  view.project = project;
  for (const el of document.querySelectorAll('[data-rules-row]')) el.dispatchEvent(new Event('settings-refresh'));
  document.getElementById('land-mode')?.dispatchEvent(new Event('settings-refresh'));
  for (const el of document.querySelectorAll('[data-rules-review]')) el.dispatchEvent(new Event('settings-refresh'));
  onSkillsChanged();
  renderSidebar(); // its promoted groups may have changed
  theirText('instructions-text', project.instructions);
  renderInstructionsHead();
  document.getElementById('onboarding-strip')?.replaceWith(onboardingStrip(project));
  renderGithubStrip();
  for (const b of document.querySelectorAll('.ticket-head button.tune-up')) b.replaceWith(tuneUpButton());
}

/** Someone else saved: show their text unless this tab has edits of its own, and bring the counter and buttons in step (sync). */
function theirText(id, text) {
  const el = document.getElementById(id);
  if (!el) return;
  if (!el.hasAttribute('data-draft')) el.value = text;
  el.dispatchEvent(new Event('settings-refresh'));
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
  return h('div', { id: 'onboarding-strip', class: 'onboarding-strip' }, h('span', {}, project.onboarding_mode === 'tune-up' ? 'Tuning up' : 'Setting up'), ' · ', h('span', {}, `${step[1]} (${step[0]} of 4)`), ' · ', skip);
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
  const settings = h('a', { class: 'settings-link', href: `#/p/${project.id}/settings`, title: "Members, your account, machines and usage; the scheme's instructions and rules are in Orders, beside Minions" }, 'Settings');
  const show = () => {
    wrap.replaceChildren(
      schemeIcon(view.projects?.find((p) => p.id === project.id) ?? project),
      h('button', { type: 'button', class: 'label', 'data-project-name': project.id, title: 'Rename scheme (its repo stays as it is)', onclick: edit }, view.project.name),
      h('span', { class: 'divider', 'aria-hidden': 'true' }),
      settings,
    );
  };
  // Every label showing the name changes now; the server's broadcast confirms it, and a refusal puts the old name back.
  const rename = (name) => onProjectUpdate({ ...(view.projectId === project.id ? view.project : project), name });
  const edit = () => {
    const panel = wrap.closest('details');
    if (panel && !panel.open) {
      panel.open = true;
      return;
    }
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
      if (e.key === 'Enter') {
        e.preventDefault();
        save();
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        show();
      }
    });
    // A space let through to the <summary> would collapse the panel in some browsers.
    input.addEventListener('keyup', (e) => {
      if (e.key === ' ') e.preventDefault();
    });
    input.addEventListener('blur', () => input.isConnected && show());
    wrap.replaceChildren(
      input,
      // mousedown kept from blurring the field, so the tap reaches save instead of cancelling.
      h('button', { type: 'button', class: 'rename', 'aria-label': 'Save name', onmousedown: (e) => e.preventDefault(), onclick: save }, '✓'),
    );
    input.focus();
    input.select();
  };
  wrap.addEventListener('click', (e) => {
    // Clicks inside the title edit it; they don't collapse the panel or close the drawer.
    if (e.target.closest('button, input')) {
      e.preventDefault();
      e.stopPropagation();
    } else if (e.target.closest('a')) e.stopPropagation(); // Settings goes there without toggling the panel
  });
  show();
  return wrap;
}

/** The Settings page's tabs; each is its own route, so old links to them still work. */
// The side menu (#995, Cara picked "Side menu, rows that open"): groups, each its own hue, every page with an
// icon and a one-line summary for the phone's list (#1018). On a phone the menu hides: Settings opens on that list
// (settingsHome), and each page's bar has a back link to it and the page's own name (Cara picked "A list of pages,
// each opens full screen").
// Orders (#1071, Josh 2026-11-19: "Lets go with Orders"; picked "Minions | Orders tabs on the panel"): what minions read
// and how work runs moved out of Settings to a tab beside Minions (ordersMenu). Settings keeps you and the admin pages.
// Schedules (#1083) lists them in the panel and opens each one's page in the main pane.
export { ORDERS_GROUPS, SETTINGS_GROUPS };
/** True for a page that lives in Orders, not Settings. */
export { isOrdersPage };
const settingsGroups = () => SETTINGS_GROUPS.filter(([, , , admin]) => !admin || account?.admin);
const propsCount = (kind) => (kind === 'properties' ? h('span', { class: 'count props-count', hidden: true }) : '');

export function settingsTabs() {
  // An Orders page keeps the (hidden) menu so it shares the settings pages' layout; its menu is the panel's Orders tab.
  if (isOrdersPage(view.main)) return h('nav', { class: 'settings-tabs orders-tabs', 'aria-hidden': 'true' });
  const nav = h(
    'nav',
    { class: 'settings-tabs', 'aria-label': 'Settings' },
    settingsGroups().map(([label, hue, items]) =>
      h(
        'div',
        { class: 'settings-group', 'data-hue': hue },
        h('span', { class: 'settings-group-label' }, label === 'Scheme' ? gloss('scheme', label) : label),
        items.map(({ kind, label: text, icon: ic }) =>
          h('a', { class: view.main === kind ? 'active' : '', href: `#/p/${view.projectId}/${kind}`, 'aria-current': view.main === kind ? 'page' : null }, icon(ic), h('span', { class: 'label' }, kind === 'contraptions' ? gloss('contraption', text) : text), propsCount(kind)),
        ),
      ),
    ),
  );
  return nav;
}

/** The Minions panel's Orders tab (#1071): its pages in two groups; each opens in the main pane. */
export function ordersMenu() {
  return h(
    'nav',
    { class: 'orders-pane', 'aria-label': 'Orders' },
    ORDERS_GROUPS.map(([label, hue, items]) =>
      h(
        'div',
        { class: 'orders-group', 'data-hue': hue },
        h('span', { class: 'orders-group-label' }, label),
        items.map(({ kind, label: text, icon: ic, blurb: sum }) =>
          h(
            'a',
            {
              class: view.main === kind ? 'active' : '',
              href: `#/p/${view.projectId}/${kind}`,
              title: sum,
              'aria-current': view.main === kind ? 'page' : null,
              // Back from the schedules list to this menu changes no route, so Schedules again only shows the list (#1083).
              onclick:
                kind === 'schedules'
                  ? (e) => {
                      if (view.main === 'schedules') e.currentTarget.closest('.sidebar')?.classList.add('show-schedules');
                    }
                  : null,
            },
            icon(ic),
            h('span', { class: 'label' }, text),
            propsCount(kind),
          ),
        ),
      ),
    ),
  );
}

/** A settings or Orders page's title: its area beside the desktop menu; on a phone a back link to the list and the page's name. */
export function settingsTitle() {
  const orders = isOrdersPage(view.main);
  const page = (orders ? ORDERS_GROUPS : SETTINGS_GROUPS).flatMap(([, , items]) => items).find((r) => r.kind === view.main);
  const area = orders ? 'Orders' : 'Settings';
  return [
    h('a', { class: 'settings-back', href: `#/p/${view.projectId}/${orders ? 'orders' : 'settings'}`, title: orders ? 'All of Orders' : 'All settings' }, icon('back'), area),
    // An Orders page has no menu beside it, so its own name heads it on a desktop too.
    h('h2', {}, h('span', { class: 'settings-title-wide' }, orders ? (page?.label ?? area) : area), h('span', { class: 'settings-title-narrow' }, page?.label ?? area)),
  ];
}

/** Settings on a phone (#1018): every page as a row in its group, each opening the page full screen. Orders' list is the same shape. */
export function settingsHome(orders = false) {
  const title = orders ? 'Orders' : 'Settings';
  return h(
    'section',
    { class: 'artifacts-main settings-home' },
    h('div', { class: 'ticket-head' }, h('div', { class: 'row' }, h('h2', {}, title), h('span', { class: 'spacer' }), tuneUpButton(), h('a', { class: 'close-view', href: `#/p/${view.projectId}`, title: 'Back to the Taskmaster', 'aria-label': 'Close' }, icon('close')))),
    h(
      'nav',
      { 'aria-label': title },
      (orders ? ORDERS_GROUPS : settingsGroups()).flatMap(([label, hue, items]) => [
        h('h3', { class: 'settings-section', 'data-hue': hue }, label),
        h(
          'div',
          { class: 'settings-rows' },
          items.map(({ kind, label: text, icon: ic, blurb: sum }) =>
            h(
              'a',
              { class: 'settings-row settings-page-link', 'data-hue': hue, href: `#/p/${view.projectId}/${kind}` },
              h('span', { class: 'settings-tile' }, icon(ic)),
              h('span', { class: 'settings-row-text' }, h('span', { class: 'settings-row-title' }, text, propsCount(kind)), h('span', { class: 'settings-row-sum' }, sum)),
              h('span', { class: 'settings-row-chev' }, icon('forward')),
            ),
          ),
        ),
      ]),
    ),
  );
}

/** "Tune up" (#175): the Taskmaster runs setup again as a diff on what the scheme has, then the chat opens on it. */
export function tuneUpButton() {
  const p = view.project;
  const open = p.onboarding !== 'done' && p.onboarding !== 'skipped';
  const b = h('button', { type: 'button', class: 'secondary tune-up', disabled: open, title: open ? "Setup is under way: see the Taskmaster's chat" : 'The Taskmaster asks what changed and posts a plan of edits for you to approve' }, 'Tune up');
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
  // Citadel itself stays off (Cara, 2026-11-18, "Later"; Josh, 2026-11-19: lock it with a note). The server still accepts
  // the setting. If #1017's Nov 26 decision turns it on for Citadel, change this line to `const locked = false;` (or delete it).
  const locked = p.id === HOME_SCHEME;
  const on = h('input', { type: 'checkbox', id: 'land-mode', checked: !locked && p.land_mode === 'fast', disabled: locked });
  const [row, sum] = settingsRow(
    { part: 'fast-mode', icon: 'spark', hue: 'running', title: 'Fast mode', summary: p.land_mode === 'fast' ? 'On' : 'Off' },
    h('label', { class: 'toggle', title: locked ? 'Off for Citadel itself' : 'Ship now, test behind' }, on, 'Ship now, test behind'),
    locked && h('p', { class: 'muted small settings-help' }, 'Off for Citadel itself: every scheme runs on it. Cara picked "Later" (Nov 18); it\'s decided around Nov 26 from the other schemes\' numbers.'),
    settingsHelp(
      'Low and medium changes ship live on the smoke check alone, and the full suite runs on main behind them.',
      "A red reopens the minion whose change broke it, and goes to the Taskmaster if it isn't fixed in 30 minutes. Failures already known on main don't hold other changes up. High-risk changes and changes to the ship pipeline keep the full gate, and CI reds on main from fast ships send no Mandate alerts, except from watched workflows.",
    ),
  );
  const shown = () => {
    on.checked = !locked && view.project?.land_mode === 'fast';
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
 * `draft`: the typed text being saved (typedDraft's `begin()`).
 */
function saveProject(p, mine, body, label, shown, draft) {
  let was;
  const ours = () => view.project?.id === p.id && Object.entries(mine).every(([k, v]) => view.project[k] === v);
  const result = optimistic({
    key: `scheme-settings:${p.id}`,
    sets: `scheme-settings:${p.id}:${Object.keys(mine).sort()}`,
    apply: () => {
      was = Object.fromEntries(Object.keys(mine).map((k) => [k, view.project?.[k]]));
      if (view.project?.id === p.id) Object.assign(view.project, mine);
      renderSidebar();
      draft?.sent();
      shown(true);
    },
    send: () => api(`api/projects/${p.id}`, { method: 'PATCH', body }).finally(draft?.answered),
    undo: (err) => {
      // Otherwise someone's update, or a later save, changed them again: theirs stays, and the page still says it wasn't saved.
      if (ours()) Object.assign(view.project, was);
      renderSidebar();
      draft?.refused();
      shown(false, err);
      // The stream has no replay: a tab that missed their update fetches it, so Discard loads theirs as the refusal says.
      if (err?.status === 409 && body.was)
        api(`api/projects/${p.id}?tickets=open`).then(
          ({ project }) => onProjectUpdate(project),
          () => {},
        );
    },
    label,
  });
  result.then(
    (project) => ours() && onProjectUpdate(project),
    () => {},
  ); // a failure already said so in its toast
  return result;
}

/**
 * A text field other people can save too (#1859). Keeps the stored text its draft began from, for the save to name as
 * `was`, and the field's data-draft mark, which stands while a save is out: a refusal then finds the text still in the box.
 */
function typedDraft(el, saved, dirty = () => el.value.trim() !== saved().trim()) {
  let base = saved();
  let out = 0;
  const sync = () => {
    const changed = dirty();
    if (!changed) base = saved();
    el.toggleAttribute('data-draft', changed || out > 0);
    return changed;
  };
  return {
    /** Whether it holds unsaved text; also the place the mark and the base are brought up to date. */
    sync,
    /** One save of it, from its press: the text it began from, and what the save tells the draft as it goes. */
    begin: () => {
      const from = base;
      return {
        from,
        sent: () => out++,
        answered: () => {
          out--;
          sync();
        },
        refused: () => {
          sync();
          base = from;
        },
      };
    },
  };
}

/**
 * A row that opens (#995, Cara picked "Side menu, rows that open"): an icon tile in its own hue, a title, a one-line
 * summary and a chevron; the body (help, field, Save) opens beneath it on a click. Returns the row and its summary
 * line, which its page keeps up to date.
 */
export function settingsRow({ icon: ic, hue, title, summary = '', open = false, key, part }, ...body) {
  const sum = h('span', { class: 'settings-row-sum' }, summary);
  // `key`: a page that redraws (the CI page, every few seconds) keeps a row open that a person opened (#1068).
  // `part`: its name for "show me where" links (#1122, src/show-parts.ts).
  const row = h(
    'details',
    { class: 'settings-row', 'data-hue': hue, 'data-part': part ?? null, open: key && openRows.has(key) ? openRows.get(key) : open, ontoggle: key ? (e) => openRows.set(key, e.currentTarget.open) : null },
    h('summary', {}, h('span', { class: 'settings-tile' }, icon(ic)), h('span', { class: 'settings-row-text' }, h('span', { class: 'settings-row-title' }, title), sum), h('span', { class: 'settings-row-chev' }, icon('forward'))),
    h('div', { class: 'settings-row-body' }, ...body),
  );
  return [row, sum];
}

const openRows = new Map(); // a keyed row's open state, by key

/** A group of rows under an uppercase heading. */
export const settingsSection = (title, ...rows) => [h('h3', { class: 'settings-section' }, title), h('div', { class: 'settings-rows' }, ...rows)];

/**
 * A strip of in-page links at the top of a long page (Cara picked "Jump links on long pages"). Plain `#id` links would
 * hit the hash router, so each scrolls its target (an element with that id, which carries .settings-anchor) into view.
 */
export function settingsJump(...links) {
  return h(
    'nav',
    { class: 'settings-jump', 'aria-label': 'On this page' },
    links.map(([id, label]) =>
      h(
        'a',
        {
          href: `#/p/${view.projectId}/${view.main}`,
          onclick: (e) => {
            e.preventDefault();
            document.getElementById(id)?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
          },
        },
        label,
      ),
    ),
  );
}

/** Help text cut to its first sentence, the rest behind More (Cara picked "Shorter help text"). */
export function settingsHelp(first, ...rest) {
  if (!rest.length) return h('p', { class: 'muted small settings-help' }, first);
  const more = h('span', { class: 'settings-more', hidden: true }, ' ', ...rest);
  const btn = h(
    'button',
    {
      type: 'button',
      class: 'settings-more-btn',
      'aria-expanded': 'false',
      onclick: () => {
        more.hidden = !more.hidden;
        btn.textContent = more.hidden ? 'More' : 'Less';
        btn.setAttribute('aria-expanded', String(!more.hidden));
      },
    },
    'More',
  );
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

/**
 * The pass on Minion rules after setup (#1046; Cara, 2026-11-19: "lets the user do a pass on it once it is set up").
 * Shown while projects.rules_review is on: what setup filled in and what is still the default, and "Looks right".
 * The flag is the scheme's, so one click clears it for every member.
 */
function rulesReviewBanner() {
  const p = view.project;
  const box = h('section', { class: 'rules-review', 'data-rules-review': '', 'aria-label': 'Check the rules after setup' });
  const ok = h('button', { type: 'button' }, 'Looks right');
  const list = h('div', { class: 'hue-rows' });
  const summary = h('div', { class: 'row' });
  const lines = (s) =>
    (s ?? '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean).length;
  const draw = () => {
    box.hidden = !view.project.rules_review;
    const q = view.project;
    // [what, value, whether it is still the starting value]
    const rows = [
      ['How changes ship', optionLabel(SHIP_PATHS, q.ship_path), q.ship_path === 'citadel'],
      ["A person's go", optionLabel(GO_FROM, q.go_from), q.go_from === 'high'],
      ['Try it first', optionLabel(TRY_FIRST, q.try_first), q.try_first === 'never'],
      ['Approval rules', `${lines(q.approval_rules)} rule${lines(q.approval_rules) === 1 ? '' : 's'}`, lines(q.approval_rules) === 0],
      ['Default effort', q.default_effort || "Claude Code's default", q.default_effort === 'high'],
      ['Plugin folders', `${lines(q.plugin_dirs)} folder${lines(q.plugin_dirs) === 1 ? '' : 's'}`, lines(q.plugin_dirs) === 0],
    ];
    const changed = rows.filter((r) => !r[2]).length;
    summary.replaceChildren(toneChip(changed ? 'ok' : 'warn', changed ? `${changed} of ${rows.length} changed` : 'All starting values'), pips(changed, rows.length));
    list.replaceChildren(...rows.map(([what, value, dflt]) => hueRow({ hue: dflt ? 'muted' : 'done', meta: toneChip(dflt ? 'neutral' : 'ok', dflt ? 'starting value' : 'changed') }, h('b', {}, what), ' ', value)));
  };
  box.append(h('h3', {}, 'Setup is done: check these rules'), summary, h('p', { class: 'muted small' }, 'Go through the rows below and change what is off; each pick saves at once. "Starting value" is what a new scheme begins with. "Looks right" clears this for every member.'), list, h('div', { class: 'row' }, ok));
  box.addEventListener('settings-refresh', draw);
  ok.onclick = () => {
    ok.disabled = true;
    saveProject(p, { rules_review: 0 }, { rules_review: false }, 'Marking the rules as checked', (done) => {
      if (!done) ok.disabled = false;
      draw();
    });
  };
  draw();
  return box;
}

/** Main panel: Minion rules, each setting a row of pickers (public/minion-rules.js) with typed entry as the fallback. */
export function approvalsEditor() {
  const p = view.project;
  const rules = pickers({ settingsRow, settingsHelp, saveProject, typedDraft });
  const elsewhere = elsewhereRows(null);
  const section = h(
    'section',
    { class: 'artifacts-main instructions-main' },
    h(
      'div',
      { class: 'ticket-head' },
      h('div', { class: 'row' }, ...settingsTitle(), h('span', { class: 'spacer' }), tuneUpButton(), h('a', { class: 'close-view', href: `#/p/${p.id}`, title: 'Back to the Taskmaster', 'aria-label': 'Close' }, icon('close'))),
      settingsTabs(),
      h('div', { class: 'meta' }, 'Minions in this scheme use these from their next turn. The Taskmaster reads Shipping too.'),
      rulesReviewBanner(),
    ),
    settingsSection('Approvals', rules.approvals()),
    settingsSection('Shipping', rules.ship(), rules.go(), fastModeRow(p), rules.tryFirst(), rules.builds(), rules.ghRunners()),
    // Plugins load code from any folder on the server, so only an admin changes them.
    settingsSection('Minions', rules.listGroups(), rules.effort(), rules.fable(), rules.grill()),
    settingsSection('Messages', ...rules.messages()),
    settingsSection('Plugins', rules.plugins()),
    settingsSection('Checks', rules.shots()),
    settingsSection('CI', rules.ci()),
    settingsSection('Elsewhere', ...elsewhere),
  );
  loadRulesData(rules, elsewhere);
  return section;
}

function renderInstructionsHead() {
  const el = document.getElementById('instructions-head');
  if (!el) return;
  const p = view.project;
  el.replaceChildren(
    h('div', { class: 'row' }, ...settingsTitle(), h('span', { class: 'spacer' }), tuneUpButton(), h('a', { class: 'close-view', href: `#/p/${p.id}`, title: 'Back to the Taskmaster', 'aria-label': 'Close' }, icon('close'))),
    settingsTabs(),
    h('div', { class: 'meta' }, 'The Taskmaster and every minion get these in their system prompt, from their next turn.', p.instructions_updated_by ? ` Last changed by ${p.instructions_updated_by} ${ago(p.instructions_updated_at)}.` : ''),
  );
}

/** The last few saves of some instructions, each with what it removed and added, and how to reload them. */
function recentChanges(url, restore) {
  const history = h('div', { class: 'instructions-history' });
  const load = async () => {
    try {
      const { history: saves } = await api(url);
      history.replaceChildren(
        ...(saves.length ? [h('h3', { class: 'settings-label' }, 'Recent changes')] : []),
        ...saves.map((s) =>
          h(
            'details',
            {},
            h('summary', {}, `${s.by}, ${ago(s.at)} `, h('span', { class: 'muted small' }, `+${s.diff.filter((d) => d.op === '+').length} −${s.diff.filter((d) => d.op === '-').length} lines`)),
            h('pre', { class: 'instructions-diff' }, ...s.diff.map((d) => h('div', { class: d.op === '+' ? 'add' : d.op === '-' ? 'del' : 'gap' }, d.op === '…' ? '…' : `${d.op} ${d.text}`))),
            // Fills the field with the text from before this save; nothing is saved until Save.
            ...(restore && s.before !== undefined ? [h('button', { type: 'button', class: 'secondary', onclick: () => restore(s.before) }, 'Put the text from before this change in the field')] : []),
          ),
        ),
      );
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
    id: 'my-instructions-text',
    'data-part': 'my-instructions',
    class: 'instructions-text settings-anchor',
    spellcheck: 'false',
    disabled: true,
    'aria-label': 'My instructions',
    placeholder: 'How you want your minions to work: tone, when to ask and when to go, previews before shipping, the model and effort they start on…',
  });
  const counter = h('span', { class: 'muted counter' });
  const aids = instructionAids(textarea, MAX_PERSONAL);
  const status = h('span', { class: 'muted', role: 'status' }, 'Loading…');
  const save = h('button', { type: 'button', disabled: true }, 'Save');
  const discard = h('button', { type: 'button', class: 'secondary', disabled: true }, 'Discard');
  // The other scope's unsaved text, in a hidden field marked as a draft so a front-end reload waits for it too.
  const hidden = h('textarea', { hidden: true, 'aria-hidden': 'true', tabindex: -1 });
  const sync = () => {
    const dirty = !textarea.disabled && textarea.value.trim() !== saved[scope].trim();
    textarea.toggleAttribute('data-draft', dirty);
    hidden.value = Object.entries(drafts)
      .filter(([k, v]) => k !== scope && v.trim() !== saved[k].trim())
      .map(([, v]) => v)
      .join('\n');
    hidden.toggleAttribute('data-draft', !!hidden.value.trim());
    const n = textarea.value.trim().length;
    counter.textContent = `${count(n)} / ${count(MAX_PERSONAL)}`;
    counter.classList.toggle('over', n > MAX_PERSONAL);
    aids.update();
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
  const scopes = [
    ['everywhere', 'Everywhere'],
    ['scheme', `${p.name} only`],
  ];
  const switcher = h('div', { class: 'row my-scope', role: 'group', 'aria-label': 'Applies to' });
  const showScope = (next) => {
    scope = next;
    switcher.replaceChildren(...scopes.map(([key, label]) => h('button', { type: 'button', class: `chip${key === scope ? ' on' : ''}`, 'aria-pressed': String(key === scope), onclick: () => showScope(key) }, label)));
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
    }).then(
      (r) => {
        histories[at][1]();
        if (saved[at] !== text.trim()) return; // a later save changed it again
        saved = { ...saved, [at]: r[at].text };
        if (scope === at && textarea.value === text) textarea.value = r[at].text; // as the server keeps it
        sync();
      },
      () => {},
    );
  };
  discard.onclick = () => {
    delete drafts[scope];
    textarea.value = saved[scope];
    status.textContent = '';
    sync();
  };
  const layer = (name, who, cls) => h('li', { class: cls }, h('strong', {}, name), h('span', { class: 'muted small' }, who));
  const section = h(
    'section',
    { class: 'artifacts-main instructions-main my-instructions' },
    h(
      'div',
      { class: 'ticket-head' },
      h('div', { class: 'row' }, ...settingsTitle(), h('span', { class: 'spacer' }), tuneUpButton(), h('a', { class: 'close-view', href: `#/p/${p.id}`, title: 'Back to the Taskmaster', 'aria-label': 'Close' }, icon('close'))),
      settingsTabs(),
      h('div', { class: 'meta' }, 'Only you edit these. They load into the minions assigned to you, from their next turn.'),
    ),
    settingsJump(['my-instructions-text', 'Your text'], ['my-instructions-recent', 'Recent changes'], ['my-instructions-order', 'What a minion reads']),
    h('h3', { class: 'settings-label' }, 'Applies to'),
    switcher,
    aids.el,
    textarea,
    hidden,
    h('div', { class: 'row instructions-actions' }, save, discard, status, h('span', { class: 'spacer' }), counter),
    h('div', { id: 'my-instructions-recent', class: 'settings-anchor' }, historySlot),
    h(
      'div',
      { class: 'settings-card settings-anchor', id: 'my-instructions-order' },
      h('h3', { class: 'settings-label' }, 'What a minion of yours reads, in order'),
      h('ol', { class: 'my-layers' }, layer('Citadel-wide', 'everyone, every scheme', 'l-app'), layer('Scheme instructions', `everyone in ${p.name}`, 'l-scheme'), layer("Yours: everywhere, then this scheme's", 'the minions assigned to you', 'l-mine')),
      h('p', { class: 'muted small' }, "The Taskmaster's prompt stays the same for everyone: it reads yours when it starts a minion for you. When someone else writes in your minion, it follows their way for their own asks."),
    ),
    h(
      'div',
      { class: 'settings-card' },
      h('h3', { class: 'settings-label' }, 'Yours wins over 1 and 2, except'),
      h(
        'ul',
        { class: 'my-limits' },
        h('li', {}, "secrets, logins, other people's files and deleting data"),
        h('li', {}, 'the tripwire'),
        h('li', {}, 'how a change ships: tests, self-review and risk labels, the ship script, the pipeline lane'),
        h('li', {}, "shared names, the shared folder's layout and the decisions log"),
        h('li', {}, "another person's pick or decision"),
      ),
    ),
  );
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

/**
 * Before a person's save (#1162): the server's matcher lists what already says the new words (a registered rule outside
 * its one home, or a paragraph elsewhere sharing a run of its words), and the save goes ahead only on Save anyway.
 * Resolves true to save. A failed check never blocks a save. Then a Sonnet check on the person's own Claude login says
 * whether each really repeats (#1211; Josh, 2026-11-20: "List now, verdicts fill in"); Save anyway works throughout.
 * Leaving while it checks saves, saying so: there is no list left to press Save anyway in, and the text would be lost (#1859).
 */
async function checkRepeats(scope, text, box, status) {
  const projectId = view.projectId;
  let found;
  try {
    ({ found } = await api(`api/projects/${projectId}/instructions/overlaps`, { method: 'POST', body: { scope, text } }));
  } catch {
    return true;
  }
  if (!found.length) return (box.hidden = true);
  if (!box.isConnected) {
    toast(`Saving the instructions you left. Some of it is already said in ${found.length === 1 ? found[0].label : `${found.length} places`}`);
    return true;
  }
  status.textContent = '';
  return new Promise((done) => {
    const close = (go) => () => {
      box.hidden = true;
      done(go);
    };
    const where = (o) => {
      const name = `${o.label}${o.line ? `, line ${o.line}` : ''}`;
      return o.href ? h('a', { href: o.href, ...(/^https?:/.test(o.href) ? { target: '_blank', rel: 'noopener' } : {}) }, name) : h('strong', {}, name);
    };
    const marks = found.map(() => h('span', { class: 'repeat-verdict muted' }, 'Sonnet: checking…'));
    const note = h('p', { class: 'muted' }, 'Sonnet is reading these on your Claude login to say which really repeat.');
    box.replaceChildren(
      h('p', {}, h('strong', {}, 'Already said elsewhere. '), 'Work your change in where it is already written, or point there in a few words, or save it anyway.'),
      // The buttons sit above the list, so verdicts filling in below never move them (no reflow without input).
      h('div', { class: 'row' }, h('button', { type: 'button', onclick: close(true) }, 'Save anyway'), h('button', { type: 'button', class: 'secondary', onclick: close(false) }, 'Keep editing')),
      h('ul', {}, ...found.map((o, i) => h('li', {}, where(o), `: “${o.excerpt.replace(/\s+/g, ' ').trim()}” `, h('span', { class: 'muted' }, `It ${o.why}.`), marks[i]))),
      note,
    );
    box.hidden = false;
    box.scrollIntoView({ block: 'nearest' });
    void fillVerdicts(projectId, scope, text, box, marks, note, found.map((o) => `${o.label}|${o.line}`).join('\n'));
  });
}

const VERDICT = { repeats: 'really repeats it', conflicts: 'conflicts with it', fine: 'only shares wording' };

/** Sonnet's verdicts into the open repeats list; a later check or a closed list drops them. */
async function fillVerdicts(projectId, scope, text, box, marks, note, places) {
  const run = (box.dataset.run = String(Number(box.dataset.run ?? 0) + 1));
  let r;
  try {
    r = await api(`api/projects/${projectId}/instructions/overlaps/verdicts`, { method: 'POST', body: { scope, text } });
  } catch (err) {
    r = { failed: err.message };
  }
  if (box.dataset.run !== run || box.hidden) return;
  // The server matched again; verdicts for a different list (the text changed under it) would land on the wrong rows.
  if (r.verdicts && (r.places ?? []).join('\n') !== places) r = { failed: 'the saved text changed while it ran; save again to check' };
  if (r.verdicts) {
    marks.forEach((m, i) => {
      const v = r.verdicts[i];
      m.className = `repeat-verdict${v && v.verdict !== 'fine' ? ' strong' : ' muted'}`;
      m.textContent = v ? `Sonnet: ${VERDICT[v.verdict]}${v.why ? `. ${v.why}` : '.'}` : 'Sonnet: no verdict.';
    });
    const vs = r.verdicts;
    note.textContent = vs.some((v) => v && v.verdict !== 'fine') ? 'Sonnet has read them: work in the ones it marks, or save anyway.' : vs.every((v) => v) ? 'Sonnet found no real repeat here: saving anyway is fine.' : 'Sonnet left some without a verdict, so read those yourself before saving anyway.';
    return;
  }
  for (const m of marks) m.remove();
  note.textContent = r.unlinked ? `No Sonnet check: ${r.unlinked}. Link it to have these read, or save anyway.` : `Sonnet's check didn't finish (${r.failed}), so the list above is the matcher's alone.`;
}

/** The Citadel-wide instructions as last loaded or broadcast, for the tab below. */
let appInstructions = null;

export function onAppInstructionsUpdate(instructions) {
  appInstructions = instructions;
  theirText('app-instructions-text', instructions.text);
  renderAppInstructionsHead();
}

function renderAppInstructionsHead() {
  const el = document.getElementById('app-instructions-head');
  if (!el) return;
  const a = appInstructions;
  el.replaceChildren(
    h('div', { class: 'row' }, ...settingsTitle(), h('span', { class: 'spacer' }), tuneUpButton(), h('a', { class: 'close-view', href: `#/p/${view.projectId}`, title: 'Back to the Taskmaster', 'aria-label': 'Close' }, icon('close'))),
    settingsTabs(),
    h('div', { class: 'meta' }, "Every scheme's minions and Taskmaster get these, before their scheme's own.", a?.by ? ` Last changed by ${a.by} ${ago(a.at)}.` : ''),
  );
}

/** A refused save's status: the server's words when someone saved first. */
const notSaved = (err) => (err?.status === 409 ? `Not saved: ${err.message}.` : 'Not saved.');

/** Main panel: edit the instructions every scheme shares. */
export function appInstructionsEditor() {
  const textarea = h('textarea', {
    id: 'app-instructions-text',
    'data-part': 'citadel-wide-instructions',
    class: 'instructions-text',
    spellcheck: 'false',
    disabled: true,
    placeholder: 'How people like to work in every scheme: tone, when to ask, how to hand work off…',
  });
  const counter = h('span', { class: 'muted counter' });
  const aids = instructionAids(textarea, MAX_INSTRUCTIONS);
  const status = h('span', { class: 'muted', role: 'status' }, 'Loading…');
  const save = h('button', { type: 'button', disabled: true }, 'Save');
  const discard = h('button', { type: 'button', class: 'secondary', disabled: true }, 'Discard');
  const saved = () => appInstructions?.text ?? '';
  // Nothing to save or discard until the GET has filled the field (it stays disabled if that fails).
  const draft = typedDraft(textarea, saved, () => !textarea.disabled && textarea.value.trim() !== saved().trim());
  const sync = () => {
    const dirty = draft.sync();
    const n = textarea.value.trim().length;
    counter.textContent = `${count(n)} / ${count(MAX_INSTRUCTIONS)}`;
    counter.classList.toggle('over', n > MAX_INSTRUCTIONS);
    aids.update();
    save.disabled = !dirty || n > MAX_INSTRUCTIONS;
    discard.disabled = !dirty;
  };
  textarea.addEventListener('input', () => {
    status.textContent = '';
    sync();
  });
  textarea.addEventListener('settings-refresh', sync);
  const [history, loadHistory] = recentChanges('api/app/instructions/history', (t) => {
    textarea.value = t;
    textarea.dispatchEvent(new Event('input'));
    textarea.focus();
  });
  const repeats = h('div', { class: 'instructions-repeats', role: 'alert', hidden: true });
  save.onclick = async () => {
    status.textContent = 'Checking for repeats…';
    save.disabled = true;
    const go = await checkRepeats('citadel', textarea.value, repeats, status);
    status.textContent = go ? '' : 'Not saved.';
    sync();
    if (go) saveNow();
  };
  // Saved at once; a refusal puts the last saved text back as the saved one, and the field keeps what was typed as a draft.
  const saveNow = () => {
    let was;
    const mine = { ...appInstructions, text: textarea.value, by: me, at: Date.now() };
    const sending = draft.begin();
    const show = (a, said) => {
      appInstructions = a;
      status.textContent = said;
      renderAppInstructionsHead();
      sync();
    };
    optimistic({
      sets: 'app-instructions',
      apply: () => {
        was = appInstructions;
        sending.sent();
        show(mine, `Saved. Every scheme picks this up on its next turn. ${instructionCost(mine.text)}`);
      },
      send: () => api('api/app/instructions', { method: 'PUT', body: { text: mine.text, was: sending.from } }).finally(sending.answered),
      undo: (err) => {
        sending.refused();
        show(appInstructions === mine ? was : appInstructions, notSaved(err)); // someone's update, or a later save, stays
        loadHistory();
        if (err?.status === 409) api('api/app/instructions').then(onAppInstructionsUpdate, () => {}); // as in saveProject
      },
      label: 'save the Citadel-wide instructions',
    }).then(
      (a) => {
        loadHistory(); // even when the broadcast of this save beat the answer and replaced `mine`
        if (appInstructions !== mine) return;
        if (textarea.value === mine.text) textarea.value = a.text; // as the server keeps it
        show(a, status.textContent);
      },
      () => {},
    );
  };
  discard.onclick = () => {
    textarea.value = saved();
    status.textContent = '';
    sync();
  };
  const section = h(
    'section',
    { class: 'artifacts-main instructions-main' },
    h('div', { class: 'ticket-head', id: 'app-instructions-head' }),
    settingsJump(['app-instructions-text', 'Instructions'], ['app-instructions-recent', 'Recent changes'], ['github-owner-section', 'GitHub owner']),
    settingsHelp('Rules for how people like to work in every scheme, read by each minion and Taskmaster from its next turn.', 'They come right before its scheme instructions, and a scheme instruction overrides one of these only where it names the rule it replaces.'),
    aids.el,
    textarea,
    h('div', { class: 'row instructions-actions' }, save, discard, status, h('span', { class: 'spacer' }), counter),
    repeats,
    h('div', { id: 'app-instructions-recent', class: 'settings-anchor' }, history),
    githubOwnerField(),
  );
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
      apply: () => {
        saved = mine;
        status.textContent = 'Saved.';
      },
      send: () => api('api/app/settings', { method: 'PUT', body: { github_owner: mine } }),
      undo: () => {
        if (saved === mine) {
          saved = was;
          status.textContent = 'Not saved.';
        }
      }, // unless a later save changed it again
      label: `make ${mine || 'the default'} the GitHub owner`,
    });
  };
  input.addEventListener('input', () => {
    status.textContent = '';
  });
  api('api/app/settings').then(show, (err) => {
    status.textContent = `Could not load it: ${err.message}`;
  });
  return h(
    'div',
    { class: 'github-owner settings-anchor', id: 'github-owner-section' },
    h('h3', { class: 'settings-label' }, 'GitHub owner for new schemes'),
    settingsHelp('A scheme started with a new repo gets a private GitHub repo under this account or organisation.', "Blank uses the owner of Citadel's own repo."),
    h('div', { class: 'row' }, input, save, status),
  );
}

/** Main panel: edit the project's instructions, or import them from Claude Code. */
export function instructionsEditor() {
  const p = view.project;
  const textarea = h('textarea', {
    id: 'instructions-text',
    'data-part': 'scheme-instructions',
    class: 'instructions-text settings-anchor',
    spellcheck: 'false',
    placeholder: 'What the scheme is for, where the work happens (branches, PR names), how a minion checks its work, what needs a go-ahead first…',
  });
  textarea.value = p.instructions ?? '';
  const counter = h('span', { class: 'muted counter' });
  const aids = instructionAids(textarea, MAX_INSTRUCTIONS);
  const status = h('span', { class: 'muted', role: 'status' });
  const save = h('button', { type: 'button' }, 'Save');
  const discard = h('button', { type: 'button', class: 'secondary' }, 'Discard');
  const now = () => (view.project?.id === p.id ? view.project : p); // a save can outlast the page
  const draft = typedDraft(textarea, () => now().instructions ?? '');
  const sync = () => {
    const dirty = draft.sync();
    const n = textarea.value.trim().length;
    counter.textContent = `${count(n)} / ${count(MAX_INSTRUCTIONS)}`;
    counter.classList.toggle('over', n > MAX_INSTRUCTIONS);
    aids.update();
    save.disabled = !dirty || n > MAX_INSTRUCTIONS;
    discard.disabled = !dirty;
  };
  textarea.addEventListener('input', () => {
    status.textContent = '';
    sync();
  });
  textarea.addEventListener('settings-refresh', sync);
  const repeats = h('div', { class: 'instructions-repeats', role: 'alert', hidden: true });
  save.onclick = async () => {
    status.textContent = 'Checking for repeats…';
    save.disabled = true;
    const go = await checkRepeats('scheme', textarea.value, repeats, status);
    status.textContent = go ? '' : 'Not saved.';
    sync();
    if (!go) return;
    const instructions = textarea.value;
    const sending = draft.begin();
    const shown = (saved, err) => {
      status.textContent = saved ? `Saved. Minions pick this up on their next turn. ${instructionCost(instructions)}` : notSaved(err);
      renderInstructionsHead();
      sync();
      if (!saved) loadHistory();
    };
    saveProject(p, { instructions, instructions_updated_by: me, instructions_updated_at: Date.now() }, { instructions, was: { instructions: sending.from } }, 'save the instructions', shown, sending).then(
      () => loadHistory(),
      () => {},
    );
  };
  discard.onclick = () => {
    textarea.value = now().instructions ?? '';
    status.textContent = '';
    sync();
  };

  /** Put imported text at the end of what's there (or in place of it), then let people review and save. */
  const insert = (parts, replace) => {
    const add = parts
      .map((x) => x.trim())
      .filter(Boolean)
      .join('\n\n');
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

  const [history, loadHistory] = recentChanges(`api/projects/${p.id}/instructions/history`, (t) => {
    textarea.value = t;
    textarea.dispatchEvent(new Event('input'));
    textarea.focus();
  });

  const section = h(
    'section',
    { class: 'artifacts-main instructions-main' },
    h('div', { class: 'ticket-head', id: 'instructions-head' }),
    settingsJump(['instructions-text', 'Instructions'], ['instructions-import', 'Import'], ['instructions-recent', 'Recent changes'], ['repo-setup', 'Repo setup']),
    h(
      'div',
      { class: 'instructions-tools', id: 'instructions-import' },
      importButton,
      h('button', { type: 'button', class: 'secondary', onclick: () => fileInput.click() }, 'Import a file…'),
      fileInput,
      h('span', { class: 'muted small' }, 'Or paste: from a Claude Code project at claude.ai/code, copy Project settings › Memory › Project instructions.'),
    ),
    picker,
    aids.el,
    textarea,
    h('div', { class: 'row instructions-actions' }, save, discard, status, h('span', { class: 'spacer' }), counter),
    repeats,
    h('div', { id: 'instructions-recent', class: 'settings-anchor' }, history),
    repoSetupCard(),
  );
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
    ...groups.map((g) =>
      h(
        'div',
        { class: 'sub' },
        h('h4', {}, g),
        sources
          .filter((s) => s.group === g)
          .map((s) => {
            const box = h('input', {
              type: 'checkbox',
              onchange: () => {
                box.checked ? picked.add(s.id) : picked.delete(s.id);
                update();
              },
            });
            return h(
              'details',
              { class: 'import-source' },
              h('summary', {}, h('label', {}, box, h('span', { class: 'name' }, s.label)), h('span', { class: 'meta' }, `${s.path} · ${count(s.content.length)} chars${s.truncated ? ' (cut short)' : ''}`), s.note ? h('span', { class: 'meta hint' }, s.note) : ''),
              h('pre', {}, s.content),
            );
          }),
      ),
    ),
    h('div', { class: 'row' }, add, replace, h('span', { class: 'muted small' }, 'Click a name to preview it.')),
  );
}
