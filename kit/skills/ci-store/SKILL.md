---
name: ci-store
description: Citadel's own store for what CI builds, in place of GitHub's artifact storage. Use when writing or changing a workflow that keeps a file from a run (actions/upload-artifact, a build, test reports, a release), when a turn needs a file a CI run made (in place of `gh run download`), or when an upload fails on GitHub's artifact quota.
---

# The CI store

A scheme's CI jobs run on its self-hosted runners and upload what they keep to Citadel, over the
tailnet. Nothing goes to GitHub's artifact storage: its quota is shared by every repo of an
account, and when it fills, every scheme's uploads fail and their land gates go red (2026-11-13).

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

## Reading a run's files

- In a turn: the `ci_files` tool lists the scheme's files, newest first, or with `latest: true`
  the newest match (by workflow, kind, target, name, run or commit). Each comes with its path on
  the server; read or copy it from there. That replaces `gh run download`.
- For people and pages: `/api/projects/<scheme id>/ci-files` lists them,
  `/api/projects/<scheme id>/ci-files/latest?workflow=<file>&kind=release` redirects to the newest,
  and each file's own URL stays the same until the rules delete it.
- An Android release run's signed APK (kind `release`, named `<app>-<versionCode>.apk`) is what
  the Releases page's publish step copies into the contraption's `android/` folder.
