// The MCP tools for minions and messages (create, read, message, close, claims, plan): definitions and handlers. mcp.ts keeps the tool lists and their order.
import { existsSync } from 'node:fs';
import { APP_NAME } from './appname.ts';
import { cardText, type CardLink } from './card-links.ts';
import { liveState } from './live-state.ts';
import { thrown } from './thrown.ts';
import { NEEDS, NEED_LINES, stateWord } from './needs.ts';
import { heldToolText } from './msg-settings.ts';
import { workerWaitText } from './worker-wait.ts';
import type { TicketView, StoredEvent, ClaimView, ErrorsDay, EventData } from './mcp-types.ts';
import { money } from './mcp-text.ts';
import { C, TICKET_ID, WHEN_CI_PASSES, call, propertyText, id, needOne, MODEL_IDS, ADVISOR_TRIAL, EFFORT_IDS, MODEL, EFFORT, PROPERTIES, NOT_HERE } from './mcp-call.ts';

const MAX_TEXT = 4000;
const NEED = { type: 'string', enum: [...NEEDS], description: `Required: what this message needs. ${NEEDS.map((n) => `${n}: ${NEED_LINES[n]}`).join('; ')}. A fyi is always held mail, whatever wake says.` };
/** What message_ticket, message_coordinator and message_minion say when the loop guard holds a message. */
const HELD = () => heldToolText(C().MSG, 'the minion and the Taskmaster');
const TITLE = { type: 'string', maxLength: 120, description: 'The short ask, about 30 characters (at most 120), e.g. "Usage bar in the top bar". No number, type, build or emoji.' };
/** A minion or ticket state; without `deploys`, pending-deploy is left out. */
const stateSchema = (deploys: boolean) => ({
  type: ['string', 'null'],
  enum: ['ready', 'complete', 'try', 'sealed', 'parked', 'blocked', 'outside', ...(deploys ? ['pending-deploy'] : []), null],
  description: `Where the turn leaves things, for the minions list: ready (a person has to act: ship, pick it up or answer), complete (no work left; it closes by itself once a member has seen it; needs a note in the same call saying what is left: "nothing left" or what to read), try (ready for people to try out), sealed (on hold on purpose), blocked (stuck on something outside the minion, not a person's answer), outside (work still running somewhere this minion cannot wait on, like CI)${deploys ? ', pending-deploy (deployed with tools/deploy.sh, waiting to go live, and nothing else left: a successful deploy dismisses the minion, so not while someone still needs you)' : ''}. null when it is simply people's turn to answer, which the list shows by itself. Cleared automatically when the next turn starts${deploys ? ', except pending-deploy, which stays until you set another state' : ''}.`,
});
const STATE = stateSchema(true);
const NOTE = { type: ['string', 'null'], maxLength: 60, description: 'One terse line on where things stand, at most 60 characters, e.g. "needs a pick: tabs or a list" or "shipped, live after restart". No names or prefixes.' };

const REPLIES = {
  type: ['array', 'null'],
  items: { type: 'string', maxLength: 40 },
  maxItems: 3,
  description: 'Up to 3 one-tap replies, e.g. ["Ship it"], that send that text as the person\'s own message, for when the next step only needs their go (a choice between options is ask_question). They go away once anyone writes or the next turn starts; [] or null clears them.',
};

const BUILD = {
  type: ['integer', 'null'],
  description: "The major build this work is assigned to, e.g. 8 for Build 8; the minions list groups the build's minions together. null takes it out of a build.",
};
const PICK_REASON = { type: 'string', maxLength: 200, description: 'Why this model and effort for this job, in your own words, one line (at most 200 characters), e.g. "known-shape fix with a clear repro". It shows on the minion as "Picked because" and is kept with the model and effort.' };
// update_ticket can still put a minion back on Claude Code's default (Opus 5.5 at high) with null.
const MODEL_CHANGE = { type: ['string', 'null'], enum: [...MODEL_IDS, null], description: `The model for the minion's next turns, as in its composer; null for Claude Code's default (Opus 5.5 at high). ${ADVISOR_TRIAL}` };
const EFFORT_CHANGE = { type: ['string', 'null'], enum: [...EFFORT_IDS, null], description: "The effort for the minion's next turns, as in its composer; null for the scheme's default effort." };
// The activity gate and one-offs (#745).
/** The kit's standard audits, kit/schedules/<slug>.md (#799); test/schedule-templates.test.ts checks this matches the folder. */
/**
 * close_self's answer. The call is checked against the state now, but the reply's own status line is applied after
 * it: a final state of complete, try or ready cancels the close (#809), so the answer says that before the minion writes it.
 */
export function closeSelfResult(cleared: boolean): string {
  return (
    `${cleared ? 'Dismissed (state ready cleared): do not set state ready again this turn, since that keeps it open. ' : ''}This minion will be dismissed when your turn ends, unless the turn doesn't finish cleanly or a new message arrives first (a GitHub notice that needs no action doesn't count); its worktree and branch are kept, and a message reopens it. ` +
    "Your final reply's status line counts too: a state of complete, try or ready there (or a card posted after this call) cancels the close, so end it with state null. " +
    'Leave the close out of your reply, since the server shows the dismissal and a new message can still skip it. If you do stay open, say plainly why ("Staying open in state ready for you to do X"; a complete minion closes by itself once a member has seen it). Finish your reply now.'
  );
}
const WORKFLOW = {
  type: ['boolean', 'null'],
  description: "true lets the minion's turns call Claude Code's Workflow tool (about 2k tokens on every call). Set it at creation: changing it later breaks the prompt cache once.",
};

const PLUGIN_FOLDERS = {
  type: ['array', 'null'],
  items: { type: 'string' },
  description: 'Extra optional plugin folders from get_project_settings (e.g. DevTools for UI work); each costs tokens every turn. Set at creation: changing it later breaks the prompt cache once. [] or null clears.',
};

export const LIST_TICKETS = {
  name: 'list_tickets',
  description: "List the minions in this scheme with their status and latest activity, and the link to each card waiting on people (link a card wherever you mention it). When the scheme's contraptions had errors yesterday, a first line counts them and names the digest file.",
  inputSchema: {
    type: 'object',
    properties: { include_closed: { type: 'boolean', description: 'Include dismissed minions (default false)' } },
  },
};

