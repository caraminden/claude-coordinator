// The tripwire's shared types and two helpers, for src/tripwire.ts and src/tripwire-git.ts.
// It imports no local file, and neither tripwire file may import the other back: pinnedCopy in turn-launch.ts
// follows ./ imports before it writes, so a cycle would recurse until the server fails to start.

export interface TripwireConfig {
  home: string;
  /** The live data dir (DATA_DIR of the server that started the turn). */
  data: string;
  /** The checkout that server runs from. */
  checkout: string;
  /** The turn's own scheme (project id); its folder under data/projects is the one writable part. */
  project: number;
  claudeConfig: string;
  /** Whether tools/deploy.sh exists in the checkout; read from disk when left out. */
  deployScript?: boolean;
  /** Whether this turn can show an approval card (minions can; Taskmasters can't), so ask-tier calls ask. */
  ask?: boolean;
  /** The turn's environment, for paths like "$TMPDIR/x"; the hook's own (the turn's) when left out. */
  env?: Record<string, string | undefined>;
  /** The turn's own folder (its pinned tripwire and hook config), read-only to the turn; Codex turns set it (#337). */
  turnDir?: string;
  /** Contraptions' folders this turn reads but never writes: the Citadel scheme's Taskmaster's (#656). */
  readOnly?: string[];
  /** Folders whose .env files this turn never reads, directly or by a recursive search: a Taskmaster's, other schemes' and contraptions' (#656). */
  envFiles?: string[];
}

/** Why a call is stopped, and whether a person may approve it once on a card instead. */
export interface Verdict {
  reason: string;
  ask: boolean;
}
export const hard = (reason: string): Verdict => ({ reason, ask: false });

export const under = (p: string, root: string) => p === root || p.startsWith(root.endsWith('/') ? root : root + '/');

/**
 * A word of the command. `unknown` when it holds an expansion the lexer can't see through; then `tmpl`
 * is its text with each expansion marked: \0NAME\0 for a variable (\0__1\0 for $1, which a call of a
 * function binds), \0__name\0 for a $(basename …), \0\0 for anything else ($(…), $@, ${x%/*}), so a
 * variable the command sets, or the turn's environment, can fill it in later.
 */
export interface Word {
  text: string;
  unknown: boolean;
  tmpl?: string;
}
