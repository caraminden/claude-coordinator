// Preloaded into a test server (NODE_OPTIONS=--import, test/list-reads.test.ts): each response carries x-sql-statements,
// the SQL statements its request ran on the main thread (writes the worker thread runs aren't counted).
import { AsyncLocalStorage } from 'node:async_hooks';
import http from 'node:http';
import { StatementSync } from 'node:sqlite';

const request = new AsyncLocalStorage<{ n: number }>();
const emit = http.Server.prototype.emit;
http.Server.prototype.emit = function (this: http.Server, event: string, ...args: any[]) {
  return event === 'request' ? request.run({ n: 0 }, () => emit.call(this, event, ...args)) : emit.call(this, event, ...args);
} as typeof emit;
for (const m of ['run', 'get', 'all', 'iterate'] as const) {
  const f = StatementSync.prototype[m] as (...a: unknown[]) => unknown;
  (StatementSync.prototype as any)[m] = function (this: StatementSync, ...a: unknown[]) {
    const r = request.getStore();
    if (r) r.n++;
    return f.apply(this, a);
  };
}
const writeHead = http.ServerResponse.prototype.writeHead;
http.ServerResponse.prototype.writeHead = function (this: http.ServerResponse, ...a: any[]) {
  const r = request.getStore();
  if (r && !this.headersSent) this.setHeader('x-sql-statements', String(r.n));
  return (writeHead as any).apply(this, a);
} as typeof writeHead;
