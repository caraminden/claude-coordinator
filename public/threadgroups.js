// Sections of the threads list, as in Delve's Custom view: the current build (the lowest build any
// open thread is assigned to) on top, then the kinds of work, then later builds in ascending order.
// Threads in a build sit in its section whatever their kind. A thread's build is its build field, or
// else the "Build N" its title holds, as Delve titles do ("Lairs · Build #8", "Major Build #7").

const KINDS = ['feature', 'bug', 'design', 'process', null, 'idea']; // null: untagged, "Other"

/** [{ key, build?, current?, tag?, rows }] for open threads, empty sections left out. */
export function threadSections(open, knownTags) {
  const buildOf = (t) => t.build ?? Number(t.title?.match(/\bbuild #?(\d+)\b/i)?.[1] ?? 0);
  const builds = [...new Set(open.map(buildOf).filter(Boolean))].sort((a, b) => a - b);
  const buildSection = (build, i) => ({ key: `build-${build}`, build, current: i === 0, rows: open.filter((t) => buildOf(t) === build) });
  const kinds = KINDS.map((tag) => ({
    key: tag ?? 'other', tag, rows: open.filter((t) => !buildOf(t) && (knownTags.includes(t.tag) ? t.tag : null) === tag),
  }));
  return [...builds.slice(0, 1).map(buildSection), ...kinds, ...builds.slice(1).map((b, i) => buildSection(b, i + 1))]
    .filter((s) => s.rows.length);
}
