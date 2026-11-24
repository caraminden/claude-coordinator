// "Did you mean" for an app agent's call to a tool it doesn't have (#1174). Claude Code refuses such a call itself,
// with only "No such tool available: <name>", and runs no hook for it, so Citadel reads the refusal off the turn's
// stream and sends the agent this note into the turn. No imports of Citadel's own: it is pure.

/** The tool name in Claude Code's refusal, or null when the error is something else. */
export function unknownToolName(error: string): string | null {
  return /No such tool available:\s*([^\s<]+)/.exec(error)?.[1] ?? null;
}

/** The part of a tool's name after any mcp__server__ prefix. */
const bare = (name: string) => name.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, '');
const words = (s: string) =>
  s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3);

function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length]!;
}

/** How near `called` is to `real`, lower is nearer; null when not near at all. */
function nearness(called: string, real: string): number | null {
  const a = bare(called).toLowerCase();
  const b = bare(real).toLowerCase();
  const edit = distance(a, b) / Math.max(a.length, b.length, 1);
  const shared = words(a).filter((w) => words(b).includes(w)).length;
  const share = shared / Math.max(words(a).length, words(b).length, 1);
  // Most of one name inside the other (view_clip_placeholder, view_clip) counts as near too.
  if (edit <= 0.34) return edit;
  if (shared >= 2 || (shared >= 1 && share >= 0.5)) return 0.5 - share / 2;
  return null;
}

const MAX_LISTED = 40;

/** The note for an unknown call: the nearest one or two of `tools` (full names), or the plain list; null with no tools to name. */
export function suggestTools(called: string, tools: string[]): string | null {
  if (!tools.length) return null;
  const near = tools
    .map((t) => ({ t, n: nearness(called, t) }))
    .filter((x): x is { t: string; n: number } => x.n !== null)
    .sort((x, y) => x.n - y.n)
    .slice(0, 2)
    .map((x) => x.t);
  const head = `${called} is not one of your tools.`;
  if (near.length) return `${head} Did you mean ${near.join(' or ')}? Call it by its full name.`;
  const list = tools.slice(0, MAX_LISTED).join(', ');
  return `${head} Your tools are: ${list}${tools.length > MAX_LISTED ? ', …' : ''}.`;
}
