// Does a chat message look like it holds a password or key (#838)? The composer asks before sending one, offering
// to save it as a secret instead. A guess on purpose: it catches the common shapes and lets ordinary text through.
// Shared with the tests (test/secrets.test.ts), so it imports nothing.

// Well-known key shapes: OpenAI/Anthropic, GitHub, AWS, Slack, Google.
const KNOWN = /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}|xox[abposr]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35})/;
// "password is X", "pw: X", "token=X", "api key: X": a keyword, then is, = or :, then the value.
const SAID = /\b(?:passwords?|passwd|pass|pwd?|passphrase|pin|token|secret|api[ _-]?key|key)\s*(?:is\s*:?|=|:)\s*(\S+)/i;
// A long run of letters and digits mixing upper, lower and digits, as generated keys are; hex alone is a commit.
const RANDOM = /[A-Za-z0-9_+/=-]{24,}/g;

/**
 * The part of `text` that looks like a password or key, or null. Links and `code` are left out, and a value
 * already written as $CITADEL_SECRET_<NAME> is fine.
 */
export function looksSecret(text) {
  const plain = String(text ?? '').replace(/`[^`]*`/g, ' ').replace(/\bhttps?:\/\/\S+/g, ' ');
  const known = plain.match(KNOWN);
  if (known) return known[0];
  const said = plain.match(SAID);
  // At least 4 long, with a digit or a symbol, so "the password is wrong" or "the key is the name" stays a sentence.
  const value = said?.[1].replace(/[.,;!?)]+$/, '');
  if (value && value.length >= 4 && !value.startsWith('$') && /[\d\W_]/.test(value)) return said[1];
  for (const [run] of plain.matchAll(RANDOM)) {
    if (/[A-Z]/.test(run) && /[a-z]/.test(run) && /\d/.test(run) && !/[/.]/.test(run.slice(1, -1))) return run;
  }
  return null;
}
