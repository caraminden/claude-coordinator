// One contraption's shots (#1783), run inside tools/app-shots/sandbox.sh: start the app's built checkout on an empty
// DATA_DIR against the fake Citadel, signed in as the fake's one test person, put Citadel UI's files in front of it as
// Citadel does, and shoot its front page and the main pages it leads to at both widths. No model, no network, no real data.
import { spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseManifest } from '../../src/app-services.ts';
import { KIT_FILE } from '../../src/front.ts';
import type { Shot } from '../../src/shot-judge.ts';
import { flatShare, readPng } from './picture.ts';
import { themeCss } from '../../src/theme.ts';
import { startFakeCitadel } from '../../kit/skills/contraption-ui/fake-citadel/fake-citadel.ts';
import { findChrome, launch, openPage } from '../../kit/skills/critique/scripts/ui-measure.mjs';

export interface Job {
  app: string;
  folder: string;
  port: number;
  widths: number[];
  /** Main pages at most, the front page included. */
  pages: number;
  out: string;
}
/** The parts of a DevTools event this reads. */
interface Event {
  method: string;
  params: {
    requestId: string;
    type: string;
    request: { url: string };
    response: { url: string; status: number };
    canceled?: boolean;
    errorText: string;
    exceptionDetails: { text: string; exception?: { description?: string } };
    args: { value?: unknown; description?: string }[];
  };
}
export interface Inner {
  boot: string | null;
  shots: Shot[];
  /** The key of every main page found, shot or not. */
  found: string[];
}

const root = join(import.meta.dirname, '..', '..');
/** One page's turn, its load, its settling and its picture: a page that takes longer is stuck. */
const PAGE_MS = 40_000;
/** The whole app's turn: pages not reached by then are left out, so the ones that were still count. */
const ALL_MS = 4 * 60_000;
const within = <T>(ms: number, what: Promise<T>): Promise<T> => {
  let t: NodeJS.Timeout;
  return Promise.race([what, new Promise<never>((_, no) => (t = setTimeout(() => no(new Error(`stuck: not drawn in ${ms / 1000} s`)), ms)))]).finally(() => clearTimeout(t));
};
const TYPES: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const PUBLIC = join(root, 'public');

