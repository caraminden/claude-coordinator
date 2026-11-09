// The cross-scheme link check (#327): in a scheme's chat a bare "#83" links to that scheme's own minion
// #83 (public/threadrefs.js), so "#83" written about another scheme's minion opens the wrong one. When a
// paragraph names another scheme and its bare #N here is closed, missing or about something else, the
// reply (the Stop hook, link-check.ts) or the outgoing message (this file's PreToolUse hook,
// schemeRefsHooks in runner.ts) is sent back once, naming what the link would open. A rewrite that
// keeps the #N goes through. message_taskmaster is skipped: there a bare #N links to the receiving scheme.
//
// Run as a hook: node scheme-refs.ts '<config json>' < PreToolUse hook input; prints a "deny" decision or nothing.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { CardLink } from './card-links.ts';
import { CODE } from './wording.ts';

/** The turn-start snapshot the runner writes into the turn's folder (writeSchemeRefs in runner.ts). */
export interface SchemeRefs {
  /** This scheme's name. */
  scheme: string;
  /** The other schemes' names. */
  others: string[];
  /** This scheme's minions by number. */
  minions: Record<string, { title: string; closed: boolean }>;
  /** The turn's own minion number, null for the Taskmaster (card-links.ts). */
  self?: number | null;
  /** This scheme's cards waiting on people (card-links.ts), refreshed when a card is posted mid-turn. */
  cards?: CardLink[];
}

export interface Stray {
  n: number;
  /** The other scheme the paragraph names. */
  other: string;
  /** What "#n" opens here, e.g. `Citadel #83 "Old title" (closed)`. */
  opens: string;
}

// The chat's own patterns (public/threadrefs.js), kept in step by hand: a number they claim isn't a bare #N.
const LIST_SEP = String.raw`(?:\s*(?:,|\/|&)\s*|,?\s+(?:and|or)\s+)`;
const PR_LIST = String.raw`\b(?:(?:PRs?|[Pp]ull [Rr]equests?|[Pp]ulls?):?\s\(?#\d{1,6}(?:${LIST_SEP}#\d{1,6})*|(?:PR|[Pp]ull [Rr]equest)\s\d{1,6})(?![\w#/-])`;
const ISSUE_LIST = String.raw`\b[Ii]ssues?\s#\d{1,6}(?:${LIST_SEP}#\d{1,6})*`;
const MINION_LIST = String.raw`(?:[Mm]inions\s+#\d{1,6}(?:${LIST_SEP}#\d{1,6})*|[Mm]inion\s+#\d{1,6})(?![\w#/-])`;
const REF = String.raw`(?<![\w&/#.:?=+-])#(?<n>\d{1,6})(?![\w#/-])`;
const POSSESSIVE = String.raw`(?:'|\u2019)s`;
/** A name with any run of spaces where it has one; case as written, since a scheme's name is a proper noun. */
const namePattern = (name: string) => name.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join(String.raw`\s+`);
const nameRe = (names: string[], flags = '') => new RegExp(`(?<![\\p{L}\\p{N}_])(?:${names.map(namePattern).join('|')})(?![\\p{L}\\p{N}_])`, `u${flags}`);

/** Words too common to show a title and a paragraph are about the same thing. */
const STOP = new Set('this that with from have will been were what when where which their there they them then than into onto over under about after before also just only some more most other others same such very your yours ours here does done make made like want need needs should would could still each every both once fix fixes fixed add adds added minion minions scheme schemes taskmaster grunt'.split(' '));
const stems = (s: string) => new Set((s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length >= 4 && !STOP.has(w)).map((w) => w.replace(/(?:es|s)$/, '')));

