import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { HostJobs, jobLost, oomKilled } from '../src/host-job.ts';

// #1325: a ship's unit killed from outside (systemd-oomd, on Nov 20) left no record but the journal; now the server hears it once.
const root = mkdtempSync(join(tmpdir(), 'host-job-lost-'));
after(() => rmSync(root, { recursive: true, force: true }));

test('a job that ended with no exit code is heard once, and keeps reading as code -1', () => {
  const heard: string[] = [], details: string[] = [];
  const before = jobLost.hear;
  jobLost.hear = (dir, detail) => (heard.push(dir), details.push(detail));
  try {
    const jobs = new HostJobs(() => false);
    const dir = join(root, 'land-1');
    mkdirSync(dir);
    // Started long ago, its wrapper gone (no live pid), no code written: its unit was killed.
    writeFileSync(join(dir, 'started'), String(Date.now() - 3600_000));
    writeFileSync(join(dir, 'pid'), '999999999');
    assert.equal(jobs.state(dir, 100)!.code, -1);
    assert.equal(jobs.state(dir, 100)!.code, -1);
    assert.deepEqual(heard, [dir]);
    assert.deepEqual(details, [`${dir}: ended with no exit code (killed from outside, stopped, or cut off by a restart)`]);
    assert.equal(readFileSync(join(dir, 'code'), 'utf8'), '-1');
    // A job that ended with its code is never heard.
    const done = join(root, 'land-2');
    mkdirSync(done);
    writeFileSync(join(done, 'started'), '1');
    writeFileSync(join(done, 'code'), '0');
    assert.equal(jobs.state(done, 100)!.code, 0);
    assert.deepEqual(heard, [dir]);
    assert.equal(existsSync(join(root, 'nothing')), false);
    assert.equal(jobs.state(join(root, 'nothing'), 100), null);
    assert.deepEqual(heard, [dir], 'no job at all is not a lost one');
  } finally {
    jobLost.hear = before;
  }
});

test("a lost unit's own journal says whether memory killed it: systemd-oomd, the kernel's OOM killer or its result", async () => {
  const says = (text: string) => oomKilled('citadel-land-1', async () => text);
  assert.equal(await says('citadel-land-1.service: systemd-oomd killed 12 process(es) in this unit.'), true);
  assert.equal(await says('citadel-land-1.service: The kernel OOM killer killed some processes in this unit.'), true);
  assert.equal(await says("citadel-land-1.service: Failed with result 'oom-kill'."), true);
  assert.equal(await says("citadel-land-1.service: Failed with result 'signal'."), false);
  assert.equal(await oomKilled('citadel-land-1', async () => { throw new Error('no journalctl'); }), false);
});

test("a job's TMPDIR is on disk in its folder, not perigee's RAM-backed /tmp; one already on disk is kept (#1339)", async () => {
  const jobs = new HostJobs(() => false);
  const run = async (name: string, env: Record<string, string>) => {
    const dir = join(root, name);
    jobs.start({ dir, cwd: root, argv: ['sh', '-c', 'echo "$TMPDIR $TMP $TEMP"'], env: { PATH: process.env.PATH!, ...env }, unit: `t-${name}`, description: name, ticketId: 0 });
    for (let i = 0; i < 100 && !existsSync(join(dir, 'code')); i++) await new Promise((r) => setTimeout(r, 50));
    return readFileSync(join(dir, 'output.log'), 'utf8').trim();
  };
  assert.equal(await run('tmpfs', { TMPDIR: '/tmp' }), `${join(root, 'tmpfs', 'tmp')} ${join(root, 'tmpfs', 'tmp')} ${join(root, 'tmpfs', 'tmp')}`);
  assert.match(await run('unset', {}), new RegExp(`^${join(root, 'unset', 'tmp')} `));
  assert.match(await run('disk', { TMPDIR: root }), new RegExp(`^${root}\\s*$`));
});
