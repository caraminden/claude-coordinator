// The wording check: words Citadel says one way, sent back before they reach people (#313). A change going onto
// main "ships", a cabal member's work going into a build "merges", and "fold" is retired (Cara, 2026-11-19: picked "Ship"
// on #1020's card over "land", and, for fold, "Retire it"). Three places use it: the Stop hook (link-check.ts) checks a turn's final reply, and
// this file's PreToolUse hook (wordingHooks in turn-launch.ts) checks the messages and cards a session sends and the
// .md and .html files it writes into the scheme's shared folders. Each sentence is sent back once; a rewrite that
// still trips it goes out.
//
// Run as a hook: node wording.ts '<config json>' < PreToolUse hook input; prints a "deny" decision or nothing.
import { resolve, sep } from 'node:path';
import { deny, readSent, runHook, saveSent, toolStrings } from './pre-tool-hook.ts';

export interface Reserved {
  /** The word as people know it, named in the send-back. */
  term: string;
  /** Why it's sent back, the send-back's first line. */
  why: string;
  /** Its forms or phrases, matched case-insensitively at word boundaries (so "folder", "scaffold" and "casefold" don't count). */
  match: RegExp;
  /** A word that, in the same sentence or within WINDOW words, makes the use fine; none for a retired word. */
  allow?: RegExp;
  /** A match this also matches is wrong whatever is near ("merge it into main" beside "the build is green"). */
  always?: RegExp;
  /** What to write instead. */
  suggest: string;
}

const MERGE = String.raw`merg(?:e|es|ed|ing)`;
const INTO = String.raw`(?!\s+(?:in(?:to)?|with)\b)`;
const LAND = String.raw`land(?:s|ed|ing)?`;

/** The words Citadel says one way. Another one is one more row, and a retired or restricted word in the kit's glossary (kit/skills/citadel-words/SKILL.md; test/citadel-words.test.ts). */
export const RESERVED: Reserved[] = [
  {
    term: 'fold',
    why: 'Citadel no longer says "fold" (Cara, 2026-11-19, "Retire it")',
    // Not "case-fold": that's text, not work.
    match: /(?<!\bcase-)\bfold(?:s|ed|ing)?\b(?:[- ]in\b)?/gi,
    suggest: '"ship" for a change going onto main, "merge into the Plot" for a Plot member, "a collapsed section" or "hidden behind a toggle" for UI, and "add to" or "refit" otherwise',
  },
  {
    term: 'cabal',
    why: 'A group of minions under one Overseer is a "Plot" now, not a "cabal" (Cara, 2026-11-27, picked "Plot" on #2270\'s card); code, tool and file names (`cabal`, `citadel:cabal`, `build/<n>`) keep theirs',
    match: /\b(?:(?:build|goal)\s+)?cabals?\b/gi,
    suggest: '"Plot 11" for the group, "Plot 11\'s Overseer", "a member of Plot 11"',
  },
  {
    term: 'major build',
    why: 'A group of minions is a "Plot" now, and "Build <n>" or a "major build" for it is retired (Cara, 2026-11-27, picked "Plot" on #2270\'s card); a build that compiles (an APK build, "build the feature") is fine',
    match: /\bmajor\s+builds?\b|(?<!\b(?:desktop|apk|android|windows|release|replaces|supersedes)\s)\bbuild\s+#?\d+\b(?!\s+(?:is|was)\s+published\b)/gi,
    suggest: '"Plot 11" for the group ("merged into Plot 11", "Plot 11 shipped")',
  },
  {
    term: 'merge',
    why: 'A change going onto main "ships" (Cara, 2026-11-19, picked "Ship" on #1020\'s card); "merge" is only for a branch going into a build, or a raw git step',
    // Only the shapes that can't mean a build: "merge it" / "merge #12" / "PR #12 merged" with no "into" after, "merged
    // to main", "ready to merge", "merged PRs", "the merge card". A bare "merged" or "the merge" is left alone: it's
    // as often git's as ours.
    match: new RegExp(
      [
        String.raw`\b${MERGE}\s+(?:it|this|that|them|(?:PR\s*)?#\d+|PR\s+\d+)\b${INTO}`,
        String.raw`\bmerge\s+\d+\b${INTO}`,
        String.raw`\b${MERGE}\b(?:\s+\S+){0,4}?\s+(?:in)?to\s+main\b`,
        String.raw`\bready\s+to\s+merge\b${INTO}`,
        String.raw`\bPR\s*#?\d+\s+(?:(?:was|is|has\s+been|got)\s+)?merged\b${INTO}`,
        String.raw`\bmerged\s+PRs?\b`,
        String.raw`\bmerge\s+(?:card|chip|go|button)s?\b`,
      ].join('|'),
      'gi',
    ),
    allow: /^(?:builds?|plots?|cabals?|feeders?|git)$/i,
    always: /\bmain\b/i,
    suggest: '"ship it", "shipped to main", "ready to ship", "shipped PRs" or "the ship card"; "merge into Plot <n>" for a Plot member',
  },
  {
    term: 'land',
    why: 'A change going onto main "ships" now, not "lands" (Cara, 2026-11-19, picked "Ship" on #1020\'s card); code, tool and file names (hand_off_land, tools/land.sh, land/* branches) keep theirs',
    // The shapes that mean a change going onto main: "land it" / "land #12", "landed on main", "ready to land",
    // "#12 has landed", "landed PRs", "the land card". A bare "lands" is left alone: findings and files land too.
    match: new RegExp(
      [
        String.raw`\b${LAND}\s+(?:it|this|that|them|(?:PR\s*)?#\d+|PR\s+\d+)\b`,
        // "land 196": the go parser reads a bare number as a PR.
        String.raw`\bland\s+\d+\b`,
        String.raw`\b${LAND}\b(?:\s+\S+){0,4}?\s+(?:on(?:to)?|in(?:to)?|to)\s+main\b(?!\.\w)`,
        String.raw`\bready\s+to\s+land\b`,
        String.raw`(?:\bPR\s*#?\d+|#\d+)\s+(?:(?:was|is|has|had|has\s+been|got)\s+)?landed\b`,
        String.raw`\blanded\s+PRs?\b`,
        String.raw`\bland\s+(?:card|chip|go|button|line)s?\b`,
      ].join('|'),
      'gi',
    ),
    suggest: '"ship it", "shipped to main", "ready to ship", "#12 has shipped", "shipped PRs" or "the ship card"',
  },
];

