// Citadel UI: polling that rests while the tab is hidden (#1394). Served to apps as /apps/_citadel/ui/visible.js (types:
// visible.d.ts beside it). Standalone like every file in public/ui/ (see tip.js's header): no imports, and its exports are an
// API apps depend on (test/ui-contract.test.ts).
//
// A hidden tab (another tab in front, a minimised window, a locked phone) has nobody to show a refresh to, so a page that
// keeps polling spends its app's server and the person's battery for nothing. pollWhileVisible() is setInterval that stops
// while the tab is hidden and, when it is shown again, refreshes once at once and goes on with the same interval.

/**
 * Call `fn` every `ms` while the page is visible. While it is hidden nothing runs; when it comes back, `fn` runs once
 * straight away (the page may have missed changes) and the interval starts over. It does not call `fn` when started: call
 * it yourself for the first load. A hidden page at start waits for its first show. `fn` may be async: a run still going is
 * not stacked under the next tick. Returns a function that stops it for good.
 * `opts.document` is for tests.
 * @type {typeof import('./visible.js').pollWhileVisible}
 */
export function pollWhileVisible(fn, ms, opts = {}) {
  const doc = opts.document ?? document;
  /** @type {ReturnType<typeof setInterval> | undefined} */
  let timer;
  let busy = false;
  let stopped = false;
  const run = async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      await fn();
    } catch {
      // a failed poll is the caller's to show; the next tick tries again
    } finally {
      busy = false;
    }
  };
  const start = () => {
    clearInterval(timer);
    timer = setInterval(run, ms);
  };
  const stop = () => {
    clearInterval(timer);
    timer = undefined;
  };
  const onChange = () => {
    if (stopped) return;
    if (doc.hidden) return stop();
    run();
    start();
  };
  doc.addEventListener('visibilitychange', onChange);
  if (!doc.hidden) start();
  return () => {
    stopped = true;
    stop();
    doc.removeEventListener('visibilitychange', onChange);
  };
}
