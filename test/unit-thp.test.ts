// Every service unit Citadel starts asks for huge pages only on request (src/unit-thp.ts, #1458): a unit started by
// systemd doesn't inherit the server's setting, so a starter that leaves thpProps() out brings back the reclaim storms.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeThp, systemdVersion, thpProps } from '../src/unit-thp.ts';

const SRC = join(import.meta.dirname, '..', 'src');
// systemd-run's arguments for a service unit (a scope, `--scope`, inherits from its starter and refuses the property).
const SERVICE = /'--user',\s*('--wait',\s*)?'--collect'/g;

test('every file that starts a service unit with systemd-run gives it thpProps()', () => {
  const count = (text: string, re: RegExp) => text.match(re)?.length ?? 0;
  const starts = readdirSync(SRC)
    .filter((f) => /\.(ts|mjs)$/.test(f))
    .map((f) => {
      const text = readFileSync(join(SRC, f), 'utf8');
      return { f, starts: count(text, SERVICE), given: count(text, /\.\.\.thpProps\(\)/g) };
    })
    .filter((s) => s.starts);
  assert.ok(starts.length >= 5, `found only ${starts.map((s) => s.f).join(', ')}: the pattern no longer matches how units start`);
  // One spread per start: the import alone, or one start of two given it, isn't enough.
  assert.deepEqual(
    starts.filter((s) => s.given < s.starts),
    [],
    'these start more service units than they give thpProps() (src/unit-thp.ts)',
  );
});

test("systemd's version: MemoryTHP= only from 260, since an older systemd-run refuses the whole unit", () => {
  assert.equal(systemdVersion('systemd 262 (262.2-1-arch)\n+PAM +AUDIT'), 262);
  assert.equal(systemdVersion('systemd 255 (255.4-1ubuntu8)'), 255);
  assert.equal(systemdVersion(''), 0);
});

test("the boot probe asks this systemd-run, and gives no property where it's older or missing (CI's runners)", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'thp-'));
  const path = process.env.PATH;
  try {
    const fake = (v: string) => {
      writeFileSync(join(dir, 'systemd-run'), `#!/bin/sh\necho "systemd ${v} (x)"\n`);
      chmodSync(join(dir, 'systemd-run'), 0o755);
    };
    process.env.PATH = `${dir}:${path}`;
    fake('262');
    await probeThp();
    assert.deepEqual(thpProps(), ['-p', 'MemoryTHP=madvise']);
    fake('255');
    await probeThp();
    assert.deepEqual(thpProps(), []);
    process.env.PATH = dir;
    rmSync(join(dir, 'systemd-run'));
    await probeThp();
    assert.deepEqual(thpProps(), []);
  } finally {
    process.env.PATH = path;
    rmSync(dir, { recursive: true, force: true }); // timing-ok: own temp dir
  }
});
