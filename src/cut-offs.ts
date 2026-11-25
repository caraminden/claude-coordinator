// Commands a time limit cut off (#1992), read from a minion's stream as it arrives. A command only moved to the background
// kept running, and a citadel-wait that ran out is a wait, so neither is one. One of a
// minion's own (`timeout 590 tail -f … | grep -m1`) is kept, by `timeout`: its command says what it was.
import type { ClaudeEvent } from './claude-events.ts';
import type { CutOff } from './db/wait-records.ts';

const COMMAND_MAX = 300;
const CITADEL_TEST = /(?:^|[\s;&|(`/])citadel-test(?=\s|$)/;
/** `timeout [options] <length>`: -k and -s take a value of their own. */
const TIMEOUT = /(?:^|[\s;&|(`])timeout(?:\s+(?:-[ks]\s+\S+|--?[a-z][\w=.-]*))*\s+(\d+(?:\.\d+)?)([smhd]?)(?=\s)/g;
const UNIT: Record<string, number> = { '': 1, s: 1, m: 60, h: 3600, d: 86400 };

/** The limit that cut this finished Bash call off, or null when none did. */
export function cutOffOf(command: string, output: string, isError: boolean): Pick<CutOff, 'limit' | 'seconds'> | null {
  const say = (limit: CutOff['limit'], seconds?: string | number) => ({ limit, ...(seconds !== undefined && { seconds: Number(seconds) }) });
  // The tools' own words, when the command ran that tool: one that only prints a log with them in it doesn't count.
  const tested = CITADEL_TEST.test(command) && /^✖ stopped at the time limit, (\d+) s/m.exec(output);
  if (tested) return say('citadel-test', tested[1]);
  const ran = /(?:^|[\s;&|(`/])run-tests\.sh(?=\s|$)/.test(command) && /^run-tests: the tests ran past (\d+)s and were stopped/m.exec(output);
  if (ran) return say('run-tests', ran[1]);
  if (!isError || !/^Exit code 124\b/.test(output) || /^citadel-(wait: still waiting |job: still running; )/m.test(output)) return null;
  const limits = new Set([...command.matchAll(TIMEOUT)].map((m) => Number(m[1]) * UNIT[m[2]]));
  if (limits.size) return say('timeout', limits.size === 1 ? [...limits][0] : undefined);
  // Its line can fall past the kept output: the command says it.
  if (CITADEL_TEST.test(command)) return say('citadel-test', /--timeout[= ](\d+)/.exec(command)?.[1]);
  return say(null);
}

/** A citadel-job that ended at its own limit. */
export const jobCutOff = (job: { what: string; limitMs: number; ended?: number }): CutOff => ({ at: job.ended ?? Date.now(), limit: 'citadel-job', seconds: Math.round(job.limitMs / 1000), command: job.what.slice(0, COMMAND_MAX) });

/** The runner hands it every stream event of every minion; it writes a record for each command a limit cut off. */
export class CutOffs {
  /** Each minion's Bash calls by their id; a finished one stays until its turn ends, as a background one's end names it. */
  private calls = new Map<number, Map<string, { command: string; parent?: string }>>();
  private add: (ticketId: number, cut: CutOff) => void;
  private now: () => number;
  constructor(add: (ticketId: number, cut: CutOff) => void, now = Date.now) {
    this.add = add;
    this.now = now;
  }

  observe(ticketId: number, ev: ClaudeEvent) {
    if (ev.type === 'system' && ev.subtype === 'init') this.calls.delete(ticketId);
    if (ev.type === 'system' && ev.subtype === 'task_notification' && /was stopped after reaching its background time limit$/.test(ev.summary ?? '')) {
      const name = /^Background command "([\s\S]*)" was stopped/.exec(ev.summary!)?.[1];
      this.note(ticketId, ev.tool_use_id, { limit: 'background' }, name);
    }
    if (ev.type === 'result') this.calls.delete(ticketId);
    if (!Array.isArray(ev.message?.content)) return;
    for (const b of ev.message.content) {
      if (ev.type === 'assistant' && b?.type === 'tool_use' && b.name === 'Bash' && typeof b.input?.command === 'string') {
        const mine = this.calls.get(ticketId) ?? new Map();
        this.calls.set(ticketId, mine);
        mine.set(b.id!, { command: b.input.command, ...(ev.parent_tool_use_id && { parent: ev.parent_tool_use_id }) });
      } else if (ev.type === 'user' && b?.type === 'tool_result') {
        // Not Bash's, or begun before a restart of the server: without its command nothing says which limit it was.
        const call = this.calls.get(ticketId)?.get(b.tool_use_id!);
        const cut = call && cutOffOf(call.command, typeof b.content === 'string' ? b.content : (b.content ?? []).map((c) => c.text ?? '').join('\n'), !!b.is_error);
        if (cut) this.note(ticketId, b.tool_use_id, cut);
      }
    }
  }

  private note(ticketId: number, id: string | undefined, cut: Pick<CutOff, 'limit' | 'seconds'>, name?: string) {
    const call = id ? this.calls.get(ticketId)?.get(id) : undefined;
    const command = call?.command ?? name;
    this.add(ticketId, { at: this.now(), ...cut, ...(command && { command: command.slice(0, COMMAND_MAX) }), ...(id && { tool_use_id: id }), ...(call?.parent && { parent: call.parent }) });
  }
}
