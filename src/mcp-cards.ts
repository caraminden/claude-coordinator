// The MCP tools that put a card in front of a person (questions, plans, proposals, approvals, memory): definitions and handlers. mcp.ts keeps the tool lists and their order.
import { setTimeout as sleep } from 'node:timers/promises';
import { APP_NAME } from './appname.ts';
import { thrown } from './thrown.ts';
import { C, WHEN_CI_PASSES, call, NOT_HERE } from './mcp-call.ts';

// A card addressed to one person (#687): the shared parts of ask_question's and propose_plan's schemas.
const DIRECT_TO = {
  type: 'string',
  description:
    'Leave out: a card goes to everyone in this chat, and any member can answer it. Set it only when one person is asking another, or a decision truly needs one specific person: their login (a member of this scheme; a wrong name is refused with the list). It then counts in only their Needs-you list and pings only their devices, in every scheme they open. Anyone in the scheme can still answer it in the chat, and the answer starts your next turn.',
};

export const ASK_QUESTION = () => ({
  name: 'ask_question',
  description:
    // Always loaded (ALWAYS_LOAD), so only its first sentence is here: each other rule is in the result or refusal that meets it (#1575).
    'Ask people in this chat 1 to 4 multiple-choice questions on a card they answer with a click (or type).',
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
            question: { type: 'string', maxLength: 2000, description: 'The full question, ending in "?". A command can go in it as a tagged fenced block (```powershell-admin, ```wsl, …), drawn like one in a reply, with Copy.' },
            header: { type: 'string', maxLength: 24, description: 'A very short label for the card, e.g. "Layout"' },
            multiSelect: { type: 'boolean', description: 'true if several options can be picked (default false)' },
            options: {
              type: 'array',
              minItems: 2,
              maxItems: 6,
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string', maxLength: 80, description: 'The choice, 1 to 5 words' },
                  description: { type: 'string', maxLength: 300, description: 'What picking it means, or its trade-off' },
                  image: {
                    type: 'string',
                    maxLength: 1000,
                    description: 'Optional picture: a path in your working directory or shared folder to a png, jpg, gif, webp, avif, svg, mp4, webm or mov, shown as a thumbnail; pictured options show as a gallery.',
                  },
                  recommended: { type: 'boolean', description: 'true on the option you recommend, listed first; the card labels it "(Recommended)". Leave the words out of the label.' },
                },
                required: ['label'],
              },
            },
          },
          required: ['question', 'options'],
        },
      },
      kind: {
        type: 'string',
        enum: ['merge', 'ship', 'land'],
        description:
          '"merge" (or "ship", the same; an old "land" too) when the card asks people for the go to ship a change (the self-review\'s high-risk card, a build\'s go card): its chip then reads "Ship It", or "Merge" on a feeder\'s card (a minion in a build, which merges into `build/<n>`; header and option "Merge"). Leave out otherwise.',
      },
      to: DIRECT_TO,
      not_duplicate: { type: 'boolean', description: 'true: post though refused as a twin; yours differs' },
      doc: {
        type: 'string',
        maxLength: 1000,
        description: 'With no questions: the path of a choices page (a mock kit page with pick bars) in your working directory or shared folder. The card names the page and opens it; it lists no options of its own. The picks arrive as a message from the person who pressed Send on the page, which settles the card.',
      },
      notice: {
        type: 'string',
        maxLength: 500,
        description: 'With to and no questions: a one-line notice for that person instead of a question (at most 500 characters). They see it with a "Got it" button, and nothing comes back to you.',
      },
      secret: {
        type: 'object',
        description: 'With no questions: a masked field for a password, API key or token. The value goes to the secret store, never the chat; you get the name it was saved as, and turns read it from $CITADEL_SECRET_<NAME> (CITADEL_SECRET_NAMES lists the ones a turn has).',
        properties: {
          name: { type: 'string', maxLength: 64, description: 'What to save it as: letters, digits and underscores, a letter first, e.g. AZURE_SPEECH_KEY (upper-cased)' },
          scope: { type: 'string', enum: ['person', 'scheme'], description: '"person" (default): the answerer\'s own, for turns that run as them. "scheme": every turn in this scheme, and its members can replace it.' },
          why: { type: 'string', maxLength: 300, description: 'What it is for, shown on the card, e.g. "To sign in to the TWI site"' },
        },
        required: ['name'],
      },
      when_ci_passes: WHEN_CI_PASSES,
    },
  },
});