/** The rule for a stand-in in a command people run (Cara, 2026-11-17: "just put the address into their shell commands"). */
export const PLACEHOLDER = {
  term: 'placeholder',
  why: 'Every value in a command people run is filled in (Cara, 2026-11-17: "just put the address into their shell commands"); only a secret, or a value only the person knows, stays a placeholder',
  suggest: 'the real value (an address, distro, path or name you can look up); a secret such as <token> or <password> may stay, with the text before the block saying where to find it',
};

/** Fenced blocks tagged with a shell people run. */
const SHELL_BLOCK = /^ {0,3}(```|~~~)[ \t]*(?:powershell-admin|powershell|wsl|fish|bash|cmd|sh)\b[^\n]*\n([\s\S]*?)(?:^ {0,3}\1|(?![\s\S]))/gim;
/** `<the address>`: angle brackets round words, not after a name (`List<string>`) or another `<` (`<<EOF`). */
const STAND_IN = /(?<![\w\]<])<([A-Za-z](?:[A-Za-z0-9 _'-]*[A-Za-z0-9])?)>/g;
/** A stand-in with one of these words names a secret, which only the person has. */
export const SECRET_WORDS = /^(?:token|password|passphrase|passcode|secret|key|pat|pin|credentials?)$/i;

/** The stand-ins people would have to fill in, in the shell blocks of `text`, one per line. */
function placeholders(text: string): Misuse[] {
  const found: Misuse[] = [];
  for (const b of text.matchAll(SHELL_BLOCK)) {
    for (const line of b[2].split('\n')) {
      const code = line.replace(/<#[\s\S]*?#>/g, ' ');
      for (const m of code.matchAll(STAND_IN)) {
        if (m[1].split(/[\s_-]+/).some((w) => SECRET_WORDS.test(w))) continue;
        found.push({ term: PLACEHOLDER.term, word: m[0], sentence: quote(line, m.index) });
        break;
      }
    }
  }
  return found;
}

/** How many words either side of a reserved word may show its meaning. */
const WINDOW = 8;

/** Text the chat renders as code: fenced blocks and inline spans. */
export const CODE = /^ {0,3}(```|~~~)[\s\S]*?(?:^ {0,3}\1|(?![\s\S]))|(`+)(?!`)[\s\S]*?[^`]\2(?!`)/gm;

