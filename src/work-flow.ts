// The Releases page's Flow tab (#1989; Josh, 2026-11-25, "Flow A: A river with the leaks drawn in"): every minion a scheme
// started in a range, from its kind, through how it got to main, to how it ended. Worked out at each read from what is kept:
// - releases and app deploys that went live, and merged pull requests (src/db/flow.ts);
// - its own chat: its ship notes, its merges into a build, each "didn't go through" a refused hand-off left (src/land.ts),
//   two-failed-ships stall notes (#1139, which also see ships a minion ran itself), and the note its close left;
// - the commits on the scheme's main branch that name it.
// Chats are read and git is run by tools/work-flow.ts, a low-priority process: cold chat reads have held the server for
// seconds (#1251, #1974). What a chat said is kept per minion in <data dir>/work-flow/<scheme id>.json and read again only
// when the minion has changed since, so a lost file costs one re-read.
import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Store } from './db.ts';
import type { FlowRow } from './db/flow.ts';
import { pacificDay, pacificDayStart } from './pacific.ts';
import { turnEnv } from './turn-launch.ts';

export type Kind = 'feature' | 'bug' | 'chore' | 'research' | 'other';
/** shipped: refusals were recorded, and there were fewer than two. untold: on main from before they were, or live with a ship it ran itself. other: on main with no ship or release of its own. */
export type Path = 'shipped' | 'untold' | 'refused' | 'other' | 'never';
/** build: merged into a major build that isn't on main. nothing: feature, fix or chore work closed with nothing on main, and no word why. norepo: the same in a scheme with no repo to look in. why: either, with its word saved. */
export type End = 'live' | 'late' | 'main' | 'build' | 'nothing' | 'why' | 'norepo' | 'answer' | 'open';
/** Refused hand-offs, and hand-offs' own ship notes, are in the chats from this Pacific day on. */
export const REFUSALS_FROM = '2026-11-14';

/** What one minion's chat says. */
export interface ChatFacts {
  id: number;
  /** Hand-offs that didn't go through. */
  refused: number;
  /** A "2 failed ships" stall note. */
  stalled: boolean;
  /** A hand-off of its own put it on main. */
  shipped: boolean;
  /** A hand-off merged it into a build. */
  merged: boolean;
  /** The note its last close left, without the "dismissed this minion" words; '' when it left none. */
  said: string;
}

export interface FlowMinion {
  id: number;
  number: number;
  title: string;
  kind: Kind;
  path: Path;
  end: End;
  /** done, replaced or dropped, on a closed one that has it saved. */
  why: string | null;
  cost: number;
  refused: number;
  said: string;
}

export interface FlowView {
  from: number;
  to: number;
  minions: FlowMinion[];
  /** Minions whose chats haven't been read, or not since they last changed: left out of `minions`, the next read has more of them. */
  unread: number;
  /** Whether the scheme has a repo to look in. */
  repo: boolean;
  /** Whether main's commits could be read. */
  git: boolean;
  /** Whether the range reaches before refused ships were kept. */
  early: boolean;
  /** Whether any release of the scheme's is in the range, so "no release recorded" means something. */
  releases: boolean;
}

const DAY_MS = 86_400_000;
/** The most days one range covers. */
export const MAX_DAYS = 400;
const RECORDED = pacificDayStart(REFUSALS_FROM) ?? 0;
/** The range a page asked for, both days in it: the last two weeks by default; null when it isn't one. */
export function rangeOf(from: string | null, to: string | null, now = Date.now()): { from: number; to: number } | null {
  const last = pacificDayStart(to ?? pacificDay(now));
  if (last === null) return null;
  const end = pacificDayStart(pacificDay(last + 1.5 * DAY_MS))!; // a day is 23 to 25 hours long
  const start = pacificDayStart(from ?? pacificDay(last + DAY_MS / 2 - 13 * DAY_MS));
  return start === null || start >= end || end - start > (MAX_DAYS + 1) * DAY_MS ? null : { from: start, to: end };
}

const KINDS: Kind[] = ['feature', 'bug', 'chore', 'research'];
export const kindOf = (type: string | null): Kind => KINDS.find((k) => k === type) ?? 'other';

