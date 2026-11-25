// Mutants of src/ship-line.ts (#1778): moving a scheme's waiting ships, pins, history, and a broken test's fix going first.
const T = ['test/ship-line.test.ts', 'test/release-targets.test.ts', 'test/land-queue.test.ts', 'test/front.test.ts', 'test/waits.test.ts'];
export default {
  file: 'src/ship-line.ts',
  tests: T,
  mutants: [
    { id: 'l01', find: "if ((own ? !waits : !repo) || !line.length) throw", replace: 'if ((own ? !waits : !repo)) throw', why: 'a scheme with an empty ship line answers 409 "no longer waiting" instead of 404 "no ship line here"' },
    { id: 'l02', find: 'e.seq === movedSeq && !e.holds)', replace: 'e.seq === movedSeq)', why: 'the ship holding the lock (shipping now) can be dragged like a waiting one' },
    { id: 'l03', find: 'if (!moved.movable) throw', replace: 'if (false) throw', why: 'a ship whose land script is too old to order is moved anyway' },
    { id: 'l04', find: '  if (by.taskmaster) {', replace: '  if (false) {', why: "a Taskmaster's order moves a ship a person pinned, or past one" },
    { id: 'l05', find: '&& !state.placed[placedKey(e)].taskmaster ?', replace: '&& state.placed[placedKey(e)].taskmaster ?', why: "a person's pin no longer counts and a Taskmaster's own earlier move now blocks the Taskmaster" },
    { id: 'l06', find: 'if (was !== now) throw', replace: 'if (false) throw', why: "a Taskmaster's order can put a ship past a person's pinned one" },
    { id: 'l07', find: '  const waiting = line.filter((e) => !e.holds && e.movable);', nth: 2, replace: '  const waiting = line.filter((e) => !e.holds);', why: "a broken test's fix is read as already first when an unmovable ship sits ahead of it" },
    { id: 'l08', find: 'waits!.setOrder(seqs, note, movedSeq)', replace: 'waits!.setOrder(seqs, note)', why: "dropping a ship on a target that shows part of the line reorders the ships it doesn't show" },
    { id: 'l09', find: 'schemeLine(repo!), seqs, note, movedSeq)', replace: 'schemeLine(repo!), seqs, note)', why: "another scheme's drag reorders ships its target doesn't show" },
    { id: 'l10', find: '.slice(-HISTORY_MAX)', replace: '.slice(0, HISTORY_MAX)', why: 'after 30 moves the line history keeps the oldest moves and stops showing new ones' },
    { id: 'l11', find: '.slice(-HISTORY_MAX)', replace: '.slice(HISTORY_MAX)', why: 'the line history shows no moves at all' },
    { id: 'l12', find: '.filter(([k]) => here.has(k))', replace: '.filter(() => true)', why: "a ship that shipped keeps its pin forever, and a new ship with that key arrives pinned" },
    { id: 'l13', find: "const i = before == null ? 0 : rest.indexOf(before);", replace: 'const i = before == null ? rest.length : rest.indexOf(before);', why: "'ship first' puts the ship last in the order written" },
    { id: 'l14', find: 'if (i < 0) throw new HttpError', replace: 'if (i < -1) throw new HttpError', why: 'a ship ahead of one that is not waiting is placed at the wrong spot instead of refused' },
    { id: 'l15', find: '!e.holds && e.movable && e.seq !== ship)', replace: '!e.holds && e.movable)', why: 'the ship to put first is listed twice in the order written' },
    { id: 'l16', find: "if (waiting[0] === e) return 'first';", replace: '', why: 'a fix already first in line is rewritten and its pinning history grows, reported as moved' },
    { id: 'l17', find: '{ ...by, taskmaster: true }', replace: '{ ...by, taskmaster: false }', why: "a Taskmaster's broken-test fix ignores people's pins and pins the ship itself" },
    { id: 'l18', find: "    return 'refused';", replace: '    return null;', why: "a refused fix-first move is reported as 'not waiting' so the caller does the wrong follow-up" },
  ],
};
