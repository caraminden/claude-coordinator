// A contraption's bug report or feature ask in its home scheme's Taskmaster chat (#316, Josh 2026-11-05:
// "they should be collapsed and summarized, not GIANT walls of text"): one header line and a short
// summary, the full text behind a toggle. The server sends `ask` with the event (src/routes/contraptions.ts).

/**
 * The header line: kind, contraption, person and the item it's about, if any.
 * `ask` is `{ kind: 'bug'|'feature', contraption, person, member, item?, summary }`.
 */
export function askHeader(ask) {
  return [ask.kind === 'bug' ? 'Bug report' : 'Feature ask', ask.contraption, ask.member ? ask.person : `${ask.person}, not a member`, ask.item ? `about “${ask.item}”` : ''].filter(Boolean).join(' · ');
}
