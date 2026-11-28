// The MCP tools for a scheme's settings, instructions, properties, schedules and review set: definitions and handlers. mcp.ts keeps the tool lists and their order.
import { APP_NAME } from './appname.ts';
import { thrown } from './thrown.ts';
import { instructionCost } from './prompt-cost.ts';
import { DONE_LINES } from './done-lines.ts';
import { pacificDay } from './pacific.ts';
import type { PropertyKey, RegistryReply, ProjectView, Counted, ReviewEntry } from './mcp-types.ts';
import { scheduleLine, type ScheduleInfo } from './mcp-text.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { repoSlug } from './repo-slug.ts';
import { C, TICKET_ID, call, propertyText, id, needOne, MODEL, EFFORT, PROPERTIES, NOT_HERE } from './mcp-call.ts';

// What a schedule's runs start with (#387), from the same table: a mechanical checkup is a read-only check.
const SCHEDULE_MODEL = { ...MODEL, description: 'The model each run starts with. Required: pick it from the model table in your prompt; a mechanical checkup is a read-only check (claude-sonnet-5-5).' };
const SCHEDULE_EFFORT = { ...EFFORT, description: 'The effort each run starts with. Required: the one the model table pairs with your model (a read-only check: low).' };

export const SCHEDULE_TEMPLATES = ['code-health', 'test-audit', 'monthly-retro', 'upstream-check', 'app-turns', 'memory-curator', 'ship-lessons', 'glossary-drift', 'architecture', 'area-review'] as const;
const SCHEDULE_GATE = {
  min_minions: { type: ['integer', 'null'], minimum: 1, description: 'Skip a due slot unless at least this many minions were made since the last real run (Taskmasters and schedule-started minions not counted); null always runs' },
  gate_scope: { type: 'string', enum: ['scheme', 'all'], description: "Whose minions min_minions counts: this scheme's (default) or every scheme's, for a sweep across schemes" },
  once: { type: 'boolean', description: 'Pause after the first real run (skips not counted): set it for a one-off such as a dated read-back' },
  trigger_count: { type: ['integer', 'null'], minimum: 1, description: 'Activity trigger: also run early once this many ships to main (or minions made, by trigger_kind) since the last real run, counted in gate_scope and checked hourly; the cron slot stays as the fallback. null clears it' },
  trigger_kind: { type: 'string', enum: ['ships', 'minions'], description: 'What trigger_count counts: ships to main (merges into a build branch not counted) or minions made (counted as min_minions counts them)' },
  trigger_gap_hours: { type: ['integer', 'null'], minimum: 1, maximum: 720, description: "A trigger's floor: never runs early within this many hours of the last real run, nor over a run still working; null is a day" },
  category: { type: 'string', description: 'The group it shows under on the Schedules page, at most 40 characters: reuse one list_schedules shows (e.g. Code, Tests, Process, Skills and docs, Models and usage, Apps, Read-backs). Left out of schedule_minion, it is guessed from the name' },
};

export const LIST_PROPERTIES = {
  name: 'list_properties',
  description: "The property registry for this scheme: the global keys (type, stage, requestedBy, assigned) and this scheme's own, with their values and aliases. Read it before setting or proposing properties.",
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

export const EDIT_INSTRUCTIONS = {
  name: 'edit_instructions',
  description:
    'Edit the Settings text the way you edit any other instruction file: this scheme\'s instructions (scope "scheme"), or the Citadel-wide ones (scope "citadel", only on a turn run for a member of the Citadel scheme). Give a list of { find, replace } edits; each `find` must match the current text exactly once, or nothing is saved and the failing edits are named. All edits save in one go through Settings\' own save, so they show in Settings and its history, by "#<your number> for <the person your turn runs for>", and the chat shows each before and after. A Settings text edit is an agent-instruction change: self-review it, label it at least medium, ship it like the rest (like a prompts.ts change), and keep its dated quotes: they are the decisions log. One home per rule (#1162): first have a Sonnet Grunt list what already speaks to the same thing (the rest of both Settings texts, CLAUDE.md and the rule files, the kit, your prompt) and pass its findings as `overlaps`. The server checks the edit too, against each registered rule\'s one home and those places; when either finds something, nothing is saved and a card asks the person to save anyway, work it in where it is already said, or cancel.',
  inputSchema: {
    type: 'object',
    properties: {
      scope: { type: 'string', enum: ['scheme', 'citadel'], description: "scheme: this scheme's instructions; citadel: the Citadel-wide instructions" },
      edits: {
        type: 'array',
        minItems: 1,
        items: { type: 'object', properties: { find: { type: 'string', description: 'Exact current text; must occur once' }, replace: { type: 'string', description: 'What it becomes (empty to delete)' } }, required: ['find', 'replace'] },
      },
      overlaps: { type: 'array', maxItems: 30, items: { type: 'string' }, description: 'What your Grunt found already says it, one line each: where, and what it says ([] when it found nothing)' },
    },
    required: ['scope', 'edits', 'overlaps'],
  },
};

export const LIST_SCHEDULES = {
  name: 'list_schedules',
  description: "List this scheme's scheduled minions: when each runs, when it runs next, and its last run.",
  inputSchema: { type: 'object', properties: {} },
};

export const SCHEDULE_MINION = {
  name: 'schedule_minion',
  description:
    "Schedule a minion: on each run the server starts a fresh minion (its own worktree, a clean context) with the brief as its first message. Runs with nothing to report dismiss themselves; runs that find something stay open in state ready. Times are the server's (America/Los_Angeles). People see schedules, and pause or delete them, under Orders → Schedules. With min_minions set, a due slot is skipped at no cost (no minion, no note) unless that many minions were made since the last real run, so the cron says how often it may check and the gate says whether it's worth a run. A one-off (a dated cron such as a read-back) sets once, or its date comes round again next year.", // pacific-ok: prose in the tool description
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Short name, also each run\'s minion title, e.g. "Nightly health check"' },
      cron: { type: 'string', description: 'Five cron fields (minute hour day-of-month month day-of-week), e.g. "0 3 * * *" for 03:00 daily, "0 9 * * 1" for Mondays 09:00; or @hourly, @daily, @weekly' },
      brief: { type: 'string', description: "The run's first message: what to check and what counts as worth reporting" },
      type: { type: 'string', description: 'The `type` property each run gets (default chore)' },
      model: SCHEDULE_MODEL,
      effort: SCHEDULE_EFFORT,
      ...SCHEDULE_GATE,
    },
    required: ['name', 'cron', 'brief', 'model', 'effort'],
  },
};

