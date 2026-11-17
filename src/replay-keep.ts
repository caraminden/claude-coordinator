// Kept chats for replay tests (#836): a contraption turn sent with `keep: true` saves what it streamed, for the first
// KEEP_TURNS turns of each session, so `citadel-replay` (src/replay.ts) can rerun real players' words against a changed
// prompt. Files sit in the contraption's home scheme's shared folder under `.replay/<app>/`: a dot folder, so the Files
// view never lists them and the files route never serves them, while the scheme's minions can read them. Nothing here
// logs their content. They go after KEEP_DAYS, with the session (DELETE /sessions/:name), and when the person opts out
// in Settings → Your account (`replay_optout:<person>`).
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ContraptionRow } from './db.ts';
import { projectDir } from './workspace.ts';

export const KEEP_TURNS = 5;
export const KEEP_DAYS = 30;
/** How much of one tool result or the reply text a kept turn holds. */
const PART_MAX = 20_000;

/** The person setting that turns keeping off for them (on by default, as Josh's 2026-11-12 feedback call covers). */
export const optOutKey = (person: number) => `replay_optout:${person}`;

/** One tool call of a kept turn: the stub (src/replay.ts) answers a replay's calls from these. */
export interface KeptCall {
  name: string;
  input: unknown;
  ok: boolean | null;
  result: string | null;
}

/** One kept turn, a line of its session's file. */
export interface KeptTurn {
  v: 1;
  at: number;
  /** The turn's id (contraption_turns.id, the start event's `turn`): #844's audit row for it has the same key. */
  turn: number;
  /** The turn's number in the session, from 1. */
  n: number;
  prompt: string;
  /** Images the turn carried, not kept. */
  images: number;
  /** sha256 of the app's own system text, so a replay can say whether its "old prompt" is the one this ran on. */
  system: string;
  model: string | null;
  servers: string[];
  agents: boolean;
  webSearch: boolean;
  compactWindow: number;
  calls: KeptCall[];
  text: string;
  stop: string;
}

export const cap = (s: string) => (s.length > PART_MAX ? `${s.slice(0, PART_MAX)}\n[cut at ${PART_MAX} characters when kept]` : s);
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** The folder a contraption's kept chats go in, or null when it has no home scheme. */
export function keptDir(dataDir: string, c: Pick<ContraptionRow, 'name' | 'home_scheme'>): string | null {
  return c.home_scheme ? join(projectDir(dataDir, c.home_scheme), 'shared', 'project', '.replay', c.name) : null;
}

/** A person's files start with this: not their id, so a file name alone doesn't say whose chat it is. */
const personPrefix = (person: number) => sha256(`citadel-replay:${person}`).slice(0, 12);
const sessionPrefix = (person: number, session: string) => `${personPrefix(person)}-${session}-`;
/** One file per Claude session, so a fresh start under the same name is a chat of its own. */
export const keptFile = (dir: string, person: number, session: string, claudeSession: string) => join(dir, `${sessionPrefix(person, session)}${claudeSession.slice(0, 8)}.jsonl`);

/** Turns already kept in a file (0 when there is none). */
function turnsIn(file: string): number {
  try {
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

/** Whether this turn of the session is still one to keep. */
export function wantsKeep(file: string): boolean {
  return turnsIn(file) < KEEP_TURNS;
}

/** Add a turn to its session's file, and drop the folder's files past KEEP_DAYS. */
export function keepTurn(file: string, turn: Omit<KeptTurn, 'v' | 'n'>, now = Date.now()) {
  const n = turnsIn(file) + 1;
  if (n > KEEP_TURNS) return;
  const dir = join(file, '..');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  appendFileSync(file, JSON.stringify({ v: 1, n, ...turn }) + '\n', { mode: 0o600 });
  prune(dir, now);
}

/** Delete files in a kept folder last written more than KEEP_DAYS ago. */
export function prune(dir: string, now = Date.now()) {
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) {
    const path = join(dir, f);
    try {
      if (now - statSync(path).mtimeMs > KEEP_DAYS * 86_400_000) rmSync(path, { force: true });
    } catch {}
  }
}

/** Delete a session name's kept chats (every fresh start under it). The whole name must match: session `a`'s prefix
 * is also the start of session `a-b`'s files. */
export function dropKeptSession(dir: string | null, person: number, session: string) {
  const prefix = sessionPrefix(person, session);
  dropMatching(dir, (f) => f.startsWith(prefix) && /^[0-9a-f]{8}\.jsonl$/.test(f.slice(prefix.length)));
}

/** Delete everything kept of a person's in these folders (their opt-out). */
export function dropKeptPerson(dirs: (string | null)[], person: number) {
  const prefix = `${personPrefix(person)}-`;
  for (const dir of dirs) dropMatching(dir, (f) => f.startsWith(prefix));
}

function dropMatching(dir: string | null, match: (file: string) => boolean) {
  if (!dir || !existsSync(dir)) return;
  for (const f of readdirSync(dir)) if (match(f)) rmSync(join(dir, f), { force: true });
}

/** Every kept-chats folder on the server, apps no longer registered included: for the daily prune and opt-outs. */
export function keptDirs(dataDir: string): string[] {
  const root = join(dataDir, 'projects');
  const sub = (d: string) => { try { return readdirSync(d).map((f) => join(d, f)); } catch { return []; } };
  return sub(root).flatMap((p) => sub(join(p, 'shared', 'project', '.replay')));
}

/** The daily sweep: files past KEEP_DAYS in every kept folder, so an app that stops keeping still loses its old chats. */
export function sweepKept(dataDir: string, now = Date.now()) {
  for (const dir of keptDirs(dataDir)) prune(dir, now);
}
