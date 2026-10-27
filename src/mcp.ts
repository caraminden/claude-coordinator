// MCP server (stdio, newline-delimited JSON-RPC) that gives a project's coordinator
// ticket tools to manage the project's other tickets through the coordinator API.
// Started by claude from the coordinator's --mcp-config; configured by environment.
import { createInterface } from 'node:readline';

const API = process.env.COORDINATOR_API ?? 'http://127.0.0.1:8573';
const TOKEN = process.env.COORDINATOR_TOKEN ?? '';
const PROJECT = Number(process.env.COORDINATOR_PROJECT);
// 'coordinator' manages the project's tickets; 'thread' lets a ticket label itself.
const ROLE = process.env.COORDINATOR_ROLE === 'thread' ? 'thread' : 'coordinator';
const TICKET = Number(process.env.COORDINATOR_TICKET);
const MAX_TEXT = 4000;

const TITLE = { type: 'string', description: 'The short ask, about 30 characters, e.g. "Usage bar in the top bar". No number, tag or emoji.' };
const TAG = {
  type: ['string', 'null'],
  enum: ['feature', 'bug', 'design', 'process', 'idea', null],
  description:
    'What kind of work: feature (new or changed behaviour), bug (something broken), design (look and layout), process (how we work: tooling, prompts, docs, setup), idea (exploring or planning, no code yet). null for one-off questions and reviews.',
};
const STATE = {
  type: ['string', 'null'],
  enum: ['ready', 'try', 'parked', 'blocked', 'outside', null],
  description:
    'Where the turn leaves things, for the threads list: ready (done; ready to merge or pick up), try (ready for people to try out), parked (on hold on purpose), blocked (stuck on something outside the thread, not a person\'s answer), outside (work still running somewhere this thread cannot wait on, like CI). null when it is simply people\'s turn to answer, which the list shows by itself. Cleared automatically when the next turn starts.',
};
const NOTE = { type: ['string', 'null'], description: 'One terse line on where things stand, max 60 chars, e.g. "needs a pick: tabs or a list" or "merged, live after restart". No names or prefixes.' };

const TICKET_ID = { type: 'integer', description: 'Ticket number in this project, e.g. 12 for #12 (as shown by list_tickets)' };

const ASK_QUESTION = {
  name: 'ask_question',
  description:
    'Ask people in this chat 1 to 4 multiple-choice questions, shown as a card they answer with a click (they can also type their own answer). Use it for real decisions with clear options, instead of listing choices in prose. Put your recommended option first. After calling it, finish your turn with a short reply and wait: the answers arrive as the next message.',
  inputSchema: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        minItems: 1,
        maxItems: 4,
        items: {
          type: 'object',
          properties: {
            question: { type: 'string', description: 'The full question, ending in "?"' },
            header: { type: 'string', description: 'A very short label for the card, max 24 chars, e.g. "Layout"' },
            multiSelect: { type: 'boolean', description: 'true if several options can be picked (default false)' },
            options: {
              type: 'array',
              minItems: 2,
              maxItems: 6,
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string', description: 'The choice, 1 to 5 words' },
                  description: { type: 'string', description: 'What picking it means, or its trade-off' },
                },
                required: ['label'],
              },
            },
          },
          required: ['question', 'options'],
        },
      },
    },
    required: ['questions'],
  },
};

const TOOLS = [
  {
    name: 'list_tickets',
    description: 'List the tickets in this project with their status and latest activity.',
    inputSchema: {
      type: 'object',
      properties: { include_closed: { type: 'boolean', description: 'Include closed tickets (default false)' } },
    },
  },
  {
    name: 'read_ticket',
    description: "Read a ticket's details and the most recent messages in its conversation.",
    inputSchema: {
      type: 'object',
      properties: { ticket_id: TICKET_ID, last: { type: 'integer', description: 'How many recent entries to return (default 10, max 50)' } },
      required: ['ticket_id'],
    },
  },
  {
    name: 'create_ticket',
    description:
      'Start a new ticket: a separate Claude Code session in its own git worktree and branch. The message is its first instruction, so make it self-contained.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { ...TITLE, description: `${TITLE.description} Also used for the branch name.` },
        tag: TAG,
        message: { type: 'string', description: 'First message to the new ticket' },
      },
      required: ['title', 'message'],
    },
  },
  {
    name: 'message_ticket',
    description: 'Send a message to a ticket. It runs now, or after the current turn if the ticket is busy. Reopens it if closed.',
    inputSchema: {
      type: 'object',
      properties: { ticket_id: TICKET_ID, text: { type: 'string' } },
      required: ['ticket_id', 'text'],
    },
  },
  {
    name: 'update_ticket',
    description: "Change a ticket's title, tag, state or note; leave out what should stay. (The branch keeps its original name.)",
    inputSchema: {
      type: 'object',
      properties: { ticket_id: TICKET_ID, title: TITLE, tag: TAG, state: STATE, note: NOTE },
      required: ['ticket_id'],
    },
  },
  {
    name: 'close_ticket',
    description: 'Close a finished or abandoned ticket. Its worktree and branch are kept. A running ticket must be stopped first.',
    inputSchema: { type: 'object', properties: { ticket_id: TICKET_ID }, required: ['ticket_id'] },
  },
  {
    name: 'reopen_ticket',
    description: 'Reopen a closed ticket.',
    inputSchema: { type: 'object', properties: { ticket_id: TICKET_ID }, required: ['ticket_id'] },
  },
  {
    name: 'stop_ticket',
    description: "Interrupt a ticket's running turn and drop its queued messages.",
    inputSchema: { type: 'object', properties: { ticket_id: TICKET_ID }, required: ['ticket_id'] },
  },
  ASK_QUESTION,
  {
    name: 'get_project_instructions',
    description: "Read the project instructions: the standing rules people set for this project, which every ticket and you receive in the system prompt.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'set_project_instructions',
    description:
      'Replace the project instructions with new text (max 16,000 characters; empty clears them). They reach every ticket, and you, from its next turn. Read the current text first and send the whole new version, not just the change.',
    inputSchema: { type: 'object', properties: { instructions: { type: 'string' } }, required: ['instructions'] },
  },
];

