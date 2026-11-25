// The MCP tools for shipping and CI (hand_off_land, wakes, the ship line, runners, CI files, ship lessons): definitions and handlers. mcp.ts keeps the tool lists and their order.
import { setTimeout as sleep } from 'node:timers/promises';
import { APP_NAME } from './appname.ts';
import { thrown } from './thrown.ts';
import { pacificDay } from './pacific.ts';
import type { UltraBatch, CiFile, CiJob, ShipLesson } from './mcp-types.ts';
import { C, TICKET_ID, call, id, NOT_HERE } from './mcp-call.ts';

const WAKE_DESCRIPTION = `Seal until a deploy is live: ${APP_NAME} messages the minion once the server runs a commit that contains \`commit\` (it must be on main, as shipped: a rebase gives it a new hash), or after the next deploy if no commit is given. In a scheme whose code this server doesn't run, it wakes once \`commit\` is on that scheme's main instead (checked at each deploy and each minion dismissal, so not the moment it lands), and a commit from that scheme is required. Woken once, then forgotten; a dismissed minion is skipped.`;
const WAKE_PROPS = {
  commit: { type: 'string', description: 'Optional: the commit to wait for (a hash, short or full)' },
  reason: { type: 'string', maxLength: 1000, description: 'What to do once it is live (at most 1,000 characters); it comes back in the wake message, e.g. "#63\'s approve cards are live: retry the tripwire test"' },
};
/** wake_at (#722): a timed message to your own chat; with neither `at` nor `cancel` it lists the pending ones. */
export const WAKE_AT = {
  name: 'wake_at',
  description: `Set a timer: at \`at\` ${APP_NAME} sends \`note\` into this same chat as a message and you take a turn on it (one waiting on a turn in progress comes after it). For work "on or after a date". Up to 20 pending, at most 90 days out. Without \`at\` or \`cancel\` it lists them. Not for waking another minion.`,
  inputSchema: {
    type: 'object',
    properties: {
      at: { type: 'string', description: 'When, e.g. "2026-11-18 09:00": Pacific unless it ends in Z or an offset like -08:00. The reply echoes it in PST/PDT' },
      note: { type: 'string', maxLength: 1000, description: 'What to do then (at most 1,000 characters); it comes back as the message' },
      cancel: { type: 'number', description: 'The id of a pending wake to cancel' },
    },
  },
};
/** A minion preps ultra reviews for its turn's person (#1399, Cara 2026-11-20 "Yes, minions prep too"); only they can Start one. */
export const PREP_ULTRA_REVIEWS = {
  name: 'prep_ultra_reviews',
  description: `Prep ultra reviews for the person this turn runs for: each area becomes a draft pull request on their own GitHub login (\`review/*\` branches, [skip ci]), waiting in this chat's Ultra review dialog for them to press Start, which bills their own Claude account. You can never start one, and \`claude ultrareview\` stays blocked. Only on a person's ask. An area over 8,000 lines or 500 files is refused with its size: split it. Unstarted PRs are closed after 7 days. Without \`areas\` it lists this chat's prepped rows.`,
  inputSchema: {
    type: 'object',
    properties: {
      areas: {
        type: 'array',
        maxItems: 20,
        description: 'Up to 20 areas, one draft PR each',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', maxLength: 80, description: 'A short label, e.g. "Land pipeline"' },
            paths: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Repo-relative files or folders, e.g. ["tools/land.sh", "src/land.ts"]' },
            question: { type: 'string', maxLength: 2000, description: 'Optional: what the review should look hardest at' },
          },
          required: ['paths'],
        },
      },
    },
  },
};

/** hand_off_land's answer: what happens next, the deploy, and what to do on a failure (its description's rules since #1575). */
export function handOffResult(args: Record<string, unknown>, contraptions: string[], deploys: boolean): string {
  const deploy = contraptions.length && args.deploy !== false && !args.into ? `, then deploys ${contraptions.join(', ')}; the shipped line says if it went live, so never call deploy_contraption or ask for a redeploy` : '';
  const end = args.stay_open === true ? 'leaves this minion open (stay_open)' : `dismisses this minion${deploys ? ' (or sets pending-deploy for a restart)' : ''}`;
  return (
    `Handed off: the server runs tools/land.sh now, behind any landings in line${deploy}. End your turn now with a short reply and set no state (the server shows you as shipping until it ends): the server posts the shipped line and ${end} on a clean land; it never seals you. ` +
    'If it fails (a conflict, even once main moves while it waits; a red test; a refusal; a failed deploy), you are woken with the end of its output: fix it and hand it off again.'
  );
}

