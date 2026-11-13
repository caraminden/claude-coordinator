// Screenshots of this worktree's Citadel, and pages driven by a few steps, in seconds (#639): the one way a
// minion shoots or tries a UI change, instead of a hand-rolled DevTools script.
//
//   node tools/ui-shot.ts [<route>...] [--widths 1440,390] [--themes light,dark] [--steps <file>] [--step <line>]
//                         [--media <name=value>] [--titlebar <l,r,h>] [--safe-area <top,bottom>] [--before <js>]
//                         [--wait <selector>] [--anon] [--url <url> --cookie <name=value>] [--out <dir>]
//
// A route is the hash after the URL ('#/p/2/t/639', '#/p/2/settings'); none, or '/', is the front door. Each
// route is shot at each width and theme, as <out>/<route>-<width>[-dark].png (out: $TMPDIR/ui-shot).
//
// It reuses this worktree's dev copy (citadel-dev-copy; started here if none runs, and left running for the
// next shot) and first makes it re-read public/, which the server otherwise keeps as it was at boot, so the
// shot shows the CSS and JS on disk now. A change to server.ts or src/ still needs `citadel-dev-copy start`
// again. --url and --cookie (or $DEV_URL and $DEV_COOKIE) point it at another server instead, with no reload.
// One headless browser for every shot, each in its own context. A page is ready once #app is drawn, the
// route's dim (body.navigating) has cleared and fonts are in, never on network idle (the page keeps an
// EventSource open). A load or step that hangs fails alone, naming it; the rest go on.
//
// Steps drive the page after it is ready, one a line (# starts a comment); with steps, only `shot` lines shoot,
// or the end if there are none. Selectors are CSS; clicks and keys are real input events.
//   click <selector>            scroll it into view and click its centre
//   type <selector> | <text>    focus it and type the text
//   key <Enter|Escape|Tab|...>  press one key
//   wait <selector>             until it exists (20 s)
//   text <selector>             print its text
//   sleep <ms>
//   eval <js>                   run it in the page (async; may await) and print what it returns
//   shot <name>                 save <route>-<width>[-dark]-<name>.png
//
// Emulation:
//   --media prefers-reduced-motion=reduce          any CSS media feature (repeatable). Chromium ignores
//   --media display-mode=window-controls-overlay   display-mode, so ui-shot rewrites it in the page's
//                                                  stylesheets and matchMedia instead
//   --titlebar 0,138,33                            env(titlebar-area-*): px kept for window controls on the
//                                                  left and right, and the strip's height (the default
//                                                  with display-mode=window-controls-overlay; a Mac is 80,0,28)
//   --safe-area 47,34                              env(safe-area-inset-top/bottom), as a notched phone
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
// @ts-ignore: plain JS from the kit
import { findChrome, launch, openPage, shot } from '../kit/skills/critique/scripts/ui-measure.mjs';

const root = resolve(import.meta.dirname, '..');
const TIMEOUT_MS = 20_000;
const VERBS = ['click', 'type', 'key', 'wait', 'text', 'sleep', 'eval', 'shot'];

type Step = { verb: string; arg: string; text?: string };
interface Opts {
  routes: string[]; widths: number[]; themes: string[]; steps: Step[]; media: { name: string; value: string }[];
  titlebar?: [number, number, number]; safeArea?: [number, number]; before?: string; wait?: string; anon: boolean;
  url?: string; cookie?: string; out: string;
}

