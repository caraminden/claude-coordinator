// The model table (#698): which model and effort a new minion starts on, by the kind of work. The one copy:
// the Taskmaster's prompt (src/prompts.ts), create_ticket's and schedule_minion's descriptions (src/mcp.ts),
// the server's own starts (schedules, a start with no model: src/routes/projects.ts, src/schedules.ts)
// read it. Cara, 2026-11-14: "we should ALWAYS make an intentional choice
// about model". The tiers follow the Citadel-wide "Usage, effort and models" summary line; change both together. Josh, 2026-11-13, on Fable: "can we tighten the fable usage a bit, maybe use it about half as often? only for really complex or high risk things?" The Fable budget and the "every Taskmaster on Opus high" rule live in the Taskmaster's prompt beside tableText().

/** The Claude models a person can pick, with the names people read. */
export const CLAUDE_MODELS = [
  ['claude-opus-5-5', 'Opus 5.5'],
  ['claude-sonnet-5-5', 'Sonnet 5.5'],
  // The advisor trial (#817, Cara 2026-11-16 "Start the trial"): Sonnet runs the turn and consults Opus at hard points.
  // Experimental in Claude Code; to drop it, take this row and its TIERS row out (and from MODELS in src/db.ts, MODEL_IDS in src/mcp.ts).
  ['claude-sonnet-5-5+opus-advisor', 'Sonnet 5.5 + Opus advisor'],
  ['claude-haiku-5-5', 'Haiku 5.5'],
  ['claude-fable-5-1', 'Fable 5.1'],
  ['claude-fable-5-2', 'Fable 5.2'],
];
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** The tiers, in the order the prompt reads them: the work each covers, its model and effort, and when to move off it. */
export const TIERS = [
  // Known-shape middle work on Sonnet (Cara, 2026-11-14, "Widen to known-shape work"; "a sonnet minion can remove a link or move something somewhere I ask it to, but it cant build new screens").
  { work: 'chores (docs, instruction edits, config, renames, setup) and known-shape work (a bug with a clear repro and a known place to look, a small spec\'d tweak with no new data model or screen, a follow-up to a shipped change, adopting a handoff, a deploy or release, a doc or skill edit needing judgment)', model: 'claude-sonnet-5-5', effort: 'medium', then: 'if it stalls or the fix does not hold Opus 5.5 at medium, then high' },
  { work: 'a read-only check', model: 'claude-sonnet-5-5', effort: 'low' },
  // The advisor trial (#817) has its own row: it is over on its date, and taking the row out (and from MODELS in src/db.ts, MODEL_IDS in src/mcp.ts) ends it.
  { work: 'in the advisor trial (#817) until 2026-11-30, about 15 known-shape middle minions and about 5 small features with a clear spec that would otherwise get Opus high at medium, and a stalled Sonnet-medium minion before Opus medium, never a Taskmaster (`node tools/advisor-trial.ts` reads its numbers)', model: 'claude-sonnet-5-5+opus-advisor', effort: 'medium' },
  { work: 'design, ideation, new screens or data models, the ship pipeline, runner, tripwire, auth, migrations, multi-file refactors, art, a bug whose first repro failed', model: 'claude-opus-5-5', effort: 'high' },
  // Research on Opus medium (Cara, 2026-11-17, picked "Research on Opus medium" on #940's card): research minions spent $236 in a week on Opus high, and the vendor's curve for research is nearly flat from medium to high.
  { work: 'research', model: 'claude-opus-5-5', effort: 'medium', then: 'high if the report is thin or sent back' },
  { work: 'rarely: architecture of a big multi-part feature or build, security and risk reviews of a high-risk change, bugs that are intermittent or whose fix failed to hold', model: 'claude-fable-5-2', effort: 'medium' },
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
  research: { model: 'claude-opus-5-5', effort: 'medium' },
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

/** "Sonnet 5.5 medium" for a model and effort: the table's tier as people read it. */
export function tierLabel(model, effort) {
  const name = CLAUDE_MODELS.find(([id]) => id === model)?.[1] ?? model ?? 'default model';
  return effort ? `${name} ${effort}` : name;
}

/**
 * The "Picked because" line on a minion (#1061). `by` says who chose: 'table' (the table's pick for its type, from the Taskmaster's
 * call or a start with none), a person's name (they set it by hand), or 'step-up' (the Taskmaster changed it later).
 */
export function pickReason(by, type, model, effort) {
  const tier = tierLabel(model, effort);
  if (by === 'step-up') return `changed by the Taskmaster (a stall step-up or someone's ask): ${tier}`;
  if (by !== 'table') return `set by ${by}: ${tier}`;
  return type ? `${type} → ${tier}` : tier;
}

/**
 * The step-up for a stalled minion (#1139), following the tiers' `then` and the advisor row (test/stall-signals.test.ts
 * checks each step it names is a TIERS model): Sonnet → (the advisor, during its
 * trial) → Opus medium → Opus high → Fable medium → Fable xhigh ("xhigh stays for a Fable run that failed twice"). Null at the
 * top, with no model set, or a model outside the Claude families. `fable` false: the scheme has Fable off, so Opus high is the top.
 */
export function nextStep(model, effort, fable = true, today = new Date().toISOString().slice(0, 10)) {
  const rank = EFFORT_LEVELS.indexOf(effort ?? 'medium');
  const trial = (advisorTrialEnd() ?? '') >= today;
  if (!model) return null;
  if (/haiku/.test(model)) return { model: 'claude-sonnet-5-5', effort: 'medium' };
  if (/\+opus-advisor$/.test(model) || (/sonnet/.test(model) && !trial)) return { model: 'claude-opus-5-5', effort: 'medium' };
  if (/sonnet/.test(model)) return { model: 'claude-sonnet-5-5+opus-advisor', effort: 'medium' };
  if (/opus/.test(model) && rank < 2) return { model, effort: 'high' };
  if (/opus/.test(model)) return fable ? { model: 'claude-fable-5-2', effort: 'medium' } : null;
  if (/fable/.test(model) && rank < 3) return { model, effort: 'xhigh' };
  return null;
}

/** The table as one line of prose, for the Taskmaster's prompt. */
export function tableText(fable = true) {
  const tiers = TIERS.filter((t) => fable || !/fable/.test(t.model)).map((t) => `${t.work} ${t.model} at ${t.effort}${t.then ? `, ${t.then}` : ''}`).join('; ');
  // xhigh and max are in create_ticket's effort description, which every Taskmaster reads with the tool.
  return `${tiers}.${fable ? '' : ' Fable is off in this scheme: never pick it for a minion, a Grunt or a review; the nearest tier below it is Opus 5.5 at high.'}`;
}

/** The table as rows for the Models section (#1061): what a person reads of each tier, straight from TIERS. */
export function tierRows() {
  return TIERS.map((t) => ({ work: t.work, tier: tierLabel(t.model, t.effort), model: t.model, effort: t.effort, then: t.then ?? null }));
}

/** When the advisor trial ends, read from its TIERS row ("until 2026-11-30"), or null once the row is gone. */
export function advisorTrialEnd() {
  const row = TIERS.find((t) => /advisor/.test(t.model));
  return row ? /until (\d{4}-\d{2}-\d{2})/.exec(row.work)?.[1] ?? null : null;
}
