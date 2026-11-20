import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

// Which desktop runner each CI run may take (#1240). On 2026-11-20 two flake proofs, each holding a runner up to 90
// minutes, sent every ship for three hours to the whole suite on perigee: no runner started its job within 90 s. So a
// proof and any run that isn't a ship's ask for a label only the second runner carries, and the first stays the ships'.
const root = join(import.meta.dirname, '..');
const read = (f: string) => readFileSync(join(root, f), 'utf8');
const runsOn = (yml: string) => yml.split('\n').filter((l) => /^\s+runs-on:/.test(l)).join('\n');

test("a flake proof runs only on the runner with the side label, so it can't take the ships' runner", () => {
  const r = runsOn(read('.github/workflows/flake-proof.yml'));
  assert.match(r, /\["self-hosted", "citadel-ci-linux", "citadel-ci-linux-side"\]/);
});

test("a ship's run takes either runner; any other run of tests.yml (the nightly, one started by hand) only the side one", () => {
  const r = runsOn(read('.github/workflows/tests.yml'));
  assert.match(r, /startsWith\(github\.ref, 'refs\/heads\/land\/'\) && fromJSON\('\["self-hosted", "citadel-ci-linux"\]'\) \|\| fromJSON\('\["self-hosted", "citadel-ci-linux", "citadel-ci-linux-side"\]'\)/);
});

test('every runner the setup script adds after the first carries the side label', () => {
  const s = read('tools/ci-runner/add-runner.sh');
  assert.match(s, /\[\[ -z \$suffix \]\] \|\| labels\+=",\$label-side"/);
  assert.match(s, /--labels "\$labels"/);
});

test("a ship's run fits its reruns alone into the time land.sh waits for it: the deadline is land.sh's CI limit", () => {
  const limit = read('tools/land.sh').match(/CI_LIMIT=\$\{LAND_CI_TIMEOUT:-(\d+)\}/)?.[1];
  assert.ok(limit, "land.sh's CI limit");
  assert.match(read('.github/workflows/tests.yml'), new RegExp(`DEPLOY_RERUN_DEADLINE=\\$\\(\\(created \\+ ${limit} - 30\\)\\)`));
});
