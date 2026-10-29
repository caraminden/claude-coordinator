// The artifact bridge, viewer side (#168): answers the pages in HTML frames this viewer made
// (public/artifact-bridge.js is the page side). A page can read and write its own store and fill the
// comment box; it never sends a message or acts as the person by itself.

export const TAG = 'citadel-bridge-1';
const MAX_TEXT = 10_000;
const MAX_ENTRIES = 100;
// Writes per frame: a burst of 40, then 20 a second.
const BURST = 40;
const PER_SECOND = 20;

// The frames with a bridge, each with what the viewer opened in it (see attachBridge).
const frames = new Set();

/**
 * The frame a message came from and its request, or null when it isn't one to answer: not from the
 * window of a frame this viewer made, not from a sandboxed page (origin "null"), or not a well-formed request.
 */
export function readRequest(e, from = frames) {
  let frame = null;
  for (const f of from) {
    if (!f.iframe.isConnected) from.delete(f);
    else if (e.source && f.iframe.contentWindow === e.source) frame = f;
  }
  const m = e.data;
  if (!frame || e.origin !== 'null' || !m || typeof m !== 'object' || m.bridge !== TAG) return null;
  if (!Number.isSafeInteger(m.id) || typeof m.page !== 'string' || m.page.length > 4000) return null;
  if (m.op === 'hello' || m.op === 'list') return { frame, req: { id: m.id, op: m.op, page: m.page } };
  if (m.op === 'write' && Array.isArray(m.entries) && m.entries.length && m.entries.length <= MAX_ENTRIES) return { frame, req: { id: m.id, op: 'write', page: m.page, entries: m.entries } };
  if (m.op === 'send' && typeof m.text === 'string' && m.text.trim() && m.text.length <= MAX_TEXT) return { frame, req: { id: m.id, op: 'send', page: m.page, text: m.text } };
  return null;
}

/** Whether the frame may write now, taking one from its allowance. */
export function takeWrite(frame, now = Date.now()) {
  frame.tokens = Math.min(BURST, (frame.tokens ?? BURST) + ((now - (frame.at ?? now)) / 1000) * PER_SECOND);
  frame.at = now;
  if (frame.tokens < 1) return false;
  frame.tokens -= 1;
  return true;
}

let call = null;

/**
 * Answer the page in `iframe`. `open` says what the viewer opened ({ artifact } | { ticket, path } |
 * { project, path }), `name` and `owner` how people know the file and who made it, and `onSend(text)`
 * puts a page's text where a person can read and send it. `api` makes the person's own API calls.
 */
export function attachBridge(iframe, { open, name, owner, onSend, api }) {
  call ??= api;
  if (!frames.size) addEventListener('message', onMessage);
  frames.add({ iframe, open, name, owner, onSend, store: null, page: null });
}

async function onMessage(e) {
  const hit = readRequest(e);
  if (!hit) return;
  const { frame, req } = hit;
  // The frame can only hold pages this server sent (the app's CSP is default-src 'self'), and its origin is
  // opaque, so '*' is the only target that reaches it.
  const reply = (body) => e.source.postMessage({ bridge: TAG, re: req.id, ...body }, '*');
  try {
    if (req.op === 'send') {
      if (!frame.onSend) throw new Error('This view has no comment box to put that in');
      // Only on a person's click or key: a page can't fill the box while someone types in it.
      if (navigator.userActivation && !navigator.userActivation.isActive) throw new Error('citadel.send works only from a click or key press');
      frame.onSend(req.text);
      return reply({ ok: true, result: { shown: true } });
    }
    if (req.op === 'write' && !takeWrite(frame)) throw new Error('Too many writes; slow down');
    const r = await storeCall(frame, req.page, req.op === 'write' ? { op: 'write', entries: req.entries } : { op: 'list' });
    const result = req.op === 'hello' ? { person: r.person, file: frame.name, owner: frame.owner, entries: r.entries } : { entries: r.entries };
    reply({ ok: true, result });
  } catch (err) {
    reply({ ok: false, error: err.message });
  }
}

async function storeCall(frame, page, body) {
  const r = await call('api/artifact-data', { method: 'POST', body: { open: frame.open, page, ...body } });
  frame.store = r.store;
  frame.page = page;
  return r;
}

/** Someone (a person or an agent) changed store `store`: send the frames showing it what it holds now. */
export function onArtifactData(store) {
  for (const f of frames) {
    if (!f.iframe.isConnected) frames.delete(f);
    else if (f.store === store && f.page) {
      storeCall(f, f.page, { op: 'list' }).then((r) => f.iframe.contentWindow?.postMessage({ bridge: TAG, op: 'changed', entries: r.entries }, '*'), () => {});
    }
  }
}
