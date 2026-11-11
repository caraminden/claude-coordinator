// The event-loop lag log (#526): the server is one thread, so while synchronous work runs (a git or gh
// call, a big delete, a gunzip) it answers nobody. This names each such stall in the journal, whose
// lines around it say what ran.

/** Log each time the event loop was held more than `over` ms, measured by a timer every `every` ms. */
export function watchLoopLag(log: (text: string) => void = console.warn, every = 100, over = 500): NodeJS.Timeout {
  let last = performance.now();
  return setInterval(() => {
    const now = performance.now();
    const held = now - last - every;
    last = now;
    if (held > over) log(`The event loop was held for ${(held / 1000).toFixed(1)} s: the server answered nobody meanwhile.`);
  }, every).unref();
}
