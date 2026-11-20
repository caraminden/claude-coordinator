// When a new front end loads (Josh, 2026-11-20, "Reload out of sight"). A tab you are looking at never refreshes
// on its own: the new version loads once the tab is hidden, or on the next in-app navigation. Unsent work holds
// both back. A restart with the same front end gives the same version, so `pending` is never set and nothing reloads.
/**
 * @param {{ pending: boolean, hidden: boolean, navigating: boolean, unsent: boolean }} s
 * @returns {boolean} true to reload now
 */
export function shouldReload({ pending, hidden, navigating, unsent }) {
  if (!pending || unsent) return false;
  return hidden || navigating;
}
