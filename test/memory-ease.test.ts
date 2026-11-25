// Memory easing (#1748): a fake box steps free memory down and back up, and what waits on it waits, then resumes.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryEase, LEVEL_FILE, parseEpisode, type Episode, type RawMemory } from '../src/memory-ease.ts';
import { createPressure } from '../src/pressure.ts';
import { HeldStarts } from '../src/held-starts.ts';
import { Store } from '../src/db.ts';
import type { Runner } from '../src/runner.ts';
import { fake } from './typed.ts';

const GB = 1024 ** 3;
const temps: string[] = [];
after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
}); // timing-ok: own temp dir
const temp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
};
const T0 = 1_800_000_000_000;

/** A fake box: free memory and kswapd/swap counters that move at the rates you set, read every 5 s. */
function box(opts: { heavyDir?: string | null } = {}) {
  let t = T0,
    free = 12 * GB,
    reclaim = 200,
    swapPages = 0,
    kswapd = 1e6,
    pswpout = 1e5;
  const recorded: Episode[] = [];
  const logs: string[] = [];
  let waiting = { starts: 0, heavy: 0, nested: 0 };
  const read = async (now: number): Promise<RawMemory> => ({ at: now, avail: free, kswapd, pswpout });
  const ease = new MemoryEase({ heavyDir: opts.heavyDir ?? null, read, now: () => t, record: (_at, e) => recorded.push(e), waiting: () => waiting, log: (l) => logs.push(l) });
  /** Moves time on `s` seconds in 5 s readings, at the current free memory and rates. */
  const run = async (s: number) => {
    for (let i = 0; i < s / 5; i++) {
      t += 5000;
      kswapd += reclaim * 5;
      pswpout += swapPages * 5;
      await ease.tick();
    }
    return ease.get().level;
  };
  return {
    ease,
    recorded,
    logs,
    run,
    now: () => t,
    free: (gb: number) => {
      free = gb * GB;
    },
    reclaim: (n: number) => {
      reclaim = n;
    },
    swapMBs: (mb: number) => {
      swapPages = (mb * 1e6) / 4096;
    },
    waiting: (w: Partial<typeof waiting>) => {
      waiting = { ...waiting, ...w };
    },
  };
}

test('free memory falling steps ok, easing, tight; rising steps back one level at a time after 60 s calm', async () => {
  const b = box();
  assert.equal(await b.run(10), 'ok');
  b.free(5);
  assert.equal(await b.run(5), 'easing');
  assert.match(b.ease.get().why, /^5\.0 GB free \(eases under 6\.0 GB, back over 8\.0 GB\)$/);
  b.free(2.5);
  assert.equal(await b.run(5), 'tight');
  b.free(9); // well clear, but tight steps down to easing first, and only after 60 s
  assert.equal(await b.run(55), 'tight');
  assert.equal(await b.run(10), 'easing');
  assert.equal(await b.run(55), 'easing');
  assert.equal(await b.run(10), 'ok');
});

test('between the lines it holds where it is: no flapping around 6 to 8 GB', async () => {
  const b = box();
  b.free(5.9);
  assert.equal(await b.run(5), 'easing');
  b.free(7);
  assert.equal(await b.run(300), 'easing', '7 GB is over the easing line but under the back line');
  b.free(7);
  const c = box();
  c.free(7);
  assert.equal(await c.run(300), 'ok', 'and from ok, 7 GB never starts easing');
  b.free(8.5);
  b.reclaim(30_000);
  assert.equal(await b.run(120), 'easing', 'free memory back, but the kernel still reclaiming hard');
  b.reclaim(200);
  assert.equal(await b.run(65), 'ok');
});

test('reclaim or swap-out sustained for 30 s eases with plenty free; a short burst does not', async () => {
  const b = box();
  b.reclaim(40_000);
  assert.equal(await b.run(20), 'ok', 'under 30 s');
  b.reclaim(200);
  assert.equal(await b.run(10), 'ok');
  b.reclaim(40_000);
  assert.equal(await b.run(40), 'easing');
  assert.match(b.ease.get().why, /reclaiming 40,000 pages\/s for 30 s/);
  b.reclaim(100_000);
  assert.equal(await b.run(40), 'tight');
  b.reclaim(200);
  await b.run(200);
  assert.equal(b.ease.get().level, 'ok');

  const s = box();
  s.swapMBs(50);
  assert.equal(await s.run(40), 'easing');
  assert.match(s.ease.get().why, /swapping out 50 MB\/s/);
});

