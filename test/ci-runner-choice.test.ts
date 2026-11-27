import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { landText } from './land-files.ts';

// Which desktop runner each CI run may take (#1240). On 2026-11-20 two flake proofs, each holding a runner up to 90
// minutes, sent every ship for three hours to the whole suite on perigee: no runner started its job within 90 s. So a
// proof and any run that isn't a ship's ask for a label only the second runner carries, and the first stays the ships'.
const root = join(import.meta.dirname, '..');
const read = (f: string) => readFileSync(join(root, f), 'utf8');
const runsOn = (yml: string) =>
  yml
    .split('\n')
    .filter((l) => /^\s+runs-on:/.test(l))
    .join('\n');

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
  // Long jobs' own runner (#1592) is off the ships' runner too.
  const long = 'inputs.long == \'true\' && fromJSON(\'["self-hosted", "citadel-ci-linux", "citadel-ci-linux-long"]\')';
  const landOnly = 'startsWith(github.ref, \'refs/heads/land/\') && fromJSON(\'["self-hosted", "citadel-ci-linux"]\')';
  // A ship's own check (#1567) only on the check runner, which carries no other label.
  const checkOnly = 'startsWith(github.ref, \'refs/heads/check/\') && fromJSON(\'["self-hosted", "citadel-ci-linux-check"]\')';
  // The early next train's run (#1568) is a ship's run on a ship runner, guarded by its own branch, never GitHub's.
  const earlyOnly = 'startsWith(github.ref, \'refs/heads/early/\') && fromJSON(\'["self-hosted", "citadel-ci-linux"]\')';
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
      // A heavy run also names its heavy label (#2120), which only narrows it to the one runner Citadel handed it to.
      if (f === 'citadel-heavy.yml') rest = rest.split(', "citadel-heavy-suite"').join('').split(long).join('');
      if (f === 'tests.yml') rest = rest.split(landOnly).join('').split(checkOnly).join('').split(earlyOnly).join('');
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

