---
name: ci-store
description: Citadel's own store for what CI builds, in place of GitHub's artifact storage. Use when writing or changing a workflow that keeps a file from a run (actions/upload-artifact, a build, test reports, a release), when a turn needs a file a CI run made (in place of `gh run download`), when an upload fails on GitHub's artifact quota, or to keep bench numbers per run.
---

# The CI store

A scheme's CI jobs run on its self-hosted runners and upload what they keep to Citadel, over the
tailnet. Nothing goes to GitHub's artifact storage: its quota is shared by every repo of an
account, and when it fills, every scheme's uploads fail and their ship gates go red (2026-11-13).

CI runs on Cara's desktop runners; GitHub-hosted runners only through `CI_RUNNER=github`, after asking Cara (Josh's rule, Cara's yes, 2026-11-05). A scheme whose repo has no runners there gets them with the `ci_runners` tool (scheme setup does this for any repo with workflows).

## What a workflow may keep

- **Reports** (test reports, logs, screenshots, crash dumps): only from a run that failed
  (`if: failure()`), as kind `report`. They go after 7 days.
- **Builds**: only one that someone or something uses: a person tries it, a contraption serves it,
  a later job needs it. No debug build from every green run "in case". Kind `build`; the newest 5
  runs per workflow and target stay.
- **Release builds**: always through the store, as kind `release`. The newest 10 runs per workflow
  and target stay, and any under 180 days.
- Never deleted: each target's newest build and release, and the release last published to a
  contraption's feed.
- Limits: 2 GiB a file, 20 GiB a scheme. An upload the scheme has no room for is refused, and its
  Taskmaster is told.

No `actions/upload-artifact` step in a new workflow; replace one when you touch its workflow.

## Uploading from a workflow

Copy `ci-upload.sh` from this skill's folder to the repo's `tools/ci-upload.sh` (keep it
executable and unchanged). The job needs the run-token permission, and then one step per file or
folder:

```yaml
    permissions:
      contents: read
      id-token: write
    steps:
      # …build…
      - name: Keep the signed APK
        run: tools/ci-upload.sh --kind release "$APK"
      - name: Keep the test reports
        if: failure()
        run: tools/ci-upload.sh --kind report --name test-reports.tar.gz app/build/reports/tests
```

- A folder is sent as one `.tar.gz`. `--name` sets the stored name (letters, digits and `. _ + -`).
- `--target windows` when one workflow builds several things, so each keeps its own newest runs.
- There is no secret to set. The script asks GitHub for the job's own run token; the store reads
  the scheme, workflow, run and commit from it, so a job can only write to its own scheme.
- A `permissions:` block replaces the defaults, so list what the job already needs beside
  `id-token: write`.
- A report that can't be uploaded warns and passes. A build or release that can't fails the step.
  A job on a GitHub-hosted runner (`CI_RUNNER=github`) can't reach the store: the script skips.

## Downloading in a later job

A job can download what another job of the same commit stored, from any workflow, in place of
`actions/download-artifact` or building it again. For example, a desktop e2e job can take the build
`windows.yml` made. Copy `ci-download.sh` from this skill's folder to the repo's
`tools/ci-download.sh` (keep it executable and unchanged). The job needs the same `id-token: write`
permission as an upload:

```yaml
    permissions:
      contents: read
      id-token: write
    steps:
      - name: Take windows.yml's build of this commit
        run: tools/ci-download.sh --workflow windows.yml --kind build --target windows --out build/app.zip
```

- Filters: `--workflow`, `--kind`, `--target`, `--name`, `--run`. With no `--name` the script takes
  the newest match. `--out` sets where the file goes (default: its stored name, in the current folder).
  `--list` prints the matches instead, newest first.
- The run token names the scheme and commit. A job reads only its own scheme's files of its own
  commit; `--commit` with another SHA is refused (403). The commit is the job's `GITHUB_SHA`.
- The file has to be stored already: the download runs after the job that uploads it. Within one
  workflow, `needs:`. Across workflows, both have to run for the same commit and the uploader has to
  finish first. A workflow started by `workflow_run` runs for the default branch's newest commit,
  not the commit of the run that started it, so it only finds that run's files when they are the same.
- A download that can't happen, or finds no match, fails the step (`--list` prints nothing for no
  match). A 503 (the store couldn't yet read GitHub's signing keys) is retried, as uploads are.
