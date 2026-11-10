import assert from 'node:assert/strict';
import { test } from 'node:test';
import { machineStatus, type StatusFacts } from '../src/machines.ts';

// The four statuses (#437) as a table: what a machine's facts are, and what its line says.
const now = 10 * 24 * 3600_000;
const min = 60_000;
const ok = (server: 'mcp' | 'ws', tools = 2) => ({ server, ok: true, tools: Array.from({ length: tools }, (_, i) => `t${i}`), error: null, ms: 5 });
const base: StatusFacts = {
  now, startedAt: now - 24 * 60 * min, online: true, runners: false, alwaysOn: true, createdAt: now - 48 * 60 * min, lastSeenAt: now - 30 * min,
  offers: ['mcp'], wsOff: false, check: { at: now - 3 * min, results: [ok('mcp', 47)] }, owned: false, lent: 1, lentOn: 1,
};

const rows: [string, Partial<StatusFacts>, string, string, string | null][] = [
  // what it is, its facts, status, reason, fix button
  ['connected, checked, lent', {}, 'ready', 'Ready · 47 tools', null],
  ['a person\'s own, lent to no scheme', { owned: true, lent: 0, lentOn: 0 }, 'ready', 'Ready · 47 tools', null],
  ['MCP server and workspace tools both passed', { offers: ['mcp', 'ws'], check: { at: now, results: [ok('mcp', 1), ok('ws', 3)] } }, 'ready', 'Ready · 4 tools', null],
  ['one tool', { check: { at: now, results: [ok('mcp', 1)] } }, 'ready', 'Ready · 1 tool', null],
  ['CI runner host, connected', { runners: true, offers: [], check: null }, 'ready', 'CI runner host, connected', null],
  ['its tools didn\'t start', { check: { at: now, results: [{ server: 'mcp', ok: false, tools: [], error: 'no answer in 30s', ms: 30_000 }] } }, 'fix', 'Its tools didn\'t start: no answer in 30s', 'check'],
  ['its workspace tools didn\'t start', { offers: ['mcp', 'ws'], check: { at: now, results: [ok('mcp'), { server: 'ws', ok: false, tools: [], error: 'boom', ms: 1 }] } }, 'fix', 'Its workspace tools didn\'t start: boom', 'check'],
  ['folder, workspace tools off', { offers: [], wsOff: true, check: null }, 'fix', 'Lends nothing: workspace tools are off', 'workspace_tools'],
  ['no server and no folder', { offers: [], check: null }, 'fix', 'Lends nothing: no MCP server or folder on that computer', 'token'],
  ['lent to no scheme', { lent: 0, lentOn: 0 }, 'fix', 'Lent to no scheme', 'lend'],
  ['its one scheme has machine tools off', { lent: 1, lentOn: 0 }, 'fix', 'Its scheme has machine tools off', 'machine_tools'],
  ['every scheme has machine tools off', { lent: 3, lentOn: 0 }, 'fix', 'Every scheme it is lent to has machine tools off', 'machine_tools'],
  ['some schemes have machine tools on', { lent: 3, lentOn: 1 }, 'ready', 'Ready · 47 tools', null],
  ['a broken check beats lent to no scheme', { lent: 0, check: { at: now, results: [{ server: 'mcp', ok: false, tools: [], error: 'x', ms: 1 }] } }, 'fix', 'Its tools didn\'t start: x', 'check'],
  ['connected, not checked yet', { check: null }, 'checking', 'Checking its tools…', null],
  ['workspace tools just switched on, not checked yet', { offers: ['mcp', 'ws'] }, 'checking', 'Checking its tools…', null],
  ['always on, offline 6 min', { online: false, lastSeenAt: now - 6 * min }, 'down', 'Offline', 'always_on'],
  ['always on, offline 4 min', { online: false, lastSeenAt: now - 4 * min }, 'asleep', 'Offline', null],
  ['always on, seen long ago, but Citadel started 2 min ago', { online: false, lastSeenAt: now - 600 * min, startedAt: now - 2 * min }, 'asleep', 'Offline', null],
  ['a laptop, offline a day', { online: false, alwaysOn: false, lastSeenAt: now - 24 * 60 * min }, 'asleep', 'Asleep', null],
  ['never connected, added 2 days ago', { online: false, lastSeenAt: null }, 'down', 'Never connected', 'remove'],
  ['never connected, a laptop: still Down', { online: false, alwaysOn: false, lastSeenAt: null }, 'down', 'Never connected', 'remove'],
  ['never connected, added 10 min ago', { online: false, lastSeenAt: null, createdAt: now - 10 * min }, 'asleep', 'Not connected yet', null],
  ['CI runner host offline 10 min', { online: false, runners: true, lastSeenAt: now - 10 * min }, 'down', 'Offline', 'always_on'],
];

for (const [what, facts, status, reason, fix] of rows) {
  test(`machine status: ${what}`, () => {
    const st = machineStatus({ ...base, ...facts });
    assert.deepEqual([st.status, st.reason, st.fix], [status, reason, fix]);
  });
}

test('machine status: the time it shows is when it was checked, seen or added', () => {
  assert.deepEqual(machineStatus(base).when, { label: 'checked', at: now - 3 * min });
  assert.deepEqual(machineStatus({ ...base, online: false }).when, { label: 'seen', at: now - 30 * min });
  assert.deepEqual(machineStatus({ ...base, online: false, lastSeenAt: null }).when, { label: 'added', at: base.createdAt });
  assert.equal(machineStatus({ ...base, runners: true }).when, null);
});