/** The host's read-only checks (#621), for a turn in a container: it has no live database or systemd user bus of its own. */
export const HOST_CHECK = {
  name: 'host_check',
  description: `The host's read-only checks, since this turn runs in a container that can't reach them itself: wherever instructions or habits say \`sqlite3 -readonly …/coordinator.db\`, \`journalctl --user\`, \`systemctl --user status\` or \`list-units\`, call this instead. what: "db" runs one SQL statement on ${APP_NAME}'s live database, read-only, with login secrets shown as [hidden] (at most 1,000 rows; it holds every scheme's chat, so only a turn a ${APP_NAME} admin or ${APP_NAME} scheme member asked for may run it); "journal" prints a user unit's journal (unit, lines, since, grep); "status" is \`systemctl --user status <unit>\`; "units" lists user units (unit as a pattern). A turn's chat, tool calls and output are in the events table (ticket_id is the minion's internal id, which read_ticket shows). The live checkout (the code ${APP_NAME} runs) is mounted read-only at its own path, so read it with Read, grep and git as usual.`,
  inputSchema: {
    type: 'object',
    properties: {
      what: { type: 'string', enum: ['db', 'journal', 'status', 'units'], description: 'Which check' },
      sql: { type: 'string', maxLength: 20000, description: 'For db: one SQL statement, e.g. "SELECT id, number, title FROM tickets WHERE project_id = 3 ORDER BY id DESC LIMIT 5"' },
      unit: { type: 'string', maxLength: 120, description: 'For journal and status: a user unit, like claude-coordinator.service (journal without one reads every user unit); for units, a pattern like "citadel-*"' },
      lines: { type: 'integer', minimum: 1, maximum: 5000, description: 'For journal: how many of the last lines (default 100)' },
      since: { type: 'string', maxLength: 40, description: 'For journal: a time journalctl reads, like "1 hour ago" or "2026-11-12 18:00"' },
      grep: { type: 'string', maxLength: 200, description: 'For journal: only lines matching this pattern (journalctl -g)' },
    },
    required: ['what'],
  },
};

/** A scheme's CI runners on the PCs that host CI (#328), through the runner agent on each. */
export const CI_RUNNERS = {
  name: 'ci_runners',
  description:
    "Add, list or remove this scheme's self-hosted GitHub Actions runners on a CI PC (more than one can host CI; list shows each), through the CI runner agent there (tools/ci-runner/README.md). `host` names the PC (its machine name from list_machines, or its hostname): add goes there and waits for that PC's own runners to show Idle (left out, it takes the first free PC); list and remove with no host reach every PC. add installs `count` (1-4, default 1) runner services labelled <scheme-slug>-ci for the scheme's repo (with os linux, Linux runners labelled <scheme-slug>-ci-linux, in WSL on the same PC, for jobs Windows can't run), skipping ones already there, then waits until GitHub shows them Idle (with a `role`, or on a second PC: until the new ones are online, busy or not). `role` sets what the new runners are for (Citadel puts its labels on them through GitHub; runners already there are left as they are): land (the label alone, which ships take), side (also <label>-side, for long or background jobs), long (also <label>-long), check (only <label>-check). Left out: side on a PC with no land runner for the scheme while another PC has one, else the PC's own order. remove takes this scheme's runners off the PC and GitHub; list shows every runner service on the PC and which are Citadel's. Only for a turn a member of this scheme asked for. An add or remove posts one note in the Taskmaster's chat when it ends; a list posts none. Waits up to 10 minutes; a longer job keeps going, an add's or remove's outcome goes in the Taskmaster's chat, and list afterwards shows the runners.",
  inputSchema: {
    type: 'object',
    properties: {
      op: { type: 'string', enum: ['add', 'list', 'remove'] },
      count: { type: 'number', description: 'add only: how many runners this scheme should have, 1 to 4 (default 1)' },
      role: { type: 'string', enum: ['land', 'side', 'long', 'check'], description: "add only: what the new runners are for (default: side on a scheme's second PC)" },
      host: { type: 'string', description: 'Which PC: its machine name or hostname. Left out: add takes the first free PC; list and remove reach every PC' },
      os: { type: 'string', enum: ['windows', 'linux'], description: 'Which runners: windows (the default) or linux, which the Linux runner agent there (in WSL on a Windows PC, or on plain Linux) adds, lists and removes' },
    },
    required: ['op'],
  },
};

