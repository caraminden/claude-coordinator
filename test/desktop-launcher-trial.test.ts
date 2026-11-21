import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// The desktop launcher's trial rules (#1396): kit/desktop-launcher/Trial.cs, built for .NET 8 with its tests
// (kit/desktop-launcher/tests) so they run off Windows. The probation window, the roll back after a crash inside it, and
// one more try before a build is refused. It needs perigee's .NET SDK (~/.dotnet); a machine without one skips it.
const root = join(import.meta.dirname, '..');
const src = join(root, 'kit/desktop-launcher');
const home = join(homedir(), '.dotnet/dotnet');
const dotnet = existsSync(home) ? home : 'dotnet';
const found = spawnSync(dotnet, ['--list-sdks'], { encoding: 'utf8' });
const skip = found.error || !/^\d+\./m.test(found.stdout ?? '') ? 'no .NET SDK' : false;

test('the launcher\'s trial rules pass their tests', { skip, timeout: 240_000 }, () => {
  // Built in a copy, so the kit folder gets no obj/ or bin/.
  const tmp = mkdtempSync(join(tmpdir(), 'launcher-trial-'));
  try {
    cpSync(join(src, 'Trial.cs'), join(tmp, 'Trial.cs'));
    cpSync(join(src, 'tests'), join(tmp, 'tests'), { recursive: true, filter: (p) => !/[\\/](obj|bin)$/.test(p) });
    const r = spawnSync(dotnet, ['run', '--project', join(tmp, 'tests/TrialTests.csproj'), '-nologo', '-v', 'q'], {
      cwd: tmp, encoding: 'utf8', timeout: 230_000,
      env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1', DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1' },
    });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    const fails = out.split('\n').filter((l) => l.startsWith('FAIL ') || /error CS\d+/.test(l));
    assert.deepEqual(fails, [], out.slice(-3000));
    assert.match(out, /^all passed$/m, out.slice(-3000));
    assert.ok((out.match(/^ok /gm) ?? []).length >= 13, 'every test ran');
    assert.equal(r.status, 0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