/** live_facts (#1113): a minion's live facts in one small read, for both roles; the Citadel scheme's Taskmaster also reads other schemes'. */
export const LIVE_FACTS = {
  name: 'live_facts',
  description:
    "A minion's live facts, read now in one small call: its status and state, the cards waiting on people (with links), what it is sealed on, what it waits on right now, its branch and head commit, where its change is (on its branch, on main, deploying, live, a failed deploy), its PR and its newest CI run with the result. Call it before you state any of these about a minion (whether it has shipped or is live, its CI result, that its card waits on a person), rather than answering from memory or an earlier reply.",
  inputSchema: { type: 'object', properties: { ticket_id: TICKET_ID }, required: ['ticket_id'] },
};

export const READ_TICKET = {
  name: 'read_ticket',
  description:
    "Read a minion's details, its worktree, the link to each of its cards waiting on people (link a card wherever you mention it) and the most recent messages in its conversation. With live: true, read what its turn is doing now instead: the tool call it waits on and for how long, or that it waits on the model, a person's card, the usage limit or the ship line, its queued messages, and its last few tool calls with their output trimmed. Use it to tell a hung minion from a busy one; its session transcript isn't readable from here.",
  inputSchema: {
    type: 'object',
    properties: {
      ticket_id: TICKET_ID,
      last: { type: 'integer', description: 'How many recent entries to return (default 10, max 50)' },
      live: { type: 'boolean', description: "Show what the minion's turn is doing right now instead of its conversation" },
    },
    required: ['ticket_id'],
  },
};

export const CREATE_TICKET = {
  name: 'create_ticket',
  description:
    'Start a new minion: a separate Claude Code session in its own git worktree and branch. The message is its first instruction, so make it self-contained: write it with citadel:briefing. The result warns when it has no quoted words from a person, no "Done when", no "Already shipped on this" or no "Leave alone".',
  inputSchema: {
    type: 'object',
    properties: {
      title: { ...TITLE, description: `${TITLE.description} Also used for the branch name.` },
      properties: { ...PROPERTIES, description: `${PROPERTIES.description} Must include type; if no type fits, use "other" and ask people where it belongs.` },
      message: { type: 'string', maxLength: 100000, description: 'First message to the new minion, at most 100,000 characters' },
      start_after: {
        type: 'integer',
        description:
          'A minion number (#N) to chain after: this one is created sealed with its message held (messages to it too, read with its brief), and starts by itself on a branch caught up to main once #N is live (or shipped, see start_when). If #N is dismissed without shipping it stays sealed and you are told; message_ticket with unseal starts it early.',
      },
      start_when: {
        type: 'string',
        enum: ['live', 'merged'],
        description: 'With start_after: "live" (default) waits until the server runs #N\'s work; "merged" starts once it has shipped to main (for a minion in a build with a branch, once it is merged into build/<n>), for work with nothing to deploy. In a scheme whose code this server doesn\'t run, live means shipped.',
      },
      parent: {
        type: ['integer', 'null'],
        description: 'The #N this minion is started for: it shows as from #N and inherits its build unless build is given. Default: the minion whose message you are answering; null for none.',
      },
      build: { ...BUILD, description: `${BUILD.description} Left out, it is the parent's build, else the start_after minion's, if any. A build whose branch build/<n> exists sets its base and target: the minion starts from build/<n> and merges into it, never main.` },
      cabal: { type: ['integer', 'string'], description: 'The #N of the minion that leads this one\'s cabal: puts it on that lead\'s board (a roster row with the same title becomes its row). A lead in another scheme is "<scheme>#N", as its ask says: it takes the row its people approved for this scheme, by title.' },
      build_owner: { type: 'boolean', description: 'true for the build minion of a new build: it makes build/<n>, keeps the list of what is in, takes main in daily and ships the build with one go card. Needs build.' },
      model: MODEL,
      effort: EFFORT,
      reason: PICK_REASON,
      workflow: WORKFLOW,
      plugin_folders: PLUGIN_FOLDERS,
      expected_cost: {
        type: 'number',
        description:
          'What the brief expects this minion to cost, in dollars (its "Expected cost: ~$N" line, citadel:briefing part 8; left out, that line is read). Its budget alarms count from the larger of this and the usual cost; over $50 no turn runs until a person answers its start card (Start, or Split first): it isn\'t sealed but shows as waiting on a person, and messages to it are held until it starts.',
      },
      not_duplicate: { type: 'boolean', description: 'true when create_ticket refused because open minions looked like the same work, or one open or closed in the last 3 days started from the same handoff file, and you checked it is not the same work' },
    },
    // properties is asked for but not required, so a client holding an older schema isn't refused before the fallback below.
    required: ['title', 'message', 'model', 'effort'],
  },
};

export const MESSAGE_TICKET = () => ({
  name: 'message_ticket',
  description:
    'Send a message to a minion. It runs now, or after the current turn if the minion is busy. Reopens it if dismissed. A sealed minion (state sealed, or chained on start_after) holds it unread until it is unsealed or woken, unless you pass `unpark`. After ' +
    C().MSG.loopLimit +
    ' messages either way with one minion in ' +
    C().MSG.loopMin +
    ' minutes, the next is held until a person continues. Waking an idle minion reloads its whole context: send news it need not act on now with your next message to it instead.',
  inputSchema: {
    type: 'object',
    properties: {
      ticket_id: TICKET_ID,
      text: { type: 'string', maxLength: 10000, description: 'The message, at most 10,000 characters (`message` is accepted too)' },
      unpark: { type: 'boolean', description: 'For a sealed minion: true unseals it and this message wakes it, with everything held for it (a minion chained on start_after starts now, its brief first). Only when people want it running now; without it the message waits for its unseal or wake.' },
      start_now: { type: 'boolean', description: 'Old name for `unpark`.' },
    },
    required: ['ticket_id', 'text'],
  },
});

