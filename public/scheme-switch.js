// Clicking another scheme in the rail keeps you on the same per-scheme page (Cara, 2026-11-19: "When I have settings
// open and click a different scheme, it should swap to that scheme leaving settings open but swapped to the other
// schemes settings pages"). A minion's chat is the exception: it opens the new scheme's Taskmaster.

const ADMIN_ONLY = new Set(['app-instructions', 'people', 'contraptions']);
const KEEP = new Set(['artifacts', 'shared', 'instructions', 'settings', 'orders', 'skills', 'approvals', 'properties', 'members', 'memory', 'decisions', 'ideas', 'reviews', 'machines',
  'my-instructions', 'account', 'notifications', 'usage', 'help', 'app-instructions', 'people', 'contraptions']);

/** The hash to open for scheme `id` when you click it while on `hash`. `isAdmin` gates the admin Settings tabs. */
export function schemeSwitchHash(hash, id, isAdmin = false) {
  const m = /^#\/p\/\d+\/([a-z-]+)(?:\/(.*))?$/.exec(hash ?? '');
  const home = `#/p/${id}`;
  if (!m) return home;
  const [, page, rest] = m;
  if (page === 'status') return `${home}/status`;
  if (page === 'ci') return /^(overview|history|runs|runners)$/.test(rest ?? '') ? `${home}/ci/${rest}` : `${home}/ci`;
  // Releases open on the scheme you switch to; only Citadel's opens on All.
  if (page === 'releases') return `${home}/releases/${Number(id) === 2 ? 'all' : id}`;
  // A schedule's page opens the other scheme's Schedules list: its schedules are its own.
  if (page === 'schedules') return `${home}/schedules`;
  // A page tied to one item (a memory file) opens the other scheme's list for that page.
  if (KEEP.has(page) && rest && /^(memory|skills|reviews|decisions)$/.test(page)) return `${home}/${page}`;
  if (page === 'orders' && !rest) return `${home}/orders`;
  if (!KEEP.has(page) || rest) return home;
  if (ADMIN_ONLY.has(page) && !isAdmin) return `${home}/instructions`;
  return `${home}/${page}`;
}
