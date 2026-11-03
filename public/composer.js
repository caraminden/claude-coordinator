// The message box under a chat, on Citadel UI's composer (public/ui/composer.js: autogrow, Enter rules,
// IME guard, list continuation, the text back on a failed send, the text draft). Citadel's own around it:
// pasted and dropped files with their drafts, the model and effort pickers, and steer or queue mid-turn.
import { account, api, catchUpEvents, formatSize, h, isCoordinator, me, reloadWhenIdle, scrollToBottom, sending, setSending, uploadUrl, view } from './core.js';
import { base64Url, renderTicketHead, renderTyping, userBubble } from './thread.js';
import { mountComposer } from './ui/composer.js';

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

// Shared with every app (public/ui/composer.js); the new-minion box uses it too.
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

/** The message box under a chat: text, pasted images, model and effort, and Send. */
export function composer(chatId, ticket) {
  const attachments = chatAttachments(chatId);
  // Mid-turn, Send steers the running turn; the ▾ (shown only then, style.css) offers queueing instead.
  // The menu sets `after` around its submit, which calls send() at once (ui/composer.js), so it reads it there.
  let after = false;
  const box = mountComposer(document.createDocumentFragment(), {
    placeholder: composerPlaceholder(ticket),
    draftKey: `cc-draft:${chatId}`,
    canSend: (text) => {
      if (attachments.busy) return alertNote('Still preparing an image; try again in a moment.'), false;
      if (attachments.uploading) return alertNote('Still uploading a file; send once it shows its size.'), false;
      return !!text || attachments.items.length > 0;
    },
    send: (text) => {
      const sent = attachments.items.slice();
      attachments.remove(sent);
      return send(text, sent, after).catch((ex) => {
        // Not sent: the core puts the text back; the attachments come back here.
        attachments.restore([...sent.filter((i) => i.data).map(({ mediaType, data }) => ({ mediaType, data })), ...sent.filter((i) => i.upload).map(({ upload }) => ({ upload }))]);
        throw ex;
      });
    },
    onError: (ex) => alertNote(ex.message),
  });
  const { form, textarea, row, sendButton: sendBtn } = box;
  form.classList.add('composer');
  row.classList.add('row');
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
  row.replaceChildren(
    h('button', { type: 'button', class: 'secondary small add-image', title: 'Attach images or files', 'aria-label': 'Attach images or files', onclick: () => picker.click() },
      h('span', { 'aria-hidden': 'true' }, '📎'), h('span', { class: 'wide-only' }, ' Attach')),
    h('span', { class: 'spacer' }),
    modelPicker(chatId), sendGroup);
  textarea.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files ?? [])];
    if (!files.length) return;
    e.preventDefault();
    attachments.add(files);
  });
  form.addEventListener('dragover', (e) => {
    if (e.dataTransfer.types.includes('Files')) e.preventDefault();
  });
  form.addEventListener('drop', (e) => {
    const files = [...e.dataTransfer.files];
    if (!files.length) return;
    e.preventDefault();
    attachments.add(files);
  });
  /** Send a message, showing it straight away; on failure it comes back out of the chat and the promise rejects. */
  const send = async (text, sent = [], queue = false) => {
    sendBtn.disabled = moreBtn.disabled = true;
    setSending(sending + 1);
    const images = sent.filter((i) => i.data).map(({ mediaType, data }) => ({ mediaType, data }));
    const uploads = sent.filter((i) => i.upload).map((i) => i.upload);
    const files = uploads.map(({ name, type }) => ({ name, type }));
    // Show the message and "Claude is thinking…" straight away; the
    // server's copy of the message replaces this one when it arrives.
    const pending = userBubble(me, text, images.map(({ mediaType, data }) => base64Url(mediaType, data)), null, null,
      uploads.map((u) => ({ ...u, href: uploadUrl(chatId, u.name) })));
    pending.classList.add('pending');
    view.pendingMessages.push({ el: pending, text });
    document.getElementById('log').append(pending);
    view.sendingTo = chatId;
    renderTyping();
    scrollToBottom();
    try {
      const ticket = await api(`api/tickets/${chatId}/messages`, { method: 'POST', body: { text, images, ...(files.length ? { files } : {}), ...(queue ? { after: true } : {}) } });
      // Show the message now even if the live stream is down; duplicates are skipped by id.
      if (view?.kind === 'project' && view.id === chatId) {
        // You just sent something, so follow the reply.
        scrollToBottom();
        view.ticket = ticket;
        renderTicketHead();
        catchUpEvents().catch(() => {});
      }
    } catch (ex) {
      pending.remove();
      if (view?.id === chatId) view.pendingMessages = view.pendingMessages.filter((m) => m.el !== pending);
      throw ex;
    } finally {
      if (view?.sendingTo === chatId) {
        view.sendingTo = null;
        renderTyping();
      }
      sendBtn.disabled = moreBtn.disabled = false;
      setSending(sending - 1);
      reloadWhenIdle();
    }
  };
  // A one-tap reply (replies.js) sends its text the same way, leaving any draft in the box alone.
  form.sendText = (text) => send(text);
  /** A queued message taken back to edit (thread.js): its text goes in ahead of any draft, its attachments with it. */
  form.editBack = (text, saved = []) => {
    const draft = textarea.value.trim();
    box.value = draft ? `${text}\n${draft}` : text;
    attachments.restore(saved);
    textarea.focus();
    textarea.setSelectionRange(text.length, text.length);
  };
  return form;
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
  const removeButton = (item) => h('button', { type: 'button', title: 'Remove', 'aria-label': 'Remove', onclick: () => state.remove([item]) }, '×');
  const render = () => {
    onChange(state.items.filter((i) => i.data || i.upload?.name).map(({ mediaType, data, upload }) => (upload ? { upload } : { mediaType, data })));
    el.hidden = !state.items.length;
    el.replaceChildren(...state.items.map((item) => item.upload
      ? h('div', { class: 'file-chip' }, h('span', { class: 'icon', 'aria-hidden': 'true' }, '📄'), h('span', { class: 'name' }, item.upload.label ?? item.file?.name ?? item.upload.name),
        h('span', { class: 'size' }, item.upload.name ? formatSize(item.upload.size) : `${Math.round((item.progress ?? 0) * 100)}%`), removeButton(item))
      : h('div', { class: 'thumb' }, h('img', { src: item.url, alt: 'Image to send' }), removeButton(item))));
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
  const addImage = async (file) => {
    // Past the image limit, an image still goes, as a file Claude can open.
    if (state.items.filter((i) => i.data).length + state.busy >= MAX_IMAGES) return addFile(file);
    state.busy++;
    let blob;
    try {
      blob = await prepareImage(file);
      const data = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).split(',')[1]);
        r.onerror = () => reject(r.error);
        r.readAsDataURL(blob);
      });
      state.items.push({ url: URL.createObjectURL(blob), mediaType: blob.type, data });
      render();
    } catch {
      // A format the browser can't draw (TIFF, PSD, HEIC on most browsers) still goes, as a file.
      blob = null;
    } finally {
      state.busy--;
    }
    // Shrunk or converted, or not drawable at all: send the untouched original too, so art isn't lost.
    if (blob !== file) await addFile(file, blob ? `${file.name || 'image'} (original)` : undefined);
  };
  state.add = async (files) => {
    // Copied first: the picker's FileList empties when the picker is reset, before the loop gets far.
    for (const file of [...files]) {
      if (file.type.startsWith('image/')) await addImage(file);
      else addFile(file);
    }
  };
  state.remove = (items) => {
    for (const item of items) {
      if (item.url) URL.revokeObjectURL(item.url);
      // shortcut: a file already uploaded stays in the thread's uploads folder; delete it here if they pile up.
      item.xhr?.abort();
    }
    state.items = state.items.filter((item) => !items.includes(item));
    render();
  };
  /** Bring back images and uploaded files saved with a draft (already prepared and encoded, or uploaded). */
  state.restore = (saved) => {
    if (!saved.length) return;
    const restored = saved.map(({ mediaType, data, upload }) => (upload ? { upload } : { url: base64Url(mediaType, data), mediaType, data }));
    state.items = [...restored, ...state.items];
    render();
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
  const encode = (type, quality) => new Promise((resolve) => canvas.toBlob(resolve, type, quality));
  // Screenshots stay sharp as PNG; fall back to JPEG when that is still too big.
  let blob = await encode('image/png');
  if (!blob || blob.size > MAX_IMAGE_BYTES) blob = await encode('image/jpeg', 0.85);
  if (!blob || blob.size > MAX_IMAGE_BYTES) throw new Error('image is too large');
  return blob;
}

