// systemd-oomd must never pick the server (#1257). On 2026-11-20 it killed claude-coordinator.service 11 times in
// 3 minutes (10:44-10:47 PST) while the server held 0.5-1.9G: oomd's pressure policy picks the cgroup with the most
// reclaim, not the biggest, and a restarting server tops that list again every 15 s. Turns, lands and test runs are
// the ones it should take.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(import.meta.dirname, '..', 'deploy', 'claude-coordinator.service.d');
/** `Key=value` lines in the [Service] sections of the server unit and its drop-ins, last one winning as in systemd. */
function serviceSettings(): Map<string, string> {
  const files = [join(dir, '..', 'claude-coordinator.service'), ...readdirSync(dir).filter((f) => f.endsWith('.conf')).sort().map((f) => join(dir, f))];
  const out = new Map<string, string>();
  for (const file of files) {
    let section = '';
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const s = line.trim();
      if (/^\[.+\]$/.test(s)) section = s;
      else if (section === '[Service]' && /^\w+\s*=/.test(s)) out.set(s.slice(0, s.indexOf('=')).trim(), s.slice(s.indexOf('=') + 1).trim());
    }
  }
  return out;
}

test('oomd leaves the server out of its candidates', () => {
  assert.equal(serviceSettings().get('ManagedOOMPreference'), 'omit');
});

test('the server keeps a hard memory cap of its own, since oomd no longer stops it', () => {
  assert.match(serviceSettings().get('MemoryMax') ?? '', /^\d+[KMGT]?$/);
});