export const MESSAGE_TASKMASTER = () => ({
  name: 'message_taskmaster',
  description:
    'Send a message to another scheme\'s Taskmaster: for work that touches both schemes, such as asking it to start or brief a minion there, or answering it. An ask (any need but fyi) comes as a form: saw (what you saw, with the error or link), checked (what you checked on your own side first: "nothing" is refused), wanted and by (by when); it is laid out the same way every time. A fyi or an answer stays free text. By default it wakes that Taskmaster, which reloads its whole context: do that only when it has to act now. News, FYIs and answers that need nothing now ("#388 is live", "the rule changed") go with need: fyi, which is always held mail: it shows in its chat at once and reaches it on its next turn, whoever wakes it. You reach the schemes the person you work for is in, and always the Citadel scheme\'s Taskmaster, for Citadel bug reports and feature asks. It acts in its own scheme; you cannot reach its minions. Its messages to you arrive as "[Taskmaster of <scheme>]: ...". Not for acknowledgements. After ' +
    C().MSG.loopLimit +
    ' messages either way between you in ' +
    C().MSG.loopMin +
    ' minutes, the next is held until a person continues.',
  inputSchema: {
    type: 'object',
    properties: {
      scheme: { type: 'string', description: 'The other scheme, by name or id; a wrong one lists them' },
      person: {
        type: 'string',
        description:
          "For a scheme with a Taskmaster per person: whose to reach (a member's name); one with none of their own, or none named, reaches its Overlord. With your own scheme and a person, it reaches that member's Taskmaster there, as held mail they read on their next turn (it never starts a turn); without a person, your own scheme says to use message_ticket. Leave it out to answer: a reply goes back to the one that wrote to you",
      },
      text: {
        type: 'string',
        maxLength: 10000,
        description: "For a fyi: the message, self-contained (it cannot see your scheme, so say which scheme's minion #N is). For an ask: optional extra context after the four fields. Short: anything longer than a paragraph goes in file. At most 10,000 characters (`message` is accepted too)",
      },
      saw: { type: 'string', description: 'An ask (any need but fyi) requires it: what you saw, with the error text or a link' },
      checked: { type: 'string', description: 'An ask requires it: what you checked on your own side first (your logs, your code, a repro). "nothing" is refused, so look first: many asks to another scheme turned out to be the sender\'s own bug' },
      wanted: { type: 'string', description: 'An ask requires it: what you need that Taskmaster to do' },
      by: { type: 'string', description: 'An ask requires it: by when ("today", "before #N ships", "no rush")' },
      need: NEED,
      wake: { type: 'boolean', description: 'false: held mail, read on its next turn, for news that needs no action now. Default true: it runs now, or after its current turn. A need of fyi is always held mail' },
      file: { type: 'string', description: "A file in your scheme's shared folder (absolute, or relative to that folder), at most 2 MB. Copied into the other scheme's shared folder under inbox/, where its Taskmaster and minions can read it; the message tells it the path" },
    },
    required: ['scheme', 'need'],
  },
});

export const UPDATE_TICKET = {
  name: 'update_ticket',
  description:
    "Change a minion's title, state, note, build group (the major build it is assigned to), model, effort, Workflow switch or extra plugin folders, or take it off its start_after chain (start_after: null: it stays sealed); leave out what should stay. A new model, effort, switch or folder applies from its next turn. State null on a sealed minion unseals it: a turn starts that reads what was held for it (a chained one starts now). (The branch keeps its original name.)",
  inputSchema: {
    type: 'object',
    properties: {
      ticket_id: TICKET_ID,
      title: TITLE,
      state: STATE,
      note: NOTE,
      build: { ...BUILD, description: `${BUILD.description} A build whose branch build/<n> exists sets its base and target from the minion's next turn: its prompt tells it to rebase onto build/<n> itself and merge into it, never main.` },
      model: MODEL_CHANGE,
      effort: EFFORT_CHANGE,
      reason: PICK_REASON,
      workflow: WORKFLOW,
      plugin_folders: PLUGIN_FOLDERS,
      cabal: { type: ['integer', 'string', 'null'], description: 'The #N of the lead whose cabal board it goes on ("<scheme>#N" for a lead in another scheme); null takes it off its board.' },
      start_after: { type: 'null', description: 'Only null: takes a sealed minion off its start_after chain but keeps it sealed. Its brief stays held as mail, it no longer starts when its leader ships, and it starts only when someone unseals it or you message it with unpark.' },
    },
    required: ['ticket_id'],
  },
};

export const FRESH_SESSION = {
  name: 'fresh_session',
  description: `Hand off to a fresh Claude session of yours: when this turn ends, your context resets and your next turn starts from \`summary\` (plus your system prompt and memory) instead of this whole conversation. People's chat history stays as it is. Use it when ${APP_NAME} asks for a handoff, or on your own when your context is long and mostly stale. First save to your memory files anything durable that lives only in this chat. Then pass every open ask and who made it, relays you still owe, cards waiting on people, who is sealed on what, and what you promised next: facts, not history.`,
  inputSchema: { type: 'object', properties: { summary: { type: 'string', maxLength: 20000, description: 'The handoff your next session starts from, at most 20,000 characters' } }, required: ['summary'] },
};

export const CLAIM = {
  name: 'claim',
  description:
    'Take a single-holder duty for a minion, e.g. the pipeline lane (`pipeline-lane`): a row every Taskmaster in the scheme sees, not a note in memory. Refused while another holds it (the answer names the holder). `queue` sets who waits for it, in order, held by anyone: when what its holder shipped is live, or the holder is dismissed, or it is released, it passes to the first in line, who gets one chat line saying so (a minion still waiting on its start_after leader starts when its chain does), and with nobody in line it is free. A queue alone on a free claim gives it to the first in line. Without `minion` or `queue` you hold it yourself.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Lowercase words joined by hyphens, e.g. pipeline-lane' },
      minion: { type: 'integer', description: 'The minion that holds it (#N as a number); leave out to hold it yourself' },
      note: { type: 'string', maxLength: 300, description: 'Optional: what it is held for' },
      keep: { type: 'boolean', description: 'true with minion (its holder): it stays with that minion through its next live, once, for a second piece that ships right after; false takes that back' },
      queue: { type: 'array', items: { type: 'integer' }, maxItems: 50, description: 'Optional: the whole waiting line, first in line first (#N as numbers); it replaces the line list_claims shows, [] empties it' },
    },
    required: ['name'],
  },
};

export const RELEASE = {
  name: 'release',
  description: "Free a claim, whoever holds it, e.g. a fix for broken shipping must jump the lane: it passes to the first in its queue, or is free. Take a minion out of the line with claim's `queue`.",
  inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'The claim, e.g. pipeline-lane' } }, required: ['name'] },
};

export const LIST_CLAIMS = {
  name: 'list_claims',
  description: "List the scheme's claims: each duty, its holder and since when, and its queue in order. list_tickets shows them too.",
  inputSchema: { type: 'object', properties: {} },
};