// The reruns alone are a step of their own with a fresh window (#1374): land.sh, at its CI limit, waits CI_RERUN more for
// a run in that step, and the step ends its reruns 30 s before that (the job's end and land.sh's next look).
test("a ship's run reruns its failed files alone in a step of its own, inside the window land.sh gives that step", () => {
  const land = landText();
  const yml = read('.github/workflows/tests.yml');
  const window = land.match(/CI_RERUN=\$\{LAND_CI_RERUN:-(\d+)\}/)?.[1];
  const limit = land.match(/CI_LIMIT=\$\{LAND_CI_TIMEOUT:-(\d+)\}/)?.[1];
  const step = land.match(/CI_RERUN_STEP='([^']+)'/)?.[1];
  assert.ok(window && limit && step, "land.sh's rerun window, CI limit and rerun step");
  const at = yml.indexOf(`name: ${step}`); // the desktop job's; GitHub's shards reuse it (#2209)
  assert.ok(at > yml.indexOf('- name: the full suite'), 'the rerun step comes after the full suite');
  const rerun = yml.slice(at, yml.indexOf('\n      - ', at));
  const suite = yml.slice(yml.indexOf('- name: the full suite'), at);
  assert.match(rerun, new RegExp(`RERUN_WINDOW: ${window}\\b`), "the step's window is land.sh's");
  assert.match(rerun, /DEPLOY_RERUN_DEADLINE=\$\(\(\$\(date \+%s\) \+ RERUN_WINDOW - 30\)\)/, 'its deadline runs from its own start');
  assert.match(rerun, /DEPLOY_RERUN_FROM="\$RUNNER_TEMP\/reruns"/);
  assert.match(rerun, /if: \$\{\{ failure\(\) && steps\.suite\.conclusion == 'failure' \}\}/);
  assert.match(suite, /id: suite/);
  assert.match(suite, /DEPLOY_RERUN_LATER="\$RUNNER_TEMP\/reruns"/, 'the full suite leaves its reruns to that step');
  assert.doesNotMatch(suite, /DEPLOY_RERUN_DEADLINE/, 'the full suite reruns nothing, so it needs no deadline');
  // A land's job outlives the longest wait land.sh gives it.
  const minutes = Number(yml.match(/timeout-minutes: \$\{\{ \(startsWith\(github\.ref, 'refs\/heads\/land\/'\) \|\| startsWith\(github\.ref, 'refs\/heads\/check\/'\) \|\| startsWith\(github\.ref, 'refs\/heads\/early\/'\)\) && (\d+)/)?.[1]);
  const burn = land.match(/CI_BURN=\$\{LAND_CI_BURN:-(\d+)\}/)?.[1];
  assert.ok(burn, "land.sh's burn-in extension");
  assert.ok(minutes * 60 >= Number(limit) + Number(window) + Number(burn) + 60, `land runs' ${minutes} min job limit covers ${limit} + ${window} + ${burn} s`);
});

// The burn-in (#1443): a land's run burns in its new and changed tests before the full suite, against the base land.sh
// pushes beside it; land.sh reads a red in that step, by name, as the ship's own, and waits its time more at CI_LIMIT.
test("a ship's run burns in its new and changed tests before the full suite, in the step land.sh names, within land.sh's extension", () => {
  const land = landText();
  const yml = read('.github/workflows/tests.yml');
  const step = land.match(/CI_BURN_STEP='([^']+)'/)?.[1];
  const burn = Number(land.match(/CI_BURN=\$\{LAND_CI_BURN:-(\d+)\}/)?.[1]);
  const base = land.match(/CI_BASE_REF=([^ \n]+)\/\$branch/)?.[1];
  assert.ok(step && burn && base, "land.sh's burn-in step, extension and base ref");
  const at = yml.indexOf(`- name: ${step}`);
  assert.ok(at > 0 && at < yml.indexOf('- name: the full suite'), 'the burn-in comes before the full suite');
  const body = yml.slice(at, yml.indexOf('- name:', at + 1));
  assert.match(body, /if: \$\{\{ startsWith\(github\.ref, 'refs\/heads\/land\/'\) \|\| startsWith\(github\.ref, 'refs\/heads\/check\/'\) \|\| startsWith\(github\.ref, 'refs\/heads\/early\/'\) \}\}/, "lands, ships' own checks and early runs only");
  // land/<branch> compares with land-base/<branch>, check/<branch> with check-base/<branch> (tools/own-check.sh).
  assert.equal(base, 'land-base');
  assert.ok(body.includes('base=origin/${GITHUB_REF_NAME%%/*}-base/${GITHUB_REF_NAME#*/}'), 'it compares with the base land.sh pushes');
  assert.match(read('tools/own-check.sh'), /"\+\$m:refs\/heads\/check-base\/\$branch"/, 'and the base the own check pushes');
  assert.match(body, /tools\/burn-in\.sh --ship "\$base"/);
  const own = Number(read('tools/burn-in.sh').match(/limit=\$\{BURN_IN_LIMIT:-(\d+)\}/)?.[1]);
  assert.ok(own > 0 && own + 30 <= burn, `its ${own} s limit (plus the last copies' kill) fits land.sh's ${burn} s extension`);
});

