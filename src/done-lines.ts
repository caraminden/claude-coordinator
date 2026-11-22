// The done-lines rule (#1115), out of every minion's system prompt since #1574: a feature minion reads it in its fresh
// session's turn note (src/runner.ts) and when set_properties sets type feature (src/mcp.ts). No imports: mcp.ts runs
// as a pinned copy that carries only ./ imports.
export const DONE_LINES = 'Done lines (#1115): on a feature, before any code, write 3 to 7 "when X, then Y" lines from the person\'s own words and show them in your first reply (or your plan). Keep building: they are a report, not a card, unless two readings would build different things. Keep them in your task list and the PR description, and tick each in your ready note, naming any not met. Bugs, chores and research write none.';
