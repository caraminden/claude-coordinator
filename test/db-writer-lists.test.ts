import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { ASYNC_WRITES, VALUE_WRITES, WRITES } from '../src/db-writer.ts';
import { Store } from '../src/db.ts';

// The static half of test/db-writer.test.ts (#2037): it reads the Store's methods, runs in well under a second, and a new
// write anywhere in src/db.ts or src/db/ breaks it, so it is on tools/always-tests.txt; the worker's behaviour stays there.
const root = mkdtempSync(join(tmpdir(), 'db-writer-lists-'));
after(() => rmSync(root, { recursive: true, force: true })); // timing-ok: own temp dir

// #1285: writes added to the Store after #795 (touch, on every chat message) missed both lists and held the server on a
// slow disk. Every method whose source runs a statement is in WRITES, VALUE_WRITES or here, with why.
const STAYS_ON_THREAD: Record<string, string> = {
  // The constructor's one-time migrations: they run before the writer starts.
  ...Object.fromEntries(
    ['attachState', 'moveSharedViews', 'serverLoginOwnerOnly', 'groupByType', 'closedAtFromNotes', 'dropEarlyPeekAurasBuilds', 'shippingFromRules', 'lendingLists', 'machineRoleTables', 'machineOwners', 'numberTickets', 'settleBuilds', 'props.seed', 'props.insertSeed', 'schedules.fillTriggers'].map((m) => [m, 'boot']),
  ),
  // Helpers that run inside a listed write, with it.
  // The usage ledger batches counts in memory and sends them as usage.addCounts on a timer (#1306, #1877).
  'usage.prune': "the ledger's own timer",
  dropAudit: 'inside sweepTurnAudit and deleteTurnAudit',
  'props.insertValue': 'inside props.registerValues and props.review',
  'props.putStage': 'inside props.statusChanged',
  'props.statusChanged': 'inside updateTicket',
  'props.startStage': "called by newMinion (src/new-minion.ts), which runs it with the ticket's other writes",
  // Not moved yet: rare, or they write only now and then and would wait for the queue on every call as a VALUE_WRITE.
  ...Object.fromEntries(
    [
      'putSecret',
      'deleteSecret',
      'splitScheme',
      'putClaudeState',
      'forgetJobKind',
      'props.backfill',
      'schedules.setBrief',
      'schedules.categorize',
      'reviews.ensureAgents',
      'reviews.recordRun',
      'reviews.recordVerdict',
      'reviews.removeVerdict',
      'reviews.recordRefutes',
      'reviews.removeLesson',
      'reviews.backfill',
      'claims.take',
      'claims.release',
      'claims.releaseHeldBy',
      'claims.setQueue',
      'claims.passOn',
      'claims.shipped',
      'claims.holderLive',
      'claims.move',
      'claims.dropBeside',
      'claims.setReady',
      'claims.handedOff',
      'claims.besideRefused',
      'claims.skip',
      'claims.setBeside',
      'claims.besideLive',
      'lessons.add',
      'lessons.take',
      'ideas.upsert',
      'ideas.restatus',
      'ideas.restatusWith',
      'ideas.warmUp',
      'ideas.linkStarts',
      'ideas.sync',
      'ideas.laterNote',
      'minionIndex.indexTicket',
      'minionIndex.syncHandoffs',
      'minionIndex.deleteTicket',
      'memoryProposals.create',
      'memoryProposals.decide',
      'memoryProposals.keepFirst',
      'memoryProposals.restored',
      'memoryProposals.prune',
      'ideas.edit',
      'ideas.linkHandoff',
      'ideas.fromHandoff',
      'ideas.join',
      'ideas.readPage',
      'ideas.now',
      'ideas.fromChat',
      'ideas.soon',
      'minionIndex.indexClosed',
    ].map((m) => [m, 'not moved yet']),
  ),
};

test("every Store method that writes is sent to the worker or listed as staying on the server's thread (#1285)", () => {
  const store = new Store(join(root, 'lists.db'));
  const listed = new Set<string>([...WRITES, ...VALUE_WRITES, ...ASYNC_WRITES]);
  const runsSql = /\.run\(|\bdb\.exec\(|[`'"]\s*(INSERT|UPDATE|DELETE|REPLACE)\s/i;
  const writers: string[] = [];
  const scan = (obj: object, prefix: string) => {
    const src = new Map<string, string>();
    for (let p = Object.getPrototypeOf(obj); p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
      for (const k of Object.getOwnPropertyNames(p)) {
        const f = Object.getOwnPropertyDescriptor(p, k)!.value;
        if (k !== 'constructor' && typeof f === 'function' && !src.has(k)) src.set(k, f.toString());
      }
    }
    // A method writes if it runs a statement, or calls a method of its own object that does and is in neither list
    // (a listed one it calls is sent or waits by itself).
    const found = new Set([...src].filter(([, s]) => runsSql.test(s)).map(([k]) => k));
    for (let grew = true; grew; ) {
      grew = false;
      const via = [...found].filter((w) => !listed.has(prefix + w));
      for (const [k, s] of src) if (!found.has(k) && via.some((w) => s.includes(`this.${w}(`))) found.add(k), (grew = true);
    }
    writers.push(...[...found].map((k) => prefix + k));
  };
  scan(store, '');
  // Its parts with writes of their own (props, schedules, memory, reviews and the rest): the lists name them `part.method`.
  for (const [k, v] of Object.entries(store)) {
    if (v && typeof v === 'object' && v !== store.db && !(v instanceof Map) && !(v instanceof Set) && Object.getPrototypeOf(v) !== Object.prototype) scan(v, `${k}.`);
  }
  assert.ok(writers.includes('touch') && writers.includes('props.set'), "the scan finds writes, its own and its parts'");
  const missed = writers.filter((m) => !listed.has(m) && !(m in STAYS_ON_THREAD));
  assert.deepEqual(missed, [], `these write but are in neither WRITES nor VALUE_WRITES (src/db-writer.ts): ${missed.join(', ')}. A void write goes in WRITES, one whose result its callers use in VALUE_WRITES.`);
  const stale = Object.keys(STAYS_ON_THREAD).filter((m) => !writers.includes(m) || listed.has(m));
  assert.deepEqual(stale, [], "listed as staying on the server's thread, but gone, no longer writing, or now in a list");
});