/** The scheme's files in Citadel's CI store (#658, src/ci-store.ts): every minion and Taskmaster. */
export const CI_FILES = {
  name: 'ci_files',
  description:
    "List what this scheme's CI runs uploaded to Citadel's own CI store (builds, reports, release builds), newest first, or with latest: true only the newest match. This replaces `gh run download`: each file comes with its path on this server (read or copy it from there) and its URL under the app's address. Filter by workflow (the file name, like android.yml), kind, target, name, run (a run id) or commit (a prefix). The store deletes by rule: reports after 7 days, builds beyond the newest 5 runs per workflow and target, old releases beyond the newest 10; each target's newest build and release and a published release stay.",
  inputSchema: {
    type: 'object',
    properties: {
      latest: { type: 'boolean', description: 'true for only the newest file that matches' },
      workflow: { type: 'string', description: "The workflow's file name, like android-release.yml" },
      kind: { type: 'string', enum: ['build', 'report', 'release'] },
      target: { type: 'string' },
      name: { type: 'string', description: "The file's exact name" },
      run: { type: 'number', description: 'A GitHub Actions run id' },
      commit: { type: 'string', description: 'A commit hash or its first characters' },
    },
  },
};

/** ship_risk (#1196): ships by risk per scheme and Pacific week, counted from each ship's note. */
export const SHIP_RISK = {
  name: 'ship_risk',
  description:
    'Ships per scheme and per Pacific week (Mon-Sun) by risk (low, medium, high) with the high share, from each ship\'s "Shipped … Risk <r>" note: use it to see whether narrowing a scheme\'s high-risk list cut the changes waiting on a go. "Merged" (a feeder into a build branch) is shown apart from "Shipped" (onto main). The Citadel scheme reads every scheme; another scheme reads its own. Schemes that ship by pull request post no note, so they are named as having none, not shown as 0.',
  inputSchema: { type: 'object', properties: { weeks: { type: 'integer', description: 'How many Pacific weeks back, this one included (default 4, max 26)' } } },
};

export const WAKE_WHEN_LIVE = {
  name: 'wake_when_live',
  description: `${WAKE_DESCRIPTION} Use it when you seal a minion that waits on another minion's deploy. The wake message doesn't count toward the loop guard.`,
  inputSchema: { type: 'object', properties: { ticket_id: TICKET_ID, ...WAKE_PROPS }, required: ['ticket_id', 'reason'] },
};

/** A Taskmaster's reorder of its scheme's ship line (#1358; src/ship-line.ts): the Releases page's drag, with a reason. */
export const ORDER_SHIP_LINE = {
  name: 'order_ship_line',
  description: `Move one waiting ship in this scheme's ship line (the changes waiting to ship, as the Releases page shows them), to the front or ahead of another waiting ship, as dragging it on the Releases page does. Your reason shows on that page and in the line's history, so give one. It is refused for a ship a person placed (it stays where they put it until it ships), for a move that would pass such a ship, for one whose land script is too old to be moved, and for any ship not waiting in this scheme's line. The ship holding the lock keeps it. Only a Taskmaster calls it.`,
  inputSchema: {
    type: 'object',
    properties: {
      ship: { type: 'integer', description: 'The minion number of the waiting ship to move.' },
      before: { type: 'integer', description: 'The minion number of the waiting ship it should go just ahead of; leave out to put it first among the waiting ships.' },
      reason: { type: 'string', description: `One line on why it goes there, at most 200 characters.` },
    },
    required: ['ship', 'reason'],
  },
};

/** A Taskmaster marks a minion of its scheme Urgent (#1888, src/urgent.ts), with a reason. */
export const MARK_URGENT = {
  name: 'mark_urgent',
  description:
    "Mark one minion of this scheme Urgent: when it wants a worker it goes ahead of everyone's share, after the minions already Urgent (or, with before or first, where you place it), until it ships or closes or someone takes it off. on: false takes off your own or the server's mark. Your reason shows beside it. It never overrides a person: a minion a person marked, or took Urgent off, stays as they left it. It never goes ahead of a minion a person marked or placed, and a move is refused saying so. It doesn't move the minion's ship (order_ship_line does).",
  inputSchema: {
    type: 'object',
    properties: {
      minion: { type: 'integer', description: 'The minion number.' },
      on: { type: 'boolean', description: 'false takes Urgent off; default true.' },
      reason: { type: 'string', description: 'One line on why, at most 200 characters; needed to mark one.' },
      before: { type: 'integer', description: 'The number of a minion of this scheme in the Urgent group to go just ahead of; leave out to go at the end (a minion already Urgent stays where it is).' },
      first: { type: 'boolean', description: "true: go first among the ones you may pass, right behind the last minion a person marked or placed. The way to jump ahead of other schemes' minions. Not with before." },
    },
    required: ['minion'],
  },
};

