import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

// Previews serve the front end under /preview/<id>/ (src/previews.ts), so its own URLs must be
// relative: "api/me", not "/api/me". The app itself is always at "/", where both mean the same.
const dir = join(import.meta.dirname, '..', 'public');

test('the front end uses relative URLs for the API and its own files', () => {
  const found: string[] = [];
  // sw.js runs only at the root (a preview shares the live worker), and machine-agent.mjs runs on machines.
  for (const f of readdirSync(dir).filter((f) => /\.(js|html)$/.test(f) && f !== 'sw.js')) {
    readFileSync(join(dir, f), 'utf8').split('\n').forEach((line, i) => {
      const bad = /['"`]\/api\//.test(line) || /\b(href|src)="\/[^/]/.test(line) || /EventSource\(['"`]\//.test(line);
      if (bad && !line.includes("register('/sw.js')")) found.push(`${f}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(found, []);
});
