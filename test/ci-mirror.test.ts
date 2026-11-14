import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import type { Run } from '../src/ci-health.ts';
import { CiMirror, storeName, type Want } from '../src/ci-mirror.ts';
import { CiStore, RULES } from '../src/ci-store.ts';
import { Store } from '../src/db.ts';
import type { Artifact } from '../src/release-readers.ts';

// src/ci-mirror.ts (#673): a shipped run's GitHub artifact copied into the CI store once, behind the poll, within the
// store's caps, so its release links a file on perigee. The download is faked; the store is real.
const root = mkdtempSync(join(tmpdir(), 'ci-mirror-'));
after(() => rmSync(root, { recursive: true, force: true }));

test('storeName makes any artifact or file name one the store takes', () => {
  assert.equal(storeName('Peek Auras Setup.exe'), 'Peek-Auras-Setup.exe');
  assert.equal(storeName('.hidden'), 'hidden');
  assert.equal(storeName('!!!'), 'artifact');
  assert.equal(storeName('x'.repeat(200), 143).length, 143);
});

test('a mirror keeps an artifact once as its run\'s release, one file as itself and several as a .tar.gz, never past the caps, and retries a failure only after an hour', async () => {
  const store = new Store(join(root, 'm.db'));
  const p = store.createProject('Peek Auras', 'https://github.com/o/peek-auras');
  const data = join(root, 'data');
  const ci = new CiStore(store, data, undefined, { ...RULES, fileBytes: 1000, schemeBytes: 2500 });
  let files: Record<string, string> = { 'Peek Auras.exe': 'x'.repeat(40) };
  let fail = false;
  const got: string[] = [];
  const download = async (w: Want, dir: string) => {
    got.push(w.artifact.name);
    if (fail) throw Object.assign(new Error('gh failed'), { stderr: 'HTTP 410: artifact expired' });
    for (const [name, body] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), body);
    }
  };
  let clock = Date.now();
  const mirror = new CiMirror(ci, download, () => clock);
  const run = (id: number): Run => ({ id, name: 'windows', workflow_id: 1, head_branch: 'main', head_sha: 'a'.repeat(40), status: 'completed', conclusion: 'success', created_at: new Date(clock - id * 60_000).toISOString(), run_attempt: 2 });
  let dones = 0;
  const want = (id: number, a: Partial<Artifact>): Want => ({ project: p, slug: 'o/peek-auras', run: run(id), artifact: { id: id * 10, name: `peek-auras-sha${id}`, expired: false, size_in_bytes: 40, ...a }, workflow: 'windows.yml', kind: 'release', target: 'release', done: () => dones++ });
  const rows = (id: number) => store.ciFiles(p.id).filter((f) => f.run_id === id);

  // One file: kept under its own (store-safe) name, filed as the run's release, and asked for once however often it is wanted.
  mirror.want(want(1, {}));
  mirror.want(want(1, {}));
  await mirror.idle();
  assert.deepEqual(got, ['peek-auras-sha1'], 'wanted twice while queued, downloaded once');
  assert.equal(dones, 1, 'its reader is told, so it reads the store again');
  const [one] = rows(1);
  assert.deepEqual([one.name, one.kind, one.target, one.workflow, one.run_attempt, one.size, one.ref], ['Peek-Auras.exe', 'release', 'release', 'windows.yml', 2, 40, 'refs/heads/main']);
  assert.equal(one.sha256, createHash('sha256').update('x'.repeat(40)).digest('hex'));
  assert.equal(one.created_at, Date.parse(run(1).created_at), 'filed at its run\'s time, so the rules order runs as they ran');
  assert.equal(readFileSync(ci.path(one), 'utf8'), 'x'.repeat(40));

  // Several files: one .tar.gz of them, as ci-upload.sh sends a folder.
  files = { 'a.txt': 'aa', 'sub/b.txt': 'bb' };
  mirror.want(want(2, { name: 'peek auras sha2' }));
  await mirror.idle();
  const [two] = rows(2);
  assert.equal(two.name, 'peek-auras-sha2.tar.gz');
  assert.deepEqual(execFileSync('tar', ['-tzf', ci.path(two)], { encoding: 'utf8' }).split('\n').filter((l) => /\.txt$/.test(l)).sort(), ['./a.txt', './sub/b.txt']);

  // Over the caps by GitHub's own count: not even downloaded. Over them once downloaded: not kept.
  const before = got.length;
  mirror.want(want(3, { size_in_bytes: 1001 }));
  await mirror.idle();
  assert.equal(got.length, before, 'bigger than a file may be: never downloaded');
  files = { 'big.exe': 'x'.repeat(1200) };
  mirror.want(want(4, { size_in_bytes: 10 }));
  await mirror.idle();
  assert.deepEqual([got.length, rows(3).length, rows(4).length], [before + 1, 0, 0], 'bigger once unpacked: downloaded, then refused');

  // A failed download leaves nothing and waits an hour before trying again.
  fail = true;
  mirror.want(want(5, {}));
  await mirror.idle();
  fail = false;
  files = { 'ok.exe': 'ok' };
  mirror.want(want(5, {}));
  await mirror.idle();
  assert.equal(got.filter((n) => n === 'peek-auras-sha5').length, 1, 'not again within the hour');
  clock += 61 * 60_000;
  mirror.want(want(5, {}));
  await mirror.idle();
  assert.deepEqual(rows(5).map((f) => f.name), ['ok.exe'], 'tried again after it');

  // No part folders left in any run's folder.
  const left = readdirSync(join(ci.dir(p.id), 'windows.yml'), { recursive: true }).map(String);
  assert.deepEqual(left.filter((f) => f.includes('.part')), []);
  assert.ok(!existsSync(join(ci.dir(p.id), 'windows.yml', '3-2')) && !existsSync(join(ci.dir(p.id), 'windows.yml', '4-2')), 'a refused run leaves no folder');
});
