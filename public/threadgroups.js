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
// Wider Deploying (Cara, 2026-11-18: "I think "Deploying" should be anything that is done with its code, I have given merge
// approval to (if needed) and will hit live without any more human input (assuming nothing goes wrong)"): a minion that
// handed its change to land (server_work: in the line, rebasing, in tests, deploying, restarting) is Deploying. A failed land,
// a running or stuck turn or a waiting approval sends it back to its type. Open question cards that don't hold the land up keep
// it here; its row's question chip still puts it in the Needs-you strip.

import { LOOK } from './threadstate.js';

/** Resting there: a running, stuck or approval-waiting thread shows where it would otherwise, as does one the server is landing (#727). */
const resting = (t) => !t.approvals && !['running', 'error'].includes(t.status) && !t.server_work;
const isParked = (t) => t.state === 'parked' && resting(t) && (t.status !== 'new' || !!t.parked_for);
/** Asleep (#1636; Cara picked "Own Asleep section"): out of its type like a sealed one, and like one it stays in its build. */
const isAsleep = (t) => !!t.asleep && t.status !== 'closed' && resting(t) && !isParked(t);
/** Deploying: pending-deploy, or dismissed with its change still on its way in a release (#764, `release` from releases.js). */
const isDeploying = (t) => (t.state === 'pending-deploy' || (t.status === 'closed' && !!t.release)) && resting(t) || onMainDeploying(t);
/** The server is landing its change (server_work: line, rebase, tests, deploy, restart), nothing of its own is stuck: a failed land, a running turn or a waiting approval keeps it in its type (#1003). */
const onMainDeploying = (t) => !!t.server_work && t.status !== 'closed' && !t.approvals && !['running', 'error'].includes(t.status) && !['live', 'failed'].includes(t.ship?.stage);
/** Parked until something wakes it by itself (the server's wakes_on; a held start_after chain has none). */
const wakesItself = (t) => !!t.wakes_on;

/**
 * [{ key, build?, current?, type?, group?, rows }] for open threads, empty sections left out. `types` are
 * the type values in list order (an unknown or missing type counts as "other"); `groups` the scheme's
 * promoted "key: value"s. `deployOrder` is releases.js's releaseOrder.
 */
export function threadSections(all, types, groups = [], deployOrder = () => undefined) {
  const buildOf = (t) => t.build ?? 0;
  // Deploying reads in the Releases page's order (Cara, 2026-11-18: "Inside of that deploying group, lets order by deploy order"):
  // `deployOrder(t)` is its place there; rows it doesn't list go after, in the list's own order (the sort is stable).
  const deploying = all.filter(isDeploying).sort((a, b) => (deployOrder(a) ?? Infinity) - (deployOrder(b) ?? Infinity));
  const parked = all.filter((t) => isParked(t) && !buildOf(t));
  const parkedInBuild = all.filter((t) => (isParked(t) || isAsleep(t)) && buildOf(t));
  const asleep = all.filter((t) => isAsleep(t) && !buildOf(t) && !isDeploying(t));
  const open = all.filter((t) => !isParked(t) && !isAsleep(t) && !isDeploying(t));
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
    { key: 'asleep', rows: asleep }, { key: 'waiting', rows: parked.filter(wakesItself) }, { key: 'parked', rows: parked.filter((t) => !wakesItself(t)) }]
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
    { key: 'look', label: 'Ready, to try or done', rows: [] },
    { key: 'work', label: 'Still working', rows: [] },
    { key: 'wait', label: 'Sealed or waiting', rows: [] },
    { key: 'closed', label: 'Dismissed', rows: [] },
  ];
  const changed = tickets.filter((t) => turns[t.id] || t.updated_at > since).sort((a, b) => b.updated_at - a.updated_at);
  for (const t of changed) {
    const st = stateOf(t);
    const key = t.status === 'closed' ? 'closed' : st.rank === 0 ? 'you' : st.rank === LOOK ? 'look' : st.fam === 'work' ? 'work' : 'wait';
    sections.find((s) => s.key === key).rows.push(t);
  }
  return sections.filter((s) => s.rows.length);
}
