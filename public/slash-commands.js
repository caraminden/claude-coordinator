// Slash commands in the composer (#937). Citadel's own (/btw, /fresh, /help) run in the page and never reach a turn;
// the rest are what the chat's turns load (src/slash-commands.ts, from Claude Code's init event) and go as text.
// A /word in neither list is refused with a hint (Cara, 2026-11-17: "Refuse with a hint"); `//` sends it as typed.

/** Citadel's own commands: `minion` ones are for minions' chats only. */
export const CITADEL_COMMANDS = [
  { name: 'btw', args: '<question>', description: 'Ask on the side: a read-only copy answers, nothing reaches its session', minion: true },
  { name: 'fresh', description: 'Start a fresh Claude session from a handoff it writes first' },
  { name: 'help', description: 'Show every command' },
];

/** The command a message starts with, as { name, rest }, or null: no slash, `//`, or a path like /home/x. */
export function parseCommand(text) {
  const m = /^\/([A-Za-z0-9][\w:.-]*)(?:\s+([\s\S]*))?$/.exec(text);
  return m ? { name: m[1], rest: (m[2] ?? '').trim() } : null;
}

/** What the menu filters on: the box's whole text while it is one `/word` still being typed, else null. */
export const menuQuery = (value) => /^\/([\w:.-]*)$/.exec(value)?.[1] ?? null;

/**
 * The commands that match `query`, best first: a name that starts with it, then one whose part after `plugin:` does,
 * then any that contain it. Citadel's own lead each group.
 */
export function matchCommands(list, query) {
  const q = query.toLowerCase();
  const rank = (name) => {
    const n = name.toLowerCase();
    if (n.startsWith(q)) return 0;
    if (n.includes(':') && n.split(':')[1].startsWith(q)) return 1;
    return n.includes(q) ? 2 : -1;
  };
  return list.map((c) => ({ c, r: rank(c.name) })).filter(({ r }) => r >= 0)
    .sort((a, b) => a.r - b.r || (b.c.citadel ? 1 : 0) - (a.c.citadel ? 1 : 0) || a.c.name.localeCompare(b.c.name))
    .map(({ c }) => c);
}

/** A chat's whole list: Citadel's own for its kind, then the loaded ones (a loaded name Citadel also uses stays Citadel's). */
export function chatCommandList(loaded, minion) {
  const own = CITADEL_COMMANDS.filter((c) => minion || !c.minion).map((c) => ({ ...c, citadel: true }));
  const taken = new Set(own.map((c) => c.name));
  return [...own, ...loaded.filter((c) => !taken.has(c.name))];
}