/** land.sh's forms, for the land and hand_off_land tools (landArgs in src/land.ts checks them). */
const LAND_PROPS = {
  into: { type: 'string', pattern: '^build/[1-9][0-9]{0,5}$', description: "A feeder's or the build minion's merge into build/<n>, with files or full" },
  files: { type: 'array', items: { type: 'string' }, maxItems: 200, description: 'With into: the test files to run (none: docs only)' },
  full: { type: 'boolean', description: 'With into: the build minion takes main in; the whole suite runs' },
  build: { type: 'boolean', description: 'The build minion shipping its build to main, alone' },
  fix: { type: 'boolean', description: 'Only for the fix or revert of a rolled-back deploy that land.sh refused for' },
  outage: { type: 'boolean', description: 'A fix for shipping or an outage that is broken right now: its restart skips the wait for a starved box (nothing else)' },
};

/** The scheme's ship lessons queue (#1119): both roles read it, the weekly Ship lessons run and a Taskmaster mark lines taken. */
export const SHIP_LESSONS = {
  name: 'ship_lessons',
  description:
    "Read this scheme's ship lessons queue: the up-to-three lines each minion wrote at ship about what its brief or the docs didn't tell it, with its #N and the files it touched, newest first, plus how many ships wrote lines this week. Lines a proposal already took are left out unless taken is true. To mark lines handled (turned into a proposed edit, or dropped), pass take with their ids and note saying what became of them: taken lines stop coming back. The weekly Ship lessons schedule reads it; so can a Taskmaster or the memory curator.",
  inputSchema: {
    type: 'object',
    properties: {
      days: { type: 'integer', minimum: 1, maximum: 365, description: 'How far back to read, in days (default 60)' },
      taken: { type: 'boolean', description: 'true: include lines already taken, with what became of them' },
      take: { type: 'array', items: { type: 'integer' }, maxItems: 200, description: 'Lesson ids to mark taken' },
      note: { type: 'string', maxLength: 300, description: 'With take: what became of them, e.g. "proposed: handoffs/handoff-x.md" or "dropped: one-off"' },
    },
  },
};

export const RELAY_WHEN_LIVE = {
  name: 'relay_when_live',
  description: `Queue a note for another scheme's Taskmaster (\`to\` is the scheme's name) or a minion of this scheme (\`to\` is #N), sent as held mail (it wakes nothing) once \`commit\` is live (in a scheme this server doesn't run: landed). Use it instead of asking the Taskmaster to relay something once you are live. Call it before hand_off_land; \`commit\` defaults to your branch's head. Your Taskmaster sees it now: it gets the full text as held mail at once, and a one-line note when it goes out. To send one note to several, pass \`to\` as a list rather than calling once each. A dismissed minion's relays still go out, and a failed land leaves them queued: call it with no arguments to list yours (a \`#id\` each), or with \`cancel\` to drop one. Several allowed.`,
  inputSchema: {
    type: 'object',
    properties: {
      to: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, maxItems: 20 }], description: "Another scheme's name, or #N for a minion of this scheme; a list (at most 20) sends the same note to each in one call, and your Taskmaster gets one note for all of them" },
      text: { type: 'string', maxLength: 10000, description: 'The note, self-contained (at most 10,000 characters)' },
      commit: { type: 'string', description: "Optional: the commit to wait for (a hash); your branch's head if left out" },
      cancel: { type: 'number', description: 'Drop your pending relay with this id instead' },
    },
  },
};

export const MINION_WAKE_WHEN_LIVE = {
  name: 'wake_when_live',
  description: `Waiting on another minion's change to be deployed? Call this with its commit and a reason, set state sealed and end your turn, instead of asking the Taskmaster to remember: ${APP_NAME} messages you once it is live. ${WAKE_DESCRIPTION.replace('the minion', 'this minion')}`,
  inputSchema: { type: 'object', properties: WAKE_PROPS, required: ['reason'] },
};

export const WAKE_WHEN_RUNNERS_BACK = {
  name: 'wake_when_runners_back',
  description: `Seal until this scheme's CI runners are back: after land.sh exits 75 (CI gave no verdict, nearly always because the machine the runners run on is off), call this, set state sealed and end your turn. ${APP_NAME} checks the scheme's GitHub runners every 5 minutes and messages you once one labelled <scheme-slug>-ci, <scheme-slug>-ci-linux or <scheme-slug>-desktop is online, so you can run land again. If it can't read the runners with the scheme's GitHub login, it says so at its next check instead. Woken once, then forgotten; a second call replaces the first.`,
  inputSchema: { type: 'object', properties: { reason: { type: 'string', maxLength: 1000, description: 'What to do once they are back (at most 1,000 characters); it comes back in the wake message, e.g. "run tools/land.sh again"' } }, required: ['reason'] },
};

