// Sections of the threads list, as in Delve's Custom view: the current build (the lowest build any
// open thread is assigned to) on top, then the scheme's promoted groups (its list_groups setting,
// like Delve's "area: balance"), then the types of work, then later builds in ascending order.
// Threads in a build sit in its section whatever their type or properties, by their build field.
// A thread outside a build that carries a promoted value sits in the first such group, not its type's.
// Resting threads leave their build or group (Cara, 2026-11-14: "Lets move the deploying tickets to their own category at
// the top below Pinned? and then waiting goes above Parked"): Deploying on top, then Waiting (parked, but something wakes
// it by itself: start_after, wake_when_live, runners back) and Parked (only a person or the Taskmaster wakes it) at the bottom.
// Newer word, parked only (Cara, 2026-11-17: "I think parked minions that are part of a major build should show in the
// build group as well"): a parked minion with a build sits in its Build N section (its row keeps the parked look, after the
// active rows); parked ones outside a build stay in Waiting/Parked. Deploying still leaves its build.

/** Resting there: a running, stuck or approval-waiting thread shows where it would otherwise, as does one the server is landing (#727). */
const resting = (t) => !t.approvals && !['running', 'error'].includes(t.status) && !t.server_work;
const isParked = (t) => t.state === 'parked' && resting(t) && (t.status !== 'new' || !!t.parked_for);
/** Deploying: pending-deploy, or dismissed with its change still on its way in a release (#764, `release` from releases.js). */
const isDeploying = (t) => (t.state === 'pending-deploy' || (t.status === 'closed' && !!t.release)) && resting(t) || onMainDeploying(t);
/** Landed on main with the server still deploying its apps (server_work): in Deploying, unlike one still in the land line or testing (#776). */
const onMainDeploying = (t) => !!t.server_work && t.status !== 'closed' && !t.approvals && !['running', 'error'].includes(t.status) && ['main', 'deploying'].includes(t.ship?.stage);
/** Parked until something wakes it by itself (the server's wakes_on; a held start_after chain has none). */
const wakesItself = (t) => !!t.wakes_on;

/**
 * [{ key, build?, current?, type?, group?, rows }] for open threads, empty sections left out. `types` are
 * the type values in list order (an unknown or missing type counts as "other"); `groups` the scheme's
 * promoted "key: value"s.
 */
export function threadSections(all, types, groups = []) {
  const buildOf = (t) => t.build ?? 0;
  const deploying = all.filter(isDeploying);
  const parked = all.filter((t) => isParked(t) && !buildOf(t));
  const parkedInBuild = all.filter((t) => isParked(t) && buildOf(t));
  const open = all.filter((t) => !isParked(t) && !isDeploying(t));
  const builds = [...new Set([...open, ...parkedInBuild].map(buildOf).filter(Boolean))].sort((a, b) => a - b);
  // Parked rows follow the active ones in their build.
  const buildSection = (build, i) => ({ key: `build-${build}`, build, current: i === 0,
    rows: [...open, ...parkedInBuild].filter((t) => buildOf(t) === build) });
  const has = (t, group) => {
    const i = group.indexOf(':');
    return [t.properties?.[group.slice(0, i).trim()]].flat().map(String).includes(group.slice(i + 1).trim());
  };
  const loose = open.filter((t) => !buildOf(t));
  const promotedTo = new Map(loose.map((t) => [t, groups.find((g) => has(t, g))]));
  const promoted = groups.map((group, i) => ({ key: `group-${i}`, group, rows: loose.filter((t) => promotedTo.get(t) === group) }));
  const typeOf = (t) => (types.includes(t.properties?.type) ? t.properties.type : 'other');
  const kinds = types.map((type) => ({ key: type, type, rows: loose.filter((t) => !promotedTo.get(t) && typeOf(t) === type) }));
  return [{ key: 'deploying', rows: deploying }, ...builds.slice(0, 1).map(buildSection), ...promoted, ...kinds, ...builds.slice(1).map((b, i) => buildSection(b, i + 1)),
    { key: 'waiting', rows: parked.filter(wakesItself) }, { key: 'parked', rows: parked.filter((t) => !wakesItself(t)) }]
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