/** Why a minion closes (`closedAs`, src/property-seed.ts; Josh, 2026-11-25, "Save one word"). */
const CLOSED_AS = { type: 'string', enum: ['done', 'replaced', 'dropped'], description: 'replaced: minion `into` has the work; dropped: nobody does' };
const CLOSED_INTO = { type: 'integer' };
const joinedLine = (into: unknown, joined?: string) => (joined ? ` #${into} joins the effort "${joined}" as this closes.` : '');

export const CLOSE_TICKET = {
  name: 'close_ticket',
  description: 'Dismiss a finished or abandoned minion. Its worktree and branch are kept. A running minion must be stopped first.',
  inputSchema: { type: 'object', properties: { ticket_id: TICKET_ID, as: CLOSED_AS, into: CLOSED_INTO }, required: ['ticket_id', 'as'] },
};

export const REOPEN_TICKET = {
  name: 'reopen_ticket',
  description: 'Reopen a dismissed minion.',
  inputSchema: { type: 'object', properties: { ticket_id: TICKET_ID }, required: ['ticket_id'] },
};

export const STOP_TICKET = {
  name: 'stop_ticket',
  description: "Interrupt a minion's running turn and drop its queued messages. A ship it has running stops too (it leaves the line and main stays as it was), unless it is already deploying; the result says which.",
  inputSchema: { type: 'object', properties: { ticket_id: TICKET_ID }, required: ['ticket_id'] },
};

/** create_ticket's duplicate check (#488): open minions the server marks as twins of the new one's title and brief (src/memory.ts TWIN_SCORE). A search that fails checks nothing. */
async function openTwins(title: string, message: string): Promise<{ number: number; title: string; status: string; score: number; owner: string | null }[]> {
  const q = new URLSearchParams({ q: `${title}\n${message}`.slice(0, 1000), scope: 'minions', limit: '3' });
  // One try, not call()'s two minutes of retries: a down embedding service mustn't hold up a new minion.
  const res = await fetch(`${C().API}/api/projects/${C().PROJECT}/memory?${q}`, { headers: { Authorization: `Bearer ${C().TOKEN}` }, signal: AbortSignal.timeout(30_000) }).catch(() => null);
  if (!res?.ok) return [];
  const { hits } = (await res.json().catch(() => ({}))) as { hits?: { twin?: boolean; number: number; title: string; status: string; score: number; owner: string | null }[] };
  return (hits ?? []).filter((h) => h.twin);
}

function clip(s: string): string {
  return s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)} … [${s.length - MAX_TEXT} more chars]` : s;
}

function ticketLine(t: TicketView): string {
  return [
    `#${t.number} ${t.title}`,
    t.properties && Object.keys(t.properties).length ? propertyText(t.properties) : '',
    t.build ? `build: ${t.build}` : '',
    t.model ? `model: ${t.model}` : '',
    t.effort ? `effort: ${t.effort}` : '',
    t.workflow ? 'workflow: on' : '',
    t.plugin_dirs ? `plugins: ${t.plugin_dirs.split('\n').join(', ')}` : '',
    `status: ${t.worker_wait ? workerWaitText(t.worker_wait) : t.status}${t.server_work?.kind === 'job' ? ` (${t.server_work.text}; its end wakes it)` : ''}${t.state ? `, ${stateWord(t.state)}` : ''}${t.asleep ? `, asleep (${t.asleep.by} put it to sleep; any message wakes it)` : ''}${t.queued ? ` (${t.queued} queued)` : ''}${t.closing ? ' (closes after this turn)' : ''}`,
    t.note ? `note: ${t.note}` : '',
    t.branch ? `branch: ${t.branch}` : '',
    t.worktree ? `worktree: ${t.worktree}` : '',
    `by ${t.created_by}`,
    t.parent ? `from #${t.parent}` : '',
    t.last_activity ? `latest: ${t.last_activity}` : '',
    // read_minion and read_ticket (#1114): spend against what its kind of work usually costs.
    t.budget
      ? `budget: ${t.running_cost ? `about ${money((t.cost ?? 0) + t.running_cost)} so far, the running turn's estimate included,` : `${money(t.cost ?? 0)} used`} of about ${money(t.budget.usd)} (${t.budget.estimate ? "its brief's expected cost" : `usual for ${t.budget.basis}`}; asked to say why or split past ${money(t.budget.ask)}, Taskmaster told past ${money(t.budget.wake)} and at each doubling, owner carded past ${money(t.budget.card)})`
      : '',
    // Each waiting card with its link (#400), so a mention of it can link it.
    ...(t.open_cards ?? []).map((c: CardLink) => `waiting: ${cardText(c)}`),
  ]
    .filter(Boolean)
    .join(' | ');
}

