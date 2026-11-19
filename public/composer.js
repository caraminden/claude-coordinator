// The message box under a chat, on Citadel UI's composer (public/ui/composer.js: autogrow, Enter rules,
// IME guard, list continuation, the text back on a failed send, the text draft). Citadel's own around it:
// pasted and dropped files with their drafts, the model and effort pickers, and steer or queue mid-turn.
import { account, api, formatSize, h, noAutofill, isCoordinator, me, uploadUrl, view } from './base.js';
import { codex, reloadWhenIdle, scrollToBottom, sending, setSending } from './core.js';
import { adoptTicket, renderTyping } from './thread.js';
import { base64Url, blobBase64, userBubble } from './bubbles.js';
import { mountComposer } from './ui/composer.js';
import { openDialog } from './ui/dialog.js';
import { lightbox } from './ui/media.js';
import { annotator } from './annotate.js';
import { optimistic } from './ui/optimistic.js';
import { pastedFiles } from './paste.js';
import { sideColdCost } from './payer.js';
import { looksSecret } from './secret-check.js';
import { chatCommandList, matchCommands, menuQuery, parseCommand } from './slash-commands.js';
import { CLAUDE_MODELS, EFFORT_LEVELS } from './model-table.js';

// ---------- drafts ----------

// Unsent text survives reloads and switching threads: it is saved per thread as you type.
// Text goes to localStorage; images are too big for it, so they go to IndexedDB, with the names of
// files already uploaded.
export function loadDraft(key) {
  try { return JSON.parse(localStorage.getItem(key)) ?? null; } catch { return null; }
}

export function saveDraft(key, value) {
  try {
    if (value) localStorage.setItem(key, JSON.stringify(value));
    else localStorage.removeItem(key);
  } catch {}
}

// Shared with every app (public/ui/composer.js).
export { fitHeight } from './ui/composer.js';

let draftDb = null;
function draftStore(mode, fn) {
  draftDb ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('cc-drafts', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('images');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return draftDb.then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction('images', mode);
    const req = fn(tx.objectStore('images'));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error);
  }));
}

const loadDraftImages = (ticketId) => draftStore('readonly', (s) => s.get(ticketId)).then((v) => v ?? [], () => []);
const saveDraftImages = (ticketId, items) =>
  draftStore('readwrite', (s) => (items.length ? s.put(items, ticketId) : s.delete(ticketId))).catch(() => {});

/** The message box's hint; a dismissed minion's says a message brings it back. */
export function composerPlaceholder(ticket) {
  const keys = matchMedia('(max-width: 800px)').matches ? '' : ' (Enter to send, Shift+Enter for a new line)';
  const ask = isCoordinator(ticket) ? 'Ask the Taskmaster to start, check on, or dismiss minions…'
    : ticket.status === 'closed' ? 'Dismissed: send a message to reopen…' : 'Message this minion…';
  return ask + keys;
}

// ---------- messages on their way ----------

// Each chat's messages on their way or not sent, oldest first, as { el, text, sendId, saved, state, retry }.
// The chat shows them below its history (thread.js chatView), so they outlive redraws and switching chats.
const outboxes = new Map();
export function outbox(chatId) {
  let box = outboxes.get(chatId);
  if (!box) outboxes.set(chatId, (box = []));
  return box;
}
const onTheWay = new Map(); // chatId → sends started and not yet answered, for "This Minion is thinking…"
const chatOpen = (chatId) => view?.kind === 'project' && view.id === chatId;

// Ctrl+V with no field focused pastes into the open chat's box (#654). A field keeps its own paste (Find in
// chat, a note, a card's box, a rename), and so does a dialog the chat isn't in.
document.addEventListener('paste', (e) => {
  const form = document.querySelector('form.composer');
  const el = e.target instanceof Element ? e.target : null;
  if (e.defaultPrevented || !form?.pasteAnywhere || !form.checkVisibility()) return;
  if (el?.closest('input, textarea, select') || el?.isContentEditable) return;
  // Any open modal without the chat (the image viewer over the file viewer that holds it, say) keeps the paste.
  if ([...document.querySelectorAll('dialog[open]')].some((d) => d.matches(':modal') && !d.contains(form))) return;
  form.pasteAnywhere(e);
});

/** Mark a message that didn't reach the server: "not sent", with Retry and a ✎ to take it back into the box. */
function notSent(chatId, entry) {
  entry.state = 'failed';
  const { el } = entry;
  el.classList.replace('pending', 'not-sent');
  el.querySelector('.who')?.append(h('span', { class: 'msg-tag unsent-tag' }, 'not sent',
    h('button', { type: 'button', class: 'take-back', title: 'Send it again', 'aria-label': 'Send it again', onclick: () => entry.retry() }, '↻'),
    h('button', { type: 'button', class: 'take-back', title: 'Take back to edit', 'aria-label': 'Take back to edit', onclick: () => {
      if (entry.state !== 'failed') return;
      entry.state = 'taken back';
      setSending(sending - 1);
      el.remove();
      for (const url of entry.urls ?? []) URL.revokeObjectURL(url);
      const box = outbox(chatId);
      if (box.includes(entry)) box.splice(box.indexOf(entry), 1);
      const form = chatOpen(chatId) && document.querySelector('.composer');
      if (form?.editBack) return form.editBack(entry.text, entry.saved);
      // Moved to another chat meanwhile: the text waits in this chat's draft, the attachments in its box.
      const draft = loadDraft(`cc-draft:${chatId}`)?.trim();
      saveDraft(`cc-draft:${chatId}`, draft ? `${entry.text}\n${draft}` : entry.text);
      chatAttachments(chatId).restore(entry.saved);
    } }, '✎')));
}

