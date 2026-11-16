// The model table (#698): which model and effort a new minion starts on, by the kind of work. The one copy:
// the Taskmaster's prompt (src/prompts.ts), create_ticket's and schedule_minion's descriptions (src/mcp.ts),
// the server's own starts (schedules, a start with no model: src/routes/projects.ts, src/schedules.ts) and the
// new-minion box (public/sidebar.js) all read it. Cara, 2026-11-14: "we should ALWAYS make an intentional choice
// about model". The tiers follow the Citadel-wide "Usage, effort and models" summary line; change both together. Josh, 2026-11-13, on Fable: "can we tighten the fable usage a bit, maybe use it about half as often? only for really complex or high risk things?" The Fable budget and the "every Taskmaster on Opus high" rule live in the Taskmaster's prompt beside tableText().

/** The Claude models a person can pick, with the names people read. */
export const CLAUDE_MODELS = [
  ['claude-opus-5-5', 'Opus 5.5'],
  ['claude-sonnet-5-5', 'Sonnet 5.5'],
  // The advisor trial (#817, Cara 2026-11-16 "Start the trial"): Sonnet runs the turn and consults Opus at hard points.
  // Experimental in Claude Code; to drop it, take this row out (and from MODELS in src/db.ts, MODEL_IDS in src/mcp.ts).
  ['claude-sonnet-5-5+opus-advisor', 'Sonnet 5.5 + Opus advisor'],
  ['claude-haiku-5-5', 'Haiku 5.5'],
  ['claude-fable-5-1', 'Fable 5.1'],
  ['claude-fable-5-2', 'Fable 5.2'],
];
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** The tiers, in the order the prompt reads them: the work each covers, its model and effort, and when to move off it. */
export const TIERS = [
  { work: 'a chore (docs, instruction edits, config, renames, checklists, setup)', model: 'claude-sonnet-5-5', effort: 'medium' },
  { work: 'a read-only check', model: 'claude-sonnet-5-5', effort: 'low' },
  // Known-shape middle work on Sonnet (Cara, 2026-11-14, "Widen to known-shape work"; "a sonnet minion can remove a link or move something somewhere I ask it to, but it cant build new screens").
  { work: 'middle work of known shape (a bug with a clear repro and a known place to look, a small feature or UI tweak with a clear spec and no new data model or screen, a follow-up to a shipped change, adopting a handoff, a deploy or release, a doc or skill edit needing judgment)', model: 'claude-sonnet-5-5', effort: 'medium', then: 'claude-opus-5-5 at medium if it stalls or the fix does not hold, then high' },
  { work: 'ordinary design, research that needs judgment, ideation, a bug whose first repro failed', model: 'claude-opus-5-5', effort: 'high', then: 'Fable only if that falls short' },
  { work: 'only architecture shaping a big multi-part feature or major build, security and risk reviews of a high-risk change, and bugs whose fix failed to hold or that are intermittent', model: 'claude-fable-5-2', effort: 'medium' },
  { work: 'everything else (a feature needing design, a new screen or data model, the land pipeline, runner, tripwire, auth or a migration, multi-file refactors, art)', model: 'claude-opus-5-5', effort: 'high' },
];

/**
 * The model and advisor a model setting launches with: `<model>+<advisor>-advisor` is `--model <model> --advisor <advisor>`
 * (#817). Any other value is the model alone. Read from the id itself, so a minion still set to an advisor
 * row that was taken out of CLAUDE_MODELS keeps launching.
 */
export function advisedModel(id) {
  const m = /^(.+)\+([a-z]+)-advisor$/.exec(id ?? '');
  return m ? { model: m[1], advisor: m[2] } : { model: id ?? null, advisor: null };
}

/** What a start that knows only the minion's `type` picks: the tier most work of that type falls in. */
export const BY_TYPE = {
  chore: { model: 'claude-sonnet-5-5', effort: 'medium' },
  bug: { model: 'claude-sonnet-5-5', effort: 'medium' },
  feature: { model: 'claude-opus-5-5', effort: 'high' },
  design: { model: 'claude-opus-5-5', effort: 'high' },
  research: { model: 'claude-opus-5-5', effort: 'high' },
  ideation: { model: 'claude-opus-5-5', effort: 'high' },
  art: { model: 'claude-opus-5-5', effort: 'high' },
};

/** When nothing tells the type (`other`, or no type yet). */
export const FALLBACK = { model: 'claude-opus-5-5', effort: 'medium' };

/** The model and effort for a minion of this type (a fresh object). */
export function pickFor(type) {
  return { ...(BY_TYPE[type] ?? FALLBACK) };
}

// Words that give a first message's kind of work away, checked in this order; the first hit wins.
const CLUES = [
  ['bug', /\b(bugs?|broken|breaks?|crash(es|ed|ing)?|errors?|fails?|failing|failed|doesn'?t work|does not work|not working|wrong|regression|stuck|fix(es)?)\b/i],
  ['chore', /\b(rename|typos?|docs?|readme|changelog|config|clean ?up|bump|tidy|checklist|ledger|update the (text|copy|docs?|prompt))\b/i],
  ['research', /\b(research|investigate|find out|look into|survey|compare|audit|why (does|is|do))\b/i],
  ['ideation', /\b(ideas?|brainstorm|ideate)\b/i],
  ['design', /\b(design|mock(-?ups?)?|wireframes?|layout)\b/i],
  ['art', /\b(art|sprites?|illustrations?|logo|artwork)\b/i],
  ['feature', /\b(add|build|make|new|support|show|let (me|people|us)|allow)\b/i],
];

/** A guess at a first message's `type` from its words, or null when nothing gives it away. */
export function guessType(text) {
  return CLUES.find(([, re]) => re.test(text ?? ''))?.[0] ?? null;
}

/** The advisor trial's brief to the Taskmaster (#817; handoff from #813), in create_ticket's and update_ticket's model description: whom it starts on the advisor. */
export const ADVISOR_TRIAL = 'claude-sonnet-5-5+opus-advisor is the advisor trial (#817): Sonnet runs the turn and consults Opus at hard points (~$0.35 a consult at an 85k context). Until its report ends it, start about 15 known-shape middle minions and about 5 small features with a clear spec that would otherwise get Opus high on it at medium, and move a stalled Sonnet-medium minion to it before Opus medium. Never a Taskmaster. `node tools/advisor-trial.ts` reads its numbers.';

/** The table as one line of prose, for the Taskmaster's prompt. */
export function tableText() {
  const tiers = TIERS.map((t) => `${t.work} ${t.model} at ${t.effort}${t.then ? `, ${t.then}` : ''}`).join('; ');
  // xhigh and max are in create_ticket's effort description, which every Taskmaster reads with the tool.
  return `${tiers}.`;
}