export function alertNote(text) {
  document.getElementById('log')?.append(h('div', { class: 'note error' }, text));
}

// ---------- model and effort ----------

const MODELS = [
  ['claude-opus-5-5', 'Opus 5.5'],
  ['claude-sonnet-5-5', 'Sonnet 5.5'],
  ['claude-haiku-5-5', 'Haiku 5.5'],
  ['claude-fable-5-1', 'Fable 5.1'],
];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const modelName = (id) => MODELS.find(([m]) => m === id)?.[1] ?? id;

/** Model and effort for this thread, beside Send; a change applies from its next turn. */
function modelPicker(chatId) {
  const save = (field) => async (e) => {
    const sel = e.target;
    sel.disabled = true;
    try {
      const ticket = await api(`api/tickets/${chatId}`, { method: 'PATCH', body: { [field]: sel.value || null } });
      if (view?.kind === 'project' && view.id === chatId) {
        view.ticket = ticket;
        renderModelPicker();
      }
    } catch (err) {
      alertNote(err.message);
      renderModelPicker();
    } finally {
      sel.disabled = false;
    }
  };
  const model = h('select', { class: 'picker', id: 'model-picker', title: 'Model for this minion', 'aria-label': 'Model for this minion', onchange: save('model') });
  const effort = h('select', { class: 'picker', id: 'effort-picker', title: 'Effort for this minion', 'aria-label': 'Effort for this minion', onchange: save('effort') });
  return h('span', { class: 'pickers' }, model, effort);
}

