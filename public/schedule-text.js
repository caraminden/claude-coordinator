// What the Schedules page (#1083) reads out of a schedule's brief, and how its list groups: no DOM, so a test can import it.

/** What it does, in a line or two: the brief's first paragraph that isn't a heading, cut at a sentence near 240 characters. */
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

/** The skills its brief names: kit skills (citadel:name) and the repo's own (.claude/skills/name), each once. */
export function briefSkills(brief) {
  const kit = [...brief.matchAll(/\bcitadel:([a-z][a-z0-9-]*[a-z0-9])/g)].map((m) => `citadel:${m[1]}`);
  const own = [...brief.matchAll(/\.claude\/skills\/([a-z0-9][a-z0-9-]*)/g)].map((m) => m[1]);
  return [...new Set([...kit, ...own])];
}

/** Standard audits, then the scheme's own; each split by category (Other last), paused ones last, the rest soonest first. */
export function groupSchedules(schedules) {
  const order = (a, b) => a.paused - b.paused || (a.next_run_at ?? Infinity) - (b.next_run_at ?? Infinity) || a.id - b.id;
  const byCategory = (rows) => {
    const m = new Map();
    for (const s of rows) {
      const c = s.category || 'Other';
      m.set(c, [...(m.get(c) ?? []), s]);
    }
    return [...m.entries()].sort(([a], [b]) => (a === 'Other') - (b === 'Other') || a.localeCompare(b)).map(([c, xs]) => [c, xs.sort(order)]);
  };
  return [
    ['Standard audits', 'teal', schedules.filter((s) => s.template)],
    ["This scheme's own", 'running', schedules.filter((s) => !s.template)],
  ]
    .filter(([, , rows]) => rows.length)
    .map(([title, hue, rows]) => [title, hue, byCategory(rows)]);
}

// A schedule that was paused has no next run until the server gives one: null reads as "–", never as 1970 (WP9, #1858).
const fmt = (ms, opts) => (ms == null ? '–' : new Date(ms).toLocaleString([], opts));
export const when = (ms) => fmt(ms, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
export const soon = (ms) => fmt(ms, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
/** The live schedule that runs next; one with no time yet is never "next". */
export const nextSchedule = (live) => live.filter((s) => s.next_run_at != null).reduce((a, s) => (a && a.next_run_at <= s.next_run_at ? a : s), null);
