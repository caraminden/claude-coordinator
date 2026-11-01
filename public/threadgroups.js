// Sections of the threads list, as in Delve's Custom view: the current build (the lowest build any
// open thread is assigned to) on top, then the scheme's promoted groups (its list_groups setting,
// like Delve's "area: balance"), then the types of work, then later builds in ascending order.
// Threads in a build sit in its section whatever their type or properties, by their build field.
// A thread outside a build that carries a promoted value sits in the first such group, not its type's.
// Parked threads leave their build or group for one Parked section at the bottom (above Dismissed).

/** Parked and resting there: a running, stuck or approval-waiting thread shows where it would otherwise. */
const isParked = (t) => t.state === 'parked' && !t.approvals && !['running', 'error'].includes(t.status) && (t.status !== 'new' || !!t.held);

/**
 * [{ key, build?, current?, type?, group?, rows }] for open threads, empty sections left out. `types` are
 * the type values in list order (an unknown or missing type counts as "other"); `groups` the scheme's
 * promoted "key: value"s.
 */
export function threadSections(all, types, groups = []) {
  const parked = all.filter(isParked);
  const open = all.filter((t) => !isParked(t));
  const buildOf = (t) => t.build ?? 0;
  const builds = [...new Set(open.map(buildOf).filter(Boolean))].sort((a, b) => a - b);
  const buildSection = (build, i) => ({ key: `build-${build}`, build, current: i === 0, rows: open.filter((t) => buildOf(t) === build) });
  const has = (t, group) => {
    const i = group.indexOf(':');
    return [t.properties?.[group.slice(0, i).trim()]].flat().map(String).includes(group.slice(i + 1).trim());
  };
  const loose = open.filter((t) => !buildOf(t));
  const promotedTo = new Map(loose.map((t) => [t, groups.find((g) => has(t, g))]));
  const promoted = groups.map((group, i) => ({ key: `group-${i}`, group, rows: loose.filter((t) => promotedTo.get(t) === group) }));
  const typeOf = (t) => (types.includes(t.properties?.type) ? t.properties.type : 'other');
  const kinds = types.map((type) => ({ key: type, type, rows: loose.filter((t) => !promotedTo.get(t) && typeOf(t) === type) }));
  return [...builds.slice(0, 1).map(buildSection), ...promoted, ...kinds, ...builds.slice(1).map((b, i) => buildSection(b, i + 1)),
    { key: 'parked', rows: parked }]
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
