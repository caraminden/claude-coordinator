// Clicking another scheme in the rail keeps you on the same per-scheme page (Cara, 2026-11-19: "When I have settings
// open and click a different scheme, it should swap to that scheme leaving settings open but swapped to the other
// schemes settings pages"). A minion's chat is the exception: it opens the new scheme's Taskmaster.

const ADMIN_ONLY = new Set(['app-instructions', 'people', 'contraptions']);
const KEEP = new Set(['artifacts', 'shared', 'instructions', 'settings', 'approvals', 'properties', 'members', 'machines',
  'my-instructions', 'account', 'notifications', 'usage', 'app-instructions', 'people', 'contraptions']);

/** The hash to open for scheme `id` when you click it while on `hash`. `isAdmin` gates the admin Settings tabs. */
export function schemeSwitchHash(hash, id, isAdmin = false) {
  const m = /^#\/p\/\d+\/([a-z-]+)(?:\/(.*))?$/.exec(hash ?? '');
  const home = `#/p/${id}`;
  if (!m) return home;
  const [, page, rest] = m;
  if (page === 'ci') return /^(overview|history|runs|runners)$/.test(rest ?? '') ? `${home}/ci/${rest}` : `${home}/ci`;
  // A release is one scheme's own; the list of all of them is every scheme's.
  if (page === 'releases') return `${home}/releases/all`;
  if (!KEEP.has(page) || rest) return home;
  if (ADMIN_ONLY.has(page) && !isAdmin) return `${home}/instructions`;
  return `${home}/${page}`;
}
