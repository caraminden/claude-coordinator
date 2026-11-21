# Real CI logs for the blame-rule bench

`test/land-verdicts.test.ts` (#1484) feeds these to the verdict functions in `tools/land.sh`. Each file is the log of
the GitHub Actions run it is named after (`gh run view <id> --log` on the citadel-tests workflow, Nov 20 to 21), and
the test cites the incident report in the shared folder's `reports/` that names the run.

They are trimmed by `trim.sh` here to keep the repo small: a log with no `✖ failing tests:` stays whole (lines cut to
400 characters); otherwise the lines before that block that land.sh reads (`run-tests:`, `burn-in:`, kill and
interrupt lines, `✖`), plus the first 3 lines naming a `src/…ts:N` path (the loop-lag noise a rule must ignore), then
everything from `✖ failing tests:` on, lines cut to 1000 characters.

A new case: fetch the run's log, `bash test/fixtures/land-verdicts/trim.sh <raw log> > test/fixtures/land-verdicts/<run>.log`,
and cite its report in the test.