/** The message box under a chat: text, pasted images, model and effort, and Send. */
export function composer(chatId, ticket) {
  const attachments = chatAttachments(chatId);
  // Mid-turn, Send steers the running turn; the ▾ (shown only then, style.css) offers queueing instead.
  // The menu sets `after` around its submit, which calls send() at once (ui/composer.js), so it reads it there.
  let after = false;
  // Set by the secret warning's Send anyway, for the one submit it makes (#838).
  let sendAnyway = false;
  let unparkWith = false;
  const minion = !isCoordinator(ticket);
  // Ask on the side (#932): a read-only copy of the minion's session answers in a side thread, even mid-turn, on your
  // own login. A cold copy (idle past the cache, or last run on another plan) says what it costs first.
  let sideOk = false;
  const sideStrip = h('div', { class: 'payer-line cold side-cold', hidden: true });
  const askSide = (text) => {
    const t = view?.ticket?.id === chatId ? view.ticket : ticket;
    const cold = !sideOk && sideColdCost(t);
    sideOk = false;
    if (cold) {
      sideStrip.replaceChildren(
        h('span', {}, `${cold.idle ? 'Cold' : 'Last ran on another plan'}: a side question re-reads its ${cold.k}k context on your login, about ${cold.cost}. `),
        h('span', { class: 'row' },
          h('button', { type: 'button', class: 'small side-go', onclick: () => { sideOk = true; askSide(text); } }, 'Ask anyway'),
          h('button', { type: 'button', class: 'small secondary', onclick: () => { sideStrip.hidden = true; textarea.focus(); } }, 'Cancel')));
      sideStrip.hidden = false;
      return;
    }
    sideStrip.hidden = true;
    box.value = '';
    api(`api/tickets/${chatId}/side`, { method: 'POST', body: { text } }).catch((ex) => {
      if (!box.value.trim()) box.value = text;
      alertNote(`Side question not asked: ${ex.message}`);
    });
  };
  const sideBtn = minion && h('button', { type: 'button', class: 'secondary side-ask', title: 'Ask on the side: a read-only copy of this minion answers, and nothing reaches its session (or start a message with /btw)',
    onclick: () => {
      const text = box.value.trim().replace(/^\/btw\s+/, '');
      if (text) return askSide(text);
      textarea.placeholder = 'Type a side question, then press Aside…';
      textarea.focus();
    } }, 'Aside');
  const box = mountComposer(document.createDocumentFragment(), {
    placeholder: composerPlaceholder(ticket),
    draftKey: `cc-draft:${chatId}`,
    canSend: (text) => {
      if (attachments.busy) return alertNote('Still preparing an image; try again in a moment.'), false;
      if (attachments.uploading) return alertNote('Still uploading a file; send once it shows its size.'), false;
      // Slash commands (#937): Citadel's own run here; one the chat's turns load goes as text; any other is refused.
      const cmd = parseCommand(text);
      // `/btw <question>` asks on the side (#932), as the button does; it never goes to the minion.
      if (cmd && minion && cmd.name === 'btw') {
        if (!cmd.rest) return alertNote('Type your question after /btw.'), false;
        if (attachments.items.length) return alertNote('A side question takes text only: remove the attachments, or send it as a message.'), false;
        return askSide(cmd.rest), false;
      }
      if (cmd?.name === 'help') return (box.value = ''), slash.open(true), false;
      if (cmd?.name === 'fresh') {
        if (cmd.rest) return alertNote('/fresh takes nothing after it: send the rest as its own message once the fresh session starts.'), false;
        return startFresh(), false;
      }
      if (cmd && commands.loaded && !commands.names.has(cmd.name)) {
        return alertNote(`/${cmd.name} isn't a command here: type / to see the list, or start with // to send it anyway, both slashes included.`), false;
      }
      const found = !sendAnyway && looksSecret(text);
      sendAnyway = false;
      if (found) return askToSaveSecret(ticket, found, {
        saved: (name) => {
          box.value = box.value.split(found).join(`$${SECRET_ENV}${name}`);
          textarea.focus();
        },
        sendAnyway: () => { sendAnyway = true; form.requestSubmit(); },
      }), false;
      return !!text || attachments.items.length > 0;
    },
    // Returns at once, so Send never waits (#392): a failed message stays in the chat with Retry and Edit, not back in the box.
    send: (text) => {
      const sent = attachments.items.slice();
      attachments.remove(sent);
      send(text, sent, after, unparkWith);
    },
    onError: (ex) => alertNote(ex.message),
  });
  const { form, textarea, row, sendButton: sendBtn } = box;
  // The chat's commands, loaded once per composer; until they come (or if they don't), nothing is refused.
  const commands = { loaded: false, names: new Set(), list: chatCommandList([], minion) };
  api(`api/tickets/${chatId}/commands`).then((r) => {
    if (!r?.loaded) return;
    commands.list = chatCommandList(r.commands, minion);
    commands.names = new Set(commands.list.map((c) => c.name));
    commands.loaded = true;
    slash.update();
  }).catch(() => {});
  const slash = slashMenu(form, textarea, () => commands.list);
  /** /fresh (#937): a fresh Claude session, Taskmaster or minion, after it writes its handoff. */
  const startFresh = () => {
    const who = minion ? 'this minion' : 'the Taskmaster';
    const how = minion ? 'It replies with a handoff' : 'It saves what lasts to memory and writes a handoff';
    if (!confirm(`Start ${who} on a fresh session? ${how}, then its context resets and its next turn starts from that. The chat stays as it is.`)) return;
    box.value = '';
    api(`api/tickets/${chatId}/fresh-session`, { method: 'POST', body: {} }).catch((ex) => {
      if (!box.value.trim()) box.value = '/fresh';
      alertNote(`No fresh session: ${ex.message}`);
    });
  };
  form.sendAndUnpark = () => {
    unparkWith = true;
    try {
      form.requestSubmit();
    } finally {
      unparkWith = false;
    }
  };
  // Citadel keeps its own look (style.css .composer); the cui-* look is the apps'. Two rows tall when empty, as before.
  form.className = 'composer';
  row.className = 'row';
  textarea.className = '';
  textarea.rows = 2;
  textarea.setAttribute('data-draft', '');
  const menu = h('div', { class: 'send-menu', role: 'menu', hidden: true },
    h('button', { type: 'button', class: 'secondary', role: 'menuitem', onclick: () => {
      closeMenu();
      after = true;
      try {
        form.requestSubmit();
      } finally {
        after = false;
      }
    } }, 'Send after this turn'));
  const moreBtn = h('button', { type: 'button', class: 'more', title: 'More ways to send', 'aria-label': 'More ways to send', 'aria-haspopup': 'menu', 'aria-expanded': 'false',
    onclick: () => (menu.hidden ? openMenu() : closeMenu()) }, '▾');
  const openMenu = () => {
    menu.hidden = false;
    moreBtn.setAttribute('aria-expanded', 'true');
    menu.querySelector('button').focus();
  };
  const closeMenu = () => {
    menu.hidden = true;
    moreBtn.setAttribute('aria-expanded', 'false');
  };
  const sendGroup = h('span', { class: 'send-group' }, sendBtn, moreBtn, menu);
  sendGroup.addEventListener('focusout', (e) => !sendGroup.contains(e.relatedTarget) && closeMenu());
  sendGroup.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menu.hidden) {
      closeMenu();
      moreBtn.focus();
    }
  });
  // No accept filter, so a phone offers its files as well as the photo library.
  const picker = h('input', { type: 'file', multiple: true, hidden: true });
  picker.addEventListener('change', () => {
    attachments.add(picker.files);
    picker.value = '';
  });
  textarea.before(attachments.el,
    account && !account.turns ? h('p', { class: 'muted small composer-note' },
      'Your messages don\'t start or steer turns yet: they wait here, unseen by Claude, until you can link your own Claude account.') : '');
  textarea.after(picker);
  if (minion) textarea.before(sideStrip);
  row.replaceChildren(
    h('button', { type: 'button', class: 'secondary small add-image', title: 'Attach images or files', 'aria-label': 'Attach images or files', onclick: () => picker.click() },
      h('span', { 'aria-hidden': 'true' }, '📎'), h('span', { class: 'wide-only' }, ' Attach')),
    h('span', { class: 'spacer' }),
    modelPicker(chatId), sideBtn || '', sendGroup);
  const pasteFiles = (e) => {
    const files = pastedFiles(e.clipboardData);
    if (!files.length) return false;
    e.preventDefault();
    attachments.add(files);
    return true;
  };
  textarea.addEventListener('paste', pasteFiles);
  // A paste in the chat with no field focused (the document listener below, #654): files attach as above,
  // text goes in at the end of the draft.
  form.pasteAnywhere = (e) => {
    textarea.focus();
    if (pasteFiles(e)) return;
    const text = e.clipboardData?.getData('text/plain');
    if (!text) return;
    e.preventDefault();
    const end = textarea.value.length;
    textarea.setSelectionRange(end, end);
    // insertText keeps Ctrl+Z working and fires input, which saves the draft and resizes the box.
    if (!document.execCommand('insertText', false, text)) {
      textarea.setRangeText(text, end, end, 'end');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }
  };
  form.addEventListener('dragover', (e) => {
    if (e.dataTransfer.types.includes('Files')) e.preventDefault();
  });
  form.addEventListener('drop', (e) => {
    const files = [...e.dataTransfer.files];
    if (!files.length) return;
    e.preventDefault();
    attachments.add(files);
  });
  /**
   * Send a message, showing it straight away. Send never waits: a chat's messages go one after another in
   * the order sent (optimistic's key), each tagged with a sendId the server takes once, however often it's
   * retried (src/send-ids.ts). One that fails stays in the chat marked not sent, with Retry and Edit, and
   * the ones after it still go. The promise settles as optimistic()'s does.
   */
  const send = (text, sent = [], queue = false, unpark = false) => {
    const images = sent.filter((i) => i.data).map(({ mediaType, data }) => ({ mediaType, data }));
    const uploads = sent.filter((i) => i.upload).map((i) => i.upload);
    const files = uploads.map(({ name, type }) => ({ name, type }));
    // The server's copy of the message replaces this one when it arrives (thread.js, by sendId).
    // Its images' object URLs are let go when the bubble goes (taken back here, swapped for the server's copy in thread.js).
    const urls = images.map(({ mediaType, data }) => base64Url(mediaType, data));
    const el = userBubble(me, text, urls, null, null,
      uploads.map((u) => ({ ...u, href: uploadUrl(chatId, u.name) })));
    const entry = { el, urls, text, sendId: crypto.randomUUID(), saved: [...images, ...uploads.map((upload) => ({ upload }))], state: 'new' };
    const body = { text, images, ...(files.length ? { files } : {}), ...(queue ? { after: true } : {}), ...(unpark ? { unpark: true } : {}), sendId: entry.sendId };
    setSending(sending + 1); // until it's in or taken back: a reload now would lose it
    entry.retry = () => optimistic({
      key: `send:${chatId}`,
      label: 'send your message',
      apply: () => {
        // A Retry of one sending again already, or taken back to edit, does nothing.
        if (entry.state !== 'new' && entry.state !== 'failed') throw new Error(`already ${entry.state}`);
        entry.state = 'sending';
        el.classList.replace('not-sent', 'pending') || el.classList.add('pending');
        el.querySelector('.unsent-tag')?.remove();
        // Last in the chat, as it reaches the server after the ones already on their way.
        const box = outbox(chatId);
        if (box.includes(entry)) box.splice(box.indexOf(entry), 1);
        box.push(entry);
        onTheWay.set(chatId, (onTheWay.get(chatId) ?? 0) + 1);
        if (chatOpen(chatId)) {
          document.getElementById('log')?.append(el);
          view.sendingTo = chatId;
          renderTyping();
          scrollToBottom();
        }
      },
      send: async () => {
        try {
          const ticket = await api(`api/tickets/${chatId}/messages`, { method: 'POST', body });
          if (entry.state === 'sending') {
            entry.state = 'sent';
            setSending(sending - 1);
          }
          // Show the message now even if the live stream is down; duplicates are skipped by id.
          if (chatOpen(chatId)) {
            // You just sent something, so follow the reply.
            scrollToBottom();
            adoptTicket(chatId, ticket);
          }
          return ticket;
        } finally {
          const left = onTheWay.get(chatId) - 1;
          left ? onTheWay.set(chatId, left) : onTheWay.delete(chatId);
          if (!left && view?.sendingTo === chatId) {
            view.sendingTo = null;
            renderTyping();
          }
          reloadWhenIdle();
        }
      },
      undo: () => {
        if (entry.state !== 'sending') return;
        if (outbox(chatId).includes(entry)) return notSent(chatId, entry);
        // The server's copy came back already (thread.js swapped it in): it went, whatever the reply said.
        entry.state = 'sent';
        setSending(sending - 1);
      },
    });
    return entry.retry();
  };
  // A one-tap reply (replies.js) sends its text the same way, leaving any draft in the box alone.
  form.sendText = (text) => send(text);
  /**
   * A queued message taken back to edit (thread.js): its text goes in ahead of any draft, its attachments with it.
   * Returns how to take them back out (the take-back was refused): its attachments, and its text unless edited since.
   */
  form.editBack = (text, saved = []) => {
    const draft = textarea.value.trim();
    const before = box.value;
    box.value = draft ? `${text}\n${draft}` : text;
    const put = box.value;
    const added = attachments.restore(saved);
    textarea.focus();
    textarea.setSelectionRange(text.length, text.length);
    return () => {
      if (box.value === put) box.value = before;
      attachments.remove(added.filter((item) => attachments.items.includes(item))); // not those sent meanwhile
    };
  };
  /** More of a taken-back message's attachments, once they have loaded (thread.js). */
  form.attach = (saved) => attachments.restore(saved);
  return form;
}

