// The Code tab's sums (public/code-map.js, #1988), kept free of the DOM so test/code-counts.test.ts can load them.

/** Lines at which a file is big enough to be worth splitting. */
export const BIG = 900;
/** @import { CodeFile } from './types.js' */
/** The fields of a CodeFile these sums read. @typedef {Pick<CodeFile, 'path' | 'lines' | 'changed' | 'bugs'> & Partial<Pick<CodeFile, 'who'>>} Counted */
/** Minions that make a file busy (Josh's picked mock: 900 lines, 40 minions), and the fewest in a scheme with less going on. */
const BUSY = 40;
const FEWEST = 4;

/** Where the marked corner starts: 40 minions, or a quarter of the busiest big file's where that is fewer. */
export const zone = (/** @type {Counted[]} */ files) => ({ lines: BIG, changed: Math.min(BUSY, Math.max(FEWEST, Math.round(Math.max(0, ...files.filter((f) => f.lines >= BIG).map((f) => f.changed)) / 4))) });

/** What a split pays: how busy, weighed by how big, and 3 for each bug fix. */
export const score = (/** @type {Counted} */ f) => Math.log(f.lines / 100) * f.changed + 3 * f.bugs;

/**
 * The files in the corner, the best to split first.
 * @template {Counted} F
 * @param {F[]} files
 */
export function candidates(files) {
  const z = zone(files);
  return files.filter((f) => f.lines >= z.lines && f.changed >= z.changed).sort((a, b) => score(b) - score(a) || (a.path < b.path ? -1 : 1));
}

/**
 * The folders to filter by: the first `n` top folders by changes, one folder deep.
 * @param {Pick<CodeFile, 'path' | 'changed'>[]} files
 */
export function folders(files, n = 5) {
  /** @type {Map<string, number>} */
  const sums = new Map();
  for (const f of files) if (f.path.includes('/')) sums.set(f.path.split('/')[0], (sums.get(f.path.split('/')[0]) ?? 0) + f.changed);
  return [...sums]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k]) => `${k}/`);
}

/** A file's short name: its last part, with its folder where another shown file has the same. */
export const shortName = (/** @type {string} */ path, /** @type {string[]} */ all) => {
  const parts = path.split('/'),
    last = parts.at(-1);
  return parts.slice(all.some((p) => p !== path && p.split('/').at(-1) === last) ? -2 : -1).join('/');
};

/**
 * The brief "Start a split minion" drafts, as a message to a Taskmaster: the title is what marks the file as being split.
 * @param {CodeFile} f
 * @param {number} days
 */
export function splitDraft(f, days) {
  const bugs = f.bugs ? `, ${f.bugs} of them fixing bugs` : '';
  return `Start a minion titled "Split ${f.path}".

Goal: split ${f.path} into modules, so minions stop meeting in one file.
Why: ${f.lines.toLocaleString('en-US')} lines, and ${f.changed} minions changed it in the last ${days} days${bugs} (the Code tab on Releases).${f.who.length ? ` The latest: ${f.who.map((n) => `#${n}`).join(', ')}.` : ''}

Done when:
- The plan names each piece and its seam before any code moves, from what those minions changed together.
- Each piece ships on its own, moving code with no change in behaviour, its tests still green.
- The next change to one part doesn't need the rest of ${f.path} open.

Check first: no open minion is already on this file, and what the last architecture check says about it.`;
}
