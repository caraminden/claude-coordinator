// MCP server (stdio, newline-delimited JSON-RPC) that gives a project's coordinator
// ticket tools to manage the project's other tickets through the coordinator API.
// Started by claude from the coordinator's --mcp-config; configured by environment.
import { createInterface } from 'node:readline';

const API = process.env.COORDINATOR_API ?? 'http://127.0.0.1:8573';
const TOKEN = process.env.COORDINATOR_TOKEN ?? '';
const PROJECT = Number(process.env.COORDINATOR_PROJECT);
const MAX_TEXT = 4000;

const PERMISSION_MODE = {
  type: 'string',
  enum: ['bypassPermissions', 'acceptEdits', 'plan'],
  description:
    'bypassPermissions (default): full access, can run any command. acceptEdits: edit files but shell commands are refused. plan: read and plan only.',
};
const TICKET_ID = { type: 'integer', description: 'Ticket number in this project, e.g. 12 for #12 (as shown by list_tickets)' };

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
        title: { type: 'string', description: 'Short title (max 120 chars); also used for the branch name' },
        message: { type: 'string', description: 'First message to the new ticket' },
        permission_mode: PERMISSION_MODE,
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
    description: "Rename a ticket. (The branch keeps its original name.)",
    inputSchema: {
      type: 'object',
      properties: { ticket_id: TICKET_ID, title: { type: 'string' } },
      required: ['ticket_id', 'title'],
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
    `status: ${t.status}${t.queued ? ` (${t.queued} queued)` : ''}`,
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

async function runTool(name: string, args: any): Promise<string> {
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
        message: args.message,
        permissionMode: args.permission_mode,
      });
      return `Created ${ticketLine(t)}`;
    }
    case 'message_ticket':
      return `Sent. ${ticketLine(await call('POST', `/api/tickets/${await id(args)}/messages`, { text: args.text }))}`;
    case 'update_ticket':
      return `Updated. ${ticketLine(await call('PATCH', `/api/tickets/${await id(args)}`, { title: args.title }))}`;
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
      reply({ id: rid, result: { tools: TOOLS } });
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
