// The deploy boot check's claude stand-in (#661): a launch that passes --settings as inline JSON is
// refused with a report that says so, not parsed and failed later on something else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

test('boot-check-claude fails a launch whose --settings is inline JSON, naming it', () => {
  const cwd = mkdtempSync(join(resolve(tmpdir()), 'boot-check-claude-'));
  try {
    const r = spawnSync(process.execPath, [resolve('tools/boot-check-claude.ts'), '--settings', '{"hooks":{}}'], { cwd, encoding: 'utf8', timeout: 20_000 });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    const report = JSON.parse(readFileSync(join(cwd, 'report.json'), 'utf8'));
    assert.equal(report.ok, false);
    assert.match(report.error, /inline JSON/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
