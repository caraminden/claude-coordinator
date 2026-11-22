// No module a worker thread loads uses top-level await (#1656). V8 aborts the whole process ("Check failed:
// !is_null()", SIGTRAP: Node 26.13.1) when a thread is terminated, by worker.terminate() or the main thread's
// process.exit(), while a module that imports a top-level-await module is still running its own top level. A reader
// thread (src/reader.ts) reached three such modules, each a CLI's `if (this file was run) { ... await ... }`, so a
// server stopped while a reader was starting died on a signal instead of exiting 0: test/restart-gap.test.ts's flakes
// (#1625) and test/host-signals.test.ts's on Nov 22. #1625 makes the exit wait for the readers, up to its grace
// period; with no top-level await in a thread's modules the abort can't happen at all, however long a reader takes.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { after, test } from 'node:test';
import { bootServer, tempRoot, until } from './helpers.ts';

const REPO = resolve(import.meta.dirname, '..');
const tmp = tempRoot('worker-tla-');
after(() => tmp.teardown());

/** The files whose own text starts a thread on a module: `new Worker(new URL(import.meta.url))` is the file itself, `new URL('./x.ts', import.meta.url)` that file. */
function workerEntries(): string[] {
  const out = new Set<string>();
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : /\.(ts|mjs)$/.test(e.name) ? [join(dir, e.name)] : []));
  for (const file of [join(REPO, 'server.ts'), ...walk(join(REPO, 'src'))]) {
    for (const m of readFileSync(file, 'utf8').matchAll(/new Worker\(\s*new URL\(\s*(?:'([^']+)',\s*)?import\.meta\.url\s*\)/g)) out.add(m[1] ? resolve(file, '..', m[1]) : file);
  }
  return [...out].sort();
}

// vm's SourceTextModule answers "does this module await at its top level" from V8's own parse; it needs a flag, so a child asks.
const SCAN = `
  import { SourceTextModule } from 'node:vm';
  import { stripTypeScriptTypes } from 'node:module';
  import { existsSync, readFileSync } from 'node:fs';
  import { dirname, resolve } from 'node:path';
  const found = {};
  for (const entry of JSON.parse(process.argv[1])) {
    const from = new Map([[entry, null]]);
    const queue = [entry];
    while (queue.length) {
      const file = queue.shift();
      const text = readFileSync(file, 'utf8');
      const js = file.endsWith('.ts') ? stripTypeScriptTypes(text) : text;
      if (file !== entry && new SourceTextModule(js, { identifier: file }).hasTopLevelAwait()) {
        const chain = [];
        for (let f = file; f; f = from.get(f)) chain.unshift(f);
        (found[entry] ??= []).push(chain);
      }
      for (const m of js.matchAll(/^\\s*(?:import|export)\\s[^'";]*?from\\s*['"](\\.[^'"]+)['"]|^\\s*import\\s*['"](\\.[^'"]+)['"]/gm)) {
        const next = resolve(dirname(file), m[1] ?? m[2]);
        if (!from.has(next) && existsSync(next)) { from.set(next, file); queue.push(next); }
      }
    }
    found[entry] ??= [];
    found[entry].push(from.size);
  }
  console.log(JSON.stringify(found));
`;

test('no module a worker thread loads awaits at its top level', () => {
  const entries = workerEntries();
  for (const known of ['src/reader.ts', 'src/front.ts', 'src/db-writer.ts']) assert.ok(entries.includes(join(REPO, known)), `the scan finds ${known}'s thread: ${entries.map((e) => relative(REPO, e)).join(', ')}`);
  const r = spawnSync(process.execPath, ['--experimental-vm-modules', '--no-warnings', '--input-type=module', '-e', SCAN, JSON.stringify(entries)], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const found = JSON.parse(r.stdout) as Record<string, (string[] | number)[]>;
  const awaits: string[] = [];
  for (const [entry, hits] of Object.entries(found)) {
    const size = hits.pop() as number;
    if (entry.endsWith('src/reader.ts')) assert.ok(size > 50, `the scan follows a thread's imports: the reader's has ${size} modules`);
    for (const chain of hits as string[][]) awaits.push(chain.map((f) => relative(REPO, f)).join(' > '));
  }
  assert.deepEqual(awaits, [], 'a thread terminated while it starts aborts the process when one of its modules awaits at its top level: move the await into a function (`void main()`)');
});

// The exit waits for a starting reader only for its grace period (#1625). One that is still starting after it
// (here: it never finishes) is cut by process.exit, which is what aborted the process.
test('on SIGTERM the server exits 0 even when a reader thread never finishes starting', async () => {
  const log = tmp.path('server.log');
  const { proc: server } = await bootServer({ root: tmp.dir, log, env: { TURN_UNITS: '0', CITADEL_READER_BOOT_WAIT: tmp.path('never-written') } });
  const closed = new Promise<string>((r) => server.once('close', (code, signal) => r(signal ? `killed by ${signal}` : `exit ${code}`)));
  await until('a reader thread to be starting', () => readFileSync(log, 'utf8').includes('Reader test hook: starting slowly'));
  server.kill('SIGTERM');
  assert.equal(await closed, 'exit 0', readFileSync(log, 'utf8').split('\n').slice(-20).join('\n'));
});
