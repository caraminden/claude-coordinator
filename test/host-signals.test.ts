// A server a test boots never reads the real box's signals (#1485): its CPU, memory and IO pressure, load, memory, CPU
// counters and cgroups, or the real Pacific clock for a day or an hour. A busy box paused a test server's indexers
// (#1301) and a test went red after midnight (#1421). src/host-signals.ts is the one place those are read, and
// CITADEL_HOST_SIGNALS=fixed (bootServer sets it) pins them: fixed readings, no cgroup, and a zone where the server
// boots at noon, so no day boundary falls inside a test.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { bootServer, ok, REPO, tempRoot } from './helpers.ts';
import { until } from './wait.ts';

test('a booted server reads no host signal and runs its clock in a fixed zone at noon', async () => {
  const tmp = tempRoot('host-signals-');
  const log = tmp.path('trap.log');
  try {
    const srv = await bootServer({ root: tmp.dir, env: { NODE_OPTIONS: `--import=${join(import.meta.dirname, 'host-signal-trap.ts')}`, HOST_SIGNAL_TRAP: log } });
    try {
    // The status page's first host sample (memory, load, pressure, the CPU ledger) is taken at boot; the host-load page reads pressure.
      await until('the first host sample', async () => ok(await srv.call('/api/status')).citadel?.host?.latest);
      ok(await srv.call('/api/host-load'));
      await srv.settled();
    } finally {
      await srv.stop(); // the zone line is written as the server exits
    }
    const lines = readFileSync(log, 'utf8').trim().split('\n');
    assert.deepEqual(lines.filter((l) => !l.startsWith('zone ')), [], 'reads that reached the real box');
    assert.match(lines.find((l) => l.startsWith('zone ')) ?? 'no zone line (the server did not exit cleanly)', /^zone Etc\/GMT([+-]\d+)? hour 1[23]$/);
  } finally {
    await tmp.teardown();
  }
});

// The booted check above only sees what runs at boot and on those two pages; this one sees every reader in the code.
const HOST_READ = /\/proc\/(pressure|loadavg|meminfo|stat['/`]|self\/cgroup)|\/sys\/fs\/cgroup|\b(loadavg|availableParallelism|cpus|freemem|totalmem)\b[^\n]*from 'node:os'|from 'node:os'[^\n]*\b(loadavg|availableParallelism|cpus|freemem|totalmem)\b/;
const OK = /\/\/\s*host-signal-ok:\s*\S/;

/** "file:line" for each row that reads a host signal itself, without a `// host-signal-ok: <why>` on the row. */
export function directReads(file: string, text: string): string[] {
  return text.split('\n').flatMap((row, i) => (HOST_READ.test(row) && !OK.test(row) && !/^\s*(\/\/|\*|\/\*)/.test(row) ? [`${file}:${i + 1}`] : []));
}

const walk = (dir: string): string[] =>
  readdirSync(join(REPO, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : /\.ts$/.test(e.name) ? [join(dir, e.name)] : []));

test('the server reads host signals only through src/host-signals.ts', () => {
  assert.deepEqual(directReads('a.ts', "import { loadavg } from 'node:os';\nreadFile('/proc/pressure/cpu');\nreadFile('/proc/stat')\n// /proc/loadavg in prose\nx('/sys/fs/cgroup'); // host-signal-ok: a test\nimport { homedir } from 'node:os';"), ['a.ts:1', 'a.ts:2', 'a.ts:3']);
  const hits = [...walk('src'), 'server.ts'].filter((f) => f !== join('src', 'host-signals.ts')).flatMap((f) => directReads(f, readFileSync(join(REPO, f), 'utf8')));
  assert.deepEqual(hits, [], 'read it through src/host-signals.ts, or say why not with // host-signal-ok: <why>');
});

test('every test that starts server.ts itself pins its host signals', () => {
  const starts = /spawn\([^\n]*server\.ts'\)\]/;
  const missing = readdirSync(join(REPO, 'test')).filter((f) => f.endsWith('.ts')).filter((f) => {
    const text = readFileSync(join(REPO, 'test', f), 'utf8');
    return starts.test(text) && !text.includes("CITADEL_HOST_SIGNALS: 'fixed'");
  });
  assert.deepEqual(missing, [], "start it with bootServer, or put CITADEL_HOST_SIGNALS: 'fixed' in its env");
});
