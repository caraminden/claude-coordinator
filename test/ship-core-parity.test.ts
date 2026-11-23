// Citadel's ship pipeline and the kit's core (kit/skills/scheme-setup/templates/land.sh, run as tools/land-core.sh once
// SHIP_CORE is on, #1323) share deploy.sh's line and Citadel's settings: these pin the places the two copies must agree
// (the ship scripts' ultra review, 2026-11-23, fix C).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { readQueue } from '../src/waits.ts';
import { scriptEnv } from './script-env.ts';

const env = { ...scriptEnv(), GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null' };

const repo = join(import.meta.dirname, '..');
const root = mkdtempSync(join(tmpdir(), 'ship-core-parity-'));
after(() => rmSync(root, { recursive: true, force: true })); // timing-ok: own temp dir
const template = join(repo, 'kit', 'skills', 'scheme-setup', 'templates', 'land.sh');
const deployQueue = join(repo, 'tools', 'deploy-queue.sh');
const fn = (file: string, name: string) => {
  const m = readFileSync(file, 'utf8').match(new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}\\n`, 'm'));
  assert.ok(m, `${name} in ${file}`);
  return m[0];
};
const bash = (script: string, ...args: string[]) => {
  const r = spawnSync('bash', ['-c', script, 'bash', ...args], { encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim().split('\n').filter(Boolean);
};

// The three ticket layouts that can sit in deploy.sh's queue/ at once: deploy-queue.sh's (`order` on line 5), the
// core's (`order` on line 8, after its commit, verdict and base) and one from before .order (4 lines, no `order`).
const deployTicket = (label: string) => ['123 456', '0', label, 'waiting', 'order', '', ''].join('\n') + '\n';
const coreTicket = (label: string) => ['123 456', '0', label, 'waiting', '-', '-', '-', 'order'].join('\n') + '\n';
const oldTicket = (label: string) => ['123 456', '0', label, 'waiting'].join('\n') + '\n';

test('the kit core, deploy-queue.sh and the server put a line of deploy.sh, core and old tickets in the same order', () => {
  const q = mkdtempSync(join(root, 'queue-parity-'));
  const tickets: [string, string][] = [
    ['0000000001', deployTicket('deploy-a')],
    ['0000000002', coreTicket('core-b')],
    ['0000000003', deployTicket('deploy-c')],
    ['0000000004', oldTicket('old-d')],
    ['0000000005', coreTicket('core-e')],
    ['0000000006', deployTicket('deploy-f')],
  ];
  for (const [n, text] of tickets) writeFileSync(join(q, n), text);
  // Ranked out of arrival order, so a ticket read as "from before .order" lands somewhere else in the line.
  writeFileSync(join(q, '.order'), '# Cara moved deploy-c\n0000000003\n0000000002\n0000000006\n0000000005\n');

  const core = bash(`${fn(template, 'queue_order')}Q_DIR=$1; queue_order; printf '%s\\n' "\${Q_ORDER[@]}"`, q);
  const deploy = bash(
    `. "$2"; queue_order "$1"; for t in "$1"/[0-9]*; do t=\${t##*/}; echo "$(queue_key "$t") $t"; done | LC_ALL=C sort | cut -d' ' -f2`,
    q,
    deployQueue,
  );
  const server = readQueue(q, 4, () => true).map((t) => String(t.seq).padStart(10, '0'));

  // Old-d waits for every lower ticket; .order ranks the others among themselves on either side of it.
  const want = ['0000000003', '0000000002', '0000000001', '0000000004', '0000000006', '0000000005'];
  assert.deepEqual(deploy, want, 'deploy-queue.sh');
  assert.deepEqual(server, want, 'the server (src/waits.ts)');
  assert.deepEqual(core, want, 'the kit core');
});

test("land.local.sh's land_deploy hands deploy.sh the core's place in line", () => {
  const dir = mkdtempSync(join(root, 'land-deploy-ticket-'));
  const tools = join(dir, 'tools');
  const main = join(dir, 'main');
  mkdirSync(tools);
  copyFileSync(join(repo, 'tools', 'land.local.sh'), join(tools, 'land.local.sh'));
  // Stand-ins for the deploy line: no restart ahead, and a deploy.sh that only says which ticket it was given.
  writeFileSync(join(tools, 'deploy-queue.sh'), 'restart_lock() { :; }\ndeploy_unchecked_back() { :; }\ntaken_back() { :; }\n');
  writeFileSync(join(tools, 'deploy.sh'), '#!/usr/bin/env bash\necho "ticket=${DEPLOY_QUEUE_TICKET:-}" >>"$SEEN"\n', { mode: 0o755 });
  const git = (...a: string[]) => spawnSync('git', ['-C', main, ...a], { encoding: 'utf8', env }).stdout.trim();
  mkdirSync(main);
  git('init', '-q');
  git('commit', '-q', '--allow-empty', '-m', 'one');
  const old = git('rev-parse', 'HEAD');
  git('commit', '-q', '--allow-empty', '-m', 'two');
  const to = git('rev-parse', 'HEAD');
  mkdirSync(join(main, '.git', 'land-deploy'));
  writeFileSync(join(main, '.git', 'land-deploy', to), `x x ${old} x\n`);
  const live = join(dir, 'live');
  mkdirSync(join(live, '.git', 'cc-deploy'), { recursive: true });
  const seen = join(dir, 'seen');
  const r = spawnSync('bash', ['-c', `say() { echo "$*" >&2; }; . "$1"; QUEUE_TICKET=$2; land_deploy "$3"`, 'bash', join(tools, 'land.local.sh'), join(dir, 'ticket'), to], {
    cwd: main,
    encoding: 'utf8',
    env: { ...env, DEPLOY_LIVE: live, SEEN: seen },
  });
  assert.equal(readFileSync(seen, 'utf8'), `ticket=${join(dir, 'ticket')}\n`, r.stderr);
});

// Each LAND_CI_* default both files set: land.local.sh ports land.sh's to the core, so a change to one (#1606's 9 min
// wait, #1655's 15 s poll) goes to the other.
test("land.local.sh's CI defaults match land.sh's", () => {
  const defaults = (file: string) => {
    const out = new Map<string, string>();
    for (const m of readFileSync(join(repo, 'tools', file), 'utf8').matchAll(/\$\{(LAND_CI_[A-Z_]+):-([^}]*)\}/g)) {
      const seen = out.get(m[1]);
      assert.ok(seen === undefined || seen === m[2], `${file} gives ${m[1]} two defaults (${seen} and ${m[2]})`);
      out.set(m[1], m[2]);
    }
    return out;
  };
  const land = defaults('land.sh'), local = defaults('land.local.sh');
  const shared = [...local.keys()].filter((k) => land.has(k));
  assert.ok(shared.includes('LAND_CI_TIMEOUT') && shared.includes('LAND_CI_POLL'), `shared: ${shared.join(' ')}`);
  for (const k of shared) assert.equal(local.get(k), land.get(k), `${k}: land.local.sh ${local.get(k)}, land.sh ${land.get(k)}`);
});
