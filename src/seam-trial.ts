// The fresh-sessions-at-seams trial (#1129, Josh 2026-11-19: "Go on F3"). A long minion re-reads everything it ever
// said on every call, and compaction hits it at a moment nobody chose. In this trial, minions of every scheme whose
// turn ends past SEAM_CONTEXT_TOKENS are enrolled one by one, alternately into two groups of ARM_SIZE: the fresh
// group is told (a turn line) to hand off at a seam it picks and carry on in a fresh Claude session (fresh_session);
// the control group carries on as today and is told nothing. tools/seam-trial.ts compares the two. Once both groups
// are full nobody else is enrolled: nothing goes wider without a person's go on the readout's card.
import type { Ticket } from './db.ts';

/** The trial's one setting: who is in which group, since when. */
export const SEAM_TRIAL_KEY = 'seam-trial';
/** A minion whose turn ends past this much context (tokens) is enrolled. */
export const SEAM_CONTEXT_TOKENS = 150_000;
/** Minions per group. */
export const ARM_SIZE = 20;

export type Arm = 'fresh' | 'control';
export interface Enrolled { id: number; at: number; context: number }
export interface SeamTrial { since: number; fresh: Enrolled[]; control: Enrolled[]; full?: number }

/** Which group a minion is in, or null. */
export function armOf(trial: SeamTrial | null | undefined, ticketId: number): Arm | null {
  if (!trial) return null;
  if (trial.fresh.some((e) => e.id === ticketId)) return 'fresh';
  if (trial.control.some((e) => e.id === ticketId)) return 'control';
  return null;
}

/** Whether a minion can be enrolled at all: an open minion (not a Taskmaster) on a Claude model with a session. */
export function eligible(t: Ticket | undefined, codex: boolean): boolean {
  return !!t && t.kind === 'ticket' && t.status !== 'closed' && !!t.session_id && !codex;
}

/**
 * Enrol a minion whose turn just ended with `context` tokens, if it qualifies and a group has room: groups take turns,
 * so they stay the same size. Returns the trial to save and the minion's group, or null when nothing changes.
 */
export function enrol(trial: SeamTrial | null | undefined, ticketId: number, context: number, now: number): { trial: SeamTrial; arm: Arm; filled: boolean } | null {
  if (context <= SEAM_CONTEXT_TOKENS) return null;
  const t: SeamTrial = trial ?? { since: now, fresh: [], control: [] };
  if (armOf(t, ticketId) || t.full) return null;
  const arm: Arm = t.fresh.length <= t.control.length ? 'fresh' : 'control';
  if (t[arm].length >= ARM_SIZE) return null;
  const next: SeamTrial = { ...t, [arm]: [...t[arm], { id: ticketId, at: now, context }] };
  const filled = next.fresh.length >= ARM_SIZE && next.control.length >= ARM_SIZE;
  if (filled) next.full = now;
  return { trial: next, arm, filled };
}

const k = (tokens: number) => `${Math.round(tokens / 1000)}k`;

/** The fresh group's line in each turn's [System] note while its context is past the mark. */
export const trialLine = (context: number) =>
  `Fresh-session trial: you are in the group that starts a fresh Claude session at a seam (your context is about ${k(context)} tokens). At the next seam you pick (research done, a plan approved, a first ship handed off with more to do, a big step finished), call fresh_session with your handoff instead of carrying this whole conversation on: your session resets when this turn ends, and your next turn starts from the handoff by itself. Pick a clean moment, not mid-step, and not in a turn that ships, closes or parks you.`;

/** Why the chat's note says it started fresh. */
export const SEAM_WHY = 'a seam the minion picked, in the fresh-session trial';

/** The message that starts the fresh session's first turn when the minion carries on. */
export const CARRY_ON = 'Your fresh session starts here. Carry on from your handoff: recreate your task list from it first, then check your worktree and git log before acting on it.';

/** How the server's facts sheet opens under a minion's handoff. */
export const MINION_SHEET_CHECK = 'Facts sheet built by the server from the database at hand-off: check your handoff above against it, and trust the sheet where they differ. The people\'s messages below are their own words.';

/** Held mail for the Citadel Taskmaster once both groups are full. */
export const fullText = (t: SeamTrial) =>
  `The fresh-session trial (#1129) has both groups full: ${t.fresh.length} fresh (${t.fresh.map((e) => `id ${e.id}`).join(', ')}) and ${t.control.length} control. No more minions are enrolled. Once most of them are dismissed, run \`node tools/seam-trial.ts\` on the host for the readout and put it on a card: nothing goes wider without a go.`;