/** Turn stored events into a readable transcript, skipping tool calls. */
function transcript(events: StoredEvent[]): string[] {
  const out: string[] = [];
  for (const ev of events) {
    const data: EventData = JSON.parse(ev.data);
    if (ev.kind === 'user_message') out.push(`[${data.author}${data.comment ? ` on ${data.comment.about}` : ''}]: ${clip(data.text!)}`);
    else if (ev.kind === 'note') out.push(`(note) ${data.text}`);
    else if (ev.kind === 'error') out.push(`(error) ${clip(data.text!)}`);
    else if (ev.kind === 'approval') out.push(`(asked for approval) ${data.tool}: ${clip(JSON.stringify(data.input))}`);
    else if (ev.kind === 'approval_result')
      out.push(data.state === 'expired' ? '(approval expired)' : data.via?.scheme ? `(allowed on ${data.by}'s go "${clip(data.via.text)}"${data.via.ticket == null ? ` in the Taskmaster chat${data.via.to != null ? `, for #${data.via.to}` : ''}` : ` in #${data.via.ticket}`})` : `(${data.state} by ${data.by})`);
    // A reply the link check sent back that its rewrite replaced (#281) shows only as the rewrite.
    else if (ev.kind === 'claude' && data.type === 'assistant' && !data.replaced) {
      const text = (data.message?.content ?? [])
        .filter((b) => b.type === 'text' && b.text!.trim())
        .map((b) => b.text!.trim())
        .join('\n');
      // A Grunt's report (a subagent's words) collapses to its first line, as it does in the chat. Not
      // public/grunts.js: this file runs as a pinned copy that only carries ./ imports (turn-launch.ts pinnedCopy).
      const first = () =>
        text
          .split('\n')
          .map((l) => l.replace(/^[\s#>*-]+/, '').trim())
          .find(Boolean);
      if (text && data.parent_tool_use_id) out.push(`(Grunt reported) ${clip(first() ?? '')}`);
      else if (text) out.push(`[Claude]: ${clip(text)}`);
    } else if (ev.kind === 'claude' && data.type === 'result') {
      out.push(data.is_error ? '(turn failed)' : '(turn finished)');
    }
  }
  return out;
}

/** The scheme list_tickets or read_ticket reads: this one, or for the Citadel scheme's Taskmaster another (#656). */
function schemeOf(args: Record<string, unknown>): number {
  if (args.scheme == null) return C().PROJECT;
  const n = Number(args.scheme);
  if (!C().APP_INSTRUCTIONS) throw new Error(`Only the ${APP_NAME} scheme's Taskmaster reads other schemes' minions: ask that scheme's Taskmaster with message_taskmaster`);
  if (!Number.isInteger(n) || n <= 0) throw new Error('scheme must be a scheme number, as your instructions list them');
  return n;
}
/** The first line of another scheme's minions, so its numbers aren't taken for this scheme's (the chat links a bare #N here). */
const otherScheme = (name: string) => `Scheme ${name}: these are its minions, not this scheme's; write each as "${name} #N".`;

/** The label fields a call sets; ones left out stay as they are. */
function labelFields(args: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const k of ['title', 'state', 'note', 'replies', 'build', 'start_after']) if (args[k] !== undefined) out[k] = args[k];
  return out;
}

/**
 * A minion's task list (#1275): the progress readout (public/progress.js) reads these calls, as it reads TaskCreate and
 * TaskUpdate. Claude Code can't preload a built-in tool, so the plan lives in an always-loaded MCP tool (ALWAYS_LOAD);
 * the readout keeps the state, so the call itself only checks its shape.
 */
export const PLAN = {
  name: 'plan',
  description:
    "Your task list, which people watch as the progress bar. The server moves the bar from what you do, by each step's kind. Each call changes only the steps it names by number n (1, 2, 3…): a new n adds a step, a known one updates it. Once every step is done, or in a later turn, naming step 1 with a title starts a new plan.",
  inputSchema: {
    type: 'object',
    properties: {
      steps: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          properties: {
            n: { type: 'integer', minimum: 1 },
            step: { type: 'string', description: 'Short title' },
            kind: { type: 'string', enum: ['read', 'build', 'test', 'review', 'ask', 'ship'], description: 'What it mostly is (two: the first); ask: a card or plan for people' },
            doing: { type: 'string', description: 'While underway, e.g. "Running tests"' },
            why: { type: 'string', description: 'One sentence: what it involves and why' },
            minutes: { type: 'number', description: 'Your estimate' },
            status: { type: 'string', enum: ['todo', 'doing', 'done', 'dropped'], description: 'Only to correct the bar' },
            outcome: { type: 'string', description: 'One sentence: what it found, decided or changed' },
          },
          required: ['n'],
        },
      },
    },
    required: ['steps'],
  },
};

/** What a plan call answers: it checks the shape and returns no state (the readout replays the calls). */
export function planResult(args: Record<string, unknown> | null): string {
  // public/progress.js planError's twin, since a pinned server can't import from public/ (#1043); test/mcp-always-load.test.ts holds them equal.
  const steps = args?.steps;
  if (!Array.isArray(steps) || !steps.length) throw new Error('steps is required: a list of { n, … }, one per step to add or change.');
  for (const s of steps) {
    if (!Number.isInteger(s?.n) || s.n < 1) throw new Error('Each step needs n, its number: 1, 2, 3…');
    const bad = ['step', 'doing', 'why', 'outcome'].find((k) => s[k] != null && typeof s[k] !== 'string');
    if (bad) throw new Error(`Step ${s.n}: ${bad} is text.`);
    if (s.minutes != null && !(Number.isFinite(s.minutes) && s.minutes >= 0)) throw new Error(`Step ${s.n}: minutes is a number.`);
    if (s.status != null && !['todo', 'doing', 'done', 'dropped'].includes(s.status)) throw new Error(`Step ${s.n}: status is todo, doing, done or dropped.`);
    if (s.kind != null && !['read', 'build', 'test', 'review', 'ask', 'ship'].includes(s.kind)) throw new Error(`Step ${s.n}: kind is read, build, test, review, ask or ship.`);
  }
  return 'ok';
}

export const SET_THREAD_STATUS = () => ({
  name: 'set_thread_status',
  description: "Label this minion for the scheme's minions list: its short title, build and where things stand (its kind of work is the `type` property: set_properties). Leave out what should stay. Call it once you know the short ask; the end of a turn's state and note go in your final reply's status line instead.",
  inputSchema: { type: 'object', properties: { title: TITLE, state: stateSchema(C().DEPLOYS), note: NOTE, replies: REPLIES, build: BUILD } },
});

export const MESSAGE_COORDINATOR = {
  name: 'message_coordinator',
  description:
    // Always loaded: the rest of its rules are in its results (fyi, held) and its need parameter (#1575).
    "Send a message to the Taskmaster of the person who owns this minion (assigned, else who asked for it; the scheme's one Taskmaster when it has one), waking it by default; others who touched this minion get it as held mail, and a minion with no owner reaches the Overlord: for what only it can do, such as starting, closing or reopening a minion, setting another minion's properties, or anything in another scheme.",
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', maxLength: 10000, description: 'What you need, self-contained: name minions as #N and give file paths in full. At most 10,000 characters (`message` is accepted too)' },
      need: NEED,
      wake: { type: 'boolean', description: 'false: held mail, read on its next turn, for news that needs no action now. Default true: it runs now, or after its current turn. A need of fyi is always held mail' },
      when_ci_passes: WHEN_CI_PASSES,
    },
    required: ['text', 'need'],
  },
};