/** How a minion got to main, and how it ended. */
export function settle(m: Pick<FlowRow, 'type' | 'status' | 'why' | 'live' | 'build' | 'merged_pr' | 'created_at'>, f: Omit<ChatFacts, 'id' | 'said'>, named: boolean, repo = true): { path: Path; end: End } {
  const kind = kindOf(m.type);
  // A build minion's pull request may have gone into its build's branch: only a release or a commit says it is on main.
  const ownPr = !!m.merged_pr && m.build === null;
  const onMain = !!m.live || f.shipped || named || ownPr;
  const refused = f.refused >= 2 || f.stalled;
  const early = m.created_at < RECORDED;
  const path: Path = refused ? 'refused' : f.shipped ? 'shipped' : m.live || (onMain && early) ? 'untold' : onMain ? 'other' : 'never';
  if (onMain) return { path, end: refused ? 'late' : m.live ? 'live' : 'main' };
  if (f.merged || m.merged_pr) return { path, end: 'build' };
  if (m.status !== 'closed') return { path, end: 'open' };
  if (kind === 'research' || kind === 'other') return { path, end: 'answer' };
  return { path, end: m.why ? 'why' : repo ? 'nothing' : 'norepo' };
}

/** The minions `log` (git log --format=%cn%x09%s) names: the #N a subject starts or ends with, else its first. GitHub's own merges end with a pull request's number. */
export function namedBy(log: string): number[] {
  const out = new Set<number>();
  for (const line of log.split('\n')) {
    const tab = line.indexOf('\t');
    const by = line.slice(0, tab);
    const subject = by === 'GitHub' ? line.slice(tab + 1).replace(/\s*\(#\d+\)\s*$/, '') : line.slice(tab + 1);
    const n = /^#(\d{1,6})\b/.exec(subject) ?? /\(#(\d{1,6})\)\s*$/.exec(subject) ?? /#(\d{1,6})\b/.exec(subject);
    if (n) out.add(Number(n[1]));
  }
  return [...out];
}

/** What the chats of minions `ids` say, read from the database that holds the events. */
export function chatFacts(db: DatabaseSync, ids: number[]): ChatFacts[] {
  const notes = db.prepare(`SELECT json_extract(data, '$.text') AS text FROM events WHERE ticket_id = ? AND kind = 'note'
    AND (data LIKE '{"text":"Shipped %' OR data LIKE '{"text":"Merged %' OR data LIKE '{"text":"Stall signal%' OR data LIKE '% dismissed this minion%') ORDER BY id`);
  const refusals = db.prepare(`SELECT count(*) AS n FROM events WHERE ticket_id = ? AND kind = 'user_message' AND json_extract(data, '$.author') = 'Citadel' AND instr(json_extract(data, '$.text'), 'Your handed-off land didn''t go through:')`);
  return ids.map((id) => {
    const f: ChatFacts = { id, refused: Number((refusals.get(id) as { n: number }).n), stalled: false, shipped: false, merged: false, said: '' };
    for (const { text } of notes.all(id) as { text: string | null }[]) {
      if (!text) continue;
      // A merge into a build said "Shipped <commit> … Merged into build/N, not live …" until Nov 19.
      if (/^Merged /.test(text) || /\bMerged into build\/\d+, not live\b/.test(text)) f.merged = true;
      else if (/^Shipped (?:[0-9a-f]{7,40}\b|the branch)/.test(text)) f.shipped = true;
      else if (/^Stall signal: .*\b2 failed ships/.test(text)) f.stalled = true;
      const closed = /^(\S.{0,60}?) dismissed this minion(?:: (.*))?\.?$/s.exec(text);
      if (closed) f.said = /\bso (?:it|the server)$/.test(closed[1]) ? '' : (closed[2]?.trim() || `Closed by ${closed[1] === 'Claude' ? 'the minion itself' : closed[1]}, no note`).slice(0, 300);
    }
    return f;
  });
}

export interface FlowAsk {
  db: string;
  ids: number[];
  repo: string | null;
  since: number;
}
export interface FlowAnswer {
  facts: ChatFacts[];
  named: number[] | null;
}

/** One ask answered in a process of its own, at the lowest CPU and disk priority. */
export function readApart(ask: FlowAsk): Promise<FlowAnswer> {
  const env = Object.fromEntries(Object.entries(turnEnv(process.env)).filter(([k]) => !/^(CLAUDE_|ANTHROPIC_)/.test(k)));
  const tool = join(import.meta.dirname, '..', 'tools', 'work-flow.ts');
  return new Promise((resolve, reject) => {
    const child = execFile('nice', ['-n', '19', 'ionice', '-c', '3', process.execPath, tool], { env, timeout: 120_000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr.trim().split('\n').at(-1) || err.message));
      try {
        resolve(JSON.parse(stdout) as FlowAnswer);
      } catch (e) {
        reject(e);
      }
    });
    child.stdin?.on('error', () => {}); // it died first: its exit says why
    child.stdin?.end(JSON.stringify(ask));
  });
}

