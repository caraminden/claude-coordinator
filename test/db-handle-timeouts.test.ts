// A raw handle a test opens on a running test server's coordinator.db waits on a busy lock: node's default is 0, so
// one write that meets the server's own fails at once with "database is locked" (the Nov 22 red CI burst, #1627).
// Read-only handles are held to it too: WAL readers rarely wait, but a checkpoint or recovery can make one.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const dir = import.meta.dirname;
const files = [
  ...readdirSync(dir)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => join(dir, f)),
  ...readdirSync(join(dir, 'drills'))
    .filter((f) => f.endsWith('.ts'))
    .map((f) => join(dir, 'drills', f)),
];

/** A `new DatabaseSync(` line that opens a server's data dir database with no `timeout`. */
const OPENS_SERVER_DB = /new DatabaseSync\([^\n]*(coordinator\.db|events\.db)/;
const SERVER_DIR = /\bdata\b|\bsrv\b|\blive\b/;

test("a raw handle on a test server's database sets a busy timeout", () => {
  const bad: string[] = [];
  for (const f of files) {
    if (f === import.meta.filename) continue;
    readFileSync(f, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (OPENS_SERVER_DB.test(line) && SERVER_DIR.test(line) && !/timeout:/.test(line)) bad.push(`${f.slice(dir.length + 1)}:${i + 1}: ${line.trim()}`);
      });
  }
  assert.deepEqual(bad, [], 'add { timeout: 30_000 } to each:\n' + bad.join('\n'));
});
