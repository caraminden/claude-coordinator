/**
 * The seen guard (PostToolUse on Bash and Read, Grunts included, inside run.ts; #1920): file lines a session already
 * has in front of it are not printed a second time (Josh, 2026-11-24: "we CERTAINLY shouldnt let a minion read the
 * same file over and over"). It judges what came out, not the command: output lines that follow each other in a file the
 * command names (or one read before) are a read of those lines, through Read, cat, sed, a pipe, a cd or a loop alike.
 *
 * - Read less than an hour ago with no compaction since: 15+ unchanged lines become one line saying when they came.
 * - Read before a compaction: any run of up to SMALL lines (a range about to be edited) prints again, and a longer one
 *   while the window's re-reads fit in REREAD_CHARS; one that doesn't fit (the wholesale second pass) becomes its outline.
 * - A changed line prints, with CONTEXT lines around it. `# allow_large` in a command, or `allow_large: true` on Read,
 *   prints everything; each use that mattered is counted in the retro log.
 *
 * It adds a line once a window has GULP chars of file text. afterCompact (after-compact.sh) marks a compaction and hands back
 * what was read. The log of what was read is $TMPDIR/citadel-kit/seen-<session>.jsonl; a compaction drops what is
 * older than KEEP_WINDOWS windows. Fails open.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HookInput } from './hook-input.ts';
import { note } from './retro-log.ts';

const CUT_MIN = 15; // shorter repeats print: cutting them saves less than the line that says so
const SMALL = 25;
const CONTEXT = 8;
const REREAD_CHARS = 12_000;
const FRESH_MS = 60 * 60_000; // past this Claude Code may have cleared the old result, so it counts as before a compaction
const GULP = 100_000;
const GULP_AGAIN = 60_000;
const BURST_MS = 15 * 60_000;
const KEEP_WINDOWS = 4;
const FILE_MAX = 2 * 1024 * 1024;
const DEF = /^ {0,2}(?:export )?(?:default )?(?:async )?(?:pub(?:\([^)]*\))? )?(?:(?:function|class|interface|type|enum|struct|impl|fn|def|func|test|describe)\b[*\s('"`]*([\w$.: -]{2,50})|([A-Za-z_]\w+)\s*\(\)\s*\{)|^(?:export )?const ([A-Za-z_$][\w$]{3,})|^(#{1,4} .{1,50})/;

/** One read: lines `from`.. of `file`, one hash a line (with the line before it, so a moved line still matches). */
interface Read {
  t: number;
  file: string;
  from: number;
  hashes: string[];
  chars: number;
  by: string;
  /** Printed again after a compaction. */
  again?: number;
}
type Entry = Read | { t: number; compact: 1 };

interface State {
  compacts: number[];
  /** A line's latest print: which window, when, by what. */
  lines: Map<string, { win: number; t: number; by: string }>;
  reads: (Read & { win: number })[];
  /** File text printed in this window, and the part of it that was read before a compaction. */
  chars: number;
  again: number;
}

export interface Files {
  read(path: string): string | null;
  stateDir: string;
  now: number;
}

const who = (input: HookInput) => `${input.session_id ?? 'unknown'}${input.agent_id ? `-${input.agent_id}` : ''}`.replace(/[^\w.-]/g, '_');
const stateFile = (input: HookInput, dir: string) => join(dir, `seen-${who(input)}.jsonl`);
/** A session's own notes, a Grunt's its own: one minion's later sessions and its Grunts share its TMPDIR. */
const notesName = (input: HookInput) => `notes-${(input.agent_id ?? input.session_id ?? 'unknown').replace(/[^\w.-]/g, '_').slice(0, 8)}.md`;

function append(input: HookInput, dir: string, entries: Entry[]): void {
  if (!entries.length) return;
  mkdirSync(dir, { recursive: true });
  appendFileSync(stateFile(input, dir), entries.map((e) => `${JSON.stringify(e)}\n`).join(''));
}

function load(input: HookInput, dir: string): State {
  const s: State = { compacts: [], lines: new Map(), reads: [], chars: 0, again: 0 };
  const file = stateFile(input, dir);
  if (!existsSync(file)) return s;
  for (const row of readFileSync(file, 'utf8').split('\n')) {
    if (!row) continue;
    const e = JSON.parse(row) as Entry;
    if ('compact' in e) {
      s.compacts.push(e.t);
      s.chars = s.again = 0;
      continue;
    }
    const win = s.compacts.length;
    for (const h of e.hashes) s.lines.set(h, { win, t: e.t, by: e.by });
    s.reads.push({ ...e, win });
    s.chars += e.chars;
    s.again += e.again ?? 0;
  }
  return s;
}

