// The check on a new minion's brief (#1108, citadel:briefing): it warns, never refuses, when the brief
// an agent wrote has no quoted words from a person or no "Done when".
import { readFileSync, realpathSync, statSync } from 'node:fs';

/** A person's words in quotes: three or more words between "…" or “…”, or a `>` quote line. */
const QUOTE = /"[^"\n]*\S\s+\S+\s+\S[^"\n]*"|“[^”\n]*\S\s+\S+\s+\S[^”\n]*”|^\s*>\s*\S/m;
const DONE_WHEN = /\bdone[\s-]*when\b/i;

/** The handoffs and specs a brief names by full path inside `shared` (the scheme's shared folder), read so a pointer brief is judged by its file. */
export function namedFiles(text: string, shared: string): string {
  const escaped = shared.replace(/\/+$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const paths = new Set([...text.matchAll(new RegExp(`${escaped}/[^\\s\`'"()<>\\[\\]]+\\.md`, 'g'))].map(([p]) => p));
  return [...paths].slice(0, 5).map((p) => {
    // Only a plain file of at most 200 kB that really sits in the shared folder (no link out, no FIFO to hang on); a missing or unreadable one adds nothing.
    try {
      const real = realpathSync(p);
      if (!real.startsWith(`${realpathSync(shared)}/`)) return '';
      const st = statSync(real);
      return st.isFile() && st.size <= 200_000 ? readFileSync(real, 'utf8') : '';
    } catch {
      return '';
    }
  }).join('\n');
}

/** What the brief (with the files it names) is missing, as one warning line, or null when it has both parts. */
export function briefWarning(text: string): string | null {
  const missing = [
    !QUOTE.test(text) && 'no quoted words from a person (their ask in quotes, with who and the date)',
    !DONE_WHEN.test(text) && 'no "Done when" (the end state a person can see or check)',
  ].filter(Boolean);
  if (!missing.length) return null;
  return `Brief check (citadel:briefing): it has ${missing.join(' and ')}. The minion was still created: send the missing part with message_ticket now, or ignore this if there is none to give.`;
}
