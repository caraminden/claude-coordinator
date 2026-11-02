// Contraptions inside Citadel's window (#274, Cara 2026-11-02: "Mandate inside Citadel"): #/apps/<name>
// shows the contraption in a frame over Citadel's page, beside the rail. It's inside Citadel's scope, so
// an installed Citadel shows no out-of-scope strip and opens no second window. Each frame stays alive
// once opened, hidden while you're elsewhere, so switching back keeps your place in it; Citadel's page
// stays under it (inert), scroll and all. The framed page's own rail.js draws no rail and lends Citadel's.

const frames = new Map();
let box = null;

/** Show contraption `name` (its frame made on first visit). */
export function showFrame(name) {
  if (!box) {
    box = document.createElement('div');
    box.id = 'frames';
    document.body.append(box);
  }
  let frame = frames.get(name);
  if (!frame) {
    frame = document.createElement('iframe');
    frame.src = `/apps/${name}/`;
    frame.title = name;
    box.append(frame);
    frames.set(name, frame);
  }
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