export const SCHEDULE_AUDIT = {
  name: 'schedule_audit',
  description:
    "Add one of the kit's standard audits to this scheme (kit/schedules/<template>.md, #799): it brings its name, time (staggered by scheme), model, effort and activity gate, and each run renders the kit's current text with this scheme's name, then your notes. Add one only where the repo shows what it needs. code-health: app code people build on, not only notes, docs or an empty scaffold. test-audit: a test suite. monthly-retro: minions working in the scheme. upstream-check: a THIRD_PARTY.md with a Copies table, or a \"## Copies\" table in onboarding.md. app-turns: a scheme home to an app; Citadel adds it by itself when the scheme gets its first app. ship-lessons: a scheme whose minions ship; Citadel adds it by itself on the scheme's first ship lessons. architecture: every scheme gets it by itself monthly; it skips unless 20 minions worked in the scheme since the last run. A scheme has each at most once; update_schedule changes it.",
  inputSchema: {
    type: 'object',
    properties: {
      template: { type: 'string', enum: [...SCHEDULE_TEMPLATES], description: 'Which audit' },
      notes: { type: 'string', description: 'What this scheme adds to the template, appended under "For <scheme>:", e.g. "Ships wait for a person\'s go." or "Never push."' },
    },
    required: ['template'],
  },
};

export const UPDATE_SCHEDULE = {
  name: 'update_schedule',
  description: 'Change, pause or resume a schedule. Pass only what changes.',
  inputSchema: {
    type: 'object',
    properties: {
      schedule_id: { type: 'integer', description: 'The schedule id from list_schedules' },
      name: { type: 'string' },
      cron: { type: 'string' },
      brief: { type: 'string' },
      type: { type: 'string' },
      model: SCHEDULE_MODEL,
      effort: SCHEDULE_EFFORT,
      ...SCHEDULE_GATE,
      paused: { type: 'boolean', description: 'true pauses it, false resumes it' },
      template: { type: 'string', enum: [...SCHEDULE_TEMPLATES], description: 'Swap a hand-written copy of a standard audit for its kit template (see schedule_audit), keeping its pause and last run; pass notes with what its brief had beyond the template' },
      notes: { type: 'string', description: "A standard audit's notes for this scheme, replacing the old ones. A whole brief instead turns it into a custom copy that no longer follows the kit" },
    },
    required: ['schedule_id'],
  },
};

export const DELETE_SCHEDULE = {
  name: 'delete_schedule',
  description: 'Delete a schedule. Minions it already started stay.',
  inputSchema: { type: 'object', properties: { schedule_id: { type: 'integer' } }, required: ['schedule_id'] },
};

export const SET_PROPERTIES = {
  name: 'set_properties',
  description: "Set a minion's properties, or (with file) those of a file it showed people. Only the keys you pass change.",
  inputSchema: {
    type: 'object',
    properties: {
      ticket_id: TICKET_ID,
      file: { type: 'string', description: 'Optional: a file the minion linked (an artifact), as a path in its working directory or an absolute path' },
      properties: PROPERTIES,
    },
    required: ['ticket_id', 'properties'],
  },
};

export const REGISTER_PROPERTY_VALUES = {
  name: 'register_property_values',
  description:
    "Add values to one of this scheme's enum keys (or, from the Citadel scheme only, a global key), or add aliases to values it has. New values are live at once but marked unreviewed (unless an open setup's approved plan card names them): say in your reply which you added, so people can approve or correct them. Near-duplicates come back as a warning and nothing is added.",
  inputSchema: { type: 'object', properties: { key: { type: 'string' }, values: VALUES, force: FORCE }, required: ['key', 'values'] },
};

export const REGISTER_PROPERTY_KEY = {
  name: 'register_property_key',
  description:
    'Propose a new key for this scheme (or, from the Citadel scheme only, a global key with global: true). New keys wait for a person to approve them in Orders → Properties, so ask people first; while setup or a tune-up is open, keys and values the approved plan card names go in approved. Keys are camelCase.',
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
};

export const GET_PROJECT_INSTRUCTIONS = {
  name: 'get_project_instructions',
  description: 'Read the scheme instructions: the standing rules people set for this scheme, which every minion and you receive in the system prompt.',
  inputSchema: { type: 'object', properties: {} },
};

export const SET_PROJECT_INSTRUCTIONS = {
  name: 'set_project_instructions',
  description:
    "Replace the scheme instructions with new text (max 32,000 characters; empty clears them). They reach every minion, and you, from its next turn. Read the current text first and send the whole new version, not just the change. New words that repeat a registered rule or text elsewhere are refused with the list: have a Sonnet Grunt judge each, then work them in, or save anyway with repeats_ok and its verdicts as overlaps. To register a scheme rule's one home (a member asks, or offer it on a card when you write a standing rule), start a minion to add it to the scheme repo's `.claude/rule-homes.json` (`citadel:writing-for-agents`, Pruning).",
  inputSchema: {
    type: 'object',
    properties: {
      instructions: { type: 'string', maxLength: 32000, description: 'The whole new text, at most 32,000 characters' },
      repeats_ok: { type: 'boolean', description: 'Save even though the new words repeat a registered rule or text elsewhere (the refusal lists them). Only when the repeat is on purpose, and with overlaps.' },
      overlaps: { type: 'array', maxItems: 30, items: { type: 'string' }, description: "With repeats_ok: your Sonnet Grunt's verdict on each place the refusal listed, one line each: where, repeats / conflicts / fine, and why" },
    },
    required: ['instructions'],
  },
};

export const GET_PROJECT_SETTINGS = {
  name: 'get_project_settings',
  description:
    "Read the scheme's approval rules (Claude Code permission rules a minion must get a person's OK for, via an Approve / Deny card in its chat), plugin folders (folders in the repo every minion loads as Claude Code plugins), optional plugin folders (loaded only by a minion that picks them, with create_ticket's plugin_folders), quiet CI workflows (whose red scheduled or dispatched runs don't message the Taskmaster), watched CI workflows (whose first red run on the default branch in a red streak wakes the Taskmaster) and default effort (what a minion without its own effort runs at).",
  inputSchema: { type: 'object', properties: {} },
};

