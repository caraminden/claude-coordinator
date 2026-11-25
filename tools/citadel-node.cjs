// Loaded into every node process tools/citadel-node starts, and their node children: spawns of
// process.execPath (node --test's test files, servers a test starts) then run as citadel-node too,
// which ananicy-cpp's `node` rule doesn't match (#506, deploy/priority.md).
if (process.env.CITADEL_NODE) process.execPath = process.env.CITADEL_NODE;

// --test-force-exit exits as soon as a reporter has unpiped from stdout, dropping what the pipe hasn't taken yet: a test
// file's last reports went uncounted, a red among them (#1959). Node first waits for its destination's close() where
// there is one, and stdout has none, so this is it: done once every reporter has unpiped (node takes the first of two
// for both) and all they wrote has gone out. Only such a run's own stdout, and it exits as before after that, open
// handles or not. A pipe nobody reads for the limit's seconds ends it too, red, as the report is then short; the
// seconds are ticks, so a process frozen for memory (citadel-heavy) isn't over it the moment it thaws.
if (process.execArgv.includes('--test-force-exit') && !process.stdout.close) {
  const { stdout } = process;
  let piped = 0;
  stdout.on('pipe', () => piped++);
  stdout.on('unpipe', () => piped--);
  stdout.close = (done) => {
    let left = Number(process.env.CITADEL_TEST_DRAIN_LIMIT) || 60;
    const tick = setInterval(() => {
      if (--left > 0) return;
      clearInterval(tick);
      process.exitCode ||= 1;
      process.stderr.write(`citadel-node: nobody read ${process.argv[1] ?? 'the run'}'s report, so the end of it is lost\n`);
      done();
    }, 1000);
    const flush = () => {
      if (piped > 0) return void stdout.once('unpipe', flush);
      stdout.write('', () => {
        clearInterval(tick);
        done();
      });
    };
    flush();
  };
}
