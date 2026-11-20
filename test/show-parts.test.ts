// "Show me where" links (#1122): every part in src/show-parts.ts is still named on an element in public/, the link and
// lookup the `citadel-where` command prints, and the ?show= address the router reads (public/threadrefs.js).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findParts, partLink, PARTS, turnPlace } from '../src/show-parts.ts';
import { showParts } from '../public/threadrefs.js';

const PUBLIC = join(import.meta.dirname, '..', 'public');
const TMP = mkdtempSync(join(tmpdir(), 'show-parts-'));
mkdirSync(join(TMP, 'projects', '5', 'tickets', '1060'), { recursive: true });
after(() => rmSync(TMP, { recursive: true, force: true }));
const frontEnd = readdirSync(PUBLIC).filter((f) => /\.(js|html)$/.test(f)).map((f) => readFileSync(join(PUBLIC, f), 'utf8')).join('\n');

/** The part named on an element: `part` (data-part, part:, dataset.part) and the quoted name on the same line. */
const named = (name: string) => new RegExp(`(?:\\bpart|data-part)\\b[^\\n]{0,80}?['"\`]${name}['"\`]`).test(frontEnd);

test('every part in the list is still named in the front end', () => {
  const missing = PARTS.map((p) => p.name).filter((n) => !named(n));
  assert.deepEqual(missing, [], `named in src/show-parts.ts but on no element in public/ (renamed or removed?): ${missing.join(', ')}`);
});

test('the check fails when a part is gone', () => {
  assert.equal(named('no-such-part-anywhere'), false);
});

// Most names are given at a call site (settingsRow({ part: 'fast-mode' })): these helpers put them on the element.
test('the helpers that take a part name put it on their element', () => {
  const src = (f: string) => readFileSync(join(PUBLIC, f), 'utf8');
  assert.match(src('settings.js'), /export function settingsRow\(\{[^}]*\bpart \}(?:[^\n]*\n){1,6}[^\n]*h\('details', \{[^}]*'data-part': part \?\? null/, 'settingsRow');
  assert.match(src('people.js'), /function accountRow\([^)]*\{ part \}[^\n]*\n\s*const \[row, sum\] = settingsRow\(\{ part,/, 'accountRow');
  assert.match(src('minion-rules.js'), /const live = \(meta,[^\n]*\n[^\n]*\n\s*const \[row, sum\] = settingsRow\(meta,/, "Minion rules' live rows");
});

test('part names are unique and fit the ?show= address', () => {
  const names = PARTS.map((p) => p.name);
  assert.equal(new Set(names).size, names.length);
  for (const n of names) assert.deepEqual(showParts(`#/p/2?show=${n}`), { hash: '#/p/2', name: n }, n);
  for (const p of PARTS) assert.match(p.page, /^(|\/t\/\{minion\}|\/[a-z-]+)$/, p.name);
});

test('a link opens the page in the scheme, a minion part in the minion given', () => {
  const part = (n: string) => PARTS.find((p) => p.name === n)!;
  assert.equal(partLink(part('fast-mode'), 3), '#/p/3/approvals?show=fast-mode');
  assert.equal(partLink(part('message-box'), 3), '#/p/3?show=message-box');
  assert.equal(partLink(part('model-picker'), 3, 12), '#/p/3/t/12?show=model-picker');
  assert.equal(partLink(part('model-picker'), 3), null, "no minion: the Taskmaster's chat may not have it");
});

test('a question finds its part', () => {
  assert.deepEqual(findParts('where is the fast mode?').map((p) => p.name), ['fast-mode']);
  assert.equal(findParts('where can I change the model')[0].name, 'model-picker');
  assert.deepEqual(findParts('flux capacitor'), []);
  assert.deepEqual(findParts('fast mode dark mode'), [], 'a word no part has: no link rather than the wrong one');
  assert.equal(findParts('where can I move them')[0].name, 'list-groups');
});

test("the turn's scheme and minion come from its folder", () => {
  assert.deepEqual(turnPlace('/home/x/.local/share/claude-coordinator/projects/4/tickets/1060'), { scheme: '4', ticketId: '1060' });
  assert.deepEqual(turnPlace('/home/x/.local/share/claude-coordinator/projects/12/coordinator'), { scheme: '12', ticketId: null });
  assert.deepEqual(turnPlace('/tmp'), { scheme: null, ticketId: null });
});

test('citadel-where prints the link', () => {
  const out = execFileSync(join(import.meta.dirname, '..', 'tools', 'citadel-where'), ['--scheme', '5', 'fast', 'mode'], { encoding: 'utf8' });
  assert.equal(out, '[Fast mode](#/p/5/approvals?show=fast-mode)  Orders → Minion rules → Shipping\n');
  const aside = (cwd: string) => execFileSync(join(import.meta.dirname, '..', 'tools', 'citadel-where'), ['--scheme', '5', 'ask', 'on', 'the', 'side'], { encoding: 'utf8', cwd });
  assert.equal(aside('/'), "Ask on the side: beside Send in a minion's chat. It's in a minion's chat: pass --minion N for a link.\n");
  assert.equal(aside(join(TMP, 'projects', '5', 'tickets', '1060')), "[Ask on the side](#/t/1060?show=ask-on-the-side)  beside Send in a minion's chat\n");
});

test('the router reads ?show= off any page address, and only a part name', () => {
  assert.deepEqual(showParts('#/p/2/approvals?show=fast-mode'), { hash: '#/p/2/approvals', name: 'fast-mode' });
  assert.deepEqual(showParts('#/t/2552?show=model-picker'), { hash: '#/t/2552', name: 'model-picker' });
  assert.equal(showParts('#/p/2/approvals'), null);
  assert.equal(showParts('#/p/2?e=12'), null);
  assert.equal(showParts('#/p/2?show="><img>'), null);
});