export const REPORT_SPEND = {
  name: 'report_spend',
  description:
    "Book what you spent on an outside API (Azure Speech, ElevenLabs, a paid data feed: not OpenRouter media or Claude, which Citadel already counts) to this scheme's month (#839). Call it right after the paid call, with the cost you worked out from the service's price list. The scheme's monthly bill shows it per service beside Claude usage, and the scheme's cap, if it has one, warns its members when crossed; nothing stops.",
  inputSchema: {
    type: 'object',
    properties: {
      service: { type: 'string', maxLength: 64, description: 'The service, lowercase and stable, like azure-speech' },
      usd: { type: 'number', exclusiveMinimum: 0, description: 'What it cost, in US dollars' },
      units: { type: 'number', minimum: 0, description: 'Optional: how much you used (characters, requests), for the record' },
      note: { type: 'string', maxLength: 500, description: 'Optional: what it was for' },
    },
    required: ['service', 'usd'],
  },
};

export const LOG_LEARNED = {
  name: 'log_learned',
  description:
    'For a ship that does not go through hand_off_land (a pull request): right before you open it, log in at most three lines what you had to find out that your brief or the docs did not tell you, and which tool, rule or skill got in your way (a refusal, a wrong instruction, a slow or broken step), one per line; "nothing" is a fine answer. It goes in the scheme\'s ship lessons queue with your #N and the files your branch touched, for the weekly pass that turns repeats into proposed doc, skill or brief edits. A second call within a few hours replaces the first. hand_off_land takes the same lines as learned, so never call this as well.',
  inputSchema: { type: 'object', properties: { learned: { type: 'string', maxLength: 1000, description: 'Up to three lines, or "nothing"' } }, required: ['learned'] },
};

export const HAND_OFF_LAND = () => ({
  name: 'hand_off_land',
  // Always loaded (ALWAYS_LOAD, #1275), so every word here is in every minion's prompt: the how-to lives in the self-review skill.
  description:
    // Its other rules are in its refusals (uncommitted work, a conflict, a missing go) and its result (#1575).
    'Ship: the server runs tools/land.sh in your worktree (a public/ diff needs the ui-screenshots critic run first, self-review 3).',
  inputSchema: {
    type: 'object',
    properties: {
      summary: { type: 'string', maxLength: 300, description: 'What ships, in one line' },
      learned: { type: 'string', maxLength: 1000, description: 'Always pass it: up to three lines on what your brief or docs missed or fought you; "nothing" is fine. Never holds the ship' },
      risk: { type: 'string', enum: ['low', 'medium', 'high'], description: "The self-review's label. Left out (no review gives one), it ships as high and needs go" },
      risk_reason: { type: 'string', maxLength: 300, description: 'One line: why, plus what you chose not to fix' },
      go: { type: 'string', maxLength: 200, description: 'At or above your go threshold, or with no risk: who gave the go and when, e.g. "Cara, 3:05 PM PST"' },
      fix_proof: { type: 'object', description: "A proven bug fix's proof, instead of go: {test, red_on, red_output, review} (self-review)" },
      stay_open: { type: 'boolean', description: 'Only when your brief has more pieces for you: it ships, you stay open in state ready' },
      waiting_on: { type: 'string', maxLength: 120, description: 'With stay_open: a wait or after-land steps ("Cara testing on her phone"); woken once live, do them and set your state' },
      probe: { type: 'object', description: 'Live check, for 600+ line ships (self-review)' },
      ...LAND_PROPS,
      ...(C().HOME_CONTRAPTIONS.length ? { deploy: { type: 'boolean', description: 'false: nothing to serve, so no deploy (a PC-only build, say)' } } : {}),
    },
    required: ['summary'],
  },
});

export const LAND = () => ({
  name: 'land',
  description: `Land this minion's branch: the server runs tools/land.sh in your worktree on the host, since your turn runs in a container where it can't. To land and end your turn, use hand_off_land; this one is for when you need land.sh's output in this turn. Commit everything first. ${C().DEPLOYS ? 'It rebases onto main, runs the tests, fast-forwards main and deploys' : "It lands the branch as the scheme's land.sh does"}, and returns land.sh's output once it ends, which can take several minutes, and longer when other landings are in line ahead of it (its output says the place). With no arguments it is a plain \`tools/land.sh\`. A build's minions pass its forms: \`tools/land.sh --into build/<n> <test files>\` is { into: "build/<n>", files: [...] }, \`tools/land.sh --into build/<n> --full\` is { into: "build/<n>", full: true }, and \`tools/land.sh --build\` is { build: true }. A call made while your last landing still runs waits on that one, whatever its arguments.`,
  inputSchema: { type: 'object', properties: LAND_PROPS },
});