/** One step a line; blank lines and # comments are skipped. */
export function parseSteps(src: string): Step[] {
  const steps: Step[] = [];
  for (const raw of src.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const verb = line.split(/\s/, 1)[0];
    const arg = line.slice(verb.length).trim();
    if (!VERBS.includes(verb)) throw new Error(`step "${line}": the verbs are ${VERBS.join(', ')}`);
    if (!arg) throw new Error(`step "${line}" needs ${verb === 'shot' ? 'a name' : 'an argument'}`);
    if (verb === 'type') {
      const bar = arg.indexOf(' | ');
      if (bar < 0) throw new Error(`step "${line}": type <selector> | <text>`);
      steps.push({ verb, arg: arg.slice(0, bar).trim(), text: arg.slice(bar + 3) });
    } else if (verb === 'sleep' && !(Number(arg) >= 0)) throw new Error(`step "${line}": sleep takes ms`);
    else if (verb === 'shot' && !/^[\w-]+$/.test(arg)) throw new Error(`step "${line}": a shot's name is letters, digits, - and _`);
    else steps.push({ verb, arg });
  }
  return steps;
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): Opts {
  const o: Opts = { routes: [], widths: [1440, 390], themes: ['light'], steps: [], media: [], anon: false, url: env.DEV_URL || undefined, cookie: env.DEV_COOKIE || undefined, out: join(env.TMPDIR || tmpdir(), 'ui-shot') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === '--widths') o.widths = val().split(',').map(Number);
    else if (a === '--themes') o.themes = val().split(',');
    else if (a === '--steps') o.steps.push(...parseSteps(readFileSync(val(), 'utf8')));
    else if (a === '--step') o.steps.push(...parseSteps(val()));
    else if (a === '--media') {
      const [name, value] = val().split('=');
      if (!name || !value) throw new Error('--media takes name=value, like display-mode=standalone');
      o.media.push({ name, value });
    } else if (a === '--titlebar') {
      const t = val().split(',').map(Number);
      if (t.length !== 3 || !t.every((n) => n >= 0)) throw new Error('--titlebar takes left,right,height in px, like 0,138,33');
      o.titlebar = t as [number, number, number];
    } else if (a === '--safe-area') {
      const [top, bottom] = val().split(',').map(Number);
      if (!(top >= 0 && bottom >= 0)) throw new Error('--safe-area takes top,bottom in px, like 47,34');
      o.safeArea = [top, bottom];
    } else if (a === '--before') o.before = val();
    else if (a === '--wait') o.wait = val();
    else if (a === '--anon') o.anon = true;
    else if (a === '--url') o.url = val();
    else if (a === '--cookie') o.cookie = val();
    else if (a === '--out') o.out = resolve(val());
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else o.routes.push(a === '/' ? '' : a);
  }
  if (!o.routes.length) o.routes.push('');
  if (o.routes.some((r) => r && !r.startsWith('#'))) throw new Error("a route is a hash, like '#/p/2/t/639' (or '/' for the front door)");
  if (o.widths.some((w) => !(w > 0))) throw new Error('--widths takes numbers, like 1440,390');
  if (o.themes.some((t) => t !== 'light' && t !== 'dark')) throw new Error('--themes takes light, dark or light,dark');
  if (o.url && !/^https?:\/\//.test(o.url)) throw new Error('--url takes the server, like http://127.0.0.1:12345/');
  if (o.url && !o.url.endsWith('/')) o.url += '/';
  if (o.cookie && !o.cookie.includes('=')) throw new Error('--cookie takes name=value, like cc_session=...');
  if (!o.titlebar && o.media.some((m) => m.name === 'display-mode' && m.value === 'window-controls-overlay')) o.titlebar = [0, 138, 33];
  return o;
}

