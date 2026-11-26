// Clicking another scheme in the rail keeps you on the same per-scheme page (Cara, 2026-11-19: "When I have settings
// open and click a different scheme, it should swap to that scheme leaving settings open but swapped to the other
// schemes settings pages"). A minion's chat is the exception: it opens the new scheme's Taskmaster.
import { PAGES } from './settings-pages.js';

// Derived from the table of Settings and Orders pages (settings-pages.js); Files and the Settings list itself aren't rows.
const ADMIN_ONLY = new Set(PAGES.filter((p) => p.admin).map((p) => p.kind));
const KEEP = new Set(['artifacts', 'shared', 'settings', ...PAGES.map((p) => p.kind)]);
const ITEM_PAGES = new Set(PAGES.filter((p) => p.item).map((p) => p.kind));

/** The hash to open for scheme `id` when you click it while on `hash`. `isAdmin` gates the admin Settings tabs.
 * @param {string | null | undefined} hash
 * @param {number} id
 * @param {boolean} [isAdmin]
 */
export function schemeSwitchHash(hash, id, isAdmin = false) {
  const m = /^#\/p\/\d+\/([a-z-]+)(?:\/(.*))?$/.exec(hash ?? '');
  const home = `#/p/${id}`;
  if (!m) return home;
  const [, page, rest] = m;
  if (page === 'status') return rest === 'all' ? `${home}/status/all` : `${home}/status`;
  if (page === 'ci' && rest === 'all') return `${home}/ci/all`;
  if (page === 'ci') return /^(overview|history|runs|runners|health|numbers)$/.test(rest ?? '') ? `${home}/ci/${rest}` : `${home}/ci`;
  // The Releases page (#1423) opens on the scheme you switch to, on the tab you were on.
  if (page === 'releases') {
    const tab = (rest ?? '').split('/')[1];
    return `${home}/releases/${id}${/^(overview|history|health|numbers|code|flow|status)$/.test(tab ?? '') ? `/${tab}` : ''}`;
  }
  // A schedule's page opens the other scheme's Schedules list: its schedules are its own.
  if (page === 'schedules') return `${home}/schedules`;
  // A chain's highlight names a minion of this scheme: the other scheme opens on its own Chains page.
  if (page === 'chains') return `${home}/chains`;
  // A page tied to one item (a memory file) opens the other scheme's list for that page.
  if (KEEP.has(page) && rest && ITEM_PAGES.has(page)) return `${home}/${page}`;
  if (page === 'orders' && !rest) return `${home}/orders`;
  if (!KEEP.has(page) || rest) return home;
  if (ADMIN_ONLY.has(page) && !isAdmin) return `${home}/instructions`;
  return `${home}/${page}`;
}
