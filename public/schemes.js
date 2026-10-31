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

/** A letter tile's letter (#222): the scheme name's first letter or digit, upper-cased; '?' for none. */
export function tileLetter(name) {
  return (String(name ?? '').match(/[\p{L}\p{N}]/u)?.[0] ?? '?').toLocaleUpperCase();
}

/** A letter tile's hue, from the scheme's id so it stays put through renames; golden-angle steps keep neighbours apart. */
export function tileHue(id) {
  return Math.round((id * 137.508) % 360);
}