test('a gap between readings gives no rate, so the 30 s starts over', async () => {
  let t = T0,
    kswapd = 0;
  const e = new MemoryEase({ heavyDir: null, now: () => t, log: () => {}, read: async (now) => ({ at: now, avail: 12 * GB, kswapd, pswpout: 0 }) });
  for (let i = 0; i < 5; i++) {
    t += 5000;
    kswapd += 50_000 * 5;
    await e.tick();
  } // 25 s over the line
  t += 120_000;
  kswapd += 50_000 * 120;
  await e.tick(); // a suspended server: no rate across it
  for (let i = 0; i < 5; i++) {
    t += 5000;
    kswapd += 50_000 * 5;
    await e.tick();
  }
  assert.equal(e.get().level, 'ok', 'the 25 s before the gap does not count');
  for (let i = 0; i < 2; i++) {
    t += 5000;
    kswapd += 50_000 * 5;
    await e.tick();
  }
  assert.equal(e.get().level, 'easing');
});

test('each stretch is recorded once, back at ok, with its lowest free memory, peak and what waited', async () => {
  const b = box();
  b.free(5);
  await b.run(10);
  assert.equal(b.ease.current()?.level, 'easing');
  b.waiting({ starts: 2, heavy: 1, nested: 4 });
  b.free(2.2);
  await b.run(10);
  b.waiting({ starts: 1, heavy: 0, nested: 0 });
  b.free(10);
  await b.run(200);
  assert.equal(b.ease.current(), null);
  assert.equal(b.recorded.length, 1);
  const e = b.recorded[0];
  assert.equal(e.peak, 'tight');
  assert.equal(e.lowestFree, 2.2 * GB);
  assert.deepEqual(e.waited, { starts: 2, heavy: 1, nested: 4 });
  assert.ok(e.until! > e.since);
  assert.deepEqual(parseEpisode(JSON.stringify(e)), e);
  assert.equal(parseEpisode('not json'), null);
});

test('stop records a stretch still going', async () => {
  const b = box();
  b.free(4);
  await b.run(10);
  b.ease.stop();
  assert.equal(b.recorded.length, 1);
  assert.equal(b.recorded[0].until, b.now());
});

test('every reading rewrites the level file: the level, then why', async () => {
  const dir = temp('ease-');
  const b = box({ heavyDir: dir });
  await b.run(5);
  assert.equal(readFileSync(join(dir, LEVEL_FILE), 'utf8'), 'ok\n\n');
  b.free(2);
  await b.run(5);
  assert.match(readFileSync(join(dir, LEVEL_FILE), 'utf8'), /^tight\n2\.0 GB free \(tight under 3\.0 GB\)\n$/);
});

test('easing holds scheduled starts and pauses background passes; back at ok they go', async () => {
  const b = box();
  const dir = temp('ease-psi-');
  const quiet = 'some avg10=0.00 avg60=0.00 avg300=0.00 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=1\n';
  for (const f of ['cpu', 'memory', 'io']) writeFileSync(join(dir, f), quiet);
  const p = createPressure({ cpuFile: join(dir, 'cpu'), memFile: join(dir, 'memory'), ioFile: join(dir, 'io'), now: b.now, log: () => {} });
  p.useEase(() => b.ease.get());

  const store = new Store(':memory:');
  const project = store.createProject('One', null);
  const sent: number[] = [];
  const runner = {
    emit: () => {},
    send: (id: number) => {
      sent.push(id);
      return fake<ReturnType<Runner['send']>>({});
    },
  };
  const held = new HeldStarts({ store, runner: runner as any, read: () => p.read(), now: b.now });
  const id = store.createTicket({ project_id: project.id, title: 'A run', permission_mode: 'bypass', created_by: 'Citadel' }).id;

  b.free(5);
  await b.run(10);
  const r = await p.read();
  assert.deepEqual([r.starved, r.why], [true, 'memory easing: 5.0 GB free (eases under 6.0 GB, back over 8.0 GB)']);
  assert.equal(await p.gate('memory index'), false);
  assert.equal(await held.start({ ticket: id, from: 'Citadel', message: 'brief', opts: {} }, () => runner.send(id)), true);
  assert.equal(sent.length, 0, 'the scheduled start waits');
  await held.tick();
  assert.equal(sent.length, 0);

  b.free(10);
  await b.run(70);
  assert.equal(b.ease.get().level, 'ok');
  assert.equal((await p.read()).starved, false);
  assert.equal(await p.gate('memory index'), true, 'the pass runs again');
  await held.tick();
  assert.deepEqual(sent, [id], 'the held start goes once memory is back');
});

test("a nested session claude-pace holds shows as its turn's wait, outside the heavy line", async () => {
  const { heavyWaits } = await import('../src/waits.ts');
  const since = T0;
  const w = heavyWaits(
    {
      holders: [],
      waiters: [
        { who: 'Delve #4', what: 'a nested Claude session', since, reason: 'ease' },
        { who: 'Peek #2', what: 'npm test', since, reason: 'memory' },
      ],
    },
    () => null,
    (who) => who,
  );
  assert.equal(w.get('Delve #4')?.chip, 'session · easing off memory');
  assert.match(w.get('Delve #4')?.text ?? '', /waits while Citadel eases off memory/);
  assert.match(w.get('Peek #2')?.text ?? '', /memory/, 'a heavy job waiting on memory keeps its own line');
});
