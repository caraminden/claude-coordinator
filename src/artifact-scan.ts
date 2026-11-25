// Artifact scanning: which of a minion's files its replies linked, kept in the store and told to open
// pages. Moved out of server.ts (docs/adr/0002-background-jobs-out-of-server.md); importing it starts nothing.
import { existsSync } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { fileType, findArtifacts, findByName, isArtifact, linkedPaths, MAX_SHARED_FILES, sharedListable, type FoundArtifact } from './artifacts.ts';
import type { Store, Ticket } from './db.ts';
import type { SharedFile } from './http.ts';
import { projectDir, projectSharedDir } from './workspace.ts';

// Rescan a ticket's folder shortly after it may have written files, at most once per delay.
export const SCAN_DELAY_MS = 2000;
// After a tool result, look again at most this often (#1542): each look starts several `git` processes on the server's
// one thread, and tool results come many times a minute per running turn. A reply that links a file, or the turn's end,
// looks within SCAN_DELAY_MS.
export const TOOL_GAP_MS = 45_000;

/** One pending run per ticket: `soon` runs within `delayMs`, otherwise no sooner than `gapMs` after the last run. */
export class ScanTimers {
  private timers = new Map<number, { at: number; timer: NodeJS.Timeout }>();
  private last = new Map<number, number>();
  private run: (ticketId: number) => void;
  private delayMs: number;
  private gapMs: number;

  constructor(run: (ticketId: number) => void, delayMs: number, gapMs: number) {
    this.run = run;
    this.delayMs = delayMs;
    this.gapMs = gapMs;
  }

  schedule(ticketId: number, soon = false) {
    const now = Date.now();
    const at = Math.max(now + this.delayMs, soon ? 0 : (this.last.get(ticketId) ?? -Infinity) + this.gapMs);
    const pending = this.timers.get(ticketId);
    if (pending && pending.at <= at) return;
    if (pending) clearTimeout(pending.timer);
    this.timers.set(ticketId, {
      at,
      timer: setTimeout(() => {
        this.timers.delete(ticketId);
        this.last.set(ticketId, Date.now());
        this.run(ticketId);
      }, at - now),
    });
  }
}
// The file a broken link's name finds (findByName), kept a while: a scan runs every few seconds, and
// broken links stay in the replies for good.
const NAME_FIX_MS = 10 * 60_000;
/** Claude events read per step of a reply scan, with the loop let go between steps (#609). */
const REPLY_PAGE = 200;

export class ArtifactScanner {
  private timers: ScanTimers;
  private scanning = new Map<number, Promise<void>>();
  // What each project's shared folder held at the last scan, so a change can tell open pages to refresh.
  private sharedSeen = new Map<number, string>();
  private nameFixes = new Map<string, { match: string | null; at: number }>();
  // The paths each ticket's replies linked, up to the last event read: a scan reads only what came since (#609). A reply's
  // text never changes once stored (strikes and replaced only add fields; the one rewrite, events_slimmed, runs at boot).
  private links = new Map<number, { cwd: string; upTo: number; linked: Set<string> }>();

  private store: Store;
  private dataDir: string;
  private broadcast: (msg: object) => void;

  constructor(store: Store, dataDir: string, broadcast: (msg: object) => void, delayMs = SCAN_DELAY_MS, gapMs = TOOL_GAP_MS) {
    this.store = store;
    this.dataDir = dataDir;
    this.broadcast = broadcast;
    this.timers = new ScanTimers((id) => this.scan(id).catch((err) => console.error(`Artifact scan of ticket ${id} failed:`, err)), delayMs, gapMs);
  }

  /** Where a ticket keeps files it fetched or made to show people, outside its repo. */
  sharedDir = (ticket: Ticket): string => join(projectDir(this.dataDir, ticket.project_id), 'shared', String(ticket.id));

  /** Scan a ticket's files again: `soon` after a reply that links one or a turn's end, else throttled (ScanTimers). */
  schedule(ticketId: number, soon = false) {
    this.timers.schedule(ticketId, soon);
  }