/** The file name for one shot: the route's words, the width, then the theme, media and step's name when given. */
export function shotName(route: string, width: number, theme: string, media: Opts['media'], step = ''): string {
  const slug = route.replace(/^#\/?/, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'front';
  return [slug, width, theme === 'dark' ? 'dark' : '', ...media.map((m) => m.value), step].filter(Boolean).join('-') + '.png';
}

/**
 * Run in the page before its own scripts: display-mode and env(titlebar-area-*) as an installed app has them.
 * Chromium's media emulation ignores display-mode, so the queries are rewritten: in matchMedia now, and in
 * the stylesheets by window.__uiShotEmulate() once they have loaded.
 */
export function emulation(mode: string | undefined, titlebar: [number, number, number] | undefined): string {
  return `(() => {
  const mode = ${JSON.stringify(mode ?? null)}, bar = ${JSON.stringify(titlebar ?? null)};
  const fix = (q) => mode ? q.replace(/\\(\\s*display-mode\\s*:\\s*([a-z-]+)\\s*\\)/gi, (_, m) => (m === mode ? '(min-width: 0px)' : '(max-width: 0px)')) : q;
  const mm = window.matchMedia.bind(window);
  window.matchMedia = (q) => mm(fix(String(q)));
  const area = () => ({ x: bar[0], y: 0, width: innerWidth - bar[0] - bar[1], height: bar[2] });
  const env = (v) => (bar ? v.replace(/env\\(\\s*titlebar-area-(x|y|width|height)\\s*(?:,(?:[^()]|\\([^()]*\\))*)?\\)/g, (_, k) => area()[k] + 'px') : v);
  const walk = (rules) => {
    for (const r of rules) {
      if (r instanceof CSSMediaRule) { const t = fix(r.media.mediaText); if (t !== r.media.mediaText) r.media.mediaText = t; }
      if (r.style) for (const p of [...r.style]) { const v = r.style.getPropertyValue(p); if (v.includes('titlebar-area-')) r.style.setProperty(p, env(v), r.style.getPropertyPriority(p)); }
      if (r.cssRules) walk(r.cssRules);
    }
  };
  window.__uiShotEmulate = () => { for (const s of document.styleSheets) { try { walk(s.cssRules); } catch {} } };
})();`;
}

interface Server { url: string; cookie?: string; pid?: number; log?: string }

/** This worktree's dev copy: the running one, or one started now (on a copy of the live data when this turn can see it). */
function devCopy(): Server {
  const home = join(process.env.TMPDIR || '', 'dev-copy');
  const run = (...a: string[]) => execFileSync(process.execPath, [join(root, 'tools/dev-copy.ts'), ...a], { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  let up = false;
  try {
    run('status');
    up = true;
  } catch {}
  if (!up) {
    const live = existsSync(join(process.env.CITADEL_LIVE_DATA_DIR || join(homedir(), '.local/share/claude-coordinator'), 'coordinator.db'));
    run('start', '--data', live ? 'copy' : 'empty');
    console.log(`Started a dev copy on ${live ? 'a copy of the live data' : 'empty data (this turn cannot see the live database)'}; it stays up for the next shot (citadel-dev-copy stop ends it).`);
  }
  const s = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'));
  if (resolve(s.worktree) !== root) throw new Error(`the running dev copy serves ${s.worktree}, not ${root}: run citadel-dev-copy start here`);
  return { url: s.url, cookie: s.cookie, pid: s.pid, log: join(home, 'server.log') };
}

/** Make the server re-read public/ and wait until it says it has; the front end's version. */
async function freshAssets(s: Server): Promise<string> {
  const from = statSync(s.log!).size;
  process.kill(s.pid!, 'SIGHUP');
  for (const end = Date.now() + 10_000; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) {
    const tail = readFileSync(s.log!).subarray(from).toString();
    const done = /Reloaded public\/ on SIGHUP: front end \S+ → (\S+)/.exec(tail);
    if (done) return done[1];
    if (/Reloading public\/ on SIGHUP failed/.test(tail)) throw new Error(`the dev copy could not re-read public/:\n${tail.slice(-1500)}`);
  }
  throw new Error(`the dev copy did not re-read public/ within 10 s; see its log, ${s.log}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** A load or step that never settles (a promise in the page that never resolves) fails instead of hanging the run. */
async function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([p, new Promise<never>((_, no) => (timer = setTimeout(() => no(new Error(`stuck over ${ms / 1000} s`)), ms)))]).finally(() => clearTimeout(timer));
}
const READY = `for (const end = Date.now() + ${TIMEOUT_MS}; document.body.classList.contains('navigating') && Date.now() < end; ) await new Promise((r) => setTimeout(r, 50));`;
const FRAME = 'await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));';
const KEYS: Record<string, [string, number, string?]> = { Enter: ['Enter', 13, '\r'], Escape: ['Escape', 27], Tab: ['Tab', 9], Backspace: ['Backspace', 8], ArrowDown: ['ArrowDown', 40], ArrowUp: ['ArrowUp', 38], ArrowLeft: ['ArrowLeft', 37], ArrowRight: ['ArrowRight', 39], ' ': ['Space', 32, ' '] };

/** Run one step on an open page; a shot's file name comes back through `shoot`. */
async function step(page: any, st: Step, shoot: (name: string) => Promise<void>, say: (s: string) => void) {
  const q = JSON.stringify(st.arg);
  const until = (sel: string) => page.evaluate(`(async () => { for (const end = Date.now() + ${TIMEOUT_MS}; !document.querySelector(${JSON.stringify(sel)}); await new Promise((r) => setTimeout(r, 50))) if (Date.now() > end) throw new Error(${JSON.stringify(`${sel} never came`)}); })()`);
  if (st.verb === 'wait') await until(st.arg);
  else if (st.verb === 'click') {
    await until(st.arg);
    const { x, y } = await page.evaluate(`(() => { const e = document.querySelector(${q}); e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await page.s('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  } else if (st.verb === 'type') {
    await until(st.arg);
    await page.evaluate(`document.querySelector(${q}).focus()`);
    await page.s('Input.insertText', { text: st.text });
  } else if (st.verb === 'key') {
    const [code, vk, text] = KEYS[st.arg] ?? [st.arg, 0];
    for (const type of ['keyDown', 'keyUp']) await page.s('Input.dispatchKeyEvent', { type: type === 'keyDown' && !text ? 'rawKeyDown' : type, key: st.arg, code, windowsVirtualKeyCode: vk, ...(type === 'keyDown' && text ? { text } : {}) });
  } else if (st.verb === 'text') {
    await until(st.arg);
    say(`text ${st.arg}: ${JSON.stringify(await page.evaluate(`document.querySelector(${q}).innerText`))}`);
  } else if (st.verb === 'sleep') await sleep(Number(st.arg));
  else if (st.verb === 'eval') say(`eval: ${JSON.stringify(await page.evaluate(`(async () => { ${/\breturn\b|;/.test(st.arg) ? st.arg : `return (${st.arg})`} })()`)) ?? 'undefined'}`);
  else if (st.verb === 'shot') {
    await page.evaluate(`(async () => { ${FRAME} })()`);
    await shoot(st.arg);
  }
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const t0 = Date.now();
  // $DEV_URL from `citadel-dev-copy env` is this worktree's own copy: keep the reload.
  const own = (() => {
    try {
      return JSON.parse(readFileSync(join(process.env.TMPDIR || '', 'dev-copy', 'state.json'), 'utf8')).url;
    } catch {
      return null;
    }
  })();
  const server: Server = o.url && o.url !== own ? { url: o.url, cookie: o.cookie } : devCopy();
  const version = server.pid ? await freshAssets(server) : null;
  const bin = process.env.CHROME || findChrome();
  if (!bin) throw new Error("no browser: install Playwright's chrome-headless-shell (npx playwright install chromium-headless-shell)");
  mkdirSync(o.out, { recursive: true });
  console.log(version ? `Serving public/ as it is now (front end ${version}) at ${server.url}; ready in ${Date.now() - t0} ms` : `Shooting ${server.url} as it is (not this worktree's dev copy, so nothing is reloaded)`);
  const mode = o.media.find((m) => m.name === 'display-mode')?.value;
  const emulate = !!(mode || o.titlebar);
  const browser = launch(bin);
  let failed = 0;
  try {
    for (const route of o.routes) {
      for (const theme of o.themes) {
        for (const width of o.widths) {
          const label = `${route || '/'} at ${width}${theme === 'dark' ? ' dark' : ''}`;
          const t = Date.now();
          let page: any;
          let at = 'loading';
          try {
            const opts = {
              init: emulate ? emulation(mode, o.titlebar) : undefined,
              cookies: o.anon || !server.cookie ? [] : [server.cookie], headers: [], dark: theme === 'dark', media: o.media.filter((m) => m.name !== 'display-mode'), settle: 0,
              wait: o.wait ?? (o.anon ? 'body > *' : '#app > *'), before: `${READY}\n${emulate ? 'window.__uiShotEmulate();' : ''}\n${o.before ?? ''}\n${FRAME}`,
            };
            const shoot = async (name = '') => {
              const file = join(o.out, shotName(route, width, theme, o.media, name));
              await shot(page, file);
              console.log(`${file}  (${Date.now() - t} ms)`);
            };
            const run = async () => {
              const opening = openPage(browser.send, server.url + route, width, opts);
              opening.then((p: any) => (page = p), () => {});
              page = await within(opening, TIMEOUT_MS * 2);
              if (o.safeArea) {
                const [top, bottom] = o.safeArea;
                await page.s('Emulation.setSafeAreaInsetsOverride', { insets: { top, topMax: top, bottom, bottomMax: bottom } });
                await page.evaluate(`(async () => { ${FRAME} })()`);
              }
              for (const st of o.steps) {
                at = `${st.verb} ${st.arg}`;
                await within(step(page, st, shoot, (s) => console.log(`  ${label}: ${s}`)), TIMEOUT_MS + 5000 + (st.verb === 'sleep' ? Number(st.arg) : 0));
              }
              if (!o.steps.some((s) => s.verb === 'shot')) await shoot();
            };
            await run();
          } catch (e) {
            failed++;
            console.log(`FAILED ${label}, at ${at}: ${(e as Error).message.split('\n')[0]}`);
          } finally {
            await page?.close().catch(() => {});
          }
        }
      }
    }
  } finally {
    await browser.close();
  }
  console.log(`${failed ? `${failed} failed; ` : ''}done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  if (failed) process.exitCode = 1;
}

if (import.meta.main) await main().catch((e) => {
  console.error(`ui-shot: ${e.message}`);
  process.exit(2);
});
