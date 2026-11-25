import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

// The Windows test rigs (#1948): they fail on what they could not see, and touch only their own run. The rigs need a
// Windows box, so keys.mjs's refusals run for real (they come before anything Windows) and the rest are pinned in the
// source; the box runs are in the ship's note.
const dir = join(import.meta.dirname, '..', 'kit/skills/run-on-windows/scripts');
const src = (f: string) => readFileSync(join(dir, f), 'utf8');

test('keys.mjs refuses a mode that runs nothing, and edge with rclick, instead of passing', () => {
  for (const args of [
    ['checkout', 'key'],
    ['edge', 'rclick'],
    ['edge', 'bogus'],
  ]) {
    const r = spawnSync(process.execPath, [join(dir, 'electron-app/keys.mjs'), ...args], { encoding: 'utf8', env: { ...process.env, TEMP: '/nonexistent-for-test' } });
    assert.equal(r.status, 1, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /^FAIL nothing to run/m, args.join(' '));
  }
});

test('keys.mjs counts a rig that sees no menu as a failure, and every exit after the app starts takes it down', () => {
  const k = src('electron-app/keys.mjs');
  assert.match(k, /if \(!items\) \{\s*fails\+\+;/);
  assert.doesNotMatch(k, /process\.exit\(1\)[\s\S]*process\.exit\(1\)/, 'the early exits go through quit()');
  assert.match(k, /await quit\(1\)/);
});

test("reload.mjs drops an old page's marks, fails with no timed reload, and uses its own profile except live", () => {
  const r = src('electron-app/reload.mjs');
  assert.match(r, /r\.origin < t0 - 5\) r = null/);
  assert.match(r, /if \(!rows\.length\) \{[\s\S]*process\.exit\(1\)/);
  assert.match(r, /const profile = live \? null : mkdtempSync/);
  assert.match(r, /process\.on\('exit'/);
});

test('drag.mjs has its own profile, stops on a page error and takes the app down when it throws', () => {
  const d = src('electron-app/drag.mjs');
  assert.match(d, /--user-data-dir=\$\{profile\}/);
  assert.match(d, /r\.exceptionDetails\) throw/);
  assert.match(d, /process\.on\('exit'[\s\S]*app\.kill\(\)[\s\S]*ps\.kill\(\)/);
});

test('install.ps1 counts only its own windows and removes only a shortcut that points into its folder', () => {
  const i = src('electron-app/install.ps1');
  assert.match(i, /\$_\.MainWindowTitle -and \$_\.Path -like "\$dir\*"/);
  assert.match(i, /CreateShortcut\(\$lnk\)\.TargetPath -like "\$dir\*"/);
  assert.doesNotMatch(i, /Remove-Item -Force -ErrorAction SilentlyContinue \(Join-Path \(\[Environment\]/);
});

test("cleanup.ps1 ends its own run only: another live driver's Edge, shortcuts and folder stay; rig.ts passes -Run", () => {
  const c = src('wco/cleanup.ps1');
  assert.match(c, /param\(\[string\]\$Run/);
  assert.match(c, /function Others/);
  assert.match(c, /if \(\$live\.Count\)/);
  assert.match(src('wco/rig.ts'), /-File \$c -Run '\$\{runUrl\}'/);
});

test('check.ps1 resets the process per case, says NOT RUN and NOT COPIED, and always prints the detections', () => {
  const c = src('defender-copy/check.ps1');
  assert.match(c, /\$p = \$null/);
  assert.match(c, /NOT RUN/);
  assert.match(c, /NOT COPIED/);
  assert.match(c, /new detections: \$\(\$new\.Count\)/);
});
