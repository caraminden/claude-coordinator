import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { READ_WAIT_MS } from '../src/db-writer.ts';
import { bootServer, type Booted } from './helpers.ts';

// #1244: on a busy box the DB write worker lags more than the READ_WAIT_MS a read waits for it, and a request's reply
// re-read what it had just written, stale ("enabled for nobody" right after enabling), and its client's next request
// didn't find it (an invite link right after making the person). This server holds every write longer than that.
const root = mkdtempSync(join(tmpdir(), 'own-writes-'));
let srv: Booted;
before(async () => {
  srv = await bootServer({ root, env: { CITADEL_DB_WRITE_DELAY_MS: String(READ_WAIT_MS * 4) } });
});
after(async () => {
  await srv?.stop();
  rmSync(root, { recursive: true, force: true });
});

test('a reply shows what its request wrote, and the next request finds it, however far the write worker lags', async () => {
  // The invite's token is written on the worker; following the link is the client's next request.
  const ids: number[] = [];
  for (const name of ['Max', 'Olive']) {
    const made = await srv.call('/api/people', { name }, 'POST');
    assert.equal(made.status, 201);
    ids.push(made.data.person.id);
    const res = await fetch(`${srv.base}/api/invite/${made.data.token}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'a-long-password' }) });
    assert.equal(res.status, 200, `${name}'s invite link works at once: ${await res.text()}`);
    assert.ok(res.headers.get('set-cookie'), 'and signs them in');
  }
  assert.equal((await srv.call('/api/contraptions', { name: 'twin', title: 'Twin', port: 7341, open_paths: [] }, 'POST')).status, 201);
  // Each reply re-reads the row it just wrote.
  for (const login of ['max', 'olive']) {
    const on = await srv.call(`/api/contraptions/twin/people/@${login}`, { enabled: true }, 'PUT');
    assert.equal(on.status, 200);
    assert.ok(on.data.logins.includes(login), `enabled for ${login}: ${on.data.logins}`);
  }
  const off = await srv.call('/api/contraptions/twin/people/@max', { enabled: false }, 'PUT');
  assert.deepEqual(off.data.logins, ['olive']);
  const set = await srv.call('/api/contraptions/twin', { repo: 'caraminden/twin', branch: 'main', folder: '~/apps/twin' }, 'PATCH');
  assert.equal(set.status, 200);
  assert.deepEqual([set.data.repo, set.data.branch, set.data.folder], ['caraminden/twin', 'main', '~/apps/twin']);
  // Any route, not only contraptions': adding a member re-reads the scheme's members after an await.
  const scheme = (await srv.call('/api/projects', { name: 'Scheme' }, 'POST')).data;
  const added = await srv.call(`/api/projects/${scheme.id}/members`, { person: ids[0] }, 'POST');
  assert.equal(added.status, 200, JSON.stringify(added.data));
  assert.ok(
    added.data.some((m: { id: number }) => m.id === ids[0]),
    `Max is in the reply: ${added.data.map((m: { name: string }) => m.name)}`,
  );
});
