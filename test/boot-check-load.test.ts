// tools/boot-check.ts when the box gets busy after a step began (#2009): the limit follows the load while the step runs,
// so a slow boot passes it. The load is faked from a preload: the average stays quiet while the runnable count turns busy after the step's first look.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';

const repo = join(import.meta.dirname, '..');
const root = mkdtempSync(join(tmpdir(), 'boot-check-load-'));
after(() => rmSync(root, { recursive: true, force: true }));

test('a server that listens after 25 s on a box that got busy after the start passes that step', { timeout: 150_000 }, () => {
  mkdirSync(join(root, 'public'));
  mkdirSync(join(root, 'src'));
  const db = join(root, 'coordinator.db');
  new Store(db).db.close();
  writeFileSync(join(root, 'src', 'db.ts'), `export * from ${JSON.stringify(join(repo, 'src', 'db.ts'))};\n`);
  // Listens late, then leaves: the next step's failure says the port step passed.
  writeFileSync(join(root, 'server.ts'), `setTimeout(() => { console.log('listening on http://127.0.0.1:9'); setTimeout(() => process.exit(7), 500); }, 25_000); // timing-ok: the brief's 25 s, past boot-check.ts's own 20 s, so it is red on the code from before\n`);
  const preload = join(root, 'load.mjs');
  writeFileSync(
    preload,
    `import fs from 'node:fs';
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
const cores = os.cpus().length;
let reads = 0;
// The 1-minute average stays quiet throughout; only the runnable count rises after the first look, as on Nov 25.
os.loadavg = () => [0, 0, 0];
const real = fs.readFileSync;
fs.readFileSync = (p, ...rest) => (p === '/proc/loadavg' ? \`0.00 0.00 0.00 \${reads++ ? cores * 4 : 1}/9999 1\\n\` : real(p, ...rest));
syncBuiltinESMExports();
`,
  );
  const run = spawnSync(process.execPath, ['--import', preload, join(repo, 'tools', 'boot-check.ts'), root, db], { encoding: 'utf8', timeout: 140_000 });
  assert.doesNotMatch(run.stderr, /did not say which port/);
  assert.match(run.stderr, /boot-check: server start: \d/);
  assert.match(run.stderr, /The server exited during boot \(code 7\)/);
});