async function call(method: string, path: string, body?: object): Promise<any> {
  const res = await fetch(API + path, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function clip(s: string): string {
  return s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)} … [${s.length - MAX_TEXT} more chars]` : s;
}

function ticketLine(t: any): string {
  return [
    `#${t.number} ${t.title}`,
    t.tag ? `tag: ${t.tag}` : '',
    `status: ${t.status}${t.state ? `, ${t.state}` : ''}${t.queued ? ` (${t.queued} queued)` : ''}${t.closing ? ' (closes after this turn)' : ''}`,
    t.note ? `note: ${t.note}` : '',
    t.branch ? `branch: ${t.branch}` : '',
    `by ${t.created_by}`,
    t.last_activity ? `latest: ${t.last_activity}` : '',
  ].filter(Boolean).join(' | ');
}

/** Turn stored events into a readable transcript, skipping tool calls. */
function transcript(events: any[]): string[] {
  const out: string[] = [];
  for (const ev of events) {
    const data = JSON.parse(ev.data);
    if (ev.kind === 'user_message') out.push(`[${data.author}]: ${clip(data.text)}`);
    else if (ev.kind === 'note') out.push(`(note) ${data.text}`);
    else if (ev.kind === 'error') out.push(`(error) ${clip(data.text)}`);
    else if (ev.kind === 'claude' && data.type === 'assistant') {
      const text = (data.message?.content ?? [])
        .filter((b: any) => b.type === 'text' && b.text.trim())
        .map((b: any) => b.text.trim())
        .join('\n');
      if (text) out.push(`[Claude]: ${clip(text)}`);
    } else if (ev.kind === 'claude' && data.type === 'result') {
      out.push(data.is_error ? '(turn failed)' : '(turn finished)');
    }
  }
  return out;
}

/** Tickets are numbered per project; the API addresses them by their global id. */
async function id(args: any): Promise<number> {
  const n = Number(args.ticket_id);
  if (!Number.isInteger(n) || n <= 0) throw new Error('ticket_id must be a ticket number');
  const { tickets } = await call('GET', `/api/projects/${PROJECT}`);
  const ticket = tickets.find((t: any) => t.number === n);
  if (!ticket) throw new Error(`There is no ticket #${n} in this project`);
  return ticket.id;
}

/** The label fields a call sets; ones left out stay as they are. */
function labelFields(args: any) {
  const out: Record<string, unknown> = {};
  for (const k of ['title', 'tag', 'state', 'note']) if (args[k] !== undefined) out[k] = args[k];
  return out;
}

const THREAD_TOOLS = [
  {
    name: 'set_thread_status',
    description:
      "Label this thread for the project's threads list: its short title, kind of work, and where things stand. Leave out what should stay. Call it when the work's kind becomes clear, and at the end of a turn whenever the state or note changes.",
    inputSchema: { type: 'object', properties: { title: TITLE, tag: TAG, state: STATE, note: NOTE } },
  },
  ASK_QUESTION,
  {
    name: 'close_self',
    description:
      "Close this thread when the current turn ends, e.g. once a small fix is merged and shipped. It closes only if the turn finishes cleanly and no new message arrived meanwhile; its worktree and branch are kept, and anyone can reopen it by sending a message. Call it near the end of your turn, after your summary is settled.",
    inputSchema: {
      type: 'object',
      properties: { reason: { type: 'string', description: 'Optional one-line summary shown in the thread with the close, e.g. "Merged abc1234; live after the restart"' } },
    },
  },
];

