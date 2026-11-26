/**
 * Keeping a waiting minion's prompt cache warm (#862, Cara 2026-11-16 on #854: "Could we build a cache monitor
 * that gets marked dirty automatically if we change a prompt? lets also limit the keep alives to "working hours"
 * something like 11am to midnight. If we do this I want to be sure we are optimizing and not wasting tokens with
 * the pings"). The cache lives an hour; a minion waiting on a person past that re-writes its whole context when
 * they answer. A one-line keepalive turn 55 minutes after its last turn re-reads the prefix instead, at a tenth of
 * the price. The pure parts are here: the window, the fingerprint of what the cached prefix holds, the miss check
 * and the week's readout. The runner (keepaliveSweep) schedules and runs the turns.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { ZONE } from './pacific.ts';

/** A keepalive goes this long after the minion's last turn (or keepalive) ended: inside the cache's hour. */
export const KEEPALIVE_AFTER_MS = 55 * 60_000;
/** The prompt cache's life (Claude Code asks for the 1 h TTL). */
export const CACHE_TTL_MS = 60 * 60_000;
/** A series stops this long after the real turn that started it. */
export const SERIES_CAP_MS = 8 * 3_600_000;
/** A keepalive that writes more than this to the cache missed it: something in the prefix moved. */
export const MISS_WRITE_TOKENS = 5_000;
/** Working hours, Pacific: from 11:00 until midnight. */
const WINDOW_FROM_HOUR = 11;
/** The keepalive's whole message: a few tokens in, one out. */
export const KEEPALIVE_TEXT = 'Keepalive from Citadel, nothing to do: reply with a single period and call no tools.';

/** Per minion: the series since its last real turn (KeepaliveSeries). */
export const keepaliveKey = (ticketId: number) => `keepalive:${ticketId}`;
/** Server-wide off switch, with why: { reason, at }. */
export const KEEPALIVE_OFF_KEY = 'keepalive_off';
/** When the last week's readout went to the Taskmaster (ms). */
export const KEEPALIVE_REPORT_KEY = 'keepalive_report_at';
export const WEEK_MS = 7 * 24 * 3_600_000;
/** Per Pacific day, how many due minions each gate turned away, and how many "passed" (#1274): { day: { gate: n } }. */
export const KEEPALIVE_GATES_KEY = 'keepalive_gates';
/** Days of gate counts kept. */
const GATE_DAYS = 14;

/** `counts` with `by` (one, or -1 to move a count away) added to `gate` on `day`, keeping the last GATE_DAYS days. */
export function countGate(counts: Record<string, Record<string, number>> | null, day: string, gate: string, by = 1): Record<string, Record<string, number>> {
  const n = (counts?.[day]?.[gate] ?? 0) + by;
  const { [gate]: _, ...rest } = counts?.[day] ?? {};
  const next = { ...counts, [day]: n > 0 ? { ...rest, [gate]: n } : rest };
  return Object.fromEntries(
    Object.entries(next)
      .sort(([a], [b]) => b.localeCompare(a))
      .slice(0, GATE_DAYS),
  );
}

export interface KeepaliveSeries {
  /** The fingerprint of the cached prefix the last real turn ran with. */
  fp: string;
  /** Its parts' hashes, so a dirty series can say which part moved. */
  parts: Record<string, string>;
  /** When the real turn that started it ended. */
  since: number;
  /** The real turn ran at low effort (#951): its keepalives launch the same way, so their prefix matches. */
  light?: true;
  /** Why it stopped: dirty (the prefix moved), missed (a ping wrote the cache), failed (a ping failed). */
  stopped?: 'dirty' | 'missed' | 'failed';
}

const hour = new Intl.DateTimeFormat('en-US', { timeZone: ZONE, hour: 'numeric', hourCycle: 'h23' });

/** Inside working hours, 11:00 to midnight Pacific. */
export function inWindow(now: number): boolean {
  return Number(hour.format(now)) >= WINDOW_FROM_HOUR;
}

