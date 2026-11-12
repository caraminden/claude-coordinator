// The kit's land.sh drift check (#602): tools/kit-land-drift.sh lists the schemes whose tools/land.sh differs from the
// template, and tools/deploy.sh tells the Taskmaster once when a deploy changes the template.
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { promisify } from 'node:util';
import { scriptEnv } from './script-env.ts';

const repo = join(import.meta.dirname, '..');
const root = mkdtempSync(join(tmpdir(), 'kit-land-drift-'));
after(() => rmSync(root, { recursive: true, force: true }));
// COORDINATOR_*: a minion's own would send the stand-in's message to its real Taskmaster.
const env = { ...scriptEnv({ COORDINATOR_CONTAINER: undefined, COORDINATOR_TICKET: undefined, COORDINATOR_TOKEN: undefined, COORDINATOR_API: undefined }), GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null' };
const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8' }).trim();
const TEMPLATE = 'kit/skills/scheme-setup/templates/land.sh';

let n = 0;
/** Projects 2 (Citadel: the live checkout, which holds the template), 3 (in sync), 4 (drifted), 5 (no land.sh). */
function world() {
  const dir = join(root, String(++n));
  const projects = join(dir, 'projects');
  const repoOf = (p: number, files: Record<string, string>, origin?: string) => {
    const r = join(projects, String(p), 'repo');
    mkdirSync(r, { recursive: true });
    git(r, 'init', '-q', '-b', 'main');
    for (const [f, text] of Object.entries(files)) {
      mkdirSync(join(r, f, '..'), { recursive: true });
      writeFileSync(join(r, f), text);
    }
    git(r, 'add', '-A');
    git(r, 'commit', '-qm', 'base');
    if (origin) git(r, 'remote', 'add', 'origin', origin);
    return r;
  };
  const live = repoOf(2, { [TEMPLATE]: 'core v1\n', 'other.txt': '1\n' });
  mkdirSync(join(live, 'tools'));
  for (const f of ['deploy.sh', 'kit-land-drift.sh']) copyFileSync(join(repo, 'tools', f), join(live, 'tools', f));
  git(live, 'add', '-A');
  git(live, 'commit', '-qm', 'tools');
  repoOf(3, { 'tools/land.sh': 'core v1\n', 'tools/land.local.sh': "CHECK='true'\n" }, 'https://github.com/o/synced.git');
  const drifted = repoOf(4, { 'tools/land.sh': 'core v0\n' }, 'git@github.com:o/drifted.git');
  repoOf(5, { 'README.md': 'no land\n' });
  const commit = (file: string, text: string) => {
    writeFileSync(join(live, file), text);
    git(live, 'commit', '-qam', file);
    return git(live, 'rev-parse', 'HEAD');
  };
  const drift = () => execFileSync('bash', [join(live, 'tools', 'kit-land-drift.sh'), projects], { env, encoding: 'utf8' });
  const deploy = (from: string, to: string, extra: Record<string, string> = {}) =>
    promisify(execFile)('bash', [join(live, 'tools', 'deploy.sh'), 'kit-land-drift', from, to], { env: { ...env, DEPLOY_LIVE: live, DEPLOY_SOURCE: join(projects, '2', 'repo'), ...extra }, encoding: 'utf8' });
  return { live, drifted, commit, drift, deploy };
}

async function standIn() {
  const seen: { url: string; auth?: string; body: string }[] = [];
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d)).on('end', () => {
      seen.push({ url: req.url ?? '', auth: req.headers.authorization, body });
      res.writeHead(202, { 'Content-Type': 'application/json' }).end('{"sent":true}');
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(srv.address() as any).port}`, seen, close: () => { srv.closeAllConnections(); srv.close(); } };
}

test('kit-land-drift.sh lists only the scheme repos whose committed land.sh differs, leaving out Citadel and repos without one', () => {
  const w = world();
  assert.equal(w.drift(), '4 o/drifted\n');
  // Main's commit counts, not the files in the main checkout.
  writeFileSync(join(w.drifted, 'tools', 'land.sh'), 'core v1\n');
  assert.equal(w.drift(), '4 o/drifted\n');
  git(w.drifted, 'commit', '-qam', 'sync');
  assert.equal(w.drift(), '');
});

test('a deploy that changes the template tells the Taskmaster once, as the deploying minion, naming the drifted schemes', async () => {
  const w = world();
  const a = git(w.live, 'rev-parse', 'HEAD');
  const b = w.commit('other.txt', '2\n');
  const c = w.commit(TEMPLATE, 'core v2\n');
  const srv = await standIn();
  try {
    const who = { COORDINATOR_TICKET: '7', COORDINATOR_TOKEN: 'tok-secret', COORDINATOR_API: srv.url };
    const quiet = await w.deploy(a, b, who);
    assert.equal(quiet.stderr, '', 'a range without the template says nothing');
    assert.equal(srv.seen.length, 0);
    const r = await w.deploy(a, c, who);
    assert.match(r.stderr, /the kit's land\.sh changed; these schemes' tools\/land\.sh differ from it: 3 o\/synced; 4 o\/drifted/);
    assert.equal(srv.seen.length, 1);
    const [m] = srv.seen;
    assert.equal(m.url, '/api/tickets/7/coordinator');
    assert.equal(m.auth, 'Bearer tok-secret');
    const text: string = JSON.parse(m.body).text;
    assert.match(text, /\n- 3 o\/synced\n- 4 o\/drifted\n/);
    assert.match(text, /copy the template over tools\/land\.sh byte for byte/);
    // Run by hand (no minion): it only prints.
    const hand = await w.deploy(a, c);
    assert.match(hand.stderr, /differ from it: 3 o\/synced; 4 o\/drifted/);
    assert.equal(srv.seen.length, 1);
  } finally {
    srv.close();
  }
});

test('a template change every scheme already matches sends nothing', async () => {
  const w = world();
  const a = git(w.live, 'rev-parse', 'HEAD');
  const c = w.commit(TEMPLATE, 'core v0\n'); // project 3 is behind now, 4 matches: make 3 match too
  const synced = join(w.live, '..', '..', '3', 'repo');
  writeFileSync(join(synced, 'tools', 'land.sh'), 'core v0\n');
  git(synced, 'commit', '-qam', 'sync');
  const srv = await standIn();
  try {
    const r = await w.deploy(a, c, { COORDINATOR_TICKET: '7', COORDINATOR_TOKEN: 'tok', COORDINATOR_API: srv.url });
    assert.match(r.stderr, /every scheme's tools\/land\.sh already matches it/);
    assert.equal(srv.seen.length, 0);
  } finally {
    srv.close();
  }
});
