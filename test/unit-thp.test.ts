// Every service unit Citadel starts asks for huge pages only on request (src/unit-thp.ts, #1458): a unit started by
// systemd doesn't inherit the server's setting, so a starter that leaves THP_PROPS out brings back the reclaim storms.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(import.meta.dirname, '..', 'src');
// systemd-run's arguments for a service unit (a scope, `--scope`, inherits from its starter and refuses the property).
const SERVICE = /'--user',\s*('--wait',\s*)?'--collect'/g;

test('every file that starts a service unit with systemd-run gives it THP_PROPS', () => {
  const count = (text: string, re: RegExp) => text.match(re)?.length ?? 0;
  const starts = readdirSync(SRC).filter((f) => /\.(ts|mjs)$/.test(f)).map((f) => {
    const text = readFileSync(join(SRC, f), 'utf8');
    return { f, starts: count(text, SERVICE), given: count(text, /\.\.\.THP_PROPS\b/g) };
  }).filter((s) => s.starts);
  assert.ok(starts.length >= 5, `found only ${starts.map((s) => s.f).join(', ')}: the pattern no longer matches how units start`);
  // One spread per start: the import alone, or one start of two given it, isn't enough.
  assert.deepEqual(starts.filter((s) => s.given < s.starts), [], 'these start more service units than they give THP_PROPS (src/unit-thp.ts)');
});