/** Claude Code's date line, in the turn's own time zone (turnEnv sets it to Pacific). */
export function turnDate(now: number, tz?: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz || undefined, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export interface PrefixInput {
  /** The turn's own folder, which every path below may name: it differs every turn but the prefix doesn't. */
  dir: string;
  systemPrompt: string;
  args: string[];
  files: { name: string; text: string }[];
  env: Record<string, string>;
  /** treeHash of the pinned files (MCP server, kit, hooks). */
  pinned: string;
  /** claudeStamp: which Claude Code build runs it. */
  claude: string;
  /** contextText: CLAUDE.md, rules and auto-memory it loads. */
  context: string;
  date: string;
}

const short = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);
/** Env that shapes the tool list or Claude Code's prompt, never a token or a secret. */
const prefixEnv = (name: string) => (/^(COORDINATOR_|CLAUDE_CODE_)/.test(name) || name === 'MCP_TOOL_TIMEOUT') && !/TOKEN|SECRET|KEY|PASS/.test(name);

/** A hash per part of what the cached prefix is built from, the turn's own folder taken out. */
export function prefixParts(p: PrefixInput): Record<string, string> {
  const norm = (s: string) => s.split(p.dir).join('<turn>');
  const env = Object.keys(p.env)
    .filter(prefixEnv)
    .sort()
    .map((k) => `${k}=${norm(p.env[k])}`);
  const files = p.files.filter((f) => f.name === 'mcp.json' || f.name === 'settings.json').map((f) => `${f.name}\n${norm(f.text)}`);
  return {
    system: short(p.systemPrompt),
    args: short(norm(JSON.stringify(p.args))),
    files: short(files.join('\n')),
    env: short(env.join('\n')),
    pinned: short(p.pinned),
    claude: short(p.claude),
    context: short(p.context),
    date: short(p.date),
  };
}

export function fingerprint(parts: Record<string, string>): string {
  return short(
    Object.keys(parts)
      .sort()
      .map((k) => `${k}:${parts[k]}`)
      .join('\n'),
  );
}

/** The parts whose hash differs (or that one side lacks). */
export function changedParts(a: Record<string, string>, b: Record<string, string>): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]);
}

const trees = new Map<string, string>();
/**
 * A hash of a folder's files, once per process: the pinned files only change with a restart. Content for
 * files under a megabyte, size alone above (the pinned node binary), so a restart that changed nothing in
 * them keeps the same hash.
 */
export function treeHash(root: string): string {
  const known = trees.get(root);
  if (known) return known;
  const h = createHash('sha256');
  const walk = (dir: string, rel: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, e.name);
      if (e.isDirectory()) walk(path, `${rel}${e.name}/`);
      else if (e.isFile()) {
        const size = statSync(path).size;
        h.update(`${rel}${e.name}\0${size}\0`);
        if (size < 1_000_000) h.update(readFileSync(path));
      }
    }
  };
  try {
    walk(root, '');
  } catch {
    // No pins (a test): the hash says so.
  }
  const out = h.digest('hex');
  trees.set(root, out);
  return out;
}

/** Which Claude Code build a command runs: its real path, size and time, so an update counts as a change. */
export function claudeStamp(bin: string, path = process.env.PATH ?? ''): string {
  try {
    const found = isAbsolute(bin)
      ? bin
      : path
          .split(delimiter)
          .map((d) => join(d, bin))
          // The turn's own claude-pace link (#1748) names its turn folder and the server's start: skip it for the CLI it hands to.
          .find((p) => existsSync(p) && !realpathSync(p).endsWith('/claude-pace'));
    if (!found) return bin;
    const real = realpathSync(found);
    const s = statSync(real);
    return `${real}\0${s.size}\0${s.mtimeMs}`;
  } catch {
    return bin;
  }
}

/**
 * The instructions Claude Code loads at a session's start: CLAUDE.md files from the working directory up, the
 * project's unscoped and scoped rules, the user's own CLAUDE.md and rules, and auto-memory's index.
 */
export async function contextText(cwd: string, configDir: string, memoryIndexes: string[]): Promise<string> {
  // With fs/promises, read one at a time in the order Claude Code loads them (#1808): a turn's launch makes no blocking file call.
  const out: string[] = [];
  const read = async (p: string) => {
    try {
      out.push(`${p}\n${await readFile(p, 'utf8')}`);
    } catch {
      // Not there.
    }
  };
  const rules = async (dir: string) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true, recursive: true });
    } catch {
      return; // No rules.
    }
    for (const e of entries.sort((a, b) => join(a.parentPath, a.name).localeCompare(join(b.parentPath, b.name)))) {
      if (e.isFile() && e.name.endsWith('.md')) await read(join(e.parentPath, e.name));
    }
  };
  for (let d = cwd; ; d = dirname(d)) {
    for (const f of ['CLAUDE.md', 'CLAUDE.local.md', '.claude/CLAUDE.md']) await read(join(d, f));
    await rules(join(d, '.claude', 'rules'));
    if (dirname(d) === d) break;
  }
  await read(join(configDir, 'CLAUDE.md'));
  await rules(join(configDir, 'rules'));
  for (const m of memoryIndexes) await read(m);
  return out.join('\n');
}

