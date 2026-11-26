// What every family of MCP tools shares, split out of mcp.ts: the turn's settings (C), the API call, minion number lookups and the field text several families use.
import { setTimeout as sleep } from 'node:timers/promises';
import { thrown } from './thrown.ts';
import { callEnv } from './pool-context.ts';
import { msgFromEnv } from './msg-settings.ts';
import type { TicketView } from './mcp-types.ts';

/**
 * A turn's settings, from its environment: the process's own for a turn's own helper, the calling turn's in the shared
 * tool server (#1259, src/mcp-pool.ts). Read per call through C(), so one process can serve many turns.
 */
function config(env: NodeJS.ProcessEnv) {
  return {
    API: env.COORDINATOR_API ?? 'http://127.0.0.1:8573',
    TOKEN: env.COORDINATOR_TOKEN ?? '',
    PROJECT: Number(env.COORDINATOR_PROJECT),
    // 'coordinator' manages the project's tickets; 'thread' lets a ticket label itself.
    ROLE: env.COORDINATOR_ROLE === 'thread' ? 'thread' : 'coordinator',
    TICKET: Number(env.COORDINATOR_TICKET),
    // Set for minions: Claude Code asks the approve tool before tripwire asks and approval-rule calls.
    APPROVALS: env.COORDINATOR_APPROVALS === '1',
    // A minion of the scheme whose code this server runs (runner.ts): only there do deploys and previews mean anything.
    DEPLOYS: env.COORDINATOR_DEPLOYS === '1',
    /** This turn runs in its person's Claude container (#213), where tools/land.sh can't: any scheme's (#574). */
    IN_CONTAINER: env.COORDINATOR_CONTAINER === '1',
    // Set for the Citadel scheme's Taskmaster: it alone edits the Citadel-wide instructions and the contraptions.
    APP_INSTRUCTIONS: env.COORDINATOR_APP_INSTRUCTIONS === '1',
    // The contraptions whose home is this scheme (#266): it may deploy them.
    HOME_CONTRAPTIONS: (env.COORDINATOR_HOME_CONTRAPTIONS ?? '').split(',').filter(Boolean),
    // The machines this minion's turn got (#617): it may propose new notes for them (checked at call time, #878).
    MACHINES: (env.COORDINATOR_MACHINES ?? '').split(',').filter(Boolean),
    JOB_MACHINES: (env.COORDINATOR_JOB_MACHINES ?? '').split(',').filter(Boolean),
    /** The scheme's message settings as this turn launched (#1059): every number in the messaging tool text comes from here. */
    MSG: msgFromEnv(env.COORDINATOR_MSG),
    // propose_host_tool (#1147; Josh, 2026-11-19): the server's own list of host tools, which turn-launch names in the env.
    HOST_TOOLS_LIST: env.COORDINATOR_HOST_TOOLS,
    /** Search by meaning over the scheme's chats (#331): offered only where the server indexes them. */
    MEMORY: env.COORDINATOR_MEMORY === '1',
    /** A minion on a cabal board or leading one (#2090): offered cabal_board. */
    CABAL: env.COORDINATOR_CABAL === '1',
    SHARED_DIR: env.COORDINATOR_SHARED_DIR?.replace(/\/+$/, ''),
    APP_TURNS_RUN: env.COORDINATOR_APP_TURNS_RUN === '1',
    /** Images and sound through the person's own OpenRouter key (#717): listed for every minion, refused on a turn whose person hasn't connected one (#878). */
    MEDIA: env.COORDINATOR_MEDIA === '1',
    /** generate_image_codex (#733): refused on a turn whose person has no Codex login it can reach (#878). */
    CODEX_IMAGES: env.COORDINATOR_CODEX_IMAGES === '1',
  };
}
const configs = new WeakMap<object, ReturnType<typeof config>>();
export function C() {
  const env = callEnv();
  let c = configs.get(env);
  if (!c) configs.set(env, (c = config(env)));
  return c;
}

export const TICKET_ID = { type: 'integer', description: 'Minion number in this scheme, e.g. 12 for #12 (as shown by list_tickets)' };

export const WHEN_CI_PASSES = {
  type: 'boolean',
  description:
    'true: hold it until CI passes on the commit you pushed (your HEAD), then the server posts it with no turn for you; the CI line reaches you as held mail. For a step that only relays green CI (a ship card, "ready to ship" to the Taskmaster) in a scheme whose PRs run CI. Leave it out when you must look at CI\'s results yourself first (screenshots, test counts), or the scheme ships with land.sh (no PR CI: refused). Push first. CI failing, a new push or a turn still running drops it, and you\'re woken as usual.',
};

