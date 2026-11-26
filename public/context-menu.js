// Citadel's own right-click menu on its pages (#1663; Cara picked take B on #1661, 2026-11-22: "B · Citadel's own menu").
// Right-click (or Shift+F10 / the Menu key) on a minion row, a message, a card, a file, a code block, a release, a link
// or empty space: a menu headed by what it is, "Point at this" and "Point and draw…" first (they took the 🎯 button's
// place on a mouse), then that thing's own actions. Every action is one a button already does. Text boxes and
// Shift+right-click keep the browser's menu. The menu itself is Citadel UI's (ui/menu.js), which apps get too.
import { dismissedWhen, jumpHref, taskmasterName, threadHref, view } from './base.js';
import { stopChat } from './core.js';
import { renderSidebar } from './sidebar.js';
import { jobOf } from './threadstate.js';
import { renderTicketHead, setStatus, unpark } from './thread-head.js';
import { PICKABLE, describe, pageName, pointAtElement } from './pick.js';
import { readSelection, selectionActions } from './selectact.js';
import { mountMenus } from './ui/menu.js';
import { heldSaid, toggleStartNow, toggleUrgent } from './worker-line.js';
import { copyText } from './ui/markdown.js';
import { toast } from './ui/status.js';

/** @import { Ticket } from './types.js' */
/** @import { MenuItem, MenuSpec } from './ui/menu.js' */
// Each kind's chip colour, from the spec's table ("What each thing offers").
/** @type {Record<string, Pick<MenuSpec, 'kind' | 'hue' | 'tone'>>} */
const KIND = {
  minion: { kind: 'Minion', hue: 'var(--running)' },
  message: { kind: 'Message', hue: 'var(--cat-1)' },
  selection: { kind: 'Selected text', hue: 'var(--cat-1)' },
  link: { kind: 'Link', hue: 'var(--cat-6)' },
  code: { kind: 'Code block', hue: 'var(--cat-5)' },
  file: { kind: 'File', hue: 'var(--cat-2)' },
  card: { kind: 'Card', hue: 'var(--waiting)' },
  release: { kind: 'Release', hue: 'var(--done)' },
  part: { kind: 'Part', tone: 'neutral' },
  page: { kind: 'Page', tone: 'neutral' },
};
// The desktop app (Electron) has no menu of its own to fall back to, and sends a Citadel link opened "in a new tab"
// back into its one window (desktop/main.cjs), so there it shows no foot and no new tab for Citadel's own links.
// A touch screen has no Shift+right-click either.
/** The desktop app's bridge (desktop/main.cjs); absent in a browser. */
const desktopBridge = /** @type {{ citadelDesktop?: { inspect?: (x: number, y: number) => void } }} */ (/** @type {unknown} */ (window)).citadelDesktop;
const desktop = !!desktopBridge;
const FOOT = desktop || matchMedia('(pointer: coarse)').matches ? undefined : "Shift+right-click: the browser's own menu";

/**
 * @param {unknown} t
 * @param {number} [n]
 */
