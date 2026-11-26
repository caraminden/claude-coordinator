// MCP server (stdio, newline-delimited JSON-RPC) that gives a project's coordinator
// ticket tools to manage the project's other tickets through the coordinator API.
// Started by claude from the coordinator's --mcp-config; configured by environment.
import { createInterface } from 'node:readline';
import { thrown } from './thrown.ts';
import { callEnv, callCwd } from './pool-context.ts';
import { toolsForTurn } from './tool-hold.ts';
import type { ToolDef, RpcRequest } from './mcp-types.ts';
import { CODEX_IMAGE_TOOL, codexImage, MEDIA_TOOL_LIST } from './mcp-media.ts';
import { C, call, NOT_HERE } from './mcp-call.ts';
import { APP_TOOLS, CONTRAPTION_TOOLS, PUBLISH_RELEASE, PUBLISH_DESKTOP, MAKE_RELEASE_KEY, DEPLOY_CONTRAPTION, COPY_APP_DATA, MANDATE_ITEM, CONTRAPTION_READ, CONTRAPTION_TURNS, runAppsTool } from './mcp-apps.ts';
import { WAKE_AT, PREP_ULTRA_REVIEWS, HOST_CHECK, CI_RUNNERS, CI_FILES, SHIP_RISK, WAKE_WHEN_LIVE, ORDER_SHIP_LINE, MARK_URGENT, SHIP_LESSONS, RELAY_WHEN_LIVE, MINION_WAKE_WHEN_LIVE, WAKE_WHEN_RUNNERS_BACK, REPORT_SPEND, LOG_LEARNED, HAND_OFF_LAND, LAND, START_PREVIEW, runShipTool } from './mcp-ship.ts';
import { ASK_QUESTION, SETTLE_QUESTION, PROPOSE_PLAN, PROPOSE_MACHINE_LEND, PROPOSE_HOST_TOOL, PROPOSE_MACHINE_NOTES, PROPOSE_MEMORY, APPLY_MEMORY, STRIKE_TEXT, MARK_IMAGE, APPROVE, runCardsTool } from './mcp-cards.ts';
import {
  LIST_PROPERTIES,
  EDIT_INSTRUCTIONS,
  LIST_SCHEDULES,
  SCHEDULE_MINION,
  SCHEDULE_AUDIT,
  UPDATE_SCHEDULE,
  DELETE_SCHEDULE,
  SET_PROPERTIES,
  REGISTER_PROPERTY_VALUES,
  REGISTER_PROPERTY_KEY,
  GET_PROJECT_INSTRUCTIONS,
  SET_PROJECT_INSTRUCTIONS,
  GET_PROJECT_SETTINGS,
  SET_PROJECT_SETTINGS,
  READ_PERSON_INSTRUCTIONS,
  APP_INSTRUCTION_TOOLS,
  REVIEW_SET,
  RECORD_VERDICT,
  MINION_SET_PROPERTIES,
  runSchemeTool,
} from './mcp-scheme.ts';
import {
  LIST_TICKETS,
  LIVE_FACTS,
  READ_TICKET,
  CREATE_TICKET,
  MESSAGE_TICKET,
  MESSAGE_TASKMASTER,
  UPDATE_TICKET,
  FRESH_SESSION,
  CLAIM,
  RELEASE,
  LIST_CLAIMS,
  CLOSE_TICKET,
  REOPEN_TICKET,
  STOP_TICKET,
  PLAN,
  SET_THREAD_STATUS,
  MESSAGE_COORDINATOR,
  MESSAGE_MINION,
  READ_MINION,
  CLOSE_SELF,
  runMinionsTool,
} from './mcp-minions.ts';
import { RUN_ON_HOST, QUEUE_JOB, JOB_STATUS, STOP_JOB, ARTIFACT_TOOLS, USAGE_SPLIT, LIST_CATALOGUE, LIST_MACHINES, CHECK_MACHINE, SEARCH_MEMORY, SEARCH_DECISIONS, SEARCH_MINIONS, IDEAS, runLookupTool } from './mcp-lookup.ts';
export { usageSplitText } from './mcp-text.ts';
export { NOT_DEFAULT } from './mcp-media.ts';
export { handOffResult } from './mcp-ship.ts';
export { SCHEDULE_TEMPLATES, reviewFields } from './mcp-scheme.ts';
export { closeSelfResult, PLAN, planResult } from './mcp-minions.ts';