  /**
   * The documents, pages, pictures, clips and sound in a project's shared folder, newest first, paths relative to it, with
   * their pins. A pinned file that is gone stays listed as missing, like a pinned artifact.
   */
  sharedFiles = async (projectId: number): Promise<SharedFile[]> => {
    const dir = projectSharedDir(this.dataDir, projectId);
    const files: (FoundArtifact & { missing?: number })[] = await findArtifacts(dir, false, sharedListable, MAX_SHARED_FILES);
    const pins = new Map(this.store.sharedPins(projectId).map((p) => [p.path, p]));
    const seen = new Set(files.map((f) => f.path));
    const real = await realpath(dir).catch(() => dir);
    for (const p of pins.values()) {
      if (seen.has(p.path)) continue;
      // Past the scan's file cap, or gone. A symlink on the way out of the folder counts as gone, as the scan skips it.
      const inside = (await realpath(join(dir, p.path)).catch(() => null)) === join(real, p.path);
      const st = inside ? await lstat(join(dir, p.path)).catch(() => null) : null;
      files.push(st?.isFile() ? { path: p.path, size: st.size, mtime: Math.round(st.mtimeMs) } : { path: p.path, size: 0, mtime: p.pinned_at, missing: 1 });
    }
    return files
      .sort((a, b) => b.mtime - a.mtime)
      .map((f) => ({
        ...f,
        name: basename(f.path),
        kind: fileType(f.path)?.kind ?? 'text',
        display_path: `scheme shared/${f.path}`,
        pinned_at: pins.get(f.path)?.pinned_at ?? null,
        pinned_by: pins.get(f.path)?.pinned_by ?? null,
        missing: f.missing ?? 0,
      }));
  };

  private async scanShared(projectId: number) {
    const sig = JSON.stringify((await this.sharedFiles(projectId)).map((f) => [f.path, f.size, f.mtime]));
    if (this.sharedSeen.get(projectId) === sig) return;
    // The first look after a start only records what is there.
    if (this.sharedSeen.has(projectId)) this.broadcast({ type: 'artifacts', projectId });
    this.sharedSeen.set(projectId, sig);
  }

  /** The paths a ticket's replies linked so far, reading only the events since the last call, a page at a time. */
  private async linkedSoFar(ticketId: number, cwd: string): Promise<Set<string>> {
    let seen = this.links.get(ticketId);
    if (seen?.cwd !== cwd) this.links.set(ticketId, (seen = { cwd, upTo: 0, linked: new Set() }));
    for (let more = true; more; ) {
      const page = this.store.replyTexts(ticketId, seen.upTo, REPLY_PAGE);
      for (const p of linkedPaths(page.texts, cwd)) seen.linked.add(p);
      seen.upTo = page.upTo;
      more = page.more;
      if (more) await new Promise((r) => setImmediate(r));
    }
    return seen.linked;
  }

  async scan(ticketId: number) {
    // One scan per ticket at a time; a request during a scan waits for it, then rescans.
    while (this.scanning.has(ticketId)) await this.scanning.get(ticketId);
    const job = (async () => {
      const ticket = this.store.getTicket(ticketId);
      // A dismissed minion whose worktree the sweep removed (#660) keeps its rows until a reopen brings the folder back.
      if (!ticket?.cwd || !existsSync(ticket.cwd)) return;
      const shared = this.sharedDir(ticket);
      const found = [
        ...(await findArtifacts(ticket.cwd, !!ticket.branch)),
        // Files in the shared folder are stored by absolute path, since they sit outside the working directory.
        ...(await findArtifacts(shared, false)).map((f) => ({ ...f, path: join(shared, f.path) })),
      ];
      // Only files a reply linked are meant for people; the rest are the ticket's own working files.
      // A pinned file stays listed either way.
      const linked = new Set(await this.linkedSoFar(ticketId, ticket.cwd));
      // A link with the wrong folders counts for the one file of its name, as the chat opens it (#281).
      for (const abs of [...linked]) {
        if (!isArtifact(abs) || (await realpath(abs).catch(() => null))) continue;
        const key = `${ticketId}\0${abs}`;
        let fix = this.nameFixes.get(key);
        if (!fix || Date.now() - fix.at > NAME_FIX_MS) {
          this.nameFixes.set(key, (fix = { match: await findByName(abs, [ticket.cwd, shared, projectSharedDir(this.dataDir, ticket.project_id)]), at: Date.now() }));
        }
        if (fix.match) linked.add(fix.match);
      }
      const pinned = new Set(this.store.pinnedArtifactPaths(ticketId));
      const shown = found.filter((f) => linked.has(isAbsolute(f.path) ? f.path : join(ticket.cwd, f.path)) || pinned.has(f.path));
      if (await this.store.syncArtifacts(ticket, shown)) this.broadcast({ type: 'artifacts', projectId: ticket.project_id });
      await this.scanShared(ticket.project_id);
    })();
    this.scanning.set(ticketId, job);
    try {
      await job;
    } finally {
      this.scanning.delete(ticketId);
    }
  }
}