export const SET_PROJECT_SETTINGS = {
  name: 'set_project_settings',
  description:
    "Replace the approval rules, plugin folders, optional plugin folders, quiet CI workflows, watched CI workflows, default effort, fast mode, screenshot widths, themes, requirement and note, onboarding step, and/or the name and repo URL of this scheme; leave out what should stay, and send the whole new list, not just the change (an empty list clears it, except screenshot widths and themes, which keep at least one). They apply from each minion's next turn. Only change them when people ask, or (onboarding) as setup moves along.",
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
        description: 'Folder paths relative to the repo root, e.g. "tools/mods/delve", or absolute. Each is loaded with --plugin-dir when it exists (a relative one in the minion\'s worktree).',
      },
      optional_plugin_folders: {
        type: 'array',
        items: { type: 'string' },
        description: 'Plugin folders, as plugin_folders, that a minion loads only when it picks them (create_ticket or update_ticket plugin_folders, or its composer): for plugins too costly for every minion, like Chrome DevTools. Admin-only, as plugin_folders.',
      },
      quiet_workflows: {
        type: 'array',
        items: { type: 'string' },
        description:
          "Workflow file names, like drift.yml, to leave unwatched: every other workflow that goes red on the default branch wakes you once per red streak, puts a quiet item in people's Mandate, and rings them if no fix minion names the run within an hour. A quiet one does none of that. A minion that dispatched a run on its own branch still hears that run's result.",
      },
      watch_workflows: {
        type: 'array',
        items: { type: 'string' },
        description:
          "Workflow file names, like desktop.yml, to watch on the default branch even when quiet_workflows lists them (every workflow is watched unless quiet): when one's newest finished run there fails, you're woken once for that red streak (any trigger, lands' pushes too), and get held mail when it's back to green.",
      },
      default_effort: { ...EFFORT, description: "Effort for every minion's turns that has none of its own. null leaves it to Claude Code's default." },
      land_mode: {
        type: 'string',
        enum: ['off', 'fast'],
        description: "fast: low and medium lands go live on the smoke check alone and the full suite runs on main behind them (a red reopens the minion that broke it); high-risk and pipeline changes keep the full gate. Only when a member asks. Refused until the scheme's tools/land.sh is re-synced from the kit.",
      },
      fable_ok: { type: 'string', enum: ['on', 'off'], description: "off: no Fable in this scheme, for any session or Grunt; the Taskmaster's model table, the model picker and the Grunt rule drop it. Only when a member asks." },
      builds: { type: 'string', enum: ['suggest', 'off'], description: "off: this scheme doesn't use numbered builds, so its Taskmaster never suggests one. Only when a member asks." },
      grill: { type: 'string', enum: ['design', 'all', 'never'], description: "Grilling before code: design (citadel:grilling's rule, design-shaped features only), all (every feature), never. Only when a member asks." },
      gh_runners: { type: 'string', enum: ['ask', 'ok', 'never'], description: "CI on GitHub's own runners is free on a public repo but may cost Actions minutes (private repo or larger runners): ask a person first (default), ok to use, never. Only when a member asks." },
      screenshot_widths: { type: 'array', items: { type: 'integer', minimum: 200, maximum: 5000 }, description: 'Pixel widths a minion shoots a UI change at, like [1440, 390]; tools/ui-shot.ts takes them as its default --widths.' },
      screenshot_themes: { type: 'array', items: { type: 'string', enum: ['light', 'dark'] }, description: "Themes a minion shoots a UI change in; ui-shot's default --themes." },
      screenshots_required: { type: 'boolean', description: "true (the default): a minion's ready note for a UI change carries its screenshots." },
      screenshot_note: { type: 'string', maxLength: 200, description: 'One line added to the screenshot rule, e.g. "1x in her window (1600×900)"; empty clears it.' },
      ship_path: {
        type: 'string',
        enum: ['citadel', 'pr-auto', 'pr-minion', 'pr-person'],
        description:
          "Shipping (Minion rules): how a change ships. citadel: hand_off_land runs the scheme's tools/land.sh; pr-auto: a pull request that auto-merges once CI is green; pr-minion: a pull request the minion merges itself with gh pr merge --squash once CI is green, for a repo whose allow_auto_merge isn't true (a private repo on a free plan); pr-person: a pull request a person merges (its go is from every change). Every minion's prompt states it, and it wins over the scheme instructions. Set at setup from \"How changes ship\", or when a member asks.",
      },
      go_from: {
        type: 'string',
        enum: ['never', 'high', 'medium', 'all'],
        description:
          'From which self-review risk label a change waits for a member\'s go before it ships: never, high, medium (and up) or all. On a pull-request path, all turns the merge approval on and the others turn it off, so the two never disagree; hand_off_land refuses without go at or above it, except a bug fix\'s fix_proof below all (self-review skill, "The go threshold").',
      },
      try_first: { type: 'string', enum: ['never', 'ui', 'features'], description: 'What waits for a person to try it before it ships: never (ships when green), ui (a change to the front-end files Project facts lists) or features (every type feature).' },
      onboarding: { type: 'string', enum: ['interview', 'planned', 'setting-up', 'done', 'skipped'], description: "Where the scheme's setup stands; the scheme header shows it until done or skipped." },
      name: { type: 'string', description: 'Rename this scheme (never another). Refused if another scheme has the name. Nothing else changes: everything goes by the scheme\'s id, and your chat gets a note. Old "<scheme> #N" text keeps the old name.' },
      repo_url: { type: 'string', description: "Record this scheme's repo URL (https:// or git@). Clones nothing and re-points no checkout: a person still clones it into the repo folder, sets up the push guard and gives Citadel GitHub access. Refused when one is set, unless replace_repo is true." },
      replace_repo: { type: 'boolean', description: 'true to let repo_url replace a repo that is already set.' },
      onboarding_mode: { type: 'string', enum: ['first-run', 'tune-up'], description: 'tune-up, with onboarding interview, when people ask you to tune up this scheme: it brings back your onboarding section, for a scheme that is set up already.' },
    },
  },
};

export const READ_PERSON_INSTRUCTIONS = {
  name: 'read_person_instructions',
  description: "Read a person's own instructions: their text for everywhere and for this scheme, which load into the minions assigned to them, never into your prompt. Read them before starting a minion for that person, and follow what they say about its model, effort and brief.",
  inputSchema: { type: 'object', properties: { person: { type: 'string', description: "The person's name or login, as in `assigned`" } }, required: ['person'] },
};

