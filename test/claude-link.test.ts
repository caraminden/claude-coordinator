// ClaudeLink's sign-in (link()): what a person sees when two starts overlap, when no link shows in time,
// and when the sign-in ends while waiting for their code (#468 S02-7, S02-8). A fake `podman` on PATH
// stands in for `podman exec … claude auth login`; how it behaves is the FAKE_PODMAN env var.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { ClaudeLink } from '../src/claude-link.ts';
import { Containers, type RunCmd } from '../src/containers.ts';
import { Credentials } from '../src/credentials.ts';
import { Store } from '../src/db.ts';
import { until } from './helpers.ts';

const root = mkdtempSync(join(tmpdir(), 'claude-link-'));
after(() => rmSync(root, { recursive: true, force: true }));
const bin = join(root, 'bin');
mkdirSync(bin);
const execs = join(root, 'execs.log');
writeFileSync(execs, '');
writeFileSync(join(bin, 'podman'), `#!${process.execPath}
require('node:fs').appendFileSync(${JSON.stringify(execs)}, process.argv.slice(2).join(' ') + '\\n');
const mode = process.env.FAKE_PODMAN;
if (mode === 'silent') setInterval(() => {}, 1000);
if (mode === 'link-then-exit') {
  console.log('Open https://claude.ai/oauth/authorize?x=1 to sign in');
  setTimeout(() => process.exit(0), 100);
}
`);
chmodSync(join(bin, 'podman'), 0o755);
writeFileSync(join(bin, 'claude'), '', { mode: 0o755 });
process.env.PATH = `${bin}:${process.env.PATH}`;

const store = new Store(join(root, 'test.db'));
const fakeRun: RunCmd = async () => ({ code: 0, stdout: '', stderr: '' });
let n = 0;
function newLink() {
  const user = store.createUser({ name: `P${++n}`, login: `p${n}` });
  const link = new ClaudeLink(store, new Credentials(store, 'x'.repeat(40)), join(root, 'data'), join(bin, 'claude'), new Containers(fakeRun), `citadel-claude-l${n}-`);
  return { link, uid: user.id };
}
const execCount = () => readFileSync(execs, 'utf8').split('\n').filter(Boolean).length;

test('a sign-in started again while the container starts leaves no orphan sign-in behind (#468 S02-7)', async () => {
  process.env.FAKE_PODMAN = 'link-then-exit';
  const before = execCount();
  const { link, uid } = newLink();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let calls = 0;
  link.ensure = async () => {
    if (++calls === 1) await gate;
  };
  const first = link.link(uid);
  await new Promise((r) => setImmediate(r));
  const second = await link.link(uid).finally(release);
  assert.equal(second.state, 'waiting for code', second.error);
  await first;
  assert.equal(execCount() - before, 1, 'only the newer start ran claude auth login');
});

test('a sign-in that shows no link in 60 seconds says so, and the exit after its kill keeps that (#468 S02-8)', async (t) => {
  process.env.FAKE_PODMAN = 'silent';
  const { link, uid } = newLink();
  link.ensure = async () => {};
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const started = link.link(uid);
  // until() would wait on the mocked setTimeout.
  while (!readFileSync(execs, 'utf8').includes(`citadel-claude-l${n}-${uid} `)) await new Promise((r) => setImmediate(r));
  t.mock.timers.tick(60_000);
  const status = await started;
  assert.match(status.error ?? '', /didn't show a link within 60 seconds/);
  t.mock.timers.reset();
  await new Promise((r) => setTimeout(r, 200));
  assert.match(link.status(uid).error ?? '', /didn't show a link within 60 seconds/);
});

test('a sign-in that ends while waiting for the code says so instead of waiting on (#468 S02-8)', async () => {
  process.env.FAKE_PODMAN = 'link-then-exit';
  const { link, uid } = newLink();
  link.ensure = async () => {};
  assert.equal((await link.link(uid)).state, 'waiting for code');
  const status = await until('the sign-in to end', () => {
    const s = link.status(uid);
    return s.state !== 'waiting for code' && s;
  }, 5000);
  assert.equal(status.state, 'not linked');
  assert.match(status.error ?? '', /ended/);
});
