// The ideas ledger (#1150, G3 from #1092; Josh's picks 2026-11-19 and 2026-11-20): one row per idea a scheme was shown,
// with where it came from, its pick, who decided in their words, its handoff and the minion that built it. It fills
// itself: a choices page's pick bars with a Later option make rows (found by reading the page, so no page opts in),
// every handoff file in the shared folder makes or joins a row, a minion whose first message (or Start button) names a
// handoff marks it started, and a ship marks it built. People and agents fix a row by hand (status, minion link) on
// Orders → Ideas or with the ideas tool, and a hand edit is never undone by the scan. Later rows older than two weeks
// sit on top of the page, and the Taskmaster gets a weekly held note of them. Keyed on the scheme everywhere.
import type { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { pacificDay } from './pacific.ts';
import { drain, pace } from './breathe.ts';

export const STATUSES = ['proposed', 'picked', 'later', 'skipped', 'started', 'built', 'declined'] as const;
export type IdeaStatus = (typeof STATUSES)[number];
/** A Later row this old is pinned on the page and listed in the Taskmaster's weekly note. */
export const LATER_STALE_MS = 14 * 24 * 60 * 60_000;
export const LATER_NOTE_EVERY_MS = 7 * 24 * 60 * 60_000;
/** How much of a handoff's head names its page, card and source. */
const HEAD_LINES = 40;
/** Event ids per step of the Send read: about 2 ms warm, a few hundred cold (#1414). */
const SEND_IDS = 20_000;

export interface Idea {
  id: number;
  project_id: number;
  /** The choices page it was on (an absolute path), '' for a handoff with no page. */
  page: string;
  /** Its id on the page (G3), or the handoff's path in the shared folder when there is no page. */
  card: string;
  collection: string;
  title: string;
  /** The #N that showed the page or wrote the handoff. */
  source_number: number | null;
  /** The option picked (go, later, skip, cut…) and how its button read; null while unpicked. */
  pick: string | null;
  pick_label: string | null;
  decided_by: string | null;
  /** The note they wrote with the pick, in their words. */
  words: string | null;
  decided_at: number | null;
  /** The handoff's path in the shared folder (relative), null when none was written. */
  handoff: string | null;
  ticket_id: number | null;
  number: number | null;
  /** 1 when a person or agent set the minion link by hand: the scan leaves it alone. */
  link_manual: number;
  status: IdeaStatus;
  /** A status set by hand, which wins over the derived one; null to go back to automatic. */
  status_manual: IdeaStatus | null;
  manual_by: string | null;
  manual_at: number | null;
  created_at: number;
  updated_at: number;
}

/** What a choices page's Send says about one item (mockkit 'items', or a line of the Send text). */
export interface PageItem {
  collection: string;
  id: string;
  title: string;
  label?: string;
}

/** The status a row's facts give, before any hand edit. */
export function derive(i: Pick<Idea, 'pick' | 'ticket_id'>, shipped: boolean): IdeaStatus {
  if (i.ticket_id) return shipped ? 'built' : 'started';
  if (!i.pick) return 'proposed';
  if (i.pick === 'later') return 'later';
  if (/^(skip|cut|no|drop|not.now)\b/i.test(i.pick)) return 'skipped';
  return 'picked';
}

/**
 * The collections a page's pick bars with a Later option use, read from its HTML: each `picks({ … })` call's
 * collection, whose options (inline, or a const it names) include 'later'. A computed collection name can't be read;
 * mockkit's Send names those sets itself.
 */
export function laterCollections(html: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/picks\(\s*\{/g)) {
    const end = html.indexOf('picks(', m.index! + 6);
    const chunk = html.slice(m.index!, Math.min(m.index! + 1500, end < 0 ? Infinity : end));
    const coll = /collection:\s*['"]([\w-]+)['"]/.exec(chunk)?.[1] ?? (/collection\s*[:,}]/.test(chunk) ? null : 'picks');
    if (!coll) continue;
    let opts = /options:\s*\[([^\]]*)\]/.exec(chunk)?.[1];
    const named = !opts && /options:\s*([A-Za-z_$][\w$]*)/.exec(chunk)?.[1];
    if (named) opts = new RegExp(`(?:const|let|var)\\s+${named}\\s*=\\s*\\[([^\\]]*)\\]`).exec(html)?.[1];
    if (opts && /['"]later['"]/i.test(opts)) out.add(coll);
  }
  return [...out];
}

/**
 * The items a Send text names: `- <title>: <label>[. "<note>"]` lines under `Picks on "…":`. A title starts with its
 * card id on idea pages ("G3 One ledger…"), which is how a line finds its row; `ids` are the row ids to match.
 */
export function sendTitles(text: string, ids: Iterable<string>): Map<string, string> {
  const out = new Map<string, string>();
  const want = [...ids].sort((a, b) => b.length - a.length);
  for (const raw of text.split('\n')) {
    if (!raw.startsWith('- ')) continue;
    const line = raw.slice(2).replace(/\. ".*"$/s, '');
    const cut = line.lastIndexOf(': ');
    if (cut <= 0) continue;
    const title = line.slice(0, cut).trim();
    const id = want.find((k) => title === k || title.startsWith(`${k} `));
    if (id && title !== id && !out.has(id)) out.set(id, title);
  }
  return out;
}

export interface HandoffHead {
  title: string;
  /** The choices page it came from, absolute. */
  page: string | null;
  card: string | null;
  source: number | null;
}

/** What a handoff's head says: its H1, the choices page and card it came from, and the #N it came from. */
export function parseHandoff(text: string, sharedDir: string): HandoffHead {
  const head = text.split('\n').slice(0, HEAD_LINES).join('\n');
  const h1 = /^#\s+(.+)$/m.exec(head)?.[1].trim() ?? '';
  const title = h1
    .replace(/^handoff\s*[:—-]\s*/i, '')
    .replace(/[*_`]/g, '')
    .trim();
  const abs = new RegExp(`${esc(sharedDir)}/([^\\s\`'")\\]]+?\\.html)`).exec(head)?.[1] ?? /(?<![\w/.-])((?:mockups|reports|specs|pages)\/[^\s`'")\]]+?\.html)/.exec(head)?.[1];
  const card = /\b(?:card|idea)\s+([A-Z]{1,2}\d{1,2})\b/.exec(head)?.[1] ?? /\(([A-Z]{1,2}\d{1,2})\)\s*$/.exec(h1)?.[1] ?? /\*\*Pick[^*]*\*\*:?\s*([A-Z]{1,2}\d{1,2})\b/.exec(head)?.[1] ?? null;
  const src = /\bfrom\s+(?:[\w-]+\s+)?#(\d{1,6})\b/i.exec(head)?.[1];
  return { title: title || h1, page: abs ? join(sharedDir, abs) : null, card, source: src ? Number(src) : null };
}

/**
 * The handoff a minion's first message (or brief) starts from, as a path in the shared folder: the first .md there
 * that lives under handoffs/, or has "handoff" in its name or just before it. null when it names none.
 */
export function handoffIn(text: string, sharedDir: string): string | null {
  const re = new RegExp(`(?:${esc(sharedDir)}/|(?<![\\w/.-])(?=handoffs/))([^\\s\`'")\\]]+?\\.md)(?![\\w/])`, 'g');
  for (const m of text.matchAll(re)) {
    const rel = m[1].replace(/[.,:;]+$/, '');
    if (rel.split('/').includes('..')) continue;
    const before = text.slice(Math.max(0, m.index! - 40), m.index!);
    if (rel.startsWith('handoffs/') || /handoff/i.test(rel.split('/').pop()!) || /handoff/i.test(before)) return rel;
  }
  return null;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Every handoff in a shared folder, relative: handoffs/ (any depth) and *handoff*.md at its root. */
export function handoffFiles(sharedDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    let names: import('node:fs').Dirent[];
    try {
      names = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of names) {
      if (d.name.startsWith('.')) continue;
      const p = join(dir, d.name);
      if (d.isDirectory() && depth < 4) walk(p, depth + 1);
      else if (d.isFile() && d.name.endsWith('.md')) out.push(relative(sharedDir, p).split(sep).join('/'));
    }
  };
  walk(join(sharedDir, 'handoffs'), 0);
  try {
    for (const n of readdirSync(sharedDir)) if (n.endsWith('.md') && /handoff/i.test(n)) out.push(n);
  } catch {
    /* no shared folder yet */
  }
  return out.sort();
}

type Patch = Partial<Omit<Idea, 'id' | 'project_id' | 'page' | 'card' | 'created_at'>>;

export class Ideas {
  private db: DatabaseSync;
  /** Parsed handoff heads by path, kept while the file's mtime holds: the scan reads only what changed. */
  private heads = new Map<string, { mtime: number; head: HandoffHead }>();
  /** Pages whose Sends were searched this server life: a page with no Later-style bar makes no rows, so "fresh" alone would search it every pass. */
  private searched = new Set<string>();
  /** Minions seen shipped, and the last event id scanned for a ship line in each one that hasn't (#1215). */
  private shipped = new Set<number>();
  private shipScanned = new Map<number, number>();
  /** Schemes whose linked minions were all scanned for ship lines this server life: restatus is cheap only after that (#1414). */
  private warm = new Set<number>();
  /**
   * The Send messages of each scheme, and the last event id read for them: a pass reads only events past it. One read of
   * every Send per pass still held the loop 4-18 s on a cold page cache (#1414), so the first read goes in id ranges.
   */
  private sends = new Map<number, { mark: number; rows: { ticket: number; data: string; number: number | null; kind: string }[] }>();
  private pages = new Map<string, { mtime: number; colls: string[] }>();
  private timers = new Map<number, ReturnType<typeof setTimeout>>();
  private running = new Map<number, Promise<void>>();

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  list(projectId: number): Idea[] {
    return this.db.prepare('SELECT * FROM ideas WHERE project_id = ? ORDER BY COALESCE(decided_at, created_at) DESC, id DESC').all(projectId) as unknown as Idea[];
  }

  get(id: number): Idea | undefined {
    return this.db.prepare('SELECT * FROM ideas WHERE id = ?').get(id) as unknown as Idea | undefined;
  }

  find(projectId: number, page: string, card: string): Idea | undefined {
    return this.db.prepare('SELECT * FROM ideas WHERE project_id = ? AND page = ? AND card = ?').get(projectId, page, card) as unknown as Idea | undefined;
  }

  byHandoff(projectId: number, handoff: string): Idea | undefined {
    return this.db.prepare('SELECT * FROM ideas WHERE project_id = ? AND handoff = ? ORDER BY id LIMIT 1').get(projectId, handoff) as unknown as Idea | undefined;
  }

  /** Make the row or change the given fields; returns it. A field left out (or undefined) stays. */
  upsert(projectId: number, page: string, card: string, patch: Patch, now = Date.now()): Idea {
    const cur = this.find(projectId, page, card);
    const keys = Object.keys(patch).filter((k) => (patch as Record<string, unknown>)[k] !== undefined && (!cur || (cur as unknown as Record<string, unknown>)[k] !== (patch as Record<string, unknown>)[k]));
    if (cur && !keys.length) return cur;
    if (!cur) {
      const cols = ['project_id', 'page', 'card', 'created_at', 'updated_at', ...keys];
      const vals = [projectId, page, card, now, now, ...keys.map((k) => (patch as Record<string, unknown>)[k])];
      this.db.prepare(`INSERT INTO ideas (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...(vals as (string | number | null)[]));
    } else {
      this.db.prepare(`UPDATE ideas SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...(keys.map((k) => (patch as Record<string, unknown>)[k]) as (string | number | null)[]), now, cur.id);
    }
    return this.find(projectId, page, card)!;
  }

  /** A hand edit: a status (null goes back to automatic) and/or a minion link (null unlinks, 'auto' hands it back to the scan). */
  edit(id: number, by: string, change: { status?: IdeaStatus | null; ticket?: { id: number; number: number | null } | null | 'auto' }, now = Date.now()): Idea {
    const cur = this.get(id)!;
    const p: Patch = {};
    if (change.status !== undefined) Object.assign(p, { status_manual: change.status, manual_by: by, manual_at: now });
    if (change.ticket === 'auto') Object.assign(p, { link_manual: 0 });
    else if (change.ticket !== undefined) Object.assign(p, { ticket_id: change.ticket?.id ?? null, number: change.ticket?.number ?? null, link_manual: 1, manual_by: by, manual_at: now });
    this.upsert(cur.project_id, cur.page, cur.card, p, now);
    this.restatus(cur.project_id);
    return this.get(id)!;
  }

  /** Link a minion to the row its handoff made (made now if the scan hasn't seen the file yet). The newest start wins, never over a hand link or a built row. */
  linkHandoff(projectId: number, sharedDir: string, rel: string, ticket: { id: number; number: number | null }): Idea | null {
    if (rel.split('/').includes('..')) return null; // a brief path must stay inside the shared folder
    let row = this.byHandoff(projectId, rel) ?? this.fromHandoff(projectId, sharedDir, rel) ?? this.fromChat(projectId, sharedDir, rel, ticket.id);
    if (!row) return null;
    if (row.link_manual || row.ticket_id === ticket.id || (row.ticket_id && row.ticket_id > ticket.id) || row.status === 'built') return row;
    row = this.upsert(projectId, row.page, row.card, { ticket_id: ticket.id, number: ticket.number });
    this.restatus(projectId);
    return this.get(row.id)!;
  }

  /** The row a handoff file makes or joins: its page's card when it names one that has no other handoff, else its own. */
  fromHandoff(projectId: number, sharedDir: string, rel: string): Idea | null {
    const abs = join(sharedDir, rel);
    let mtime: number;
    try {
      mtime = statSync(abs).mtimeMs;
    } catch {
      return this.byHandoff(projectId, rel) ?? null;
    }
    let h = this.heads.get(abs);
    if (!h || h.mtime !== mtime) {
      let text = '';
      try {
        text = readFileSync(abs, 'utf8').slice(0, 20_000);
      } catch {
        return null;
      }
      h = { mtime, head: parseHandoff(text, sharedDir) };
      this.heads.set(abs, h);
    }
    const had = this.byHandoff(projectId, rel);
    if (had) return had.title ? had : this.upsert(projectId, had.page, had.card, { title: h.head.title });
    return this.join(projectId, rel, h.head);
  }

  /** A handoff's row: its page's card when it names one that has no other handoff yet, else a row of its own. */
  private join(projectId: number, rel: string, head: HandoffHead): Idea {
    const { card, title, source } = head;
    // A handoff that names its card and the minion whose page it was ("#1093's ideas, idea A1") but not the page's path.
    const onPage = head.page && card ? this.find(projectId, head.page, card) : card && source ? (this.db.prepare("SELECT * FROM ideas WHERE project_id = ? AND source_number = ? AND card = ? AND page != '' ORDER BY id LIMIT 1").get(projectId, source, card) as unknown as Idea | undefined) : undefined;
    const page = head.page ?? onPage?.page;
    if (page && card && (!onPage || !onPage.handoff)) {
      return this.upsert(projectId, page, card, { handoff: rel, title: onPage?.title || title, source_number: onPage?.source_number ?? source });
    }
    return this.upsert(projectId, '', rel, { handoff: rel, title, source_number: source });
  }

  /** A handoff deleted once its minion shipped: read the copy the minion read in its own chat, else name the row after the minion. */
  fromChat(projectId: number, sharedDir: string, rel: string, ticketId: number): Idea {
    const abs = join(sharedDir, rel);
    const like = (s: string) => `%${s.replace(/[%_]/g, '_')}%`;
    const uses = this.db.prepare(`SELECT data FROM events WHERE ticket_id = ? AND kind = 'claude' AND data LIKE '{"type":"assistant"%' AND data LIKE ? ORDER BY id LIMIT 5`).all(ticketId, like(abs)) as { data: string }[];
    const result = this.db.prepare(`SELECT data FROM events WHERE ticket_id = ? AND kind = 'claude' AND data LIKE '{"type":"user"%' AND data LIKE ? ORDER BY id LIMIT 1`);
    for (const u of uses) {
      let ids: string[] = [];
      try {
        ids = (JSON.parse(u.data).message?.content ?? []).filter((c: { type?: string; input?: unknown }) => c.type === 'tool_use' && JSON.stringify(c.input ?? '').includes(abs)).map((c: { id: string }) => c.id);
      } catch {
        continue;
      }
      for (const id of ids) {
        const r = result.get(ticketId, like(id)) as { data: string } | undefined;
        if (!r) continue;
        let text = '';
        try {
          const c = (JSON.parse(r.data).message?.content ?? []).find((x: { tool_use_id?: string }) => x.tool_use_id === id)?.content;
          text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x: { text?: string }) => x.text ?? '').join('\n') : '';
        } catch {
          continue;
        }
        // Read's output numbers each line ("    12\t…" or "12→…"); cat's doesn't.
        text = text.replace(/^ *\d+(?:\t|→)/gm, '');
        if (/^#\s/m.test(text)) return this.join(projectId, rel, parseHandoff(text.slice(0, 20_000), sharedDir));
      }
    }
    const t = this.db.prepare('SELECT title FROM tickets WHERE id = ?').get(ticketId) as { title: string } | undefined;
    return this.join(projectId, rel, { title: t?.title ?? rel, page: null, card: null, source: null });
  }

  /** A page's picks: one row per item of a later-style collection (picked, noted or, from mockkit's list, unpicked). */
  readPage(projectId: number, file: string, source: number | null, items: PageItem[] = [], sendText = ''): void {
    let colls: string[] = [];
    try {
      const mtime = statSync(file).mtimeMs;
      const hit = this.pages.get(file);
      if (hit?.mtime === mtime) colls = hit.colls;
      else {
        colls = laterCollections(readFileSync(file, 'utf8'));
        this.pages.set(file, { mtime, colls });
      }
    } catch {
      /* gone: its rows stay */
    }
    const docs = this.db.prepare("SELECT key, value FROM artifact_data WHERE project_id = ? AND file = ? AND key LIKE 'db/%'").all(projectId, file) as { key: string; value: string }[];
    const parsed = docs.flatMap((d) => {
      const m = /^db\/([^/]+)\/(.+)$/.exec(d.key);
      if (!m) return [];
      try {
        return [{ collection: m[1], id: m[2], doc: JSON.parse(d.value) as { v?: string | null; note?: string; by?: string; at?: string } }];
      } catch {
        return [];
      }
    });
    const later = new Set([...colls, ...parsed.filter((p) => p.doc.v === 'later').map((p) => p.collection), ...(this.db.prepare('SELECT DISTINCT collection FROM ideas WHERE project_id = ? AND page = ?').all(projectId, file) as { collection: string }[]).map((r) => r.collection)]);
    const titles = sendTitles(
      sendText,
      parsed.filter((p) => later.has(p.collection)).map((p) => p.id),
    );
    for (const it of items) if (later.has(it.collection) && it.title && it.title !== it.id) titles.set(it.id, it.title);
    const known = new Set<string>();
    for (const { collection, id, doc } of parsed) {
      if (!later.has(collection)) continue;
      known.add(`${collection}/${id}`);
      const label = items.find((i) => i.collection === collection && i.id === id)?.label;
      const at = doc.at ? Date.parse(doc.at) : NaN;
      this.upsert(projectId, file, id, {
        collection,
        source_number: source ?? undefined,
        pick: doc.v || null,
        decided_by: doc.by ?? null,
        words: doc.note?.trim() || null,
        decided_at: Number.isFinite(at) ? at : null,
        ...(titles.get(id) ? { title: titles.get(id) } : {}),
        ...(label ? { pick_label: label } : {}),
      });
    }
    // An item the page lists that nobody picked yet: proposed, with its title.
    for (const it of items) {
      if (!later.has(it.collection) || known.has(`${it.collection}/${it.id}`)) continue;
      const cur = this.find(projectId, file, it.id);
      this.upsert(projectId, file, it.id, { collection: it.collection, title: it.title || it.id, source_number: source ?? undefined, ...(cur?.pick ? { pick: null, decided_by: null, words: null, decided_at: null } : {}) });
    }
    // Send lines name labels too ("Build it"), for rows a page without mockkit's list made.
    for (const raw of sendText.split('\n')) {
      const line = raw.startsWith('- ') ? raw.slice(2).replace(/\. ".*"$/s, '') : '';
      const cut = line.lastIndexOf(': ');
      if (cut <= 0) continue;
      const title = line.slice(0, cut);
      const id = [...titles].find(([, t]) => t === title)?.[0];
      if (id) this.upsert(projectId, file, id, { pick_label: line.slice(cut + 2).trim() });
    }
  }

  /**
   * Every row's derived status, kept in the status column for the page's filters; a hand status wins. Until the scheme's
   * first paced ship scan has run, a ship isn't looked for here: scanning every linked minion's events at once, on a cold
   * cache after a restart, held the loop for seconds (#1414). That scan is queued instead, and sets the statuses after.
   */
  restatus(projectId: number): void {
    const warm = this.warm.has(projectId);
    if (!warm) void this.warmUp(projectId);
    this.restatusWith(projectId, warm ? this.shippedTickets(projectId) : null);
  }

  /** With no scan yet (null), only minions already known to have shipped count, and a built row stays built. */
  private restatusWith(projectId: number, shipped: Set<number> | null): void {
    for (const r of this.list(projectId)) {
      if (!shipped && r.status === 'built' && r.status_manual == null) continue;
      const s = r.status_manual ?? derive(r, !!r.ticket_id && (shipped ?? this.shipped).has(r.ticket_id));
      if (s !== r.status) this.db.prepare('UPDATE ideas SET status = ?, updated_at = ? WHERE id = ?').run(s, Date.now(), r.id);
    }
  }

  /** The scheme's ship scan, paced, then its statuses: queued behind any sync of the scheme. */
  private warmUp(projectId: number): Promise<void> {
    return this.queue(projectId, async () => {
      if (this.warm.has(projectId)) return;
      const shipped = await pace(this.shipSteps(projectId));
      this.warm.add(projectId);
      this.restatusWith(projectId, shipped);
    });
  }

  /**
   * The linked minions that shipped: a "Shipped …" line from land, a pull request merged, or three lines after a
   * ship. A minion merged into a build counts once its build's own minion has shipped.
   */
  shippedTickets(projectId: number): Set<number> {
    return drain(this.shipSteps(projectId));
  }

  /** shippedTickets as steps, one linked minion each, so a paced caller yields between them (#1414). */
  private *shipSteps(projectId: number): Generator<void, Set<number>> {
    const linked = (this.db.prepare('SELECT DISTINCT ticket_id FROM ideas WHERE project_id = ? AND ticket_id IS NOT NULL').all(projectId) as { ticket_id: number }[]).map((r) => r.ticket_id);
    const out = new Set<number>();
    // A ship line never goes away, so a shipped minion is remembered, and an unshipped one's events are only
    // read past the last one already scanned: this runs every pass, and a LIKE over every event froze the loop (#1215).
    const ship = this.db.prepare(`SELECT 1 FROM events WHERE ticket_id = ? AND id > ? AND kind IN ('note', 'user_message')
      AND (data LIKE '{"text":"Shipped %' OR data LIKE '%"text":"PR #% was merged%') LIMIT 1`);
    const last = this.db.prepare('SELECT MAX(id) AS m FROM events WHERE ticket_id = ?');
    const lesson = this.db.prepare('SELECT 1 FROM ship_lessons WHERE ticket_id = ? LIMIT 1');
    const did = (id: number) => {
      if (this.shipped.has(id)) return true;
      if (lesson.get(id)) {
        this.shipped.add(id);
        return true;
      }
      const m = (last.get(id) as { m: number | null }).m ?? 0;
      const from = this.shipScanned.get(id) ?? 0;
      if (m === from) return false;
      // m < from: the minion's events were deleted and its id reused, so scan it afresh.
      const since = m < from ? 0 : from;
      this.shipScanned.set(id, m);
      if (!ship.get(id, since)) return false;
      this.shipped.add(id);
      return true;
    };
    for (const id of linked) {
      yield;
      if (did(id)) {
        out.add(id);
        continue;
      }
      const t = this.db.prepare('SELECT build FROM tickets WHERE id = ?').get(id) as { build: number | null } | undefined;
      if (!t?.build) continue;
      const owner = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(`build-owner:${projectId}:${t.build}`) as { value: string } | undefined;
      const oid = owner ? Number(JSON.parse(owner.value)) : NaN;
      if (Number.isSafeInteger(oid) && oid !== id && did(oid)) out.add(id);
    }
    return out;
  }

  /** The minions started since the last scan whose first message or Start button names a handoff. */
  linkStarts(projectId: number, sharedDir: string): void {
    const key = `ideas_scanned:${projectId}`;
    const mark = Number((this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? 0);
    const tickets = this.db.prepare("SELECT id, number FROM tickets WHERE project_id = ? AND kind = 'ticket' AND id > ? ORDER BY id").all(projectId, mark) as { id: number; number: number | null }[];
    const first = this.db.prepare("SELECT data FROM events WHERE ticket_id = ? AND kind = 'user_message' ORDER BY id LIMIT 1");
    for (const t of tickets) {
      const row = first.get(t.id) as { data: string } | undefined;
      let text = '';
      try {
        text = row ? String(JSON.parse(row.data).text ?? '') : '';
      } catch {
        /* not JSON */
      }
      const rel = handoffIn(text, sharedDir);
      if (rel) this.linkHandoff(projectId, sharedDir, rel, t);
    }
    for (const b of this.db.prepare('SELECT path, ticket_id FROM brief_starts WHERE project_id = ? AND ticket_id IS NOT NULL').all(projectId) as { path: string; ticket_id: number }[]) {
      const rel = b.path.startsWith(sharedDir + sep) ? relative(sharedDir, b.path).split(sep).join('/') : null;
      const t = this.db.prepare('SELECT id, number FROM tickets WHERE id = ?').get(b.ticket_id) as { id: number; number: number | null } | undefined;
      if (rel && t && this.byHandoff(projectId, rel)?.ticket_id !== t.id) this.linkHandoff(projectId, sharedDir, rel, t);
    }
    if (tickets.length) this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(tickets.at(-1)!.id));
  }

  /**
   * The whole scan for one scheme: its pages, its handoffs, its minions' starts, then every row's status. Paced: it
   * yields to the event loop between pages, files, Send chunks and minions (#1414), so call it through now() or soon().
   */
  async sync(projectId: number, sharedDir: string): Promise<void> {
    await pace(this.syncSteps(projectId, sharedDir));
  }

  private *syncSteps(projectId: number, sharedDir: string): Generator<void, void> {
    const files = (this.db.prepare("SELECT DISTINCT file FROM artifact_data WHERE project_id = ? AND key LIKE 'db/%'").all(projectId) as { file: string }[]).map((r) => r.file);
    for (const file of files) {
      yield;
      const src = this.db.prepare(`SELECT t.number FROM artifacts a JOIN tickets t ON t.id = a.ticket_id WHERE a.project_id = ? AND a.path = ? AND t.kind = 'ticket' ORDER BY a.created_at LIMIT 1`).get(projectId, file) as { number: number | null } | undefined;
      // Titles the page's Sends named: read from the chats it was sent to, once per page while a row lacks one.
      const untitled = this.db.prepare("SELECT 1 FROM ideas WHERE project_id = ? AND page = ? AND title = '' LIMIT 1").get(projectId, file);
      const fresh = !this.db.prepare('SELECT 1 FROM ideas WHERE project_id = ? AND page = ? LIMIT 1').get(projectId, file);
      const key = `${projectId}\0${file}`;
      if ((!untitled && !fresh) || this.searched.has(key)) {
        this.readPage(projectId, file, src?.number ?? null);
        continue;
      }
      this.searched.add(key);
      yield* this.sendSteps(projectId);
      const sends = this.sendsOf(projectId, file);
      this.readPage(projectId, file, src?.number ?? sends.source, [], sends.text);
      // A row no Send named keeps its card id as its title, so this chat search runs once per page, not every pass.
      this.db.prepare("UPDATE ideas SET title = card WHERE project_id = ? AND page = ? AND title = ''").run(projectId, file);
    }
    for (const rel of handoffFiles(sharedDir)) {
      yield;
      this.fromHandoff(projectId, sharedDir, rel);
    }
    this.linkStarts(projectId, sharedDir);
    const shipped = yield* this.shipSteps(projectId);
    this.warm.add(projectId);
    this.restatusWith(projectId, shipped);
  }

  /** Reads the scheme's Sends past the last event read, a range of event ids per step. */
  private *sendSteps(projectId: number): Generator<void, void> {
    // On the primary key, one row: MIN and MAX in one query scan the table (eventIdAt).
    const top = (this.db.prepare('SELECT id FROM events ORDER BY id DESC LIMIT 1').get() as { id: number } | undefined)?.id ?? 0;
    let held = this.sends.get(projectId);
    // Past the newest event: the newest were deleted and their ids may come back, so read afresh.
    if (!held || held.mark > top) this.sends.set(projectId, (held = { mark: 0, rows: [] }));
    // CROSS JOIN keeps events first, on events_asks: from tickets, it read every event of the scheme's minions to check its kind.
    const range = this.db.prepare(`SELECT t.id AS ticket, e.data, t.number, t.kind FROM events e CROSS JOIN tickets t ON t.id = e.ticket_id
      WHERE e.kind = 'user_message' AND e.id > ? AND e.id <= ? AND t.project_id = ? AND e.data LIKE '%Picks on %' ORDER BY e.id`);
    while (held.mark < top) {
      const to = Math.min(held.mark + SEND_IDS, top);
      held.rows.push(...(range.all(held.mark, to, projectId) as { ticket: number; data: string; number: number | null; kind: string }[]));
      held.mark = to;
      if (held.mark < top) yield;
    }
  }

  /** The Send texts posted from a page, newest first, from any chat in the scheme, and the minion they first went to. */
  sendsOf(projectId: number, file: string): { text: string; source: number | null } {
    // The Send's comment carries the page's path. Read on the spot when sync didn't read them first (a direct caller).
    drain(this.sendSteps(projectId));
    // The rows outlive passes, so a minion deleted or moved to another scheme since they were read is dropped here.
    const here = this.db.prepare('SELECT 1 FROM tickets WHERE id = ? AND project_id = ?');
    const rows = this.sends.get(projectId)!.rows.filter((r) => r.data.includes(file) && here.get(r.ticket, projectId));
    const texts: string[] = [];
    for (const r of rows) {
      try {
        texts.push(String(JSON.parse(r.data).text ?? ''));
      } catch {
        /* skip */
      }
    }
    return { text: texts.reverse().join('\n'), source: rows.find((r) => r.kind === 'ticket')?.number ?? null };
  }

  /** Run sync soon (debounced per scheme), off the request that asked for it; errors are logged, never thrown. */
  soon(projectId: number, sharedDir: string, ms = 1500): void {
    clearTimeout(this.timers.get(projectId));
    this.timers.set(
      projectId,
      setTimeout(() => {
        this.timers.delete(projectId);
        void this.now(projectId, sharedDir);
      }, ms).unref(),
    );
  }

  now(projectId: number, sharedDir: string): Promise<void> {
    return this.queue(projectId, () => this.sync(projectId, sharedDir));
  }

  /** Runs `job` after the scheme's queued ones, so two paced scans of a scheme never interleave; errors are logged. */
  private queue(projectId: number, job: () => Promise<void>): Promise<void> {
    const prev = this.running.get(projectId) ?? Promise.resolve();
    const next = prev.then(job).catch((e) => console.error(`ideas sync ${projectId}: ${(e as Error).message}`));
    this.running.set(projectId, next);
    return next;
  }

  /** Later rows decided over two weeks ago, oldest first. */
  staleLater(projectId: number, now = Date.now()): Idea[] {
    return this.list(projectId)
      .filter((r) => r.status === 'later' && (r.decided_at ?? r.created_at) < now - LATER_STALE_MS)
      .sort((a, b) => (a.decided_at ?? a.created_at) - (b.decided_at ?? b.created_at));
  }

  /** The weekly held note's text for a scheme, or null when it isn't due or nothing waits. Records that it went. */
  laterNote(projectId: number, now = Date.now()): string | null {
    const key = `ideas_later_note:${projectId}`;
    const last = Number((this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? 0);
    if (now - last < LATER_NOTE_EVERY_MS) return null;
    const rows = this.staleLater(projectId, now);
    if (!rows.length) return null;
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(now));
    const day = pacificDay;
    const lines = rows.slice(0, 30).map((r) => `- ${r.title || r.card}${r.source_number ? ` (from #${r.source_number})` : ''}: Later since ${day(r.decided_at ?? r.created_at)}${r.decided_by ? `, ${r.decided_by}` : ''}${r.words ? `: "${r.words}"` : ''}`);
    return `(nothing to do unless you choose to) ${rows.length === 1 ? 'One idea has' : `${rows.length} ideas have`} sat at Later for over two weeks. Offer them to the members on a card when there's room (start, keep waiting, or skip); the Ideas page (Orders → Ideas) lists them on top.\n${lines.join('\n')}${rows.length > 30 ? `\n…and ${rows.length - 30} more on the page.` : ''}`;
  }
}
