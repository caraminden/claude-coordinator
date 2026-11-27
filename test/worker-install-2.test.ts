// Part 2 of 3 of the worker-install tests (#2208); the shared setup is in worker-install-setup.ts.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { before, test } from 'node:test';
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
  assert.match(caps.out, /Caps: 6 minions at once, 2 threads, 24 GB of memory, 30 GB of disk/);
  assert.match(p.logged(), /CPUQuota=200%[^]*systemctl --user restart citadel-worker\n$/);
});
