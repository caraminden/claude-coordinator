// Minion links in chat (a.thread-ref) coloured by their minion's state (#1743). The links are plain HTML from threadrefs.js, so this
// paints them in the DOM from the scheme's list already on screen (no fetch per link): a data-ref-state attribute (the CSS draws the
// colour and a glyph from it, in thread.css) and the state in words in the hover title.
import { view } from './base.js';
import { REF_WORDS, refBucket, refTitle } from './threadstate.js';
import { pendingRelease, releasesLoaded } from './releases.js';

const TARGET = 'a.thread-ref[href], a[data-pr-url][href]';
const THREAD_HREF = /^#\/p\/(\d+)\/t\/(\d+)$/;

/** Paint every minion link under `root` (the whole page by default) from the open scheme's minions. */
export function paintRefs(root = document) {
  if (view?.kind !== 'project' || !view.tickets) return;
  const links = [...root.querySelectorAll(TARGET)];
  if (!links.length) return;
  const byNumber = new Map([...view.tickets.values()].map((t) => [t.number, t]));
  for (const a of links) {
    const m = THREAD_HREF.exec(a.getAttribute('href'));
    if (!m) continue;
    const t = Number(m[1]) === view.projectId ? byNumber.get(Number(m[2])) : null;
    const release = t && t.status === 'closed' ? pendingRelease(t) : null;
    // A dismissed minion's release may still be on its way: until the releases are known, say nothing rather than guess green.
    const bucket = t?.status === 'closed' && !releasesLoaded() ? 'neutral' : refBucket(release ? { ...t, release } : t);
    if (a.dataset.baseTitle === undefined) a.dataset.baseTitle = a.getAttribute('title') ?? '';
    const word = REF_WORDS[bucket];
    if (word) {
      if (a.dataset.refState !== bucket) a.dataset.refState = bucket;
    } else delete a.dataset.refState;
    const title = refTitle(a.dataset.baseTitle, m[2], word);
    if (title) {
      if (a.getAttribute('title') !== title) a.setAttribute('title', title);
    } else a.removeAttribute('title');
  }
}

let queued = false;
/** Repaint once next frame, however many asked (a burst of ticket updates, a chat drawing many messages). */
export function schedulePaintRefs() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    paintRefs();
  });
}

/** Paint links as chats draw them, and again whenever `schedulePaintRefs` is asked (core.js, on each ticket update). */
export function watchRefs() {
  new MutationObserver((muts) => {
    if (muts.some((m) => [...m.addedNodes].some((n) => n.nodeType === 1 && (n.matches?.(TARGET) || n.querySelector?.(TARGET))))) schedulePaintRefs();
  }).observe(document.body, { childList: true, subtree: true });
}
