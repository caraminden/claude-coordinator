import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

// tools/citadel-app-heavy (#847): an app's way into the heavy slots, capped and one app at a time, on a throwaway lock folder.
const tool = join(import.meta.dirname, '..', 'tools', 'citadel-app-heavy');
const root = mkdtempSync(join(tmpdir(), 'app-heavy-'));
after(() => rmSync(root, { recursive: true, force: true }));
const pressure = join(root, 'pressure');
writeFileSync(pressure, 'some avg10=1.00 avg60=1.00 avg300=1.00 total=1\n');
let n = 0;
function env(app: string, more: Record<string, string> = {}) {
  return { ...process.env, CITADEL_HEAVY_HELD: undefined, CITADEL_HEAVY_WHO: undefined, CITADEL_HEAVY_DIR: join(root, `locks-${n}`), CITADEL_HEAVY_SLOTS: '2', CITADEL_HEAVY_PRESSURE: pressure, CITADEL_HEAVY_POLL: '0.1', BASE_PATH: `/apps/${app}`, ...more };
}
async function until(what: string, check: () => boolean) {
  for (let i = 0; i < 400 && !check(); i++) await new Promise((r) => setTimeout(r, 25));
  assert.ok(check(), `timed out waiting for ${what}`);
}

test("it runs the step with its status and puts the app's name in the history", () => {
  n++;
  const r = spawnSync(tool, ['sh', '-c', 'echo hi; exit 3'], { env: env('trip'), encoding: 'utf8' });
  assert.equal(r.status, 3);
  assert.equal(r.stdout, 'hi\n');
  const line = readFileSync(join(root, `locks-${n}`, 'history'), 'utf8').trim().split('\t');
  assert.equal(line[1], 'trip (app)');
  assert.equal(spawnSync(tool, [], { env: env('trip') }).status, 2);
});

test('a hold past the cap is stopped with 124 and told to split the work', () => {
  n++;
  const began = Date.now();
  const r = spawnSync(tool, ['sleep', '30'], { env: env('trip', { CITADEL_HEAVY_APP_CAP: '1' }), encoding: 'utf8' });
  assert.equal(r.status, 124);
  assert.ok(Date.now() - began < 10_000);
  assert.match(r.stderr, /capped at 0 min 1 s\. Split the work into shorter steps/);
});

test('apps hold one slot between them: a second app waits outside the line, then runs', async () => {
  n++;
  const go = join(root, 'go'), aUp = join(root, 'a-up'), bUp = join(root, 'b-up');
  const a = spawn(tool, ['sh', '-c', `touch '${aUp}'; i=0; while [ ! -e '${go}' ] && [ $i -lt 600 ]; do sleep 0.05; i=$((i + 1)); done`], { env: env('one'), stdio: 'ignore' });
  const aDone = new Promise((r) => a.on('close', r));
  await until('the first app to start', () => existsSync(aUp));
  const b = spawn(tool, ['touch', bUp], { env: env('two'), stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  b.stderr!.on('data', (d) => (err += d));
  const bDone = new Promise((r) => b.on('close', r));
  try {
    await until('the second app to say it waits', () => /another app holds/.test(err));
    assert.ok(!existsSync(bUp), 'the second app waits though a slot is free');
    const next = join(root, `locks-${n}`, 'queue.who');
    assert.ok(!(existsSync(next) && readFileSync(next, 'utf8').includes('two (app)')), "it keeps no place in citadel-heavy's line");
  } finally {
    writeFileSync(go, '');
  }
  assert.equal(await aDone, 0);
  assert.equal(await bDone, 0);
  assert.ok(existsSync(bUp));
});
