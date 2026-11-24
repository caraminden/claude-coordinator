// Select text in a message to act on it (#1133): Reply to this (a quote in the chat box), Ask on the side (/btw with the
// quote) and Copy link (to that exact message). A plain click does nothing new; the menu is fixed, so it never moves the chat.
// The right-click menu offers the same list (selectionActions, #1663).
import { h, jumpHref, view } from './base.js';
import { toast } from './ui/status.js';

const MESSAGE = '.msg.reply[data-reply-event], .msg.user[data-event]';
const idOf = (el) => Number(el.dataset.replyEvent ?? el.dataset.event);

/** A selection as a markdown quote: every line behind "> ", then a blank line to type below it. Pure, for tests. */
export function quoteOf(text) {
  const lines = text
    .trim()
    .split(/\r?\n/)
    .map((l) => `> ${l}`.trimEnd());
  return `${lines.join('\n')}\n\n`;
}

/** The message a node sits in, or null (cards, notes, the composer and the menu itself are not messages). */
const messageOf = (node) => (node?.nodeType === 3 ? node.parentElement : node)?.closest?.(MESSAGE) ?? null;

/** What is selected inside the log: { text, first, last, rect } or null. */
export function readSelection(log) {
  const sel = getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const text = sel.toString();
  if (!text.trim()) return null;
  const range = sel.getRangeAt(0);
  if (!log.contains(range.commonAncestorContainer)) return null;
  const first = messageOf(sel.anchorNode) ?? messageOf(range.startContainer);
  const last = messageOf(sel.focusNode) ?? messageOf(range.endContainer);
  if (!first || !last) return null;
  const rects = range.getClientRects();
  const rect = rects.length ? rects[0] : range.getBoundingClientRect();
  return { text, first, last, rect, single: first === last };
}

/**
 * What can be done with a selection `s` (readSelection's) in a chat whose composer is `form`: one list that the select
 * bar and the right-click menu (context-menu.js, #1663) both draw, so neither has its own copy. Each is
 * { id, label, short (the bar's word), title, icon, run }.
 */
export function selectionActions(s, form) {
  const textarea = form.querySelector('textarea');
  const done = () => getSelection()?.removeAllRanges();
  const put = (value) => {
    textarea.value = value;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    done();
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  };
  const id = idOf(s.first);
  return [
    {
      id: 'reply',
      label: 'Reply to this',
      short: 'Reply',
      title: 'Quote this in the chat box',
      icon: '❝',
      run: () => {
        const q = quoteOf(s.text);
        put(textarea.value.trim() ? `${textarea.value.replace(/\s+$/, '')}\n\n${q}` : q);
      },
    },
    // Aside is the composer's own (minions only); a selection across two messages offers only Reply.
    s.single && form.querySelector('.side-ask') && { id: 'aside', label: 'Ask on the side', title: 'Start a side question with this quote', icon: '💬', run: () => put(`/btw ${quoteOf(s.text)}`) },
    s.single &&
      id && {
        id: 'link',
        label: 'Copy link',
        title: 'Copy a link to this message',
        icon: '🔗',
        run: () => {
          const url = new URL(jumpHref(view.ticket, id), location.href).href;
          navigator.clipboard?.writeText(url).then(
            () => toast('Link to this message copied'),
            () => toast('Could not copy the link'),
          );
          done();
        },
      },
  ].filter(Boolean);
}

export function selectActions(log, form) {
  const menu = h('div', { class: 'select-menu', role: 'toolbar', 'aria-label': 'Actions for the selected text', hidden: true });
  document.body.append(menu);
  let current = null;
  // The menu must not take the selection away when it is pressed.
  menu.addEventListener('mousedown', (e) => e.preventDefault());
  menu.addEventListener('pointerdown', (e) => e.preventDefault());
  const hide = () => {
    menu.hidden = true;
    current = null;
  };
  const show = () => {
    const s = readSelection(log);
    if (!s) return hide();
    current = s;
    menu.replaceChildren(
      ...selectionActions(s, form).map((a) =>
        h(
          'button',
          {
            type: 'button',
            class: 'small secondary',
            title: a.title,
            onclick: () => {
              a.run();
              hide();
            },
          },
          a.short ?? a.label,
        ),
      ),
    );
    menu.hidden = false;
    const narrow = matchMedia('(max-width: 800px)').matches;
    menu.classList.toggle('bar', narrow);
    if (narrow) {
      // the phone's own copy menu sits by the selection: ours is a slim bar just above the chat box
      menu.style.left = '0';
      menu.style.right = '0';
      menu.style.top = 'auto';
      menu.style.bottom = `${Math.max(0, innerHeight - form.getBoundingClientRect().top)}px`;
    } else {
      const w = menu.offsetWidth;
      menu.style.bottom = 'auto';
      menu.style.right = 'auto';
      menu.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, s.rect.left))}px`;
      const above = s.rect.top - menu.offsetHeight - 6;
      menu.style.top = `${above >= 8 ? above : s.rect.bottom + 6}px`;
    }
  };
  let timer = 0;
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(show, 120);
  };
  const onSel = () => (getSelection()?.isCollapsed ? hide() : later());
  document.addEventListener('selectionchange', onSel);
  // The menu goes with the chat's scroll or a resize rather than drifting off the selection.
  log.closest('.chat')?.addEventListener('scroll', () => current && later(), true);
  addEventListener('resize', hide);
  // Gone with the chat: a new chat mounts its own.
  const watch = new MutationObserver(() => {
    if (!form.isConnected) {
      document.removeEventListener('selectionchange', onSel);
      removeEventListener('resize', hide);
      menu.remove();
      watch.disconnect();
    }
  });
  watch.observe(document.body, { childList: true, subtree: true });
}
