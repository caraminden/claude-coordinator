// MCP server (stdio, newline-delimited JSON-RPC) that gives a project's coordinator
// ticket tools to manage the project's other tickets through the coordinator API.
// Started by claude from the coordinator's --mcp-config; configured by environment.
import { createInterface } from 'node:readline';
import { APP_NAME } from './appname.ts';

const API = process.env.COORDINATOR_API ?? 'http://127.0.0.1:8573';
const TOKEN = process.env.COORDINATOR_TOKEN ?? '';
const PROJECT = Number(process.env.COORDINATOR_PROJECT);
// 'coordinator' manages the project's tickets; 'thread' lets a ticket label itself.
const ROLE = process.env.COORDINATOR_ROLE === 'thread' ? 'thread' : 'coordinator';
const TICKET = Number(process.env.COORDINATOR_TICKET);
// Set for threads in projects with approval rules: Claude Code asks the approve tool before those calls.
const APPROVALS = process.env.COORDINATOR_APPROVALS === '1';
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
    'Where the turn leaves things, for the minions list: ready (done; ready to merge or pick up), try (ready for people to try out), parked (on hold on purpose), blocked (stuck on something outside the minion, not a person\'s answer), outside (work still running somewhere this minion cannot wait on, like CI). null when it is simply people\'s turn to answer, which the list shows by itself. Cleared automatically when the next turn starts.',
};
const NOTE = { type: ['string', 'null'], description: 'One terse line on where things stand, max 60 chars, e.g. "needs a pick: tabs or a list" or "merged, live after restart". No names or prefixes.' };

const BUILD = {
  type: ['integer', 'null'],
  description: 'The major build this work is assigned to, e.g. 8 for Build 8; the minions list groups the build\'s minions together. null takes it out of a build.',
};

const PROPERTIES = {
  type: 'object',
  description:
    'Properties as { key: value }, e.g. { "type": "feature", "area": ["town", "ui"], "build": 8 }. Keys and values come from list_properties; aliases resolve to their value, and null clears a key. Unknown keys and values are refused with a "did you mean".',
  additionalProperties: true,
};

const LIST_PROPERTIES = {
  name: 'list_properties',
  description: "The property registry for this scheme: the global keys (type, stage, requestedBy) and this scheme's own, with their values and aliases. Read it before setting or proposing properties.",
  inputSchema: { type: 'object', properties: {} },
};

const VALUES = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      value: { type: 'string', description: 'Canonical value: lowercase kebab-case, or a proper name with its capitals' },
      label: { type: 'string' },
      description: { type: 'string' },
      aliases: { type: 'array', items: { type: 'string' }, description: 'Other spellings that resolve to this value' },
    },
    required: ['value'],
  },
};

const FORCE = { type: 'boolean', description: 'Register even though it looks like a near-duplicate of something that exists (only once you have checked it really is different)' };

const TICKET_ID = { type: 'integer', description: 'Minion number in this scheme, e.g. 12 for #12 (as shown by list_tickets)' };

