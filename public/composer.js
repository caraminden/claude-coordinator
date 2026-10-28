// The message box under a chat: drafts, pasted images, model and effort.
import { api, catchUpEvents, h, isCoordinator, me, reloadWhenIdle, scrollToBottom, sending, setSending, view } from './core.js';
import { base64Url, renderTicketHead, renderTyping, userBubble } from './thread.js';

// ---------- drafts ----------

// Unsent text survives reloads and switching threads: it is saved per thread as you type.
// Text goes to localStorage; images are too big for it, so they go to IndexedDB.
export function loadDraft(key) {
  try { return JSON.parse(localStorage.getItem(key)) ?? null; } catch { return null; }
}

export function saveDraft(key, value) {
  try {
    if (value) localStorage.setItem(key, JSON.stringify(value));
    else localStorage.removeItem(key);
  } catch {}
}

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
  const textarea = h('textarea', {
    placeholder: composerPlaceholder(ticket),
    'data-draft': true,
  });
  const draftKey = `cc-draft:${chatId}`;
  textarea.value = loadDraft(draftKey) ?? '';
  textarea.addEventListener('input', () => saveDraft(draftKey, textarea.value));
  const sendBtn = h('button', { type: 'submit' }, 'Send');
  const attachments = createAttachments((items) => saveDraftImages(chatId, items));
  loadDraftImages(chatId).then((items) => attachments.restore(items));
  const picker = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true });
  picker.addEventListener('change', () => {
    attachments.add(picker.files);
    picker.value = '';
  });
  const form = h('form', { class: 'composer' }, attachments.el, textarea, picker,
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'secondary small add-image', title: 'Add image', 'aria-label': 'Add image', onclick: () => picker.click() },
        h('span', { 'aria-hidden': 'true' }, '📎'), h('span', { class: 'wide-only' }, ' Add image')),
      h('span', { class: 'spacer' }),
      modelPicker(chatId), sendBtn));
  textarea.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();
    attachments.add(files);
  });
  form.addEventListener('dragover', (e) => {
    if ([...e.dataTransfer.items].some((i) => i.type.startsWith('image/'))) e.preventDefault();
  });
  form.addEventListener('drop', (e) => {
    const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();
    attachments.add(files);
  });
  textarea.addEventListener('keydown', (e) => {
    // Leave Enter alone while an IME is composing text, or it would send half a word.
    // On a phone Enter adds a line; the Send button sends.
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !matchMedia('(max-width: 800px)').matches) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = textarea.value.trim();
    if (attachments.busy) return alertNote('Still preparing an image; try again in a moment.');
    if (!text && !attachments.items.length) return;
    sendBtn.disabled = true;
    setSending(sending + 1);
    const sent = attachments.items.slice();
    const images = sent.map(({ mediaType, data }) => ({ mediaType, data }));
    // Show the message and "Claude is thinking…" straight away, and clear the composer; the
    // server's copy of the message replaces this one when it arrives.
    const pending = userBubble(me, text, images.map(({ mediaType, data }) => base64Url(mediaType, data)));
    pending.classList.add('pending');
    view.pendingMessages.push({ el: pending, text });
    document.getElementById('log').append(pending);
    textarea.value = '';
    saveDraft(draftKey, '');
    attachments.remove(sent);
    view.sendingTo = chatId;
    renderTyping();
    scrollToBottom();
    try {
      const ticket = await api(`/api/tickets/${chatId}/messages`, { method: 'POST', body: { text, images } });
      // Show the message now even if the live stream is down; duplicates are skipped by id.
      if (view?.kind === 'project' && view.id === chatId) {
        // You just sent something, so follow the reply.
        scrollToBottom();
        view.ticket = ticket;
        renderTicketHead();
        catchUpEvents().catch(() => {});
      }
    } catch (ex) {
      // Not sent: take the message back out of the chat and put it back in the composer.
      pending.remove();
      if (view?.id === chatId) view.pendingMessages = view.pendingMessages.filter((m) => m.el !== pending);
      textarea.value = textarea.value.trim() ? `${text}\n${textarea.value}` : text;
      saveDraft(draftKey, textarea.value);
      attachments.restore(images);
      alertNote(ex.message);
    } finally {
      if (view?.sendingTo === chatId) {
        view.sendingTo = null;
        renderTyping();
      }
      sendBtn.disabled = false;
      setSending(sending - 1);
      reloadWhenIdle();
    }
  });
  return form;
}

// ---------- pasted images ----------

const MAX_IMAGES = 6;
const MAX_IMAGE_EDGE = 2000;
const MAX_IMAGE_BYTES = 3.5 * 1024 * 1024; // base64 adds a third; the server caps decoded images at 5 MB
const SENDABLE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

/** Pending images in the composer: thumbnails with a remove button, read as base64 for sending. */
function createAttachments(onChange) {
  const el = h('div', { class: 'attachments', hidden: true });
  const state = { el, items: [], busy: 0 };
  const render = () => {
    onChange(state.items.map(({ mediaType, data }) => ({ mediaType, data })));
    el.hidden = !state.items.length;
    el.replaceChildren(...state.items.map((item) => h('div', { class: 'thumb' },
      h('img', { src: item.url, alt: 'Image to send' }),
      h('button', { type: 'button', title: 'Remove', onclick: () => {
        URL.revokeObjectURL(item.url);
        state.items.splice(state.items.indexOf(item), 1);
        render();
      } }, '×'))));
  };
  state.add = async (files) => {
    for (const file of files) {
      if (state.items.length + state.busy >= MAX_IMAGES) {
        alertNote(`At most ${MAX_IMAGES} images per message.`);
        break;
      }
      state.busy++;
      try {
        const blob = await prepareImage(file);
        const data = await new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(String(r.result).split(',')[1]);
          r.onerror = () => reject(r.error);
          r.readAsDataURL(blob);
        });
        state.items.push({ url: URL.createObjectURL(blob), mediaType: blob.type, data });
        render();
      } catch (err) {
        alertNote(`Could not add image: ${err.message}`);
      } finally {
        state.busy--;
      }
    }
  };
  state.remove = (items) => {
    for (const item of items) URL.revokeObjectURL(item.url);
    state.items = state.items.filter((item) => !items.includes(item));
    render();
  };
  /** Bring back images saved with a draft (they are already prepared and encoded). */
  state.restore = (saved) => {
    if (!saved.length) return;
    const restored = saved.map(({ mediaType, data }) => ({ url: base64Url(mediaType, data), mediaType, data }));
    state.items = [...restored, ...state.items].slice(0, MAX_IMAGES);
    render();
  };
  return state;
}

/** Shrink big images (and convert odd formats) so they fit the API's size limits. */
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
      const ticket = await api(`/api/tickets/${chatId}`, { method: 'PATCH', body: { [field]: sel.value || null } });
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