const TOOLS = () => [
  LIST_TICKETS,
  LIVE_FACTS,
  SHIP_RISK,
  USAGE_SPLIT,
  READ_TICKET,
  CREATE_TICKET,
  MESSAGE_TICKET(),
  MESSAGE_TASKMASTER(),
  UPDATE_TICKET,
  WAKE_WHEN_LIVE,
  FRESH_SESSION,
  CLAIM,
  RELEASE,
  LIST_CLAIMS,
  LIST_SCHEDULES,
  SCHEDULE_MINION,
  SCHEDULE_AUDIT,
  UPDATE_SCHEDULE,
  DELETE_SCHEDULE,
  CLOSE_TICKET,
  REOPEN_TICKET,
  STOP_TICKET,
  // A Taskmaster's ask_question also asks for everyone (#921).
  {
    ...ASK_QUESTION(),
    inputSchema: {
      ...ASK_QUESTION().inputSchema,
      properties: {
        ...ASK_QUESTION().inputSchema.properties,
        for_everyone: {
          type: 'boolean',
          description:
            "true: a question for the whole scheme, not just your person (the pipeline lane, a Citadel-wide rule, a build). The card goes to the Overlord's chat, which every member sees, and the first answer settles it for everyone; the answer still comes back to you, and you act on it. Questions only: no to, doc, notice, secret or when_ci_passes. Ignored before the scheme has per-person Taskmasters.",
        },
      },
    },
  },
  SETTLE_QUESTION,
  PROPOSE_PLAN,
  LIST_CATALOGUE,
  LIST_MACHINES,
  CHECK_MACHINE,
  PROPOSE_MACHINE_LEND,
  STRIKE_TEXT,
  LIST_PROPERTIES,
  SET_PROPERTIES,
  REGISTER_PROPERTY_VALUES,
  REGISTER_PROPERTY_KEY,
  GET_PROJECT_INSTRUCTIONS,
  SET_PROJECT_INSTRUCTIONS,
  GET_PROJECT_SETTINGS,
  SET_PROJECT_SETTINGS,
  READ_PERSON_INSTRUCTIONS,
  ...ARTIFACT_TOOLS,
];

const THREAD_TOOLS = () => [
  LIVE_FACTS,
  PLAN,
  SHIP_RISK,
  SET_THREAD_STATUS(),
  // A minion's ship card also prepares its hand-off (#1930).
  {
    ...ASK_QUESTION(),
    inputSchema: {
      ...ASK_QUESTION().inputSchema,
      properties: {
        ...ASK_QUESTION().inputSchema.properties,
        hand_off: { type: 'object', description: "With kind ship: hand_off_land's arguments but go, so Ship It needs no turn" },
      },
    },
  },
  SETTLE_QUESTION,
  STRIKE_TEXT,
  PROPOSE_PLAN,
  MARK_IMAGE,
  { ...LIST_TICKETS, description: `${LIST_TICKETS.description} Read-only: each one's line with its branch, worktree and latest activity line, not its conversation (read_minion reads that).` },
  LIST_PROPERTIES,
  MINION_SET_PROPERTIES,
  MESSAGE_COORDINATOR,
  MESSAGE_MINION(),
  READ_MINION,
  RELAY_WHEN_LIVE,
  MINION_WAKE_WHEN_LIVE,
  WAKE_WHEN_RUNNERS_BACK,
  ...(C().HOST_REACH ? [RUN_ON_HOST()] : []),
  REPORT_SPEND,
  LOG_LEARNED,
  HAND_OFF_LAND(),
  ...(C().IN_CONTAINER ? [LAND()] : []),
  ...(C().DEPLOYS ? [START_PREVIEW] : []),
  CLOSE_SELF(),
  ...ARTIFACT_TOOLS,
];

/** Each family's handlers; a family answers NOT_HERE for another family's tool. */
const FAMILIES = [runAppsTool, runShipTool, runCardsTool, runSchemeTool, runMinionsTool, runLookupTool];

