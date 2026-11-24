// The slow-load recorder (#1752): any request, page opening or frozen tab on this page that waits over 2 s is noted
// with where the time went: the server (its Server-Timing stamp, src/front.ts stampServerTime), the tab (the main
// thread blocked, from a heartbeat timer running late) and the network (the rest). A classic script before app.js, so
// it hears the page open; base.js api() reports each request to it. The report goes out a moment after the pause
// ends, kept on this device until it's taken, so a tab that froze or was offline sends it later or on its next load.
// It never throws and never holds up the page.
(() => {
  const SLOW = 2000, TICK = 250, KEY = 'cc-slow-moments', KEEP = 20;
  // A gap this long is a sleeping computer, not a frozen tab. shortcut: a real freeze longer than this goes unrecorded; raise it if one ever does.
  const ASLEEP = 120_000;
  const tab = Math.random().toString(36).slice(2, 6);
  const ua = navigator.userAgent;
  const device = [
    /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iPhone' : /Mac/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'Other',
    /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'browser',
  ].join(' · ') + (matchMedia('(display-mode: standalone), (display-mode: window-controls-overlay)').matches ? ' · app' : '');

  // The heartbeat: each time it runs late by over 100 ms, the tab was blocked for that long. Kept two minutes.
  const blocked = []; // [start, end] in performance.now() time
  let last = performance.now();
  const note = [];   // moments waiting for the heartbeat to catch up, so their tab time is whole
  setInterval(() => {
    const now = performance.now(), late = now - last - TICK;
    last = now;
    if (document.hidden || late < 100 || late > ASLEEP) return; // a hidden tab's timers are slowed on purpose
    blocked.push([now - late, now]);
    while (blocked.length && blocked[0][1] < now - 120_000) blocked.shift();
    if (late > SLOW) noteMoment('freeze', '', now - late, now, null);
  }, TICK);
  document.addEventListener('visibilitychange', () => { last = performance.now(); });

  const tabTime = (start, end) => blocked.reduce((sum, [a, b]) => sum + Math.max(0, Math.min(b, end) - Math.max(a, start)), 0);
  const serverMs = (h) => { const m = /(?:^|,)\s*app;dur=([\d.]+)/.exec(h || ''); return m ? Number(m[1]) : null; };

  let timer = null;
  function noteMoment(kind, what, start, end, server) {
    if (end - start <= SLOW) return;
    note.push({ kind, what, start, end, server, page: location.hash || '#/' });
    clearTimeout(timer);
    timer = setTimeout(settle, 1000); // after the heartbeat has measured the pause
  }

  // Each moment's split, the freezes a request or opening already covers dropped, then kept and sent.
  function settle() {
    try {
      const waits = note.filter((m) => m.kind !== 'freeze');
      const rows = note.splice(0).filter((m) => m.kind !== 'freeze' || !waits.some((w) => w.start <= m.start + TICK && w.end >= m.end - TICK)).map((m) => {
        const total = m.end - m.start, tabMs = Math.min(total, tabTime(m.start, m.end)), server = m.server == null ? null : Math.min(m.server, total - tabMs);
        return { kind: m.kind, what: m.what, page: m.page, at: Math.round(performance.timeOrigin + m.start), total, server, tab: tabMs, network: Math.max(0, total - tabMs - (server ?? 0)) };
      });
      if (rows.length) localStorage.setItem(KEY, JSON.stringify([...kept(), ...rows].slice(-KEEP)));
    } catch {}
    send();
  }
  const kept = () => { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; } };

  let sending = false;
  function send() {
    const moments = kept();
    if (sending || !moments.length) return;
    sending = true;
    fetch('api/slow-moments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device, tab, moments }), keepalive: true })
      .then((res) => {
        // Taken, or refused as it is (signed out, malformed): either way not sent again. Offline or restarting: kept.
        if (res.ok || (res.status >= 400 && res.status < 500)) {
          const left = kept().filter((m) => !moments.some((s) => s.at === m.at && s.kind === m.kind && s.what === m.what));
          if (left.length) localStorage.setItem(KEY, JSON.stringify(left)); else localStorage.removeItem(KEY);
        }
      }, () => {})
      .finally(() => { sending = false; });
  }

  globalThis.citadelSlow = {
    /** One request from api(): `start` from performance.now() as it was sent, `res` its answer or null if it failed. */
    request(method, path, start, res) {
      try { noteMoment('request', `${method || 'GET'} ${String(path).split('?')[0].slice(0, 140)}`, start, performance.now(), serverMs(res?.headers.get('server-timing'))); } catch {}
    },
  };

  // Opening Citadel: from the navigation to the page's load event, the HTML's own server time included.
  addEventListener('load', () => setTimeout(() => {
    try {
      const nav = performance.getEntriesByType('navigation')[0];
      const server = nav?.serverTiming?.find((t) => t.name === 'app')?.duration ?? null;
      if (nav) noteMoment('load', '', 0, nav.loadEventStart, server);
    } catch {}
    // What an earlier page kept (it froze, closed or was offline), a while after this one opened.
    setTimeout(send, 5000);
  }));
  addEventListener('online', send);
})();
