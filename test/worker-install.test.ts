// Part 1 of 3 of the worker-install tests (#2208); the shared setup is in worker-install-setup.ts.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { before, test } from 'node:test';
import { TOKEN, n, pc } from './worker-install-setup.ts';

test('on a Windows PC the clock is turned off before anything else, then Windows is put out of reach, then it stops for a restart', async () => {
  const p = pc({ wsl: true });
  const first = await p.install();
  assert.equal(first.code, 10, first.out);
  assert.equal(p.logged(), 'systemctl mask --now systemd-timesyncd\n', 'nothing at all before it, and nothing more this time');
  assert.match(p.read('etc/wsl.conf'), /\[automount\]\nenabled=false\nmountFsTab=false\n[^]*\[interop\]\nenabled=false\nappendWindowsPath=false/);
  assert.equal(existsSync(join(p.r, 'users')), false);

  // Restarted, but Windows is still there: refused before anything is installed.
  mkdirSync(join(p.r, 'mnt/c/Windows'), { recursive: true });
  const reached = await p.install();
  assert.equal(reached.code, 1);
  assert.match(reached.out, /C: is still mounted/);
  assert.equal(existsSync(join(p.r, 'users')), false);
});

test('a plain Linux PC keeps its clock and its settings, and gets the worker: its user, caps, token and service', async () => {
  const p = pc();
  const done = await p.install(['--workers', '3', '--threads', '4', '--memory', '10', '--disk', '80']);
  assert.equal(done.code, 0, done.out);
  assert.doesNotMatch(p.logged(), /timesyncd/);
  assert.equal(existsSync(join(p.r, 'etc/wsl.conf')), false);
  assert.deepEqual(JSON.parse(p.read('etc/citadel-worker/config.json')), { workers: 3, threads: 4, memory_gb: 10, disk_gb: 80, root: join(p.r, 'home/citadel-worker/worker') });
  assert.match(p.logged(), /systemctl set-property user-1001\.slice CPUQuota=400% MemoryMax=10G MemoryHigh=9216M/);
  assert.equal(p.read('etc/citadel-worker/machine-token'), TOKEN);
  assert.equal(p.mode('etc/citadel-worker/machine-token'), '640');
  assert.equal(p.mode('etc/citadel-worker'), '750');
  assert.equal(p.mode('home/citadel-worker'), '700');
  assert.ok(Math.abs(Number(p.read('etc/citadel-worker/installed')) - Date.now()) < 60_000, 'when it was installed, for which of two PCs has this token');
  assert.match(p.logged(), /chown root:citadel-worker machine-token/);
  const unit = p.read('home/citadel-worker/.config/systemd/user/citadel-worker.service');
  assert.match(unit, /ExecStart=\S+node \S+\/app\/worker-agent\.mjs http:\/\/127\.0\.0\.1:\d+ \S+\/etc\/citadel-worker\/config\.json\n/);
  assert.match(unit, /RestartPreventExitStatus=64\n/);
  assert.match(unit, /KillMode=process\n/, 'a restart of the program leaves running minions be');
  assert.doesNotMatch(unit + done.out + p.logged(), new RegExp(TOKEN), 'the token is in its one file');
  assert.match(p.read('etc/subuid'), /^citadel-worker:524288:65536$/m);
  assert.match(done.out, /The worker is running[^]*sign in to Claude and GitHub/);
});

test("run again, it keeps the owner's own settings and changes the caps given; a worker that cannot connect is said", async () => {
  const p = pc();
  assert.equal((await p.install()).code, 0);
  const cfg = { ...JSON.parse(p.read('etc/citadel-worker/config.json')), image: 'localhost/mine' };
  writeFileSync(join(p.r, 'etc/citadel-worker/config.json'), JSON.stringify(cfg));
  const again = await p.install(['--workers', '2'], { CC_MACHINE_TOKEN: TOKEN, SAYS: "This worker can't start: nope" });
  assert.equal(again.code, 1);
  assert.match(again.out, /can't start: nope[^]*not reached Citadel yet/, 'not the line of the run before');
  assert.deepEqual(JSON.parse(p.read('etc/citadel-worker/config.json')), { ...cfg, workers: 2 });
  assert.equal(p.logged().match(/useradd/g)!.length, 1);
  assert.equal(p.read('etc/subuid').match(/citadel-worker/g)!.length, 1);
});