async function runTool(name: string, args: Record<string, unknown>): Promise<string> {
  // Each role may only call its own tools.
  const tool = toolList().find((t) => t.name === name);
  if (!tool) throw new Error(`Unknown tool ${name}`);
  // Models often send the string "null" for null (#481): read it as null where the schema takes null.
  for (const [k, v] of Object.entries(args)) if (v === 'null' && [tool.inputSchema?.properties?.[k]?.type].flat().includes('null')) args[k] = null;
  switch (name) {
    case 'generate_image':
    case 'edit_image':
    case 'generate_audio':
    case 'generate_speech': {
      // Offered to every minion so the tool list doesn't follow the sender (#878); refused here when this turn's person has no key.
      if (!C().MEDIA) throw new Error("Not on this turn: the person it runs for hasn't connected OpenRouter on their account page. Make it with code instead, or ask them to connect it.");
      const r = await call<{ model: string; paths: string[]; cost_usd: unknown; month_usd: unknown; cap_usd: unknown; left_usd: unknown; warnings?: string[]; over_cap?: boolean }>('POST', `/api/tickets/${C().TICKET}/openrouter`, { tool: name, args });
      if (r.model === 'azure-speech')
        return `Wrote ${r.paths.join(', ')} with Azure Speech for about $${Number(r.cost_usd).toFixed(4)} (booked to the scheme: $${Number(r.month_usd).toFixed(2)} outside spend this month${r.cap_usd === null ? '' : ` of the $${Number(r.cap_usd).toFixed(2)} cap${r.over_cap ? ', over it' : ''}`}).`;
      return `Wrote ${r.paths.join(', ')} with ${r.model} for $${Number(r.cost_usd).toFixed(4)}; $${Number(r.left_usd).toFixed(2)} left this month.${r.warnings ? `\n${r.warnings.join('\n')}` : ''}`;
    }
    case 'generate_image_codex':
      if (!C().CODEX_IMAGES) throw new Error('Not on this turn: the person it runs for has no Codex login a turn can reach. Use generate_image (OpenRouter) for this one if it is on this turn.');
      return codexImage(args, callEnv(), callCwd());
    default:
      for (const run of FAMILIES) {
        const answer = await run(name, args);
        if (answer !== NOT_HERE) return answer;
      }
      throw new Error(`Unknown tool ${name}`);
  }
}

/** list_tickets, read_ticket and live_facts with a scheme, for the Citadel scheme's Taskmaster (#656): read-only, no other tool crosses schemes. */
const SCHEME_ARG = { scheme: { type: 'integer', description: "Another scheme's number (as your instructions list them), to read its minions instead of this scheme's. Read-only, and only on a turn a Citadel member or admin asked for; leave it out for this scheme." } };
const withScheme = (t: ToolDef) => (t.name === 'list_tickets' || t.name === 'read_ticket' || t.name === 'live_facts' ? { ...t, inputSchema: { ...t.inputSchema, properties: { ...t.inputSchema.properties, ...SCHEME_ARG } } } : t);

/**
 * Tools every turn of a role uses (#710): Claude Code defers MCP tools behind ToolSearch, a whole round trip each, and again
 * after a resume or compaction. `_meta["anthropic/alwaysLoad"]` keeps these in the first prompt. Each 1k tokens of prefix costs
 * about $27 a week (#699, measured by #1263), so test/mcp-always-load.test.ts pins this list.
 */
export const ALWAYS_LOAD = {
  thread: ['set_thread_status', 'set_properties', 'message_coordinator', 'ask_question', 'close_self', 'plan', 'hand_off_land'],
  taskmaster: ['create_ticket', 'read_ticket', 'message_ticket', 'list_tickets'],
};
const withAlwaysLoad = (tools: ToolDef[]) => {
  const names = ALWAYS_LOAD[C().ROLE === 'thread' ? 'thread' : 'taskmaster'];
  return tools.map((t) => (names.includes(t.name) ? { ...t, _meta: { ...t._meta, 'anthropic/alwaysLoad': true } } : t));
};

function toolList() {
  return withAlwaysLoad(toolListAll());
}

