// The runner's per-minion memory (#1452, seam review fact 6, #1283): every Map or Set keyed by minion id is saved with its
// turn (TurnState, so a restart mid-turn keeps it), rebuilt at boot from another saved row, or dropped on purpose. A new
// one fails here until it is put in one of the three, so a value a restart loses is caught when it is written.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const src = readFileSync(new URL('../src/runner.ts', import.meta.url), 'utf8');

/** In TurnState: saved by saveTurn, restored by recover() or reattach. */
const SAVED: Record<string, string> = {
  turns: 'dir',
  closing: 'closing',
  deployedMidTurn: 'deployed',
  turnFrom: 'from',
  parkedAs: 'parkedAs',
  statuses: 'status',
  keepalives: 'keepalive',
  spends: 'spend',
  sentBack: 'sentBack',
};
/** Rebuilt from another saved row, or dropped on purpose, and why. */
const OTHER: Record<string, string> = {
  progress: 'a cache, rebuilt from the plan: setting and the events',
  stepRatios: 'a cache by scheme, rebuilt on its next read',
  wakeNow: 'the net or kill wait it hurries is saved; after a restart its message waits for the probe or the kill line',
  limitStarting: "this server's token for a limit resume it started; the wait itself is saved (limit-resumes)",
  killStarted: "this server's note of kill resumes it started; the kill waits are saved and re-armed (armKillResumes)",
  turnSecrets: "read again on the turn's next line",
  keepalivePending: 'keepalives are dropped on a restart (#862); the next sweep asks again',
  gateCounted: 'a count of the keepalive gates; a restart may count one window again',
  contextSizes: "set again by the turn's next usage line",
  contextShown: 'a broadcast throttle',
  refsLast: 'a throttle by scheme; every turn writes its own snapshot at its start',
  mainModels: "the context window keeps its last turn's value until the next init event",
  strayWaits: 'a poll on a turn wrapper nothing here follows; liveTurn finds the stray turn folder again after a restart (#1464)',
};
/** Named before the branch that adds them ships, so the two can ride one ship train in either order; that branch drops it here. */
const IN_FLIGHT = new Set(['strayWaits']);

test('every per-minion Map or Set in the runner is saved with its turn, rebuilt, or dropped on purpose', () => {
  const fields = [...src.matchAll(/^\s+(?:private |readonly )*(\w+) = new (?:Map|Set)<number\b/gm)].map((m) => m[1]);
  assert.ok(fields.length > 10, `found the fields (${fields.join(', ')})`);
  const unnamed = fields.filter((f) => !(f in SAVED) && !(f in OTHER));
  assert.deepEqual(unnamed, [], 'a per-minion Map or Set a restart would lose: add it to TurnState through saveTurn and restore it in recover(), or say here why it may go');
  const stale = [...Object.keys(SAVED), ...Object.keys(OTHER)].filter((f) => !fields.includes(f) && !IN_FLIGHT.has(f));
  assert.deepEqual(stale, [], 'names here no runner field has any more');
  const turnState = /interface TurnState \{([\s\S]*?)\n\}/.exec(src)![1];
  for (const [field, key] of Object.entries(SAVED)) assert.match(turnState, new RegExp(`^\\s+${key}\\?:`, 'm'), `TurnState has ${key} (for ${field})`);
});