export const APP_INSTRUCTION_TOOLS = [
  {
    name: 'get_app_instructions',
    description: `Read the ${APP_NAME}-wide instructions: the standing rules people set for every scheme, which every minion and Taskmaster in every scheme receives in its system prompt, right before its scheme instructions.`,
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'set_app_instructions',
    description: `Replace the ${APP_NAME}-wide instructions with new text (max 32,000 characters; empty clears them). They reach every minion and Taskmaster in every scheme from its next turn. Read the current text first and send the whole new version, not just the change; new words that repeat a registered rule or text elsewhere are refused with the list: have a Sonnet Grunt judge each, then work them in, or save anyway with repeats_ok and its verdicts as overlaps. A scheme instruction overrides one of these only where it names the rule it replaces. Only on a turn a ${APP_NAME} admin asked for.`,
    inputSchema: {
      type: 'object',
      properties: {
        instructions: { type: 'string', maxLength: 32000, description: 'The whole new text, at most 32,000 characters' },
        repeats_ok: { type: 'boolean', description: 'Save even though the new words repeat a registered rule or text elsewhere (the refusal lists them). Only when the repeat is on purpose, and with overlaps.' },
        overlaps: { type: 'array', maxItems: 30, items: { type: 'string' }, description: "With repeats_ok: your Sonnet Grunt's verdict on each place the refusal listed, one line each: where, repeats / conflicts / fine, and why" },
      },
      required: ['instructions'],
    },
  },
];

/** Putting an item in the asking person's Mandate (#268): every minion and Taskmaster; the server checks whom for. */
/** The scheme's review set (src/review-set.ts, Build 4): read it, or save what a person's verdict taught a critic (citadel:critique step 9). */
/** The fields of a review entry the Taskmaster sets besides its text: only those passed, so a save never blanks the rest (the store checks them). */
export const reviewFields = (args: Record<string, unknown>) => Object.fromEntries(['kind', 'name', 'when', 'model', 'effort', 'panel', 'on_fail', 'context'].filter((k) => args[k] !== undefined).map((k) => [k, args[k]]));

/** The kinds of refuted finding a scheme is counting (#1158), one line each: what a minion reads to reuse their words. */
const countedText = (ls: Counted[]) => (ls.length ? ls.map((l) => `- ${l.kind}: ${l.count}${l.count >= 3 ? ' (a lesson)' : ''}, last ${pacificDay(l.last)}: ${l.why}`).join('\n') : '(none yet)');

export const REVIEW_SET = {
  name: 'review_set',
  description:
    "This scheme's reviewers and critics (its review set, on the Reviewers and critics page). With no slug: one line per entry (slug, on or off, trial, when it runs). With a slug: that entry's whole rubric as the critic reads it, its version and its own body. To save what a person's verdict taught it (citadel:critique step 9), pass slug, body (the entry's own text, whole, with your edit made: frontmatter keys besides name, extends, when, model and effort, then its sections; never the kit starter's text) and version (the one you read). A save is a new version people see in History. The kit's own reviewers (pre-ship review, its lenses, finding checker, fresh eyes, professor) are entries too, marked kit: a scheme switches them and adds to their text (body), and their own text stays in the kit. The scheme's own reviewing agents in its repo (.claude/agents/*.md, found by name and description, or a `kind:` frontmatter line; `kind: none` leaves one off) are entries too, marked agent_file, the same way: their text stays in the file. After a calibration run (citadel:critique, references/calibrate.md), pass slug and calibration with its counts: it is recorded on the entry, and an entry on trial comes off it when most notes hit and nothing false-alarmed. A minion saves only the body and calibrations; the on/off and trial switches, when and names are for people and the Taskmaster, who may also pass enabled or trial. A Taskmaster can also set an entry's kind (critic, reviewer, checker, referee, teacher, audit), name, model, effort, panel, on_fail (hand-offs: [{after: 2, to: art-professor}, {after: 3, to: person}]; `to` is professor, person or another entry's slug; an empty list clears them) and context ({guides: [{label, href}], paths, verdicts, requester}, whole: it replaces the old one), on add or on a save, with the same checks as the page; each save is a version in History. A teacher entry holds a scheme's own rules for fixes: a critic whose on_fail names it hands a stubborn fail to citadel:professor with that entry's text (kind teacher, extends the kit's teacher starter). A Taskmaster adds an entry with add: true and extends (a kit starter from citadel:critique's rubrics/, e.g. for a setup plan's picks) or a new slug, with when and body as needed; a new entry starts on trial. After each round you run of an entry (a critic, a reviewer, a referee), pass slug and run with the round and its verdict: the page's dots and pass rate come from these, and a blocking entry's last fail or ask on you holds your ship until a later round passes. A teacher's run (the kit's professor, or a teacher entry) is the critic round after its fix, one per item it fixed: pass if the item passed that round, else fail; the page shows how often its fixes held. After the finding checker refutes findings on a deep review, pass slug pre-ship-review and refuted, one {kind, why} per refuted finding: a kind refuted in three minions' reviews or more (one minion's rounds count once), with no 30-day gap, becomes a lesson the scheme's later reviews read. Reading pre-ship-review lists the kinds being counted, to reuse their words.",
  inputSchema: {
    type: 'object',
    properties: {
      slug: { type: 'string', description: "The entry's slug, e.g. ui-screenshots" },
      body: { type: 'string', description: "The entry's own text, whole, with your edit made" },
      version: { type: 'integer', description: 'The version you read; a save over a newer one is refused, so read it again' },
      note: { type: 'string', description: 'What changed, a few words for History, e.g. "Calibration board: Josh passed long labels"' },
      enabled: { type: 'boolean', description: 'Taskmaster only: turn it on or off' },
      trial: { type: 'boolean', description: 'Taskmaster only: put it on trial or take it off' },
      calibration: {
        type: 'object',
        description: "A calibration run's counts, sent on their own: hits out of notes (the person's notes the critic caught), false_alarms out of controls (work they passed that it failed), and the model it ran on",
        properties: { hits: { type: 'integer' }, notes: { type: 'integer' }, false_alarms: { type: 'integer' }, controls: { type: 'integer' }, model: { type: 'string' } },
        required: ['hits', 'notes', 'false_alarms', 'controls'],
      },
      kind: { type: 'string', enum: ['critic', 'reviewer', 'checker', 'referee', 'teacher', 'audit'], description: "Taskmaster only: what the entry is. A teacher is handed a critic's stubborn fails by on_fail" },
      name: { type: 'string', description: 'Taskmaster only: the name the page shows, 1 to 80 characters' },
      model: { type: ['string', 'null'], description: "Taskmaster only: opus, sonnet or haiku; empty for the format's default" },
      effort: { type: ['string', 'null'], description: "Taskmaster only: low, medium or high; empty for the format's default" },
      panel: { type: ['string', 'null'], description: 'Taskmaster only: a panel name (up to 40 characters); empty for none' },
      on_fail: {
        type: ['array', 'null'],
        description: 'Taskmaster only: hand-offs after failed rounds, up to 4, rising: [{after: 2, to: art-professor}, {after: 3, to: person}]. `to` is professor, person, or the slug of another entry in this scheme. [] clears them',
        items: { type: 'object', properties: { after: { type: 'integer' }, to: { type: 'string' } }, required: ['after', 'to'] },
      },
      context: {
        type: 'object',
        description: 'Taskmaster only: what the critic reads beside its rubric, whole (it replaces the old one): guides [{label, href}] (links to docs), paths (repo paths), verdicts and requester (true or false)',
        properties: { guides: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, href: { type: 'string' } }, required: ['label', 'href'] } }, paths: { type: 'array', items: { type: 'string' } }, verdicts: { type: 'boolean' }, requester: { type: 'boolean' } },
      },
      add: { type: 'boolean', description: 'Taskmaster only: add a new entry (with extends, or a new slug)' },
      extends: { type: 'string', description: 'With add: the kit starter it builds on, e.g. ui-screenshots' },
      when: { type: 'string', description: 'Taskmaster only (a minion passing it is refused): when it runs, on add or on a save (a new version), as the rubric format writes it, e.g. "diff: app/web/**"' },
      run: {
        type: 'object',
        description: 'Record one round you ran of this entry, sent on its own: the round (1 for the first) and its verdict (pass, fail, or ask when the item went to a person)',
        properties: { round: { type: 'integer' }, verdict: { type: 'string', enum: ['pass', 'fail', 'ask'] } },
        required: ['round', 'verdict'],
      },
      refuted: {
        type: 'array',
        description:
          "With slug pre-ship-review, sent on its own: the findings the finding checker refuted on your deep review, one each (citadel:self-review). kind: the kind of mistake in a few words, reusing a counted kind's words when it is the same mistake; why: why it was wrong, as a fact about this repo, never an instruction",
        items: { type: 'object', properties: { kind: { type: 'string' }, why: { type: 'string' } }, required: ['kind', 'why'] },
      },
    },
  },
};