/** A text file's text, or null for a missing, big or binary one. */
function readText(path: string): string | null {
  const st = statSync(path, { throwIfNoEntry: false });
  if (!st?.isFile() || st.size > FILE_MAX) return null;
  const text = readFileSync(path, 'utf8');
  return text.slice(0, 8000).includes('\0') ? null : text;
}

const linesOf = (text: string) => {
  const all = text.split('\n');
  if (all.at(-1) === '') all.pop();
  return all;
};

/** The files a command may have printed: every path in it that exists (from its folder or one it cds to), and files read before whose name it holds. */
function candidates(command: string, cwd: string, before: Set<string>, files: Files): { path: string; lines: string[] }[] {
  const vars: Record<string, string> = { TMPDIR: tmpdir(), HOME: process.env.HOME ?? '' };
  for (const m of command.matchAll(/(?:^|[\s;&])(\w+)=(['"]?)([^\s;&'"]+)\2/g)) vars[m[1]] = m[3].replace(/\$\{?(\w+)\}?/g, (w, v) => vars[v] ?? w);
  const text = command.replace(/\$\{?(\w+)\}?/g, (w, v) => vars[v] ?? w);
  const dirs = [cwd];
  for (const m of text.matchAll(/\b(?:cd|-C)\s+['"]?([^\s;&|'"]+)/g)) dirs.push(resolve(dirs.at(-1)!, m[1]));
  const out = new Map<string, string[]>();
  const add = (path: string) => {
    if (out.has(path) || out.size >= 12) return;
    const t = files.read(path);
    if (t !== null) out.set(path, linesOf(t));
  };
  // A revision's copy (main:src/x.ts) is looked up as the file itself: only lines that match it count.
  for (const m of text.matchAll(/[\w@~./+-]*[\w+-]/g)) for (const d of dirs) if (/[./]/.test(m[0])) add(resolve(d, m[0]));
  for (const p of before) if (text.includes(basename(p))) add(p);
  return [...out].map(([path, lines]) => ({ path, lines }));
}

interface Run {
  /** Index of its first output line. */
  at: number;
  len: number;
  path: string;
  lines: string[];
  /** Index of its first line in the file. */
  from: number;
}

const KEY = 60;
const bare = (l: string) => l.replace(/^ *\d+[\t:-]/, '');

/** Is this output line that file line: whole, cut short (cut -c1-160), or with a line number in front. */
const isLine = (shown: string, line: string) => [shown, bare(shown)].some((s) => s === line || (s.length >= KEY && line.startsWith(s)));

/** The runs of 3+ output lines that follow each other in one of the files. */
export function fileRuns(shown: string[], files: { path: string; lines: string[] }[]): Run[] {
  const index = files.map((f) => {
    const m = new Map<string, number[]>();
    for (const [i, l] of f.lines.entries()) if (l.trim().length > 3) m.set(l.slice(0, KEY), [...(m.get(l.slice(0, KEY)) ?? []), i].slice(0, 40));
    return m;
  });
  const runs: Run[] = [];
  for (let i = 0; i < shown.length; ) {
    let best: Run | null = null;
    if (shown[i].trim().length > 3)
      for (const [k, f] of files.entries())
        for (const from of new Set([shown[i], bare(shown[i])].flatMap((s) => index[k].get(s.slice(0, KEY)) ?? []))) {
          let len = 0;
          while (i + len < shown.length && from + len < f.lines.length && isLine(shown[i + len], f.lines[from + len])) len++;
          if (len > (best?.len ?? 2)) best = { at: i, len, path: f.path, lines: f.lines, from };
        }
    if (best) runs.push(best);
    i += best?.len ?? 1;
  }
  return runs;
}

const hash = (path: string, prev: string, line: string) => createHash('sha1').update(`${path}\0${prev}\0${line}`).digest('base64').slice(0, 10);

/** The definitions in lines from..to (0-based, to exclusive), as "12 name". */
function outline(path: string, lines: string[], from: number, to: number, max: number): string {
  const md = path.endsWith('.md');
  const found: string[] = [];
  for (let i = from; i < to && i < lines.length; i++) {
    const m = DEF.exec(lines[i]);
    // A # line is a heading only where headings are; elsewhere it's a comment.
    const name = m && (m[1] ?? m[2] ?? m[3] ?? (md ? m[4] : undefined))?.trim();
    if (name) found.push(`${i + 1} ${name}`);
  }
  const step = Math.max(1, found.length / max);
  return Array.from({ length: Math.min(max, found.length) }, (_, i) => found[Math.floor(i * step)]).join(', ');
}

const ago = (ms: number) => (ms < 90_000 ? `${Math.max(1, Math.round(ms / 1000))} s ago` : `${Math.round(ms / 60_000)} min ago`);

interface Cut {
  at: number;
  len: number;
  text: string;
  chars: number;
}

/** The parts of these runs to leave out, and how many chars of earlier-window text still print. */
function cuts(shown: string[], runs: Run[], s: State, show: (p: string) => string, now: number, how: string, notes: string): { cuts: Cut[]; again: number[] } {
  const out: Cut[] = [];
  const again: number[] = [];
  let used = s.again;
  for (const r of runs) {
    const was = Array.from({ length: r.len }, (_, i) => {
      const prev = r.lines[r.from + i - 1] ?? '';
      const line = r.lines[r.from + i];
      const b = s.lines.get(hash(r.path, prev, line)) ?? s.lines.get(hash(r.path, prev, bare(shown[r.at + i]))) ?? s.lines.get(hash(r.path, prev, shown[r.at + i]));
      return b ? { ...b, kind: b.win === s.compacts.length && now - b.t < FRESH_MS ? 'now' : 'old' } : { win: 0, t: 0, by: '', kind: 'new' };
    });
    let repeated = 0;
    for (let a = 0, b = 0; a < r.len; a = b) {
      for (b = a; b < r.len && was[b].kind === was[a].kind; ) b++;
      if (was[a].kind === 'new') continue;
      const lo = a > 0 && was[a - 1].kind === 'new' ? a + CONTEXT : a;
      const hi = b < r.len && was[b].kind === 'new' ? b - CONTEXT : b;
      const size = (x: number, y: number) => shown.slice(r.at + x, r.at + y).reduce((n, l) => n + l.length + 1, 0);
      const place = `lines ${r.from + lo + 1}-${r.from + hi} of ${show(r.path)}`;
      const when = ago(now - Math.max(...was.slice(a, b).map((w) => w.t)));
      if (was[a].kind === 'now' && hi - lo >= CUT_MIN && size(lo, hi) >= 600) {
        out.push({ at: r.at + lo, len: hi - lo, chars: size(lo, hi), text: `[seen] ${place}: unchanged since you printed them ${when} (${was[lo].by}), so they are in your context already. ${how} prints them anyway.` });
      } else if (was[a].kind === 'old') {
        if (hi - lo > SMALL && used + size(a, b) > REREAD_CHARS) {
          const has = outline(r.path, r.lines, r.from + lo, r.from + hi, 14);
          out.push({
            at: r.at + lo,
            len: hi - lo,
            chars: size(lo, hi),
            text: `[seen] ${place}: you read these ${when}, before your context was compacted; unchanged since.${has ? ` They hold: ${has}.` : ''} grep -n for what you need, print the up to ${SMALL} lines you are about to edit, and keep what you find in $TMPDIR/${notes}. ${how} prints them all.`,
          });
        } else {
          used += size(a, b);
          repeated += size(a, b);
        }
      }
    }
    again.push(repeated);
  }
  return { cuts: out, again };
}

/** One finished Bash or Read call; returns what to print (the output with its repeats left out, the gulp line), or null. */
export function seenHook(input: HookInput, files: Files = { read: readText, stateDir: join(tmpdir(), 'citadel-kit'), now: Date.now() }): string | null {
  if (input.hook_event_name !== 'PostToolUse' || typeof input.tool_response !== 'object') return null;
  const ti = input.tool_input ?? {};
  const cwd = String(input.cwd ?? process.cwd());
  const res = input.tool_response as { stdout?: unknown; isImage?: unknown; persistedOutputPath?: unknown; type?: unknown; file?: { filePath?: string; content?: unknown; startLine?: number; numLines?: number } };
  const isRead = input.tool_name === 'Read';
  const text = isRead ? (res.type === 'text' ? res.file?.content : null) : res.stdout;
  // An output saved to a file shows only its first lines, so it isn't a read of them all.
  if (typeof text !== 'string' || !text || res.isImage || res.persistedOutputPath) return null;
  const s = load(input, files.stateDir);
  const command = isRead ? '' : String(ti.command ?? '');
  const path = String(res.file?.filePath ?? ti.file_path ?? '');
  const from = Math.max(0, (Number(res.file?.startLine) || 1) - 1);
  const shown = linesOf(text);
  let runs: Run[];
  if (isRead) {
    const now = files.read(path);
    const lines = now === null ? [] : linesOf(now);
    runs = shown.every((l, i) => lines[from + i] === l) ? [{ at: 0, len: shown.length, path, lines, from }] : [];
  } else runs = fileRuns(shown, candidates(command, cwd, new Set(s.reads.map((r) => r.file)), files));
  if (!runs.length) return null;

  const show = (p: string) => (p.startsWith(`${cwd}/`) ? relative(cwd, p) : p);
  const allowed = isRead ? !!ti.allow_large : /#\s*allow_large\b/.test(command);
  const by = isRead ? 'Read' : command.replace(/\s+/g, ' ').slice(0, 60);
  const found = cuts(shown, runs, s, show, files.now, isRead ? 'allow_large: true' : '"# allow_large" in the command', notesName(input));
  let cut = found.cuts;
  if (allowed && cut.length) note(input, 're-read', `allow_large printed ${cut.reduce((n, c) => n + c.chars, 0)} chars again that the seen guard would have left out (${show(runs[0].path)})`);
  if (allowed) cut = [];
  // Read numbers its lines, so only its head or its tail can go without moving the rest.
  if (isRead) cut = cut.filter((c, i) => c.at === 0 || (i === cut.length - 1 && c.at + c.len === shown.length)).slice(0, 1);

  const gone = new Set(cut.flatMap((c) => Array.from({ length: c.len }, (_, i) => c.at + i)));
  const entries: Read[] = [];
  for (const [k, r] of runs.entries())
    for (let a = 0, b = 0; a < r.len; a = b + 1) {
      for (b = a; b < r.len && !gone.has(r.at + b); ) b++;
      if (b === a) continue;
      const part = shown.slice(r.at + a, r.at + b);
      const hashes = part.map((l, i) => {
        const line = r.lines[r.from + a + i];
        return hash(r.path, r.lines[r.from + a + i - 1] ?? '', [l, bare(l)].includes(line) ? line : bare(l));
      });
      const firstOfRun = !entries.some((e) => e.file === r.path && e.from >= r.from && e.from < r.from + r.len);
      entries.push({ t: files.now, file: r.path, from: r.from + a, hashes, chars: part.join('\n').length, by, ...(firstOfRun && found.again[k] && { again: found.again[k] }) });
    }
  append(input, files.stateDir, entries);

  const total = s.chars + entries.reduce((n, e) => n + e.chars, 0);
  const step = (n: number) => (n < GULP ? 0 : 1 + Math.floor((n - GULP) / GULP_AGAIN));
  const context: string[] = [];
  if (step(total) > step(s.chars)) {
    const per = new Map<string, number>();
    for (const e of [...s.reads.filter((r) => r.win === s.compacts.length), ...entries]) per.set(e.file, (per.get(e.file) ?? 0) + e.chars);
    const top = [...per].sort((a, b) => b[1] - a[1]).slice(0, 3);
    context.push(
      `[seen] ${Math.round(total / 1000)}k chars of files are in your context now (${top.map(([p, n]) => `${basename(p)} ${Math.round(n / 1000)}k`).join(', ')}), and a compaction will drop them. Stop printing ranges: write what you have found, with line numbers, to $TMPDIR/${notesName(input)}, then grep -n for the rest.`,
    );
  }
  let updated: unknown;
  if (cut.length && isRead) {
    const c = cut[0];
    const file = res.file!;
    if (c.len === shown.length) updated = { ...res, file: { ...file, content: c.text, numLines: 1 } };
    else if (c.at === 0) {
      updated = { ...res, file: { ...file, content: shown.slice(c.len).join('\n'), startLine: from + 1 + c.len, numLines: shown.length - c.len } };
      context.push(c.text);
    } else updated = { ...res, file: { ...file, content: [...shown.slice(0, c.at), c.text].join('\n'), numLines: c.at + 1 } };
  } else if (cut.length) {
    const at = new Map(cut.map((c) => [c.at, c.text]));
    updated = { ...res, stdout: shown.flatMap((l, i) => at.get(i) ?? (gone.has(i) ? [] : l)).join('\n') };
  }
  if (!updated && !context.length) return null;
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', ...(updated !== undefined && { updatedToolOutput: updated }), ...(context.length && { additionalContext: context.join('\n') }) } });
}

/** Ranges as "1-40, 90-120", joined where they touch. */
function ranges(list: { from: number; to: number }[]): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  for (const r of [...list].sort((a, b) => a.from - b.from)) {
    const last = out.at(-1);
    if (last && r.from <= last.to + 1) last.to = Math.max(last.to, r.to);
    else out.push({ ...r });
  }
  return out;
}

/** What a compacted session gets back: the ranges it had read and what they hold, its notes, and on a second compaction within 15 minutes what it read again. */
export function afterCompact(input: HookInput, files: Files = { read: readText, stateDir: join(tmpdir(), 'citadel-kit'), now: Date.now() }, tmp = tmpdir()): string {
  const s = load(input, files.stateDir);
  const first = s.compacts.length - KEEP_WINDOWS + 1;
  // Every compaction's row stays, so the windows keep their numbers and a burst its count.
  if (first > 0 && s.reads.some((r) => r.win < first)) {
    const rows: Entry[] = [0, ...s.compacts].flatMap((t, win) => [...(win ? [{ t, compact: 1 as const }] : []), ...(win < first ? [] : s.reads.filter((r) => r.win === win))]);
    writeFileSync(stateFile(input, files.stateDir), rows.map((e) => `${JSON.stringify(e)}\n`).join(''));
  }
  append(input, files.stateDir, [{ t: files.now, compact: 1 }]);
  const cwd = String(input.cwd ?? process.cwd());
  const show = (p: string) => (p.startsWith(`${cwd}/`) ? relative(cwd, p) : p);
  const out: string[] = [];
  const per = new Map<string, (Read & { win: number })[]>();
  for (const r of s.reads) per.set(r.file, [...(per.get(r.file) ?? []), r]);
  const chars = (rs: Read[]) => rs.reduce((n, r) => n + r.chars, 0);
  const top = [...per].sort((a, b) => chars(b[1]) - chars(a[1])).slice(0, 10);
  if (top.length) {
    out.push(`You had read these. Printing them again wholesale is cut to an outline; print the up to ${SMALL} lines you are about to edit, and grep -n for the rest:`);
    for (const [path, rs] of top) {
      const list = ranges(rs.map((r) => ({ from: r.from + 1, to: r.from + r.hashes.length })));
      const text = files.read(path);
      const lines = text === null ? [] : linesOf(text);
      const holds = list
        .map((r) => outline(path, lines, r.from - 1, r.to, Math.max(2, Math.ceil(8 / list.length))))
        .filter(Boolean)
        .join(', ');
      out.push(
        `- ${show(path)} ${list
          .slice(0, 8)
          .map((r) => `${r.from}-${r.to}`)
          .join(', ')}${holds ? `: ${holds}` : ''}`.slice(0, 340),
      );
    }
  }
  const notes = join(tmp, notesName(input));
  const kept = files.read(notes);
  if (kept) out.push(`Your notes, ${notes} (${linesOf(kept).length} lines, the last of them here):\n${kept.slice(-2500)}`);
  const burst = s.compacts.filter((t) => files.now - t < BURST_MS).length;
  if (burst) {
    const twice = top.filter(([, rs]) => new Set(rs.map((r) => r.win)).size > 1).map(([p]) => basename(p));
    out.push(`This is compaction ${burst + 1} in 15 minutes${twice.length ? `; you went back to: ${twice.slice(0, 5).join(', ')}` : ''}. Before anything else write what you know, with file and line numbers, to ${notes}, and grep that instead of printing files again.`);
  } else if (top.length && !kept) out.push(`Keep what you find, with line numbers, in ${notes}: the next compaction hands it back.`);
  return out.join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const out = afterCompact(JSON.parse(readFileSync(0, 'utf8')) as HookInput);
    if (out) process.stdout.write(`${out}\n`);
  } catch {
    // Says nothing: the compaction itself goes on.
  }
}