export interface WorkFlowDeps {
  dir: string;
  read: (ask: FlowAsk) => Promise<FlowAnswer>;
  /** The database file; its chats may be in events.db beside it. */
  db: string;
  /** How long a page waits for chats to be read; the rest go on behind it. */
  waitMs?: number;
}

/** Chats read per process run. */
const BATCH = 150;
const WAIT_MS = 12_000;

type Kept = Record<string, ChatFacts & { at: number }>;

export class WorkFlow {
  private store: Store;
  private deps: WorkFlowDeps;
  private kept = new Map<number, Kept>();
  /** Scheme id -> its running read of chats: one at a time. */
  private reading = new Map<number, Promise<void>>();

  constructor(store: Store, deps: WorkFlowDeps) {
    this.store = store;
    this.deps = deps;
  }

  private file(id: number) {
    return join(this.deps.dir, `${id}.json`);
  }

  private async load(id: number): Promise<Kept> {
    let k = this.kept.get(id);
    if (!k) {
      k = await readFile(this.file(id), 'utf8')
        .then((s) => JSON.parse(s) as Kept)
        .catch(() => ({})); // a broken file is read again from the chats
      k = this.kept.get(id) ?? k;
      this.kept.set(id, k);
    }
    return k;
  }

  private async save(id: number) {
    await mkdir(this.deps.dir, { recursive: true });
    const file = this.file(id);
    await writeFile(`${file}.tmp`, JSON.stringify(this.kept.get(id)));
    await rename(`${file}.tmp`, file);
  }

  /** Read the chats of `rows` that changed since they were last read, newest first. */
  private async refresh(id: number, rows: FlowRow[]) {
    const kept = await this.load(id);
    const stale = rows.filter((r) => (kept[r.id]?.at ?? -1) < r.updated_at);
    for (let i = 0; i < stale.length; i += BATCH) {
      const part = stale.slice(i, i + BATCH);
      const { facts } = await this.deps.read({ db: this.deps.db, ids: part.map((r) => r.id), repo: null, since: 0 });
      const at = new Map(part.map((r) => [r.id, r.updated_at]));
      for (const f of facts) kept[f.id] = { ...f, at: at.get(f.id)! };
      await this.save(id);
    }
  }

  /** The Flow tab's read: the minions started in [from, to). */
  async view(id: number, from: number, to: number): Promise<FlowView> {
    const rows = this.store.flowRows(id, from, to);
    const repo = this.store.getProject(id)?.repo_dir ?? null;
    const git = repo
      ? this.deps.read({ db: this.deps.db, ids: [], repo, since: from }).then(
          (a) => a.named,
          () => null,
        )
      : Promise.resolve(null);
    // Another page's read may be on a different range: wait for it, then read what this one still lacks.
    const before = this.reading.get(id) ?? Promise.resolve();
    const run = before.catch(() => {}).then(() => this.refresh(id, rows));
    this.reading.set(id, run);
    const done = run.finally(() => this.reading.get(id) === run && this.reading.delete(id));
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([done, new Promise((r) => (timer = setTimeout(r, this.deps.waitMs ?? WAIT_MS)))]).finally(() => clearTimeout(timer));
    done.catch((err) => console.error(`Flow: reading scheme ${id}'s chats failed: ${err?.message ?? err}`));
    const named = await git;
    const on = new Set(named ?? []);
    const kept = await this.load(id);
    const read = rows.filter((r) => kept[r.id]?.at >= r.updated_at); // an older read is as good as none: it may have closed since
    return {
      from,
      to,
      minions: read.map((r) => {
        const f = kept[r.id];
        return { id: r.id, number: r.number, title: r.title, kind: kindOf(r.type), ...settle(r, f, on.has(r.number), !!repo), why: r.status === 'closed' ? r.why : null, cost: r.cost, refused: f.refused, said: f.said };
      }),
      unread: rows.length - read.length,
      repo: !!repo,
      git: !repo || named !== null,
      early: from < RECORDED,
      releases: rows.some((r) => r.live),
    };
  }
}