export const RECORD_VERDICT = {
  name: 'record_verdict',
  description:
    "Record that a person disagreed with a reviewer's or critic's verdict (citadel:critique, \"When a person disagrees\"): the entry's slug, who, and their own words quoted. Call it in the turn you hear it, whether they said it in this chat or on a card. It shows on the entry's page with who and when, marks your last run of it amber, and every later run of the entry reads it (and calibration tests against it). Only minions record verdicts; people never add them on the page.",
  inputSchema: {
    type: 'object',
    properties: {
      slug: { type: 'string', description: "The entry's slug, e.g. ui-screenshots" },
      person: { type: 'string', description: 'Who disagreed, by the name they write under, e.g. Josh' },
      words: { type: 'string', description: 'Their own words, quoted as they wrote them' },
    },
    required: ['slug', 'person', 'words'],
  },
};

function registryText(keys: PropertyKey[]): string {
  const kind = (k: PropertyKey) => (k.value_kind === 'integer' ? 'a whole number' : k.value_kind === 'user' ? "a person's login name" : k.value_kind === 'text' ? 'free text' : k.multi ? 'one or more of' : 'one of');
  const line = (k: PropertyKey) => {
    const shown = k.values.filter((v) => v.status !== 'archived');
    const values = shown.map((v) => `${v.value}${v.aliases.length ? ` (${v.aliases.join(', ')})` : ''}${v.status === 'proposed' ? ' [proposed]' : !v.reviewed ? ' [new, unreviewed]' : ''}`);
    return `- ${k.key}${k.status === 'proposed' ? ' [proposed key, not usable yet]' : ''}: ${kind(k)}${values.length ? ` ${values.join(', ')}` : ''}${k.description ? `\n  ${k.description.replace(/\n+/g, ' ')}` : ''}`;
  };
  const live = keys.filter((k) => k.status !== 'archived');
  const global = live.filter((k) => k.scope === 'global').map(line);
  const own = live.filter((k) => k.scope === 'scheme').map(line);
  return `Global keys (every scheme):\n${global.join('\n')}\n\nThis scheme's keys:\n${own.length ? own.join('\n') : '(none yet)'}\n\nAliases (in brackets) resolve to their value. Show properties as key: value.`;
}

/** A registry call's answer: what happened, plus any warnings or follow-ups for the caller. */
function registryReply(r: RegistryReply, done: string): string {
  if (r.warnings?.length) return `Nothing changed; it looks like a near-duplicate:\n${r.warnings.map((w: string) => `- ${w}`).join('\n')}`;
  return [done, ...(r.notes ?? [])].join('\n');
}

export const MINION_SET_PROPERTIES = {
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
};

/**
 * The overlap check a person's Settings save gets (#1162), before the Taskmaster saves rule text (#1211): refused with
 * what already says the new words. Like a Settings save's Sonnet check, its own Sonnet Grunt judges the hits (Josh,
 * 2026-11-20: "Yes, its own Grunt"), and repeats_ok saves past them only with the Grunt's verdicts as `overlaps`.
 */
async function repeatsFirst(scope: 'citadel' | 'scheme', args: Record<string, unknown>): Promise<string> {
  const text = wholeText(args);
  const judged: string[] = Array.isArray(args.overlaps) ? args.overlaps.filter((l: unknown): l is string => typeof l === 'string' && !!l.trim()).map((l: string) => l.trim().slice(0, 300)) : [];
  let found: { label: string; line?: number; href?: string; excerpt: string; why: string }[];
  // Like a Settings save, a check that fails never blocks the save: it says so instead.
  try {
    ({ found } = await call<{ found: typeof found }>('POST', `/api/projects/${C().PROJECT}/instructions/overlaps`, { scope, text }));
  } catch (err) {
    return ` The repeat check didn't run (${thrown(err).message}), so nothing was checked.`;
  }
  if (!found.length) return '';
  if (args.repeats_ok === true && judged.length >= found.length) return `\nSaved past ${found.length} flagged place${found.length > 1 ? 's' : ''} on your Grunt's word; tell the person what it found:\n${judged.map((l) => `- ${l}`).join('\n')}`;
  const place = (o: (typeof found)[number]) => `${o.label}${o.line ? `, line ${o.line}` : ''}${o.href && /^https:/.test(o.href) ? ` (${o.href})` : ''}`;
  throw new Error(
    [
      args.repeats_ok === true ? `repeats_ok needs your Grunt's verdict on each place as overlaps (${found.length} listed, ${judged.length} given). Nothing was saved.` : `Nothing was saved: a word matcher flagged places that may already say the new words.`,
      ...found.map((o) => `- ${place(o)}: "${o.excerpt}" It ${o.why}.`),
      `First have a Sonnet Grunt judge each against the new words (for a registered rule, against its home): repeats, conflicts, or fine (only shared wording). Put what it marks where it is already said, or point there in a few words. To save anyway, call again with repeats_ok: true and its verdicts as overlaps, one line per place.`,
    ].join('\n'),
  );
}

