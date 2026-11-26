import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { bootServer, type Booted, tempRoot, until } from './helpers.ts';

// #2101 (Josh, 2026-11-26, "Why does the home screen take so long to load?"): after each deploy the first Home open read
// 15 days of ship notes from a cold events.db before answering (14.2 s live; 15.7-17.3 s cold on an 830 MB copy, 50 ms
// warm). The server now reads them as it starts, so Home finds them held.
const tmp = tempRoot('home-warm-');
const LOG = join(tmp.dir, 'server.log');
let srv: Booted | undefined;
after(async () => {
  await srv?.stop();
  await tmp.teardown();
});

test("the server reads Home's ship notes as it starts, before anyone opens Home, and Home answers from them", { timeout: 120_000 }, async () => {
  mkdirSync(join(tmp.dir, 'data'), { recursive: true });
  const seed = new Store(join(tmp.dir, 'data', 'coordinator.db'));
  seed.createProject('Placeholder one', null);
  seed.createProject('Placeholder two', null);
  // Ownerless, so the server's first start gives it to its admin, who signs in below.
  const scheme = seed.createProject('Peek Auras', null);
  const t = seed.createTicket({ project_id: scheme.id, title: 'one', permission_mode: 'bypassPermissions', created_by: 'cara' });
  seed.addEvent(t.id, 'note', { text: 'Shipped aaa1111: one. Risk low: x.' });
  seed.db.close();
  srv = await bootServer({ root: tmp.dir, log: LOG });
  const line = await until("the start's read of Home's ship notes", () => /Home's ship notes read: (\d+) in \d+ ms/.exec(readFileSync(LOG, 'utf8')));
  assert.equal(line[1], '1', 'the one ship note');
  const home = await srv.call('/api/home');
  assert.equal(home.status, 200);
  const peek = home.data.schemes.find((s: { name: string }) => s.name === 'Peek Auras');
  assert.equal(
    peek.daily.reduce((a: number, b: number) => a + b, 0),
    1,
    "Home's bars come from the notes read at the start",
  );
  assert.equal(readFileSync(LOG, 'utf8').match(/Home's ship notes read/g)?.length, 1, 'read once');
});
