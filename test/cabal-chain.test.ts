// What a cabal row's `after` chains on (src/cabal-start.ts chainOf): a list ("H1, H2", "H1 and H2", "H1 & H2") reads as
// its parts, the parts already merged or shipped drop out, and a start waits on at most one minion.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { chainOf } from '../src/cabal-start.ts';
import { Store } from '../src/db.ts';
import type { App } from '../src/http.ts';

const root = mkdtempSync(join(tmpdir(), 'cabal-chain-'));
after(() => rmSync(root, { recursive: true, force: true })); // timing-ok: own temp dir
const store = new Store(join(root, 'coordinator.db'));
const p = store.createProject('Scheme', null);
const make = (title: string) => store.createTicket({ project_id: p.id, title, permission_mode: 'default', created_by: 'Cara' });
const lead = make('Lead');
const h1 = make('One');
const h2 = make('Two');
store.ensureCabal(lead.id, p.id);
store.addCabalRow(lead.id, { label: 'H1', title: 'One', ticket_id: h1.id });
store.addCabalRow(lead.id, { label: 'H2', title: 'Two', ticket_id: h2.id });
const app: Pick<App, 'store'> = { store };
const rowAfter = (text: string) => {
  const id = store.addCabalRow(lead.id, { label: `R${Math.random()}`, title: 'Row', after: text });
  return store.cabalRow(id)!;
};
const chain = (text: string) => chainOf(app, lead, rowAfter(text));
const merge = (t: { id: number }) => store.addEvent(t.id, 'note', { text: 'Merged into Build 10: done. Risk low: small.' });

test('a list of two open labels is refused, naming both; the row text is never rewritten', () => {
  const r = rowAfter('H1, H2');
  assert.throws(() => chainOf(app, lead, r), /H1 \(#\d+\) and H2 \(#\d+\).*all but one/);
  assert.equal(store.cabalRow(r.id)!.after, 'H1, H2');
  for (const sep of [' and ', ' & ', ' + ', '; ']) assert.throws(() => chain(`H1${sep}H2`), /all but one/, sep);
});

test('one part merged: it chains on the other; both merged: no chain', () => {
  merge(h1);
  assert.equal(chain('H1, H2'), h2.number);
  assert.equal(chain('h2 and H1'), h2.number, 'case-insensitive, any order');
  assert.equal(chain(`#${h1.number}, #${h2.number}`), h2.number, 'a #N part counts too');
  merge(h2);
  assert.equal(chain('H1, H2'), null);
  assert.equal(chain(`H1, #${h2.number}`), null);
});

test('an unknown part is refused by its own name; a single label or #N works as before', () => {
  assert.throws(() => chain('H1, H9'), /waits on "H9", which is no #N and no label/);
  assert.equal(chain(''), null);
  assert.equal(chain(`#${99999}`), 99999, 'a #N with no minion here is kept as typed');
});
