// Claude Code keeps what a session needs to resume (its transcript, saved tool output, task list
// and the project's auto-memory) under its config dir, which belongs to one account on one machine.
// These copy that state into the app's database after each turn and put it back before the next,
// so a thread survives a switch of Claude account or config dir.
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { gunzipSync, gzip } from 'node:zlib';
import type { Project, Store, Ticket } from './db.ts';

const gz = promisify(gzip);

export function claudeConfigDir(env: NodeJS.ProcessEnv): string {
  return env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

/** Claude Code's folder name for a working directory under `projects/`. */
export function projectSlug(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, '-');
}

interface Scope {
  /** Rows that belong to this ticket alone; the rest of `roots` are the project's shared memory. */
  ticketRoots: string[];
  projectRoots: string[];
}

/** What a ticket's session reads on resume, as paths relative to the config dir (files or folders). */
function scope(ticket: Ticket, project: Project): Scope {
  const cwdSlug = projectSlug(ticket.cwd);
  const ticketRoots = [join('projects', cwdSlug, 'memory')];
  if (ticket.session_id) {
    ticketRoots.push(
      join('projects', cwdSlug, `${ticket.session_id}.jsonl`),
      join('projects', cwdSlug, ticket.session_id), // saved tool output, subagent transcripts
      join('tasks', ticket.session_id), // the task list behind the progress readout
    );
  }
  // Sessions in a git worktree keep auto-memory under the main checkout's folder, shared by the project.
  const projectRoots = project.repo_dir ? [join('projects', projectSlug(project.repo_dir), 'memory')] : [];
  return { ticketRoots, projectRoots };
}

async function listFiles(configDir: string, root: string): Promise<string[]> {
  const abs = join(configDir, root);
  let st;
  try {
    st = await stat(abs);
  } catch {
    return [];
  }
  if (st.isFile()) return [root];
  if (!st.isDirectory()) return [];
  const out: string[] = [];
  for (const entry of await readdir(abs, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) out.push(relative(configDir, join(entry.parentPath, entry.name)));
  }
  return out;
}

/**
 * Copy a ticket's session state from the config dir into the database, skipping files whose size
 * and mtime are unchanged. With `prune`, rows for files that are gone are dropped too; only do that
 * right after a turn, when the config dir is known to hold everything (see restoreSession).
 */
export async function saveSession(store: Store, ticket: Ticket, project: Project, configDir: string, prune: boolean) {
  const { ticketRoots, projectRoots } = scope(ticket, project);
  for (const [roots, ticketId] of [[ticketRoots, ticket.id], [projectRoots, null]] as const) {
    const seen = new Set<string>();
    for (const root of roots) {
      for (const path of await listFiles(configDir, root)) {
        seen.add(path);
        let st;
        try {
          st = await stat(join(configDir, path));
        } catch {
          continue;
        }
        const mtime = Math.round(st.mtimeMs);
        const row = store.getClaudeState(path);
        if (row && row.size === st.size && row.mtime === mtime) continue;
        const data = await gz(await readFile(join(configDir, path)));
        store.putClaudeState({ path, project_id: project.id, ticket_id: ticketId, size: st.size, mtime, data });
      }
    }
    if (!prune) continue;
    const rows = ticketId === null ? store.listClaudeState(project.id, null) : store.listClaudeState(project.id, ticketId);
    for (const row of rows) {
      const inRoots = roots.some((r) => row.path === r || row.path.startsWith(r + sep));
      // A row outside the current roots (an earlier session id) or a file deleted since: drop it.
      if (!inRoots || !seen.has(row.path)) store.deleteClaudeState(row.path);
    }
  }
}

/**
 * Write back any of a ticket's stored session state that the config dir is missing or has an older
 * copy of. Synchronous, since it runs just before the turn's process starts; normally it only stats.
 * Returns how many files it wrote.
 */
export function restoreSession(store: Store, ticket: Ticket, project: Project, configDir: string): number {
  let written = 0;
  const rows = [...store.listClaudeState(project.id, ticket.id), ...store.listClaudeState(project.id, null)];
  for (const meta of rows) {
    const abs = join(configDir, meta.path);
    if (!abs.startsWith(configDir + sep)) continue;
    if (existsSync(abs) && statSync(abs).mtimeMs >= meta.mtime) continue;
    const row = store.getClaudeState(meta.path, true);
    if (!row?.data) continue;
    mkdirSync(dirname(abs), { recursive: true, mode: 0o700 });
    writeFileSync(abs, gunzipSync(row.data), { mode: 0o600 });
    utimesSync(abs, new Date(row.mtime), new Date(row.mtime));
    written++;
  }
  return written;
}

/**
 * The effort level the session's latest reply ran at, read from the end of its transcript (the
 * stream Claude Code prints doesn't report it). Null if there is no transcript or no effort in it.
 */
export function lastEffort(ticket: Ticket, configDir: string): string | null {
  if (!ticket.session_id || !ticket.cwd) return null;
  const path = join(configDir, 'projects', projectSlug(ticket.cwd), `${ticket.session_id}.jsonl`);
  let fd;
  try {
    fd = openSync(path, 'r');
  } catch {
    return null;
  }
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(size, 256 * 1024);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const all = [...buf.toString('utf8').matchAll(/"effort":"([a-z]+)"/g)];
    return all.length ? all[all.length - 1][1] : null;
  } finally {
    closeSync(fd);
  }
}
