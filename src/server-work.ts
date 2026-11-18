// What the server is doing for a minion with no turn of its own (#727): today, landing it after hand_off_land.
// The views read it as working; a row is sent again whenever its server work starts or ends.

/** `handoffs` lists the minions whose handed-off land isn't settled yet (Landings.handoffs); `changed` re-sends a row. */
export function serverWorkWatch(handoffs: () => number[], changed: (id: number) => void, now = () => Date.now()) {
  let current = new Set<number>(), readAt = -Infinity, shown = new Set<number>();
  // Each row of a list asks: read the landings' folder at most once a second.
  const read = (fresh = false) => {
    if (fresh || now() - readAt > 1000) [current, readAt] = [new Set(handoffs()), now()];
    return current;
  };
  return {
    /** `fresh`: read the folder now, for a decision that can't wait out the second's cache (a turn's start). */
    of: (id: number, fresh = false): { kind: 'land' } | null => (read(fresh).has(id) ? { kind: 'land' } : null),
    /** Re-reads and re-sends each row whose server work started or ended since the last sync. */
    sync() {
      const next = read(true);
      for (const id of new Set([...shown, ...next])) if (shown.has(id) !== next.has(id)) changed(id);
      shown = next;
    },
  };
}
