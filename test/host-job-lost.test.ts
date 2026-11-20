import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { HostJobs, jobLost } from '../src/host-job.ts';

// #1325: a ship's unit killed from outside (systemd-oomd, on Nov 20) left no record but the journal; now the server hears it once.
const root = mkdtempSync(join(tmpdir(), 'host-job-lost-'));
after(() => rmSync(root, { recursive: true, force: true }));

test('a job that ended with no exit code is heard once, and keeps reading as code -1', () => {
  const heard: string[] = [];
  const before = jobLost.hear;
  jobLost.hear = (dir) => heard.push(dir);
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