export const SETTLE_QUESTION = {
  name: 'settle_question',
  description:
    "Settle a card of yours that someone answered by typing a reply instead of clicking it, or that a newer card replaced, or withdraw one no longer wanted. Use your judgement: settle a question only if their message really answers it. A settled question card greys out as answered and a plan-type card (propose_plan, edit_instructions' held edit) as withdrawn; either leaves the needs-you list, can no longer be answered, and no longer holds the minion open. Without question_id it settles your one open question card, and refuses when more than one is open, listing them; a plan-type card is withdrawn only by its id.",
  inputSchema: {
    type: 'object',
    properties: { question_id: { type: 'string', description: "The card's id (from ask_question, propose_plan or edit_instructions), or its link; needed for a plan-type card; leave out only when one question card is open" } },
  },
};

export const PROPOSE_PLAN = {
  name: 'propose_plan',
  description:
    'Post a plan in this chat as a card people answer with Approve or Revise, for a run-back before code or any plan that needs a go. Only a person can approve it. Write it for someone who hasn\'t followed the work: plain words, minions named by what they do with #N after, no paths, line numbers or hashes. After calling it, finish your turn with a short reply and write no code: the card shows below your reply, even when you asked early in a long turn (say "the card below", never "above"), and the go (Approve) or the notes to revise it come as the next message. To revise, call propose_plan again with the whole new plan; the old card shows as superseded. A card from an earlier turn that is still open sits above your later replies: name it or say "above", never "below". The result gives the card\'s link: make every mention of the card a link to it, as in [the plan card below](#/p/2/t/12?e=345).',
  inputSchema: {
    type: 'object',
    properties: {
      summary: { type: 'string', maxLength: 200, description: 'One line on what the plan builds, at most 200 characters, e.g. "Usage bar in the top bar, fed by the turn stats"' },
      plan: { type: 'string', maxLength: 20000, description: 'The whole plan in markdown: what you will change and how, what you will not do, and how you will test it. At most 20,000 characters' },
      to: DIRECT_TO,
    },
    required: ['summary', 'plan'],
  },
};

// propose_machine_lend (#1638; Cara, 2026-11-22): Taskmasters and minions both, as a card a person approves.
export const PROPOSE_MACHINE_LEND = {
  name: 'propose_machine_lend',
  description:
    "Ask for a connected machine's lending to change, as a card in this chat: put this scheme on its list or take it off (here), tick or untick its workspaces (folders) and its MCP server, and set its switches (workspace tools, always on, GPU jobs). Use it instead of describing the Machines page to a person; when you mention the page, link it with the machine's page link list_machines and this tool's reply give. Only who can save that machine on the page approves (an admin, or its owner for someone's own); approving saves it exactly as the page does (its agent is told, and sessions on what is no longer lent end), rejecting changes nothing, and either comes as a message. A scheme's minions use a workspace only if it is ticked AND the scheme is on the machine's list, so ask for both in one card. Ticks are the machine's, shared by every scheme it is lent to. Names come from list_machines; a newer proposal for the same machine replaces an open one. Minion turns get the change from their next start. Link every mention of the card, as with propose_plan.",
  inputSchema: {
    type: 'object',
    properties: {
      machine: { type: 'string', description: 'The machine, as list_machines names it, e.g. citadel-test-box' },
      here: { type: 'boolean', description: "true: put this scheme on the machine's list; false: take it off. Leave out to keep it as it is" },
      tick: { type: 'array', items: { type: 'string' }, maxItems: 50, description: 'Workspaces (folders) to tick, by the names list_machines shows' },
      untick: { type: 'array', items: { type: 'string' }, maxItems: 50, description: 'Workspaces to untick: every scheme it is lent to loses them' },
      server: { type: ['string', 'null'], description: 'The MCP server to lend (it lends one at a time), or null to untick it. Leave out to keep it' },
      workspace_tools: { type: 'boolean', description: 'Only for an agent from before ticks: all its folders on or off' },
      always_on: { type: 'boolean', description: 'true: offline over 5 minutes shows as Down (a desktop); false: shows as Asleep (a laptop)' },
      gpu: { type: 'boolean', description: 'The GPU jobs switch: false refuses GPU tasks (run-gpu) and stops one running; true allows them again' },
      why: { type: 'string', maxLength: 500, description: 'What it is for, for the person approving: at most 500 characters' },
    },
    required: ['machine'],
  },
};