export const MESSAGE_MINION = () => ({
  name: 'message_minion',
  description:
    'Send a message to another minion of this scheme (#N), to pass it information or ask it something, without going through the Taskmaster. It runs now, or after its current turn if it is busy. A sealed minion holds it until it is unsealed or woken, unless you pass `unpark`. Waking a minion reloads its whole context: news it need not act on now goes with wake: false. It shows in both chats, labelled with your number and title, and the Taskmaster gets a one-line copy that wakes nothing. A dismissed minion is refused, never reopened: starting, closing and reopening minions, setting their properties and anything in another scheme stay with the Taskmaster (message_coordinator). Not for acknowledgements. After ' +
    C().MSG.loopLimit +
    ' messages either way between two minions in ' +
    C().MSG.loopMin +
    ' minutes, the next is held until a person continues.',
  inputSchema: {
    type: 'object',
    properties: {
      ticket_id: TICKET_ID,
      text: { type: 'string', maxLength: 10000, description: 'Self-contained: it cannot see your chat, so give file paths in full. At most 10,000 characters (`message` is accepted too)' },
      wake: { type: 'boolean', description: 'false: held mail, read on its next turn, for news that needs no action now. Default true: it runs now, or after its current turn' },
      unpark: { type: 'boolean', description: "For a minion sealed waiting on you (your work, your word): true unseals it and this message wakes it now, so don't ask the Taskmaster. A chain a person put on hold is refused: only their Unseal or the Taskmaster starts it." },
    },
    required: ['ticket_id', 'text'],
  },
});

export const READ_MINION = {
  name: 'read_minion',
  description: 'Read another minion of this scheme: its line (title, state, note, branch, worktree) and the most recent messages and replies in its chat, without tool calls or cards. Read-only. For finding who owns a file or a piece of work before you message it (message_minion).',
  inputSchema: {
    type: 'object',
    properties: {
      ticket_id: TICKET_ID,
      last: { type: 'integer', description: 'How many recent entries to return (default 10, max 50)' },
    },
    required: ['ticket_id'],
  },
};

export const CLOSE_SELF = () => ({
  name: 'close_self',
  description:
    // Always loaded: the rest is in its result (closeSelfResult) and its refusal (keptOpen) (#1575).
    `Dismiss this minion when the turn ends, once its work has shipped and nothing needs deploying${C().DEPLOYS ? ' (after tools/deploy.sh, set state pending-deploy instead: the deploy dismisses it once live)' : ''}.`,
  inputSchema: {
    type: 'object',
    properties: { as: CLOSED_AS, into: CLOSED_INTO, reason: { type: 'string', maxLength: 500, description: 'One line shown with it' } },
    required: ['as'],
  },
});

/** The paths in the scheme's shared folder that the text names and that aren't there. A path in a sentence that asks for it to be written or created doesn't count. */
function missingShared(text: unknown): string[] {
  const shared = C().SHARED_DIR;
  if (!shared || typeof text !== 'string') return [];
  const paths = new RegExp(`${shared.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/[^\\s\`'"()<>\\[\\]]+`, 'g');
  const missing = new Set<string>();
  for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
    if (/\b(write|writes|writing|written|create|creates|creating|created)\b/i.test(sentence)) continue;
    for (const [match] of sentence.matchAll(paths)) {
      const path = match.replace(/[.,;:!?*_]+$/, '');
      if (!existsSync(path)) missing.add(path);
    }
  }
  return [...missing];
}

/**
 * A brief that sends a minion to a shared file that isn't there yet stops it on its first turn (#481):
 * refuse it. A chained create (start_after) only warns (#2129): a minion ahead of it may write the file.
 */
function sharedFilesExist(text: unknown, then: string): void {
  const [path] = missingShared(text);
  if (path) throw new Error(`${path} does not exist yet. ${then} once it is written, or drop the path. Nothing was sent.`);
}

