# Starter CI

What a scheme whose repo has no CI starts from (#1782): the repo's own check after each ship, and a nightly boot
check, both on the scheme's own Linux runner. An app with a Windows desktop part adds the `windows-ci/` kit beside it.

| File | Goes to | What it is |
|---|---|---|
| `ci.yml` | `.github/workflows/ci.yml` | Install, typecheck, build and tests, on main and by hand |
| `boot.yml` | `.github/workflows/boot.yml` | Nightly: the boot check on the default branch |
| `boot-check.ts` | `tools/boot-check.ts` | Builds the app, starts it the way Citadel does, gets its health page; copy unchanged |

## Adopt it

1. Copy the three files, and `ci-numbers.sh` from the `citadel:ci-store` skill to `tools/ci-numbers.sh` (executable).
2. In both workflows swap `<scheme-slug>`; in `boot.yml` give the cron a `<minute>` of the scheme's own; in `ci.yml` name the
   repo's default branch. Set `node-version` to what `package.json` asks for, and add the repo's other toolchains.
3. Make `ci.yml`'s steps the repo's check commands (Project facts). Keep each step's failure loud: no `--if-present`,
   no `|| true`.
4. Run `node tools/boot-check.ts` (with the app's folder, if `citadel-app.json` isn't at the root) and fix what it finds.
5. Give the repo a runner: `ci_runners` `op: "add"`, `os: "linux"`. Jobs wait until one is there. The runner is a small Ubuntu with
   Node and git: what a test needs beyond that (a browser, a `-dev` library) is a setup step, or Cara installs it once.
6. Ship. Then dispatch both workflows once by hand and read the runs: a nightly nobody has seen green proves nothing.
   *Done when* both are green on the default branch and the runner shows Idle.
7. Rows for `tools/boot-check.ts` and `tools/ci-numbers.sh` go in the README Layout table when a layout test asks for them.

## What the boot check does

It reads `citadel-app.json` (`build`, `start`, `workdir`, `env`, `health`) and needs no settings. The app gets the variables
Citadel sets (`PORT`, `DATA_DIR`, `CITADEL_KEYS`, `CITADEL_URL`, `BASE_PATH`) and its manifest's `env`, with an empty data folder, a
HOME of its own, a throwaway identity key and a Citadel that doesn't answer. Two 2xx answers within 60 s pass;
with no `health`, an open port counts. An app that can't start on a fresh database, or while Citadel is away, fails,
and that is a bug in the app. A repo with no `citadel-app.json` leaves out `boot.yml` and `boot-check.ts`.

## The nightly, as a trigger

- **Starts it:** the cron, once a night, or a person's dispatch.
- **Reads and writes:** the checkout and a temp folder it deletes. No real data, no Citadel.
- **Starts next:** nothing itself. A red run reaches the scheme's Taskmaster through Citadel's CI health (#588),
  once per run, and the Taskmaster starts a bug minion unless one is open on it.
- **A person comes back in** through that minion's chat.
- **Two at once:** the `boot` concurrency group.

Never `ubuntu-latest`, and no `CI_RUNNER` switch: GitHub's runners cost Actions minutes (Cara, 2026-11-05).
While Cara's PC is off or she is logged off, runs wait in GitHub's queue.
