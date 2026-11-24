# review-escapes

Replays the pre-ship reviewer (`citadel:reviewer`, briefed the way `citadel:self-review` briefs it)
on changes that shipped with a defect a later minion had to fix, plus same-size changes nobody
fixed, and has a blind judge say whether each review named the defect (#1505).

```bash
node tools/review-escapes/run.ts run --jobs 4                        # all arms, all 40 cases (in the background)
node tools/review-escapes/run.ts report                              # the table, again
node tools/review-escapes/run.ts check                               # rebuild workspaces, look for leaks
```

`run` takes `--arms sonnet,opus,lens`, `--case <regex>`, `--out <dir>` (default
`$TMPDIR/review-escapes`), `--kit <dir>`, `--judge-model` and `--budget` (per review, USD). A case
already reviewed or judged in `--out` is skipped, so a stopped run picks up where it left off. It
runs `claude -p` on the asker's own Claude login: about $8–10 an arm on Sonnet, $47 on Opus, plus $2 of judging. One pass can swing by 3 named bugs, so run an arm twice before believing a gap.

## Files

- `set.json`: the 40 cases. An escape has `origin` (the minion whose change shipped), `base`
  (main where it branched) and `head` or `picks` (its commits), and `defects`: each later fix's
  minion, its title, why and cause from the pairs table, and its commits. `taught: true` marks a
  case the lenses already use as their example (#795), so results are given with and without it.
- `arms.json`: what is compared. An arm is a model, an effort and optionally text that replaces
  "Lenses: by the diff." in the brief. Add an arm here to test a new lens.
- `run.ts`: builds each case in a shared clone with only `main` (the base) and
  `ticket/<origin>-replay` (the change as shipped), no other refs or reflog, so the fix is not in
  reach; runs each arm under a read-only guard hook (`tools/prompt-evals/guard.ts`); has an Opus
  judge, which sees the defect, the fix's commit messages and its non-test diff but not the arm,
  mark each defect named / near / no; writes `report.md` and `verdicts.tsv` in `--out`.

- `planted.json`: the planted set (#1738): 22 real small commits, each with one bug planted (`plant`:
  the commit's own added text `from`, replaced by `to`, amended into the head), and 5 untouched
  controls. Kinds: flipped comparison or boundary, missed sibling, dropped `await`, wrong argument
  order, unescaped value. The reviewer sees the commit with the bug in it; the judge sees the bug and
  its failing case. `--set all` runs both files, `--set planted` only this one.
- `bench.ts`: the record of the last benchmark run, `test/reviewer-benchmark.json`.

## When the reviewer changes

`test/reviewer-benchmark.test.ts` goes red when `kit/agents/reviewer.md` (its model and effort are in
its frontmatter), self-review's section 2, the lenses or `ponytail-review` changed since the last
recorded run (whitespace doesn't count). To clear it, in the background and not through citadel-heavy:

```bash
node tools/review-escapes/run.ts run --arms sonnet --set all --jobs 3 --additions <the scheme's pre-ship-review.md> --out $TMPDIR/bench-1
node tools/review-escapes/run.ts run --arms sonnet --set all --jobs 3 --additions <the scheme's pre-ship-review.md> --out $TMPDIR/bench-2
node tools/review-escapes/bench.ts record $TMPDIR/bench-1 $TMPDIR/bench-2 --additions <the same file> --results <where you kept the reports>
```

Two Sonnet passes over both sets cost about $20 (the baseline: see its report). If the mean of planted
bugs named fell by 2 or more from the last record, `record` says so and writes `drop` into the record:
the change is high risk and ships only on a member's go (as prompt-eval's "Drop needs a go"). Commit
`test/reviewer-benchmark.json` with the change. Measure, don't tune: the benchmark checks a reviewer
change, it isn't a reason to edit the reviewer.

**Lessons** (the scheme's auto-added `pre-ship-review.md`) count as a change once 3 new kinds were added
since the last run. The test can't see them (they live in the database); `node tools/review-escapes/bench.ts status`
reads them from the live database, read-only, and says so. Run it when you ship a change to lessons code or
see lessons arrive. This measures planted catch and control noise; the refuted-findings rate of those
lessons is the separate review the lessons-measure handoff does.

## How the set was picked

Escapes come from the reviewer-pairs table in the #1493 deep dive
(`shared/project/reports/rework-deep-dive-2026-11-21.md`): a minion whose change a later minion
fixed, with the fix's cause in the code (fragile tests and stalls left out: #1487, #1492). Each
case keeps only the origin's commits from before its first fix commit. Commits whose title lost
its `#N` (the commentChar bug, #1489) were given back by the files they touch.

Clean cases: features and bugs shipped Nov 7–17, 200–2000 lines, never an origin or fix in the
pairs table and never named by a later commit, picked with seed 1505 to match the escapes' size
spread. "Clean" means nobody fixed them, not that they have no bugs: findings on them are counted,
not called false.

## Limits

- The reviewer sees the change as it shipped and today's kit (its lenses may have learned from
  some of these escapes since); each case's CLAUDE.md is the one from that day.
- escape-627 had to be rebuilt as a plain range and carries #628/#629's work too.
- Findings are the review's numbered Must fix / Should fix lines.
