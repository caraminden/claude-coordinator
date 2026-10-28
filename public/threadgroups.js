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

/**
 * Whether a thread matches the search: its title, its number ("78" or "#78", exactly) or a property
 * value; "key: value" matches too, so "type: bug" finds bugs without "type" finding everything.
 */
export function threadMatches(t, query) {
  const q = query.toLowerCase();
  if (String(t.number ?? t.id) === q.replace(/^#/, '')) return true;
  const props = Object.entries(t.properties ?? {}).flatMap(([k, v]) => [v].flat().map((x) => (q.includes(':') ? `${k}: ${x}` : String(x))));
  return [t.title, ...props].some((f) => f?.toLowerCase().includes(q));
}

/**
 * The scheme recap's sections: minions that finished a turn or changed since `since`, newest first,
 * as needs you / still working / parked or waiting / dismissed. `stateOf` is the list rows' rowState.
 */
export function recapSections(tickets, since, turns, stateOf) {
  const sections = [
    { key: 'you', label: 'Needs you', rows: [] },
    { key: 'work', label: 'Still working', rows: [] },
    { key: 'wait', label: 'Parked or waiting', rows: [] },
    { key: 'closed', label: 'Dismissed', rows: [] },
  ];
  const changed = tickets.filter((t) => turns[t.id] || t.updated_at > since).sort((a, b) => b.updated_at - a.updated_at);
  for (const t of changed) {
    const st = stateOf(t);
    const key = t.status === 'closed' ? 'closed' : st.rank === 0 ? 'you' : st.fam === 'work' ? 'work' : 'wait';
    sections.find((s) => s.key === key).rows.push(t);
  }
  return sections.filter((s) => s.rows.length);
}
