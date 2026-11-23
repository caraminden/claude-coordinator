// Which app a right-click in the desktop app's window landed in (#1691), kept apart from Electron so
// test/desktop-app-frame.test.ts can run it. An app (a contraption) shows in a frame of Citadel's page at /apps/<name>/:
// on its own host when APPS_DOMAIN is set (live: <name>.citadel.zip, src/apps.ts), else on Citadel's. So the path decides,
// not the origin. A frame inside the app (its own embed) counts as the app.
// `frame` is the WebFrameMain the context-menu event names. Returns the app's frame, or null: Citadel's own page, a frame
// at another path, a frame that is gone.
function appFrame(frame) {
  let f = frame;
  while (f?.parent?.parent) f = f.parent;
  if (!f?.parent) return null;
  try {
    const url = new URL(f.url);
    return /^https?:$/.test(url.protocol) && url.pathname.startsWith('/apps/') ? f : null;
  } catch { return null; }
}
module.exports = { appFrame };