export const PROPOSE_HOST_TOOL = () => ({
  name: 'propose_host_tool',
  description: `Propose installing a command-line tool on the server every turn runs on (yours too, in a container, which can't install one), as a card in this chat showing the exact install command. Only a member of the ${APP_NAME} scheme can approve it: approve installs it with mise (an Arch package is installed by a person, as the server has no root) and ships its line in the server's host tools list, which a rebuild installs from; reject installs nothing. Either comes as a message. Pin one exact version and say in why what it's for.${C().HOST_TOOLS_LIST ? ` What the server has already: ${C().HOST_TOOLS_LIST}.` : ''} A newer proposal for the same package replaces an open one. Link every mention of the card, as with propose_plan.`,
  inputSchema: {
    type: 'object',
    properties: {
      source: {
        type: 'string',
        enum: ['mise', 'npm', 'pypi', 'cargo', 'github', 'pacman'],
        description: "Where it comes from: mise (mise's own tools and registry, e.g. jq, go), npm, pypi (a Python CLI), cargo (a Rust crate, built from source: minutes), github (a release binary, package owner/repo), pacman (an Arch package)",
      },
      package: { type: 'string', maxLength: 140, description: 'Its name in that source, e.g. "ripgrep", "@biomejs/biome", "BurntSushi/ripgrep"' },
      version: { type: 'string', maxLength: 64, description: 'One exact version, e.g. "14.1.1": no ranges, no "latest"' },
      why: { type: 'string', maxLength: 500, description: 'What it is for, for the person approving: at most 500 characters' },
    },
    required: ['source', 'package', 'version', 'why'],
  },
});

export const PROPOSE_MACHINE_NOTES = {
  name: 'propose_machine_notes',
  description:
    'Propose a connected machine\'s whole new notes (its owner\'s instructions that every scheme using it reads as "Notes on <machine> from its owner") as a card in this chat with a diff, when your work changes how the machine should be used. Only its owner or an admin can approve it; approving saves them, rejecting leaves them as they are, and either comes as a message. Send the full text minions should read, not just the change: it replaces the old notes. A newer proposal for the same machine replaces an open one. Link every mention of the card, as with propose_plan.',
  inputSchema: {
    type: 'object',
    properties: {
      // A free string, checked by the server (#878): an enum of this turn's machines would change the tool list with the sender.
      machine: { type: 'string', description: 'The machine, one this turn got' },
      notes: { type: 'string', maxLength: 2000, description: 'The whole new notes, at most 2,000 characters' },
    },
    required: ['machine', 'notes'],
  },
};

export const PROPOSE_MEMORY = () => ({
  name: 'propose_memory',
  description:
    "For a memory curator run: propose a tidy of this scheme's Claude Code memory (MEMORY.md and its notes) as a card in this chat. Nothing is written until a member approves it all on the card (then you apply it with apply_memory) or ticks changes on the Memory page; the decision comes as a message. One change per note file: edit (whole new text, and optionally a new index line), add (new note with its index line), delete (the card's Approve all covers it; on the page a member ticks each), index (only its MEMORY.md line), or flag (no change, just the reason, for a person to judge). Every change needs a reason people decide from. A newer proposal replaces an open one. Never edit memory files yourself in a curator run.",
  inputSchema: {
    type: 'object',
    properties: {
      changes: {
        type: 'array',
        maxItems: 300,
        items: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['edit', 'add', 'delete', 'index', 'flag'] },
            file: { type: 'string', description: 'The note file name, like some-note.md (never MEMORY.md)' },
            text: { type: 'string', description: 'edit, add: the whole new note, frontmatter included' },
            line: { type: 'string', description: 'add, index (optional on edit): its whole MEMORY.md line, "- [Name](file.md) — hook", under about 150 characters' },
            reason: { type: 'string', maxLength: 500, description: 'Why, in one plain sentence' },
          },
          required: ['action', 'file', 'reason'],
        },
      },
    },
    required: ['changes'],
  },
});

export const APPLY_MEMORY = {
  name: 'apply_memory',
  inputSchema: { type: 'object', properties: {} },
  description:
    "For a memory curator run, only after a member approved your memory tidy card (the approval comes as a message): applies the whole approved tidy to the memory folder through the Memory page's own apply, and returns what changed and what was skipped (a note changed since you proposed it is skipped, never overwritten). Refused before an approval, and for a tidy someone already decided on the Memory page. Never edit memory files yourself.",
};

