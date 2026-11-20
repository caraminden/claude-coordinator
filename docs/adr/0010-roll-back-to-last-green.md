# Roll back to last green, and the hold that keeps it

Status: accepted, 2026-11-18 (#1016's grilling round, built in #1016).

From #1006's report (`reports/ci-test-policy-2026-11.md`, section 3e): instead of a dev and a stable copy of
everything, one button goes back to the last version that passed the full suite. Fast mode ("land now, test behind")
turns on for no scheme until it is live (Cara, 2026-11-18: "No build, rollback first").

- **Last green** is per scheme: the newest commit on its default branch where the newest run of every workflow on that
  commit (ci_quiet's left out) passed. CI health reads every scheme's runs every 5 minutes, and last green only ever
  moves forward (`src/last-green.ts`). Citadel's own lands count: each one's CI run tests the exact commit that lands.
- **The button**: "Roll back to last green" on each Releases card whose target can deploy a given commit: a contraption
  (its two-slot deploy, health check, back to what ran on a failure) and Citadel's server (`tools/deploy.sh --to`:
  boot check, restart, health check). It pins the deploy; it doesn't rewrite main. Any member of the scheme presses it.
- **Hold until the fix** (Cara's pick on Q1, 2026-11-18: "Hold until the fix"): lands keep going onto main, so the fix
  can land, but the rolled-back target stays where it is until main has a newer commit that passed the full suite,
  then auto-deploy ships it. A person's Deploy overrides and clears the hold; a minion's or Taskmaster's deploy call is refused while it
  holds. Citadel's server, whose fast mode is still off: a land that touches none of the files the rolled-back commits
  changed is refused until the fix lands (as after a failed restart's own rollback; LAND_FIX=1 for a fix that doesn't);
  the fix's healthy deploy clears it. Until the roll back's own restart is live (it waits for running turns, up to 2 h),
  every land and deploy is refused, the fix too, so none can move the checkout under it (#1271); the roll back's job
  ends only with that restart's verdict, failed if it didn't go live.
- **Last green only** (Q2: "Last green only"): no Roll back to this on earlier releases. A break no test notices passes
  the suite, so last green can be the broken version itself; that one isn't what this button is for.
- **Migrations** (Q3: "App lists its migrations"): a contraption's `citadel-app.json` may list `migrations`, paths in its
  repo; a rollback is refused, saying which files, when anything under them changed between last green and what runs.
  An app that lists none rolls back, with its health check as the guard. Since #1137 (ADR 0015), a snapshot of the app's
  data taken under code with the same migrations lets it go back, data and all; it is refused only when there is none. Citadel's server is guarded by its boot check
  against a copy of the database, and its schema_version warning.
