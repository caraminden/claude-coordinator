/**
 * The big-read guard (PreToolUse on Read and Bash, every session, Grunts included): sends back a whole read of a big
 * file, since its text stays in context for every later model call (#813's report: 348M cache-read tokens a week from
 * Read results of 10k+ chars, 117M more from Bash cat/sed). Big means over LINES lines or CHARS chars in what the call
 * would print. Narrow on purpose: a Read with no limit, and a plain `cat path` or `sed -n 'N,Mp' path` whose output
 * isn't piped or redirected; anything unclear (expansions, globs, a cd first) goes through. `allow_large: true` on
 * Read, or `# allow_large` in the command, gets past it. Fails open.
 */
import { readFileSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HookInput } from './hook-input.ts';

const LINES = 600;
const CHARS = 25_000;
const READ_DEFAULT_LINES = 2000; // what Read returns with no limit
// Read shows these as pictures, pages or cells, not as raw text.
const NOT_TEXT = /\.(?:png|jpe?g|gif|webp|bmp|ico|avif|tiff?|pdf|ipynb)$/i;

/** The lines from..to (1-based, inclusive) of a text file, or null for a missing, binary or huge file. */
function measure(cwd: string, path: string, from = 1, to = Infinity): { lines: number; chars: number } | null {
  const file = resolve(cwd, path);
  if (NOT_TEXT.test(file)) return null;
  const st = statSync(file, { throwIfNoEntry: false });
  // shortcut: files over 16 MB go through unmeasured; Read refuses those itself, and cat of one is rare.
  if (!st?.isFile() || st.size > 16 * 1024 * 1024) return null;
  const buf = readFileSync(file);
  if (buf.subarray(0, 8000).includes(0)) return null;
  const all = buf.toString('utf8').split('\n');
  if (all.at(-1) === '') all.pop();
  const part = all.slice(Math.max(from, 1) - 1, to);
  return { lines: part.length, chars: part.reduce((n, l) => n + l.length + 1, 0) };
}

const big = (m: { lines: number; chars: number }) => m.lines > LINES || m.chars > CHARS;
const size = (m: { lines: number; chars: number }) => `${m.lines} lines (${Math.round(m.chars / 1000)}k chars)`;

/** A command's segments (split at ; && || | and newlines) as words; plain is false when the shell would change them or the output is piped or redirected. Null for an unclosed quote. */
function segments(command: string): { words: string[]; plain: boolean }[] | null {
  const out: { words: string[]; plain: boolean }[] = [];
  let words: string[] = [];
  let word = '';
  let inWord = false;
  let plain = true;
  const endWord = () => {
    if (inWord) words.push(word);
    word = '';
    inWord = false;
  };
  const endSeg = (pipedOut = false) => {
    endWord();
    if (words.length) out.push({ words, plain: plain && !pipedOut });
    words = [];
    plain = true;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === "'" || c === '"') {
      const close = command.indexOf(c, i + 1);
      if (close < 0) return null;
      const inner = command.slice(i + 1, close);
      if (c === '"' && /[$`\\]/.test(inner)) plain = false;
      word += inner;
      inWord = true;
      i = close;
    } else if (c === ' ' || c === '\t') endWord();
    else if (c === '#' && !inWord) {
      const nl = command.indexOf('\n', i);
      i = nl < 0 ? command.length : nl - 1;
    } else if (c === ';' || c === '\n') endSeg();
    else if ((c === '&' || c === '|') && command[i + 1] === c) {
      endSeg();
      i++;
    } else if (c === '|') endSeg(true);
    else {
      // Expansions, globs, redirects, subshells, escapes and a lone & make the segment unclear.
      if (/[$`*?[\]{}()<>~\\!&]/.test(c)) plain = false;
      word += c;
      inWord = true;
    }
  }
  endSeg();
  return out;
}

/** What a Bash command would print from big files, as a reason, or null. */
function bashReason(command: string, cwd: string): string | null {
  if (/#\s*allow_large\b/.test(command)) return null;
  const found: string[] = [];
  for (const { words, plain } of segments(command) ?? []) {
    if (words[0] === 'cd' || words[0] === 'pushd') break; // the cwd is unknown from here on
    if (!plain) continue;
    if (words[0] === 'cat') {
      const files = words.slice(1).filter((w, i, a) => a.slice(0, i).includes('--') || !(w.startsWith('-') && w.length > 1));
      const ms = files.map((f) => measure(cwd, f));
      if (!files.length || ms.some((m) => !m)) continue;
      const total = { lines: 0, chars: 0 };
      for (const m of ms) (total.lines += m!.lines), (total.chars += m!.chars);
      if (big(total)) found.push(`cat of ${files.map((f) => basename(f)).join(', ')}: ${size(total)}`);
    } else if (words[0] === 'sed' && words[1] === '-n' && words.length === 4) {
      const r = words[2].match(/^(\d+),(\d+|\$)p$/);
      const m = r && measure(cwd, words[3], Number(r[1]), r[2] === '$' ? Infinity : Number(r[2]));
      if (m && big(m)) found.push(`sed of ${basename(words[3])}: ${size(m)}`);
    }
  }
  if (!found.length) return null;
  return `[citadel big-read] This prints ${found.join('; ')}, and that text stays in context for every later call. grep -n for what you need, then print a small range with sed -n 'a,bp' (or Read with offset/limit). A Bash output over 12,000 characters is cut to a preview, so to read it all use Read with allow_large: true.`;
}

/** One hook call; returns what to print (a deny for Claude Code), or null to let the call run. */
export function bigReadHook(input: HookInput): string | null {
  const ti = input?.tool_input ?? {};
  const cwd = String(input?.cwd ?? process.cwd());
  let reason: string | null = null;
  if (input?.tool_name === 'Read') {
    if (!ti.file_path || ti.allow_large || ti.limit != null || ti.pages) return null;
    const from = Number(ti.offset) || 1;
    const m = measure(cwd, String(ti.file_path), from, from + READ_DEFAULT_LINES - 1);
    if (!m || !big(m)) return null;
    reason = `[citadel big-read] A whole read of ${basename(String(ti.file_path))} is ${size(m)}, and it stays in context for every later call. grep -n for what you need, then Read with offset/limit. If you really need it all, pass allow_large: true.`;
  } else if (input?.tool_name === 'Bash') {
    reason = bashReason(String(ti.command ?? ''), cwd);
  }
  if (!reason) return null;
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // Fails open: a guard that can't run lets the call through.
  try {
    const out = bigReadHook(JSON.parse(readFileSync(0, 'utf8')));
    if (out) process.stdout.write(out);
  } catch {
    // See above.
  }
}
