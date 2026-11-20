// Every contraption's errors in one daily file (#835, Peek's C1): its agents' failed tool calls (tool), 5xx answers
// through Citadel's proxy (http) and error lines in its services' journals (log), grouped by the message with numbers
// and ids taken out, each with a count and the first one's scrubbed sample line. Peek's playtest lost 206 of 1,011
// tool calls and real chats ~10 to disabled tools before anyone noticed; this makes that visible every day.
// The file is reports/contraption-errors/<day>.md in the app's home scheme's shared folder, rewritten every 10 minutes
// while the day has new errors and once more when it ends; the scheme's list_tickets shows yesterday's count.
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ContraptionErrorRow, ContraptionRow, Store } from './db.ts';
import { afterAllWrites } from './http.ts';
import { pacific, pacificDay, ZONE } from './pacific.ts';
import { redact } from './timer-alerts.ts';
import { every, type Job } from './every.ts';

const POLL_MS = 10 * 60_000;
const DAY_MS = 86_400_000;
/** Ended days written at once after a long stop, at most. */
const CATCH_UP_DAYS = 7;
export const DIGEST_DIR = 'reports/contraption-errors';
/** Settings keys: the last ended day written, and each app's journal cursor. */
const FINAL = 'contraption-errors-final';
const CURSORS = 'contraption-errors-cursors';

export interface JournalEntry {
  at: number;
  unit: string;
  text: string;
  priority: number;
}

export interface DigestDeps {
  /** A scheme's shared folder, or null for none. */
  sharedDir: (projectId: number) => string | null;
  /** An app's journal entries after `cursor` (null: the last few minutes), and the cursor to read on from. */
  journal?: (row: ContraptionRow, cursor: string | null) => Promise<{ entries: JournalEntry[]; cursor: string | null }>;
  now?: () => number;
}

const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/** The first non-empty line, without Claude's <tool_use_error> wrapper. */
function firstLine(text: string): string {
  const s = text.replace(/<\/?tool_use_error>/g, '');
  return (s.split('\n').find((l) => l.trim()) ?? '').trim();
}

const cap = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** What groups an error: its first line, scrubbed, with times, ids, numbers and long quoted text taken out. */
export function errorKey(text: string): string {
  const s = firstLine(text)
    .replace(/\d{4}-\d\d-\d\d[T ][\d:.]+(Z|[+-]\d\d:?\d\d)?/g, '<time>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>');
  return cap(redact(s)
    .replace(/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{6,}\b/gi, '<id>')
    .replace(/"[^"]{25,}"/g, '"…"').replace(/'[^']{25,}'/g, "'…'")
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' '), 160);
}

/** One error's sample: its first line, scrubbed and cut short (never the rest: player text and stacks stay out). */
export const sampleLine = (text: string) => cap(redact(firstLine(text)).replace(/\s+/g, ' '), 200);

const ERROR_WORDS = /\b(error|exception|traceback|fatal|panic|unhandled|uncaught|segfault)\b|[a-z]Error\b|\bFailed with result\b|Main process exited, code=\w+, status=(?!0\/)/i;
/** Whether a journal line is an error: err priority or worse, or it says so. */
export const isErrorLine = (line: string, priority: number) => priority <= 3 || ERROR_WORDS.test(line);

/** A request path as a group: no query, numbers as #, ids and long or encoded segments as *. */
function pathKey(path: string): string {
  return (path.split('?')[0] ?? '').split('/').map((seg) => (seg.length > 40 || seg.includes('%') ? '*' : errorKey(seg).replace(/<id>/g, '*'))).join('/');
}

export class ErrorDigest {
  private store: Store;
  private deps: DigestDeps;
  /** Days with errors not yet in their files. */
  private dirty = new Set<string>();
  private busy = false;
  private timer: Job | null = null;

  constructor(store: Store, deps: DigestDeps) {
    this.store = store;
    this.deps = deps;
  }

  private now() {
    return this.deps.now?.() ?? Date.now();
  }

  private add(row: Pick<ContraptionRow, 'id'>, kind: ContraptionErrorRow['kind'], key: string, sample: string, at = this.now()) {
    const day = pacificDay(at);
    this.store.addContraptionError(row.id, day, kind, key, sample, at);
    this.dirty.add(day);
  }

  /** An agent's tool call that came back is_error. */
  toolError(row: Pick<ContraptionRow, 'id'>, tool: string, error: string) {
    this.add(row, 'tool', `${tool}: ${errorKey(error)}`, `${tool}: ${sampleLine(error)}`);
  }

  /** A 5xx answer through the proxy, or `note` when the app didn't answer at all. */
  httpError(row: Pick<ContraptionRow, 'id'>, status: number, method: string, path: string, note = '') {
    const tail = note ? ` (${note})` : '';
    this.add(row, 'http', `${status} ${method} ${pathKey(path)}${tail}`, sampleLine(`${status} ${method} ${path.split('?')[0]}${tail}`));
  }

  start() {
    this.timer ??= every('contraption errors', POLL_MS, () => this.tick(), 60_000);
  }