export const START_PREVIEW = {
  name: 'start_preview',
  description:
    "Start (or restart) a preview of this minion's worktree for people to try before it ships: its server.ts runs on a copy of the app's data, behind the app's login, and never runs turns. Commit first: it serves the worktree as it is now. Returns the link; post it in your reply and set state try. It stops after an hour unused (opening the link starts it again) and goes when the minion is dismissed.",
  inputSchema: { type: 'object', properties: {} },
};

/** Answers this family's tools; NOT_HERE for any other. */
export async function runShipTool(name: string, args: Record<string, unknown>): Promise<string | typeof NOT_HERE> {
  switch (name) {
    case 'ship_risk':
      return (await call<{ text: string }>('GET', `/api/tickets/${C().TICKET}/ship-risk?weeks=${Number(args.weeks) || 4}`)).text;
    case 'log_learned': {
      const r = await call<{ lines?: string; id: number; files: number }>('POST', `/api/tickets/${C().TICKET}/learned`, { learned: args.learned });
      return r.lines ? `Logged ${r.lines.split('\n').length} line${r.lines.includes('\n') ? 's' : ''} (lesson #${r.id}, ${r.files} file${r.files === 1 ? '' : 's'} touched) in the scheme's ship lessons queue.` : `Logged "nothing" (lesson #${r.id}): it still counts as this ship's answer.`;
    }
    case 'ship_lessons': {
      if (args.take !== undefined) {
        if (typeof args.note !== 'string' || !args.note.trim()) throw new Error('take goes with note: what became of these lines');
        const { taken } = await call<{ taken: number[] }>('POST', `/api/projects/${C().PROJECT}/ship-lessons/take`, { ids: args.take, note: args.note });
        return `Marked ${taken.length} taken${taken.length ? `: #${taken.join(', #')}` : ''}${taken.length < (args.take as unknown[]).length ? " (the rest were already taken or not this scheme's)" : ''}.`;
      }
      const q = new URLSearchParams({ ...(args.days ? { days: String(args.days) } : {}), ...(args.taken ? { taken: '1' } : {}) });
      const r = await call<{ week: { ships: number; withLines: number }; window: { ships: number; withLines: number }; days: number; lessons: ShipLesson[] }>('GET', `/api/projects/${C().PROJECT}/ship-lessons?${q}`);
      const head = `This week: ${r.week.ships} ship${r.week.ships === 1 ? '' : 's'} answered, ${r.week.withLines} with lines. Last ${r.days} days: ${r.window.ships} answered, ${r.window.withLines} with lines.`;
      const rows = r.lessons.map(
        (l) =>
          `lesson ${l.id} · #${l.number ?? '?'} · ${pacificDay(l.at)}${l.taken_at ? ` · taken: ${l.taken_note}` : ''}\n${l.lines
            .split('\n')
            .map((x: string) => `  - ${x}`)
            .join('\n')}${l.files.length ? `\n  files: ${l.files.join(', ')}` : ''}`,
      );
      return [head, ...(rows.length ? rows : [`No ${args.taken ? '' : 'open '}lines in that window.`])].join('\n');
    }
    case 'report_spend': {
      const r = await call('POST', `/api/tickets/${C().TICKET}/spend`, args);
      return `Booked $${Number(args.usd).toFixed(4)} on ${args.service}: $${Number(r.month_usd).toFixed(2)} this month${r.cap_usd === null ? '' : ` of the $${Number(r.cap_usd).toFixed(2)} cap${r.over_cap ? " (over it; the scheme's members were told)" : ''}`}.`;
    }
    case 'order_ship_line':
      return (await call<{ said: string }>('POST', `/api/projects/${C().PROJECT}/releases/ship-line`, { ship: args.ship, before: args.before, reason: args.reason })).said;
    case 'mark_urgent':
      return (await call<{ said: string }>('POST', `/api/projects/${C().PROJECT}/urgent`, { minion: args.minion, on: args.on, reason: args.reason, before: args.before, first: args.first })).said;
    case 'ci_files': {
      const q = new URLSearchParams();
      for (const k of ['workflow', 'kind', 'target', 'name', 'run', 'commit']) if (args[k] !== undefined && args[k] !== '') q.set(k, String(args[k]));
      const { files, usage } = await call<{ files: CiFile[]; usage: { scheme: number } }>('GET', `/api/projects/${C().PROJECT}/ci-files?${q}`);
      if (!files.length) return 'No file in the CI store matches.';
      const line = (f: CiFile) =>
        `${f.kind} ${f.name} (${f.size.toLocaleString('en')} bytes) from ${f.workflow} run ${f.run_id}${f.run_attempt > 1 ? ` attempt ${f.run_attempt}` : ''}, commit ${f.sha.slice(0, 8)}${f.target ? `, target ${f.target}` : ''}${f.published_to ? `, published to ${f.published_to}` : ''}, uploaded ${new Date(f.created_at).toISOString()}\n  path: ${f.path}\n  url: ${f.url}`;
      if (args.latest === true) return line(files[0]);
      return `${files.slice(0, 50).map(line).join('\n')}${files.length > 50 ? `\n… and ${files.length - 50} older` : ''}\n${(usage.scheme / 1024 ** 2).toFixed(1)} MiB in this scheme's store.`;
    }
    case 'ci_runners': {
      const started = await call<CiJob>('POST', `/api/projects/${C().PROJECT}/ci-runners`, {
        op: args.op,
        ...(args.count !== undefined ? { count: args.count } : {}),
        ...(args.os !== undefined ? { os: args.os } : {}),
        ...(args.host !== undefined ? { host: args.host } : {}),
        ...(args.role !== undefined ? { role: args.role } : {}),
      });
      let job = started;
      for (const end = Date.now() + 10 * 60_000; job.ok === null && Date.now() < end; ) {
        const now = await call<{ job?: CiJob }>('GET', `/api/projects/${C().PROJECT}/ci-runners?wait=50`);
        if (!now.job) return `${started.op} on ${started.machine}: ${APP_NAME} restarted while it ran, so its outcome is lost; ci_runners list shows what is on the PCs now.`;
        job = now.job;
      }
      const head = `${job.op}${job.count ? ` ${job.count}` : ''}${job.os === 'linux' ? ' Linux' : ''} on ${job.machine}, asked by ${job.by}`;
      if (job.ok === null) return `${head}: still running after 10 minutes. ${job.op === 'list' ? 'A list notes nothing; ask again later.' : "The outcome will be noted in the Taskmaster's chat; ci_runners list afterwards shows the runners."}`;
      return `${head}: ${job.ok ? 'done' : 'FAILED'}.\n${job.text}`;
    }
    case 'start_preview': {
      const { url } = await call('POST', `/api/tickets/${C().TICKET}/preview`, {});
      return `The preview is up at ${url}. Post that link in your reply (the minion's view also shows an Open preview button) and set state try.`;
    }
    case 'host_check': {
      const body: Record<string, unknown> = {};
      for (const k of ['what', 'sql', 'unit', 'lines', 'since', 'grep'] as const) if (args[k] !== undefined) body[k] = args[k];
      return (await call<{ output: string }>('POST', '/api/host-check', body)).output;
    }
    case 'hand_off_land': {
      const body: Record<string, unknown> = {};
      for (const k of ['summary', 'learned', 'risk', 'risk_reason', 'go', 'fix_proof', 'into', 'files', 'full', 'build', 'deploy', 'stay_open', 'waiting_on', 'probe'] as const) if (args[k] !== undefined) body[k] = args[k];
      if (args.fix === true) body.fix = true;
      if (args.outage === true) body.outage = true;
      await call('POST', `/api/tickets/${C().TICKET}/land/handoff`, body);
      return handOffResult(args, C().HOME_CONTRAPTIONS, C().DEPLOYS);
    }
    case 'land': {
      // The server checks into, files, full and build against the shapes land.sh accepts (landArgs in src/land.ts).
      const body: Record<string, unknown> = {};
      for (const k of ['into', 'files', 'full', 'build'] as const) if (args[k] !== undefined) body[k] = args[k];
      if (args.fix === true) body.fix = true;
      if (args.outage === true) body.outage = true;
      let r = await call<{ code: number | null; output?: unknown }>('POST', `/api/tickets/${C().TICKET}/land`, body);
      while (r.code === null) {
        await sleep(5000);
        try {
          r = await call<{ code: number | null; output?: unknown }>('GET', `/api/tickets/${C().TICKET}/land`);
        } catch (err) {
          // A landing's folder outlives restarts (src/land.ts); this is a server from before that, or one whose folder went.
          if (!/No landing has started|Nothing has started shipping/.test(thrown(err).message!)) throw err;
          return 'tools/land.sh ended, then Citadel restarted (most likely the deploy it ran) before its result was read, so its exit code and output are lost. Check `git log main` for your commits.';
        }
      }
      return `tools/land.sh exited ${r.code}${r.code === 0 ? '' : ' (read its output: main only moved if it says so)'}.\n\n${String(r.output).slice(-12_000)}`;
    }
    case 'wake_when_live': {
      const target = C().ROLE === 'thread' ? C().TICKET : await id(args);
      const r = await call<{ commit?: string; waiting?: boolean; merged?: boolean; head?: unknown }>('POST', `/api/tickets/${target}/wake`, { commit: args.commit ?? null, reason: args.reason });
      const what = r.commit ? `\`${r.commit.slice(0, 7)}\`` : 'the next deploy';
      if (!r.waiting && r.merged) return `${what} is on the scheme's main already, so there is nothing to wait for.`;
      if (!r.waiting) return `${what} is live already (the server runs \`${String(r.head).slice(0, 7)}\`), so there is nothing to wait for.`;
      return `Waiting for ${what}: ${APP_NAME} sends ${C().ROLE === 'thread' ? 'you' : 'the minion'} a message once it is ${r.merged ? "on the scheme's main" : 'live'}.${C().ROLE === 'thread' ? ' Set state sealed and end your turn.' : ''}`;
    }
    case 'relay_when_live': {
      const r = await call<{ relays: { id: number; to: string; commit: string; text: string }[]; cancelled?: number; id?: number; queued?: boolean; ids: number[]; to?: string; commit: string }>('POST', `/api/tickets/${C().TICKET}/relay-when-live`, {
        to: args.to ?? null,
        text: args.text,
        commit: args.commit ?? null,
        cancel: args.cancel ?? null,
      });
      const lines = r.relays.map((o) => `#${o.id} to ${o.to}, once \`${String(o.commit).slice(0, 7)}\` is live: ${o.text.length > 120 ? o.text.slice(0, 120) + '…' : o.text}`);
      if (r.cancelled) return `Cancelled relay #${r.cancelled}. ${lines.length ? `Pending:\n${lines.join('\n')}` : 'None left.'}`;
      if (r.id)
        return r.queued
          ? `Queued as #${r.id}${r.ids?.length > 1 ? ` (relays #${r.ids.join(', #')}, one per recipient)` : ''}: ${APP_NAME} leaves it as held mail for ${r.to} once \`${r.commit.slice(0, 7)}\` is live, and your Taskmaster has the full text. If the land fails it stays queued: fix it, or cancel it. Do not ask the Taskmaster to relay it.`
          : `\`${r.commit.slice(0, 7)}\` was live already, so the note went to ${r.to} now.`;
      return lines.length ? `Pending relays:\n${lines.join('\n')}` : 'No relays pending.';
    }
    case 'prep_ultra_reviews': {
      const path = `/api/tickets/${C().TICKET}/ultrareview/batch`;
      const r = Array.isArray(args.areas) && args.areas.length ? await call<UltraBatch>('POST', path, { areas: args.areas }) : await call<UltraBatch>('GET', path);
      const rows = r.rows.map((x) => `${x.name}: ${x.state}${x.pr?.number ? `, draft PR #${x.pr.number}${x.pr.url ? ` ${x.pr.url}` : ''}` : ''} (${x.size.lines} lines, ${x.size.files} files)${x.error ? `: ${x.error}` : ''}`);
      const refused = (r.refused ?? []).map((x) => `Refused ${x.name || `area ${x.index + 1}`}: ${x.error}`);
      const head = r.for ? `Prepped for ${r.for}: the rows wait in this chat's Ultra review dialog for their Start; tell them so in your reply. You cannot start one.` : '';
      return [head, ...refused, rows.length ? `Rows:\n${rows.join('\n')}` : 'No prepped ultra reviews in this chat.'].filter(Boolean).join('\n');
    }
    case 'wake_at': {
      const r = await call<{ wakes: { id: number; when: string; note: string }[]; set?: { when: string }; cancelled?: number }>('POST', `/api/tickets/${C().TICKET}/wake-at`, { at: args.at ?? null, note: args.note, cancel: args.cancel ?? null });
      const lines = r.wakes.map((w) => `#${w.id} ${w.when}: ${w.note}`);
      if (r.set) return `Wake set for ${r.set.when}: ${APP_NAME} sends you the note then.\n${lines.join('\n')}`;
      if (r.cancelled) return `Cancelled #${r.cancelled}. ${lines.length ? `Pending:\n${lines.join('\n')}` : 'None left.'}`;
      return lines.length ? `Pending wakes:\n${lines.join('\n')}` : 'No wakes pending.';
    }
    case 'wake_when_runners_back': {
      const r = await call<{ labels?: string[]; label: string }>('POST', `/api/tickets/${C().TICKET}/wake-runners`, { reason: args.reason });
      return `Waiting for a runner labelled ${(r.labels ?? [r.label]).join(', ').replace(/, ([^,]*)$/, ' or $1')} to be online: ${APP_NAME} looks every 5 minutes and sends you a message then. Set state sealed and end your turn.`;
    }
    default:
      return NOT_HERE;
  }
}
