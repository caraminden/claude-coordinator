// The cross-scheme link check (#327): in a scheme's chat a bare "#83" links to that scheme's own minion
// #83 (public/threadrefs.js), so "#83" written about another scheme's minion opens the wrong one. When a
// bare #N sits right after another scheme's name (strayRefs), the reply (the Stop hook, link-check.ts) or the outgoing message (this file's PreToolUse hook,
// schemeRefsHooks in runner.ts) is sent back once, naming what the link would open. A rewrite that
// keeps the #N goes through. message_taskmaster is skipped: there a bare #N links to the receiving scheme.
//
// Run as a hook: node scheme-refs.ts '<config json>' < PreToolUse hook input; prints a "deny" decision or nothing.
import { readFileSync, writeFileSync } from 'node:fs';
import type { CardLink } from './card-links.ts';
import { deny, readSent, runHook, saveSent, toolStrings } from './pre-tool-hook.ts';
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

// The chat's list separator (public/threadrefs.js), kept in step by hand.
const LIST_SEP = String.raw`(?:\s*(?:,|\/|&)\s*|,?\s+(?:and|or)\s+)`;
/** A name with any run of spaces where it has one; case-blind, as the chat reads it. */
const namePattern = (name: string) => name.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join(String.raw`\s+`);
const key = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();
/** "ToC" for "Theory of Crafting": a short form the chat doesn't know, so its numbers link here. */
const initials = (name: string) => {
  const words = name.trim().split(/\s+/);
  return words.length > 1 ? words.map((w) => w[0]).join('').toLowerCase() : '';
};

/**
 * The bare #N in `text` the chat links here although they sit right after another scheme's name, one per number:
 * the rest of a list ("Delve #3, #4 and #5": only #3 is Delve's), a possessive without its s ("Peek Auras' #81"),
 * a short form ("ToC #60") or an aside ("Threadspace (the old Obsidian) #24"). A #N elsewhere in a paragraph that
 * names another scheme is left alone: 99 of the first 109 send-backs were that, all this scheme's own minions (#404).
 */
export function strayRefs(text: string, refs: SchemeRefs): Stray[] {
  const own = key(refs.scheme);
  const others = refs.others.filter((n) => n.trim() && key(n) !== own);
  if (!others.length || !text.includes('#')) return [];
  // What each name or short form the reply may use stands for, and whether the chat reads it as a scope.
  const byKey = new Map<string, { other: string; full: boolean }>();
  for (const n of others) {
    const short = initials(n);
    if (short && short !== initials(refs.scheme) && !byKey.has(short)) byKey.set(short, { other: n.trim(), full: false });
  }
  for (const n of others) byKey.set(key(n), { other: n.trim().replace(/\s+/g, ' '), full: true });
  // Longest first, and this scheme's own name too, so "Delve Two #3" isn't read as "Delve" + "Two #3".
  const names = [...byKey.keys(), own].sort((a, b) => b.length - a.length).map(namePattern).join('|');
  const run = new RegExp(String.raw`(?<![\p{L}\p{N}_])(?<name>${names})(?<poss>'s|\u2019s|'|\u2019)?(?<aside>\s*\([^()\n]{1,60}\))?\s+(?<minion>[Mm]inions?\s+)?#(?<first>\d{1,6})(?<rest>(?:${LIST_SEP}#\d{1,6})*)(?![\w#/-])`, 'giu');
  const found: Stray[] = [];
  for (const m of text.replace(CODE, ' ').matchAll(run)) {
    const g = m.groups!;
    const named = byKey.get(key(g.name));
    if (!named) continue;
    const { other } = named;
    // As the chat reads it: the full name, "'s" or nothing, then "#3" or "minion(s) #3".
    const scoped = named.full && !g.aside && (!g.poss || g.poss.endsWith('s'));
    const nums = [...(scoped ? [] : [g.first]), ...(scoped && /^minions/i.test(g.minion ?? '') ? [] : g.rest.match(/\d+/g) ?? [])].map(Number);
    for (const n of nums) {
      if (found.some((f) => f.n === n)) continue;
      const minion = refs.minions[n];
      const opens = minion ? `${refs.scheme} #${n} "${minion.title}"${minion.closed ? ' (closed)' : ''}` : `nothing: ${refs.scheme} has no #${n}`;
      found.push({ n, other, opens });
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
  const sent = readSent<number>(cfg.sent);
  const fresh = strayRefs(toolStrings(input.tool_input).join('\n\n'), refs).filter((f) => !sent.includes(f.n));
  if (!fresh.length) return null;
  // No record to stop the next try, so let it through rather than loop.
  if (!saveSent(cfg.sent, [...sent, ...fresh.map((f) => f.n)])) return null;
  return deny(`[links] This message wasn't sent: a #N in it would open the wrong minion.\n${explainStrays(fresh, refs.scheme)}\nRewrite it and send it again.`);
}

runHook(import.meta, checkCall);
