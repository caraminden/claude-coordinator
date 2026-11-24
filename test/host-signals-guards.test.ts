// The static halves of test/host-signals.test.ts (#1485, #1536), split out in #1621 so they run on every citadel-test run
// (tools/always-tests.txt): they read every file of the repo, so no map picks them, and they take well under a second.
// The tests that boot a server stay in host-signals.test.ts, on the map.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { REPO, TEST_ZONE } from './helpers.ts';

// The booted check above only sees what runs at boot and on those two pages; this one sees every reader in the code.
const HOST_READ = /\/proc\/(pressure|loadavg|meminfo|stat['/`]|self\/cgroup)|\/sys\/fs\/cgroup|\b(loadavg|availableParallelism|cpus|freemem|totalmem)\b[^\n]*from 'node:os'|from 'node:os'[^\n]*\b(loadavg|availableParallelism|cpus|freemem|totalmem)\b/;
const OK = /\/\/\s*host-signal-ok:\s*\S/;

/** "file:line" for each row that reads a host signal itself, without a `// host-signal-ok: <why>` on the row. */
export function directReads(file: string, text: string): string[] {
  return text.split('\n').flatMap((row, i) => (HOST_READ.test(row) && !OK.test(row) && !/^\s*(\/\/|\*|\/\*)/.test(row) ? [`${file}:${i + 1}`] : []));
}

const walk = (dir: string): string[] => readdirSync(join(REPO, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : /\.ts$/.test(e.name) ? [join(dir, e.name)] : []));

test('the server reads host signals only through src/host-signals.ts', () => {
  assert.deepEqual(directReads('a.ts', "import { loadavg } from 'node:os';\nreadFile('/proc/pressure/cpu');\nreadFile('/proc/stat')\n// /proc/loadavg in prose\nx('/sys/fs/cgroup'); // host-signal-ok: a test\nimport { homedir } from 'node:os';"), ['a.ts:1', 'a.ts:2', 'a.ts:3']);
  const hits = [...walk('src'), 'server.ts'].filter((f) => f !== join('src', 'host-signals.ts')).flatMap((f) => directReads(f, readFileSync(join(REPO, f), 'utf8')));
  assert.deepEqual(hits, [], 'read it through src/host-signals.ts, or say why not with // host-signal-ok: <why>');
});

/** "file:line" for each spawn of server.ts whose call (up to its first `})`) doesn't set CITADEL_HOST_SIGNALS: 'fixed' and hand it the test's CITADEL_ZONE. */
export function unpinnedStarts(file: string, text: string): string[] {
  return [...text.matchAll(/spawn\([^\n]*server\.ts'/g)].flatMap((m) => {
    const end = text.indexOf('})', m.index);
    const call = text.slice(m.index, end === -1 ? undefined : end);
    return call.includes("CITADEL_HOST_SIGNALS: 'fixed'") && call.includes('CITADEL_ZONE: ') ? [] : [`${file}:${text.slice(0, m.index).split('\n').length}`];
  });
}

test('every test that starts server.ts itself pins its host signals and hands it its zone', () => {
  assert.deepEqual(
    unpinnedStarts(
      'a.ts',
      "spawn(node, [join(r, 'server.ts')], {\n  env: { PORT: '0' },\n});\nspawn(node, [join(r, 'server.ts')], { env: { CITADEL_HOST_SIGNALS: 'fixed', CITADEL_ZONE: TEST_ZONE } });\nspawn(node, ['-e', `spawn(x, [${s(join(r, 'server.ts'))}], { env: {} })`]); // CITADEL_HOST_SIGNALS: 'fixed', CITADEL_ZONE: \nspawn(node, [join(r, 'server.ts')], { env: { CITADEL_HOST_SIGNALS: 'fixed' } });",
    ),
    ['a.ts:1', 'a.ts:5', 'a.ts:6'],
  );
  const missing = readdirSync(join(REPO, 'test'))
    .filter((f) => f.endsWith('.ts') && f !== 'host-signals.test.ts' && f !== 'host-signals-guards.test.ts')
    .flatMap((f) => unpinnedStarts(join('test', f), readFileSync(join(REPO, 'test', f), 'utf8')));
  assert.deepEqual(missing, [], "start it with bootServer, or put CITADEL_HOST_SIGNALS: 'fixed' and CITADEL_ZONE: TEST_ZONE in its env");
});
