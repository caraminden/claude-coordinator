// The per-file leak count (test/leak-file.ts, #1763): a test file that leaves a process, a unit, a listening port and a
// temp folder behind goes red naming each, and is cleaned up after; a clean file stays green.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { judge, KINDS, readBaseline, type Leftovers } from './leak-file.ts';

const GUARD = join(import.meta.dirname, 'leak-guard.ts');
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
// systemd-run --user needs the user's systemd: perigee and the CI runners have it; a container turn may not.
const hasUnits = spawnSync('systemd-run', ['--user', '--quiet', '--collect', '--wait', 'true'], { stdio: 'ignore' }).status === 0;

const LEAKY = `import { test } from 'node:test';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
test('leaves one of each behind', async () => {
  mkdtempSync(join(tmpdir(), 'left-'));
  // Detached, so it outlives the file: a listener on a port of its own.
  const p = spawn(process.execPath, ['-e', 'require("net").createServer().listen(0, "127.0.0.1", () => console.log("up")); setInterval(() => {}, 1e6)'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise((r) => p.stdout.once('data', r));
  p.stdout.destroy();
  p.unref();
  let unit = '';
  if (process.env.LEAKFIX_UNITS) {
    unit = 'citadel-leakfix-' + process.pid + '.service';
    // In a unit of its own, as a test server's turn supervisor is: not a child, no inherited environment; its command line names the file's temp folder.
    execFileSync('systemd-run', ['--user', '--quiet', '--collect', '--unit=' + unit, 'sh', '-c', 'sleep 300; :', 'leakfix', tmpdir()]);
  }
  writeFileSync(process.env.LEAKFIX_OUT, JSON.stringify({ pid: p.pid, unit }));
});
`;
const CLEAN = `import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
test('cleans up after itself', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mine-'));
  const p = spawn('sleep', ['30', dir], { stdio: 'ignore' });
  p.kill();
  await new Promise((r) => p.once('exit', r));
  rmSync(dir, { recursive: true }); // timing-ok: the fixture's own temp dir
});
`;

test('a file that leaves a process, a port, a unit and a temp folder goes red naming each, and is cleaned up; a clean file stays green', { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'leakfix-'));
  try {
    writeFileSync(join(dir, 'leaky.test.mjs'), LEAKY);
    writeFileSync(join(dir, 'clean.test.mjs'), CLEAN);
    const out = join(dir, 'out.json');
    const env = { ...process.env, LEAKFIX_OUT: out, ...(hasUnits ? { LEAKFIX_UNITS: '1' } : {}) };
    delete env.NODE_TEST_CONTEXT; // else the nested node --test runs as this file's child, not as a runner
    const r = await new Promise<{ code: number | null; text: string }>((resolve) => {
      const p = spawn(process.execPath, ['--test', '--test-reporter=spec', `--test-global-setup=${GUARD}`, 'leaky.test.mjs', 'clean.test.mjs'], { cwd: dir, env });
      let text = '';
      p.stdout.on('data', (d) => (text += d));
      p.stderr.on('data', (d) => (text += d));
      p.on('close', (code) => resolve({ code, text }));
    });
    assert.notEqual(r.code, 0, r.text);
    const left = JSON.parse(readFileSync(out, 'utf8')) as { pid: number; unit: string };
    assert.match(r.text, /leak guard: \S*leaky\.test\.mjs left these behind/, r.text);
    assert.doesNotMatch(r.text, /clean\.test\.mjs left/, r.text);
    assert.match(r.text, new RegExp(`process\\(es\\) still running:[\\s\\S]*${left.pid} `), r.text);
    assert.match(r.text, new RegExp(`TCP port\\(s\\) still listening:\\s+\\d+ \\(pid ${left.pid}\\)`), r.text);
    assert.match(r.text, /entr\(ies\) left in its temp folder:\s+left-/, r.text);
    assert.match(r.text, /✖ leaky\.test\.mjs/, r.text);
    assert.match(r.text, /✔ cleans up after itself/, r.text);
    assert.equal(alive(left.pid), false, 'the leaked process was killed');
    if (hasUnits) {
      assert.match(r.text, new RegExp(`user unit\\(s\\) still running:\\s+${left.unit.replace(/\./g, '\\.')}`), r.text);
      const state = spawnSync('systemctl', ['--user', 'is-active', left.unit], { encoding: 'utf8' }).stdout.trim();
      assert.notEqual(state, 'active', 'the leaked unit was stopped');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true }); // timing-ok: own temp dir
  }
});

const none: Leftovers = { procs: [], units: [], ports: [], tmp: [] };

test('a baseline lets a file leave as many as it allows, fails one more, and asks to be lowered when it leaves fewer', () => {
  const two = { ...none, tmp: ['a', 'b'] };
  assert.equal(judge('x.test.ts', two, { tmp: 2 }).fail, false);
  assert.equal(judge('x.test.ts', two, { tmp: 2 }).text, '');
  const over = judge('x.test.ts', two, { tmp: 1 });
  assert.equal(over.fail, true);
  assert.match(over.text, /2 entr\(ies\) left in its temp folder \(its baseline allows 1\)/);
  const under = judge('x.test.ts', { ...none, tmp: ['a'] }, { tmp: 2 });
  assert.equal(under.fail, false);
  assert.match(under.text, /now leaves 1 where test\/leak-baseline\.json allows 2 \(tmp\): lower it/);
  assert.equal(judge('x.test.ts', { ...none, ports: [[80, 1]] }, { tmp: 5 }).fail, true, 'a baseline for one kind allows no other');
});

test('a test process that is not a test file of a guarded run loads the counter but does nothing', () => {
  // A plain node with the counter preloaded and no runner above it: no temp folder of its own, no exit check.
  const r = spawnSync(process.execPath, ['--import', join(import.meta.dirname, 'leak-file.ts'), '-e', 'console.log(process.env.TMPDIR ?? "", process.env.CITADEL_LEAK_FILE ?? "none")'], {
    encoding: 'utf8', env: { ...process.env, CITADEL_LEAK_FILES: '1', TMPDIR: '/tmp' },
  });
  assert.equal(r.stdout.trim(), `/tmp ${process.env.CITADEL_LEAK_FILE ?? 'none'}`, r.stderr);
});

test('the baseline names only test files that exist, with a positive count of a known kind for each', () => {
  for (const [file, counts] of Object.entries(readBaseline())) {
    assert.ok(existsSync(join(import.meta.dirname, file)), `test/leak-baseline.json names ${file}, which is gone: drop its line`);
    for (const [kind, n] of Object.entries(counts)) {
      assert.ok((KINDS as string[]).includes(kind), `${file}: ${kind} is not one of ${KINDS.join(', ')}`);
      assert.ok(Number.isInteger(n) && n! > 0, `${file}: ${kind} ${n}: a count of none goes, with its line once it is empty`);
    }
  }
});