const ASK_QUESTION = {
  name: 'ask_question',
  description:
    'Ask people in this chat 1 to 4 multiple-choice questions, shown as a card they answer with a click (they can also type their own answer). Use it for real decisions with clear options, instead of listing choices in prose. Put your recommended option first. For visual choices (art, UI, layouts, animations), make each take as an image, GIF or short video first and give each option its `image`: the card then shows them as a gallery to pick from. After calling it, finish your turn with a short reply and wait: the answers arrive as the next message.',
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
                  image: {
                    type: 'string',
                    description:
                      'Optional picture of this option: path to an image, GIF or video (png, jpg, gif, webp, avif, svg, mp4, webm, mov) you made in your working directory or shared folder, absolute or relative to your working directory. Shown as a thumbnail people can open full size.',
                  },
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
    description: 'List the minions in this scheme with their status and latest activity.',
    inputSchema: {
      type: 'object',
      properties: { include_closed: { type: 'boolean', description: 'Include dismissed minions (default false)' } },
    },
  },
  {
    name: 'read_ticket',
    description: "Read a minion's details and the most recent messages in its conversation.",
    inputSchema: {
      type: 'object',
      properties: { ticket_id: TICKET_ID, last: { type: 'integer', description: 'How many recent entries to return (default 10, max 50)' } },
      required: ['ticket_id'],
    },
  },
  {
    name: 'create_ticket',
    description:
      'Start a new minion: a separate Claude Code session in its own git worktree and branch. The message is its first instruction, so make it self-contained.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { ...TITLE, description: `${TITLE.description} Also used for the branch name.` },
        tag: TAG,
        properties: { ...PROPERTIES, description: `${PROPERTIES.description} Must include type; if no type fits, use "other" and ask people where it belongs.` },
        message: { type: 'string', description: 'First message to the new minion' },
      },
      required: ['title', 'properties', 'message'],
    },
  },
  {
    name: 'message_ticket',
    description: 'Send a message to a minion. It runs now, or after the current turn if the minion is busy. Reopens it if dismissed.',
    inputSchema: {
      type: 'object',
      properties: { ticket_id: TICKET_ID, text: { type: 'string' } },
      required: ['ticket_id', 'text'],
    },
  },
  {
    name: 'update_ticket',
    description: "Change a minion's title, tag, state, note or build group (the major build it is assigned to); leave out what should stay. (The branch keeps its original name.)",
    inputSchema: {
      type: 'object',
      properties: { ticket_id: TICKET_ID, title: TITLE, tag: TAG, state: STATE, note: NOTE, build: BUILD },
      required: ['ticket_id'],
    },
  },
  {
    name: 'close_ticket',
    description: 'Dismiss a finished or abandoned minion. Its worktree and branch are kept. A running minion must be stopped first.',
    inputSchema: { type: 'object', properties: { ticket_id: TICKET_ID }, required: ['ticket_id'] },
  },
  {
    name: 'reopen_ticket',
    description: 'Reopen a dismissed minion.',
    inputSchema: { type: 'object', properties: { ticket_id: TICKET_ID }, required: ['ticket_id'] },
  },
  {
    name: 'stop_ticket',
    description: "Interrupt a minion's running turn and drop its queued messages.",
    inputSchema: { type: 'object', properties: { ticket_id: TICKET_ID }, required: ['ticket_id'] },
  },
  ASK_QUESTION,
  LIST_PROPERTIES,
  {
    name: 'set_properties',
    description: "Set a minion's properties, or (with file) those of a file it showed people. Only the keys you pass change.",
    inputSchema: {
      type: 'object',
      properties: {
        ticket_id: TICKET_ID,
        file: { type: 'string', description: "Optional: a file the minion linked (an artifact), as a path in its working directory or an absolute path" },
        properties: PROPERTIES,
      },
      required: ['ticket_id', 'properties'],
    },
  },
  {
    name: 'register_property_values',
    description:
      "Add values to one of this scheme's enum keys (or, from the Citadel scheme only, a global key), or add aliases to values it has. New values are live at once but marked unreviewed: say in your reply which you added, so people can approve or correct them. Near-duplicates come back as a warning and nothing is added.",
    inputSchema: { type: 'object', properties: { key: { type: 'string' }, values: VALUES, force: FORCE }, required: ['key', 'values'] },
  },
  {
    name: 'register_property_key',
    description:
      "Propose a new key for this scheme (or, from the Citadel scheme only, a global key with global: true). New keys wait for a person to approve them in Settings → Properties, so ask people first. Keys are camelCase.",
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'camelCase, e.g. playerClass' },
        label: { type: 'string' },
        description: { type: 'string', description: 'What it means and when to set it' },
        multi: { type: 'boolean', description: 'Whether it holds a list of values' },
        value_kind: { type: 'string', enum: ['enum', 'integer', 'user', 'text'], description: 'enum (a fixed list of values, the default), integer, user (a login name) or text' },
        values: VALUES,
        global: { type: 'boolean', description: 'A key for every scheme (Citadel scheme only)' },
        force: FORCE,
      },
      required: ['key', 'description'],
    },
  },
  {
    name: 'review_property',
    description:
      "Settle a value: approve a minion's proposed value, reject it, archive a value no longer used (what has it keeps it), restore one, or merge a value into another (it becomes an alias and everything carrying it moves over). Keys, and approving your own unreviewed values, need a person.",
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        value: { type: 'string' },
        action: { type: 'string', enum: ['approve', 'reject', 'archive', 'restore', 'merge'] },
        into: { type: 'string', description: 'For merge: the value it becomes an alias of' },
      },
      required: ['key', 'value', 'action'],
    },
  },
  {
    name: 'get_project_instructions',
    description: "Read the scheme instructions: the standing rules people set for this scheme, which every minion and you receive in the system prompt.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'set_project_instructions',
    description:
      'Replace the scheme instructions with new text (max 16,000 characters; empty clears them). They reach every minion, and you, from its next turn. Read the current text first and send the whole new version, not just the change.',
    inputSchema: { type: 'object', properties: { instructions: { type: 'string' } }, required: ['instructions'] },
  },
  {
    name: 'get_project_settings',
    description:
      "Read the scheme's approval rules (Claude Code permission rules a minion must get a person's OK for, via an Approve / Deny card in its chat) and plugin folders (folders in the repo every minion loads as Claude Code plugins).",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'set_project_settings',
    description:
      'Replace the approval rules and/or plugin folders; leave out what should stay, and send the whole new list, not just the change (an empty list clears it). They apply from each minion\'s next turn. Only change them when people ask.',
    inputSchema: {
      type: 'object',
      properties: {
        approval_rules: {
          type: 'array',
          items: { type: 'string' },
          description: 'Claude Code permission rules, e.g. "Bash(gh pr merge:*)" or "mcp__*__merge_pull_request". Matching tool calls wait for a person to approve them.',
        },
        plugin_folders: {
          type: 'array',
          items: { type: 'string' },
          description: 'Folder paths relative to the repo root, e.g. "tools/mods/delve". Each is loaded with --plugin-dir when it exists in a minion\'s worktree.',
        },
      },
    },
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

/** Properties as people read them: always `key: value`, since one word can be a value of two keys. */
function propertyText(props: Record<string, unknown> | undefined): string {
  return Object.entries(props ?? {}).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join('; ');
}

function registryText(keys: any[]): string {
  const kind = (k: any) => (k.value_kind === 'integer' ? 'a whole number' : k.value_kind === 'user' ? "a person's login name" : k.value_kind === 'text' ? 'free text' : k.multi ? 'one or more of' : 'one of');
  const line = (k: any) => {
    const shown = k.values.filter((v: any) => v.status !== 'archived');
    const values = shown.map((v: any) => `${v.value}${v.aliases.length ? ` (${v.aliases.join(', ')})` : ''}${v.status === 'proposed' ? ' [proposed]' : !v.reviewed ? ' [new, unreviewed]' : ''}`);
    return `- ${k.key}${k.status === 'proposed' ? ' [proposed key, not usable yet]' : ''}: ${kind(k)}${values.length ? ` ${values.join(', ')}` : ''}${k.description ? `\n  ${k.description.replace(/\n+/g, ' ')}` : ''}`;
  };
  const live = keys.filter((k) => k.status !== 'archived');
  const global = live.filter((k) => k.scope === 'global').map(line);
  const own = live.filter((k) => k.scope === 'scheme').map(line);
  return `Global keys (every scheme):\n${global.join('\n')}\n\nThis scheme's keys:\n${own.length ? own.join('\n') : '(none yet)'}\n\nAliases (in brackets) resolve to their value. Show properties as key: value.`;
}

/** A registry call's answer: what happened, plus any warnings or follow-ups for the caller. */
function registryReply(r: any, done: string): string {
  if (r.warnings?.length) return `Nothing changed; it looks like a near-duplicate:\n${r.warnings.map((w: string) => `- ${w}`).join('\n')}`;
  return [done, ...(r.notes ?? [])].join('\n');
}

function ticketLine(t: any): string {
  return [
    `#${t.number} ${t.title}`,
    t.tag ? `tag: ${t.tag}` : '',
    t.properties && Object.keys(t.properties).length ? propertyText(t.properties) : '',
    t.build ? `build: ${t.build}` : '',
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
    if (ev.kind === 'user_message') out.push(`[${data.author}${data.comment ? ` on ${data.comment.about}` : ''}]: ${clip(data.text)}`);
    else if (ev.kind === 'note') out.push(`(note) ${data.text}`);
    else if (ev.kind === 'error') out.push(`(error) ${clip(data.text)}`);
    else if (ev.kind === 'approval') out.push(`(asked for approval) ${data.tool}: ${clip(JSON.stringify(data.input))}`);
    else if (ev.kind === 'approval_result') out.push(data.state === 'expired' ? '(approval expired)' : `(${data.state} by ${data.by})`);
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
  if (!Number.isInteger(n) || n <= 0) throw new Error('ticket_id must be a minion number');
  const { tickets } = await call('GET', `/api/projects/${PROJECT}`);
  const ticket = tickets.find((t: any) => t.number === n);
  if (!ticket) throw new Error(`There is no minion #${n} in this scheme`);
  return ticket.id;
}

/** The label fields a call sets; ones left out stay as they are. */
function labelFields(args: any) {
  const out: Record<string, unknown> = {};
  for (const k of ['title', 'tag', 'state', 'note', 'build']) if (args[k] !== undefined) out[k] = args[k];
  return out;
}

const THREAD_TOOLS = [
  {
    name: 'set_thread_status',
    description:
      "Label this minion for the scheme's minions list: its short title, kind of work, and where things stand. Leave out what should stay. Call it when the work's kind becomes clear, and at the end of a turn whenever the state or note changes.",
    inputSchema: { type: 'object', properties: { title: TITLE, tag: TAG, state: STATE, note: NOTE, build: BUILD } },
  },
  ASK_QUESTION,
  LIST_PROPERTIES,
  {
    name: 'set_properties',
    description: "Set this minion's properties (type, stage, and this scheme's keys), or with file those of a file you showed people. Only the keys you pass change.",
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Optional: a file you linked in a reply, as a path in your working directory or an absolute path' },
        properties: PROPERTIES,
      },
      required: ['properties'],
    },
  },
  {
    name: 'propose_property',
    description:
      "Propose a new value for one of this scheme's keys, or (without value) a new key. It waits as proposed until the Taskmaster or a person approves it, and the Taskmaster is told. Only when nothing in list_properties fits: never a near-duplicate of an existing value.",
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'The key; for a new key, its camelCase name' },
        value: { type: 'string', description: 'The new value (kebab-case, or a proper name). Leave out to propose a new key.' },
        aliases: { type: 'array', items: { type: 'string' } },
        reason: { type: 'string', description: 'Why nothing existing fits' },
        label: { type: 'string' },
        description: { type: 'string' },
        multi: { type: 'boolean', description: 'New key only: holds a list' },
        value_kind: { type: 'string', enum: ['enum', 'integer', 'user', 'text'], description: 'New key only' },
        values: { ...VALUES, description: 'New key only: its values' },
        force: FORCE,
      },
      required: ['key', 'reason'],
    },
  },
  {
    name: 'message_coordinator',
    description:
      "Send a message to this scheme's Taskmaster, waking it: for what only it can do, such as passing information to another minion (#N), starting a new minion from a handoff, or reporting something it should track. Not for acknowledgements or progress; people read your replies directly.",
    inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'What you need, self-contained: name minions as #N and give file paths in full' } }, required: ['text'] },
  },
  {
    name: 'close_self',
    description:
      "Dismiss this minion when the current turn ends, e.g. once a small fix is merged and shipped. It is dismissed only if the turn finishes cleanly and no new message arrived meanwhile; its worktree and branch are kept, and anyone can reopen it by sending a message. Call it near the end of your turn, after your summary is settled. Not for minions whose result is a report or doc for people to read: those stay open until someone has read it.",
    inputSchema: {
      type: 'object',
      properties: { reason: { type: 'string', description: 'Optional one-line summary shown in the minion with the dismissal, e.g. "Merged abc1234; live after the restart"' } },
    },
  },
];