const shorten = (t, n = 60) => {
  const s = String(t ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};
/** @param {string} href */
const abs = (href) => new URL(href, location.href).href;
/**
 * @param {string} text
 * @param {string} what
 */
const copy = (text, what) => copyText(text).then((ok) => toast(ok ? `${what} copied` : `Could not copy the ${what.toLowerCase()}`));
// While the live stream is down (core.js's Reconnecting… chip), what needs the server is greyed with the reason.
const offline = () => !!document.querySelector('body > .cui-chip.reconnecting');
/** @param {MenuItem} item */
const needsServer = (item) => (offline() ? { ...item, disabled: true, reason: 'reconnecting…' } : item);
/** @param {string} href */
const newTab = (href) => (desktop && new URL(href, location.href).origin === location.origin ? null : { label: desktop ? 'Open in browser' : 'Open in a new tab', icon: '↗', run: () => window.open(href, '_blank', 'noopener') });

/**
 * @param {Element} el
 * @param {string} [label]
 * @returns {(MenuItem | '-')[]}
 */
const pointItems = (el, label = 'Point at this') => [{ label, icon: '📍', keys: 'Alt+Shift+P', point: true, run: () => pointAtElement(el) }, { label: 'Point and draw…', icon: '✎', point: true, run: () => pointAtElement(el, { draw: true }) }, '-'];

/**
 * The menu for what was right-clicked, as ui/menu.js's spec; null leaves the browser's own.
 * @param {Element} target
 * @returns {MenuSpec | null}
 */
export function menuFor(target) {
  if (target.closest('.cui-lb, .pick-dim, .pick-hint')) return null;
  const chat = target.closest('.chat');
  const form = /** @type {HTMLFormElement | null | undefined} */ (chat?.querySelector('form.composer'));
  const msg = target.closest('.msg');

  // Selected text in a message: the select bar's own actions (#1133), then Copy. Nothing to point at.
  const sel = getSelection();
  if (sel && !sel.isCollapsed && sel.containsNode(target, true) && chat) {
    const s = readSelection(chat.querySelector('.log') ?? chat);
    if (s) {
      return { ...KIND.selection, name: `“${shorten(s.text, 40)}”`, foot: FOOT, items: [...(form ? selectionActions(s, form).map(({ label, icon, run }) => ({ label, icon, run })) : []), { label: 'Copy', icon: '⧉', keys: 'Ctrl+C', run: () => copy(s.text, 'Text') }] };
    }
  }

  const file = /** @type {HTMLAnchorElement | null} */ (target.closest('a.file-card, a.file-preview, a.file-chip[href]'));
  if (file) return fileMenu(file);
  const row = /** @type {HTMLAnchorElement | null} */ (target.closest('a.thread-row[data-id]'));
  if (row) {
    const id = Number(row.dataset.id);
    const t = view?.tickets?.get(id) ?? (view?.coordinator?.id === id ? view.coordinator : null);
    if (t) return minionMenu(row, t);
  }
  const release = releaseOf(target);
  if (release) return releaseMenu(release.ver, release.row);
  const link = /** @type {HTMLAnchorElement | null} */ (target.closest('a[href]'));
  if (link) return linkMenu(link);
  const pre = target.closest('pre');
  if (pre && msg) return codeMenu(pre, msg, form);
  const card = /** @type {HTMLElement | null} */ (target.closest('.qcard'));
  if (card) return cardMenu(card);
  if (msg?.matches('.msg.reply[data-reply-event], .msg.user[data-event]')) return messageMenu(msg, form);

  const page = { label: 'Copy page link', icon: '🔗', run: () => copy(location.href, 'Page link') };
  const reload = { label: 'Reload', icon: '↻', keys: 'Ctrl+R', run: () => location.reload() };
  const part = target.closest(PICKABLE);
  if (part && part !== document.body) {
    return { ...KIND.part, name: describe(part).label.split(' · ')[0], foot: FOOT, items: [...pointItems(part), page, reload] };
  }
  return { ...KIND.page, name: pageName(), foot: FOOT, items: [...pointItems(document.getElementById('app') ?? document.body, 'Point at this page'), page, reload] };
}

/**
 * @param {HTMLAnchorElement} row
 * @param {Ticket} t
 * @returns {MenuSpec}
 */
function minionMenu(row, t) {
  const coord = t.id === view?.coordinator?.id;
  const ref = coord ? taskmasterName() : `#${t.number ?? t.id}`;
  const redraw = () => {
    renderSidebar();
    if (view?.id === t.id) renderTicketHead();
  };
  /** @type {MenuItem | undefined} */
  let state;
  if (t.status === 'running' || t.limit_resume_at || t.approvals || jobOf(t)) state = needsServer({ label: t.status === 'running' || t.limit_resume_at || t.approvals ? 'Stop turn' : 'Stop its job', icon: '■', run: () => stopChat(t, redraw) });
  else if (t.status === 'closed') state = { label: `Dismissed ${dismissedWhen(t.closed_at)?.short ?? ''}`.trim(), icon: '✕', disabled: true };
  else if (t.state === 'parked' || t.parked_for) state = needsServer({ label: 'Unseal', icon: '⏵', run: () => unpark(t) });
  // The head's Dismiss, behind a question here: a right-click is easier to slip on (the spec: "Asks first").
  else if (!coord)
    state = needsServer({
      label: 'Dismiss minion',
      icon: '✕',
      danger: true,
      run: () => {
        if (!confirm(`Dismiss ${ref}${t.title ? ` (${t.title})` : ''}?`)) return;
        setStatus(t, 'closed');
        if (view?.id === t.id) location.hash = `#/p/${t.project_id}`;
      },
    });
  return {
    ...KIND.minion,
    name: coord ? ref : `${ref} ${t.title ?? ''}`.trim(),
    foot: FOOT,
    items: [
      ...pointItems(row),
      { label: `Open ${ref}`, icon: '→', keys: 'Enter', run: () => row.click() },
      newTab(row.href),
      { label: 'Copy link', icon: '🔗', run: () => copy(abs(threadHref(t)), 'Link') },
      !coord && { label: `Copy “${ref}”`, icon: '#', run: () => copy(ref, ref) },
      !coord && t.status !== 'closed' && needsServer({ label: t.urgent ? `Take off Urgent (set by ${t.urgent.by})` : 'Mark Urgent', icon: '!', run: () => toggleUrgent(t) }),
      !coord && t.status !== 'closed' && (t.start_now || t.worker_wait) && needsServer({ ...(t.start_now ? { label: 'Release', icon: '⏏', keys: heldSaid(t.start_now).replace('since ', '') } : { label: 'Start now', icon: '▶' }), run: () => toggleStartNow(t) }),
      state && '-',
      state,
    ],
  };
}

/**
 * @param {Element} msg
 * @param {HTMLFormElement | null | undefined} form
 * @returns {MenuSpec}
 */
function messageMenu(msg, form) {
  const text = [...msg.children]
    .filter((c) => !c.classList.contains('who'))
    .map((c) => /** @type {HTMLElement} */ (c).innerText)
    .join('\n')
    .trim();
  // The select bar's list (#1133) for the whole message, so Reply, Ask on the side and Copy link have one home.
  const acts = form ? Object.fromEntries(selectionActions({ text, first: msg, single: true }, form).map((a) => [a.id, a])) : {};
  return {
    ...KIND.message,
    name: shorten(text, 50),
    foot: FOOT,
    items: [
      ...pointItems(msg),
      acts.reply && { label: 'Reply with a quote', icon: '❝', run: acts.reply.run },
      acts.aside && { label: 'Ask on the side', icon: '💬', run: acts.aside.run },
      { label: 'Copy text', icon: '⧉', run: () => copy(text, 'Text') },
      acts.link && { label: 'Copy link to message', icon: '🔗', run: acts.link.run },
    ],
  };
}

/**
 * @param {Element} pre
 * @param {Element} msg
 * @param {HTMLFormElement | null | undefined} form
 * @returns {MenuSpec}
 */
function codeMenu(pre, msg, form) {
  const code = (pre.querySelector('code') ?? pre).textContent.replace(/\n$/, '');
  const reply = form && selectionActions({ text: `\`\`\`\n${code}\n\`\`\``, first: msg, single: true }, form).find((a) => a.id === 'reply');
  const button = pre.querySelector('.cui-copy');
  return {
    ...KIND.code,
    name: shorten(code.split('\n')[0], 50),
    foot: FOOT,
    items: [
      ...pointItems(pre),
      // The block's own Copy button, so a shell block copies as it does there (copyPayload).
      { label: 'Copy code', icon: '⧉', run: () => (button ? /** @type {HTMLElement} */ (button).click() : copy(code, 'Code')) },
      reply && { label: 'Reply about this code', icon: '❝', run: reply.run },
    ],
  };
}

/**
 * @param {HTMLAnchorElement} a
 * @returns {MenuSpec}
 */
function fileMenu(a) {
  const path = a.dataset.file;
  const m = /^#\/f\/(\d+)\//.exec(a.getAttribute('href') ?? '');
  const download = a.hasAttribute('download') ? a.href : m && path ? abs(`api/tickets/${m[1]}/file?path=${encodeURIComponent(path)}&download`) : null;
  return {
    ...KIND.file,
    name: a.querySelector('.name, .caption')?.textContent || path || a.textContent,
    foot: FOOT,
    items: [
      ...pointItems(a),
      { label: 'Open', icon: '→', keys: 'Enter', run: () => a.click() },
      newTab(a.href),
      // `download` can be '' (falsy, skipped like false by the menu)
      /** @type {MenuItem | false} */ (download && { label: 'Download', icon: '⤓', run: () => Object.assign(document.createElement('a'), { href: download, download: '' }).click() }),
      { label: 'Copy link', icon: '🔗', run: () => copy(a.href, 'Link') },
    ],
  };
}

/**
 * @param {HTMLElement} card
 * @returns {MenuSpec}
 */
function cardMenu(card) {
  const ticket = view?.ticket ?? view?.coordinator;
  const id = card.dataset.cardEvent;
  const linkItem = (id && ticket && { label: 'Copy link to card', icon: '🔗', run: () => copy(abs(jumpHref(ticket, id)), 'Link') }) || null; // the menu drops any falsy item, so '' and null are the same
  const title = /** @type {HTMLElement | null} */ (card.querySelector('.qtitle, .q'))?.innerText.split('\n')[0];
  /** @type {MenuItem[]} */
  let answers = [];
  if (card.classList.contains('answered')) {
    const picked = [.../** @type {NodeListOf<HTMLElement>} */ (card.querySelectorAll('.opt.picked'))].map((b) => b.dataset.label).filter(Boolean);
    const said = [...card.querySelectorAll('.muted')].map((e) => e.textContent).find((x) => /^(Answered|Dismissed|Saved) by |^Settled/.test(x));
    const who = said?.match(/^Answered by (.+)/)?.[1];
    answers = [{ label: picked.length ? `Answered: ${picked.join(', ')}${who ? ` · ${who}` : ''}` : (said ?? 'Answered'), icon: '✓', disabled: true }];
  } else if (card.matches('[data-single]')) {
    // One pick-one question: pick the option, then the card's own Send.
    answers = [.../** @type {NodeListOf<HTMLElement>} */ (card.querySelectorAll('[data-q="0"] .opt[data-label]:not(.pic)'))].map((opt, i) =>
      needsServer({
        label: `Answer: ${opt.dataset.label}`,
        icon: i ? '○' : '✓',
        run: () => {
          if (!opt.classList.contains('picked')) opt.click();
          /** @type {HTMLElement | null} */ (card.querySelector('.qsend'))?.click();
        },
      }),
    );
  }
  return { ...KIND.card, name: shorten(title, 50), foot: FOOT, items: [...pointItems(card), ...answers, linkItem] };
}

/**
 * A release's number (releases.js's versionLink) and the row it sits in, when the click is on either.
 * @param {Element} target
 */
function releaseOf(target) {
  const own = target.closest('[data-version]');
  const row = own?.closest('.rel-row, .rel-current, .rel-card-sm, .rel-grid-row') ?? target.closest('.rel-row, .rel-current, .rel-card-sm.live, .rel-grid-row');
  const ver = own ?? row?.querySelector('[data-version]');
  return ver ? { ver: /** @type {HTMLAnchorElement} */ (ver), row: row ?? ver } : null;
}

/**
 * @param {HTMLAnchorElement} ver
 * @param {Element} row
 * @returns {MenuSpec}
 */
function releaseMenu(ver, row) {
  const name = /** @type {string} */ (ver.dataset.version);
  const dl = /** @type {HTMLAnchorElement | null} */ (row.querySelector('a[download]'));
  return {
    ...KIND.release,
    name: [row.querySelector('.rel-name')?.textContent, name].filter(Boolean).join(' '),
    foot: FOOT,
    items: [
      ...pointItems(row),
      { label: `Copy version ${name}`, icon: '⧉', run: () => copy(name, name) },
      /** @type {MenuItem | false} */ (ver.href && { label: 'Open release', icon: '→', run: () => window.open(ver.href, '_blank', 'noopener') }),
      dl && { label: 'Copy download link', icon: '⤓', run: () => copy(dl.href, 'Download link') },
    ],
  };
}

/**
 * @param {HTMLAnchorElement} a
 * @returns {MenuSpec}
 */
function linkMenu(a) {
  return { ...KIND.link, name: shorten(a.textContent) || a.href, foot: FOOT, items: [...pointItems(a), { label: 'Open', icon: '→', run: () => a.click() }, newTab(a.href), { label: 'Copy link address', icon: '🔗', run: () => copy(a.href, 'Link') }] };
}

/**
 * In the desktop app every menu ends with Inspect (#1665): DevTools on what was right-clicked, or the focused thing's middle from the keyboard.
 * @param {MenuSpec | null} spec
 * @param {Element} target
 * @param {MouseEvent | null} e
 * @returns {MenuSpec | null}
 */
function withInspect(spec, target, e) {
  if (!spec) return null;
  const r = target.getBoundingClientRect();
  const [x, y] = e?.clientX || e?.clientY ? [e.clientX, e.clientY] : [r.left + r.width / 2, r.top + r.height / 2];
  return { ...spec, items: [...spec.items, '-', { label: 'Inspect', icon: '⌕', keys: 'Ctrl+Shift+I', run: () => /** @type {NonNullable<typeof desktopBridge>} */ (desktopBridge).inspect?.(x, y) }] };
}

// A phone's long press (#1664) opens the sheet on the things Cara listed (rows, cards, files, code blocks, releases,
// links), not on message text, which keeps the phone's own selection, or on bare page and part menus.
const LONG_PRESS = new Set(['Minion', 'Card', 'File', 'Code block', 'Release', 'Link']);
mountMenus({
  menuFor: desktop ? (target, e) => withInspect(menuFor(target), target, /** @type {MouseEvent | null} */ (e)) : menuFor,
  longPress: (t, spec) => LONG_PRESS.has(/** @type {string} */ (spec.kind)) && !t.closest('[data-reorder]'),
});