/** The text of a replace-it-all tool. Only an explicit string counts: a missing or misnamed argument must never mean "clear". */
function wholeText(args: Record<string, unknown>): string {
  if (typeof args.instructions !== 'string') {
    throw new Error(`instructions is required and must be text: send the whole new text. Nothing was changed. To clear it on purpose, pass instructions: "" (an empty string).`);
  }
  return args.instructions;
}

/** Answers this family's tools; NOT_HERE for any other. */
export async function runSchemeTool(name: string, args: Record<string, unknown>): Promise<string | typeof NOT_HERE> {
  switch (name) {
    case 'read_person_instructions': {
      if (typeof args.person !== 'string' || !args.person.trim()) throw new Error('person is required: their name or login.');
      const r = await call('GET', `/api/projects/${C().PROJECT}/people/${encodeURIComponent(args.person.trim())}/instructions`);
      if (!r.everywhere && !r.scheme) return `${r.name} has no instructions of their own.`;
      return [r.everywhere && `${r.name}'s instructions for everywhere:\n\n${r.everywhere}`, r.scheme && `${r.name}'s instructions for this scheme (after the ones for everywhere):\n\n${r.scheme}`].filter(Boolean).join('\n\n');
    }
    case 'list_properties': {
      const { keys } = await call<{ keys: PropertyKey[] }>('GET', `/api/projects/${C().PROJECT}/properties`);
      return registryText(keys);
    }
    case 'set_properties': {
      if (!args.properties || typeof args.properties !== 'object' || Array.isArray(args.properties) || !Object.keys(args.properties).length) {
        throw new Error('properties is required: an object of key: value (null clears a key). Nothing was changed.');
      }
      const target = C().ROLE === 'thread' ? C().TICKET : await id(args);
      const r = await call<RegistryReply>('PUT', `/api/tickets/${target}/properties`, { properties: args.properties, file: args.file ?? null });
      // A minion that just made itself a feature reads the done-lines rule here (#1574).
      const feature = C().ROLE === 'thread' && !args.file && r.properties?.type === 'feature' && Object.keys(args.properties).some((k) => k.toLowerCase() === 'type');
      return registryReply(r, `Set. ${propertyText(r.properties) || '(no properties)'}${feature ? `\n${DONE_LINES}` : ''}`);
    }
    case 'register_property_values': {
      const r = await call<RegistryReply & { added: string[]; updated: string[]; unreviewed?: string[] }>('POST', `/api/projects/${C().PROJECT}/properties/values`, { key: args.key, values: args.values, force: !!args.force });
      const parts = [r.added.length ? `Added ${r.added.map((v: string) => `${args.key}: ${v}`).join(', ')}` : '', r.updated.length ? `updated ${r.updated.join(', ')}` : ''].filter(Boolean).join('; ');
      return registryReply(r, `${parts || 'No change'}.${r.unreviewed?.length ? ` ${r.unreviewed.join(', ')} ${r.unreviewed.length === 1 ? 'is' : 'are'} live but unreviewed: tell people in your reply what you added, so they can approve or correct it.` : ''}`);
    }
    case 'register_property_key': {
      const r = await call<RegistryReply>('POST', `/api/projects/${C().PROJECT}/properties/keys`, args);
      return registryReply(r, r.status === 'active' ? `Registered ${args.key}: your approved setup plan lists it, so it is live with no further approval.` : `Proposed ${args.key}; it waits for a person to approve it in Orders → Properties. Tell people in your reply.`);
    }
    case 'get_project_instructions': {
      const { project } = await call<{ project: ProjectView }>('GET', `/api/projects/${C().PROJECT}?tickets=none`); // the scheme's fields, not every minion's view (#1514)
      if (!project.instructions) return 'This scheme has no instructions yet.';
      const by = project.instructions_updated_by ? ` (last changed by ${project.instructions_updated_by})` : '';
      return `Scheme instructions${by}:\n\n${project.instructions}`;
    }
    case 'get_project_settings': {
      const { project } = await call<{ project: ProjectView }>('GET', `/api/projects/${C().PROJECT}?tickets=none`); // the scheme's fields, not every minion's view (#1514)
      const show = (text: string) =>
        text
          ? text
              .split('\n')
              .map((l) => `- ${l}`)
              .join('\n')
          : '(none)';
      return `Approval rules (need a person's OK):\n${show(project.approval_rules)}\n\nPlugin folders (every minion):\n${show(project.plugin_dirs)}\n\nOptional plugin folders (only minions that pick them, with plugin_folders on create_ticket or update_ticket):\n${show(project.optional_plugin_dirs)}\n\nQuiet CI workflows (their red scheduled or dispatched runs don't message the Taskmaster):\n${show(project.ci_quiet ?? '')}\n\nWatched CI workflows (their first red run on the default branch in a streak wakes the Taskmaster):\n${show(project.ci_watch ?? '')}\n\nDefault effort: ${project.default_effort || "Claude Code's default"}\n\nShipping: ship_path ${project.ship_path}; a person's go from: ${project.go_from}; try it first: ${project.try_first}\n\nFast mode (land now, test behind): ${project.land_mode === 'fast' ? 'on' : 'off'}\n\nFable: ${project.fable_ok === 'off' ? 'off' : 'on'}; numbered builds: ${project.builds}; grill before code: ${project.grill}; GitHub's own runners: ${project.gh_runners}\n\nScreenshots: widths ${project.shot_widths}, themes ${project.shot_themes}, ${project.shots_required ? 'required in the ready note' : 'not required'}${project.shot_note ? `, note: ${project.shot_note}` : ''}`;
    }
    case 'set_project_settings': {
      const body: Record<string, unknown> = {};
      if (args.approval_rules !== undefined) body.approval_rules = args.approval_rules;
      if (args.plugin_folders !== undefined) body.plugin_dirs = args.plugin_folders;
      if (args.optional_plugin_folders !== undefined) body.optional_plugin_dirs = args.optional_plugin_folders;
      if (args.quiet_workflows !== undefined) body.ci_quiet = args.quiet_workflows;
      if (args.watch_workflows !== undefined) body.ci_watch = args.watch_workflows;
      if (args.default_effort !== undefined) body.default_effort = args.default_effort;
      if (args.land_mode !== undefined) body.land_mode = args.land_mode;
      for (const k of ['fable_ok', 'builds', 'grill', 'gh_runners'] as const) if (args[k] !== undefined) body[k] = args[k];
      if (args.screenshot_widths !== undefined) body.shot_widths = args.screenshot_widths;
      if (args.screenshot_themes !== undefined) body.shot_themes = args.screenshot_themes;
      if (args.screenshots_required !== undefined) body.shots_required = args.screenshots_required;
      if (args.screenshot_note !== undefined) body.shot_note = args.screenshot_note;
      for (const k of ['ship_path', 'go_from', 'try_first'] as const) if (args[k] !== undefined) body[k] = args[k];
      if (args.ship_path === 'pr-auto') await refuseWithoutAutoMerge(args.repo_url);
      if (args.onboarding !== undefined) body.onboarding = args.onboarding;
      if (args.onboarding_mode !== undefined) body.onboarding_mode = args.onboarding_mode;
      if (args.name !== undefined) body.name = args.name;
      if (args.repo_url !== undefined) {
        body.repo_url = args.repo_url;
        if (args.replace_repo === true) body.replace_repo = true;
      }
      if (!Object.keys(body).length)
        throw new Error(
          'Pass approval_rules, plugin_folders, optional_plugin_folders, quiet_workflows, watch_workflows, default_effort, land_mode, fable_ok, builds, grill, gh_runners, screenshot_widths, screenshot_themes, screenshots_required, screenshot_note, ship_path, go_from, try_first, onboarding, onboarding_mode, name, repo_url or a mix',
        );
      const project = await call<ProjectView>('PATCH', `/api/projects/${C().PROJECT}`, body);
      const n = (text: string) => (text ? text.split('\n').length : 0);
      return `Saved: ${n(project.approval_rules)} approval rule(s), ${n(project.plugin_dirs)} plugin folder(s), ${n(project.optional_plugin_dirs)} optional plugin folder(s), ${n(project.ci_quiet ?? '')} quiet CI workflow(s), ${n(project.ci_watch ?? '')} watched CI workflow(s), default effort ${project.default_effort || "Claude Code's default"}, fast mode ${project.land_mode === 'fast' ? 'on' : 'off'}, Fable ${project.fable_ok}, builds ${project.builds}, grill ${project.grill}, GitHub runners ${project.gh_runners}, screenshots ${project.shot_widths} px in ${project.shot_themes}, shipping ${project.ship_path} with a go from ${project.go_from} and try first ${project.try_first}, onboarding ${project.onboarding} (${project.onboarding_mode}). They apply from each minion's next turn.${args.repo_url !== undefined ? ` Repo recorded as ${project.repo_url}: nothing was cloned, so a person still clones it into the repo folder, sets up the push guard and gives Citadel GitHub access. With a checkout already there, the URL reverts at the next restart until the checkout's origin is re-pointed.` : ''}`;
    }
    case 'get_app_instructions': {
      const app = await call<{ text: string; by?: string }>('GET', '/api/app/instructions');
      if (!app.text) return `The ${APP_NAME}-wide instructions are empty.`;
      return `${APP_NAME}-wide instructions${app.by ? ` (last changed by ${app.by})` : ''}:\n\n${app.text}`;
    }
    case 'set_app_instructions': {
      const unchecked = await repeatsFirst('citadel', args);
      const app = await call<{ text: string }>('PUT', '/api/app/instructions', { text: wholeText(args) });
      return (app.text ? `Saved (${app.text.length} characters). ${instructionCost(app.text)}` : `Cleared the ${APP_NAME}-wide instructions.`) + unchecked;
    }
    case 'review_set': {
      if (args.add) {
        const e = await call('POST', `/api/projects/${C().PROJECT}/reviews`, { slug: args.slug, extends: args.extends, when: args.when, body: args.body, ...reviewFields(args) });
        return `Added ${e.slug} (on trial): ${e.when}.`;
      }
      if (!args.slug) {
        const { entries } = await call<{ entries: ReviewEntry[] }>('GET', `/api/projects/${C().PROJECT}/reviews`);
        return entries.length
          ? entries
              .map(
                (e) =>
                  `${e.slug} (${e.kind}, ${e.enabled ? 'on' : 'off'}${e.kit ? ', kit' : ''}${e.file ? `, agent_file ${e.file}` : ''}${e.trial ? ', trial' : ''}${e.gate === 'block' && !e.trial ? ', blocks' : ''}${e.panel ? `, panel ${e.panel}` : ''}${e.extends ? `, on kit ${e.extends}` : ''}${e.calibrated ? `, calibrated ${e.calibrated}` : ''}${e.rate != null ? `, ${e.rate}% first-round pass` : ''}): ${e.when}`,
              )
              .join('\n')
          : 'This scheme has no reviewers or critics in its set yet.';
      }
      const slug = encodeURIComponent(String(args.slug));
      if (args.run !== undefined) {
        const r = await call('POST', `/api/projects/${C().PROJECT}/reviews/${slug}/runs`, { round: (args.run as { round?: unknown; verdict?: unknown } | null)?.round, verdict: (args.run as { round?: unknown; verdict?: unknown } | null)?.verdict });
        return `Recorded round ${r.round} of ${args.slug}: ${r.verdict}.`;
      }
      if (args.refuted !== undefined) {
        if (args.slug !== 'pre-ship-review') throw new Error('refuted goes with slug pre-ship-review: the lessons are for its reviewer');
        const r = await call<{ counted: Counted[] }>('POST', `/api/projects/${C().PROJECT}/reviews/pre-ship-review/refutes`, { refuted: args.refuted });
        return `Recorded ${(args.refuted as unknown[]).length} refuted finding${(args.refuted as unknown[]).length === 1 ? '' : 's'}. Kinds counting (3 makes a lesson the reviewer reads):\n${countedText(r.counted)}`;
      }
      if (args.calibration !== undefined) {
        const e = await call('PATCH', `/api/projects/${C().PROJECT}/reviews/${slug}`, { calibration: args.calibration });
        return `Recorded on ${e.slug}: ${e.calibrated}.${e.trial ? ' It stays on trial (advises only).' : ''}`;
      }
      if (args.extends !== undefined) throw new Error('extends is only for add: true; a save cannot change what an entry builds on');
      const extra = reviewFields(args);
      if (args.body === undefined && args.enabled === undefined && args.trial === undefined && !Object.keys(extra).length) {
        const { entries } = await call<{ entries: ReviewEntry[] }>('GET', `/api/projects/${C().PROJECT}/reviews`);
        const e = entries.find((x) => x.slug === args.slug);
        if (!e) throw new Error(`No entry named ${args.slug}; review_set with no slug lists them`);
        if (e.kit)
          return `${e.slug}, version ${e.version}, the kit's ${e.name} (${e.enabled ? 'on' : 'off'} here): ${e.what} Its text is the kit's; this scheme's additions, what a save replaces:\n\n${e.body || '(none)'}${e.lessons ? `\n\nRefuted kinds counting (3 makes a lesson the reviewer reads; record with refuted, reusing a kind's words when it is the same mistake):\n${countedText(e.lessons)}` : ''}`;
        if (e.file) return `${e.slug}, version ${e.version}, agent_file ${e.file} (${e.enabled ? 'on' : 'off'} here): ${e.agent ? `${e.what ?? ''} Its text is the file's:\n\n${e.agent.text}\n----` : 'Its file is gone from the repo.'} This scheme's additions, what a save replaces:\n\n${e.body || '(none)'}`;
        return `${e.slug}, version ${e.version} (${e.updated_by} saved it). As the critic reads it:\n\n${e.text}\n---- Its own body, what a save replaces:\n\n${e.body}`;
      }
      const e = await call('PATCH', `/api/projects/${C().PROJECT}/reviews/${slug}`, { body: args.body, version: args.version, note: args.note, enabled: args.enabled, trial: args.trial, ...extra });
      return `Saved ${e.slug} as version ${e.version}.`;
    }
    case 'record_verdict': {
      const v = await call('POST', `/api/projects/${C().PROJECT}/reviews/${encodeURIComponent(String(args.slug))}/verdicts`, { person: args.person, words: args.words });
      return `Recorded on ${args.slug}: ${v.person}, "${v.words}". Its later runs read it.`;
    }
    case 'set_project_instructions': {
      const unchecked = await repeatsFirst('scheme', args);
      const project = await call<{ instructions: string }>('PATCH', `/api/projects/${C().PROJECT}`, { instructions: wholeText(args) });
      return (project.instructions ? `Saved (${project.instructions.length} characters). ${instructionCost(project.instructions)}` : 'Cleared the scheme instructions.') + unchecked;
    }
    case 'edit_instructions': {
      const r = await call<{ held?: number; found?: string[]; href: string; id: number; saved: string; edits: number; length: number }>('POST', `/api/tickets/${C().TICKET}/edit-instructions`, { scope: args.scope, edits: args.edits, overlaps: Array.isArray(args.overlaps) ? args.overlaps : [] });
      if (r.held)
        return `Nothing saved yet: the edit repeats what ${r.held === 1 ? 'one place already says' : `${r.held} places already say`}${r.found?.length ? ` (${r.found.join('; ')})` : ''}. A card asks the person to save anyway, work it in or cancel; its link is ${r.href}. Link every mention of it, e.g. [the card below](${r.href}). Its id is ${r.id}: if the edit is no longer wanted (you work it in another way, or a later edit replaces it), withdraw the card with settle_question question_id ${r.id}, or a person may still save it. End your turn; the answer comes as a message.`;
      return `Saved the ${r.saved} Settings text (${r.edits} edit${r.edits === 1 ? '' : 's'}, ${r.length} characters). It shows in Settings and its history, and applies from each minion's next turn. Self-review it and label its risk like any instruction change.`;
    }
    case 'list_schedules': {
      const { schedules } = await call<{ schedules: ScheduleInfo[] }>('GET', `/api/projects/${C().PROJECT}/schedules`);
      return schedules.length ? schedules.map(scheduleLine).join('\n') : 'Nothing scheduled.';
    }
    case 'schedule_minion': {
      const s = await call<ScheduleInfo>('POST', `/api/projects/${C().PROJECT}/schedules`, {
        name: args.name,
        cron: args.cron,
        brief: args.brief,
        type: args.type,
        model: args.model,
        effort: args.effort,
        min_minions: args.min_minions,
        gate_scope: args.gate_scope,
        once: args.once,
        category: args.category,
        trigger_count: args.trigger_count,
        trigger_kind: args.trigger_kind,
        trigger_gap_hours: args.trigger_gap_hours,
      });
      return `Scheduled. ${scheduleLine(s)}`;
    }
    case 'schedule_audit': {
      const s = await call<ScheduleInfo>('POST', `/api/projects/${C().PROJECT}/schedules`, { template: args.template, notes: args.notes });
      return `Scheduled. ${scheduleLine(s)}`;
    }
    case 'update_schedule': {
      const { schedule_id, ...patch } = args;
      needOne(patch, ['name', 'cron', 'brief', 'type', 'model', 'effort', 'min_minions', 'gate_scope', 'once', 'paused', 'template', 'notes', 'category', 'trigger_count', 'trigger_kind', 'trigger_gap_hours'], 'update_schedule');
      return `Updated. ${scheduleLine(await call<ScheduleInfo>('PATCH', `/api/schedules/${Number(schedule_id)}`, patch))}`;
    }
    case 'delete_schedule':
      await call('DELETE', `/api/schedules/${Number(args.schedule_id)}`);
      return 'Deleted.';
    default:
      return NOT_HERE;
  }
}

const runGh = promisify(execFile);

/** pr-auto only where GitHub can auto-merge (#2301): a private repo on a free plan can't, and its PRs sit green. Throws naming pr-minion unless the repo answers allow_auto_merge true. */
async function refuseWithoutAutoMerge(repoUrl: unknown): Promise<void> {
  const url = typeof repoUrl === 'string' ? repoUrl.trim() : (await call<{ project: ProjectView }>('GET', `/api/projects/${C().PROJECT}?tickets=none`)).project.repo_url;
  const slug = repoSlug(url ?? null);
  if (!slug) throw new Error("pr-auto needs the scheme's repo on GitHub, and this scheme has none: pick citadel or pr-person");
  const fallback = 'Use ship_path pr-minion (the minion merges once CI is green)';
  let answer: string;
  try {
    answer = (await runGh('gh', ['api', `repos/${slug}`, '--jq', '.allow_auto_merge'], { timeout: 20_000 })).stdout.trim();
  } catch (err) {
    const why = (thrown(err).stderr || thrown(err).message || '').toString().trim().slice(0, 200);
    throw new Error(`Not saved: couldn't ask GitHub whether ${slug} can auto-merge (${why}), and pr-auto only works where it can. ${fallback}, or set pr-auto from a turn whose gh login can push to the repo.`);
  }
  if (answer !== 'true') {
    throw new Error(
      `Not saved: ${slug} can't auto-merge (GitHub's allow_auto_merge: ${answer || 'empty'}; a private repo on a free plan can't, and GitHub shows the field only to people with push access), so pr-auto PRs would sit green. ${fallback}, or turn on "Allow auto-merge" in the repo's settings and set pr-auto again.`,
    );
  }
}
