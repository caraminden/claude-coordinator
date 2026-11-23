import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { until } from './wait.ts';
import { HostJobs } from '../src/host-job.ts';

// #1734: a job's start wiped the last run's folder (thousands of files under load) on the server's thread, holding it 9.9 s.
const root = mkdtempSync(join(tmpdir(), 'host-job-old-'));
after(() => rmSync(root, { recursive: true, force: true })); // timing-ok: own temp dir

test("a job's start renames the last run's folder away and deletes it, and any a restart left, off the thread", async () => {
  const dir = join(root, '7');
  mkdirSync(join(dir, 'tmp'), { recursive: true });
  for (let i = 0; i < 300; i++) writeFileSync(join(dir, 'tmp', `f${i}`), 'x');
  writeFileSync(join(dir, 'code'), '0');
  mkdirSync(join(root, '7.old-1'));
  writeFileSync(join(root, '7.old-1', 'left'), 'by a restart mid-delete');
  mkdirSync(join(root, '70'));
  new HostJobs(() => false).start({ dir, cwd: root, argv: ['true'], env: {}, unit: 'u', description: 'd', ticketId: 7 });
  const olds = readdirSync(root).filter((n) => n.startsWith('7.old-'));
  assert.equal(olds.length, 2, 'the last run is renamed away, not deleted, before start returns');
  assert.ok(!readdirSync(dir).includes('code'), "the new folder starts empty of the last run's files");
  await until('the old folders are deleted in the background', () => readdirSync(root).sort().join() === '7,70');
  await until('the job ends', () => readdirSync(dir).includes('code'));
});
