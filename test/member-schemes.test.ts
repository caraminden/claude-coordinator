import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { GLOBAL_OWNER } from '../src/properties.ts';
import { tempRoot } from './helpers.ts';
import { bootPeople } from './scheme-boot.ts';

// #674 (Cara, 2026-11-14: "I added Alex to the Citadel scheme and now it shows him as if he is in every scheme"):
// admin reach (the flag, or Citadel membership since #621) still opens every scheme, but GET /api/projects marks
// which ones the person really owns or was added to, so their lists show those as theirs and the rest apart.
const tmp = tempRoot('member-schemes-');
after(() => tmp.teardown());

let call: Awaited<ReturnType<typeof bootPeople>>['call'];
let person: Awaited<ReturnType<typeof bootPeople>>['person'];
before(async () => {
  ({ call, person } = await bootPeople(tmp));
});

const mine = async (who: string) => Object.fromEntries((await call<{ name: string; member: boolean }[]>(who, '/api/projects')).data.map((p) => [p.name, p.member]));

test('a Citadel member in one other scheme has those two as theirs; the rest are listed apart, still open to them', async () => {
  const schemes: Record<string, number> = {};
  for (const name of ['Delve', 'Citadel', 'Genesis']) schemes[name] = (await call<{ id: number }>('Cara', '/api/projects', { method: 'POST', body: { name } })).data.id;
  assert.equal(schemes.Citadel, GLOBAL_OWNER, "the fixture's second scheme is the Citadel scheme");
  const alex = await person('Alex', 'alex-password-1');
  const josh = await person('Josh', 'josh-password-1');
  for (const name of ['Citadel', 'Genesis']) assert.equal((await call('Cara', `/api/projects/${schemes[name]}/members`, { method: 'POST', body: { person: alex } })).status, 200);
  assert.equal((await call('Cara', `/api/projects/${schemes.Delve}/members`, { method: 'POST', body: { person: josh } })).status, 200);
  // Josh's own scheme, which Cara (an admin) was never added to.
  assert.equal((await call('Josh', '/api/projects', { method: 'POST', body: { name: 'Threadspace', source: 'none' } })).status, 201);

  assert.deepEqual(await mine('Alex'), { Delve: false, Citadel: true, Genesis: true, Threadspace: false });
  // Admin reach is unchanged: Alex still opens a scheme he isn't in.
  assert.equal((await call('Alex', `/api/projects/${schemes.Delve}`)).status, 200);
  // The admin flag gets the same treatment: Cara's list marks Josh's scheme as not hers.
  assert.deepEqual(await mine('Cara'), { Delve: true, Citadel: true, Genesis: true, Threadspace: false });
  // A plain member sees only theirs, all marked so.
  assert.deepEqual(await mine('Josh'), { Delve: true, Threadspace: true });
});