/** A keepalive's usage says it missed the cache. */
export function missed(usage: { cache_creation_input_tokens?: number | null } | null | undefined): boolean {
  return (usage?.cache_creation_input_tokens ?? 0) > MISS_WRITE_TOKENS;
}

/** More than a fifth of a day's keepalives missed, out of enough to judge (5), and at least 3: one cache flush on Anthropic's side misses 2 (#2034). */
export function tooManyMisses(pings: number, misses: number): boolean {
  return pings >= 5 && misses >= 3 && misses * 5 > pings;
}

export interface KeepaliveRow {
  ticket_id: number;
  ended_at: number;
  duration_ms: number | null;
  cost_usd: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  keepalive: number | null;
}

export interface KeepaliveReport {
  pings: number;
  misses: number;
  pingUsd: number;
  /** Waits (a real turn over an hour after the last) that started on a cache a keepalive kept warm. */
  warm: number;
  /** Waits that started cold. */
  cold: number;
  /** What the warm wakes' reloads would have cost: the context re-written (2x) instead of read (0.1x). */
  savedUsd: number;
  netUsd: number;
}

/** A turn's price per input-token equivalent, from its own cost: reads 0.1x, 1 h writes 2x, output 5x. */
function unitPrice(r: KeepaliveRow): number {
  const units = (r.input_tokens ?? 0) + 0.1 * (r.cache_read_tokens ?? 0) + 2 * (r.cache_write_tokens ?? 0) + 5 * (r.output_tokens ?? 0);
  return units > 0 ? r.cost_usd / units : 0;
}

/** The readout for minion turns: keepalives that ended in [from, to), and waits whose turn started then. */
export function weekReport(rows: KeepaliveRow[], from: number, to: number): KeepaliveReport {
  const r: KeepaliveReport = { pings: 0, misses: 0, pingUsd: 0, warm: 0, cold: 0, savedUsd: 0, netUsd: 0 };
  const sorted = [...rows].sort((a, b) => a.ticket_id - b.ticket_id || a.ended_at - b.ended_at);
  let ticket = -1;
  let lastReal: number | null = null;
  let lastPing: KeepaliveRow | null = null;
  const within = (t: number) => t >= from && t < to;
  for (const row of sorted) {
    if (row.ticket_id !== ticket) {
      ticket = row.ticket_id;
      lastReal = null;
      lastPing = null;
    }
    if (row.keepalive) {
      if (within(row.ended_at)) {
        r.pings++;
        r.pingUsd += row.cost_usd;
        if (missed({ cache_creation_input_tokens: row.cache_write_tokens })) r.misses++;
      }
      lastPing = row;
      continue;
    }
    const start = row.ended_at - (row.duration_ms ?? 0);
    if (within(start) && lastReal !== null && start - lastReal > CACHE_TTL_MS) {
      const warmPing = lastPing && start - lastPing.ended_at <= CACHE_TTL_MS && !missed({ cache_creation_input_tokens: lastPing.cache_write_tokens }) ? lastPing : null;
      if (warmPing) {
        r.warm++;
        r.savedUsd += (warmPing.cache_read_tokens ?? 0) * 1.9 * unitPrice(warmPing);
      } else r.cold++;
    }
    lastReal = row.ended_at;
    lastPing = null;
  }
  r.netUsd = r.savedUsd - r.pingUsd;
  return r;
}

const usd = (n: number) => `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`;

/** The week's line for the Taskmaster. */
export function reportText(r: KeepaliveReport, off: boolean): string {
  return (
    `Minion keepalives, last 7 days (#862): ${r.pings} pings cost ${usd(r.pingUsd)}${r.misses ? ` (${r.misses} missed the cache)` : ''}; ` +
    `${r.warm} waits ended in a warm wake, ${r.cold} cold; the warm wakes saved about ${usd(r.savedUsd)} of reloads, so the net is ${r.netUsd >= 0 ? '+' : ''}${usd(r.netUsd)}.` +
    (off ? ' The net is below zero, so keepalives are now off server-wide (setting keepalive_off).' : '')
  );
}
