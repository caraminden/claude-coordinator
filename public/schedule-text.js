// What the Schedules page (#1083) reads out of a schedule's brief, and how its list groups: no DOM, so a test can import it.

/**
 * What it does, in a line or two: the brief's first paragraph that isn't a heading, cut at a sentence near 240 characters.
 * @param {string} brief
 */
export function briefSummary(brief) {
  const para =
    brief
      .split(/\n\s*\n/)
      .map((p) => p.replace(/\s+/g, ' ').trim())
      .find((p) => p && !p.startsWith('#')) ?? '';
  if (para.length <= 240) return para;
  const cut = para.slice(0, 240).match(/^.*[.!?:](?=\s)/)?.[0];
  return cut && cut.length > 60 ? cut : `${para.slice(0, 240).replace(/\s+\S*$/, '')}…`;
}

/** The skills its brief names: kit skills (citadel:name) and the repo's own (.claude/skills/name), each once.
 * @param {string} brief
 */
export function briefSkills(brief) {
  const kit = [...brief.matchAll(/\bcitadel:([a-z][a-z0-9-]*[a-z0-9])/g)].map((m) => `citadel:${m[1]}`);
  const own = [...brief.matchAll(/\.claude\/skills\/([a-z0-9][a-z0-9-]*)/g)].map((m) => m[1]);
  return [...new Set([...kit, ...own])];
}

/**
 * @typedef {object} ScheduleRow
 * @property {number} id
 * @property {boolean | number} paused
 * @property {number | null} [next_run_at]
 * @property {string | null} [category]
 * @property {unknown} [template]
 */

/** Standard audits, then the scheme's own; each split by category (Other last), paused ones last, the rest soonest first.
 * @template {ScheduleRow} S
 * @param {S[]} schedules
 * @returns {[string, string, [string, S[]][]][]}
 */
export function groupSchedules(schedules) {
  /** @type {(a: S, b: S) => number} */
  const order = (a, b) => Number(a.paused) - Number(b.paused) || (a.next_run_at ?? Infinity) - (b.next_run_at ?? Infinity) || a.id - b.id;
  /**
   * @param {S[]} rows
   * @returns {[string, S[]][]}
   */
  const byCategory = (rows) => {
    /** @type {Map<string, S[]>} */
    const m = new Map();
    for (const s of rows) {
      const c = s.category || 'Other';
      m.set(c, [...(m.get(c) ?? []), s]);
    }
    return [...m.entries()].sort(([a], [b]) => Number(a === 'Other') - Number(b === 'Other') || a.localeCompare(b)).map(([c, xs]) => /** @type {[string, S[]]} */ ([c, xs.sort(order)]));
  };
  return /** @type {[string, string, S[]][]} */ ([
    ['Standard audits', 'teal', schedules.filter((s) => s.template)],
    ["This scheme's own", 'running', schedules.filter((s) => !s.template)],
  ])
    .filter(([, , rows]) => rows.length)
    .map(([title, hue, rows]) => [title, hue, byCategory(rows)]);
}

// A schedule that was paused has no next run until the server gives one: null reads as "–", never as 1970 (WP9, #1858).
/** @type {(ms: number | null | undefined, opts: Intl.DateTimeFormatOptions) => string} */
const fmt = (ms, opts) => (ms == null ? '–' : new Date(ms).toLocaleString([], opts));
/** @param {number | null | undefined} ms */
export const when = (ms) => fmt(ms, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
/** @param {number | null | undefined} ms */
export const soon = (ms) => fmt(ms, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
/** The live schedule that runs next; one with no time yet is never "next". */
/**
 * @template {ScheduleRow} S
 * @param {S[]} live
 * @returns {S | null}
 */
export const nextSchedule = (live) => live.filter((s) => s.next_run_at != null).reduce((/** @type {S | null} */ a, s) => (a && /** @type {number} */ (a.next_run_at) <= /** @type {number} */ (s.next_run_at) ? a : s), null);
