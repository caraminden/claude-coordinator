// The Code tab's numbers (#1988; Josh, 2026-11-25, "Code B: Split these: big and busy, top right"): per file, its lines and
// how many minions changed it in the last two weeks. Counted once a Pacific day per scheme by tools/code-counts.ts, a low-priority
// process of its own, one scheme at a time and never 3-6 AM (the nightly work). Kept as <data dir>/code-counts/<scheme id>.json:
// made from git, so a lost file costs one recount. The page read opens that file and never git. A failed count keeps the last
// good numbers beside its error, and waits for the next day.
import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Store } from './db.ts';
import { pacificDay, ZONE } from './pacific.ts';
import { thrown } from './thrown.ts';
import { turnEnv } from './turn-launch.ts';

/** The window a change counts in. */
export const DAYS = 14;
/** Pacific hours a count never starts in, from and before. */
const QUIET = [3, 6];
const RUN_MS = 5 * 60_000;

export interface CodeFile {
  path: string;
  lines: number;
  /** Minions that changed it; a ship whose commits name no minion counts as one. */
  changed: number;
  /** How many of them were bug minions. */
  bugs: number;
  /** The last few minions' numbers, newest first. */
  who: number[];
}
export interface Counted {
  at: number;
  branch: string;
  commit: string;
  days: number;
  files: CodeFile[];
}
/** What is kept: the last good count, and why the newest try failed. */
export interface Kept extends Counted {
  error?: string;
}
export type SplitBy = { number: number; title: string };

/**
 * Which files an open minion is already splitting, by its title ("Split runner.ts into modules", "Break up tools/land.sh"):
 * a path names that file; a bare file name, with or without its ending ("Split the runner"), names every file called that.
 * It leans to saying yes: a wrong match shows a minion to look at, a missed one would propose the same split twice.
 */
export function splitting(files: readonly { path: string }[], minions: readonly SplitBy[]): Record<string, SplitBy[]> {
  const out: Record<string, SplitBy[]> = {};
  for (const m of minions) {
    if (!/\b(split|break(ing)? up|carve)/i.test(m.title)) continue;
    const words = m.title.split(/[\s,;:()"'`]+/).map((w) => w.replace(/^\.\/|\.+$/g, ''));
    for (const f of files) {
      const stem =
        f.path
          .split('/')
          .at(-1)
          ?.replace(/\.\w+$/, '')
          .toLowerCase() ?? '';
      if (words.some((w) => (/\.\w+$/.test(w) && (f.path === w || f.path.endsWith(`/${w}`))) || (stem.length > 3 && w.toLowerCase() === stem))) (out[f.path] ??= []).push({ number: m.number, title: m.title });
    }
  }
  return out;
}

export interface CodeCountsDeps {
  dir: string;
  /** Count one repo: the low-priority process's answer. */
  count: (repo: string, bugs: number[]) => Promise<Counted>;
  now?: () => number;
}

/** The count in a process of its own, at the lowest CPU and disk priority. */
export function countApart(repo: string, bugs: number[]): Promise<Counted> {
  const env = Object.fromEntries(Object.entries(turnEnv(process.env)).filter(([k]) => !/^(CLAUDE_|ANTHROPIC_)/.test(k)));
  const tool = join(import.meta.dirname, '..', 'tools', 'code-counts.ts');
  return new Promise((resolve, reject) => {
    const child = execFile('nice', ['-n', '19', 'ionice', '-c', '3', process.execPath, tool, repo, String(DAYS)], { env, timeout: RUN_MS, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr.trim().split('\n').at(-1) || err.message));
      try {
        resolve(JSON.parse(stdout) as Counted);
      } catch (e) {
        reject(e);
      }
    });
    child.stdin?.on('error', () => {}); // it died first: its exit says why
    child.stdin?.end(JSON.stringify(bugs));
  });
}

const hour = (t: number) => Number(new Intl.DateTimeFormat('en-US', { timeZone: ZONE, hourCycle: 'h23', hour: 'numeric' }).format(t));

export class CodeCounts {
  private store: Store;
  private deps: CodeCountsDeps;
  private busy = false;
  /** The day each scheme was last tried by this process, so one whose file can't be written doesn't hold up the rest. */
  private tried = new Map<number, string>();

  constructor(store: Store, deps: CodeCountsDeps) {
    this.store = store;
    this.deps = deps;
  }

  private file(id: number) {
    return join(this.deps.dir, `${id}.json`);
  }

  /** What is kept for a scheme; null when it has no count yet. */
  async read(id: number): Promise<Kept | null> {
    try {
      return JSON.parse(await readFile(this.file(id), 'utf8')) as Kept;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  /** Count the next scheme due today, if any: one a tick, so the rest of the box is between them. The scheme counted, or null. */
  async tick(): Promise<number | null> {
    const now = this.deps.now?.() ?? Date.now();
    const h = hour(now);
    if (this.busy || (h >= QUIET[0] && h < QUIET[1])) return null;
    this.busy = true;
    try {
      const today = pacificDay(now);
      for (const p of this.store.listProjects()) {
        if (!p.repo_dir || this.tried.get(p.id) === today) continue;
        const at = await stat(this.file(p.id)).then(
          (s) => s.mtimeMs,
          () => 0,
        );
        if (at && pacificDay(at) === today) continue;
        this.tried.set(p.id, today);
        await this.run(p.id, p.repo_dir);
        return p.id;
      }
      return null;
    } finally {
      this.busy = false;
    }
  }

  private async run(id: number, repo: string) {
    let kept: Kept;
    try {
      kept = await this.deps.count(repo, this.store.bugNumbers(id));
    } catch (err) {
      const was = await this.read(id).catch(() => null);
      kept = { ...(was ?? { at: 0, branch: '', commit: '', days: DAYS, files: [] }), error: String(thrown(err).message ?? err).slice(0, 300) };
    }
    await mkdir(this.deps.dir, { recursive: true });
    const file = this.file(id);
    await writeFile(`${file}.tmp`, JSON.stringify(kept));
    await rename(`${file}.tmp`, file);
  }

  /** The Code tab's read: what is kept, and who is splitting which file now. */
  async view(id: number): Promise<{ repo: boolean; kept: Kept | null; splitting: Record<string, SplitBy[]> }> {
    const kept = await this.read(id);
    return { repo: !!this.store.getProject(id)?.repo_dir, kept, splitting: kept ? splitting(kept.files, this.store.openTitles(id)) : {} };
  }
}
