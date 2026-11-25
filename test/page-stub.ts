// A stand-in Citadel server inside the page, for tests of the real front end (public/index.html) in headless Chromium:
// serveApp's `stub`, run before app.js, so fetch and the event stream are answered in the page and nothing reaches a server.
// Builds the fixture only: tests make their own asserts.

/**
 * `code` runs in the page after the shared parts, with `now`, `me` and `reply(status, body)` (a JSON Response) in scope.
 * It may define `function route(path, url, init)`: a Response, or a promise of one, for the paths it answers (`path` has
 * no leading slash) and undefined for the rest, which get the fallbacks: api/me is `me`, an inbox is empty, anything
 * else `[]`. The stream is `window.es` (send it a message with `es.onmessage({ data: JSON.stringify(msg) })`); `open`
 * fires its onopen, `hello` sends the server's hello after 100 ms.
 */
export const pageStub = (code: string, { open = false, hello = false } = {}) => `<script>
  const now = Date.now();
  const me = { name: 'Cara', login: 'cara', admin: true, uid: 1 };
  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  window.EventSource = class {
    constructor() {
      window.es = this;${open ? '\n      setTimeout(() => this.onopen?.());' : ''}${hello ? "\n      setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type: 'hello', usage: {}, version: 'v1' }) }), 100);" : ''}
    }
    addEventListener() {}
    close() {}
  };
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    const path = url.pathname.replace(/^\\//, '');
    const answer = typeof route === 'function' ? await route(path, url, init) : undefined;
    if (answer) return answer;
    if (path === 'api/me') return reply(200, me);
    if (/inbox$/.test(path)) return reply(200, { items: [] });
    return reply(200, []);
  };
${code}
</script>`;
