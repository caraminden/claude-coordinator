// A choices card's preview (#821): a picture of the top of the page it names, shot once in headless
// Chromium and kept until the page file changes. The card shows it above its Open button; without
// one (no browser, a page that won't load) the card shows just the button.
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Opens `url` and returns a JPEG of its top, or throws. */
export type Shooter = (url: string) => Promise<Buffer>;

/** The page is laid out this wide and shot this tall: a desktop layout that stays legible at a card's width. */
export const VIEW = { width: 960, height: 480 };
const TIMEOUT_MS = 20_000;
/** Pictures kept on disk; the oldest go first. A page edited many times leaves one per version. */
const KEEP = 300;

export class DocPreviews {
  private queue: Promise<unknown> = Promise.resolve();
  private inFlight = new Map<string, Promise<Buffer | null>>();
  /** Versions that failed to shoot this run, so a broken page isn't shot again on every card render. */
  private failed = new Set<string>();

  private dir: string;
  private shoot: Shooter;

  constructor(dir: string, shoot: Shooter = chromiumShooter) {
    this.dir = dir;
    this.shoot = shoot;
  }

  /** The key of one version of a page: its path, size and modified time. */
  static key(abs: string, size: number, mtime: number): string {
    return createHash('sha256').update(`${abs}\0${size}\0${mtime}`).digest('hex').slice(0, 32);
  }

  /** The picture of this version of the page, shooting it (one at a time) the first time; null if it can't be shot. */
  async get(key: string, url: () => string): Promise<Buffer | null> {
    const file = join(this.dir, `${key}.jpg`);
    const kept = await readFile(file).catch(() => null);
    if (kept) return kept;
    if (this.failed.has(key)) return null;
    let p = this.inFlight.get(key);
    if (!p) {
      p = this.take(key, file, url()).finally(() => this.inFlight.delete(key));
      this.inFlight.set(key, p);
    }
    return p;
  }

  private take(key: string, file: string, url: string): Promise<Buffer | null> {
    const run = async () => {
      try {
        const img = await withTimeout(this.shoot(url), TIMEOUT_MS);
        await mkdir(this.dir, { recursive: true });
        await writeFile(file, img);
        await this.prune();
        return img;
      } catch (err) {
        console.warn(`doc preview of ${url.replace(/\/files\/[^/]+\//, '/files/…/')} failed: ${(err as Error).message.slice(0, 300)}`);
        this.failed.add(key);
        return null;
      }
    };
    const p = this.queue.then(run);
    this.queue = p.catch(() => {});
    return p;
  }

  private async prune() {
    const names = (await readdir(this.dir).catch(() => [] as string[])).filter((n) => n.endsWith('.jpg'));
    if (names.length <= KEEP) return;
    const dated = await Promise.all(names.map(async (n) => ({ n, t: (await stat(join(this.dir, n)).catch(() => null))?.mtimeMs ?? 0 })));
    dated.sort((a, b) => a.t - b.t);
    for (const { n } of dated.slice(0, dated.length - KEEP)) await unlink(join(this.dir, n)).catch(() => {});
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([p, new Promise<T>((_, no) => (timer = setTimeout(() => no(new Error(`no picture after ${ms / 1000} s`)), ms)))]).finally(() => clearTimeout(timer));
}

/** Shoots with Playwright's chrome-headless-shell over a pipe (the kit's ui-measure helpers): no port, no installs. */
export const chromiumShooter: Shooter = async (url) => {
  const { findChrome, launch, openPage } = await import('../kit/skills/critique/scripts/ui-measure.mjs');
  const bin = findChrome();
  if (!bin) throw new Error('no chrome-headless-shell in ~/.cache/ms-playwright');
  const browser = launch(bin);
  try {
    const page = await openPage(browser.send, url, VIEW.width, { headers: [], cookies: [], settle: 500 });
    await page.s('Emulation.setDeviceMetricsOverride', { ...VIEW, deviceScaleFactor: 1, mobile: false });
    const { data } = await page.s('Page.captureScreenshot', { format: 'jpeg', quality: 80, clip: { x: 0, y: 0, ...VIEW, scale: 1 } });
    return Buffer.from(data, 'base64');
  } finally {
    await browser.close();
  }
};
