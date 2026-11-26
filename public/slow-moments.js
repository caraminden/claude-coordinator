// The slow-load recorder (#1752): any request, page opening or frozen tab on this page that waits over 2 s is noted
// with where the time went: the server (its Server-Timing stamp, src/front.ts stampServerTime), the tab (the main
// thread blocked, from a heartbeat timer running late) and the network (the rest). A classic script before app.js, so
// it hears the page open; base.js api() reports each request to it, and core.js's route() dims the page (body
// .navigating) while it opens one. The report goes out a moment after the pause ends, kept on this device until it's
// taken, so a tab that froze or was offline sends it later or on its next load. It never throws and never holds up the page.
(() => {
  // Tests turn the times down (test/slow-recorder-browser.test.ts sets this before the script runs); a page never does.
  /** @type {{ slow?: number, sendAfterLoad?: number }} */
  const knob = /** @type {{ citadelSlowKnobs?: { slow?: number, sendAfterLoad?: number } }} */ (globalThis).citadelSlowKnobs ?? {};
  const SLOW = knob.slow ?? 2000,
    TICK = 250,
    KEY = 'cc-slow-moments',
    KEEP = 20,
    KEPT_MS = 120_000;
  // A gap this long is a sleeping computer, not a frozen tab. shortcut: a real freeze longer than this goes unrecorded; raise it if one ever does.
  const ASLEEP = 120_000;
  const tab = Math.random().toString(36).slice(2, 6);
  const ua = navigator.userAgent;
  const device =
    [/Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iPhone' : /Mac/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'Other', /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'browser'].join(
      ' · ',
    ) + (matchMedia('(display-mode: standalone), (display-mode: window-controls-overlay)').matches ? ' · installed app' : '');

  /**
   * @typedef {{ kind: string, what: string, start: number, end: number, server: number | null, page: string }} Moment
   * @typedef {[number, number, number | null, string]} Request
   */
  /**
   * @param {[number, number, ...unknown[]][]} list
   * @param {number} now
   */
  const trim = (list, now) => {
    while (list.length && list[0][1] < now - KEPT_MS) list.shift();
  };
  // The heartbeat: each time it runs late by over 100 ms, the tab was blocked for that long. Kept two minutes.
  /** @type {[number, number][]} */
  const blocked = []; // [start, end] in performance.now() time
  let last = performance.now();
  setInterval(() => {
    const now = performance.now(),
      late = now - last - TICK;
    last = now;
    if (document.hidden || late < 100 || late > ASLEEP) return; // a hidden tab's timers are slowed on purpose
    blocked.push([now - late, now]);
    trim(blocked, now);
    if (late > SLOW) noteMoment('freeze', '', now - late, now, null);
  }, TICK);
  document.addEventListener('visibilitychange', () => {
    last = performance.now();
  });

  // Every request in the last two minutes, fast ones too: a page opening is often several of them.
  /** @type {Request[]} */
  const requests = []; // [start, end, server ms or null, what]
  // The page's address over time, so a wait is put on the page it started on.
  /** @type {[number, string][]} */
  const pages = [[-Infinity, location.hash || '#/']];
  addEventListener('hashchange', () => {
    pages.push([performance.now(), location.hash || '#/']);
    if (pages.length > 50) {
      pages.shift();
      pages[0][0] = -Infinity;
    }
  });
  /** @param {number} t */
  const pageAt = (t) => /** @type {[number, string]} */ (pages.findLast(([at]) => at <= t))[1];

  /**
   * @param {number} start
   * @param {number} end
   */
  const tabTime = (start, end) => blocked.reduce((sum, [a, b]) => sum + Math.max(0, Math.min(b, end) - Math.max(a, start)), 0);
  /** @param {string | null | undefined} h */
  const serverMs = (h) => {
    const m = /(?:^|,)\s*app;dur=([\d.]+)/.exec(h || '');
    return m ? Number(m[1]) : null;
  };

  /** @type {Moment[]} */
  const note = []; // moments waiting for the heartbeat to catch up, so their tab time is whole
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;
  /**
   * @param {string} kind
   * @param {string} what
   * @param {number} start
   * @param {number} end
   * @param {number | null} server
   */
  function noteMoment(kind, what, start, end, server) {
    if (end - start <= SLOW) return;
    note.push({ kind, what, start, end, server, page: pageAt(start) });
    clearTimeout(/** @type {ReturnType<typeof setTimeout>} */ (timer));
    timer = setTimeout(settle, 1000); // after the heartbeat has measured the pause
  }

  // Each moment's split, then kept and sent. A page opening takes the requests inside it (the slowest names it and
  // gives its server time), and a freeze inside any other moment is already in that moment's tab time.
  function settle() {
    try {
      const moments = note.splice(0);
      const opens = moments.filter((m) => m.kind === 'open');
      /**
       * @param {Moment} m
       * @param {Moment} w
       */
      const inside = (m, w) => w !== m && w.start <= m.start + TICK && w.end >= m.end - TICK;
      for (const o of opens) {
        const within = requests.filter(([a, b]) => a >= o.start - TICK && b <= o.end + TICK);
        const slowest = within.reduce((/** @type {Request | null} */ s, r) => (!s || r[1] - r[0] > s[1] - s[0] ? r : s), null);
        if (slowest) {
          o.what = slowest[3];
          o.server = within.reduce((/** @type {number | null} */ s, r) => (r[2] == null ? s : Math.max(s ?? 0, r[2])), null);
        }
      }
      const rows = moments
        .filter((m) => !(m.kind === 'freeze' && moments.some((w) => w.kind !== 'freeze' && inside(m, w))) && !(m.kind === 'request' && opens.some((o) => inside(m, o))))
        .map((m) => {
          const total = m.end - m.start,
            tabMs = Math.min(total, tabTime(m.start, m.end)),
            server = m.server == null ? null : Math.min(m.server, total - tabMs);
          return { kind: m.kind, what: m.what, page: m.page, at: Math.round(performance.timeOrigin + m.start), tab: tab, total, server, tab_ms: tabMs, network: Math.max(0, total - tabMs - (server ?? 0)) };
        });
      if (rows.length) localStorage.setItem(KEY, JSON.stringify([...kept(), ...rows].slice(-KEEP)));
    } catch {}
    send();
  }
  /** @returns {{ at: number, kind: string, what: string }[]} */
  const kept = () => {
    try {
      return JSON.parse(localStorage.getItem(KEY) || '[]');
    } catch {
      return [];
    }
  };

  let sending = false;
  function send() {
    const moments = kept();
    if (sending || !moments.length) return;
    sending = true;
    fetch('api/slow-moments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device, tab, moments }), keepalive: true })
      .then(
        (res) => {
          // Taken, or refused as it is (signed out, malformed): either way not sent again. Offline or restarting: kept.
          if (res.ok || (res.status >= 400 && res.status < 500)) {
            const left = kept().filter((m) => !moments.some((s) => s.at === m.at && s.kind === m.kind && s.what === m.what));
            if (left.length) localStorage.setItem(KEY, JSON.stringify(left));
            else localStorage.removeItem(KEY);
          }
        },
        () => {},
      )
      .finally(() => {
        sending = false;
      });
  }

  /** @type {{ citadelSlow?: unknown }} */ (globalThis).citadelSlow = {
    /**
     * One request from api(): `start` from performance.now() as it was sent, `res` its answer or null if it failed.
     * @param {string | undefined} method
     * @param {unknown} path
     * @param {number} start
     * @param {Response | null} res
     */
    request(method, path, start, res) {
      try {
        const end = performance.now(),
          what = `${method || 'GET'} ${String(path).split('?')[0].slice(0, 140)}`,
          server = serverMs(res?.headers.get('server-timing'));
        requests.push([start, end, server, what]);
        trim(requests, end);
        noteMoment('request', what, start, end, server);
      } catch {}
    },
  };

  // Opening a page inside Citadel (a scheme, a minion, the Status page): from route() dimming the page to drawing it.
  let loaded = false,
    /** @type {number | null} */
    opening = null;
  const watch = () =>
    new MutationObserver(() => {
      const dim = document.body.classList.contains('navigating');
      if (dim && opening == null) opening = performance.now();
      else if (!dim && opening != null) {
        if (loaded) noteMoment('open', '', opening, performance.now(), null);
        opening = null;
      }
    }).observe(document.body, { attributeFilter: ['class'] });
  if (document.body) watch();
  else document.addEventListener('DOMContentLoaded', watch);

  // Opening Citadel: from the navigation to the page's load event, the HTML's own server time included.
  addEventListener('load', () =>
    setTimeout(() => {
      loaded = true;
      try {
        const nav = /** @type {PerformanceNavigationTiming | undefined} */ (performance.getEntriesByType('navigation')[0]);
        // Served from the service worker's copy (no bytes came over the network), its Server-Timing is an old visit's.
        const server = nav?.transferSize === 0 ? 0 : (nav?.serverTiming?.find((t) => t.name === 'app')?.duration ?? null);
        if (nav) noteMoment('load', '', 0, nav.loadEventStart, server);
      } catch {}
      // What an earlier page kept (it froze, closed or was offline), a while after this one opened.
      setTimeout(send, knob.sendAfterLoad ?? 5000);
    }),
  );
  addEventListener('online', send);
})();
