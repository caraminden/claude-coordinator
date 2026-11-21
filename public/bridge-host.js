// The artifact bridge, viewer side (#168): answers the pages in HTML frames this viewer made, and in
// tabs its Open button opened (public/artifact-bridge.js is the page side). A page can read and write its
// own store, and on a person's click send its answer to the minion that showed it, as that person (#417).
// It never sends by itself. A page can also open one of its own pictures to draw on (#946), and send the
// marked copies with its text.

import { answerNow } from './inbox.js';

export const TAG = 'citadel-bridge-1';
const MAX_TEXT = 10_000;
const MAX_ENTRIES = 100;
const MAX_IMAGES = 6;
// Writes per frame: a burst of 40, then 20 a second.
const BURST = 40;
const PER_SECOND = 20;

// The frames and tabs with a bridge, each with what the viewer opened in it (see attachBridge).
const frames = new Set();
// A tab's sends, which can't show they came from a click (activation stays in the tab): one every few seconds.
const TAB_SEND_GAP = 3000;

/**
 * The frame a message came from and its request, or null when it isn't one to answer: not from the
 * window of a frame this viewer made, not from a sandboxed page (origin "null"), or not a well-formed request.
 */
export function readRequest(e, from = frames) {
  let frame = null;
  for (const f of from) {
    if (!alive(f)) from.delete(f);
    else if (e.source && win(f) === e.source) frame = f;
  }
  const m = e.data;
  if (!frame || e.origin !== 'null' || !m || typeof m !== 'object' || m.bridge !== TAG) return null;
  if (!Number.isSafeInteger(m.id) || typeof m.page !== 'string' || m.page.length > 4000) return null;
  if (m.op === 'hello' || m.op === 'list' || m.op === 'typing') return { frame, req: { id: m.id, op: m.op, page: m.page } };
  if (m.op === 'write' && Array.isArray(m.entries) && m.entries.length && m.entries.length <= MAX_ENTRIES) return { frame, req: { id: m.id, op: 'write', page: m.page, entries: m.entries } };
  if (m.op === 'send' && typeof m.text === 'string' && m.text.trim() && m.text.length <= MAX_TEXT && validImages(m.images)) {
    const items = Array.isArray(m.items) && m.items.length <= 500 ? m.items.filter((i) => i && typeof i === 'object').map(({ collection, id, title, label }) => ({ collection, id, title, label })) : null;
    return { frame, req: { id: m.id, op: 'send', page: m.page, text: m.text, ...(m.keepOpen === true ? { keepOpen: true } : {}), ...(m.images?.length ? { images: m.images.map(({ mediaType, data }) => ({ mediaType, data })) } : {}), ...(items?.length ? { items } : {}) } };
  }
  if (m.op === 'draw' && typeof m.src === 'string' && m.src.length <= 4000) return { frame, req: { id: m.id, op: 'draw', page: m.page, src: m.src } };
  return null;
}

// Marked pictures a send carries, as a chat message does ({ mediaType, data } in base64); the server checks the bytes.
const validImages = (v) => v == null || (Array.isArray(v) && v.length <= MAX_IMAGES && v.every((i) => i && typeof i.mediaType === 'string' && typeof i.data === 'string' && i.data));

/**
 * Whether a page's picture may be drawn on: only one behind a file token (api/files/<token>/…), which the page
 * could fetch itself. A cookie-backed route (another minion's files, the API) would hand the page pixels the
 * person can see but it can't, and another site's picture would taint the canvas.
 */
export function ownPicture(src, base = document.baseURI) {
  try {
    const u = new URL(src);
    return /^https?:$/.test(u.protocol) && !u.username && !u.password && u.href.startsWith(new URL('api/files/', base).href);
  } catch {
    return false;
  }
}

/** Whether the frame may write now, taking one from its allowance. */
export function takeWrite(frame, now = Date.now()) {
  frame.tokens = Math.min(BURST, (frame.tokens ?? BURST) + ((now - (frame.at ?? now)) / 1000) * PER_SECOND);
  frame.at = now;
  if (frame.tokens < 1) return false;
  frame.tokens -= 1;
  return true;
}

// When a page last said someone typed in it, or wrote: Citadel waits for a quiet moment before it loads a
// new front end, and its own input events never see typing in a frame (#821).
let typedAt = 0;
export const bridgeTypedAt = () => typedAt;

/** Whether a page open here holds writes Citadel couldn't take yet (it was restarting): a reload would lose them. */
export const bridgeUnsaved = () => [...frames].some((f) => alive(f) && f.unsaved);

/** A failure worth sending again: the network, or Caddy's answer while Citadel restarts. */
const transient = (err) => err?.retry === true || err instanceof TypeError || [502, 503, 504].includes(err?.status);

const win = (f) => (f.iframe ? f.iframe.contentWindow : f.tab);
const alive = (f) => (f.iframe ? f.iframe.isConnected : !f.tab.closed);

/**
 * Answer the page in `iframe`, or in `tab`, a window the viewer opened. `open` says what the viewer opened
 * ({ artifact } | { ticket, path } | { project, path }), `name` and `owner` how people know the file and
 * who made it. `api` makes the person's own API calls. `draw(src, marks)` opens a picture to draw on over the
 * viewer and resolves null when closed, else { marks, image } (image null when every mark was taken off);
 * a tab has none, since its page sits in front of Citadel.
 */
