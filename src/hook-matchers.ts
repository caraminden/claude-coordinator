/**
 * The tools each PreToolUse check of a turn reads, as Claude Code hook matchers (regexes). One home, so the combined
 * runner (hook-run.ts) and the settings that start it (turn-launch.ts) can't drift apart. Node built-ins only: it is
 * pinned with the hooks (turn-launch.ts pinnedCopy follows the ./ imports).
 */

/** The tripwire (tripwire.ts): every tool that can run a command, read or write a file, or load a skill. */
export const TRIPWIRE_MATCHER = '^(Bash|Read|Write|Edit|MultiEdit|NotebookEdit|Grep|Glob|Skill)$';

/** A side question's read-only guard (side-guard.ts, #932): every tool. */
export const SIDE_GUARD_MATCHER = '.*';

/** The tools whose text the wording check (wording.ts) reads before it goes out: messages, cards, notes and file writes. */
export const WORDING_MATCHER = '^(mcp__(thread|coordinator)__(message_coordinator|message_taskmaster|message_ticket|ask_question|propose_plan|update_ticket)|Write|Edit|MultiEdit)$';

/**
 * The tools whose text shows in this scheme's chats, where a bare #N links (scheme-refs.ts). Left out of WORDING_MATCHER's list:
 * message_taskmaster (another scheme reads it, so its bare #N rightly links there), update_ticket (a title or
 * note) and file writes.
 */
export const SCHEME_REFS_MATCHER = '^mcp__(thread|coordinator)__(message_coordinator|message_ticket|ask_question|propose_plan)$';

/** The kit's big-read guard (kit/hooks/big-read.ts): whole reads of big files, by Read or by cat and sed. */
export const BIG_READ_MATCHER = '^(Read|Bash)$';
