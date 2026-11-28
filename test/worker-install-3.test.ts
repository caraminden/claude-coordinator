// Part 3 of 3 of the worker-install tests (#2208); the shared setup is in worker-install-setup.ts.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { before, test } from 'node:test';
import { scripts, TOKEN, bin, stub, n, pc } from './worker-install-setup.ts';

test('the worker may run one root command through sudo, page-caps, with its own PATH; a sudo that refuses the rule leaves it out', async () => {
  const p = pc();
  assert.equal((await p.install()).code, 0);
  const rules = p.read('etc/sudoers.d/citadel-worker');
  const lines = rules.split('\n').filter((l) => l && !l.startsWith('#'));
  assert.deepEqual(lines, ['Defaults:citadel-worker env_reset, secure_path="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"', 'citadel-worker ALL=(root) NOPASSWD: /usr/local/bin/citadel-worker page-caps *']);
  assert.equal(p.mode('etc/sudoers.d/citadel-worker'), '440');
  assert.match(p.logged(), /visudo -cqf \S+\/etc\/sudoers\.d\/citadel-worker\.new\n/, 'checked before it is put where sudo reads it');

  const q = pc();
  const refused = await q.install([], { CC_MACHINE_TOKEN: TOKEN, VISUDO: '1' });
  assert.equal(refused.code, 0, "the worker still installs: only the page's raise is missing");
  assert.equal(existsSync(join(q.r, 'etc/sudoers.d/citadel-worker')), false);
  assert.equal(existsSync(join(q.r, 'etc/sudoers.d/citadel-worker.new')), false);
  // Through sudo, whatever that sudo keeps, the caller's PATH (a bash or node of its own) is never used as root: its bash is
  // the system's, and with SUDO_USER set the stubs on this PATH (an id that says root, a systemctl) aren't run.
  assert.match(readFileSync(join(scripts, 'citadel-worker'), 'utf8'), /^#!\/bin\/bash\n/);
  const said = p.logged();
  const sudoed = await p.run(join(scripts, 'citadel-worker'), ['page-caps', '--threads', '4', '--memory', '8'], { SUDO_USER: 'citadel-worker' });
  assert.equal(sudoed.code, 1, sudoed.out);
  assert.match(sudoed.out, /Run this as root|No worker is installed here/, "the system's id, not the stub's");
  assert.equal(p.logged(), said);
});

test("citadel-worker page-caps: the worker's ask is refused unless it is --threads then --memory, whole numbers within what this PC has, and sets only that user's slice", async () => {
  const p = pc();
  const helper = join(scripts, 'citadel-worker');
  assert.equal((await p.install(['--workers', '3', '--threads', '4', '--memory', '10', '--disk', '80'])).code, 0);
  const before = p.read('etc/citadel-worker/config.json');
  const said = p.logged();
  // This PC: 16 threads (getconf) and 31 GB (meminfo).
  for (const bad of [
    [],
    ['--threads', '4'],
    ['--memory', '8', '--threads', '4'],
    ['--threads', '4', '--memory', '8', '--memory', '8'],
    ['--threads', '4', '--memory', '8', '--no-restart'],
    ['--threads', '4', '--disk', '80'],
    ['--workers', '4', '--memory', '8'],
    ['--image', 'evil', '--memory', '8'],
    ['folder', 'add', '--memory', '8'],
    ['--threads', '0', '--memory', '8'],
    ['--threads', '17', '--memory', '8'],
    ['--threads', '4; reboot', '--memory', '8'],
    ['--threads', '04', '--memory', '8'],
    ['--threads', ' 4', '--memory', '8'],
    ['--threads', '4', '--memory', '32'],
    ['--threads', '4', '--memory', '1'],
    ['--threads', '4', '--memory', '8x'],
  ]) {
    const got = await p.run(helper, ['page-caps', ...bad]);
    assert.equal(got.code, 1, bad.join(' '));
    assert.match(got.out, /Refused/, bad.join(' '));
  }
  assert.equal(p.logged(), said, 'nothing refused touched the slice, nor anything else');

  const raised = await p.run(helper, ['page-caps', '--threads', '16', '--memory', '31']);
  assert.equal(raised.code, 0, raised.out);
  assert.equal(p.read('etc/citadel-worker/config.json'), before, "the PC's own caps stay as its owner set them");
  assert.equal(p.logged().slice(said.length), 'systemctl set-property user-1001.slice CPUQuota=1600% MemoryMax=31G MemoryHigh=28569M\n', 'only the slice, and no restart: the worker that asked holds them');
});