export const STRIKE_TEXT = {
  name: 'strike_text',
  description:
    'Strike through words of yours that turned out wrong, once you are proven wrong in a disagreement (with the Taskmaster, a minion, or anyone; by a test, git, the live state, a person), quoting them exactly: it finds the newest of your replies, or of your messages to another thread, containing the text, shows that text struck through there, and posts a note with your reason. In your reply, also write the wrong words as `~~…~~` with the fix right after.',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', maxLength: 10000, description: 'The wrong words, verbatim from one of your messages (Markdown and all), as short as still pins down the claim (at most 10,000 characters)' },
      reason: { type: 'string', maxLength: 1000, description: 'One sentence (at most 1,000 characters) on what proved it wrong and what is right instead; the note shows it after the struck words, e.g. "git log shows abc123 is on main, so #12 has shipped."' },
    },
    required: ['text', 'reason'],
  },
};

export const MARK_IMAGE = {
  name: 'mark_image',
  description:
    'Point at parts of a picture (#960): boxes, arrows, numbered pins and short labels drawn over it in the chat, which people can hide, and edit or add to before replying. Returns a markdown image line: put it in your reply as it is. Use it when someone asks where something is on a screenshot or your answer points at part of one, instead of describing where.',
  inputSchema: {
    type: 'object',
    properties: {
      image: { type: 'string', description: "The picture: a pasted one's path from the turn's picture line, or a PNG, JPEG, GIF or WebP in your working directory, files folder or shared folder" },
      alt: { type: 'string', description: 'Optional: a few words on what it shows' },
      marks: {
        type: 'array',
        maxItems: 20,
        description: 'Coordinates are percent of the picture from its top left: [0, 0] top left, [100, 100] bottom right',
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['box', 'arrow', 'pin', 'label'] },
            at: { type: 'array', items: { type: 'number' }, description: "[x, y]: a box's corner, an arrow's tail, a pin's or label's centre" },
            to: { type: 'array', items: { type: 'number' }, description: "Box and arrow: [x, y] of the box's opposite corner or the arrow's tip" },
            n: { type: 'integer', description: 'Pin: its number, by default 1, 2, 3 in order' },
            text: { type: 'string', maxLength: 40, description: 'Label: its words' },
            colour: { type: 'string', enum: ['red', 'yellow'], description: 'Optional, default red' },
          },
          required: ['kind', 'at'],
        },
      },
    },
    required: ['image', 'marks'],
  },
};

// Claude Code's permission-prompt tool (--permission-prompt-tool): not one for Claude to call itself.
export const APPROVE = {
  name: 'approve',
  description: 'Used by Claude Code itself to ask people in the chat to approve a tool call. Do not call it yourself.',
  inputSchema: {
    type: 'object',
    properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } },
    required: ['tool_name', 'input'],
  },
};

/**
 * Post an Approve / Deny card for a tool call and wait, however long it takes, for a person to
 * click. Answers in the shape Claude Code expects from a permission-prompt tool. Anything other
 * than a person's Approve, including errors and expired cards, denies.
 */
async function approve(args: Record<string, unknown>): Promise<string> {
  let decision: { state: string; by?: string; reason?: string } | undefined;
  try {
    const { id, refused } = await call<{ id: string; refused?: string }>('POST', `/api/tickets/${C().TICKET}/approvals`, { tool_name: args.tool_name, input: args.input ?? {}, tool_use_id: args.tool_use_id });
    if (refused) return JSON.stringify({ behavior: 'deny', message: refused });
    // Each request waits up to half a minute on the server; keep asking until the card is settled.
    for (let failures = 0; !decision || decision.state === 'pending'; ) {
      try {
        decision = await call<{ state: string; by?: string; reason?: string }>('GET', `/api/tickets/${C().TICKET}/approvals?id=${encodeURIComponent(id)}`);
        failures = 0;
      } catch (err) {
        if (++failures >= 5) throw err;
        await sleep(2000);
      }
    }
  } catch (err) {
    decision = { state: 'expired', reason: `The approval card failed: ${thrown(err).message}` };
  }
  if (decision!.state === 'allowed') return JSON.stringify({ behavior: 'allow', updatedInput: args.input ?? {} });
  const message =
    decision!.state === 'denied'
      ? `${decision!.by} denied this in the chat. It was not run. Do not retry it or work around it; say what you needed it for, carry on with anything that does not need it, and hand the commands it needed to a person in your reply.`
      : `Nobody approved this, so it was not run (${decision!.reason ?? 'the card expired'}).`;
  return JSON.stringify({ behavior: 'deny', message });
}