// A ship's own check (#1567; Cara, 2026-11-22, A "Gated, after C and B"): check/<branch> runs on the one runner with the
// check label, in a concurrency group of its own, so it never takes a land's runner or cancels a land's run, and the
// desktop never runs two checks at once. Its numbers aren't kept as a land's.
test("a ship's own check runs only on the check runner, in its own group, and keeps no land numbers", () => {
  const yml = read('.github/workflows/tests.yml');
  assert.match(yml, /branches: \['land\/\*\*', 'check\/\*\*', 'early\/\*\*'\]/);
  assert.match(yml, /group: .*startsWith\(github\.ref, 'refs\/heads\/check\/'\) && 'citadel-check'/);
  assert.match(runsOn(yml), /runs-on: \$\{\{ startsWith\(github\.ref, 'refs\/heads\/check\/'\) && fromJSON\('\["self-hosted", "citadel-ci-linux-check"\]'\) \|\|/, 'before the hosted-runner switch, so it never goes to GitHub');
  assert.match(yml, /if: \$\{\{ success\(\) && !startsWith\(github\.ref, 'refs\/heads\/check\/'\) && !startsWith\(github\.ref, 'refs\/heads\/early\/'\) \}\}/);
  assert.match(read('tools/own-check.sh'), /^OWN_CHECK_LABEL=citadel-ci-linux-check$/m);
});

// The early next train's run (#1568; Cara, 2026-11-22, "Low-priority run on a ship runner"): early/<branch> runs beside the
// train ahead's, so it has a group per branch (the lands' one-at-a-time group would hold it until that run ends), takes a
// ship runner before the hosted-runner switch, runs niced, asks Citadel first (#1906), and keeps no land numbers.
test("the early next train's run goes beside the lands' run, niced, on a ship runner, never GitHub's", () => {
  const yml = read('.github/workflows/tests.yml');
  assert.match(yml, /group: .*startsWith\(github\.ref, 'refs\/heads\/early\/'\) && format\('citadel-early-\{0\}', github\.ref_name\)/);
  const r = runsOn(yml);
  const early = r.indexOf('refs/heads/early/\') && fromJSON(\'["self-hosted", "citadel-ci-linux"]\')');
  assert.ok(early >= 0 && !r.split('\n')[0]!.includes('ubuntu-latest'), "on a ship runner, never GitHub's own: their shards are land/'s (#2209)");
  assert.match(yml, /NICENESS: \$\{\{ !startsWith\(github\.ref, 'refs\/heads\/land\/'\) && '10' \|\| '0' \}\}/);
  assert.match(yml, /BURN_IN_NICE: \$\{\{ \(startsWith\(github\.ref, 'refs\/heads\/check\/'\) \|\| startsWith\(github\.ref, 'refs\/heads\/early\/'\)\) && 'nice -n 10'/);
  const ask = stepBody(yml, 'ask Citadel whether ships go first');
  assert.doesNotMatch(ask, /early\//, 'it asks: one Citadel job at a time (#1906)');
  assert.match(landText(), /"\+\$top:refs\/heads\/early\/\$nb" "\+\$tip:refs\/heads\/early-base\/\$nb"/, 'land.sh pushes it there, with its base');
});

// Deploys first (#1902): what isn't a ship's asks Citadel first, and a held run gives its runner back. A ship's run never asks.
const stepBody = (yml: string, name: string) => yml.slice(yml.indexOf(`- name: ${name}`), yml.indexOf('- name:', yml.indexOf(`- name: ${name}`) + 1));
test("main's run and heavy jobs ask Citadel before they start, with their own run's token; a ship's run never asks", () => {
  for (const f of ['tests.yml', 'citadel-heavy.yml']) {
    const yml = read(`.github/workflows/${f}`);
    assert.match(stepBody(yml, 'ask Citadel whether ships go first'), /node tools\/ci-hold-ask\.ts/, f);
    assert.match(yml, /^  id-token: write/m, f);
  }
  const yml = read('.github/workflows/tests.yml');
  const ask = stepBody(yml, 'ask Citadel whether ships go first');
  assert.ok(ask.includes("if: ${{ !startsWith(github.ref, 'refs/heads/land/') }}"), "only a ship's run in line starts unasked: a check and an early run ask (#1906)");
  assert.ok(yml.indexOf(ask) < yml.indexOf('- name: the full suite') && !yml.includes('wait for the lands'), 'nothing waits on the runner');
});

// HE1 (#1863): a heavy job's `npm test` and a flake proof of a property test could never be green: no packages there.
test('every workflow that runs the tests installs their packages after its checkout', () => {
  for (const f of ['tests', 'citadel-heavy', 'flake-proof']) {
    const yml = read(`.github/workflows/${f}.yml`);
    const at = yml.indexOf('run: npm ci --ignore-scripts --no-audit --no-fund');
    assert.ok(at > yml.indexOf('actions/checkout@'), f);
  }
});

// ci_busy keeps an own check and the early next train off a busy desktop (#1906); a flake proof runs beside ships (Josh, 2026-11-25), so it isn't busy.
test('a flake proof does not make the desktop busy for an own check or the early next train', () => {
  const [, re] = /ci_busy\(\) \{[^}]*?test\("([^"]+)"\)/s.exec(read('tools/deploy-queue.sh'))!;
  const busy = (file: string) => new RegExp(re.replaceAll('\\\\', '\\')).test(`.github/workflows/${file}`);
  assert.deepEqual(['tests.yml', 'citadel-heavy.yml', 'flake-proof.yml', 'desktop.yml'].map(busy), [true, true, false, false]);
});

// #2209 (Cara, 2026-11-27: "github should actually be the main CI? with my desktop as the fallback", "if they give us
// 20, take 20"): a ship's push runs 20 shards on GitHub's runners and the desktop job not at all; a check, an early run,
// the nightly and land.sh's fallback (where=desktop) run on the desktop as before, and CI_RUNNER=desktop sends ships back.
test("a ship's push runs 20 shards on GitHub's runners, and everything else the desktop job", () => {
  const yml = read('.github/workflows/tests.yml');
  const onGh = "inputs.where == 'github' || (github.event_name == 'push' && startsWith(github.ref, 'refs/heads/land/') && vars.CI_RUNNER != 'desktop')";
  const times = yml.slice(yml.indexOf('\n  times:\n'), yml.indexOf('\n  shard:\n'));
  const shard = yml.slice(yml.indexOf('\n  shard:\n'));
  assert.ok(times.includes(`    if: \${{ ${onGh} }}\n    runs-on: ubuntu-latest\n`), "only a ship's push, or a run asked for there");
  assert.ok(yml.slice(0, yml.indexOf('\n  times:\n')).includes(`    if: \${{ !(${onGh}) }}`), 'the desktop job is the rest');
  // Every shard the same split: one times file and one main, from the times job, not each shard's own look.
  assert.match(shard, /^ {4}needs: times\n {4}runs-on: ubuntu-latest\n/m);
  assert.match(times, /git ls-remote "\$GITHUB_SERVER_URL\/\$GITHUB_REPOSITORY" refs\/heads\/main/);
  assert.match(shard, /name: split-times\n/);
  assert.match(shard, /git branch -f main "\$\{\{ needs\.times\.outputs\.main \}\}"/);
  assert.doesNotMatch(shard, /actions\/cache/, 'no shard reads the times cache itself');
  assert.ok(yml.includes(`(${onGh}) && format('citadel-github-{0}', github.run_id)`), "a group per run: shards never cancel a land's desktop run");
  assert.match(shard, /fail-fast: false/);
  assert.equal(
    shard
      .match(/shard: \[([\d, ]+)\]/)?.[1]
      ?.split(', ')
      .join(),
    Array.from({ length: 20 }, (_, i) => i).join(),
  );
  assert.match(shard, /CITADEL_TEST_SHARD: \$\{\{ strategy\.job-index \}\}\/\$\{\{ strategy\.job-total \}\}/);
  for (const step of ['- name: the full suite', '- *rerun', '- *systemd', '- *devdeps']) assert.ok(shard.includes(step), step);
  assert.match(yml, /where:\n(.*\n)*? +options: \[desktop, github\]\n +default: desktop/, "a dispatch with no where (land.sh's fallback, a person's) runs on the desktop");
  assert.match(landText(), /'inputs\[where\]=desktop'/);
});
