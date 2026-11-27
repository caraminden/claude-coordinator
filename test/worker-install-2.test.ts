// Part 2 of 3 of the worker-install tests (#2208); the shared setup is in worker-install-setup.ts.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { before, test } from 'node:test';
import { workerSize } from '../public/machine-setup.js';
import { scripts, TOKEN, n, pc } from './worker-install-setup.ts';

test("run again, nothing in the worker's home is written as root: a link a minion left there is followed as that user", async () => {
  const p = pc();
  assert.equal((await p.install()).code, 0);
  const script = readFileSync(join(scripts, 'install-worker.sh'), 'utf8') + readFileSync(join(scripts, 'citadel-worker'), 'utf8');
  for (const line of script.split('\n')) if (/\$home\/|"\$log"/.test(line) && !/^(ExecStart|WorkingDirectory|Standard|\s*(echo|#|log=|\[\[ ! -f))/.test(line)) assert.match(line, /\bas (mkdir|tee|cat|tail) |ROOT=/, line);
  assert.match(readFileSync(join(p.r, 'log.user'), 'utf8'), /worker-agent\.mjs$/m);
});

test('a wrong PC, address or token is refused before anything is changed', async () => {
  const p = pc();
  assert.match((await p.install([], { CC_MACHINE_TOKEN: 'ccm_7_short' })).out, /isn't a machine token/);
  assert.match((await p.install([], { CC_MACHINE_TOKEN: TOKEN, ARCH: 'aarch64' })).out, /aarch64/);
  assert.match((await p.run(join(scripts, 'install-worker.sh'), ['http://x/; rm -rf /'])).out, /usage/);
  assert.equal(p.logged(), '');
});

test("citadel-worker: caps are whole numbers, and a sign-in is Claude Code's and gh's own, in the minions' home", async () => {
  const p = pc();
  const helper = join(scripts, 'citadel-worker');
  assert.match((await p.run(helper, ['caps', '--workers', '4'])).out, /No worker is installed here/);
  await p.install();
  assert.match((await p.run(helper, ['signin'])).out, /not built yet/);
  writeFileSync(join(p.r, 'home/citadel-worker/worker/image-tag'), 'localhost/citadel-worker:abc');
  assert.equal((await p.run(helper, ['signin'])).code, 0);
  assert.match(p.logged(), /podman run --rm -it .* -v citadel-worker-home:\/home\/worker:U localhost\/citadel-worker:abc claude \/login\n/);
  assert.equal((await p.run(helper, ['signin-github'])).code, 0);
  assert.match(p.logged(), /localhost\/citadel-worker:abc gh auth login --hostname github\.com/);
  for (const bad of ['1; reboot', '0', '65']) assert.equal((await p.run(helper, ['caps', '--workers', bad])).code, 1, bad);
  for (const [flag, low] of [
    ['--memory', '1'],
    ['--disk', '19'],
    ['--threads', '1025'],
  ])
    assert.match((await p.run(helper, ['caps', flag, low])).out, /a whole number from/);
  const caps = await p.run(helper, ['caps', '--threads', '2', '--disk', '30']);
  assert.match(caps.out, /Caps: 4 minions at once, 2 threads, 23 GB of memory, 30 GB of disk/, 'install sized the rest from this PC (16 threads, 31 GB), and caps keeps them');
  assert.match(p.logged(), /CPUQuota=200%[^]*systemctl --user restart citadel-worker\n$/);
});

test("a new install with no caps given is sized from the PC (#2250): a quarter of its threads and memory kept, at least 2 and 4 GB, a minion per 3; the page's rule is the same", async () => {
  const sizes: [number, number, Record<string, number>][] = [
    [4, 8, { workers: 1, threads: 2, memory_gb: 4, disk_gb: 60 }],
    [16, 32, { workers: 4, threads: 12, memory_gb: 24, disk_gb: 60 }],
    [64, 128, { workers: 16, threads: 48, memory_gb: 96, disk_gb: 60 }],
  ];
  // Three PCs at once: an install takes some seconds.
  await Promise.all(
    sizes.map(async ([threads, gb, want], i) => {
      const p = pc();
      writeFileSync(join(p.r, 'proc/meminfo'), `MemTotal:       ${gb * 1024 * 1024} kB\n`);
      const done = await p.install([], { CC_MACHINE_TOKEN: TOKEN, THREADS: String(threads) });
      assert.equal(done.code, 0, done.out);
      const cfg = JSON.parse(p.read('etc/citadel-worker/config.json'));
      const { root: _, ...caps } = cfg;
      assert.deepEqual(caps, want, `${threads} threads, ${gb} GB`);
      assert.deepEqual(workerSize({ threads, memory_gb: gb }), want, "the Machines page's offer sizes it the same");
      assert.match(p.logged(), new RegExp(`CPUQuota=${want.threads * 100}% MemoryMax=${want.memory_gb}G`));
      if (i !== 1) return;
      // Run again on a bigger PC, its caps stay: an owner may have set them by hand.
      const again = await p.install([], { CC_MACHINE_TOKEN: TOKEN, THREADS: '128' });
      assert.equal(again.code, 0, again.out);
      assert.deepEqual(JSON.parse(p.read('etc/citadel-worker/config.json')), cfg);
    }),
  );
});
