// Contraptions inside Citadel's window (#274, Cara 2026-11-02: "Mandate inside Citadel"): #/apps/<name>
// shows the contraption in a frame over Citadel's page, beside the rail. It's inside Citadel's scope, so
// an installed Citadel shows no out-of-scope strip and opens no second window. Each frame stays alive
// once opened, hidden while you're elsewhere, so switching back keeps your place in it; Citadel's page
// stays under it (inert), scroll and all. The framed page's own rail.js draws no rail and lends Citadel's.

const frames = new Map();
let box = null;

/** Show contraption `name` (its frame made on first visit), at address `src` if given: an open frame reloads there. */
export function showFrame(name, src) {
  if (!box) {
    box = document.createElement('div');
    box.id = 'frames';
    document.body.append(box);
  }
  let frame = frames.get(name);
  if (!frame) {
    frame = document.createElement('iframe');
    frame.src = src ?? `/apps/${name}/`;
    frame.title = name;
    box.append(frame);
    frames.set(name, frame);
  } else if (src) frame.src = src;
  for (const [n, f] of frames) f.hidden = n !== name;
  setFramed(true);
  frame.focus();
}

/** Back to Citadel's own page. */
export const hideFrames = () => setFramed(false);

/** Whether a contraption is showing over Citadel's page. */
export const framed = () => document.documentElement.classList.contains('framed');

/** Signing out: drop every frame, so the next person never sees one. */
export function dropFrames() {
  setFramed(false);
  box?.remove();
  box = null;
  frames.clear();
}

function setFramed(on) {
  document.documentElement.classList.toggle('framed', on);
  for (const el of document.querySelectorAll('body > .topbar, body > main')) el.inert = on;
}

// The contraptions that take shares from the phone's Share sheet (#375), in order of preference. Only
// Mandate so far, so a share goes straight to it; a second one would want a picker here.
const SHARE_TAKERS = ['mandate'];

/**
 * Where a share goes (#/share?title=&text=&url=, from the manifest's share_target): the first of your
 * contraptions `mine` (GET api/contraptions/mine) that takes shares, at its address with each field
 * passed on as it came, as share_title, share_text and share_url; null when none of yours takes shares.
 */
export function shareTarget(search, mine) {
  const name = SHARE_TAKERS.find((n) => mine?.some?.((c) => c.name === n));
  if (!name) return null;
  const got = new URLSearchParams(search);
  const params = new URLSearchParams();
  for (const k of ['title', 'text', 'url']) if (got.has(k)) params.set(`share_${k}`, got.get(k));
  return { name, src: `/apps/${name}/?${params}` };
}
