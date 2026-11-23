// Holding a warm session's tool text (#1731), beside its prompt hold (src/prompt-hold.ts). The tool list comes before the
// system prompt in the cached prefix, so a deployed rewording of any tool's description re-writes every warm session's
// whole conversation. While the prompt hold says the turn resumes its warm session under the cap (CITADEL_TOOL_HOLD), the
// tool server lists the tools as that session last saw them, as long as only description wording changed: a changed
// parameter, tool or flag takes the current list at once. The list a session saw is kept in the turn's own TMPDIR.
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** A tool list with its description strings left out: what a held list must still match. */
const contract = (tools: unknown[]) => JSON.stringify(tools, (k, v) => (k === 'description' && typeof v === 'string' ? undefined : v));

/** The list this turn's session gets: the held one when it may hold and only wording differs, else the current one. */
export function heldTools<T>(current: T[], held: T[] | null, hold: boolean): T[] {
  return hold && Array.isArray(held) && contract(held) === contract(current) ? held : current;
}

/** tools/list for a turn: reads and keeps the list its session saw in `$TMPDIR` (per minion, cleared on dismissal). */
export async function toolsForTurn<T>(current: T[], env: NodeJS.ProcessEnv): Promise<T[]> {
  if (!env.TMPDIR || !env.COORDINATOR_TICKET) return current;
  // The ticket in the name: a turn whose own temp folder couldn't be made shares the server's TMPDIR.
  const file = join(env.TMPDIR, `.citadel-tools-${env.COORDINATOR_TICKET}.json`);
  // The scheme's message numbers sit in tool text and are enforced elsewhere (src/msg-settings.ts): a change to them is no rewording.
  const msg = env.COORDINATOR_MSG ?? '';
  const hold = env.CITADEL_TOOL_HOLD === '1';
  const kept = hold ? await readFile(file, 'utf8').then((t) => JSON.parse(t)).catch(() => null) : null;
  const tools = heldTools(current, kept?.msg === msg ? kept.tools : null, hold);
  if (tools === current) {
    // Whole or not at all: a half-written file would only lose the hold, but a rename never leaves one.
    const part = `${file}.${process.pid}.part`;
    await writeFile(part, JSON.stringify({ msg, tools: current })).then(() => rename(part, file)).catch(() => {});
  }
  return tools;
}
