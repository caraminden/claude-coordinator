// The artifact bridge, viewer side (#168): answers the pages in HTML frames this viewer made, and in
// tabs its Open button opened (public/artifact-bridge.js is the page side). A page can read and write its
// own store, and on a person's click send its answer to the minion that showed it, as that person (#417).
// It never sends by itself.

export const TAG = 'citadel-bridge-1';
const MAX_TEXT = 10_000;
const MAX_ENTRIES = 100;
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

// When a page last said someone typed in it, or wrote: Citadel waits for a quiet moment before it loads a
// new front end, and its own input events never see typing in a frame (#821).
let typedAt = 0;
export const bridgeTypedAt = () => typedAt;

/** Whether a page open here holds writes Citadel couldn't take yet (it was restarting): a reload would lose them. */
export const bridgeUnsaved = () => [...frames].some((f) => alive(f) && f.unsaved);

/** A failure worth sending again: the network, or Caddy's answer while Citadel restarts. */
const transient = (err) => err instanceof TypeError || [502, 503, 504].includes(err?.status);

const win = (f) => (f.iframe ? f.iframe.contentWindow : f.tab);
const alive = (f) => (f.iframe ? f.iframe.isConnected : !f.tab.closed);

/**
 * Answer the page in `iframe`, or in `tab`, a window the viewer opened. `open` says what the viewer opened
 * ({ artifact } | { ticket, path } | { project, path }), `name` and `owner` how people know the file and
 * who made it. `api` makes the person's own API calls.
 */
export function attachBridge(iframe, { open, name, owner, api, tab = null }) {
  if (!frames.size) addEventListener('message', onMessage);
  frames.add({ iframe: tab ? null : iframe, tab, open, name, owner, api, store: null, page: null });
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
    if (req.op === 'send') {
      // Only on a person's click or key: a page never sends as them by itself. A frame's click reaches
      // this window; a tab's doesn't, so a tab only gets a gap between sends.
      if (frame.iframe && navigator.userActivation && !navigator.userActivation.isActive) throw new Error('citadel.send works only from a click or key press');
      if (frame.tab && Date.now() - (frame.sentAt ?? 0) < TAB_SEND_GAP) throw new Error('Sent a moment ago; wait a few seconds before sending again');
      const r = await frame.api('api/artifact-send', { method: 'POST', body: { open: frame.open, page: req.page, text: req.text } });
      frame.sentAt = Date.now(); // after it went, so a retry after a failure isn't held back
      return reply({ ok: true, result: { sent: true, to: r.to.label } });
    }
    if (req.op === 'write') {
      if (!takeWrite(frame)) throw new Error('Too many writes; slow down');
      typedAt = Date.now();
    }
    let r;
    try {
      r = await storeCall(frame, req.page, req.op === 'write' ? { op: 'write', entries: req.entries } : { op: 'list' });
    } catch (err) {
      // The page sends it again until it lands (artifact-bridge.js); until then a reload here would lose it.
      if (req.op === 'write' && transient(err)) frame.unsaved = true;
      throw err;
    }
    if (req.op === 'write') frame.unsaved = false;
    const result = req.op === 'hello' ? { person: r.person, file: frame.name, owner: frame.owner, entries: r.entries } : { entries: r.entries };
    reply({ ok: true, result });
  } catch (err) {
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