  /**
   * Read the journals on, write the days that changed, and once a day the ended ones in full.
   * shortcut: rows and files are kept for good (a few thousand small rows and one file per scheme a day a year); add retention if they grow.
   */
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      if (this.deps.journal) await this.readJournals();
      // The rows just read go through the write queue: the day files below read them back.
      await afterAllWrites(() => {});
      const today = pacificDay(this.now());
      const yesterday = addDays(today, -1);
      const last = this.store.getSetting<string>(FINAL);
      const written = new Set<string>();
      if (!last || last < yesterday) {
        const from = last && last >= addDays(today, -CATCH_UP_DAYS) ? addDays(last, 1) : yesterday;
        let ok = true;
        for (let d = from; d <= yesterday; d = addDays(d, 1)) (ok = this.write(d, true) && ok), written.add(d);
        // A scheme's file that failed is tried again next tick; the others are rewritten with it, which is harmless.
        if (ok) this.store.setSetting(FINAL, yesterday);
      }
      const days = [...this.dirty];
      this.dirty.clear();
      for (const d of days) if (!written.has(d) && !this.write(d, false)) this.dirty.add(d);
    } finally {
      this.busy = false;
    }
  }

  private async readJournals() {
    const cursors = this.store.getSetting<Record<string, string>>(CURSORS) ?? {};
    for (const row of this.store.listContraptions()) {
      try {
        const { entries, cursor } = await this.deps.journal!(row, cursors[row.name] ?? null);
        for (const e of entries) {
          if (!isErrorLine(e.text, e.priority)) continue;
          const job = e.unit.startsWith(`citadel-app-${row.name}-`) ? `${e.unit.slice(`citadel-app-${row.name}-`.length).replace(/\.service$/, '')} job: ` : '';
          this.add(row, 'log', `${job}${errorKey(e.text)}`, `${job}${sampleLine(e.text)}`, e.at);
        }
        if (cursor) cursors[row.name] = cursor;
      } catch (err: any) {
        console.error(`Contraption errors: ${row.name}'s journal: ${err?.message ?? err}`);
      }
    }
    this.store.setSetting(CURSORS, cursors);
  }

  /** The schemes that own a contraption, with their apps. */
  private owners(): Map<number, ContraptionRow[]> {
    const out = new Map<number, ContraptionRow[]>();
    for (const c of this.store.listContraptions()) if (c.home_scheme != null) out.set(c.home_scheme, [...(out.get(c.home_scheme) ?? []), c]);
    return out;
  }

  /**
   * Write a day's file for each scheme with errors that day, or (`all`, an ended day) for every owning scheme.
   * False when a scheme's file couldn't be written (logged); the other schemes' still are.
   */
  private write(day: string, all: boolean): boolean {
    const rows = this.store.contraptionErrors(day);
    let ok = true;
    for (const [scheme, apps] of this.owners()) {
      const mine = rows.filter((r) => r.home_scheme === scheme);
      if (!all && !mine.length) continue;
      const dir = this.deps.sharedDir(scheme);
      if (!dir) continue;
      try {
        const folder = join(dir, DIGEST_DIR);
        mkdirSync(folder, { recursive: true });
        const file = join(folder, `${day}.md`);
        writeFileSync(`${file}.tmp`, render(this.store.getProject(scheme)?.name ?? 'This scheme', day, apps, mine, this.now(), all));
        renameSync(`${file}.tmp`, file);
      } catch (err: any) {
        ok = false;
        console.error(`Contraption errors: scheme ${scheme}'s ${day} file: ${err?.message ?? err}`);
      }
    }
    return ok;
  }

  /** Yesterday's count for a scheme's apps and its file, for the Taskmaster's list_tickets; null when there were none. */
  summary(projectId: number, now = this.now()): { day: string; total: number; apps: { title: string; count: number }[]; file: string } | null {
    const day = addDays(pacificDay(now), -1);
    const by = new Map<string, number>();
    for (const r of this.store.contraptionErrors(day)) if (r.home_scheme === projectId) by.set(r.title, (by.get(r.title) ?? 0) + r.count);
    const apps = [...by].map(([title, count]) => ({ title, count })).sort((a, b) => b.count - a.count);
    const total = apps.reduce((n, a) => n + a.count, 0);
    return total ? { day, total, apps, file: `${DIGEST_DIR}/${day}.md` } : null;
  }
}

const tick = (s: string) => s.replace(/`/g, "'");

export function render(scheme: string, day: string, apps: ContraptionRow[], rows: ContraptionErrorRow[], now: number, ended: boolean): string {
  const out = [
    `# Contraption errors, ${day} (Pacific day)`,
    '',
    `${scheme}'s contraptions' errors that day, counted by Citadel (#835): failed agent tool calls (tool), 5xx answers through Citadel's proxy (http) and error lines in their service journals (log). One line per kind of error, with numbers and ids taken out, biggest first; the sample is the first one seen, scrubbed and cut to one line. Written ${pacific(now)}${ended ? '' : ', the day still running'}.`,
  ];
  for (const app of apps) {
    const mine = rows.filter((r) => r.contraption_id === app.id);
    out.push('', `## ${app.title} (${app.name}): ${mine.reduce((n, r) => n + r.count, 0)}`, '');
    if (!mine.length) out.push('No errors.');
    // Calls to a tool the agent has not got (#1174), so it shows whether the did-you-mean note helped.
    const phantom = mine.filter((r) => r.kind === 'tool' && /No such tool available/.test(r.key));
    if (phantom.length) {
      const byTool = new Map<string, number>();
      for (const r of phantom) byTool.set(r.key.split(': ')[0]!, (byTool.get(r.key.split(': ')[0]!) ?? 0) + r.count);
      const names = [...byTool].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([t, n]) => `${tick(t)} ×${n}`).join(', ');
      out.push(`Unknown-tool calls (#1174): ${phantom.reduce((n, r) => n + r.count, 0)} (${names})`, '');
    }
    for (const r of mine) out.push(`- ${r.count} × ${r.kind} · \`${tick(r.key)}\``, `  - sample, ${pacific(r.first_at)}${r.count > 1 ? `, last ${pacific(r.last_at)}` : ''}: \`${tick(r.sample)}\``);
  }
  return `${out.join('\n')}\n`;
}