/**
 * Fill the pickers from the thread: its choice, or with none, the default (the effort the scheme or the
 * Taskmaster pin gives it, the model it came out as on its last turn, else just "Model" / "Effort"). The default shows grey; a choice shows in full ink.
 */
export function renderModelPicker() {
  const model = document.getElementById('model-picker');
  const effort = document.getElementById('effort-picker');
  if (!model || !effort || !view.ticket) return;
  const t = view.ticket;
  const defModel = !t.model && t.last_model ? modelName(t.last_model) : 'Model';
  model.replaceChildren(h('option', { value: '' }, defModel), ...MODELS.map(([id, name]) => h('option', { value: id }, name)));
  // A model set outside this list (say, by an older version) still shows as itself.
  if (t.model && !MODELS.some(([id]) => id === t.model)) model.append(h('option', { value: t.model }, t.model));
  model.value = t.model ?? '';
  const shownDefault = t.default_effort ?? t.last_effort;
  const defEffort = !t.effort && shownDefault ? shownDefault : 'Effort';
  effort.replaceChildren(h('option', { value: '' }, defEffort), ...EFFORTS.map((e) => h('option', { value: e }, e)));
  effort.value = t.effort ?? '';
  model.classList.toggle('is-default', !t.model);
  effort.classList.toggle('is-default', !t.effort);
  const later = t.status === 'running' ? '; a change applies from the next turn' : '';
  model.title = t.model ? `Model for this minion: ${modelName(t.model)}${later}` : `Model for this minion: the default${t.last_model ? ` (${modelName(t.last_model)} on its last turn)` : ''}${later}`;
  effort.title = t.effort ? `Effort for this minion: ${t.effort}${later}` : `Effort for this minion: the default${t.default_effort ? ` (${t.default_effort})` : t.last_effort ? ` (${t.last_effort} on its last turn)` : ''}${later}`;
  model.setAttribute('aria-label', model.title);
  effort.setAttribute('aria-label', effort.title);
}
