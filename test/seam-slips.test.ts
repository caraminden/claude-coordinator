// Greps that keep three seam-review slips (#1450) from coming back: a second place disagreeing with the first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const grep = (pattern: string, ...paths: string[]) => {
  try {
    return execFileSync('git', ['grep', '-nE', pattern, '--', ...paths], { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
};

test('the kit never says the server runs UTC: it runs Pacific (P5)', () => {
  assert.equal(grep('runs UTC|host time \\(UTC\\)', 'kit'), '');
});

test("the MCP tools' text reads days in Pacific, never a UTC date slice (P6)", () => {
  assert.equal(grep('toISOString\\(\\)\\.slice\\(0, 10\\)', 'src/mcp.ts', 'src/mcp-text.ts', 'src/mcp-*.ts'), '');
});
