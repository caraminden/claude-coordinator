// "Point at something" (#1141, Josh picked the takes on 2026-11-19): the page dims, the person clicks or taps the thing
// they mean, and the chat's message box gets a crop of it (pick-crop.js) and a chip naming the page, the part, the screen
// size and the theme, whose text goes with the message. Started by the 🎯 beside Attach (composer.js), the overview
// drawer's line on a phone (project.js) or Alt+Shift+P anywhere. From a page with no chat, it goes to the scheme's
// Taskmaster (Josh, Q2).
import { h, taskmasterName, threadHref, view } from './base.js';
import { toast } from './ui/status.js';
import { cropPart } from './pick-crop.js';
import { pointAt } from './composer.js';

// What a click snaps to: the nearest named part (#1122) or control, row or heading, not the bare text inside it.
const PICKABLE = '[data-part], button, a[href], input, select, textarea, summary, label, [role=button], [role=tab], [role=menuitem], [role=option], [role=row], li, tr, h1, h2, h3, h4, .msg, .thread-row';

let active = null;

export function startPick() {
  if (active) return;
  // Where it goes is settled now, so a pick on a page that changes underneath still lands in the chat it began from.
  const chatId = view?.main === 'chat' ? view.id : view?.coordinator?.id;
  if (!chatId) return toast('Open a scheme first: what you point at goes to one of its chats', { tone: 'warn' });
  const coordinator = chatId === view.coordinator?.id ? view.coordinator : null;
  const box = h('div', { class: 'pick-box', hidden: true });
  const hint = h('div', { class: 'pick-hint', role: 'status' },
    h('span', {}, matchMedia('(hover: hover)').matches ? 'Click the thing you mean' : 'Tap the thing you mean'),
    h('button', { type: 'button', class: 'secondary small', onclick: () => stop() }, 'Cancel'));
  // The dim catches every press, so nothing under it acts on the click that picks.
  const dim = h('div', { class: 'pick-dim' });
  document.body.append(dim, box, hint);
  let target = null;
  const under = (x, y) => {
    const el = document.elementsFromPoint(x, y).find((e) => e !== dim && e !== box && !hint.contains(e));
    return el && el !== document.documentElement && el !== document.body ? el.closest(PICKABLE) ?? el : null;
  };
  const show = (el) => {
    target = el;
    box.hidden = !el;
    if (!el) return;
    const r = el.getBoundingClientRect();
    for (const [k, v] of Object.entries({ left: r.left - 3, top: r.top - 3, width: r.width + 6, height: r.height + 6 })) box.style.setProperty(k, `${v}px`);
  };
  const onMove = (e) => {
    if (e.pointerType === 'mouse') {
      show(under(e.clientX, e.clientY));
      hint.firstChild.textContent = 'Click the thing you mean';
    }
    // Keep the hint off what the pointer is near: top unless the pointer's up there.
    hint.classList.toggle('low', e.clientY < 96);
  };
  const onUp = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = under(e.clientX, e.clientY);
    if (!el) return;
    show(el);
    // The dim stays a moment to take the click that follows a tap, so it can't reach what's under it.
    hint.remove();
    removeEventListener('keydown', onKey, true);
    setTimeout(stop, 300);
    deliver(el, chatId, coordinator);
  };
  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    stop();
  };
  const stop = () => {
    dim.remove();
    box.remove();
    hint.remove();
    removeEventListener('keydown', onKey, true);
    active = null;
  };
  dim.addEventListener('pointermove', onMove);
  dim.addEventListener('pointerup', onUp);
  // The press that picks mustn't focus or click what's under the dim either.
  dim.addEventListener('pointerdown', (e) => e.preventDefault());
  dim.addEventListener('click', (e) => e.preventDefault());
  addEventListener('keydown', onKey, true);
  active = { stop };
}

async function deliver(el, chatId, coordinator) {
  const crop = await cropPart(el);
  const note = describe(el);
  pointAt(chatId, crop, note);
  if (coordinator && !(view?.main === 'chat' && view.id === chatId)) location.hash = threadHref(coordinator);
}

/** The chip's short label and the text the message carries: page, part, screen size, theme. */
export function describe(el) {
  const part = el.dataset?.part;
  const within = el.parentElement?.closest('[data-part]')?.dataset.part;
  const name = shorten(el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || el.getAttribute('alt') || el.innerText || buttonValue(el) || '');
  const kind = kindOf(el);
  const size = `${innerWidth}×${innerHeight}`;
  const theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  const page = pageName();
  const what = name ? `${kind} "${name}"` : kind;
  const label = [name || part || kind, page, `${size} ${theme}`].join(' · ');
  const text = [
    `📍 Pointed at: ${what}${part ? ` (part ${part})` : ''}${within ? `, inside part ${within}` : ''}`,
    `On: ${page} (${location.hash || '#/'}) · window ${size} · ${theme} theme`,
  ].join('\n');
  return { label, text };
}

// A field's typed value never goes in the message (it could be a password or a token, and sent past looksSecret): only
// a button input's value, which is its label.
const buttonValue = (el) => (el instanceof HTMLInputElement && /^(button|submit|reset)$/.test(el.type) ? el.value : '');

const shorten = (t) => {
  const s = String(t).replace(/\s+/g, ' ').trim();
  return s.length > 60 ? `${s.slice(0, 59)}…` : s;
};

function kindOf(el) {
  const role = el.getAttribute('role');
  if (role) return role;
  const tag = el.tagName.toLowerCase();
  return { a: 'link', button: 'button', input: 'field', textarea: 'text box', select: 'dropdown', summary: 'section toggle', li: 'list item', tr: 'table row', label: 'label' }[tag]
    ?? (/^h\d$/.test(tag) ? 'heading' : el.classList.contains('thread-row') ? 'minion row' : el.classList.contains('msg') ? 'message' : tag);
}

function pageName() {
  if (!view) return 'Citadel';
  if (view.main === 'chat') return view.id === view.coordinator?.id ? `${taskmasterName()}'s chat` : `#${view.ticket?.number ?? view.id}'s chat`;
  const main = typeof view.main === 'string' ? view.main : view.kind;
  if (main === 'ci') return 'CI page';
  return `${String(main ?? 'Citadel').replace(/[-_]/g, ' ').replace(/^\w/, (c) => c.toUpperCase())} page`;
}

// Alt+Shift+P anywhere starts it on a desktop; the drawer line and the 🎯 do on a phone.
addEventListener('keydown', (e) => {
  if (e.code === 'KeyP' && e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.repeat) {
    e.preventDefault();
    startPick();
  }
});