/** Answers this family's tools; NOT_HERE for any other. */
export async function runCardsTool(name: string, args: Record<string, unknown>): Promise<string | typeof NOT_HERE> {
  switch (name) {
    case 'approve':
      return approve(args);
    case 'mark_image': {
      const r = await call('POST', `/api/tickets/${C().TICKET}/mark-image`, args);
      return `Put this line in your reply as it is; the chat draws the marks over the picture (${r.w}x${r.h}):\n${r.markdown}`;
    }
    case 'ask_question': {
      const direct = args.to ? { to: args.to } : {};
      if (args.doc != null && args.questions == null) {
        const ci = args.when_ci_passes === true ? { when_ci_passes: true } : {};
        const { id: questionId, href, armed } = await call('POST', `/api/tickets/${C().TICKET}/questions`, { doc: args.doc, ...direct, ...ci });
        if (armed) return `${armed} End your turn now with a short reply that says the card comes once CI passes, and set state outside.`;
        return `The choices card (id ${questionId}) is in the chat${args.to ? ` for ${args.to}` : ''}; it opens the page. Its link is ${href}: link every mention of it, in this reply and later ones, e.g. [the card below](${href}), and link the card rather than the page when you point people at the choices. End your turn now with a short reply; the picks will come as a message from whoever presses Send on the page.`;
      }
      if (args.secret != null && args.questions == null) {
        const { id: questionId, href } = await call('POST', `/api/tickets/${C().TICKET}/questions`, { secret: args.secret, ...direct });
        return `The secret card (id ${questionId}) is in the chat${args.to ? ` for ${args.to}` : ''}; its link is ${href}: link every mention of it, e.g. [the card below](${href}). End your turn now with a short reply. Once someone saves it, you get a message with the name it was saved as (never the value), and your next turn has it in $CITADEL_SECRET_<NAME>: use it in commands without ever printing it.`;
      }
      if (args.to && args.questions == null) {
        const { href, armed } = await call('POST', `/api/tickets/${C().TICKET}/questions`, { ...direct, notice: args.notice, ...(args.when_ci_passes === true ? { when_ci_passes: true } : {}) });
        if (armed) return `${armed} Nothing comes back from it, so keep working.`;
        return `The notice for ${args.to} is in the chat; its link is ${href}. Nothing comes back from it, so keep working.`;
      }
      // A choices page or a secret card asks on its own: questions beside it would post a plain card and drop the page or field.
      if (args.questions != null && args.doc != null) throw new Error('Pass doc or questions, not both: a choices page (citadel:docs-and-mocks) asks on its own page, and its Send settles the card. Call again with doc alone, or questions alone.');
      if (args.questions != null && args.secret != null) throw new Error('Pass secret or questions, not both: a secret card is one masked field for a password, API key or token. Call again with secret alone; you get only the name it was saved as.');
      if (args.questions == null) throw new Error('questions is required, unless you send a notice to one person (to and notice), ask on a choices page (doc) or ask for a secret (secret)');
      const ci = args.when_ci_passes === true ? { when_ci_passes: true } : {};
      const everyone = args.for_everyone === true ? { for_everyone: true } : {};
      const {
        id: questionId,
        href,
        armed,
        merged,
      } = await call('POST', `/api/tickets/${C().TICKET}/questions`, { questions: args.questions, ...(args.not_duplicate === true ? { not_duplicate: true } : {}), ...(args.kind ? { kind: args.kind } : {}), ...(args.hand_off !== undefined ? { hand_off: args.hand_off } : {}), ...direct, ...ci, ...everyone });
      if (armed) return `${armed} End your turn now with a short reply that says the card comes once CI passes, and set state outside.`;
      if (merged)
        return `Your earlier question card of this turn was still unanswered, so these questions joined it (up to 8 questions in all): people see one card with one Send and answer all of them in one message. Its link is ${href} (the same one; link it, e.g. [the card below](${href}), "below" this turn, "above" later). End your turn now with a short reply; the answers will come as the next message.`;
      return `The question card (id ${questionId}) is in ${args.for_everyone === true ? "the Overlord's chat, for everyone" : 'the chat'}${args.to ? ` for ${args.to}` : ''}${href ? `; its link is ${href}. Link every mention of it, in this reply and later ones, e.g. [${args.for_everyone === true ? "the card in the Overlord's chat" : 'the card below'}](${href})${args.for_everyone === true ? '' : ' ("below" this turn, "above" later)'}` : ''}. End your turn now with a short reply; the answers will come as ${args.to ? `a message from ${args.to}` : 'the next message'}.${args.kind ? '' : ' A plain card you ask later this turn, while this one is still unanswered, joins it (up to 8 questions in all), so people see one card with one Send.'}`;
    }
    case 'settle_question': {
      const { settled } = await call<{ settled: unknown[] }>('POST', `/api/tickets/${C().TICKET}/settle`, { questionId: args.question_id ?? null });
      return settled.length ? `Settled ${settled.join(', ')}: shown as answered (a plan-type card as withdrawn) in the chat.` : 'No card of yours was open.';
    }
    case 'strike_text':
      await call('POST', `/api/tickets/${C().TICKET}/strike`, { text: args.text, reason: args.reason });
      return 'Struck through in the chat, with your reason in a note.';
    case 'propose_machine_notes': {
      if (!C().MACHINES.includes(String(args.machine ?? '').toLowerCase())) throw new Error(C().MACHINES.length ? `No machine called ${args.machine} that this turn got: it has ${C().MACHINES.join(', ')}` : 'This turn got no connected machines, so there are no notes to propose');
      const { href, owner } = await call('POST', `/api/tickets/${C().TICKET}/machine-notes`, { machine: args.machine, notes: args.notes });
      return `The notes card is in the chat; its link is ${href}. Link every mention of it, e.g. [the notes card below](${href}). Only ${owner ? `${owner} (its owner) or an admin` : 'an admin'} can approve it, and the answer comes as a message. Keep working on what doesn't depend on it.`;
    }
    case 'propose_machine_lend': {
      const { href, owner, page } = await call('POST', `/api/tickets/${C().TICKET}/machine-lend`, args);
      return `The lending card is in the chat; its link is ${href}. Link every mention of it, e.g. [the lending card below](${href}), and the machine itself as [${String(args.machine).toLowerCase()} on the Machines page](${page}). Only ${owner ? `${owner} (its owner) or an admin` : 'an admin'} can approve it, and the answer comes as a message. Keep working on what doesn't depend on it.`;
    }
    case 'propose_host_tool': {
      const { href } = await call('POST', `/api/tickets/${C().TICKET}/host-tool`, { source: args.source, package: args.package, version: args.version, why: args.why });
      return `The host tool card is in the chat; its link is ${href}. Link every mention of it, e.g. [the host tool card below](${href}). Only a member of the ${APP_NAME} scheme can approve it, and the answer comes as a message, then another once it's installed. Keep working on what doesn't depend on it.`;
    }
    case 'propose_memory': {
      const { href, counts } = await call('POST', `/api/tickets/${C().TICKET}/memory-proposal`, { changes: args.changes });
      return `The memory tidy card (${counts}) is in the chat; its link is ${href}. Link every mention of it. A member approves it on the card or picks changes on the Memory page, and the answer comes as a message. End your turn now, in state ready. On an approval, call apply_memory; then, or on any other answer, report it and close yourself with close_self.`;
    }
    case 'apply_memory':
      return `${(await call('POST', `/api/tickets/${C().TICKET}/memory-proposal/apply`, {})).line} Report that in a few lines, then close yourself with close_self.`;
    case 'propose_plan': {
      const { href } = await call('POST', `/api/tickets/${C().TICKET}/plans`, { summary: args.summary, plan: args.plan, ...(args.to ? { to: args.to } : {}) });
      return `The plan card is in the chat${args.to ? ` for ${args.to}` : ''}${href ? `; its link is ${href}. Link every mention of it, in this reply and later ones, e.g. [the plan card below](${href})` : ''}. End your turn now with a short reply and write no code; the go or the notes to revise it will come as ${args.to ? `a message from ${args.to}` : 'the next message'}.`;
    }
    default:
      return NOT_HERE;
  }
}
