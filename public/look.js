// Citadel's look for its own pages (#1068, Josh picked "Rows that open" with the card take's colour): the parts a page
// builds its first look from, beside settingsRow in settings.js. The rules for using them: .claude/rules/citadel-look.md;
// their styles: settings.css, "Citadel's look".
import { h } from './base.js';
/** @import { Child } from './base.js' */

/** A scheme's hue, "1" to "6" (--cat-N), from its name, so a scheme is the same colour on every page. @param {string} name */
export function schemeHue(name) {
  let n = 0;
  for (const c of String(name)) n = (n * 31 + c.charCodeAt(0)) >>> 0;
  return String((n % 6) + 1);
}

/** A scheme's name (or an app's, in its scheme's hue) as a square tag. @param {string} scheme @param {string} [label] */
export const schemeTag = (scheme, label = scheme) => h('span', { class: 'scheme-tag', 'data-cat': schemeHue(scheme), title: label }, label);

/** A status as a toned chip: tone is ok, warn, danger, info, violet or neutral (Citadel UI's cui-chip). @param {string} tone @param {Child} text */
export const toneChip = (tone, text) => h('span', { class: 'cui-chip state-chip', 'data-tone': tone }, text);

/**
 * Stat tiles: each [value, label, hue] (hue a data-hue name, running by default); a falsy tile is left out.
 * @param {...([Child, Child, string?] | false | 0 | '' | null | undefined)} tiles
 */
export const statTiles = (...tiles) => h('div', { class: 'stat-tiles' }, .../** @type {[Child, Child, string?][]} */ (tiles.filter(Boolean)).map(([value, label, hue = 'running']) => h('div', { class: 'stat-tile', 'data-hue': hue }, h('b', {}, value), h('span', {}, label))));

/**
 * An item row with a bar in its hue down the left: `lead` (a number or a short word), the text, and `meta` on the
 * right. `hue` is a data-hue name, `cat` a scheme's (schemeHue); `free` draws it dashed and quiet, for an empty slot.
 * @param {{ hue?: string | null, cat?: string | null, lead?: Child, meta?: Child, free?: boolean }} [row]
 * @param {...Child} text
 */
export const hueRow = ({ hue, cat, lead, meta, free } = {}, ...text) =>
  h('div', { class: `hue-row${free ? ' free' : ''}`, 'data-hue': hue, 'data-cat': cat }, lead != null ? h('b', { class: 'hue-row-lead' }, lead) : null, h('span', { class: 'hue-row-text' }, ...text), meta != null ? h('span', { class: 'hue-row-meta' }, meta) : null);

/**
 * An empty state as a card: a mark, what it is, and what would fill it. `hue` defaults to done (green).
 * @param {Child} title
 * @param {Child} [line]
 * @param {{ mark?: string, hue?: string }} [opts]
 */
export const emptyCard = (title, line, { mark = '✓', hue } = {}) => h('div', { class: 'empty-card', 'data-hue': hue }, h('span', { class: 'empty-card-mark', 'aria-hidden': 'true' }, mark), h('div', {}, h('b', {}, title), line ? h('span', {}, line) : null));

/** A bar for `frac` (0 to 1) in --h, beside its words. Its width is set through the CSSOM: the CSP refuses style="". @param {number} frac @param {Child} words */
export function meter(frac, words) {
  const fill = h('i');
  fill.style.setProperty('--pct', `${Math.max(frac > 0 ? 2 : 0, Math.min(100, frac * 100)).toFixed(1)}%`);
  return h('span', { class: 'meter' }, h('span', { class: 'meter-text' }, words), h('span', { class: 'meter-bar', 'aria-hidden': 'true' }, fill));
}

/** Little squares, `on` of `of` filled: slots in use, steps done. @param {number} on @param {number} of */
export const pips = (on, of) => h('span', { class: 'pips', 'aria-hidden': 'true' }, ...Array.from({ length: of }, (_, i) => h('i', { class: i < on ? 'on' : null })));

const shownAll = new Set();

/**
 * A long list cut to its first `n`, with a "Show all" toggle under it. `wrap(items)` builds the list (a table, a
 * box of rows) from the items shown. The choice is kept by `key` across a page's redraws.
 * @template T
 * @overload
 * @param {{ key: string, items: T[], n?: number, noun?: string, wrap: (xs: T[]) => Element }} list
 * @returns {HTMLDivElement}
 */
/**
 * @overload
 * @param {{ key: string, items: Child[], n?: number, noun?: string }} list
 * @returns {HTMLDivElement}
 */
/** @param {{ key: string, items: Child[], n?: number, noun?: string, wrap?: (xs: Child[]) => Element }} list */
export function showFirst({ key, items, n = 5, noun = 'rows', wrap = (xs) => h('div', { class: 'hue-rows' }, ...xs) }) {
  const box = h('div', { class: 'show-first' });
  const draw = () => {
    const all = shownAll.has(key) || items.length <= n + 1; // never hide just one
    box.replaceChildren(
      wrap(all ? items : items.slice(0, n)),
      ...(items.length > n + 1
        ? [
            h(
              'button',
              {
                type: 'button',
                class: 'show-more',
                'aria-expanded': String(all),
                onclick: () => {
                  if (shownAll.has(key)) shownAll.delete(key);
                  else shownAll.add(key);
                  draw();
                  /** @type {HTMLButtonElement | null} */ (box.querySelector('.show-more'))?.focus();
                },
              },
              all ? `Show the first ${n} only` : `Show all ${items.length} ${noun}`,
            ),
          ]
        : []),
    ); // replaceChildren writes a null as "null"
  };
  draw();
  return box;
}
