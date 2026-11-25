// One read shared by the callers of a page within a few seconds of its answer (Properties' filter and Settings count,
// #1528), dropped by `forget()` when a change is made so the next caller reads again (WP2, #1858).

/** `read(key)` runs `fetcher(key)` unless a read for that key is in flight or was answered under `ttl` ms ago. */
export function sharedRead(fetcher, ttl = 5000) {
  let entry = null;
  return {
    read(key) {
      if (entry?.key !== key || (entry.at && Date.now() - entry.at > ttl)) {
        const e = { key, at: 0, read: fetcher(key) };
        entry = e;
        e.read.then(
          () => {
            e.at = Date.now();
          },
          () => {
            if (entry === e) entry = null;
          },
        );
      }
      return entry.read;
    },
    forget() {
      entry = null;
    },
  };
}
