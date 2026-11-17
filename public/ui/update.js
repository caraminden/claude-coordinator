// Citadel UI: the Android update banner (#837). Served to apps as /apps/_citadel/ui/update.js (types: update.d.ts beside
// it); its look is base.css's cui-notice and cui-btn. Docs: kit/skills/android-app/SKILL.md, "Delivery".
//
// Standalone like every file in public/ui/ (see tip.js's header): no imports, cui-* classes only, and its exports are an
// API apps depend on (test/ui-contract.test.ts).
//
// A Capacitor app's web layer calls mountUpdate() once it starts. Inside the Android app (never in a browser) it reads the
// feed Citadel publishes after each deploy (src/apk-build.ts): android/latest.json, { "versionCode": N, "apk": "<file>",
// "versionName"?, "commit"? }, the apk relative to the feed. When N is above the installed build (App.getInfo().build), it
// shows "A new version of the app is ready" with an "Update the app" button that opens the APK in the system browser,
// where Android's installer takes over. Offline, or with no feed, it shows nothing.

/**
 * The update waiting for this app, or null: none newer, not inside the Android app, or the feed can't be read.
 * `feed` is resolved against the page (default 'android/latest.json').
 */
export async function checkUpdate(opts = {}) {
  const cap = globalThis.Capacitor;
  const app = cap?.isNativePlatform?.() ? cap.Plugins?.App : null;
  if (!app?.getInfo) return null;
  try {
    const feed = new URL(opts.feed ?? 'android/latest.json', document.baseURI);
    const [info, latest] = await Promise.all([app.getInfo(), fetch(feed, { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null))]);
    const code = latest?.versionCode;
    if (!Number.isInteger(code) || typeof latest.apk !== 'string' || !(code > Number(info?.build))) return null;
    return { versionCode: code, versionName: typeof latest.versionName === 'string' ? latest.versionName : null, url: new URL(latest.apk, feed).href };
  } catch {
    return null;
  }
}

/** Open `url` outside the app's WebView: Capacitor's Browser or AppLauncher plugin when the app has one, else a plain navigation. */
function openOutside(url) {
  const p = globalThis.Capacitor?.Plugins ?? {};
  if (p.Browser?.open) return p.Browser.open({ url });
  if (p.AppLauncher?.openUrl) return p.AppLauncher.openUrl({ url });
  location.href = url;
}

/**
 * Check for an update and, when there is one, put the banner at the top of `parent` (default document.body). `open(url)`
 * replaces how the APK is opened (an app with a plugin of its own); `text` and `button` replace the words. Resolves to the
 * banner element, or null when there's nothing to show.
 */
export async function mountUpdate(parent = document.body, opts = {}) {
  const update = await checkUpdate(opts);
  if (!update) return null;
  const banner = document.createElement('div');
  banner.className = 'cui-notice cui-update';
  banner.dataset.tone = 'info';
  banner.setAttribute('role', 'status');
  const say = document.createElement('span');
  say.textContent = opts.text ?? 'A new version of the app is ready.';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'cui-btn cui-small cui-primary';
  button.textContent = opts.button ?? 'Update the app';
  button.addEventListener('click', () => {
    void Promise.resolve((opts.open ?? openOutside)(update.url)).catch(() => { location.href = update.url; });
  });
  banner.append(say, ' ', button);
  parent.prepend(banner);
  return banner;
}