// Claude Code's permission-prompt tool (--permission-prompt-tool): not one for Claude to call itself.
const APPROVE = {
  name: 'approve',
  description: 'Used by Claude Code itself to ask people in the chat to approve a tool call. Do not call it yourself.',
  inputSchema: {
    type: 'object',
    properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } },
    required: ['tool_name', 'input'],
  },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Post an Approve / Deny card for a tool call and wait, however long it takes, for a person to
 * click. Answers in the shape Claude Code expects from a permission-prompt tool. Anything other
 * than a person's Approve, including errors and expired cards, denies.
 */
async function approve(args: any): Promise<string> {
  let decision: any;
  try {
    const { id } = await call('POST', `/api/tickets/${TICKET}/approvals`, { tool_name: args.tool_name, input: args.input ?? {} });
    // Each request waits up to half a minute on the server; keep asking until the card is settled.
    for (let failures = 0; !decision || decision.state === 'pending';) {
      try {
        decision = await call('GET', `/api/tickets/${TICKET}/approvals?id=${encodeURIComponent(id)}`);
        failures = 0;
      } catch (err) {
        if (++failures >= 5) throw err;
        await sleep(2000);
      }
    }
  } catch (err: any) {
    decision = { state: 'expired', reason: `The approval card failed: ${err.message}` };
  }
  if (decision.state === 'allowed') return JSON.stringify({ behavior: 'allow', updatedInput: args.input ?? {} });
  const message = decision.state === 'denied'
    ? `${decision.by} denied this in the chat. It was not run. Do not retry it or work around it; say what you needed it for, and carry on with anything that does not need it.`
    : `Nobody approved this, so it was not run (${decision.reason ?? 'the card expired'}).`;
  return JSON.stringify({ behavior: 'deny', message });
}

