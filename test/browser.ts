// A headless Chromium page for tests of public/ui/ (tip-browser.test.ts), driven over the DevTools
// protocol on a pipe as tools/boot-check.ts does: no dependency, no port to clash with anyone's.
// Uses Playwright's chrome-headless-shell from ~/.cache/ms-playwright; `chromium()` is null without one.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';

export function chromium(): string | null {
  const cache = join(homedir(), '.cache', 'ms-playwright');
  const dirs = existsSync(cache) ? readdirSync(cache).filter((d) => /^chromium_headless_shell-\d+$/.test(d)) : [];
  dirs.sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const d of dirs) {
    const bin = join(cache, d, 'chrome-headless-shell-linux64', 'chrome-headless-shell');
    if (existsSync(bin)) return bin;
  }
  return null;
}

export interface Page {
  /** The value of a page expression (awaited if it's a promise). */
  eval<T = unknown>(expression: string): Promise<T>;
  send(method: string, params?: object): Promise<any>;
  mouse(x: number, y: number): Promise<void>;
  /** Press and release a key: 'Tab', 'Escape'. */
  key(key: 'Tab' | 'Escape'): Promise<void>;
  touch(type: 'touchStart' | 'touchEnd', x?: number, y?: number): Promise<void>;
  tap(x: number, y: number): Promise<void>;
  /** The centre of the first element matching `selector`. */
  centre(selector: string): Promise<{ x: number; y: number }>;
}

export interface Browser {
  page(url: string, opts?: { width?: number; height?: number; touch?: boolean; dark?: boolean; scale?: number }): Promise<Page>;
  close(): Promise<void>;
}

export async function launch(bin: string): Promise<Browser> {
  const dir = mkdtempSync(join(tmpdir(), 'ui-browser-'));
  const chrome: ChildProcess = spawn(bin, ['--headless', '--remote-debugging-pipe', `--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  let log = '';
  chrome.stderr!.on('data', (d) => (log += d));
  const [input, output] = [chrome.stdio[3] as Writable, chrome.stdio[4] as Readable];
  let next = 0;
  const pending = new Map<number, { ok: (v: any) => void; no: (e: Error) => void }>();
  let gone: Error | null = null;
  chrome.once('exit', (code) => {
    gone = new Error(`Chromium exited (code ${code}):\n${log.slice(-2000)}`);
    for (const p of pending.values()) p.no(gone);
  });
  let buf = '';
  output.setEncoding('utf8');
  output.on('data', (d: string) => {
    buf += d;
    for (let i; (i = buf.indexOf('\0')) >= 0; buf = buf.slice(i + 1)) {
      const m = JSON.parse(buf.slice(0, i));
      const p = m.id && pending.get(m.id);
      if (!p) continue;
      pending.delete(m.id);
      if (m.error) p.no(new Error(`DevTools ${m.error.message}`));
      else p.ok(m.result);
    }
  });
  const send = (method: string, params: object = {}, sessionId?: string) => new Promise<any>((ok, no) => {
    if (gone) return no(gone);
    pending.set(++next, { ok, no });
    input.write(JSON.stringify({ id: next, method, params, sessionId }) + '\0');
  });

  return {
    async page(url, { width = 600, height = 400, touch = false, dark = false, scale = 1 } = {}) {
      const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
      const s = (method: string, params: object = {}) => send(method, params, sessionId);
      await s('Runtime.enable');
      await s('Page.enable');
      await s('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: touch });
      if (touch) await s('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
      await s('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] });
      await s('Page.navigate', { url });
      const evaluate = async (expression: string) => {
        const r = await s('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
        return r.result.value;
      };
      for (const end = Date.now() + 10_000; !(await evaluate('!!window.ready').catch(() => false)); await new Promise((r) => setTimeout(r, 50))) {
        if (Date.now() > end) throw new Error(`${url} never set window.ready`);
      }
      const KEYS = { Tab: 9, Escape: 27 };
      return {
        eval: evaluate,
        send: s,
        mouse: (x, y) => s('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }),
        async key(key) {
          for (const type of ['rawKeyDown', 'keyUp']) await s('Input.dispatchKeyEvent', { type, key, code: key, windowsVirtualKeyCode: KEYS[key] });
        },
        touch: (type, x = 0, y = 0) => s('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] }),
        async tap(x, y) {
          await s('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
          await s('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        },
        centre: (selector) => evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`),
      };
    },
    async close() {
      if (chrome.exitCode === null && chrome.signalCode === null) {
        chrome.kill();
        await new Promise((r) => chrome.once('exit', r));
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
