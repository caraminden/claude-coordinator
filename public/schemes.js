// Which scheme a bare visit to the app opens: the one this browser last had open, else Citadel,
// else the first. There is no list page any more, so this is the app's front door.

export const HOME_SCHEME = 2; // Citadel

/** The id to open from `projects` ([{ id }]), given the last-opened id; null when there are none. */
export function startScheme(projects, lastId) {
  const has = (id) => projects.some((p) => p.id === id);
  if (has(lastId)) return lastId;
  if (has(HOME_SCHEME)) return HOME_SCHEME;
  return projects[0]?.id ?? null;
}