async function runTool(name: string, args: any): Promise<string> {
  // Each role may only call its own tools.
  if (!toolList().some((t) => t.name === name)) throw new Error(`Unknown tool ${name}`);
  switch (name) {
    case 'list_tickets': {
      const { tickets } = await call('GET', `/api/projects/${PROJECT}`);
      const shown = tickets.filter((t: any) => args.include_closed || t.status !== 'closed');
      return shown.length ? shown.map(ticketLine).join('\n') : 'No minions.';
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
        properties: args.properties ?? {},
        message: args.message,
      });
      return [`Created ${ticketLine(t)}`, ...(t.notes ?? [])].join('\n');
    }
    case 'list_properties': {
      const { keys } = await call('GET', `/api/projects/${PROJECT}/properties`);
      return registryText(keys);
    }
    case 'set_properties': {
      const target = ROLE === 'thread' ? TICKET : await id(args);
      const r = await call('PUT', `/api/tickets/${target}/properties`, { properties: args.properties, file: args.file ?? null });
      return registryReply(r, `Set. ${propertyText(r.properties) || '(no properties)'}`);
    }
    case 'register_property_values': {
      const r = await call('POST', `/api/projects/${PROJECT}/properties/values`, { key: args.key, values: args.values, force: !!args.force });
      const parts = [r.added.length ? `Added ${r.added.map((v: string) => `${args.key}: ${v}`).join(', ')}` : '', r.updated.length ? `updated ${r.updated.join(', ')}` : ''].filter(Boolean).join('; ');
      return registryReply(r, `${parts || 'No change'}.${r.unreviewed ? ' These are live but unreviewed: tell people in your reply what you added, so they can approve or correct it.' : ''}`);
    }
    case 'register_property_key': {
      const r = await call('POST', `/api/projects/${PROJECT}/properties/keys`, args);
      return registryReply(r, r.status === 'active' ? `Registered ${args.key}.` : `Proposed ${args.key}; it waits for a person to approve it in Settings → Properties. Tell people in your reply.`);
    }
    case 'review_property': {
      const r = await call('POST', `/api/projects/${PROJECT}/properties/review`, args);
      return `Done: ${r.action} ${r.key}${r.value ? `: ${r.value}` : ''}.`;
    }
    case 'propose_property': {
      const r = await call('POST', `/api/projects/${PROJECT}/properties/proposals`, args);
      return registryReply(r, 'Proposed. The Taskmaster has been told; it stays unusable until approved.');
    }
    case 'get_project_instructions': {
      const { project } = await call('GET', `/api/projects/${PROJECT}`);
      if (!project.instructions) return 'This scheme has no instructions yet.';
      const by = project.instructions_updated_by ? ` (last changed by ${project.instructions_updated_by})` : '';
      return `Scheme instructions${by}:\n\n${project.instructions}`;
    }
    case 'get_project_settings': {
      const { project } = await call('GET', `/api/projects/${PROJECT}`);
      const show = (text: string) => (text ? text.split('\n').map((l) => `- ${l}`).join('\n') : '(none)');
      return `Approval rules (need a person's OK):\n${show(project.approval_rules)}\n\nPlugin folders:\n${show(project.plugin_dirs)}`;
    }
    case 'set_project_settings': {
      const body: Record<string, unknown> = {};
      if (args.approval_rules !== undefined) body.approval_rules = args.approval_rules;
      if (args.plugin_folders !== undefined) body.plugin_dirs = args.plugin_folders;
      if (!Object.keys(body).length) throw new Error('Pass approval_rules, plugin_folders or both');
      const project = await call('PATCH', `/api/projects/${PROJECT}`, body);
      const n = (text: string) => (text ? text.split('\n').length : 0);
      return `Saved: ${n(project.approval_rules)} approval rule(s), ${n(project.plugin_dirs)} plugin folder(s). They apply from each minion's next turn.`;
    }
    case 'approve':
      return approve(args);
    case 'set_project_instructions': {
      const project = await call('PATCH', `/api/projects/${PROJECT}`, { instructions: String(args.instructions ?? '') });
      return project.instructions ? `Saved (${project.instructions.length} characters).` : 'Cleared the scheme instructions.';
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
    case 'message_coordinator':
      await call('POST', `/api/tickets/${TICKET}/coordinator`, { text: args.text });
      return 'Sent. The Taskmaster runs it now, or after its current turn.';
    case 'close_self':
      try {
        await call('POST', `/api/tickets/${TICKET}/close`, { reason: args.reason ?? null });
      } catch (err: any) {
        // A server from before close_self refuses the route with its generic "only itself" error.
        if (/only update itself|Not found/.test(err.message)) {
          throw new Error(`The ${APP_NAME} server running now predates close_self, so it cannot dismiss minions yet; it will after its next restart. End your reply with "Done, ready to close" instead.`);
        }
        throw err;
      }
      return 'This minion will be dismissed when your turn ends (unless the turn fails or a new message arrives). Finish your reply now.';
    case 'close_ticket':
      return `Closed. ${ticketLine(await call('POST', `/api/tickets/${await id(args)}/status`, { status: 'closed' }))}`;
    case 'reopen_ticket':
      return `Reopened. ${ticketLine(await call('POST', `/api/tickets/${await id(args)}/status`, { status: 'idle' }))}`;
    case 'stop_ticket': {
      const { stopped } = await call('POST', `/api/tickets/${await id(args)}/stop`, {});
      return stopped ? 'Stopped.' : 'That minion was not running.';
    }
    default:
      throw new Error(`Unknown tool ${name}`);
  }
}

function toolList() {
  if (ROLE !== 'thread') return TOOLS;
  return APPROVALS ? [...THREAD_TOOLS, APPROVE] : THREAD_TOOLS;
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
      reply({ id: rid, result: { tools: toolList() } });
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