function toolListAll() {
  const host = C().IN_CONTAINER ? [HOST_CHECK] : [];
  const deploy = [...(C().APP_INSTRUCTIONS || C().HOME_CONTRAPTIONS.length ? [DEPLOY_CONTRAPTION()] : []), ...(C().HOME_CONTRAPTIONS.length ? [PUBLISH_RELEASE(), MAKE_RELEASE_KEY()] : [])];
  const memory = [...(C().MEMORY ? [SEARCH_MEMORY] : []), SEARCH_DECISIONS, SEARCH_MINIONS, IDEAS];
  const audit = C().HOME_CONTRAPTIONS.length && (C().ROLE !== 'thread' || C().APP_TURNS_RUN) ? [CONTRAPTION_TURNS()] : [];
  if (C().ROLE !== 'thread')
    return C().APP_INSTRUCTIONS
      ? [...TOOLS().map(withScheme), SHIP_LESSONS, WAKE_AT, CI_RUNNERS, CI_FILES, PUBLISH_DESKTOP, ORDER_SHIP_LINE, MARK_URGENT, ...APP_INSTRUCTION_TOOLS, ...CONTRAPTION_TOOLS, ...APP_TOOLS, ...deploy, MANDATE_ITEM, REVIEW_SET, RECORD_VERDICT, CONTRAPTION_READ, ...audit, ...memory, ...host]
      : [...TOOLS(), WAKE_AT, CI_RUNNERS, CI_FILES, PUBLISH_DESKTOP, ORDER_SHIP_LINE, MARK_URGENT, ...APP_TOOLS, ...deploy, MANDATE_ITEM, REVIEW_SET, RECORD_VERDICT, CONTRAPTION_READ, ...audit, ...memory, ...host];
  return [
    ...THREAD_TOOLS(),
    SHIP_LESSONS,
    WAKE_AT,
    PREP_ULTRA_REVIEWS,
    CI_RUNNERS,
    CI_FILES,
    PUBLISH_DESKTOP,
    ...(C().HOME_CONTRAPTIONS.length ? [DEPLOY_CONTRAPTION(), COPY_APP_DATA(), PUBLISH_RELEASE(), MAKE_RELEASE_KEY()] : []),
    PROPOSE_MACHINE_NOTES,
    PROPOSE_MACHINE_LEND,
    PROPOSE_HOST_TOOL(),
    PROPOSE_MEMORY(),
    APPLY_MEMORY,
    EDIT_INSTRUCTIONS,
    ...(C().JOB_MACHINES.length ? [QUEUE_JOB(), JOB_STATUS, STOP_JOB] : []),
    MANDATE_ITEM,
    REVIEW_SET,
    RECORD_VERDICT,
    CONTRAPTION_READ,
    ...audit,
    ...memory,
    ...MEDIA_TOOL_LIST,
    CODEX_IMAGE_TOOL,
    ...host,
    ...(C().APPROVALS ? [APPROVE] : []),
  ];
}

/** One JSON-RPC request's answer, or null for a notification: a turn's own helper writes it to stdout, the shared tool server (src/mcp-pool.ts) sends it over HTTP. */
export async function handle(req: RpcRequest): Promise<object | null> {
  const { id: rid, method, params } = req;
  if (rid === undefined) return null; // notification
  const reply = (msg: object) => ({ jsonrpc: '2.0', ...msg });
  try {
    if (method === 'initialize') {
      return reply({
        id: rid,
        result: {
          protocolVersion: params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'coordinator', version: '0.1.0' },
        },
      });
    } else if (method === 'tools/list') {
      return reply({ id: rid, result: { tools: await toolsForTurn(toolList(), callEnv()) } });
    } else if (method === 'tools/call') {
      try {
        const text = await runTool(params?.name!, params?.arguments ?? {});
        return reply({ id: rid, result: { content: [{ type: 'text', text }] } });
      } catch (err) {
        return reply({ id: rid, result: { content: [{ type: 'text', text: `Error: ${thrown(err).message}` }], isError: true } });
      }
    } else if (method === 'ping') {
      return reply({ id: rid, result: {} });
    } else {
      return reply({ id: rid, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  } catch (err) {
    return reply({ id: rid, error: { code: -32603, message: thrown(err).message } });
  }
}

// A turn's own helper (stdio, newline-delimited JSON-RPC); the shared tool server imports this file instead.
if (import.meta.main) {
  const write = (msg: object | null) => msg && process.stdout.write(JSON.stringify(msg) + '\n');
  createInterface({ input: process.stdin }).on('line', (line) => {
    if (!line.trim()) return;
    let req;
    try {
      req = JSON.parse(line);
    } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    handle(req).then(write);
  });
}
