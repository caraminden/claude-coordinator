// Every service unit Citadel starts asks for huge pages only on request (src/unit-thp.ts, #1458): a unit started by
// systemd doesn't inherit the server's setting, so a starter that leaves THP_PROPS out brings back the reclaim storms.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(import.meta.dirname, '..', 'src');
// systemd-run's arguments for a service unit (a scope, `--scope`, inherits from its starter and refuses the property).
const SERVICE = /'--user',\s*('--wait',\s*)?'--collect'/;

test('every file that starts a service unit with systemd-run gives it THP_PROPS', () => {
  const starters = readdirSync(SRC).filter((f) => /\.(ts|mjs)$/.test(f) && f !== 'unit-thp.ts').filter((f) => SERVICE.test(readFileSync(join(SRC, f), 'utf8')));
  assert.ok(starters.length >= 5, `found only ${starters.join(', ')}: the pattern no longer matches how units start`);
  const missing = starters.filter((f) => !readFileSync(join(SRC, f), 'utf8').includes('THP_PROPS'));
  assert.deepEqual(missing, [], 'these start a service unit without THP_PROPS (src/unit-thp.ts)');
});