/** How long a call keeps trying while the app restarts: the turn outlives the server, its calls wait for the next one. */
const RETRY_MS = 120_000;

export async function call<T = Record<string, unknown>>(method: string, path: string, body?: object): Promise<T> {
  const started = Date.now();
  let res!: Response;
  for (let wait = 500; ; wait = Math.min(wait * 2, 5000)) {
    // A refused connection never reached the app, so any call is safe to send again; one cut off
    // mid-way, or answered by the proxy, may have run, so only reads are.
    let retry = false;
    try {
      res = await fetch(C().API + path, {
        method,
        headers: { Authorization: `Bearer ${C().TOKEN}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      retry = method === 'GET' && (res.status === 502 || res.status === 503);
    } catch (err) {
      if (!((thrown(err).cause as { code?: string } | undefined)?.code === 'ECONNREFUSED' || method === 'GET') || Date.now() - started > RETRY_MS) throw err;
      retry = true;
    }
    if (!retry || Date.now() - started > RETRY_MS) break;
    await sleep(wait);
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data as T;
}

/** Properties as people read them: always `key: value`, since one word can be a value of two keys. */
export function propertyText(props: Record<string, unknown> | undefined): string {
  return Object.entries(props ?? {})
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
    .join('; ');
}

/** Tickets are numbered per project; the API addresses them by their global id. */
export async function id(args: Record<string, unknown>, scheme = C().PROJECT): Promise<number> {
  const n = Number(args.ticket_id);
  if (!Number.isInteger(n) || n <= 0) throw new Error('ticket_id must be a minion number');
  const { tickets } = await call<{ tickets: TicketView[] }>('GET', `/api/projects/${scheme}?number=${n}`); // one minion's view, not the whole scheme's (#609)
  const ticket = tickets.find((t) => t.number === n);
  if (!ticket) throw new Error(`There is no minion #${n} in ${scheme === C().PROJECT ? 'this' : 'that'} scheme`);
  return ticket.id;
}

/** A set/update tool that was given nothing to set did nothing; say so rather than "Updated". */
export function needOne(args: Record<string, unknown>, fields: string[], tool: string): void {
  if (!fields.some((k) => args[k] !== undefined)) throw new Error(`${tool}: pass at least one of ${fields.join(', ')}. Nothing was changed.`);
}

// The same lists as MODELS and EFFORTS in db.ts; the server checks them again. Required on create (#698;
// Cara, 2026-11-14: "we should ALWAYS make an intentional choice about model"): the table is in the Taskmaster's prompt.
export const MODEL_IDS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-sonnet-5-5+opus-advisor', 'claude-haiku-5-5', 'claude-fable-5-1', 'claude-fable-5-2', 'gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-luna'];
/** The advisor trial's brief to the Taskmaster (#817; handoff from #813): whom it starts on the advisor. Here, not in public/model-table.js, as turns run a pinned copy of this file that carries only ./ imports. */
export const ADVISOR_TRIAL = 'claude-sonnet-5-5+opus-advisor: Sonnet runs the turn and consults Opus at hard points; the model table says when. Never a Taskmaster.';
export const EFFORT_IDS = ['low', 'medium', 'high', 'xhigh', 'max'];
export const MODEL = {
  type: 'string',
  enum: MODEL_IDS,
  description: `The model for the minion's turns, from the model table in your prompt. Required. gpt-6-* are Codex, only on a person's ask. ${ADVISOR_TRIAL}`,
};
export const EFFORT = {
  type: 'string',
  enum: EFFORT_IDS,
  description: "The effort for the minion's turns, as in its composer. Required: the effort the model table pairs with your model for this kind of work. xhigh only after a Fable run failed twice or a person asks; never max.",
};

export const PROPERTIES = {
  type: 'object',
  description: 'Properties as { key: value }, e.g. { "type": "feature", "area": ["town", "ui"], "build": 8 }. Keys and values come from list_properties; aliases resolve to their value, and null clears a key. Unknown keys and values are refused with a "did you mean".',
  additionalProperties: true,
};

/** A family's answer for a tool that is another family's. */
export const NOT_HERE = Symbol("not this family's tool");
