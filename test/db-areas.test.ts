// src/db.ts by area (#1313): each area's queries live in src/db/<area>.ts and are attached to Store, so the class in
// src/db.ts keeps only setup, migrations and settings. These lists name what is still in the class.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../src/db.ts';

const src = join(import.meta.dirname, '..', 'src');

/** Setup, migrations and settings: these stay in src/db.ts. */
const STAYS = `
attachEvents
attachState
autoCheckpoint
closedAtFromNotes
deleteSetting
dropEarlyPeekAurasBuilds
eventsPath
getSetting
groupByType
keyRange
lendingLists
moveSharedViews
noteSchemaVersion
numberTickets
serverLoginOwnerOnly
setSetting
settingKeys
settingsWithPrefix
settleBuilds
shippingFromRules
statePath
`;

/** Areas not split out yet. A step that moves an area takes its names off; nothing is added here. One name per line, sorted, so
 * two branches removing names rarely touch the same lines. */
const NOT_MOVED_YET = `
accountSpend
addFlakeEvents
addFlakeFix
addHealthEvent
addHostSample
addStepTimes
backfillTurns
dailyCosts
fableSpend
flakeCounts
flakeDetails
flakeFiles
flakeFix
flakeFixes
flakeSightings
hasFlakeNear
healthBetween
healthCount
healthEventsSince
hostSamples
lastHealthEvent
lastTurnEnd
listTurns
minionCosts
minionTurnsSince
promptHashes
recordGrunts
recordTurn
shippedSince
spendByPayer
spendRows
stepRatio
ticketCost
turnOutcomes
updateFlakeFix
`;

/** The methods declared in src/db.ts's Store class body, by name. */
function classMethods(): string[] {
  const text = readFileSync(join(src, 'db.ts'), 'utf8');
  const start = text.indexOf('\nexport class Store {');
  assert.ok(start > 0, 'src/db.ts declares `export class Store {`');
  const body = text.slice(start, text.indexOf('\n}\n', start));
  // A method, or a field holding a function (`name = () => ...`), at the class body's indent.
  const names = [...body.matchAll(/^ {2}(?:(?:private|static|async|get|set|readonly) )*([A-Za-z_$][\w$]*)\s*(?:[<(]|(?::[^=\n]*)?=\s*(?:async\s*)?(?:function\b|\(|[A-Za-z_$][\w$]*\s*=>))/gm)].map((m) => m[1]);
  return names.filter((n) => n !== 'constructor');
}

test("no new query method lands in src/db.ts itself: it goes in its area's file under src/db/", () => {
  const allowed = new Set(`${STAYS} ${NOT_MOVED_YET}`.split(/\s+/).filter(Boolean));
  const found = classMethods();
  assert.ok(found.includes('getSetting') && found.includes('attachState'), "the scan finds the class's methods");
  const added = found.filter((n) => !allowed.has(n));
  assert.deepEqual(added, [], `new methods in src/db.ts's Store class: ${added.join(', ')}. Put a query in its area's file under src/db/ ` + '(an object of methods taking `this: Store`, attached at the bottom of src/db.ts); start a new area file if none fits.');
  const gone = [...allowed].filter((n) => !found.includes(n));
  assert.deepEqual(gone, [], 'moved out of src/db.ts or renamed: take them off the lists in this test');
});

test('every area file under src/db/ is attached to Store, and no method is defined twice', async () => {
  const files = readdirSync(join(src, 'db')).filter((f) => f.endsWith('.ts'));
  assert.ok(files.length >= 2, 'the area files are there');
  const seen = new Map<string, string>();
  for (const f of files) {
    const mod = await import(join(src, 'db', f));
    for (const [exp, area] of Object.entries(mod)) {
      for (const [name, d] of Object.entries(Object.getOwnPropertyDescriptors(area as object))) {
        assert.ok(!seen.has(name), `${name} is in both ${seen.get(name)} and src/db/${f}`);
        seen.set(name, `src/db/${f}`);
        assert.equal(Object.getOwnPropertyDescriptor(Store.prototype, name)?.value, d.value, `src/db/${f}'s ${exp}.${name} is not on Store: add ${exp} to the areas at the bottom of src/db.ts`);
      }
    }
  }
  const store = new Store(':memory:');
  assert.equal(store.createMachine('m', 'h', 'cara').name, 'm', 'a moved method runs with `this` as the Store, and calls another');
});
