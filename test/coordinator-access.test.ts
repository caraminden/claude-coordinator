import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { coordinatorAccess } from '../src/runner.ts';

const root = mkdtempSync(join(tmpdir(), 'coordinator-access-'));
after(() => rmSync(root, { recursive: true, force: true }));

const repo = join(root, 'repo');
const tickets = join(root, 'tickets');
mkdirSync(join(tickets, '7'), { recursive: true });

test('adds the repo and the tickets folder, and denies edits in both', () => {
  const { addDirs, settings } = coordinatorAccess(repo, tickets) as any;
  assert.deepEqual(addDirs, [repo, tickets]);
  assert.ok(settings.permissions.deny.includes(`Edit(/${repo}/**)`));
  assert.ok(settings.permissions.deny.includes(`Edit(/${tickets}/**)`));
});

test('allows read-only git -C with the exact folder as prefix', () => {
  const { allow } = (coordinatorAccess(repo, tickets).settings as any).permissions;
  assert.ok(allow.includes(`Bash(git -C ${repo} log:*)`));
  assert.ok(allow.includes(`Bash(git -C ${join(tickets, '7')} status:*)`));
  assert.ok(allow.includes(`Bash(git -C ${repo} branch -a)`));
  for (const rule of allow) {
    assert.ok(!rule.includes('*)') || rule.endsWith(':*)'), `no mid-rule wildcard: ${rule}`);
    assert.doesNotMatch(rule, / (commit|checkout|switch|reset|push|merge|rebase)\b/);
  }
});

test('without a repo, only the tickets folder is added and no git is allowed, only the web tools', () => {
  const { addDirs, settings } = coordinatorAccess(null, tickets) as any;
  assert.deepEqual(addDirs, [tickets]);
  assert.deepEqual(settings.permissions.allow, ['WebSearch', 'WebFetch']);
});

test('a live checkout is added read-only, with read-only git, and only when given', () => {
  const live = join(root, 'live');
  const { addDirs, settings } = coordinatorAccess(repo, tickets, null, null, live) as any;
  assert.deepEqual(addDirs, [repo, tickets, live]);
  assert.ok(settings.permissions.deny.includes(`Edit(/${live}/**)`));
  assert.ok(settings.permissions.allow.includes(`Bash(git -C ${live} log:*)`));
  assert.ok(!settings.permissions.allow.some((r: string) => r.includes(live) && !r.startsWith(`Bash(git -C ${live} `)));
  assert.ok(!JSON.stringify(coordinatorAccess(repo, tickets)).includes(live));
});

test('a project with no tickets folder yet still works', () => {
  const { addDirs } = coordinatorAccess(repo, join(root, 'missing'));
  assert.equal(addDirs.length, 2);
});
