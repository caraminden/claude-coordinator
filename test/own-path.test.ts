import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ownPath } from '../src/http.ts';

test('the old root redirects to /c/, keeping the query; /c/ paths reach the same routes; /apps/ is left alone', () => {
  assert.deepEqual(ownPath('/'), { redirect: 'c/' });
  assert.deepEqual(ownPath('/?next=%2Fapps%2Fx%2F'), { redirect: 'c/?next=%2Fapps%2Fx%2F' });
  assert.deepEqual(ownPath('/c'), { redirect: 'c/' });
  assert.deepEqual(ownPath('/c/'), { url: '/' });
  assert.deepEqual(ownPath('/c/api/me?x=1'), { url: '/api/me?x=1' });
  assert.deepEqual(ownPath('/c/app.js'), { url: '/app.js' });
  assert.equal(ownPath('/c/apps/mandate/'), null);
  assert.equal(ownPath('/c/preview/3/'), null);
  assert.equal(ownPath('/apps/mandate/'), null);
  assert.equal(ownPath('/api/me'), null);
  assert.equal(ownPath('/cats'), null);
});

test("Citadel's manifest keeps its id and its scope leaves /apps/ to contraptions", () => {
  const m = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'public', 'manifest.webmanifest'), 'utf8'));
  // Changing the id would make every installed copy a different app (reinstall needed).
  assert.equal(m.id, '/');
  const scope = new URL(m.scope, 'https://x/');
  assert.ok(new URL(m.start_url, 'https://x/').pathname.startsWith(scope.pathname));
  // Chrome won't offer to install a contraption whose start_url is inside an installed app's scope.
  assert.ok(!'/apps/mandate/'.startsWith(scope.pathname), `scope ${m.scope} covers /apps/`);
  // The rail's way back from a contraption focuses the open window instead of opening another (#274).
  assert.deepEqual(m.launch_handler?.client_mode, ['focus-existing', 'auto']);
});
