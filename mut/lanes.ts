// Mutants of src/lanes.ts (#1778): one serial queue per minion, so a turn never overlaps the step before it.
export default {
  file: 'src/lanes.ts',
  tests: ['test/lane.test.ts', 'test/lanes-property.test.ts', 'test/minion-lane.test.ts', 'test/chain-outbox.test.ts', 'test/queue-give-back.test.ts', 'test/restart-anywhere.test.ts', 'test/keepalive.test.ts'],
  mutants: [
    { id: 'n01', find: 'const before = this.tails.get(key);', replace: 'const before = undefined;', why: "a step starts while the one before it still runs, so two turns of one minion overlap" },
    { id: 'n02', find: 'if (this.tails.get(key) !== tail) return;', replace: '', why: 'the lane goes idle (and starts queued messages) while a later step still waits on it' },
    { id: 'n03', find: '      this.onIdle(key);', replace: '', why: 'a lane going idle never starts the minion\'s queued messages' },
    { id: 'n04', find: 'const nested = before ? undefined : this.tails.get(key);', replace: 'const nested = undefined;', why: 'a lane goes idle under a turn the outbox started inside a step' },
    { id: 'n05', find: 'if (thrown) throw thrown.err;', replace: '', why: 'a step that throws at once hides its error from the caller, which believes it started' },
    { id: 'n06', find: 'return this.tails.has(key);', replace: 'return false;', why: 'a lane with a running step reads as free' },
  ],
};