async function runTool(name: string, args: any): Promise<string> {
  // Each role may only call its own tools.
  if (!(ROLE === 'thread' ? THREAD_TOOLS : TOOLS).some((t) => t.name === name)) throw new Error(`Unknown tool ${name}`);
  switch (name) {
    case 'list_tickets': {
      const { tickets } = await call('GET', `/api/projects/${PROJECT}`);
      const shown = tickets.filter((t: any) => args.include_closed || t.status !== 'closed');
      return shown.length ? shown.map(ticketLine).join('\n') : 'No tickets.';
    }
    case 'read_ticket': {
      const n = await id(args);
      const last = Math.min(Math.max(Number(args.last) || 10, 1), 50);
      const [{ ticket }, events] = await Promise.all([call('GET', `/api/tickets/${n}`), call('GET', `/api/tickets/${n}/events`)]);
      const lines = transcript(events);
      const skipped = Math.max(lines.length - last, 0);
      return [ticketLine(ticket), skipped ? `(${skipped} earlier entries omitted)` : '', ...lines.slice(-last)].filter(Boolean).join('\n\n');
    }
    case 'create_ticket': {
      const t = await call('POST', `/api/projects/${PROJECT}/tickets`, {
        title: args.title,
        tag: args.tag ?? null,
        message: args.message,
      });
      return `Created ${ticketLine(t)}`;
    }
    case 'get_project_instructions': {
      const { project } = await call('GET', `/api/projects/${PROJECT}`);
      if (!project.instructions) return 'This project has no instructions yet.';
      const by = project.instructions_updated_by ? ` (last changed by ${project.instructions_updated_by})` : '';
      return `Project instructions${by}:\n\n${project.instructions}`;
    }
    case 'set_project_instructions': {
      const project = await call('PATCH', `/api/projects/${PROJECT}`, { instructions: String(args.instructions ?? '') });
      return project.instructions ? `Saved (${project.instructions.length} characters).` : 'Cleared the project instructions.';
    }
    case 'message_ticket':
      return `Sent. ${ticketLine(await call('POST', `/api/tickets/${await id(args)}/messages`, { text: args.text }))}`;
    case 'update_ticket':
      return `Updated. ${ticketLine(await call('PATCH', `/api/tickets/${await id(args)}`, labelFields(args)))}`;
    case 'ask_question':
      await call('POST', `/api/tickets/${TICKET}/questions`, { questions: args.questions });
      return 'The question card is in the chat. End your turn now with a short reply; the answers will come as the next message.';
    case 'set_thread_status':
      return `Updated. ${ticketLine(await call('PATCH', `/api/tickets/${TICKET}`, labelFields(args)))}`;
    case 'close_self':
      try {
        await call('POST', `/api/tickets/${TICKET}/close`, { reason: args.reason ?? null });
      } catch (err: any) {
        // A server from before close_self refuses the route with its generic "only itself" error.
        if (/only update itself|Not found/.test(err.message)) {
          throw new Error('The coordinator server running now predates close_self, so it cannot close threads yet; it will after its next restart. End your reply with "Done, ready to close" instead.');
        }
        throw err;
      }
      return 'This thread will close when your turn ends (unless the turn fails or a new message arrives). Finish your reply now.';
    case 'close_ticket':
      return `Closed. ${ticketLine(await call('POST', `/api/tickets/${await id(args)}/status`, { status: 'closed' }))}`;
    case 'reopen_ticket':
      return `Reopened. ${ticketLine(await call('POST', `/api/tickets/${await id(args)}/status`, { status: 'idle' }))}`;
    case 'stop_ticket': {
      const { stopped } = await call('POST', `/api/tickets/${await id(args)}/stop`, {});
      return stopped ? 'Stopped.' : 'That ticket was not running.';
    }
    default:
      throw new Error(`Unknown tool ${name}`);
  }
}

function reply(msg: object) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
}

async function handle(req: any) {
  const { id: rid, method, params } = req;
  if (rid === undefined) return; // notification
  try {
    if (method === 'initialize') {
      reply({
        id: rid,
        result: {
          protocolVersion: params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'coordinator', version: '0.1.0' },
        },
      });
    } else if (method === 'tools/list') {
      reply({ id: rid, result: { tools: ROLE === 'thread' ? THREAD_TOOLS : TOOLS } });
    } else if (method === 'tools/call') {
      try {
        const text = await runTool(params?.name, params?.arguments ?? {});
        reply({ id: rid, result: { content: [{ type: 'text', text }] } });
      } catch (err: any) {
        reply({ id: rid, result: { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true } });
      }
    } else if (method === 'ping') {
      reply({ id: rid, result: {} });
    } else {
      reply({ id: rid, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  } catch (err: any) {
    reply({ id: rid, error: { code: -32603, message: err.message } });
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    reply({ id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  handle(req);
});
