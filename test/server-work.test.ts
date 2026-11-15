import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Landings } from '../src/land.ts';
import { serverWorkWatch } from '../src/server-work.ts';
import { isWorking } from '../public/schemecounts.js';

test("server work (#727): a handed-off land is working until it settles, and its row is sent at each end", (t) => {
  const data = mkdtempSync(join(tmpdir(), 'server-work-'));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  const landings = new Landings(data);
  let clock = 0;
  const sent: number[] = [];
  const work = serverWorkWatch(() => landings.handoffs(), (id) => sent.push(id), () => clock);
  // What Landings.handOff leaves, without running land.sh.
  const dir = join(data, 'run', 'landings', '5');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'handoff.json'), JSON.stringify({ summary: 's', risk: 'low', reason: 'r', args: [] }));

  assert.deepEqual(work.of(5), { kind: 'land' });
  assert.equal(work.of(6), null, 'another minion');
  assert.equal(isWorking({ status: 'idle', server_work: work.of(5) }), true, 'its scheme counts it working');
  work.sync();
  assert.deepEqual(sent, [5], 'its row is sent as the land starts');
  work.sync();
  assert.deepEqual(sent, [5], 'nothing moved: nothing sent');

  landings.settled(5);
  assert.deepEqual(work.of(5), { kind: 'land' }, 'read at most once a second');
  work.sync();
  assert.deepEqual(sent, [5, 5], 'settled: its row is sent again');
  assert.equal(work.of(5), null);
  assert.equal(isWorking({ status: 'idle', server_work: work.of(5) }), false, 'and no longer counts');
  clock += 1001;
  assert.equal(work.of(5), null);
});
