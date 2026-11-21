import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
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

// Every job on the desktop that isn't a ship's (#1347): on 2026-11-20 heavy jobs (citadel-heavy.yml) asked for only
// `citadel-ci-linux`, took the first runner back to back (one for 36 minutes) while a proof held the side one, and
// four ships in a row found no runner within land.sh's 85 s. So the ships-only form of the label may appear only behind
// the land/ branch check, and every other self-hosted job asks for the side label.
test("no workflow but a ship's run can take the first runner: every other self-hosted job asks for the side label", () => {
  const dir = join(root, '.github', 'workflows');
  const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
  const side = '"self-hosted", "citadel-ci-linux", "citadel-ci-linux-side"';
  const landOnly = "startsWith(github.ref, 'refs/heads/land/') && fromJSON('[\"self-hosted\", \"citadel-ci-linux\"]')";
  const bad: string[] = [];
  let sideJobs = 0;
  for (const f of files) {
    const lines = read(`.github/workflows/${f}`).split('\n');
    lines.forEach((l, i) => {
      const m = l.match(/^(\s+)runs-on:(.*)$/);
      if (!m) return;
      // A selector in any form: the line's own value plus a YAML list or mapping indented under it.
      let sel = m[2];
      for (let j = i + 1; j < lines.length && (lines[j].trim() === '' || lines[j].match(/^\s*/)![0].length > m[1].length); j++) sel += ' ' + lines[j];
      sideJobs += sel.split(side).length - 1;
      // What's left once the side label's form and (in tests.yml) the land-guarded ships' form are taken out must not
      // name a self-hosted runner at all: a form this test can't read counts against it.
      let rest = sel.split(side).join('');
      if (f === 'tests.yml') rest = rest.split(landOnly).join('');
      if (/self-hosted|citadel-ci-linux/.test(rest)) bad.push(`${f}:${i + 1}: ${sel.trim()}`);
    });
  }
  assert.deepEqual(bad, [], "these jobs can take the ships' runner");
  assert.ok(sideJobs >= 4, `the heavy, desktop, proof and tests jobs ask for the side label (found ${sideJobs})`);
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
