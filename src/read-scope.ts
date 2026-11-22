// One request's reads, read once (#1527). The scheme list and a scheme's open minions built every row from small
// reads repeated per row: the chain list four times a minion, its queue setting four times, the person lookups three,
// about 2,100 statements for 60 open minions. Inside readScope() the Store's hot reads remember what they read, and
// views() fills whole kinds of per-minion rows (costs, last turn ends, touches, cards, settings) with one query each.
//
// A scope wraps synchronous, read-only work only: it ends before the call returns, so no other request's code and no
// write runs inside it, and nothing read here outlives it (a cache between requests would show stale state: the
// handoff ruled it out). A write made inside one would not be seen by a later read in the same scope.
import type { DatabaseSync } from 'node:sqlite';

const scopes = new WeakMap<DatabaseSync, Map<string, unknown>>();
let enabled = process.env.CITADEL_READ_SCOPE !== '0';

/** Turn scopes off (the old per-row reads) or on: the test pinning that both give the same JSON. */
export function setReadScopes(on: boolean) {
  enabled = on;
}

/** Run `fn` with `db`'s reads remembered until it returns. Nested scopes share the outer one. */
export function readScope<T>(db: DatabaseSync, fn: () => T): T {
  if (!enabled || scopes.has(db)) return fn();
  scopes.set(db, new Map());
  try {
    const r = fn();
    if (r instanceof Promise) throw new Error('readScope: an async body would keep the scope across an await');
    return r;
  } finally {
    scopes.delete(db);
  }
}

/** Whether a scope is open on `db`: a batch read (warm) is worth its query only then. */
export function inScope(db: DatabaseSync): boolean {
  return scopes.has(db);
}

/** `read()`'s result, read once per scope under `key`; outside a scope, read() every time. */
export function scoped<T>(db: DatabaseSync, key: string, read: () => T): T {
  const memo = scopes.get(db);
  if (!memo) return read();
  if (memo.has(key)) return memo.get(key) as T;
  const v = read();
  memo.set(key, v);
  return v;
}

/** Put batch-read values in the scope, so scoped() under those keys reads nothing. Outside a scope, does nothing. */
export function warm(db: DatabaseSync, entries: Iterable<[string, unknown]>) {
  const memo = scopes.get(db);
  if (!memo) return;
  for (const [k, v] of entries) if (!memo.has(k)) memo.set(k, v);
}

/** A shallow copy of a remembered row, so one caller's edit can't reach another's; it keeps node:sqlite's null prototype. */
export function copyRow<T extends object>(row: T | undefined): T | undefined {
  return row && Object.assign(Object.create(Object.getPrototypeOf(row)), row);
}