/** What people see: the app behind Citadel's proxy, its identity header added, and Citadel UI's files. */
async function front(app: string, appPort: number, identity: () => string) {
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (KIT_FILE.test(path)) {
      const name = path.slice('/apps/_citadel/'.length);
      const body = name === 'theme.css' ? themeCss(readFileSync(join(PUBLIC, 'style.css'), 'utf8')) : existsSync(join(PUBLIC, name)) ? readFileSync(join(PUBLIC, name)) : null;
      res.writeHead(body === null ? 404 : 200, { 'content-type': TYPES[extname(name)] ?? 'application/octet-stream' });
      return void res.end(body ?? '');
    }
    // Citadel's own API and the app host's calls: a quiet "not here", which the rail and switcher take as signed out.
    if (path.startsWith('/api/') || path.startsWith('/_citadel/') || path.startsWith('/apps/_citadel/')) {
      res.writeHead(204);
      return void res.end();
    }
    const up = request({ host: '127.0.0.1', port: appPort, method: req.method, path: req.url, headers: { ...req.headers, 'x-citadel-identity': identity() } }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on('error', () => res.headersSent || res.writeHead(502).end('Bad Gateway'));
    req.pipe(up);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  return { port: typeof addr === 'object' && addr ? addr.port : 0, close: () => new Promise((r) => (server.closeAllConnections(), server.close(r))) };
}

/** Where an app keeps the buttons that switch pages. */
const NAV = '[role=tab], nav button, [role=navigation] button, aside [role=button], .cui-rail button, header.cui-topbar button';

/** The main pages a front page leads to: its own links, one of each shape, then its nav's buttons and tabs. */
const FIND_PAGES = (base: string) => `(() => {
  const seen = new Set(), out = [];
  const visible = (el) => el.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) ?? true;
  for (const a of document.querySelectorAll('a[href]')) {
    const u = new URL(a.href, location.href);
    if (u.origin !== location.origin || !(u.pathname + '/').startsWith(${JSON.stringify(base + '/')}) || a.hasAttribute('download')) continue;
    if (/\\.(?!html$)[a-z0-9]{1,8}$/i.test(u.pathname) || /\\/(api|logout|export|download|android)(\\/|$)/i.test(u.pathname)) continue;
    // A hash that names nothing on the page is a route of its own.
    const hash = u.hash.length > 1 && !document.getElementById(decodeURIComponent(u.hash.slice(1))) ? u.hash : '';
    const at = (u.pathname.slice(${base.length}) || '/') + hash;
    if (at === '/' || at === '/#/') continue;
    const shape = at.replace(/(?=[a-f]*\\d)[0-9a-f]{6,}|\\d+/gi, '#');
    if (!seen.has(shape)) seen.add(shape), out.push({ key: shape, path: at });
  }
  const labels = new Set();
  for (const b of document.querySelectorAll('${NAV}')) {
    const label = (b.innerText || b.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim();
    if (!label || label.length > 30 || b.disabled || !visible(b) || labels.has(label)) continue;
    if (/log ?out|sign out|delete|remove|close|menu|theme/i.test(label)) continue;
    labels.add(label), out.push({ key: '> ' + label, click: label });
  }
  return out;
})()`;

const CLICK = (label: string) => `(() => {
  // textContent too: what a closed drawer holds has no innerText, and a click still opens its page.
  const is = (t) => (t || '').replace(/\\s+/g, ' ').trim() === ${JSON.stringify(label)};
  const all = [...document.querySelectorAll('${NAV}')].filter((b) => is(b.innerText) || is(b.textContent) || is(b.getAttribute('aria-label')));
  const b = all.find((x) => x.checkVisibility?.() ?? true) ?? all[0];
  b?.click();
  return !!b;
})()`;

async function run(job: Job): Promise<Inner> {
  const manifest = parseManifest(readFileSync(join(job.folder, 'citadel-app.json'), 'utf8'));
  const home = homedir();
  const tilde = (s: string) => s.replace(/^~(?=\/)/, home);
  const fake = await startFakeCitadel({ app: job.app });
  const base = `/apps/${job.app}`;
  const real = realpathSync(job.folder);
  // As its unit has it (unitFiles): its paths are the real ones, which the sandbox made empty.
  const env: NodeJS.ProcessEnv = {
    PATH: `${home}/.local/share/mise/shims:${home}/.local/bin:/usr/local/bin:/usr/bin:/bin`,
    HOME: home,
    USER: process.env.USER,
    LANG: process.env.LANG ?? 'C.UTF-8',
    TZ: process.env.TZ,
    TMPDIR: '/tmp',
    ...Object.fromEntries(Object.entries(manifest.env).map(([k, v]) => [k, tilde(v)])),
    PORT: String(job.port),
    DATA_DIR: join(home, '.local/share', job.app),
    CITADEL_KEYS: fake.keysDir,
    CITADEL_URL: fake.url,
    BASE_PATH: base,
    MISE_TRUSTED_CONFIG_PATHS: [job.folder, real, manifest.env.MISE_TRUSTED_CONFIG_PATHS && tilde(manifest.env.MISE_TRUSTED_CONFIG_PATHS)].filter(Boolean).join(':'),
    // mise reads the real path of a deploy slot's link.
    MISE_CEILING_PATHS: [join(job.folder, '..'), join(real, '..')].join(':'),
  };
  // As the live one exists already.
  mkdirSync(env.DATA_DIR!, { recursive: true });
  const child = spawn(tilde(manifest.start[0]), manifest.start.slice(1), { cwd: join(job.folder, manifest.workdir), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  let gone: string | null = null;
  for (const s of [child.stdout, child.stderr]) s.on('data', (d) => (log = (log + d).slice(-3000)));
  child.on('error', (e) => (gone = e.message));
  child.on('exit', (code, sig) => (gone = `it exited (${sig ?? code})`));
  const health = manifest.health ?? `${base}/`;
  for (const end = Date.now() + 60_000; ; await sleep(300)) {
    if (gone) return { boot: `${gone}\n${log}`, shots: [], found: [] };
    if (Date.now() > end) return { boot: `it didn't answer ${health} in 60 s\n${log}`, shots: [], found: [] };
    const ok = await fetch(`http://127.0.0.1:${job.port}${health}`, { headers: { 'x-citadel-identity': fake.identity() }, redirect: 'manual', signal: AbortSignal.timeout(5000) }).then(
      (r) => r.status < 500,
      () => false,
    );
    if (ok) break;
  }
  const proxy = await front(job.app, job.port, () => fake.identity());
  const bin = findChrome();
  if (!bin) throw new Error('no browser');
  const browser = launch(bin);
  const origin = `http://127.0.0.1:${proxy.port}`;
  const url = (path: string) => `${origin}${base}${path}`;
  const shots: Shot[] = [];
  const until = Date.now() + ALL_MS;
  try {
    const list: { key: string; path?: string; click?: string }[] = [{ key: '/', path: '/' }];
    for (let i = 0; i < list.length && i < job.pages && Date.now() < until; i++) {
      for (const width of job.widths) {
        const p = list[i];
        const s: Shot = { page: p.key, width, file: null, thumb: null, status: 0, text: '', errors: [], flat: 0, moved: null, was: null, since: null, failed: null };
        const add = (e: string) => void (s.errors.length < 10 && !s.errors.includes(e) && s.errors.push(e));
        const asked = new Map<string, { url: string; type: string }>();
        // Only this page's own requests count: the sandbox has no way out, so another host's always fail.
        const own = (u: string) => u.startsWith(origin);
        const stop = browser.send.listen((m: Event) => {
          const x = m.params;
          if (m.method === 'Network.requestWillBeSent') asked.set(x.requestId, { url: x.request.url, type: x.type });
          else if (m.method === 'Network.responseReceived' && own(x.response.url)) {
            if (x.type === 'Document' && !s.status) s.status = x.response.status;
            // 502 to 504: the app's own upstream (another site), which the room has no way out to.
            else if (x.response.status >= 400 && !(x.response.status >= 502 && x.response.status <= 504) && !/favicon\.ico/.test(x.response.url)) add(`HTTP ${x.response.status} from ${new URL(x.response.url).pathname}`);
          } else if (m.method === 'Network.loadingFailed' && !x.canceled && own(asked.get(x.requestId)?.url ?? '')) add(`${x.errorText} from ${new URL(asked.get(x.requestId)!.url).pathname}`);
          else if (m.method === 'Runtime.exceptionThrown')
            add(
              String(x.exceptionDetails.exception?.description ?? x.exceptionDetails.text)
                .split('\n')[0]
                .replaceAll(origin, ''),
            );
          else if (m.method === 'Runtime.consoleAPICalled' && x.type === 'error')
            add(
              x.args
                .map((a) => a.value ?? a.description ?? '')
                .join(' ')
                .split('\n')[0]
                .replaceAll(origin, '')
                .slice(0, 300),
            );
        });
        let page: Awaited<ReturnType<typeof openPage>> | null = null;
        try {
          const drawn = await within(
            PAGE_MS,
            (async () => {
              page = await openPage(browser.send, url(p.path ?? '/'), width, { headers: [], cookies: [], dark: false, media: [{ name: 'prefers-reduced-motion', value: 'reduce' }], settle: 1500 });
              if (p.click) {
                // A tab the other width alone has.
                if (!(await page!.evaluate(CLICK(p.click)))) return false;
                await sleep(1000);
              }
              await page!.settle({ network: true, pointer: true });
              if (i === 0) list.push(...((await page!.evaluate(FIND_PAGES(base))) as typeof list).filter((x) => !list.some((y) => y.key === x.key)));
              s.text = ((await page!.evaluate(`(document.body?.innerText ?? '').slice(0, 400)`)) as string).trim();
              const png = Buffer.from((await page!.s('Page.captureScreenshot', { format: 'png' })).data, 'base64');
              const webp = Buffer.from((await page!.s('Page.captureScreenshot', { format: 'webp', quality: 70, clip: { x: 0, y: 0, width: page.width, height: page.height, scale: width > 800 ? 0.5 : 0.6 } })).data, 'base64');
              s.flat = flatShare(readPng(png));
              const name = `${i}-${
                p.key
                  .replace(/[^a-z0-9]+/gi, '-')
                  .replace(/^-|-$/g, '')
                  .slice(0, 40) || 'front'
              }-${width}`;
              writeFileSync(join(job.out, `${name}.png`), png);
              writeFileSync(join(job.out, `${name}.webp`), webp);
              [s.file, s.thumb] = [`${name}.png`, `${name}.webp`];
              return true;
            })(),
          );
          if (!drawn) continue;
          shots.push(s);
        } catch (e) {
          s.failed = String((e as Error).message ?? e).replaceAll(origin, '');
          shots.push(s);
        } finally {
          stop();
          await within(5000, (page as { close(): Promise<unknown> } | null)?.close() ?? Promise.resolve()).catch(() => {});
        }
        // Died under a page: the rest of it would only say the same.
        if (gone) return { boot: `it died while its pages were open: ${gone}\n${log}`, shots, found: list.map((x) => x.key) };
      }
    }
    return { boot: null, shots, found: list.map((x) => x.key) };
  } finally {
    await within(5000, browser.close()).catch(() => {});
    await within(5000, proxy.close()).catch(() => {});
    child.kill('SIGKILL');
    await within(5000, fake.close()).catch(() => {});
  }
}

const job: Job = JSON.parse(process.argv[2]);
const answer = await run(job);
writeFileSync(join(job.out, 'inner.json'), JSON.stringify(answer));
process.exit(0);