/** The bare #N in `text` that likely mean another scheme's minion, one per number. */
export function strayRefs(text: string, refs: SchemeRefs): Stray[] {
  const others = refs.others.filter((n) => n.trim() && n.trim() !== refs.scheme.trim());
  if (!others.length || !text.includes('#')) return [];
  const all = [...others, refs.scheme].filter((n) => n.trim()).sort((a, b) => b.length - a.length);
  const names = all.map(namePattern).join('|');
  // As the chat reads it, but case-insensitive for names as the chat is: a name before the number scopes it.
  const scoped = String.raw`(?<![\p{L}\p{N}_])(?:${names})(?:${POSSESSIVE})?\s+(?:${PR_LIST}|${MINION_LIST}|#\d{1,6}(?![\w#/-]))|${MINION_LIST}\s+in\s+(?:${names})(?![\p{L}\p{N}_])`;
  const tokens = new RegExp(`${ISSUE_LIST}|${PR_LIST}|${scoped}|${REF}`, 'giu');
  const max = Math.max(0, ...Object.keys(refs.minions).map(Number));
  const found: Stray[] = [];
  for (const para of text.replace(CODE, ' ').split(/\n\s*\n/)) {
    const other = nameRe(others).exec(para)?.[0];
    if (!other) continue;
    const words = stems(para);
    for (const m of para.matchAll(tokens)) {
      if (!m.groups?.n) continue;
      const n = Number(m.groups.n);
      if (found.some((f) => f.n === n)) continue;
      const minion = refs.minions[n];
      // Past the newest number it's likely one started during this turn, after the snapshot.
      if (!minion && n > max) continue;
      if (minion && !minion.closed && [...stems(minion.title)].some((w) => words.has(w))) continue;
      const opens = minion ? `${refs.scheme} #${n} "${minion.title}"${minion.closed ? ' (closed)' : ''}` : `nothing: ${refs.scheme} has no #${n}`;
      found.push({ n, other: other.replace(/\s+/g, ' '), opens });
    }
  }
  return found;
}

/** The send-back's lines for these: what each link opens, and what to write instead. */
export function explainStrays(found: Stray[], scheme: string): string {
  const lines = ['A bare #N links to this scheme\'s own minion, and these sit next to another scheme\'s name:'];
  for (const f of found) lines.push(`- #${f.n} here opens ${f.opens}. Meant ${f.other}'s? Write "${f.other} #${f.n}".`);
  lines.push(`If you meant ${scheme}'s own minion, leave it as it is: the next try goes through.`);
  return lines.join('\n');
}

/** The snapshot, or null when there's none to check against. */
export function readRefs(file: string | undefined): SchemeRefs | null {
  if (!file) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export interface SchemeRefsConfig {
  /** The snapshot file (SchemeRefs) in the turn's folder. */
  refs: string;
  /** A file in the turn's folder listing the numbers already sent back this turn. */
  sent: string;
}

/**
 * The tools whose text shows in this scheme's chats, where a bare #N links. Left out of WORDING_MATCHER's list:
 * message_taskmaster (another scheme reads it, so its bare #N rightly links there), update_ticket (a title or
 * note) and file writes.
 */
export const SCHEME_REFS_MATCHER = '^mcp__(thread|coordinator)__(message_coordinator|message_ticket|ask_question|propose_plan)$';

/** The PreToolUse hook's answer: a deny with the reason, or null to let the call through. */
export function checkCall(input: { tool_name?: string; tool_input?: any }, cfg: SchemeRefsConfig) {
  const refs = readRefs(cfg.refs);
  if (!refs) return null;
  const strings: string[] = [];
  const walk = (v: any) => (typeof v === 'string' ? strings.push(v) : v && typeof v === 'object' && Object.values(v).forEach(walk));
  walk(input.tool_input);
  let sent: number[] = [];
  try {
    sent = JSON.parse(readFileSync(cfg.sent, 'utf8'));
  } catch {
    // None sent back yet.
  }
  const fresh = strayRefs(strings.join('\n\n'), refs).filter((f) => !sent.includes(f.n));
  if (!fresh.length) return null;
  try {
    writeFileSync(cfg.sent, JSON.stringify([...sent, ...fresh.map((f) => f.n)]));
  } catch {
    // No record to stop the next try, so let it through rather than loop.
    return null;
  }
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `[links] This message wasn't sent: a #N in it would open the wrong minion.\n${explainStrays(fresh, refs.scheme)}\nRewrite it and send it again.`,
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const verdict = checkCall(JSON.parse(readFileSync(0, 'utf8')), JSON.parse(process.argv[2]));
    if (verdict) process.stdout.write(JSON.stringify(verdict));
  } catch {
    // A check that can't run never holds up the call.
  }
}