/** The words people read: code, paths and URLs out (and for HTML, scripts, styles and tags), each replaced by a space. */
export function prose(text: string, html = false): string {
  let t = text;
  if (html) {
    t = t
      .replace(/<(script|style|pre|code)\b[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&quot;/g, '"');
  }
  return t.replace(CODE, ' ').replace(/\S*[/\\]\S*/g, ' ');
}

export interface Misuse {
  term: string;
  /** The word as written, e.g. "Folding in". */
  word: string;
  /** Its sentence, trimmed to a quotable length. */
  sentence: string;
}

const WORD = /[A-Za-z0-9#']+/g;
const words = (s: string) => s.match(WORD) ?? [];

/** Each sentence's [start, end): split at . ! ? before a space, and at every line break (a heading is its own sentence). */
function sentences(text: string): [number, number][] {
  const out: [number, number][] = [];
  let start = 0;
  for (const m of text.matchAll(/[.!?]+(?=\s|$)|\n/g)) {
    const end = m.index + m[0].length;
    out.push([start, end]);
    start = end;
  }
  if (start < text.length) out.push([start, text.length]);
  return out;
}

/** A sentence short enough to quote, centred on the word at `at` (relative to the sentence). */
function quote(sentence: string, at: number): string {
  const s = sentence.replace(/\s+/g, ' ').trim();
  if (s.length <= 160) return s;
  const i = Math.max(0, Math.min(s.length - 160, Math.round(at - 80)));
  return `${i > 0 ? '…' : ''}${s.slice(i, i + 160).trim()}${i + 160 < s.length ? '…' : ''}`;
}

/** The reserved words `text` uses the wrong way, one per sentence and term. */
export function misusedWords(text: string, html = false): Misuse[] {
  const p = prose(text, html);
  const found: Misuse[] = html ? [] : placeholders(text);
  for (const [start, end] of sentences(p)) {
    const sentence = p.slice(start, end);
    for (const r of RESERVED) {
      for (const m of sentence.matchAll(r.match)) {
        const at = start + m.index;
        // Quoted, it's about the word itself ('"fold" means merging').
        if (/["'“‘]$/.test(p.slice(0, at)) && /^["'”’]/.test(p.slice(at + m[0].length))) continue;
        if (!r.allow || r.always?.test(m[0])) {
          found.push({ term: r.term, word: m[0], sentence: quote(sentence, m.index) });
          break;
        }
        const near = [...words(sentence), ...words(p.slice(Math.max(0, at - 200), at)).slice(-WINDOW), ...words(p.slice(at + m[0].length, at + m[0].length + 200)).slice(0, WINDOW)];
        if (near.some((w) => r.allow!.test(w))) continue;
        found.push({ term: r.term, word: m[0], sentence: quote(sentence, m.index) });
        break;
      }
    }
  }
  return found;
}

/** The send-back's lines for these misuses: why, the quoted sentences, and what to write instead. */
export function explain(found: Misuse[]): string {
  const lines: string[] = [];
  for (const r of [...RESERVED, PLACEHOLDER]) {
    const mine = found.filter((f) => f.term === r.term);
    if (!mine.length) continue;
    lines.push(`${r.why}:`);
    for (const f of mine) lines.push(`- "${f.sentence}" (${f.word})`);
    lines.push(r === PLACEHOLDER ? `Use ${r.suggest}.` : `Say ${r.suggest}. Quoting someone's words? Put them in backticks.`);
  }
  return lines.join('\n');
}

export interface WordingConfig {
  /** The shared folders whose .md and .html files people read. */
  shared: string[];
  /** A file in the turn's folder listing the sentences already sent back this turn. */
  sent: string;
}

/** The people-facing text a tool call carries, and whether it's HTML; null for a call the check skips. */
function outgoing(tool: string, input: Record<string, unknown> | undefined, cfg: WordingConfig): { text: string; html: boolean } | null {
  if (/^mcp__/.test(tool)) {
    return { text: toolStrings(input).join('\n'), html: false };
  }
  const path = typeof input?.file_path === 'string' ? resolve(input.file_path) : '';
  if (!/\.(md|html?)$/i.test(path) || !cfg.shared.some((d) => path.startsWith(resolve(d) + sep))) return null;
  const text = tool === 'Write' ? input?.content : tool === 'Edit' ? input?.new_string : tool === 'MultiEdit' ? ((input?.edits ?? []) as ({ new_string?: unknown } | null)[]).map((e) => e?.new_string).join('\n') : '';
  return typeof text === 'string' ? { text, html: /\.html?$/i.test(path) } : null;
}

/** The PreToolUse hook's answer: a deny with the reason, or null to let the call through. */
export function checkCall(input: { tool_name?: string; tool_input?: Record<string, unknown> }, cfg: WordingConfig) {
  const out = outgoing(String(input.tool_name ?? ''), input.tool_input, cfg);
  if (!out) return null;
  const sent = readSent<string>(cfg.sent);
  const key = (f: Misuse) => `${f.term}\t${f.sentence}`;
  const fresh = misusedWords(out.text, out.html).filter((f) => !sent.includes(key(f)));
  if (!fresh.length) return null;
  // No record to stop the next try, so let it through rather than loop.
  if (!saveSent(cfg.sent, [...sent, ...fresh.map(key)])) return null;
  const what = /^mcp__/.test(String(input.tool_name)) ? 'This message' : 'This file';
  return deny(`[wording] ${what} wasn't sent: people would read a word Citadel says another way.\n${explain(fresh)}\nRewrite it and send it again.`);
}

runHook(import.meta, checkCall);