/** "pipeline-lane: #580 Fix land.sh, taken by Josh since Nov 17, 10:14 PST (land retry)" (#921). */
function claimLine(c: ClaimView) {
  const chip = (q: NonNullable<ClaimView['queue']>[number]) => `#${q.number}${q.state === 'chained' ? ` (after #${q.after})` : q.state === 'new' ? ' (not started)' : q.state === 'working' ? ' (working)' : ''}`;
  const waiting = (c.queue ?? []).filter((q) => q.state !== 'done');
  const left = c.estimate ? `, about ${Math.round((c.estimate.left_ms / 3_600_000) * 10) / 10} h left (an estimate from the last ${c.estimate.of} holders)` : '';
  const line = waiting.length ? `; queue: ${waiting.map(chip).join(', ')}; ${c.done} of ${c.total} done${left}` : '';
  return `${c.name}: ${c.holder_name}, taken by ${c.taken_by} ${c.since_text}${c.note ? ` (${c.note})` : ''}${c.keep ? ', kept through its next live' : ''}${c.beside_number ? `, #${c.beside_number} shipping beside it` : ''}${line}`;
}

/** Answers this family's tools; NOT_HERE for any other. */
export async function runMinionsTool(name: string, args: Record<string, unknown>): Promise<string | typeof NOT_HERE> {
  switch (name) {
    case 'list_tickets': {
      const at = schemeOf(args);
      const { tickets, scheme, errors } = await call<{ tickets: TicketView[]; scheme: string; errors?: ErrorsDay }>('GET', `/api/projects/${at}/tickets${args.include_closed ? '?include_closed=1' : ''}`);
      const head = at === C().PROJECT ? [] : [otherScheme(scheme)];
      // The morning count (#835): yesterday's contraption errors and the shared-folder file that lists them.
      if (errors) head.push(`Contraption errors yesterday (${errors.day}): ${errors.total}, ${errors.apps.map((a) => `${a.title} ${a.count}`).join(', ')}. Grouped with a sample each in the shared folder's ${errors.file}.`);
      const claims = at === C().PROJECT ? (await call<{ claims: ClaimView[] }>('GET', `/api/projects/${at}/claims`)).claims : [];
      return [...head, tickets.length ? tickets.map(ticketLine).join('\n') : 'No minions.', ...(claims.length ? ['Claims:', ...claims.map(claimLine)] : [])].join('\n');
    }
    case 'claim': {
      const r = await call<{ claim: ClaimView }>('POST', `/api/projects/${C().PROJECT}/claims`, { name: args.name, minion: args.minion ?? null, note: args.note ?? null, keep: args.keep ?? null, queue: args.queue ?? null });
      return `${args.queue && args.minion == null ? 'Queue set' : 'Claimed'}: ${claimLine(r.claim)}`;
    }
    case 'release': {
      const r = await call<{ released?: ClaimView; claim?: ClaimView }>('DELETE', `/api/projects/${C().PROJECT}/claims/${encodeURIComponent(String(args.name ?? ''))}`);
      return r.released ? `Released: ${claimLine(r.released)}${r.claim ? `\nNow: ${claimLine(r.claim)}` : ''}` : `Nobody held ${args.name}.`;
    }
    case 'list_claims': {
      const { claims } = await call<{ claims: ClaimView[] }>('GET', `/api/projects/${C().PROJECT}/claims`);
      return claims.length ? claims.map(claimLine).join('\n') : 'No claims: every duty is free.';
    }
    case 'read_ticket': {
      const at = schemeOf(args);
      const n = await id(args, at);
      const last = Math.min(Math.max(Number(args.last) || 10, 1), 50);
      // The whole history (?after=0), not a chat page: the skipped count needs every entry.
      const [{ ticket, project }, events] = await Promise.all([call<{ ticket: TicketView; project: { name: string } }>('GET', `/api/tickets/${n}`), call<StoredEvent[]>('GET', `/api/tickets/${n}/events?after=0`)]);
      const head = at === C().PROJECT ? [] : [otherScheme(project.name)];
      if (args.live === true) return [...head, ticketLine(ticket), ...liveState(ticket, events)].join('\n');
      const lines = transcript(events);
      const skipped = Math.max(lines.length - last, 0);
      return [...head, ticketLine(ticket), ticket.cwd ? `worktree: ${ticket.cwd}` : '', skipped ? `(${skipped} earlier entries omitted)` : '', ...lines.slice(-last)].filter(Boolean).join('\n\n');
    }
    case 'create_ticket': {
      // A session that loaded an older schema may leave out properties (or its type); a missing type
      // must not stop it starting minions, so it gets `other` and is told.
      const properties = args.properties && typeof args.properties === 'object' && !Array.isArray(args.properties) ? ({ ...args.properties } as Record<string, unknown>) : {};
      const untyped = !Object.keys(properties).some((k) => k.toLowerCase() === 'type');
      if (untyped) properties.type = 'other';
      if (args.start_after == null) sharedFilesExist(args.message, 'Start this minion');
      const twins = C().MEMORY && args.not_duplicate !== true ? await openTwins(String(args.title ?? ''), String(args.message ?? '')) : [];
      if (twins.length) {
        return [
          'Not created: these open minions read like the same work (closeness by meaning, 1 is the same):',
          ...twins.map((h) => `- #${h.number} ${h.title}${h.owner ? `, ${h.owner}'s` : ''} (${h.status}, ${h.score})`),
          'If one is, message it instead (message_ticket). If not, call create_ticket again with not_duplicate: true.',
        ].join('\n');
      }
      const t = await call<TicketView>('POST', `/api/projects/${C().PROJECT}/tickets`, {
        title: args.title,
        properties,
        message: args.message,
        start_after: args.start_after ?? null,
        start_when: args.start_when ?? null,
        parent: args.parent,
        build: args.build,
        build_owner: args.build_owner === true || undefined,
        cabal: args.cabal ?? undefined,
        model: args.model ?? null,
        effort: args.effort ?? null,
        pick_reason: args.reason,
        workflow: args.workflow ?? null,
        plugin_dirs: args.plugin_folders,
        expected_cost: args.expected_cost ?? null,
        not_duplicate: args.not_duplicate === true || undefined,
      });
      const fallback = untyped ? [`No type was given, so it is type: other for now. Set the right one with set_properties (ticket_id ${t.number}), and pass properties: { type: … } to create_ticket next time.`] : [];
      const absent = args.start_after == null ? [] : missingShared(args.message).map((path) => `Warning: the brief names ${path}, which does not exist. Unless a minion ahead of #${t.number} writes it, send it the right path (message_ticket).`);
      return [`Created ${ticketLine(t)}`, ...(t.notes ?? []), ...absent, ...fallback].join('\n');
    }
    case 'message_ticket': {
      const ticketId = await id(args);
      sharedFilesExist(args.text ?? args.message, 'Send this');
      // Unseal (#718; start_now is its old name): the server unseals it first if it's sealed, and this message wakes it.
      const unpark = args.unpark === true || args.start_now === true;
      const t = await call<TicketView & { held?: boolean | string }>('POST', `/api/tickets/${ticketId}/messages`, { text: args.text ?? args.message, ...(unpark ? { unpark: true } : {}) });
      if (t.held === 'parked')
        return `Held for #${t.number}: it is sealed or waits for its start card, so the message shows in its chat now and reaches it when it is unsealed or woken (its deploy wait or chained start). Do not resend it; message_ticket with \`unpark\` wakes a sealed one now, but one waiting on its start card starts only on a person's answer.\n${ticketLine(t)}`;
      return t.held ? `${HELD()} Finish your turn.\n${ticketLine(t)}` : `Sent. ${ticketLine(t)}`;
    }
    case 'message_taskmaster': {
      const r = await call<{ file?: string; held?: unknown; scheme: unknown; woke?: unknown; left: number }>('POST', '/api/taskmaster', {
        scheme: args.scheme,
        ...(args.person ? { person: args.person } : {}),
        text: args.text ?? args.message,
        saw: args.saw,
        checked: args.checked,
        wanted: args.wanted,
        by: args.by,
        need: args.need,
        ...(args.wake === false ? { wake: false } : {}),
        ...(args.file ? { file: args.file } : {}),
      });
      const copied = r.file ? ` The file is at ${r.file} in its shared folder.` : '';
      const ask = 'If you have a good reason to keep going, ask people with ask_question, saying why; their answer (or anything a person writes in your chat) continues it.';
      if (r.held) return `${heldToolText(C().MSG, `you and the Taskmaster of ${r.scheme}`)}${copied} ${ask}`;
      const how = (args.wake === false || args.need === 'fyi') && !r.woke ? `Left as held mail: the Taskmaster of ${r.scheme} reads it on its next turn.` : `Sent. The Taskmaster of ${r.scheme} runs it now, or after its current turn.`;
      return `${how}${copied}${r.left <= 2 ? ` ${r.left} more between you before the loop guard holds them. ${ask}` : ''}`;
    }
    case 'update_ticket':
      needOne(args, ['title', 'state', 'note', 'replies', 'build', 'model', 'effort', 'workflow', 'plugin_folders', 'start_after', 'cabal'], 'update_ticket');
      return `Updated. ${ticketLine(await call<TicketView>('PATCH', `/api/tickets/${await id(args)}`, { ...labelFields(args), cabal: args.cabal, model: args.model, effort: args.effort, pick_reason: args.reason, workflow: args.workflow, plugin_dirs: args.plugin_folders }))}`;
    case 'set_thread_status':
      needOne(args, ['title', 'state', 'note', 'replies', 'build'], 'set_thread_status');
      {
        const t = await call<TicketView & { close_cancelled?: string }>('PATCH', `/api/tickets/${C().TICKET}`, labelFields(args));
        const cancelled = t.close_cancelled ? `close_self is cancelled: ${t.close_cancelled}, so this minion stays open after this turn. If nothing is left for people, set another state and call close_self again. ` : '';
        return `Updated. ${cancelled}${ticketLine(t)}`;
      }
    case 'message_coordinator': {
      const r = await call('POST', `/api/tickets/${C().TICKET}/coordinator`, { text: args.text ?? args.message, need: args.need, ...(args.wake === false ? { wake: false } : {}), ...(args.when_ci_passes === true ? { when_ci_passes: true } : {}) });
      if (r.armed) return `${r.armed} End your turn with state outside.`;
      if (r.held) return `${HELD()} Finish your turn.`;
      // Rules its description held before #1575, where they apply (message_minion's pointer is in the minion prompt).
      const fyi = args.need === 'fyi' ? ' A fyi is for status, shipped, live or tracking: anything with no action. If you need anything done it is not a fyi, so send it again with the need that fits; otherwise do not resend it.' : '';
      const never = " Never send that you shipped or are live (the server's shipped line already tells it), nor acknowledgements or progress.";
      const start = args.need === 'start' ? " If the work should start only once something ships, say what: the Taskmaster starts it with create_ticket's start_after when the work is planned." : '';
      if (r.mail) return `Left as held mail: it shows in the Taskmaster's chat now, and the Taskmaster reads it on its next turn, whoever wakes it.${fyi || ' Do not resend it.'}${start}${never}`;
      return `Sent. The Taskmaster runs it now, or after its current turn.${fyi}${start}${never}`;
    }
    case 'message_minion': {
      const n = Number(args.ticket_id);
      if (!Number.isInteger(n) || n <= 0) throw new Error('ticket_id must be a minion number');
      sharedFilesExist(args.text ?? args.message, 'Send this');
      const r = await call('POST', `/api/tickets/${C().TICKET}/minion-message`, { to: n, text: args.text ?? args.message, ...(args.wake === false ? { wake: false } : {}), ...(args.unpark === true ? { unpark: true } : {}) });
      const who = `#${r.number} ${r.title}`;
      if (r.held === true) return `${heldToolText(C().MSG, `you and #${r.number}`)} Finish your turn.`;
      if (r.held === 'parked') return `Held for ${who}: it is sealed or waits for its start card, so the message shows in its chat now and reaches it when it is unsealed or woken. Do not resend it; if it is sealed on you, resend with \`unpark: true\`.`;
      if (r.held === 'mail') return `Left as held mail: ${who} reads it on its next turn, whoever wakes it. Do not resend it.`;
      return `Sent. ${who} runs it now, or after its current turn.`;
    }
    case 'live_facts': {
      // A minion reads a minion of its own scheme through its own path; a Taskmaster by the minion's id (another scheme's for Citadel's).
      if (C().ROLE === 'thread') {
        const n = Number(args.ticket_id);
        if (!Number.isInteger(n) || n <= 0) throw new Error('ticket_id must be a minion number');
        return (await call<{ text: string }>('GET', `/api/tickets/${C().TICKET}/facts?number=${n}`)).text;
      }
      const at = schemeOf(args);
      const { text, facts } = await call<{ text: string; facts: { scheme: string } }>('GET', `/api/tickets/${await id(args, at)}/facts`);
      return at === C().PROJECT ? text : `${otherScheme(facts.scheme)}\n${text}`;
    }
    case 'read_minion': {
      const n = Number(args.ticket_id);
      if (!Number.isInteger(n) || n <= 0) throw new Error('ticket_id must be a minion number');
      const r = await call<{ ticket: TicketView; skipped?: number; events: StoredEvent[] }>('GET', `/api/tickets/${C().TICKET}/peer?number=${n}&last=${Number(args.last) || 10}`);
      return [ticketLine(r.ticket), r.skipped ? `(${r.skipped} earlier entries omitted)` : '', ...transcript(r.events)].filter(Boolean).join('\n\n');
    }
    case 'plan':
      return planResult(args);
    case 'close_self': {
      let closed: { cleared?: boolean; joined?: string } | undefined;
      try {
        closed = await call<{ cleared?: boolean; joined?: string }>('POST', `/api/tickets/${C().TICKET}/close`, { reason: args.reason ?? null, as: args.as ?? null, into: args.into ?? null });
      } catch (err) {
        // A server from before close_self refuses the route with its generic "only itself" error.
        if (/only update itself|Not found/.test(thrown(err).message!)) {
          throw new Error(`The ${APP_NAME} server running now predates close_self, so it cannot dismiss minions yet; it will after its next restart. Say in your reply that the work is finished and nothing is left for people.`);
        }
        throw err;
      }
      return closeSelfResult(!!closed?.cleared) + joinedLine(args.into, closed?.joined);
    }
    case 'close_ticket': {
      const t = await call<TicketView & { joined?: string }>('POST', `/api/tickets/${await id(args)}/status`, { status: 'closed', as: args.as ?? null, into: args.into ?? null });
      return `Closed. ${ticketLine(t)}${joinedLine(args.into, t.joined)}`;
    }
    case 'reopen_ticket':
      return `Reopened. ${ticketLine(await call<TicketView>('POST', `/api/tickets/${await id(args)}/status`, { status: 'idle' }))}`;
    case 'fresh_session':
      await call('POST', `/api/tickets/${C().TICKET}/fresh-session`, { summary: args.summary });
      return 'Handoff saved: your session resets when this turn ends, and your next turn starts from it. Reply in one line and end the turn.';
    case 'stop_ticket': {
      const { stopped, ship } = await call('POST', `/api/tickets/${await id(args)}/stop`, {});
      return [stopped ? 'Stopped.' : 'That minion was not running.', ship].filter(Boolean).join(' ');
    }
    default:
      return NOT_HERE;
  }
}
