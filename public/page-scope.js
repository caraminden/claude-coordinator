// Where the CI and Status pages open (Cara, 2026-11-20: "when you open CI/Status on Citadel it just opens citadel, its only on
// Home that it opens all schemes"). From a scheme they show that scheme only; from Home, every scheme (`/all`).

/** The hash a CI or Status chip opens: `schemeId` is the scheme on screen (null on Home), `lastScheme` is where Home's page is hosted. */
export function scopedPageHash(page, schemeId, lastScheme = 2) {
  return schemeId ? `#/p/${schemeId}/${page}` : `#/p/${lastScheme}/${page}/all`;
}