export function attachBridge(iframe, { open, name, owner, api, draw = null, tab = null, afterSend = null }) {
  if (!frames.size) addEventListener('message', onMessage);
  frames.add({ iframe: tab ? null : iframe, tab, open, name, owner, api, draw: tab ? null : draw, marks: new Map(), store: null, page: null, afterSend: tab ? null : afterSend });
}

/** Open `src` (an HTML page) in a new tab that keeps its bridge to this viewer; false if the browser refused. */
export function openWithBridge(src, bridge, api) {
  const tab = window.open(src, '_blank');
  if (!tab) return false;
  attachBridge(null, { ...bridge, api, tab });
  return true;
}

/** Whether a tab opened with Open is still open: reloading this page would cut its bridge (it can't be found again). */
export const tabBridgeOpen = () => [...frames].some((f) => f.tab && alive(f));

async function onMessage(e) {
  const hit = readRequest(e);
  if (!hit) return;
  const { frame, req } = hit;
  // The frame can only hold pages this server sent (the app's CSP is default-src 'self'), and its origin is
  // opaque, so '*' is the only target that reaches it.
  const reply = (body) => e.source.postMessage({ bridge: TAG, re: req.id, ...body }, '*');
  if (req.op === 'typing') return void (typedAt = Date.now());
  try {
    if (req.op === 'draw') {
      if (!frame.draw) throw new Error('Drawing on a picture works only in Citadel\'s viewer');
      if (navigator.userActivation && !navigator.userActivation.isActive) throw new Error('citadel.draw works only from a click or key press');
      if (!ownPicture(req.src)) throw new Error('Only a picture from this page\'s own folder can be drawn on');
      // The marks are kept here, so opening a marked picture again can undo back to the clean one.
      const r = await frame.draw(req.src, frame.marks.get(req.src) ?? []);
      if (r) frame.marks.set(req.src, r.marks);
      return reply({ ok: true, result: r && (r.image ? { marked: true, ...r.image } : { marked: false }) });
    }
    if (req.op === 'send') {
      // Only on a person's click or key: a page never sends as them by itself. A frame's click reaches
      // this window; a tab's doesn't, so a tab only gets a gap between sends.
      if (frame.iframe && navigator.userActivation && !navigator.userActivation.isActive) throw new Error('citadel.send works only from a click or key press');
      if (frame.tab && Date.now() - (frame.sentAt ?? 0) < TAB_SEND_GAP) throw new Error('Sent a moment ago; wait a few seconds before sending again');
      // #1409: the choices card this page answers drops from the counts at the click; a refused send brings it back.
      const unanswer = frame.open?.ticket ? answerNow(frame.open.ticket, (i) => !!i.card?.doc && (i.card.doc.path === frame.open.path || i.card.doc.path?.endsWith(`/${frame.open.path}`))) : () => {};
      const r = await frame.api('api/artifact-send', { method: 'POST', body: { open: frame.open, page: req.page, text: req.text, images: req.images, items: req.items } }).catch((e) => { unanswer(); throw e; });
      frame.sentAt = Date.now(); // after it went, so a retry after a failure isn't held back
      reply({ ok: true, result: { sent: true, to: r.to.label } });
      // Sent: the viewer goes away and the chat shows the message, unless the page keeps it open (send's keepOpen).
      if (!req.keepOpen) frame.afterSend?.();
      return;
    }
    if (req.op === 'write') {
      // The page sends a refused write again after its gap, so a burst of picks isn't lost.
      if (!takeWrite(frame)) throw Object.assign(new Error('Too many writes; slow down'), { retry: true });
      typedAt = Date.now();
    }
    const r = await storeCall(frame, req.page, req.op === 'write' ? { op: 'write', entries: req.entries } : { op: 'list' });
    // Landed, or a hello from a page that reloaded and so has no write left to send.
    if (req.op !== 'list') frame.unsaved = false;
    const result = req.op === 'hello' ? { person: r.person, file: frame.name, owner: frame.owner, entries: r.entries, draw: !!frame.draw } : { entries: r.entries };
    reply({ ok: true, result });
  } catch (err) {
    // A write the page sends again until it lands (artifact-bridge.js) holds a reload here; one refused
    // for good won't be sent again, so it doesn't.
    if (req.op === 'write') frame.unsaved = transient(err);
    reply({ ok: false, error: err.message, ...(transient(err) ? { retry: true } : {}) });
  }
}

async function storeCall(frame, page, body) {
  const r = await frame.api('api/artifact-data', { method: 'POST', body: { open: frame.open, page, ...body } });
  frame.store = r.store;
  frame.page = page;
  return r;
}

/** Someone (a person or an agent) changed store `store`: send the frames showing it what it holds now. */
export function onArtifactData(store) {
  for (const f of frames) {
    if (!alive(f)) frames.delete(f);
    else if (f.store === store && f.page) {
      storeCall(f, f.page, { op: 'list' }).then((r) => win(f)?.postMessage({ bridge: TAG, op: 'changed', entries: r.entries }, '*'), () => {});
    }
  }
}
