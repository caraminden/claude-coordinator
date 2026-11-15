// The front-end error beacon (#724): uncaught errors and unhandled rejections go to /api/client-errors, where the
// post-deploy watch counts them before and after each deploy. A classic script before app.js, so it hears errors
// from the very first module. Each distinct error is sent once per page, at most 10 per page, and it never throws.
(() => {
  const seen = new Set();
  // A restart's dropped connections aren't the code's fault, and would be blamed on every deploy that restarts.
  const NETWORK = /Failed to fetch|NetworkError|Load failed|network error|AbortError|aborted/i;
  const send = (kind, message, source, line) => {
    try {
      message = String(message ?? '').slice(0, 300);
      const key = `${kind}|${message}|${source}|${line}`;
      if (!message || message === 'Script error.' || NETWORK.test(message) || seen.size >= 10 || seen.has(key)) return;
      seen.add(key);
      const body = JSON.stringify({ kind, message, source: String(source ?? '').slice(0, 300), line: Number(line) || 0 });
      fetch('api/client-errors', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
    } catch {}
  };
  addEventListener('error', (e) => e instanceof ErrorEvent && send('error', e.error?.message ?? e.message, e.filename, e.lineno));
  addEventListener('unhandledrejection', (e) => {
    try {
      const r = e.reason;
      const at = /(https?:\/\/[^\s)]+):(\d+):\d+/.exec(String(r?.stack ?? ''));
      send('rejection', r?.message ?? r, at?.[1], at?.[2]);
    } catch {}
  });
})();