// ---------- slash commands ----------

/**
 * The menu of slash commands above the box (#937): it opens while the box holds one `/word`, filters as you type,
 * and fills the box with the one picked (arrows and Enter or Tab, or a tap). It floats over the chat, so it moves
 * nothing (test/no-reflow-browser.test.ts). `open(true)` shows every command (/help).
 */
function slashMenu(form, textarea, list) {
  const menu = h('div', { class: 'slash-menu', role: 'listbox', id: `slash-${Math.random().toString(36).slice(2)}`, hidden: true });
  form.prepend(menu);
  textarea.setAttribute('aria-controls', menu.id);
  let shown = [];
  let active = 0;
  let all = false;
  const close = () => {
    menu.hidden = true;
    all = false;
    textarea.removeAttribute('aria-activedescendant');
    textarea.setAttribute('aria-expanded', 'false');
  };
  const mark = () => {
    [...menu.children].forEach((el, i) => el.setAttribute('aria-selected', String(i === active)));
    const el = menu.children[active];
    if (!el) return;
    textarea.setAttribute('aria-activedescendant', el.id);
    el.scrollIntoView({ block: 'nearest' });
  };
  const pick = (c) => {
    textarea.value = `/${c.name} `;
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    textarea.dispatchEvent(new Event('input', { bubbles: true })); // saves the draft and fits the box; closes the menu
    textarea.focus();
  };
  const update = () => {
    const query = all ? '' : menuQuery(textarea.value);
    shown = query === null ? [] : matchCommands(list(), query);
    if (!shown.length) return close();
    active = Math.min(active, shown.length - 1);
    menu.replaceChildren(...shown.map((c, i) => h('div', { class: 'slash-item', role: 'option', id: `${menu.id}-${i}`, onclick: () => pick(c) },
      h('span', { class: 'slash-name' }, `/${c.name}`, c.args ? h('span', { class: 'slash-args' }, ` ${c.args}`) : ''),
      h('span', { class: 'slash-desc' }, c.description || ''))));
    menu.hidden = false;
    textarea.setAttribute('aria-expanded', 'true');
    mark();
  };
  // A tap on the menu keeps the box focused (and a phone's keyboard up).
  menu.addEventListener('pointerdown', (e) => e.preventDefault());
  textarea.addEventListener('input', () => {
    all = false;
    active = 0;
    update();
  });
  textarea.addEventListener('blur', close);
  // Capture: ahead of the box's own Enter, which would send.
  form.addEventListener('keydown', (e) => {
    if (menu.hidden || e.target !== textarea || e.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      active = (active + (e.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length;
      mark();
    } else if (e.key === 'Escape') {
      close();
    } else if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
      // Enter on a name typed out in full sends it; otherwise Enter, like Tab, fills in the one picked.
      if (e.key === 'Enter' && textarea.value === `/${shown[active].name}`) return close();
      pick(shown[active]);
    } else {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
  }, true);
  return {
    update: () => !menu.hidden && update(),
    open: (everything = false) => {
      all = everything;
      active = 0;
      update();
      textarea.focus();
    },
  };
}

// ---------- pasted images and attached files ----------

const MAX_IMAGES = 6;
const MAX_IMAGE_EDGE = 2000;
const MAX_IMAGE_BYTES = 3.5 * 1024 * 1024; // base64 adds a third; the server caps decoded images at 5 MB
const SENDABLE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const MAX_FILES = 20;
const MAX_FILE_BYTES = 200 * 1024 * 1024; // the server's cap (src/uploads.ts)

// A chat's attachments outlive its composer: switching chats and back builds a new composer, and a
// file still uploading must stay on the message, not go with the old composer (#134).
const attachmentsByChat = new Map();
function chatAttachments(chatId) {
  let attachments = attachmentsByChat.get(chatId);
  if (!attachments) {
    attachments = createAttachments(chatId, (items) => saveDraftImages(chatId, items));
    attachmentsByChat.set(chatId, attachments);
    loadDraftImages(chatId).then((items) => attachments.restore(items));
  }
  return attachments;
}

/** A card's answer box takes pictures the way the composer does (pasted, dropped or attached); `onChange` runs as its strip changes. */
export const cardAttachments = (chatId, onChange) => createAttachments(chatId, onChange);

/** Put a marked picture (#946: drawn on a chat image) in a chat's message box, as if pasted. */
export const attachImage = (chatId, blob) => chatAttachments(chatId).add([new File([blob], 'marked.png', { type: blob.type })], true);

/** Whether any chat has a file uploading or an image being prepared; a reload now would lose it. */
export const uploadsRunning = () => [...attachmentsByChat.values()].some((a) => a.busy || a.uploading);

/**
 * What a message will carry: images as thumbnails, read as base64 so Claude sees them, and files,
 * each uploaded to the thread's files folder as soon as it is added. An image that had to be shrunk
 * or converted goes both ways: the preview for Claude to see, the untouched original as a file.
 * Items are { url, mediaType, data } for an image or { upload: { name, size, type } } for a file,
 * whose name is empty until its upload is done.
 */
function createAttachments(chatId, onChange) {
  const el = h('div', { class: 'attachments', hidden: true });
  const state = {
    el, items: [], busy: 0,
    get uploading() { return state.items.some((i) => i.upload && !i.upload.name); },
  };
  const removeButton = (item) => h('button', { type: 'button', class: 'remove', title: 'Remove', 'aria-label': 'Remove', onclick: () => state.remove([item]) }, '×');
  const render = () => {
    onChange(state.items.filter((i) => i.data || i.upload?.name).map(({ mediaType, data, upload }) => (upload ? { upload } : { mediaType, data })));
    el.hidden = !state.items.length;
    el.replaceChildren(...state.items.map((item) => item.upload
      ? h('div', { class: 'file-chip' }, h('span', { class: 'icon', 'aria-hidden': 'true' }, '📄'), h('span', { class: 'name' }, item.upload.label ?? item.file?.name ?? item.upload.name),
        h('span', { class: 'size' }, item.upload.name ? formatSize(item.upload.size) : `${Math.round((item.progress ?? 0) * 100)}%`), removeButton(item))
      : h('div', { class: 'thumb' },
        h('button', { type: 'button', class: 'zoom', title: 'View larger or draw on it', onclick: () => drawOn(item) }, h('img', { src: item.url, alt: 'Image to send' })),
        removeButton(item))));
  };
  const addFile = async (file, label) => {
    if (state.items.filter((i) => i.upload).length >= MAX_FILES) return alertNote(`At most ${MAX_FILES} files per message.`);
    if (file.size > MAX_FILE_BYTES) return alertNote(`${file.name} is ${formatSize(file.size)}; files must be under ${formatSize(MAX_FILE_BYTES)}.`);
    const item = { file, upload: { name: '', size: file.size, type: file.type || 'application/octet-stream', label }, progress: 0 };
    state.items.push(item);
    render();
    try {
      const saved = await uploadFile(chatId, file, item, () => {
        const size = el.children[state.items.indexOf(item)]?.querySelector('.size');
        if (size) size.textContent = `${Math.round(item.progress * 100)}%`;
      });
      Object.assign(item.upload, saved);
      delete item.file;
      delete item.xhr;
      render();
    } catch (err) {
      if (!state.items.includes(item)) return; // removed while uploading
      state.items.splice(state.items.indexOf(item), 1);
      render();
      alertNote(`Could not attach ${file.name}: ${err.message}`);
    }
  };
  const addImage = async (file, marked) => {
    // Past the image limit, an image still goes, as a file Claude can open.
    if (state.items.filter((i) => i.data).length + state.busy >= MAX_IMAGES) return addFile(file);
    state.busy++;
    let blob;
    try {
      blob = await prepareImage(file);
      const data = await blobBase64(blob);
      state.items.push({ url: URL.createObjectURL(blob), mediaType: blob.type, data });
      render();
    } catch {
      // A format the browser can't draw (TIFF, PSD, HEIC on most browsers) still goes, as a file.
      blob = null;
    } finally {
      state.busy--;
    }
    // Shrunk or converted, or not drawable at all: send the untouched original too, so art isn't lost.
    // A picture marked here has no original worth keeping (Cara, 2026-11-17: "Only the marked copy").
    if (blob !== file && !(marked && blob)) await addFile(file, blob ? `${file.name || 'image'} (original)` : undefined);
  };
  state.add = async (files, marked = false) => {
    // Copied first: the picker's FileList empties when the picker is reset, before the loop gets far.
    for (const file of [...files]) {
      if (file.type.startsWith('image/')) await addImage(file, marked);
      else addFile(file);
    }
  };
  state.remove = (items) => {
    for (const item of items) {
      if (item.url) URL.revokeObjectURL(item.url);
      if (item.clean?.url) URL.revokeObjectURL(item.clean.url);
      // shortcut: a file already uploaded stays in the thread's uploads folder; delete it here if they pile up.
      item.xhr?.abort();
    }
    state.items = state.items.filter((item) => !items.includes(item));
    render();
  };
  /** Bring back images and uploaded files saved with a draft (already prepared and encoded, or uploaded). */
  /** Put saved attachments back in front; returns the items it added, for remove(). */
  state.restore = (saved) => {
    if (!saved.length) return [];
    const restored = saved.map(({ mediaType, data, upload }) => (upload ? { upload } : { url: base64Url(mediaType, data), mediaType, data }));
    state.items = [...restored, ...state.items];
    render();
    return restored;
  };
  /**
   * An image waiting to send, full size (#654), in the kit's lightbox (#872), ready to draw on (#946): Done swaps in
   * the marked copy; Esc, its ✕ or a backdrop click closes it unchanged. The clean picture and the marks stay on the
   * item, so reopening it can undo back to the original.
   */
  const drawOn = (item) => {
    const clean = item.clean ?? { url: item.url, mediaType: item.mediaType, data: item.data };
    const lb = lightbox([{ src: clean.url, caption: 'Image to send', alt: 'Image to send, full size' }], {
      render: (_, stage) => annotator(stage, clean.url, {
        marks: item.marks,
        onDone: async (canvas, marks) => {
          lb.close();
          const blob = canvas && await encodeCanvas(canvas).catch(() => null);
          if (canvas && !blob) return alertNote('Could not save the marked image: it came out too large.');
          if (!state.items.includes(item)) return; // removed while open
          if (item.url !== clean.url) URL.revokeObjectURL(item.url);
          if (!blob) {
            Object.assign(item, clean, { clean: undefined, marks: undefined });
          } else {
            const data = await blobBase64(blob);
            Object.assign(item, { url: URL.createObjectURL(blob), mediaType: blob.type, data, clean, marks });
          }
          render();
        },
      }),
    });
  };
  return state;
}

/** PUT a file into the thread's uploads folder, streamed, with progress (fetch can't report upload progress). */
function uploadFile(chatId, file, item, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    item.xhr = xhr;
    xhr.open('PUT', `api/tickets/${chatId}/uploads?name=${encodeURIComponent(file.name || 'file')}`);
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      item.progress = e.loaded / e.total;
      onProgress();
    };
    xhr.onload = () => {
      let data = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {}
      if (xhr.status === 201) resolve(data);
      else reject(new Error(data.error || `HTTP ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error('the upload broke off'));
    xhr.onabort = () => reject(new Error('cancelled'));
    xhr.send(file);
  });
}

/** Shrink big images (and convert odd formats) so they fit the API's size limits; the file itself if it already does. */
const SECRET_ENV = 'CITADEL_SECRET_';

/**
 * A message about to go out looks like it holds a password or key (#838): offer to save it as a secret instead.
 * Saved, the message says $CITADEL_SECRET_<NAME> where the value was, for the person to look over and send.
 */
function askToSaveSecret(ticket, found, { saved, sendAnyway }) {
  const value = h('input', { type: 'password', value: found, ...noAutofill('secret-value', 'new-password'), spellcheck: 'false', required: true, 'aria-label': 'The value' });
  const name = h('input', { type: 'text', autocomplete: 'off', spellcheck: 'false', required: true, placeholder: 'SITE_PASSWORD', pattern: '[A-Za-z][A-Za-z0-9_]{0,63}', 'aria-label': 'Name' });
  const whose = h('select', { 'aria-label': 'Whose' }, h('option', { value: 'person' }, 'Mine'),
    ticket?.project_id != null ? h('option', { value: 'scheme' }, 'This scheme\'s') : null);
  const err = h('p', { class: 'error', role: 'alert', hidden: true });
  const save = h('button', { type: 'submit' }, 'Save as a secret');
  const form = h('form', { class: 'secret-warning' },
    h('p', {}, 'Chats are kept, so a password or key sent here stays in this chat. Save it as a secret instead: a minion gets it as ',
      h('code', {}, `$${SECRET_ENV}<NAME>`), ' and the message names it in place of the value.'),
    h('label', {}, 'The value', value), h('label', {}, 'Name', name), h('label', {}, 'Whose', whose), err,
    h('div', { class: 'row' }, save,
      h('button', { type: 'button', class: 'secondary', onclick: () => { dialog.close(); sendAnyway(); } }, 'Send anyway'),
      h('button', { type: 'button', class: 'secondary', onclick: () => dialog.close() }, 'Cancel')));
  const dialog = openDialog({ title: 'This looks like a secret. Save it as one instead?', className: 'secret-ask', body: form });
  form.onsubmit = async (e) => {
    e.preventDefault();
    save.disabled = true;
    err.hidden = true;
    try {
      const scope = whose.value;
      const r = await api('api/secrets', { method: 'PUT', body: { scope, ...(scope === 'scheme' ? { project: ticket.project_id } : {}), name: name.value, value: value.value } });
      dialog.close();
      saved(r.name);
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
      save.disabled = false;
    }
  };
  name.focus();
}

async function prepareImage(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size <= MAX_IMAGE_BYTES && SENDABLE_TYPES.includes(file.type)) {
    bitmap.close();
    return file;
  }
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return encodeCanvas(canvas);
}

/** A marked picture as a message carries it ({ mediaType, data }), shrunk as a pasted one is (#946, choices pages). */
export async function sendableImage(blob) {
  const sendable = await prepareImage(blob);
  return { mediaType: sendable.type, data: await blobBase64(sendable) };
}

/** A canvas as a sendable image: PNG keeps screenshots sharp; JPEG when that is still too big. */
async function encodeCanvas(canvas) {
  const encode = (type, quality) => new Promise((resolve) => canvas.toBlob(resolve, type, quality));
  let blob = await encode('image/png');
  if (!blob || blob.size > MAX_IMAGE_BYTES) blob = await encode('image/jpeg', 0.85);
  if (!blob || blob.size > MAX_IMAGE_BYTES) throw new Error('image is too large');
  return blob;
}

export function alertNote(text) {
  document.getElementById('log')?.append(h('div', { class: 'note error' }, text));
}

// ---------- model and effort ----------

const MODELS = CLAUDE_MODELS;
// Codex's (#337, src/codex.ts CODEX_MODELS): one-off picks, for people whose own container is signed in to Codex.
const CODEX_MODELS = [
  ['gpt-6-astra', 'GPT-6 Astra'],
  ['gpt-6.1-sol', 'GPT-6.1 Sol'],
  ['gpt-6-luna', 'GPT-6 Luna'],
];
const EFFORTS = EFFORT_LEVELS;
export const modelName = (id) => [...MODELS, ...CODEX_MODELS].find(([m]) => m === id)?.[1] ?? id;
/** Why Codex can't be picked here, briefly, or null. */
function codexBlocked() {
  if (!codex) return 'sign in first';
  if (codex.ready) return null;
  return /container/.test(codex.why ?? '') ? 'link your Claude first' : 'sign in to Codex first';
}

/** Model, effort and (minions only) the Workflow switch for this thread, beside Send; a change applies from its next turn. */
function modelPicker(chatId) {
  const save = (field) => (e) => {
    const value = field === 'workflow' ? e.target.value === 'on' : e.target.value || null;
    setTicketField(chatId, field, value, field === 'workflow' ? (value ? 'on' : 'off') : value ?? 'the default');
  };
  const model = h('select', { class: 'picker', id: 'model-picker', title: 'Model for this minion', 'aria-label': 'Model for this minion', onchange: save('model') });
  const effort = h('select', { class: 'picker', id: 'effort-picker', title: 'Effort for this minion', 'aria-label': 'Effort for this minion', onchange: save('effort') });
  // Workflow (#359): off by default, as the tool adds ~2k tokens to every call; the Taskmaster never gets it.
  const workflow = h('select', { class: 'picker', id: 'workflow-picker', onchange: save('workflow') },
    h('option', { value: '' }, 'Workflow off'), h('option', { value: 'on' }, 'Workflow on'));
  // Each picker in a row with its name, which only phones show; on desktop the rows are display: contents.
  const row = (name, control, id) => h('span', { class: 'picker-row', id }, h('span', { class: 'picker-label', 'aria-hidden': 'true' }, name), control);
  const pickers = h('span', { class: 'pickers', id: 'pickers' },
    row('Model', model), row('Effort', effort), row('Workflow', workflow, 'workflow-row'), row('Plugins', pluginPicker(chatId), 'plugin-row'));
  return settingsMenu(pickers);
}

const phone = matchMedia('(max-width: 800px)');
let closeSettings = () => {};
// The phone texts differ ("Default", "Off"), so crossing the breakpoint refills them, and shuts the menu.
phone.addEventListener('change', () => {
  closeSettings();
  renderModelPicker();
});

/**
 * Phones (#365): one settings button beside Send in place of the row of pickers, which it opens as a menu
 * of named rows. Desktop never shows the button, and the pickers stay inline as before (style.css).
 */
function settingsMenu(pickers) {
  const button = h('button', { type: 'button', class: 'picker settings-button', id: 'settings-picker', 'aria-haspopup': 'true', 'aria-expanded': 'false', 'aria-controls': 'pickers' },
    h('span', { class: 'gear', 'aria-hidden': 'true' }, '⚙'), h('span', { class: 'dot', 'aria-hidden': 'true' }));
  const wrap = h('span', { class: 'settings-picker' }, button, pickers);
  const close = () => {
    wrap.classList.remove('open');
    button.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside, true);
  };
  // A tap outside closes it. Not focusout: a select that disables itself while it saves, or a checkbox
  // Safari doesn't focus, would drop the focus and shut the menu under the person's thumb.
  const outside = (e) => !wrap.contains(e.target) && close();
  button.addEventListener('click', () => {
    if (wrap.classList.contains('open')) return close();
    wrap.classList.add('open');
    button.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', outside, true);
  });
  wrap.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && wrap.classList.contains('open')) {
      close();
      button.focus();
    }
  });
  closeSettings = close;
  return wrap;
}

/** The folder's last part, the name people know a plugin by ("tools/plugins/devtools" → "devtools"). */
const pluginName = (dir) => dir.replace(/\/+$/, '').split('/').pop();

/**
 * Plugins (#361): which of the scheme's optional plugin folders this minion loads, as a checkbox per
 * folder in a menu over the button. Shown only on a minion in a scheme that has optional folders.
 */
function pluginPicker(chatId) {
  const button = h('button', { type: 'button', class: 'picker plugin-button', id: 'plugin-picker', 'aria-haspopup': 'true', 'aria-expanded': 'false', hidden: true });
  const menu = h('div', { class: 'plugin-menu', id: 'plugin-menu', hidden: true });
  const wrap = h('span', { class: 'plugin-picker', id: 'plugin-picker-wrap', hidden: true }, button, menu);
  const close = () => {
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
  };
  button.addEventListener('click', () => {
    if (!menu.hidden) return close();
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    menu.querySelector('input')?.focus();
  });
  wrap.addEventListener('focusout', (e) => !wrap.contains(e.relatedTarget) && close());
  wrap.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menu.hidden) {
      close();
      button.focus();
    }
  });
  menu.addEventListener('change', () => {
    const picks = [...menu.querySelectorAll('input')].filter((b) => b.checked).map((b) => b.value);
    setTicketField(chatId, 'plugin_dirs', picks, picks.length ? picks.map(pluginName).join(', ') : 'no plugins');
  });
  return wrap;
}

/**
 * Set one of the pickers' fields on the minion: shown at once, sent behind (one chat's changes in click order),
 * and put back if the server refuses. plugin_dirs goes as a list and is kept, as the server gives it, one per line.
 */
function setTicketField(chatId, field, value, shown) {
  const t = view.ticket;
  if (view?.id !== chatId || !t) return;
  const was = t[field];
  const show = (v) => {
    t[field] = v;
    if (view?.ticket === t) renderModelPicker();
  };
  const mine = Array.isArray(value) ? value.join('\n') : value;
  optimistic({
    key: `pickers:${chatId}`,
    sets: `pickers:${chatId}:${field}`, // per field: a model that goes through doesn't stand for a failed effort
    apply: () => show(mine),
    send: () => api(`api/tickets/${chatId}`, { method: 'PATCH', body: { [field]: value } }),
    undo: () => t[field] === mine && show(was), // unless something else changed it since
    label: `set ${field === 'plugin_dirs' ? 'plugins' : field} to ${shown}`,
  });
}

/**
 * Fill the pickers from the thread: its choice, or with none, the default (the effort the scheme or the
 * Taskmaster pin gives it, the model it came out as on its last turn, else just "Model" / "Effort"). The default shows grey; a choice shows in full ink.
 */
export function renderModelPicker() {
  const model = document.getElementById('model-picker');
  const effort = document.getElementById('effort-picker');
  if (!model || !effort || !view?.ticket) return;
  const t = view.ticket;
  // On phones each picker sits beside its name, so a default with nothing to show says "Default".
  const onPhone = phone.matches;
  const defModel = !t.model && t.last_model ? modelName(t.last_model) : onPhone ? 'Default' : 'Model';
  const blocked = codexBlocked();
  model.replaceChildren(h('option', { value: '' }, defModel),
    h('optgroup', { label: 'Claude' }, ...MODELS.map(([id, name]) => {
      // The scheme's Minion rules can turn Fable off (#1045): greyed, but a minion already on it keeps showing it.
      const noFable = view.project?.fable_ok === 'off' && /fable/.test(id) && t.model !== id;
      return h('option', { value: id, disabled: noFable, title: noFable ? 'Fable is off in this scheme (Minion rules)' : null }, name);
    })),
    h('optgroup', { label: blocked ? `Codex (${blocked})` : 'Codex' },
      ...CODEX_MODELS.map(([id, name]) => h('option', { value: id, disabled: !!blocked && t.model !== id, title: blocked ? `Codex: ${codex?.why ?? 'sign in to Citadel to use Codex'}` : null }, name))));
  // A model set outside these lists (say, by an older version) still shows as itself.
  if (t.model && ![...MODELS, ...CODEX_MODELS].some(([id]) => id === t.model)) model.append(h('option', { value: t.model }, t.model));
  model.value = t.model ?? '';
  const shownDefault = t.default_effort ?? t.last_effort;
  const defEffort = !t.effort && shownDefault ? shownDefault : onPhone ? 'Default' : 'Effort';
  effort.replaceChildren(h('option', { value: '' }, defEffort), ...EFFORTS.map((e) => h('option', { value: e }, e)));
  effort.value = t.effort ?? '';
  model.classList.toggle('is-default', !t.model);
  effort.classList.toggle('is-default', !t.effort);
  const later = t.status === 'running' ? '; a change applies from the next turn' : '';
  model.title = t.model ? `Model for this minion: ${modelName(t.model)}${later}` : `Model for this minion: the default${t.last_model ? ` (${modelName(t.last_model)} on its last turn)` : ''}${later}`;
  effort.title = t.effort ? `Effort for this minion: ${t.effort}${later}` : `Effort for this minion: the default${t.default_effort ? ` (${t.default_effort})` : t.last_effort ? ` (${t.last_effort} on its last turn)` : ''}${later}`;
  model.setAttribute('aria-label', model.title);
  effort.setAttribute('aria-label', effort.title);
  const workflow = document.getElementById('workflow-picker');
  if (!workflow) return;
  workflow.hidden = document.getElementById('workflow-row').hidden = t.kind === 'coordinator';
  workflow.options[0].textContent = onPhone ? 'Off' : 'Workflow off';
  workflow.options[1].textContent = onPhone ? 'On' : 'Workflow on';
  workflow.value = t.workflow ? 'on' : '';
  workflow.classList.toggle('is-default', !t.workflow);
  workflow.title = `${t.workflow ? 'This minion can use the Workflow tool' : 'Workflow tool off for this minion'}: turning it on adds ~2k tokens to every call, and a change breaks the prompt cache once${later}`;
  workflow.setAttribute('aria-label', workflow.title);
  const picked = renderPluginPicker(t, later);
  renderSettingsButton(t, picked, later);
}

/** The phone settings button: a dot when anything is off its default, and the settings in its label. */
function renderSettingsButton(t, picked, later) {
  const button = document.getElementById('settings-picker');
  if (!button) return;
  const off = [t.model && modelName(t.model), t.effort && `${t.effort} effort`, t.workflow && t.kind !== 'coordinator' && 'Workflow on',
    picked.length && `plugins: ${picked.map(pluginName).join(', ')}`].filter(Boolean);
  button.classList.toggle('is-default', !off.length);
  button.title = `Settings for this minion: ${off.length ? off.join(', ') : 'all on their defaults'}${later}`;
  button.setAttribute('aria-label', button.title);
}

function renderPluginPicker(t, later) {
  const wrap = document.getElementById('plugin-picker-wrap');
  const button = document.getElementById('plugin-picker');
  const menu = document.getElementById('plugin-menu');
  if (!wrap || !button || !menu) return [];
  const offered = t.optional_plugin_dirs ?? [];
  // A pick an admin has since taken off the list no longer loads, so it isn't shown as on.
  const picked = (t.plugin_dirs ? t.plugin_dirs.split('\n') : []).filter((d) => offered.includes(d));
  wrap.hidden = button.hidden = document.getElementById('plugin-row').hidden = t.kind === 'coordinator' || !offered.length;
  button.textContent = !picked.length ? 'No plugins' : picked.length === 1 ? pluginName(picked[0]) : `${picked.length} plugins`;
  button.classList.toggle('is-default', !picked.length);
  button.title = `${picked.length ? `Extra plugins for this minion: ${picked.map(pluginName).join(', ')}` : 'No extra plugins for this minion'}: each costs tokens and memory on every turn, and a change breaks the prompt cache once${later}`;
  button.setAttribute('aria-label', button.title);
  const focused = menu.contains(document.activeElement) ? document.activeElement.value : null;
  menu.replaceChildren(h('p', { class: 'muted small' }, 'Extra plugins for this minion'),
    ...offered.map((d) => h('label', { title: d }, h('input', { type: 'checkbox', value: d, checked: picked.includes(d) }), ` ${pluginName(d)}`)));
  if (focused) menu.querySelector(`input[value="${CSS.escape(focused)}"]`)?.focus();
  return t.kind === 'coordinator' ? [] : picked;
}