- The routes it calls, on the store's address: `GET /api/ci-store?commit=&workflow=&kind=&target=&name=&run=`
  lists the matches as JSON, and each file's `url` (`/api/ci-store/<id>/<name>`) is the bytes, both with
  `Authorization: Bearer <run token>`.

## Keeping numbers per run

A few numbers a run measures (a bench timing, a binary's size, a test count) are kept per commit for
400 days, charted on the CI page's Numbers tab (one row per series, each point linking its commit),
and watched for a step up. Copy `ci-numbers.sh` from this skill's folder to the repo's
`tools/ci-numbers.sh` (keep it executable and unchanged); the job needs the same `id-token: write`
permission as an upload:

```yaml
    permissions:
      contents: read
      id-token: write
    steps:
      # …bench…
      - name: Keep the bench numbers
        run: tools/ci-numbers.sh startup=412ms frame-p95=16.4ms apk-size=12.5MB
```

- Worth sending from any scheme: the test suite's wall time (`suite-time=187s`), timed around the test step on a green run.
  Citadel's `tests.yml` does (`suite-time`, `front-end-size`).
- Each number is `name=value[unit]`: the name is letters, digits and `. _ + -` (one series per
  name, per scheme), the unit the letters (or `%`, `/`) after the value. `--file bench.txt` reads
  one a line as `name value [unit]`, `#` for a comment, for a bench that writes its own file.
- The commit, run, workflow and branch come from the run token, as for an upload. Each branch is its
  own line (a ship's `land/…` run counts as main's); the chart shows, and the flag watches, the
  branch most runs are on (the default branch, in practice).
- A re-run attempt of the same run replaces its numbers. A number that can't be sent warns and never
  fails the job; a GitHub-hosted runner skips.
- Limits: at most 50 numbers a run, 100 series a scheme (a new series past that is refused, an old
  one keeps taking numbers), 16 KiB a request. Numbers, not reports.
- **The step-up flag.** When 3 runs in a row on that branch are each over 5% above the median of the 10
  runs before, and past those runs' usual wobble (3 × their median distance from that median), the
  series is flagged once, at the step's first run, and the scheme's Taskmaster is woken with the
  numbers and the commit. One noisy run never flags. It is a flag, not a gate: nothing waits on it.
  A step down is never flagged, so send numbers where higher is worse (a time, a size), not a score.
- The read route, for a page or a script: `GET /api/projects/<scheme id>/ci-numbers` (a person's
  session or a contraption key, as for `ci-files`) gives each series' points and steps. The send
  route the script calls is `POST /api/ci-numbers` on the store's address, with
  `Authorization: Bearer <run token>` and `{ "numbers": [{ "name", "value", "unit" }] }`.

## Reading a run's files

- In a turn: the `ci_files` tool lists the scheme's files, newest first, or with `latest: true`
  the newest match (by workflow, kind, target, name, run or commit). Each comes with its path on
  the server; read or copy it from there. That replaces `gh run download`.
- For people and pages: `/api/projects/<scheme id>/ci-files` lists them,
  `/api/projects/<scheme id>/ci-files/latest?workflow=<file>&kind=release` redirects to the newest,
  and each file's own URL stays the same until the rules delete it.
- For a contraption's server: the same three routes, with its contraption key
  (`Authorization: Bearer <contraption.key>`), for its home scheme only (another scheme's id is
  403). The newest Windows build of `windows.yml`, as its details:
  `GET $CITADEL_URL/api/projects/<home scheme id>/ci-files/latest?workflow=windows.yml&kind=build&target=windows&json=1`,
  then the bytes from its `url`. Leave out `json=1` and the redirect leads straight to the bytes.
  The contraption-ui skill's `references/api.md` ("Your home scheme's CI files") has the code.
- A rolled-back CI package (ADR 0012): `/api/projects/<scheme id>/ci-files/pins` lists the builds
  each pinned target is held at, with their files. An app's updater hands out a pinned build in
  place of the newest, even though its number is older, until the pin is gone from the list. The
  store keeps those builds and each target's last green one past the rules' sweep.
- An Android release run's signed APK (kind `release`, named `<app>-<versionCode>.apk`) is what
  the Releases page's publish step copies into the contraption's `android/` folder.
